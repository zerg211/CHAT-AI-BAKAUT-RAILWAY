import { AsyncLocalStorage } from 'node:async_hooks';
import type { PoolClient } from 'pg';
import { config } from '../config.js';
import { pool } from '../db/pool.js';

export type OpenAIUsageContext = {
  sessionId?: string | null;
  turnId?: string | null;
  pageUrl?: string | null;
  userAgent?: string | null;
};

type UsageNumbers = {
  inputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  totalTokens: number | null;
};

const usageContext = new AsyncLocalStorage<OpenAIUsageContext>();
const usageRecorded = new WeakSet<object>();
const usageReservationByResponse = new WeakMap<object, string>();
const reservationBucket = 'global_openai_tokens_24h';
const reservationTtlMinutes = 15;

export class OpenAIUsageBudgetExceededError extends Error {
  constructor(message: string, readonly details: Record<string, unknown>) {
    super(message);
    this.name = 'OpenAIUsageBudgetExceededError';
  }
}

export function runWithOpenAIUsageContext<T>(context: OpenAIUsageContext, fn: () => Promise<T>): Promise<T> {
  return usageContext.run(context, fn);
}

export function currentOpenAIUsageContext() {
  return usageContext.getStore() ?? {};
}

export function requestSourceFromContext(context: OpenAIUsageContext = currentOpenAIUsageContext()) {
  let pageHost = '';
  try {
    pageHost = new URL(String(context.pageUrl ?? '')).hostname.toLocaleLowerCase('en-US');
  } catch {
    pageHost = '';
  }
  const userAgent = String(context.userAgent ?? '').toLowerCase();
  const bakautHost = pageHost === 'bakautprof.ru' || pageHost.endsWith('.bakautprof.ru');
  if (userAgent.includes('headlesschrome') && bakautHost) return 'production_live_test';
  if (bakautHost) return 'production_widget';
  if (pageHost === 'localhost' || pageHost === '127.0.0.1') return 'local_widget';
  if (userAgent.includes('headlesschrome')) return 'automated_browser';
  return 'unknown';
}

export function extractOpenAIUsage(response: unknown): UsageNumbers {
  const usage = response && typeof response === 'object'
    ? (response as { usage?: Record<string, unknown> }).usage
    : undefined;
  if (!usage || typeof usage !== 'object') {
    return { inputTokens: null, outputTokens: null, reasoningTokens: null, totalTokens: null };
  }
  const outputDetails = usage.output_tokens_details && typeof usage.output_tokens_details === 'object'
    ? usage.output_tokens_details as Record<string, unknown>
    : {};
  return {
    inputTokens: numberOrNull(usage.input_tokens),
    outputTokens: numberOrNull(usage.output_tokens),
    reasoningTokens: numberOrNull(outputDetails.reasoning_tokens),
    totalTokens: numberOrNull(usage.total_tokens)
  };
}

