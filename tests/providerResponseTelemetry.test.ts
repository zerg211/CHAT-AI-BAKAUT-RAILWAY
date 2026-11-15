import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { diagnosticProviderResponse, projectDiagnosticEnvelope, runWithDiagnostics, type DiagnosticEvent } from '../src/observability/diagnostics.js';
import { ControlledResponsesClient } from '../src/ai/controlledResponsesClient.js';
import { ControlledWebSearchProvider } from '../src/ai/controlledWebSearchProvider.js';
import { PlatformAgentClient } from '../src/ai/platformAgentClient.js';
import { ConversationRepository } from '../src/db/repositories.js';

vi.mock('../src/config.js', () => ({ config: { BAKAUT_MCP_TOKEN: 'private_token_canary', BAKAUT_CATALOG_URL: 'https://catalog-search-production.up.railway.app' } }));
const secret = 'private_customer_answer_card_source_error_secret_canary';
const id = 'a'.repeat(24);
const prefetch = { source_revision: 'revision', completeness: 'full' as const, items: [{ product_id: id, name: 'Model A',
  attributes: { private: secret }, description: secret, documents: [], original_card: { private: secret } }] };
const usage = { input_tokens: 100, output_tokens: 20, total_tokens: 120,
  input_tokens_details: { cached_tokens: 40, cache_write_tokens: 50, private: secret }, output_tokens_details: { reasoning_tokens: 5 }, private: secret };
const identity = () => ({ sessionId: randomUUID(), turnId: randomUUID() });
const answer = () => ({ id: 'resp_observed', status: 'completed', model: 'gpt-6-luna', usage, service_tier: 'default',
  output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify({ answer: secret,
    selected: [id], rejected: [], uncertain: [], selection_snapshots: [], availability: null }) }] }] });
