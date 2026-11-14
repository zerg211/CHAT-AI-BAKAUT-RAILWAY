import { PlatformAgentClient } from './platformAgentClient.js';
import { randomUUID } from 'node:crypto';
import { diagnosticEvent, diagnosticSpan, runWithDiagnostics } from '../observability/diagnostics.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { PoolClient } from 'pg';
import { config } from '../config.js';
import { pool } from '../db/pool.js';
import { estimateProviderUsageCostUsd } from './openaiRequestBudget.js';
import { estimateLunaStandardTokenCost, isPricingStale, lunaPricing } from './modelPricing.js';
import { runWithTurnTiming } from '../observability/turnTiming.js';
import { z } from 'zod';

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

const nonnegativeInteger = z.string().regex(/^(0|[1-9][0-9]{0,36})$/);
const monetaryPolicySchema = z.object({ version: z.string().trim().min(1), model: z.string().min(1), tier: z.string().min(1),
  validUntil: z.number().int().safe(), capNano: nonnegativeInteger, inputNanoPerMillion: nonnegativeInteger,
  outputNanoPerMillion: nonnegativeInteger, otherFeesNano: nonnegativeInteger }).strict();
export type MonetaryBound = { inputTokens: number; outputTokens: number; tier: unknown; tools: unknown };

function monetaryQuote(model: string, bound?: MonetaryBound) {
  try {
    const policy = monetaryPolicySchema.parse(JSON.parse(config.OPENAI_MONETARY_POLICY_JSON ?? ''));
    if (!bound || policy.validUntil <= Date.now() || model !== policy.model || bound.tier !== policy.tier ||
        !Number.isSafeInteger(bound.inputTokens) || bound.inputTokens < 0 ||
        !Number.isSafeInteger(bound.outputTokens) || bound.outputTokens < 0 ||
        !Array.isArray(bound.tools) || bound.tools.length !== 0) throw new Error('incomplete bound');
    const ceilMillion = (n: bigint) => (n + 999999n) / 1000000n;
    const amount = ceilMillion(BigInt(bound.inputTokens) * BigInt(policy.inputNanoPerMillion)) +
      ceilMillion(BigInt(bound.outputTokens) * BigInt(policy.outputNanoPerMillion)) + BigInt(policy.otherFeesNano);
    if (amount > 10n ** 38n - 1n) throw new Error('amount overflow');
    return { amount, cap: BigInt(policy.capNano), version: policy.version };
  } catch {
    throw new OpenAIUsageBudgetExceededError('Monetary admission unavailable', { stage: 'monetary' });
  }
}

