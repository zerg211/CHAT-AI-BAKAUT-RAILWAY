import { pool } from '../db/pool.js';
import type { ConversationRepository } from '../db/repositories.js';
import { assertOpenAIUsageBudget, currentOpenAIUsageContext } from './openaiUsageGuard.js';
import { webStepKey, type SearchDependencies, type SearchReceipt } from './controlledWebSearch.js';

/** Uses the existing authenticated turn context and owner-checked checkpoint. */
export function controlledWebSearchLedger(input: { sessionId: string; turnId: string; ownerId: string; conversations: ConversationRepository }):
  Pick<SearchDependencies, 'reserve' | 'saveCheckpoint' | 'recordUsage'> {
  function assertContext() {
    const context = currentOpenAIUsageContext();
    if (!input.sessionId || !input.turnId || !input.ownerId || context.sessionId !== input.sessionId || context.turnId !== input.turnId) {
      throw new Error('Trusted search turn context unavailable');
    }
  }
  return {
    reserve: async (model, tokens, operationKey) => {
      assertContext();
      return assertOpenAIUsageBudget('controlled_web_search', model, tokens, operationKey);
    },
    saveCheckpoint: async checkpoint => {
      assertContext();
      if (checkpoint.sessionId !== input.sessionId || checkpoint.turnId !== input.turnId) throw new Error('Search checkpoint ownership mismatch');
      await input.conversations.upsertTurnCheckpoint({ sessionId: input.sessionId, turnId: input.turnId,
        executionOwner: input.ownerId, checkpoint: webStepKey('controlled_web_search', checkpoint.step), status: 'running', payload: checkpoint });
    },
    recordUsage: async (reservationId, receipt) => {
      assertContext();
      await recordSearchUsage(input, reservationId, receipt);
    }
  };
}

async function recordSearchUsage(input: { sessionId: string; turnId: string }, reservationId: string, receipt: SearchReceipt) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`controlled_web_search:${receipt.responseId}`]);
    const owned = await client.query(`SELECT status, model FROM openai_usage_reservations WHERE id=$1::uuid AND session_id=$2::uuid
      AND turn_id=$3::uuid AND stage='controlled_web_search' AND status IN ('reserved','reconciled') FOR UPDATE`,
      [reservationId, input.sessionId, input.turnId]);
    if (owned.rowCount !== 1 || owned.rows[0].model !== receipt.model) throw new Error('Search reservation ownership unavailable');
    const existing = await client.query(`SELECT id, session_id, turn_id, metadata, total_tokens FROM openai_usage_events
      WHERE stage='controlled_web_search' AND response_id=$1`, [receipt.responseId]);
    if (existing.rows.length > 1 || (existing.rows.length &&
      (existing.rows[0].session_id !== input.sessionId || existing.rows[0].turn_id !== input.turnId ||
       existing.rows[0].metadata?.reservationId !== reservationId))) throw new Error('Search receipt ownership mismatch');
    const usage = receipt.usage ?? {};
    const validNumber = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
    const total = validNumber(usage.total_tokens);
    if (existing.rows.length && existing.rows[0].total_tokens != null && total !== null && Number(existing.rows[0].total_tokens) !== total) {
      throw new Error('Search receipt usage changed');
    }
    const metadata = JSON.stringify({ reservationId, rawUsage: receipt.usage, toolFees: receipt.toolFees,
      monetaryCost: null, costStatus: 'unknown' });
    if (existing.rows.length) {
      await client.query(`UPDATE openai_usage_events SET input_tokens=coalesce($2,input_tokens), output_tokens=coalesce($3,output_tokens), total_tokens=coalesce($4,total_tokens),
        model=$5, cost_usd=NULL, metadata=$6::jsonb WHERE id=$1`, [existing.rows[0].id,
        validNumber(usage.input_tokens), validNumber(usage.output_tokens), total, receipt.model, metadata]);
    } else {
      await client.query(`INSERT INTO openai_usage_events(stage,model,session_id,turn_id,input_tokens,output_tokens,total_tokens,cost_usd,response_id,metadata)
        VALUES ('controlled_web_search',$1,$2::uuid,$3::uuid,$4,$5,$6,NULL,$7,$8::jsonb)`, [receipt.model,
        input.sessionId, input.turnId, validNumber(usage.input_tokens), validNumber(usage.output_tokens), total, receipt.responseId, metadata]);
    }
    if (total !== null) await client.query(`UPDATE openai_usage_reservations SET status='reconciled',actual_tokens=$2,updated_at=now()
      WHERE id=$1::uuid AND status='reserved'`, [reservationId, total]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally { client.release(); }
}
