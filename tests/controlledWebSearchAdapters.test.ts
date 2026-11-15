import { describe, expect, it, vi } from 'vitest';
import type { ConversationRepository } from '../src/db/repositories.js';
import type { ControlledResponsesClient } from '../src/ai/controlledResponsesClient.js';
import type { SearchCheckpoint } from '../src/ai/controlledWebSearch.js';

const state = vi.hoisted(() => ({ query: vi.fn(), reserve: vi.fn(), bind: vi.fn(), record: vi.fn(), checkpoints: vi.fn() }));
vi.mock('../src/db/pool.js', () => ({ pool: { connect: async () => ({ query: state.query, release: () => {} }) } }));
vi.mock('../src/ai/openaiUsageGuard.js', () => ({ currentOpenAIUsageContext: () => ({ sessionId: 'session', turnId: 'turn' }),
  assertOpenAIUsageBudget: state.reserve, bindOpenAIUsageReservation: state.bind, recordOpenAIUsageOnce: state.record }));
import { ControlledWebSearchProvider } from '../src/ai/controlledWebSearchProvider.js';
import { controlledWebSearchLedger } from '../src/ai/controlledWebSearchLedger.js';
import { runControlledWebSearch } from '../src/ai/controlledWebSearch.js';
import { continueAfterWebSearch } from '../src/ai/controlledWebContinuation.js';
import { acceptCatalogReview, reviewContext, reviewSources } from '../src/ai/catalogReviewState.js';
import type { WebContinuationCheckpoint } from '../src/ai/controlledWebContinuation.js';
import { config } from '../src/config.js';