export async function assertOpenAIUsageBudget(stage: string, model: string, requestedReserveTokens?: number) {
  if (!config.OPENAI_USAGE_GUARD_ENABLED) return null;
  const context = currentOpenAIUsageContext();
  const requestSource = requestSourceFromContext(context);
  const tokenBudget = config.OPENAI_DAILY_TOKEN_BUDGET;
  const reserveTokens = Math.max(
    config.OPENAI_BUDGET_GUARD_RESERVE_TOKENS,
    Number.isFinite(requestedReserveTokens) ? Math.ceil(Number(requestedReserveTokens)) : 0
  );
  let client: PoolClient | undefined;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [reservationBucket]);
    const totals = await client.query(
      `SELECT
         coalesce((
           SELECT sum(total_tokens)
           FROM openai_usage_events
           WHERE created_at >= now() - interval '24 hours'
         ), 0)::bigint AS used_tokens,
         coalesce((
           SELECT sum(reserved_tokens)
           FROM openai_usage_reservations
           WHERE bucket = $1
             AND status = 'reserved'
             AND expires_at > now()
         ), 0)::bigint AS reserved_tokens`,
      [reservationBucket]
    );
    const usedTokens = Number(totals.rows[0]?.used_tokens ?? 0);
    const activeReservedTokens = Number(totals.rows[0]?.reserved_tokens ?? 0);
    if (usedTokens + activeReservedTokens + reserveTokens > tokenBudget) {
      throw new OpenAIUsageBudgetExceededError(
        `OpenAI daily token budget exceeded for ${requestSource}`,
        {
          stage,
          model,
          requestSource,
          usedTokens,
          activeReservedTokens,
          reserveTokens,
          tokenBudget,
          sessionId: context.sessionId ?? null,
          turnId: context.turnId ?? null
        }
      );
    }
    const reservation = await client.query(
      `INSERT INTO openai_usage_reservations(
         bucket, stage, model, request_source, session_id, turn_id, reserved_tokens, expires_at
       )
       VALUES ($1, $2, $3, $4, $5::uuid, $6::uuid, $7, now() + ($8 || ' minutes')::interval)
       RETURNING id`,
      [
        reservationBucket,
        stage,
        model,
        requestSource,
        context.sessionId ?? null,
        context.turnId ?? null,
        reserveTokens,
        reservationTtlMinutes
      ]
    );
    await client.query('COMMIT');
    return String(reservation.rows[0].id);
  } catch (error) {
    await client?.query('ROLLBACK').catch(() => undefined);
    if (error instanceof OpenAIUsageBudgetExceededError) throw error;
    throw new OpenAIUsageBudgetExceededError('OpenAI usage ledger unavailable', {
      stage,
      model,
      requestSource,
      tokenBudget,
      reason: error instanceof Error ? error.message : String(error)
    });
  } finally {
    client?.release();
  }
}

export function bindOpenAIUsageReservation(response: unknown, reservationId: string | null) {
  if (reservationId && response && typeof response === 'object') {
    usageReservationByResponse.set(response, reservationId);
  }
}

export async function releaseOpenAIUsageReservation(reservationId: string | null) {
  if (!reservationId) return;
  await pool.query(
    `UPDATE openai_usage_reservations
     SET status = 'released', updated_at = now()
     WHERE id = $1 AND status = 'reserved'`,
    [reservationId]
  ).catch(() => undefined);
}

export async function recordOpenAIUsage(stage: string, model: string, response: unknown) {
  if (!response || typeof response !== 'object') return;
  if (usageRecorded.has(response)) return;

  const usage = extractOpenAIUsage(response);
  const context = currentOpenAIUsageContext();
  const requestSource = requestSourceFromContext(context);
  const responseId = typeof (response as { id?: unknown }).id === 'string'
    ? (response as { id: string }).id
    : null;

  const reservationId = usageReservationByResponse.get(response) ?? null;
  if (config.NODE_ENV === 'test' && !reservationId) {
    usageRecorded.add(response);
    return;
  }
  let client: PoolClient | undefined;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO openai_usage_events(
         stage,
         model,
         request_source,
         session_id,
         turn_id,
         page_url,
         user_agent,
         input_tokens,
         output_tokens,
         reasoning_tokens,
         total_tokens,
         response_id,
         metadata
       )
       VALUES ($1, $2, $3, $4::uuid, $5::uuid, $6, $7, $8, $9, $10, $11, $12, $13::jsonb)`,
      [
        stage,
        model,
        requestSource,
        context.sessionId ?? null,
        context.turnId ?? null,
        context.pageUrl ?? null,
        context.userAgent ?? null,
        usage.inputTokens,
        usage.outputTokens,
        usage.reasoningTokens,
        usage.totalTokens,
        responseId,
        JSON.stringify({ hasUsage: usage.totalTokens !== null })
      ]
    );
    if (reservationId) {
      await client.query(
        `UPDATE openai_usage_reservations
         SET status = 'reconciled', actual_tokens = $2, updated_at = now()
         WHERE id = $1 AND status = 'reserved'`,
        [reservationId, usage.totalTokens ?? 0]
      );
    }
    await client.query('COMMIT');
    usageRecorded.add(response);
    usageReservationByResponse.delete(response);
  } catch (error) {
    await client?.query('ROLLBACK').catch(() => undefined);
    const message = error instanceof Error ? error.message : String(error);
    console.warn('[OpenAIUsage] Failed to record usage event', { stage, model, message });
  } finally {
    client?.release();
  }
}

export async function recordOpenAIUsageOnce(stage: string, model: string, response: unknown) {
  await recordOpenAIUsage(stage, model, response);
}

function numberOrNull(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