export async function assertOpenAIUsageBudget(stage: string, model: string, requestedReserveTokens?: number, operationKey?: string, monetaryBound?: MonetaryBound) {
  const monetary = config.OPENAI_MONETARY_GUARD_ENABLED ? monetaryQuote(model, monetaryBound) : null;
  if (!config.OPENAI_USAGE_GUARD_ENABLED) {
    if (operationKey || monetary) throw new OpenAIUsageBudgetExceededError('OpenAI usage guard is disabled', { stage, model });
    return null;
  }
  const context = currentOpenAIUsageContext();
  if ((operationKey || monetary) && (!context.sessionId || !context.turnId || !operationKey)) {
    throw new OpenAIUsageBudgetExceededError('Trusted turn context unavailable', { stage, model });
  }
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
    if (monetary) {
      const money = await client.query(`SELECT coalesce(sum(monetary_reserved_nano),0)::text AS committed_nano,
        count(*) FILTER (WHERE monetary_reserved_nano IS NULL)::int AS unpriced
        FROM openai_usage_reservations WHERE session_id=$1::uuid AND turn_id=$2::uuid`,
      [context.sessionId, context.turnId]);
      if (Number(money.rows[0]?.unpriced) !== 0 || BigInt(money.rows[0]?.committed_nano) + monetary.amount > monetary.cap) {
        throw new OpenAIUsageBudgetExceededError('OpenAI monetary turn reservation unavailable', { stage, model });
      }
    }
    if (operationKey) {
      const turnTotals = await client.query(
        `SELECT
           coalesce(sum(CASE WHEN status = 'reserved' THEN reserved_tokens
                             WHEN status = 'reconciled' THEN actual_tokens ELSE 0 END), 0)::bigint AS committed_tokens,
           count(*) FILTER (WHERE operation_key = $3)::int AS matching_operations
         FROM openai_usage_reservations
         WHERE session_id = $1::uuid AND turn_id = $2::uuid`,
        [context.sessionId, context.turnId, operationKey]
      );
      const committedTokens = Number(turnTotals.rows[0]?.committed_tokens ?? 0);
      if (Number(turnTotals.rows[0]?.matching_operations ?? 0) > 0 || committedTokens + reserveTokens > tokenBudget) {
        throw new OpenAIUsageBudgetExceededError('OpenAI turn reservation unavailable', {
          stage, model, committedTokens, reserveTokens, tokenBudget, operationKey
        });
      }
    }
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
         bucket, stage, model, request_source, session_id, turn_id, reserved_tokens, expires_at, operation_key${monetary ? ', monetary_reserved_nano, monetary_policy_version' : ''}
       )
       VALUES ($1, $2, $3, $4, $5::uuid, $6::uuid, $7, now() + ($8 || ' minutes')::interval, $9${monetary ? ', $10::numeric, $11' : ''})
       RETURNING id`,
      [
        reservationBucket,
        stage,
        model,
        requestSource,
        context.sessionId ?? null,
        context.turnId ?? null,
        reserveTokens,
        reservationTtlMinutes,
        operationKey ?? null,
        ...(monetary ? [monetary.amount.toString(), monetary.version] : [])
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
  if (!reservationId || config.OPENAI_MONETARY_GUARD_ENABLED) return;
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
    if ((stage === 'platform_agent' || stage === 'semantic_catalog' || stage === 'semantic_catalog_cache_check' || stage === 'catalog_web_search') && responseId) {
      // A recovered request reads the same provider turn, not a new model call.
      // Serialize duplicate accounting without changing the global usage ledger.
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`${stage}:${responseId}`]);
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
          ...pricing,
          ...(reservationId ? { reservationId } : {})
        })
      ]
    );
    if (alreadyRecorded && usage.totalTokens !== null) await client.query(
      `UPDATE openai_usage_events
       SET input_tokens=coalesce($3,input_tokens), output_tokens=coalesce($4,output_tokens),
           reasoning_tokens=coalesce($5,reasoning_tokens), total_tokens=$6, cost_usd=coalesce($7,cost_usd),
           metadata=coalesce(metadata,'{}'::jsonb) || $8::jsonb, model=$9
       WHERE stage=$1 AND response_id=$2`,
      [stage, responseId, usage.inputTokens, usage.outputTokens, usage.reasoningTokens, usage.totalTokens,
        estimatedCostUsd, JSON.stringify({ hasUsage: true, ...pricing, ...(reservationId ? { reservationId } : {}) }), model]
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
    if (usage.totalTokens !== null) {
      usageRecorded.add(response);
      usageReservationByResponse.delete(response);
    }
  } catch {
    await client?.query('ROLLBACK').catch(() => undefined);
    diagnosticEvent('usage.record.failed', { code: 'usage_ledger_write_failed', usageKnown: usage.totalTokens !== null });
    console.warn('[OpenAIUsage] Failed to record usage event', { stage, model });
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
  const pending = await pool.query<{ id: string | null; session_id: string; turn_id: string; response_id: string;
    agent_session_id: string; model: string; reservation_id?: string | null }>(
    `SELECT * FROM (
      SELECT DISTINCT ON (response_id) * FROM (
       SELECT e.id, e.session_id, e.turn_id, e.response_id, e.model,
              coalesce(receipt.payload->>'agentSessionId',s.agent_session_id,'') AS agent_session_id,
              coalesce(e.metadata->>'reservationId', receipt.payload->>'reservation', CASE WHEN cp.payload->>'responseId'=e.response_id
                THEN cp.payload->>'reservation' END) AS reservation_id,
              e.total_tokens IS NULL AS usage_missing, e.created_at
       FROM openai_usage_events e LEFT JOIN platform_agent_sessions s ON s.session_id=e.session_id
       LEFT JOIN turn_checkpoints cp ON cp.session_id=e.session_id AND cp.turn_id=e.turn_id
         AND cp.checkpoint='platform_agent_submission'
       LEFT JOIN turn_checkpoints receipt ON receipt.session_id=e.session_id AND receipt.turn_id=e.turn_id
         AND receipt.checkpoint='platform_agent_usage:' || e.response_id
         AND receipt.payload->>'kind'='platform_usage_response' AND receipt.payload->>'responseId'=e.response_id
       WHERE e.stage='platform_agent' AND e.response_id IS NOT NULL AND e.turn_id IS NOT NULL
         AND (receipt.payload->>'agentSessionId' IS NOT NULL OR s.agent_session_id IS NOT NULL OR left(e.response_id,5)='resp_')
         AND e.created_at > now() - interval '30 days'
         AND (e.total_tokens IS NULL OR e.created_at > now() - interval '15 minutes')
       UNION ALL
       SELECT NULL::uuid AS id, cp.session_id, cp.turn_id, cp.payload->>'responseId' AS response_id,
              cp.payload->'plan'->>'model' AS model, ''::text AS agent_session_id,
              cp.payload->>'reservation' AS reservation_id, true AS usage_missing, cp.updated_at AS created_at
       FROM turn_checkpoints cp
       WHERE cp.checkpoint='platform_agent_submission' AND cp.payload->>'kind'='controlled_response'
         AND left(cp.payload->>'responseId',5)='resp_' AND coalesce(cp.payload->'plan'->>'model','')<>''
         AND cp.updated_at > now() - interval '30 days'
         AND NOT EXISTS (SELECT 1 FROM openai_usage_events e
           WHERE e.stage='platform_agent' AND e.response_id=cp.payload->>'responseId')
       UNION ALL
       SELECT NULL::uuid AS id, cp.session_id, cp.turn_id, cp.payload->>'responseId' AS response_id,
              cp.payload->>'model' AS model, coalesce(cp.payload->>'agentSessionId','') AS agent_session_id,
              cp.payload->>'reservation' AS reservation_id, true AS usage_missing, cp.updated_at AS created_at
       FROM turn_checkpoints cp
       WHERE cp.checkpoint='platform_agent_usage:' || (cp.payload->>'responseId')
         AND cp.payload->>'kind'='platform_usage_response' AND coalesce(cp.payload->>'responseId','')<>''
         AND coalesce(cp.payload->>'model','')<>''
         AND (left(cp.payload->>'responseId',5)='resp_' OR coalesce(cp.payload->>'agentSessionId','')<>'')
         AND cp.updated_at > now() - interval '30 days'
         AND NOT EXISTS (SELECT 1 FROM openai_usage_events e
           WHERE e.stage='platform_agent' AND e.response_id=cp.payload->>'responseId')
      ) candidates ORDER BY response_id, id NULLS LAST, usage_missing DESC, created_at DESC
     ) unique_candidates ORDER BY usage_missing DESC, created_at DESC LIMIT 25`
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
      const actualModel = typeof turn.model === 'string' && turn.model ? turn.model : row.model;
      const pricing = estimateRecordedUsageCost(actualModel, turn);
      const db = await pool.connect();
      try {
        await db.query('BEGIN');
        await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`platform_agent:${row.response_id}`]);
        let eventId = row.id;
        if (!eventId) {
          const existing = await db.query<{ id: string }>(
            `SELECT id FROM openai_usage_events WHERE stage='platform_agent' AND response_id=$1 LIMIT 1`, [row.response_id]
          );
          eventId = existing.rows[0]?.id ?? null;
          if (!eventId) {
            const inserted = await db.query<{ id: string }>(
              `INSERT INTO openai_usage_events(stage,model,request_source,session_id,turn_id,response_id,metadata)
               VALUES ('platform_agent',$1,'unknown',$2::uuid,$3::uuid,$4,$5::jsonb) RETURNING id`,
              [row.model, row.session_id, row.turn_id, row.response_id,
                JSON.stringify({ hasUsage: false, ...(row.reservation_id ? { reservationId: row.reservation_id } : {}) })]
            );
            eventId = inserted.rows[0]?.id ?? null;
          }
          if (!eventId) throw new Error('Usage reconciliation event identity unavailable');
        }
        const persisted = await db.query(
          `UPDATE openai_usage_events SET input_tokens=coalesce($2,input_tokens), output_tokens=coalesce($3,output_tokens),
             reasoning_tokens=coalesce($4,reasoning_tokens), total_tokens=$5, cost_usd=coalesce($6,cost_usd),
             metadata=coalesce(metadata,'{}'::jsonb) || $7::jsonb, model=$9
           WHERE id=$1 AND stage='platform_agent' AND response_id=$8`,
          [eventId, usage.inputTokens, usage.outputTokens, usage.reasoningTokens, usage.totalTokens, pricing.costUsd,
            JSON.stringify({ hasUsage: true, ...pricing, usageReconciledAt: new Date().toISOString() }), row.response_id, actualModel]
        );
        if (persisted.rowCount !== 1) throw new Error('Usage reconciliation event was not persisted');
        await db.query(
          `UPDATE messages m SET metadata=coalesce(m.metadata,'{}'::jsonb) || jsonb_build_object('platformAgentUsage',$3::jsonb)
           FROM conversation_turns t WHERE t.id=$1 AND t.session_id=$2 AND t.assistant_message_id=m.id
             AND m.metadata->>'platformAgentTurnId'=$4`,
          [row.turn_id, row.session_id, JSON.stringify(turn.usage), row.response_id]
        );
        if (row.reservation_id) await db.query(
          `UPDATE openai_usage_reservations SET status='reconciled', actual_tokens=$2, updated_at=now()
           WHERE id::text=$1 AND session_id=$3 AND turn_id=$4 AND stage='platform_agent' AND status='reserved'`,
          [row.reservation_id, usage.totalTokens, row.session_id, row.turn_id]
        );
        else if (!row.response_id.startsWith('resp_')) await db.query(
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
    } catch {
      diagnosticEvent('usage.reconciliation.failed',{usageKnown:false,code:'usage_reconciliation_failed'});
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
    inFlight = runWithDiagnostics({jobType:'platform_usage_batch',jobId:randomUUID()},() => diagnosticSpan('usage.reconciliation',async () => reconcilePlatformAgentUsage())).catch(() => {
      diagnosticEvent('usage.worker.failed',{code:'usage_reconciliation_batch_failed'});
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