describe('controlled search adapters, offline', () => {
  it('restores the exact review base and rejects changed context before reading or resubmitting', async () => {
    state.reserve.mockReset().mockResolvedValue('reservation');
    state.record.mockReset().mockResolvedValue(undefined);
    const prefetch = { source_revision: 'snapshot', completeness: 'full' as const, items: [{ product_id: 'a', name: 'A',
      attributes: {}, description: 'Full description', documents: [], original_card: { variant: 'A' } }] };
    const ctx = reviewContext(['a'], prefetch, 'Задача', []);
    const base = acceptCatalogReview(JSON.stringify({ answer: 'Вывод', candidate_decisions: {
      a: { product_name: 'A', basis: 'Исходный факт', decision: 'selected' }
    } }), ctx, [], 'resp_initial').state;
    const receipt = { responseId: 'source', status: 'ok' as const, model: 'model', usage: null, toolFees: null,
      monetaryCost: null, costStatus: 'unknown' as const, findings: 'New facts', sources: [] };
    const input = { sessionId: 'session', turnId: 'turn', ownerId: 'owner', message: 'Задача', history: [], prefetch,
      receipt, classificationIds: ['a'], catalogReview: base };
    let saved: WebContinuationCheckpoint | undefined;
    const conversations = { upsertTurnCheckpoint: vi.fn(async (entry: any) => { saved = structuredClone(entry.payload); }) } as unknown as ConversationRepository;
    const plan = { model: 'model', reserveTokens: 100, review: { context: ctx, sources: reviewSources([receipt]), base } };
    const prepare = vi.fn().mockResolvedValue(plan);
    const submit = vi.fn().mockResolvedValue('resp_review');
    const wait = vi.fn().mockRejectedValueOnce(new Error('interrupted')).mockResolvedValue({ turnId: 'resp_review', model: 'model', catalogReview: base });
    const client = { prepare, submit, wait } as unknown as ControlledResponsesClient;
    await expect(continueAfterWebSearch(input, { client, conversations })).rejects.toThrow('interrupted');
    expect(prepare.mock.calls[0][0]).toMatchObject({ catalogReview: base, classificationScope: 'Задача' });
    expect(saved).toMatchObject({ attempted: true, responseId: 'resp_review', plan: { review: { base } } });
    await expect(continueAfterWebSearch(input, { client, conversations }, saved)).resolves.toMatchObject({ catalogReview: base });
    for (const changed of [{ ...input, message: 'Другие условия' },
      { ...input, receipt: { ...receipt, findings: 'Replaced facts' } },
      { ...input, prefetch: { ...prefetch, source_revision: 'other' } },
      { ...input, catalogReview: undefined },
      { ...input, catalogReview: { ...base, decisions: { ...base.decisions, a: { ...base.decisions.a, basis: 'Tampered' } } } }]) {
      await expect(continueAfterWebSearch(changed, { client, conversations }, saved)).rejects.toThrow();
    }
    expect(prepare).toHaveBeenCalledOnce();
    expect(submit).toHaveBeenCalledOnce();
    expect(wait).toHaveBeenCalledTimes(2);
  });

  it.each(['legacy', 'identity_updates_v2'])('never repeats an unknown continuation submission with %s', async format => {
    state.reserve.mockReset().mockResolvedValue('reservation');
    const monetary = config.OPENAI_MONETARY_GUARD_ENABLED;
    config.OPENAI_MONETARY_GUARD_ENABLED = false;
    let saved: WebContinuationCheckpoint | undefined;
    const conversations = { upsertTurnCheckpoint: vi.fn(async (entry: any) => { saved = structuredClone(entry.payload); }) } as unknown as ConversationRepository;
    const client = { prepare: vi.fn().mockResolvedValue({ model: 'model', reserveTokens: 10 }),
      submit: vi.fn().mockRejectedValue(new Error('connection lost')), wait: vi.fn() } as unknown as ControlledResponsesClient;
    const input = { sessionId: 'session', turnId: 'turn', ownerId: 'owner', message: 'Задача', history: [], prefetch: {} as never,
      receipt: { responseId: 'source', status: 'ok' as const, model: 'model', usage: null, toolFees: null,
        monetaryCost: null, costStatus: 'unknown' as const, findings: '', sources: [] } };
    if (format === 'identity_updates_v2') {
      const prefetch = { source_revision: 'revision', completeness: 'full' as const, items: [{ product_id: 'a', name: 'A',
        attributes: {}, description: 'Original', documents: [], original_card: { variant: 'A' } }] };
      const context = reviewContext(['a'], prefetch, input.message, []);
      const base = acceptCatalogReview(JSON.stringify({ answer: 'Initial', candidate_decisions: {
        a: { product_name: 'A', basis: 'Original', decision: 'selected' }
      } }), context, [], 'resp_initial').state;
      Object.assign(input, { prefetch, classificationIds: ['a'], catalogReview: base });
      vi.mocked(client.prepare).mockResolvedValue({ model: 'model', reserveTokens: 10,
        manifest: { classification_format: format }, review: { context, sources: reviewSources([input.receipt]), base } } as never);
    }
    try {
      await expect(continueAfterWebSearch(input, { client, conversations })).rejects.toThrow('connection lost');
      if (format === 'identity_updates_v2') expect(saved?.plan.manifest.classification_format).toBe(format);
      await expect(continueAfterWebSearch(input, { client, conversations }, saved)).rejects.toThrow('outcome is unknown');
      expect(client.submit).toHaveBeenCalledOnce();
      expect(client.wait).not.toHaveBeenCalled();
      saved!.responseId = 'resp_known';
      vi.mocked(client.wait).mockResolvedValue({ turnId: 'resp_known', model: 'model' } as never);
      await expect(continueAfterWebSearch(input, { client, conversations }, saved)).resolves.toMatchObject({ turnId: 'resp_known' });
      expect(client.submit).toHaveBeenCalledOnce();
    } finally { config.OPENAI_MONETARY_GUARD_ENABLED = monetary; }
  });
  it('polls queued responses and resumes a timeout using only GET', async () => {
    let stage = 0;
    const transport = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      stage++;
      return Response.json({ id: 'resp_x', model: 'model', status: stage < 3 ? 'in_progress' : 'completed',
        ...(stage >= 3 ? { output: [{ type: 'web_search_call', status: 'completed' }] } : {}) });
    }) as unknown as typeof fetch;
    const provider = new ControlledWebSearchProvider('key', 'model', 10, transport, 1000, 1);
    expect((await provider.read('resp_x')).status).toBe('ok');
    expect(transport).toHaveBeenCalledTimes(3);
    const abort = new AbortController(); abort.abort();
    await expect(provider.read('resp_x', abort.signal)).rejects.toBeDefined();
    expect((await provider.read('resp_x')).responseId).toBe('resp_x');
    expect(vi.mocked(transport).mock.calls.every(([, init]) => init?.method === 'GET')).toBe(true);
  });
  it('times out a pending response and later resumes it without a POST', async () => {
    let completed = false;
    const transport = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.method).toBe('GET');
      return Response.json({ id: 'resp_x', model: 'model', status: completed ? 'completed' : 'in_progress',
        ...(completed ? { output: [{ type: 'web_search_call', status: 'completed' }] } : {}) });
    }) as unknown as typeof fetch;
    const provider = new ControlledWebSearchProvider('key', 'model', 10, transport, 10, 1);
    await expect(provider.read('resp_x')).rejects.toBeDefined();
    completed = true;
    expect((await provider.read('resp_x')).status).toBe('ok');
    expect(vi.mocked(transport).mock.calls.every(([, init]) => init?.method === 'GET')).toBe(true);
  });
  it('moves a source through provider, durable ledger and the original-model continuation', async () => {
    state.reserve.mockReset().mockResolvedValueOnce('reservation').mockResolvedValueOnce('continuation-reservation');
    state.query.mockReset().mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT status, model')) return { rowCount: 1, rows: [{ status: 'reserved', model: 'model' }] };
      return { rowCount: 0, rows: [] };
    });
    state.checkpoints.mockReset().mockResolvedValue(undefined);
    const transport = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === 'POST') return Response.json({ id: 'resp_web', model: 'model', status: 'queued' });
      return Response.json({ id: 'resp_web', model: 'model', status: 'completed', usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 },
        tool_fees: { amount: 1, currency: 'USD' }, output: [{ type: 'web_search_call', status: 'completed' },
          { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Факт', annotations: [
            { type: 'url_citation', url: 'https://example.test/manual', title: 'Руководство' }] }] }] });
    }) as unknown as typeof fetch;
    const provider = new ControlledWebSearchProvider('test-key', 'model', 100, transport);
    const conversations = { upsertTurnCheckpoint: state.checkpoints } as unknown as ConversationRepository;
    const ledger = controlledWebSearchLedger({ sessionId: 'session', turnId: 'turn', ownerId: 'owner', conversations });
    const search = await runControlledWebSearch({ sessionId: 'session', turnId: 'turn', query: 'Размер', model: 'model', reserveTokens: 100 },
      { ...ledger, submit: provider.submit, read: provider.read });
    expect(search.receipt).toMatchObject({ status: 'ok', toolFees: { amount: 1 }, costStatus: 'unknown', monetaryCost: null });
    expect(state.query.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO openai_usage_events'))).toBe(true);
    expect(state.query.mock.calls.some(([sql]) => String(sql).includes("status='reconciled'"))).toBe(true);
    const prepare = vi.fn(async (args: any) => { expect(args.webSearchReceipt.sources[0].url).toBe('https://example.test/manual');
      return { model: 'model', reserveTokens: 150 }; });
    const submit = vi.fn(async () => 'resp_primary');
    const wait = vi.fn(async () => ({ turnId: 'resp_primary', model: 'model', usage: { total_tokens: 20 } }));
    const client = { prepare, submit, wait } as unknown as ControlledResponsesClient;
    const result = await continueAfterWebSearch({ sessionId: 'session', turnId: 'turn', ownerId: 'owner', message: 'Вопрос',
      history: [], prefetch: {} as never, receipt: search.receipt }, { client, conversations });
    expect(result.turnId).toBe('resp_primary');
    expect(state.reserve).toHaveBeenCalledWith('platform_agent', 'model', 150, 'web_continuation');
    expect(submit).toHaveBeenCalledOnce();
  });

  it('rejects unsafe source URLs and changed provider models, including on recovery', async () => {
    const base: SearchCheckpoint = { version: 1, sessionId: 's', turnId: 't', query: 'q', model: 'model', reserveTokens: 1,
      reservationId: 'r', attempted: true, responseId: 'resp_x', receipt: { status: 'ok', responseId: 'resp_x', model: 'model',
        usage: null, toolFees: null, monetaryCost: null, costStatus: 'unknown', findings: '',
        sources: [{ url: 'javascript:alert(1)', title: '', excerpt: '' }] } };
    const deps = { saveCheckpoint: vi.fn(), reserve: vi.fn(), submit: vi.fn(), read: vi.fn(), recordUsage: vi.fn() };
    await expect(runControlledWebSearch({ sessionId: 's', turnId: 't', query: 'q', model: 'model', reserveTokens: 1 }, deps, base)).rejects.toThrow('Invalid controlled search response');
    base.receipt!.sources[0].url = 'https://example.test'; base.receipt!.model = 'other';
    await expect(runControlledWebSearch({ sessionId: 's', turnId: 't', query: 'q', model: 'model', reserveTokens: 1 }, deps, base)).rejects.toThrow('model mismatch');
    expect(deps.submit).not.toHaveBeenCalled();
  });

  it('keeps the token reservation when provider usage is unknown', async () => {
    state.query.mockReset().mockImplementation(async (sql: string) => sql.includes('SELECT status, model')
      ? { rowCount: 1, rows: [{ status: 'reserved', model: 'model' }] } : { rowCount: 0, rows: [] });
    const ledger = controlledWebSearchLedger({ sessionId: 'session', turnId: 'turn', ownerId: 'owner',
      conversations: { upsertTurnCheckpoint: state.checkpoints } as unknown as ConversationRepository });
    await ledger.recordUsage('reservation', { status: 'unavailable', responseId: 'resp_x', model: 'model',
      usage: null, toolFees: null, monetaryCost: null, costStatus: 'unknown', sources: [], findings: '' });
    expect(state.query.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO openai_usage_events'))).toBe(true);
    expect(state.query.mock.calls.some(([sql]) => String(sql).includes("status='reconciled'"))).toBe(false);
  });
});
