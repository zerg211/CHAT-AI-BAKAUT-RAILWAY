import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';

const db = vi.hoisted(() => ({ query: vi.fn(), connect: vi.fn(), commitMessage: vi.fn() }));
vi.mock('../src/db/pool.js', () => ({ pool: { query: db.query, connect: db.connect } }));
vi.mock('../src/config.js', () => ({ config: {
  OPENAI_API_KEY: 'offline-dummy-key', OPENAI_PLATFORM_AGENT_ID: 'offline-agent', BAKAUT_MCP_TOKEN: 'offline-dummy-token',
  BAKAUT_CATALOG_URL: 'https://catalog-search-production.up.railway.app', OPENAI_USAGE_GUARD_ENABLED: true,
  OPENAI_MONETARY_GUARD_ENABLED: false, OPENAI_DAILY_TOKEN_BUDGET: 10_000_000, OPENAI_BUDGET_GUARD_RESERVE_TOKENS: 1,
  CONTROLLED_WEB_SEARCH_ENABLED: true, CONTROLLED_WEB_SEARCH_FEES_APPROVED: true
} }));
vi.mock('../src/db/repositories.js', () => ({ ConversationRepository: class {
  addAssistantMessageForTurn = db.commitMessage;
  listMessages = async () => [];
}, LeadRepository: class {} }));
vi.mock('../src/catalog/currentSitePrice.js', () => ({ readSitePriceObservation: async () => ({ status: 'unknown' }) }));
// The separate web ledger is outside this regression; platform accounting stays real.
vi.mock('../src/ai/controlledWebSearchLedger.js', () => ({ controlledWebSearchLedger: (input: any) => ({
  reserve: async () => 'offline-web-reservation', recordUsage: async () => undefined,
  saveCheckpoint: async (payload: unknown) => input.conversations.upsertTurnCheckpoint({ checkpoint: 'controlled_web_search', payload })
}) }));
import { PlatformAgentAssistant } from '../src/ai/platformAgentAssistant.js';
import { ControlledResponsesClient } from '../src/ai/controlledResponsesClient.js';
import { assertOpenAIUsageBudget, bindOpenAIUsageReservation, estimateRecordedUsageCost, recordOpenAIUsageOnce,
  runWithOpenAIUsageContext } from '../src/ai/openaiUsageGuard.js';
import type { ConversationRepository } from '../src/db/repositories.js';

type EventRow = { stage: string; responseId: string; input: number | null; output: number | null; total: number | null;
  cost: number | null; metadata: Record<string, unknown> };
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.clearAllMocks(); });

