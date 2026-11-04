import { PlatformAgentClient } from './platformAgentClient.js';
import { randomUUID } from 'node:crypto';
import { diagnosticEvent, diagnosticError, diagnosticSpan, runWithDiagnostics } from '../observability/diagnostics.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { PoolClient } from 'pg';
import { config } from '../config.js';
import { pool } from '../db/pool.js';
import { estimateProviderUsageCostUsd } from './openaiRequestBudget.js';
import { estimateLunaStandardTokenCost, isPricingStale, lunaPricing } from './modelPricing.js';
import { runWithTurnTiming } from '../observability/turnTiming.js';

export type OpenAIUsageContext = {
  sessionId?: string | null;
  turnId?: string | null;
  pageUrl?: string | null;
  userAgent?: string | null;
};

type UsageNumbers = {
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  totalTokens: number | null;
};

const usageContext = new AsyncLocalStorage<OpenAIUsageContext>();
const usageRecorded = new WeakSet<object>();
const usageReservationByResponse = new WeakMap<object, string>();
const reservationBucket = 'global_openai_tokens_24h';
// Unknown outcomes must not silently become free again within the daily window.
const reservationTtlMinutes = 24 * 60;

export class OpenAIUsageBudgetExceededError extends Error {
  constructor(message: string, readonly details: Record<string, unknown>) {
    super(message);
    this.name = 'OpenAIUsageBudgetExceededError';
  }
}

export function runWithOpenAIUsageContext<T>(context: OpenAIUsageContext, fn: () => Promise<T>): Promise<T> {
  return usageContext.run(context, () => context.sessionId && context.turnId
    ? runWithTurnTiming({sessionId: context.sessionId, turnId: context.turnId}, fn)
    : fn());
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
    return { inputTokens: null, cachedInputTokens: null, outputTokens: null, reasoningTokens: null, totalTokens: null };
  }
  const outputDetails = usage.output_tokens_details && typeof usage.output_tokens_details === 'object'
    ? usage.output_tokens_details as Record<string, unknown>
    : {};
  const inputDetails = usage.input_tokens_details && typeof usage.input_tokens_details === 'object'
    ? usage.input_tokens_details as Record<string, unknown>
    : {};
  return {
    inputTokens: numberOrNull(usage.input_tokens),
    cachedInputTokens: numberOrNull(inputDetails.cached_tokens),
    outputTokens: numberOrNull(usage.output_tokens),
    reasoningTokens: numberOrNull(outputDetails.reasoning_tokens),
    totalTokens: numberOrNull(usage.total_tokens)
  };
}