function harness(read = async () => Response.json(answer()), submit = async () => Response.json({ id: 'resp_observed', model: 'gpt-6-luna', status: 'queued' })) {
  const transport = vi.fn(async (url: any, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    if (path === '/v1/agents/saved') return Response.json({ model: 'gpt-6-luna', instructions: secret });
    if (path === '/v1/responses/input_tokens') return Response.json({ object: 'response.input_tokens', input_tokens: 100 });
    if (path === '/v1/responses' && init?.method === 'POST') return submit();
    if (path === '/v1/responses/resp_observed') return read();
    throw new Error('Unexpected mock transport request');
  });
  return { transport, client: new ControlledResponsesClient('private_api_canary', 'saved', transport as typeof fetch) };
}
beforeEach(() => { vi.stubGlobal('fetch', async () => { throw new Error('Network forbidden in offline telemetry tests'); }); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('existing diagnostic pipeline observes response lifecycle without content', () => {
  it('keeps actual provider time distinct from observation time and preserves null through durable projection', () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(1_800_000_010_000);
    const events: DiagnosticEvent[] = [];
    runWithDiagnostics(identity(), () => {
      diagnosticProviderResponse({ ...answer(), completed_at: 1_800_000_000 }, 'controlled');
      diagnosticProviderResponse(answer(), 'controlled');
      diagnosticProviderResponse({ ...answer(), completed_at: secret, usage: { input_tokens: secret }, error: secret }, 'controlled');
    }, e => events.push(e));
    expect(events[0]).toMatchObject({ agentTurnId: 'resp_observed', observedAtMs: 1_800_000_010_000,
      providerCompletedAtMs: 1_800_000_000_000, firstObservedTerminal: true, inputTokens: 100, cachedInputTokens: 40,
      cacheWriteInputTokens: 50, outputTokens: 20, reasoningTokens: 5, totalTokens: 120, usageKnown: true, serviceTier: 'default' });
    expect(events[1]).toMatchObject({ providerCompletedAtMs: null, firstObservedTerminal: false, totalTokens: 120, basis: 'usage_snapshot_not_delta' });
    expect(projectDiagnosticEnvelope(events[1])).toMatchObject({ providerCompletedAtMs: null, firstObservedTerminal: false });
    expect(events[2]).toMatchObject({ providerCompletedAtMs: null, usageKnown: false });
    expect(JSON.stringify(events)).not.toContain(secret);
  });

  it('records submit, correlated reads and validation; repeated reads do not submit or count another charge', async () => {
    const events: DiagnosticEvent[] = []; const h = harness();
    await runWithDiagnostics(identity(), async () => {
      const plan = await h.client.prepare({ message: secret, history: [], prefetch });
      await h.client.submit(plan, 'turn-key');
      expect((await h.client.wait(plan, 'resp_observed')).answer).toContain(secret);
      await h.client.wait(plan, 'resp_observed');
    }, e => events.push(e));
    expect(events.some(e => e.name === 'provider.submit.started')).toBe(true);
    expect(events.find(e => e.name === 'provider.submit.acknowledged')).toMatchObject({ agentTurnId: 'resp_observed', knownOutcome: 'response_observed' });
    const reads = events.filter(e => e.name === 'provider.http.started' && e.operation === 'read');
    expect(reads).toHaveLength(2); expect(reads.every(e => e.agentTurnId === 'resp_observed' && e.pollCount === 1)).toBe(true);
    const terminal = events.filter(e => e.name === 'provider.response.observed' && e.terminal);
    expect(terminal.map(e => e.firstObservedTerminal)).toEqual([true, false]);
    expect(events.filter(e => e.name === 'provider.result.validate.complete')).toHaveLength(2);
    expect(h.transport.mock.calls.filter(([url, init]) => new URL(String(url)).pathname === '/v1/responses' && init?.method === 'POST')).toHaveLength(1);
    expect(JSON.stringify(events)).not.toContain(secret);
    expect(JSON.stringify(events)).not.toContain('private_api_canary');
    expect(JSON.stringify(events)).not.toContain('private_token_canary');
  });

  it('records a failed read and a later recovery of the same ID without a new POST', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(1_800_000_000_000);
    let attempt = 0; const h = harness(async () => { if (++attempt === 1) throw new Error(secret); return Response.json(answer()); });
    const events: DiagnosticEvent[] = []; const ids = identity();
    const plan = await runWithDiagnostics(ids, () => h.client.prepare({ message: secret, history: [], prefetch }), e => events.push(e));
    await expect(runWithDiagnostics(ids, () => h.client.wait(plan, 'resp_observed'), e => events.push(e))).rejects.toThrow('unknown');
    vi.setSystemTime(1_800_000_002_000);
    await runWithDiagnostics(ids, () => h.client.wait(plan, 'resp_observed'), e => events.push(e));
    expect(events.some(e => e.name === 'provider.response.wait.failed')).toBe(true);
    expect(events.find(e => e.name === 'provider.response.observed')).toMatchObject({ observedAtMs: 1_800_000_002_000, providerCompletedAtMs: null });
    expect(h.transport.mock.calls.some(([url, init]) => new URL(String(url)).pathname === '/v1/responses' && init?.method === 'POST')).toBe(false);
    expect(JSON.stringify(events)).not.toContain(secret);
  });

  it('marks unknown POST outcomes without retrying and keeps sink failures out of business results', async () => {
    const h = harness(undefined, async () => { throw new Error(secret); }); const events: DiagnosticEvent[] = [];
    await runWithDiagnostics(identity(), async () => {
      const plan = await h.client.prepare({ message: secret, history: [], prefetch });
      await expect(h.client.submit(plan, 'turn-key')).rejects.toThrow('unknown');
    }, e => { events.push(e); throw new Error('private_sink_canary'); });
    expect(events.find(e => e.name === 'provider.submit.outcome')).toMatchObject({ knownOutcome: 'unknown' });
    expect(events.some(e => e.name === 'provider.submit.acknowledged')).toBe(false);
    expect(h.transport.mock.calls.filter(([url, init]) => new URL(String(url)).pathname === '/v1/responses' && init?.method === 'POST')).toHaveLength(1);
    const ok = harness();
    await runWithDiagnostics(identity(), async () => {
      const plan = await ok.client.prepare({ message: secret, history: [], prefetch });
      await expect(ok.client.wait(plan, 'resp_observed')).resolves.toMatchObject({ turnId: 'resp_observed' });
    }, () => { throw new Error('sink unavailable'); });
    expect(JSON.stringify(events)).not.toContain(secret);
  });

  it.each(['failed', 'cancelled', 'incomplete', 'invalid_output'])('retains usage before %s rejection', async status => {
    const raw = status === 'invalid_output' ? { ...answer(), output: [] }
      : { ...answer(), status, error: { message: secret } };
    const h = harness(async () => Response.json(raw)); const events: DiagnosticEvent[] = [];
    await runWithDiagnostics(identity(), async () => {
      const plan = await h.client.prepare({ message: secret, history: [], prefetch });
      await expect(h.client.wait(plan, 'resp_observed')).rejects.toThrow();
    }, e => events.push(e));
    expect(events.find(e => e.name === 'provider.response.observed')).toMatchObject({ usageKnown: true, totalTokens: 120, terminal: true });
    if (status === 'invalid_output') expect(events.some(e => e.name === 'provider.result.validate.failed')).toBe(true);
    expect(JSON.stringify(events)).not.toContain(secret);
  });

  it('captures discovery usage before item retrieval failure and cancellation usage through the existing platform client', async () => {
    const events: DiagnosticEvent[] = [];
    const transport = vi.fn(async (url: any, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith('/cancel')) return Response.json({ ...answer(), status: 'cancelled' });
      if (path.endsWith('/events')) return Response.json({});
      if (path.endsWith('/turns')) return Response.json({ data: [{ id: 'turn_discovery', status: 'completed', usage, error: { message: secret } }] });
      if (path.endsWith('/items')) throw new Error(secret);
      return Response.json({ id: 'session_fixture', agent: { model: 'gpt-6-luna' } });
    });
    const client = new PlatformAgentClient('private_api_canary', 'saved', [], transport as typeof fetch);
    await runWithDiagnostics(identity(), async () => {
      await client.submitMessage('session_fixture', secret, 'key');
      await expect(client.waitForTurn({ sessionId: 'session_fixture', previousTurnId: null })).rejects.toThrow();
      await client.cancelTurn('controlled:resp_observed');
    }, e => events.push(e));
    expect(events.find(e => e.name === 'provider.submit.acknowledged')).toMatchObject({ knownOutcome: 'http_acknowledged' });
    expect(events.find(e => e.name === 'provider.response.observed' && e.agentTurnId === 'turn_discovery')).toMatchObject({ totalTokens: 120 });
    expect(events.find(e => e.name === 'provider.response.observed' && e.agentTurnId === 'resp_observed')).toMatchObject({ remoteStatus: 'cancelled', totalTokens: 120 });
    expect(JSON.stringify(events)).not.toContain(secret);
  });

  it('observes web polling, unknown submissions and terminal usage without source text', async () => {
    let reads = 0; const events: DiagnosticEvent[] = [];
    const transport = vi.fn(async (_url: any, init?: RequestInit) => {
      if (init?.method === 'POST') throw new Error(secret);
      if (++reads === 1) return Response.json({ id: 'resp_web', model: 'gpt-6-luna', status: 'in_progress' });
      return Response.json({ id: 'resp_web', model: 'gpt-6-luna', status: 'completed', usage, output: [
        { type: 'web_search_call', status: 'completed' }, { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: secret,
          annotations: [{ type: 'url_citation', url: `https://example.test/${secret}`, title: secret }] }] }] });
    });
    const client = new ControlledWebSearchProvider('private_api_canary', 'gpt-6-luna', 100, transport as typeof fetch, 1000, 1);
    await runWithDiagnostics(identity(), async () => {
      await expect(client.submit(secret, 'key')).rejects.toThrow(secret);
      expect((await client.read('resp_web')).findings).toBe(secret);
      await client.read('resp_web');
    }, e => events.push(e));
    expect(events.filter(e => e.name === 'provider.http.started' && e.operation === 'read').map(e => e.pollCount)).toEqual([1, 2, 1]);
    expect(events.find(e => e.name === 'provider.submit.outcome')).toMatchObject({ knownOutcome: 'unknown' });
    expect(events.filter(e => e.name === 'provider.response.observed' && e.terminal).map(e => e.firstObservedTerminal)).toEqual([true, false]);
    expect(JSON.stringify(events)).not.toContain(secret);
  });

  it('observes checkpoint success and failure without payloads and preserves the original error', async () => {
    const failure = new Error(secret); const query = vi.fn().mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 'saved' }] }).mockRejectedValueOnce(failure);
    const repository = new ConversationRepository({ query } as never); const events: DiagnosticEvent[] = []; const ids = identity();
    await runWithDiagnostics(ids, async () => {
      const input = { ...ids, executionOwner: randomUUID(), checkpoint: 'catalog_review:resp_observed', status: 'succeeded' as const,
        payload: { query: secret, response: secret }, errorMessage: secret };
      await expect(repository.upsertTurnCheckpoint(input)).resolves.toEqual({ id: 'saved' });
      await expect(repository.upsertTurnCheckpoint({ ...input, checkpoint: secret })).rejects.toBe(failure);
    }, e => events.push(e));
    expect(query).toHaveBeenCalledTimes(2);
    expect(events.find(e => e.name === 'checkpoint.write.complete')).toMatchObject({ stage: 'catalog_review', outcome: 'ok' });
    expect(events.find(e => e.name === 'checkpoint.write.failed')).toMatchObject({ stage: 'other', outcome: 'error' });
    expect(JSON.stringify(events)).not.toContain(secret);
  });

  it('records local cancellation without sending a read or another submission', async () => {
    const h = harness(); const events: DiagnosticEvent[] = [];
    await runWithDiagnostics(identity(), async () => {
      const plan = await h.client.prepare({ message: secret, history: [], prefetch });
      const before = h.transport.mock.calls.length;
      const reason = new Error(secret);
      await expect(h.client.wait(plan, 'resp_observed', AbortSignal.abort(reason))).rejects.toBe(reason);
      expect(h.transport).toHaveBeenCalledTimes(before);
    }, e => events.push(e));
    expect(events.some(e => e.name === 'provider.response.wait.failed')).toBe(true);
    expect(JSON.stringify(events)).not.toContain(secret);
  });

  it.each(['failed', 'cancelled', 'incomplete'])('keeps web usage before %s validation failure', async status => {
    const transport = vi.fn(async () => Response.json({ ...answer(), status }));
    const client = new ControlledWebSearchProvider('private_api_canary', 'gpt-6-luna', 100, transport as typeof fetch);
    const events: DiagnosticEvent[] = [];
    await runWithDiagnostics(identity(), async () => {
      await expect(client.read('resp_observed')).rejects.toThrow('not complete');
    }, e => events.push(e));
    expect(transport).toHaveBeenCalledTimes(1);
    expect(events.find(e => e.name === 'provider.response.observed')).toMatchObject({ totalTokens: 120, terminal: true });
    expect(events.some(e => e.name === 'provider.result.validate.failed')).toBe(true);
    expect(JSON.stringify(events)).not.toContain(secret);
  });
});
