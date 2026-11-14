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

describe('controlled search adapters, offline', () => {
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