export function estimateRecordedUsageCost(model: string, response: unknown) {
  const usage = extractOpenAIUsage(response);
  const tier = response && typeof response === 'object'
    ? (response as { service_tier?: unknown }).service_tier
    : undefined;
  const isLuna = model === lunaPricing.model || model.startsWith(`${lunaPricing.model}-`);
  if (isLuna) {
    // An absent tier is not proof of standard processing. Missing cache counts
    // also remain unknown rather than silently charging the uncached rate.
    const supported = tier === 'default' && !isPricingStale(lunaPricing.verifiedAt) &&
      usage.inputTokens !== null && usage.cachedInputTokens !== null && usage.outputTokens !== null;
    const costUsd = supported ? estimateLunaStandardTokenCost({
      inputTokens: usage.inputTokens!, cachedInputTokens: usage.cachedInputTokens!, outputTokens: usage.outputTokens!
    }) : null;
    return { costUsd, costBasis: costUsd === null ? 'unavailable' : 'standard_token_rate_estimate',
      pricingVersion: lunaPricing.version, serviceTier: typeof tier === 'string' ? tier : null,
      cachedInputTokens: usage.cachedInputTokens, excludes: ['cache_write_surcharge', 'hosted_tools', 'account_adjustments'] };
  }
  const costUsd = estimateProviderUsageCostUsd({ model, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens });
  return { costUsd, costBasis: costUsd === null ? 'unavailable' : 'legacy_reservation_ceiling_estimate',
    pricingVersion: 'legacy-2026-07-11', serviceTier: typeof tier === 'string' ? tier : null,
    cachedInputTokens: usage.cachedInputTokens, excludes: ['cached_input_discount', 'hosted_tools', 'account_adjustments'] };
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
  const pricing = estimateRecordedUsageCost(model, response);
  const estimatedCostUsd = pricing.costUsd;
  if (config.NODE_ENV === 'test' && !reservationId) {
    usageRecorded.add(response);
    return;
  }
  let client: PoolClient | undefined;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    let alreadyRecorded = false;
    if (stage === 'platform_agent' && responseId) {
      // A recovered request reads the same provider turn, not a new model call.
      // Serialize duplicate accounting without changing the global usage ledger.
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`platform_agent:${responseId}`]);
      const existing = await client.query(
        'SELECT 1 FROM openai_usage_events WHERE stage = $1 AND response_id = $2 LIMIT 1', [stage, responseId]
      );
      alreadyRecorded = Boolean(existing.rowCount);
    }
    if (!alreadyRecorded) await client.query(
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
         cost_usd,
         response_id,
         metadata
       )
       VALUES ($1, $2, $3, $4::uuid, $5::uuid, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb)`,
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
        estimatedCostUsd,
        responseId,
        JSON.stringify({
          hasUsage: usage.totalTokens !== null,
          ...pricing
        })
      ]
    );
    if (reservationId && usage.totalTokens !== null) {
      await client.query(
        `UPDATE openai_usage_reservations
         SET status = 'reconciled', actual_tokens = $2, updated_at = now()
         WHERE id = $1 AND status = 'reserved'`,
        [reservationId, usage.totalTokens]
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

/** Platform usage is best-effort and may arrive after the turn has completed. */
export async function reconcilePlatformAgentUsage(transport: typeof fetch = fetch) {
  if (!config.OPENAI_API_KEY || !config.OPENAI_PLATFORM_AGENT_ID) return;
  const pending = await pool.query<{ id: string; session_id: string; turn_id: string; response_id: string; agent_session_id: string; model: string }>(
    `SELECT e.id, e.session_id, e.turn_id, e.response_id, e.model, s.agent_session_id
     FROM openai_usage_events e JOIN platform_agent_sessions s ON s.session_id=e.session_id
     WHERE e.stage='platform_agent' AND e.response_id IS NOT NULL AND e.turn_id IS NOT NULL
       AND e.created_at > now() - interval '30 days'
       AND (e.total_tokens IS NULL OR e.created_at > now() - interval '15 minutes')
     ORDER BY (e.total_tokens IS NULL) DESC, e.created_at DESC LIMIT 25`
  );
  diagnosticEvent('usage.reconciliation.candidates',{candidateCount:pending.rows.length});
  for (const row of pending.rows) {
    await runWithDiagnostics({jobType:'platform_usage_item',jobId:randomUUID(),sessionId:row.session_id,turnId:row.turn_id,agentTurnId:row.response_id},async () => {
    try {
      const client = new PlatformAgentClient(config.OPENAI_API_KEY!,config.OPENAI_PLATFORM_AGENT_ID!,[],transport);
      const turn = await client.readTurn(row.agent_session_id,row.response_id,AbortSignal.timeout(8_000));
      if (turn.id !== row.response_id || !turn.usage || typeof turn.usage !== 'object') { diagnosticEvent('usage.reconciliation.unknown',{usageKnown:false}); return; }
      const usage = extractOpenAIUsage(turn);
      if (usage.totalTokens === null) { diagnosticEvent('usage.reconciliation.unknown',{usageKnown:false}); return; }
      const pricing = estimateRecordedUsageCost(row.model, turn);
      const db = await pool.connect();
      try {
        await db.query('BEGIN');
        await db.query(
          `UPDATE openai_usage_events SET input_tokens=coalesce($2,input_tokens), output_tokens=coalesce($3,output_tokens),
             reasoning_tokens=coalesce($4,reasoning_tokens), total_tokens=$5, cost_usd=coalesce($6,cost_usd),
             metadata=coalesce(metadata,'{}'::jsonb) || $7::jsonb
           WHERE id=$1 AND stage='platform_agent' AND response_id=$8`,
          [row.id, usage.inputTokens, usage.outputTokens, usage.reasoningTokens, usage.totalTokens, pricing.costUsd,
            JSON.stringify({ hasUsage: true, cachedInputTokens: usage.cachedInputTokens, usageReconciledAt: new Date().toISOString() }), row.response_id]
        );
        await db.query(
          `UPDATE messages m SET metadata=coalesce(m.metadata,'{}'::jsonb) || jsonb_build_object('platformAgentUsage',$3::jsonb)
           FROM conversation_turns t WHERE t.id=$1 AND t.session_id=$2 AND t.assistant_message_id=m.id
             AND m.metadata->>'platformAgentTurnId'=$4`,
          [row.turn_id, row.session_id, JSON.stringify(turn.usage), row.response_id]
        );
        await db.query(
          `UPDATE openai_usage_reservations SET status='reconciled', actual_tokens=$3, updated_at=now()
           WHERE session_id=$1 AND turn_id=$2 AND stage='platform_agent' AND status='reserved'`,
          [row.session_id, row.turn_id, usage.totalTokens]
        );
        await db.query('COMMIT');
      } catch (error) {
        await db.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally { db.release(); }
      diagnosticEvent('usage.reconciliation.complete',{usageKnown:true,totalTokens:usage.totalTokens});
    } catch (error) {
      diagnosticError('usage.reconciliation.failed',error,{usageKnown:false});
      // Keep the event pending for the next run; never infer zero or expose credentials.
      console.warn('[OpenAIUsage] Could not reconcile platform agent usage');
    }
    });
  }
}

export function startPlatformUsageReconciliation() {
  let inFlight: Promise<void> | undefined;
  const run = () => {
    if (inFlight) return;
    inFlight = runWithDiagnostics({jobType:'platform_usage_batch',jobId:randomUUID()},() => diagnosticSpan('usage.reconciliation',async () => reconcilePlatformAgentUsage())).catch(error => {
      diagnosticError('usage.worker.failed',error);
      console.warn('[OpenAIUsage] Platform usage reconciliation failed');
    }).finally(() => { inFlight = undefined; });
  };
  run();
  const timer = setInterval(run, 60_000).unref();
  return async () => { clearInterval(timer); await inFlight; };
}

function numberOrNull(value: unknown) {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}
