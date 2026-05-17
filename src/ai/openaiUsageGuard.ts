import { AsyncLocalStorage } from 'node:async_hooks';
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
  const pageUrl = String(context.pageUrl ?? '').toLowerCase();
  const userAgent = String(context.userAgent ?? '').toLowerCase();
  if (userAgent.includes('headlesschrome') && pageUrl.includes('bakautprof.ru')) return 'production_live_test';
  if (pageUrl.includes('bakautprof.ru')) return 'production_widget';
  if (pageUrl.includes('localhost') || pageUrl.includes('127.0.0.1')) return 'local_widget';
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

export async function assertOpenAIUsageBudget(stage: string, model: string) {
  if (!config.OPENAI_USAGE_GUARD_ENABLED) return;
  const context = currentOpenAIUsageContext();
  const requestSource = requestSourceFromContext(context);
  const isProductionLiveTest = requestSource === 'production_live_test';
  const tokenBudget = isProductionLiveTest
    ? config.OPENAI_HEADLESS_DAILY_TOKEN_BUDGET
    : config.OPENAI_DAILY_TOKEN_BUDGET;
  if (!tokenBudget) return;

  const usedTokens = await sumTokensSince(
    new Date(Date.now() - 24 * 60 * 60 * 1000),
    isProductionLiveTest ? requestSource : undefined
  );
  const reserveTokens = config.OPENAI_BUDGET_GUARD_RESERVE_TOKENS;
  if (usedTokens + reserveTokens <= tokenBudget) return;

  throw new OpenAIUsageBudgetExceededError(
    `OpenAI daily token budget exceeded for ${requestSource}: used ${usedTokens}, reserve ${reserveTokens}, budget ${tokenBudget}`,
    {
      stage,
      model,
      requestSource,
      usedTokens,
      reserveTokens,
      tokenBudget,
      sessionId: context.sessionId ?? null,
      turnId: context.turnId ?? null
    }
  );
}

export async function recordOpenAIUsage(stage: string, model: string, response: unknown) {
  if (!response || typeof response !== 'object') return;
  if (usageRecorded.has(response)) return;
  usageRecorded.add(response);

  const usage = extractOpenAIUsage(response);
  const context = currentOpenAIUsageContext();
  const requestSource = requestSourceFromContext(context);
  const responseId = typeof (response as { id?: unknown }).id === 'string'
    ? (response as { id: string }).id
    : null;

  try {
    await pool.query(
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
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn('[OpenAIUsage] Failed to record usage event', { stage, model, message });
  }
}

export async function recordOpenAIUsageOnce(stage: string, model: string, response: unknown) {
  await recordOpenAIUsage(stage, model, response);
}

async function sumTokensSince(since: Date, requestSource?: string) {
  try {
    const result = requestSource
      ? await pool.query(
        `SELECT coalesce(sum(total_tokens), 0)::bigint AS total_tokens
         FROM openai_usage_events
         WHERE created_at >= $1
           AND request_source = $2`,
        [since, requestSource]
      )
      : await pool.query(
        `SELECT coalesce(sum(total_tokens), 0)::bigint AS total_tokens
         FROM openai_usage_events
         WHERE created_at >= $1`,
        [since]
      );
    return Number(result.rows[0]?.total_tokens ?? 0);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn('[OpenAIUsage] Failed to read token budget ledger', { requestSource, message });
    return 0;
  }
}

function numberOrNull(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