describe('actual usage ledger across catalog checkpoint failure and recovery', () => {
  it.each([false, true])('updates pending once logically before checkpoint failure and reuses the response (search=%s)', async search => {
    const sessionId = randomUUID(), turnId = randomUUID(), productId = 'a'.repeat(24);
    const usage = { input_tokens: 1000, output_tokens: 100, total_tokens: 1100, input_tokens_details: { cached_tokens: 500 } };
    const item = { product_id: productId, requested_product_id: productId, status: 'found', completeness: 'full', source_revision: 'rev',
      name: 'Offline model', price_rub: 100, attributes: {}, description: 'Offline fixture', documents: [], original_card: { test: true } };
    const events = new Map<string, EventRow>();
    const reservations = new Map<string, { actual: number | null; status: string; operation: string }>();
    const order: string[] = []; let inserts = 0, actualUpdates = 0, reconciliations = 0;
    const unexpectedSql: string[] = [];
    const query = vi.fn(async (sql: string, args: any[] = []) => {
      if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql) || sql.includes('pg_advisory_xact_lock')) return { rows: [], rowCount: 0 };
      if (sql.includes('matching_operations')) return { rows: [{ committed_tokens: 0,
        matching_operations: [...reservations.values()].filter(row => row.operation === args[2]).length }] };
      if (sql.includes('AS used_tokens')) return { rows: [{ used_tokens: 0, reserved_tokens: 0 }] };
      if (sql.includes('INSERT INTO openai_usage_reservations')) {
        const id = randomUUID(); reservations.set(id, { actual: null, status: 'reserved', operation: args[8] });
        return { rows: [{ id }], rowCount: 1 };
      }
      if (sql.startsWith('SELECT 1 FROM openai_usage_events')) {
        const exists = events.has(`${args[0]}:${args[1]}`); return { rows: exists ? [{ exists: 1 }] : [], rowCount: exists ? 1 : 0 };
      }
      if (sql.includes('INSERT INTO openai_usage_events')) {
        inserts++;
        const key = `${args[0]}:${args[12]}`; expect(events.has(key)).toBe(false);
        events.set(key, { stage: args[0], responseId: args[12], input: args[7], output: args[8], total: args[10],
          cost: args[11], metadata: JSON.parse(args[13]) });
        order.push(`insert:${args[12]}:${args[10]}`); return { rows: [], rowCount: 1 };
      }
      if (sql.includes('UPDATE openai_usage_events')) {
        const row = events.get(`${args[0]}:${args[1]}`); expect(row).toBeDefined();
        Object.assign(row!, { input: args[2], output: args[3], total: args[5], cost: args[6], metadata: { ...row!.metadata, ...JSON.parse(args[7]) } });
        if (args[1] === 'resp_completed') actualUpdates++;
        order.push(`actual:${args[1]}`); return { rows: [], rowCount: 1 };
      }
      if (sql.includes('UPDATE openai_usage_reservations')) {
        const row = reservations.get(args[0]);
        if (row?.status === 'reserved') {
          if (sql.includes("status = 'released'")) row.status = 'released';
          else { row.status = 'reconciled'; row.actual = args[1]; reconciliations++; }
          return { rows: [], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes('SELECT id FROM conversation_sessions')) return { rows: [{ id: sessionId }], rowCount: 1 };
      if (sql.startsWith('UPDATE platform_agent_sessions')) return { rows: [], rowCount: 1 };
      unexpectedSql.push(sql); throw new Error(`Unexpected SQL-mock statement: ${sql.slice(0, 70)}`);
    });
    db.query.mockImplementation(query); db.connect.mockResolvedValue({ query, release: vi.fn() });
    db.commitMessage.mockResolvedValue({ id: randomUUID() });
    const checkpoints = new Map<string, any>(); let failReview = true;
    const repository = {
      getTurn: vi.fn(async () => ({ id: turnId, status: 'answering', deadlineAt: null })),
      getSession: vi.fn(async () => ({ id: sessionId, status: 'active', needState: {} })),
      claimTurnExecution: vi.fn(async () => ({ id: turnId })), renewTurnExecution: vi.fn(), releaseTurnExecution: vi.fn(),
      listMessages: vi.fn(async () => []),
      listTurnCheckpoints: vi.fn(async () => [...checkpoints].map(([checkpoint, payload]) => ({ checkpoint, payload: structuredClone(payload) }))),
      upsertTurnCheckpoint: vi.fn(async ({ checkpoint, payload }: { checkpoint: string; payload: any }) => {
        if (checkpoint === 'catalog_review:resp_completed') {
          order.push('review-checkpoint');
          const row = events.get('platform_agent:resp_completed');
          expect(row).toMatchObject({ input: 1000, output: 100, total: 1100, metadata: { hasUsage: true } });
          expect(reservations.get(row!.metadata.reservationId as string)).toMatchObject({ status: 'reconciled', actual: 1100 });
          if (failReview) throw new Error('Offline catalog checkpoint failure');
        }
        checkpoints.set(checkpoint, structuredClone(payload));
      })
    } as unknown as ConversationRepository;
    const answer = { answer_contract: 'consultation_receipt_v1', answer: 'Предварительный вывод.', comparison_ids: [],
      recommendation_status: 'confirmed', selection_snapshots: [], availability: null,
      answer_review: { verdict: 'complete', publication: 'ready', rationale: 'Готово.' } };
    const output = (id: string, body: unknown) => Response.json({ id, status: 'completed', model: 'gpt-6-luna', service_tier: 'default', usage,
      output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify(body) }] }] });
    const posts: string[] = [], reads: string[] = [];
    const transport = vi.fn(async (url: any, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      if (String(url) === 'https://catalog-search-production.up.railway.app/health') return Response.json({ status: 'ok', revision: 'rev' });
      if (String(url) === 'https://catalog-search-production.up.railway.app/products-full' && init?.method === 'POST') {
        expect(JSON.parse(String(init.body)).identifiers).toEqual([productId]);
        return Response.json({ status: 'ok', mode: 'full', source_revision: 'rev', requested_ids: [productId], requested_count: 1,
          offset: 0, returned_count: 1, returned_ids: [productId], results: [item], has_more: false, complete: true, next_cursor: null });
      }
      if (new URL(String(url)).origin !== 'https://api.openai.com') throw new Error('External network forbidden');
      if (path === '/v1/agents/offline-agent') return Response.json({ model: 'gpt-6-luna', instructions: 'Offline fixture' });
      if (path === '/v1/responses/input_tokens') return Response.json({ object: 'response.input_tokens', input_tokens: 100 });
      if (path === '/v1/responses' && init?.method === 'POST') {
        const request = JSON.parse(String(init.body));
        const id = request.tools?.some((tool: any) => tool.type === 'web_search') ? 'resp_search'
          : request.text.format.schema.properties.candidate_updates ? 'resp_continuation' : 'resp_completed';
        if (posts.includes(id)) throw new Error('Unexpected repeated mock submission');
        posts.push(id); return Response.json({ id, model: 'gpt-6-luna', status: 'queued' });
      }
      const id = path.split('/').at(-1)!; reads.push(id);
      if (id === 'resp_completed') return output(id, { ...answer, candidate_decisions: {
        [productId]: { product_name: 'Offline model', basis: 'Исходные тестовые факты', decision: 'selected' } },
        web_search_intent: search ? { query: 'Проверить дополнительный факт', rationale: 'Тестовая потребность' } : null });
      if (id === 'resp_search') return Response.json({ id, status: 'completed', model: 'gpt-6-luna', usage,
        output: [{ type: 'web_search_call', status: 'completed' }, { type: 'message', role: 'assistant',
          content: [{ type: 'output_text', text: 'Offline findings', annotations: [] }] }] });
      if (id === 'resp_continuation') return output(id, { ...answer, web_search_intent: null,
        base_digest: checkpoints.get('controlled_web_continuation').plan.review.base.digest,
        source_review: [{ response_id: 'resp_search', assessment: 'Тестовая применимость' }], candidate_updates: [] });
      throw new Error('Unexpected offline provider request');
    });
    vi.stubGlobal('fetch', transport);
    await runWithOpenAIUsageContext({ sessionId, turnId }, async () => {
      const client = new ControlledResponsesClient('offline-dummy-key', 'offline-agent', transport as typeof fetch);
      const plan = await client.prepare({ message: 'Подберите под задачу', history: [], classificationIds: [productId],
        prefetch: { source_revision: 'rev', completeness: 'full', items: [item] } });
      const reservation = await assertOpenAIUsageBudget('platform_agent', plan.model, plan.reserveTokens, 'answer');
      const responseId = await client.submit(plan, turnId);
      checkpoints.set('platform_agent_submission', { kind: 'controlled_response', plan, reservation, attempted: true,
        responseId, userMessage: 'Подберите под задачу', phase: 'catalog_recompose',
        repair: { reason: 'category_review', sourceRevision: 'rev', correctedIds: [productId], priorKnownProductIds: [],
          previousDraft: '', originalResponseId: 'resp_discovery', checkedSnapshot: { status: 'ok', selection_mode: 'repair_candidates',
            source_revision: 'rev', items: [item], selected_count: 1 } } });
      const pending = { id: responseId, usage: null, service_tier: 'default' };
      bindOpenAIUsageReservation(pending, reservation);
      await recordOpenAIUsageOnce('platform_agent', plan.model, pending);
      expect(events.get('platform_agent:resp_completed')).toMatchObject({ total: null, metadata: { hasUsage: false } });
      expect(reservations.get(reservation!)).toMatchObject({ status: 'reserved', actual: null });
      const assistant = new PlatformAgentAssistant(repository);
      await expect(assistant.recoverTurn({ sessionId, turnId })).rejects.toThrow('Offline catalog checkpoint failure');
      const actual = structuredClone(events.get('platform_agent:resp_completed')!);
      expect(actual.cost).toBe(estimateRecordedUsageCost(plan.model, { usage, service_tier: 'default' }).costUsd);
      expect(order.indexOf('actual:resp_completed')).toBeLessThan(order.indexOf('review-checkpoint'));
      expect(posts).toEqual(['resp_completed']); expect(db.commitMessage).not.toHaveBeenCalled();
      failReview = false;
      const result = await assistant.recoverTurn({ sessionId, turnId });
      expect(result.answer).toBe('Предварительный вывод.'); expect(db.commitMessage).toHaveBeenCalledOnce();
      expect(events.get('platform_agent:resp_completed')).toEqual(actual);
      expect([...events.values()].filter(row => row.responseId === 'resp_completed')).toHaveLength(1);
      expect(reads.filter(id => id === 'resp_completed')).toHaveLength(2);
      expect(posts).toEqual(search ? ['resp_completed', 'resp_search', 'resp_continuation'] : ['resp_completed']);
      expect(actualUpdates).toBe(2);
      expect(inserts).toBe(search ? 2 : 1); expect(reconciliations).toBe(search ? 2 : 1);
      expect(unexpectedSql).toEqual([]);
      expect([...events.values()].reduce((total, row) => total + (row.total ?? 0), 0)).toBe(search ? 2200 : 1100);
      expect(query.mock.calls.filter(([sql]) => sql.includes('pg_advisory_xact_lock')).map(([, args]) => args?.[0]))
        .toContain('platform_agent:resp_completed');
    });
  });
});
