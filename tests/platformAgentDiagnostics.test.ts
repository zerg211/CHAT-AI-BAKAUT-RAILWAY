import { beforeEach, describe, expect, it, vi } from 'vitest';
import { diagnosticEventFailed, safeDiagnosticEvent } from '../src/client/DiagnosticTimeline.js';
import { PlatformAgentClient, PlatformAgentRequestError } from '../src/ai/platformAgentClient.js';

// Test the producer boundary independently from the journal's additional projection.
const { events } = vi.hoisted(() => ({ events: [] as Array<{ name: string; fields: Record<string, unknown> }> }));
vi.mock('../src/observability/diagnostics.js', () => ({
  diagnosticEvent: (name: string, fields: Record<string, unknown> = {}) => {
    events.push({ name, fields }); return `event_${events.length}`;
  },
  diagnosticError: (name: string, error: unknown, fields: Record<string, unknown> = {}) => {
    events.push({ name, fields: { ...fields, errorClass: error instanceof Error ? error.constructor.name : 'unknown' } });
    return `event_${events.length}`;
  },
  diagnosticAbortSource: (signal?: AbortSignal) => signal?.aborted ? 'unknown' : 'none',
  diagnosticSpan: async (name: string, operation: () => Promise<unknown>, fields: Record<string, unknown> = {}) => {
    events.push({ name: `${name}.start`, fields });
    try { const result = await operation(); events.push({ name: `${name}.finish`, fields }); return result; }
    catch (error) { events.push({ name: `${name}.error`, fields }); throw error; }
  }
}));
const canary = 'PRIVATE-CANARY-user-message-key-output';
const json = (value: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(value), { status, headers });
const client = (responses: Array<Response | Error>) => {
  const transport = vi.fn(async () => { const next = responses.shift(); if (next instanceof Error) throw next; return next!; });
  return { api: new PlatformAgentClient(canary, 'agent_demo', [], transport as typeof fetch), transport };
};
const find = (name: string) => events.filter((event) => event.name === name);
function balanced(requests: number) {
  expect(find('provider.http.start')).toHaveLength(requests);
  expect(find('provider.http.finish').length + find('provider.http.error').length).toBe(requests);
  expect(find('provider.http.response')).toHaveLength(requests);
  expect(JSON.stringify(events)).not.toContain(canary);
}
beforeEach(() => events.splice(0));

describe('safe Platform HTTP diagnostics', () => {
  it('preserves quota classification, safe headers and timings without provider messages', async () => {
    const { api } = client([json({ error: { code: 'insufficient_quota', type: 'insufficient_quota', message: canary } }, 429,
      { 'x-request-id': 'req_test123', 'retry-after': '2', 'x-ratelimit-remaining-requests': '0' })]);
    await expect(api.latestTurn('sess_test')).rejects.toMatchObject({ statusCode: 429, errorCode: 'insufficient_quota', providerRequestId: 'req_test123' });
    expect(find('provider.http.response')[0].fields).toMatchObject({ endpoint: '/agents/sessions/:sessionId/turns', method: 'GET',
      errorCode: 'insufficient_quota', retryAfterSeconds: 2, rateLimitRemainingRequests: 0,
      headersMs: expect.any(Number), bodyMs: expect.any(Number), parseMs: expect.any(Number) });
    balanced(1);
  });
  it.each([500, 502, 503])('records %s without forwarding unrecognized error codes or IDs', async (status) => {
    const { api } = client([json({ error: { code: canary, type: canary, message: canary } }, status, { 'x-request-id': canary })]);
    await expect(api.latestTurn(canary)).rejects.toMatchObject({ statusCode: status, errorCode: 'unknown', errorType: 'unknown' });
    balanced(1);
  });
  it('bounds error parsing and does not replace the HTTP error with a JSON error', async () => {
    const { api } = client([new Response(canary.repeat(2000), { status: 502 })]);
    await expect(api.latestTurn('sess_test')).rejects.toBeInstanceOf(PlatformAgentRequestError);
    expect(find('provider.http.response')[0].fields.responseBytes).toBe(16_384);
    balanced(1);
  });
  it('preserves malformed successful JSON error and records parse timing', async () => {
    const { api } = client([new Response(`{${canary}`)]);
    await expect(api.latestTurn('sess_test')).rejects.toBeInstanceOf(SyntaxError);
    expect(find('provider.http.failure')[0].fields.stage).toBe('parse');
    balanced(1);
  });
  it('preserves a failed error-envelope read as secondary to the HTTP failure', async () => {
    const stream = new ReadableStream({ start(controller) { controller.error(new Error(canary)); } });
    const { api } = client([new Response(stream, { status: 503 })]);
    await expect(api.latestTurn('sess_test')).rejects.toMatchObject({ statusCode: 503 });
    expect(find('provider.error_envelope.failure')).toHaveLength(1);
    balanced(1);
  });
  it('records transport abort without signal reason or transport message', async () => {
    const abort = new DOMException(canary, 'AbortError');
    const signal = AbortSignal.abort(canary);
    const { api } = client([abort]);
    await expect(api.latestTurn('sess_test', signal)).rejects.toBe(abort);
    expect(find('provider.http.failure')[0].fields).toMatchObject({ aborted: true, outcome: 'aborted' });
    balanced(1);
  });
  it('keeps checkpoint primary failure and cancellation failure independently visible', async () => {
    const primary = new Error(canary);
    const { api, transport } = client([json({ instructions: canary }), json({ id: 'sess_test' }), json({ error: { code: 'server_error' } }, 500)]);
    await expect(api.run({ message: canary, idempotencyKey: canary, onSession: async () => { throw primary; } })).rejects.toBe(primary);
    expect(find('provider.checkpoint.failure')).toHaveLength(1);
    expect(String(find('provider.cancel.failure')[0].fields.causalEventId).startsWith('event_')).toBe(true);
    expect(transport).toHaveBeenCalledTimes(3);
    balanced(3);
  });
  it('projects turn/item metadata and observed model only, leaving answer extraction unchanged', async () => {
    const { api } = client([json({ agent: { model: 'gpt-5.6-luna', instructions: canary } }),
      json({ data: [{ id: 'turn_test', status: 'completed', extra: canary }] }),
      json({ data: [{ id: 'msg_test', turn_id: 'turn_test', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: canary }] },
        { id: 'mcp_test', turn_id: 'turn_test', type: 'mcp_call', name: 'get_product', status: 'completed', arguments: canary, output: canary },
        { id: canary, type: canary, name: canary, status: canary }] })]);
    await expect(api.waitForTurn({ sessionId: 'sess_test', previousTurnId: null })).resolves.toMatchObject({ answer: canary, model: 'gpt-5.6-luna' });
    expect(find('provider.turn.poll')[0].fields.pollCount).toBe(1);
    expect(find('provider.turn.observed')[0].fields.remoteStatus).toBe('completed');
    expect(find('provider.item.observed')).toHaveLength(3);
    expect(find('provider.item.observed')[1].fields.tool).toBe('get_product');
    expect(find('provider.item.observed')[2].fields).toMatchObject({ itemType: 'unknown', tool: 'unknown', remoteStatus: 'unknown' });
    balanced(3);
  });
  it('preserves HTTP failure with malformed error JSON', async () => {
    const { api } = client([new Response(`{${canary}`, { status: 500 })]);
    await expect(api.latestTurn('sess_test')).rejects.toMatchObject({ statusCode: 500, errorCode: 'unknown' });
    expect(find('provider.error_envelope.failure')[0].fields.stage).toBe('parse');
    balanced(1);
  });
  it('records successive poll statuses and never logs an arbitrary model identifier', async () => {
    {
      const { api } = client([json({ agent: { model: `gpt-${canary}` } }), json({ data: [{ id: 'turn_test', status: 'in_progress' }] }),
        json({}), json({ data: [{ id: 'turn_test', status: 'completed' }] }),
        json({ data: [{ id: 'msg_test', turn_id: 'turn_test', role: 'assistant', content: [{ type: 'output_text', text: canary }] }] })]);
      const result = api.waitForTurn({ sessionId: 'sess_test', previousTurnId: null });
      await expect(result).resolves.toMatchObject({ answer: canary });
      expect(find('provider.turn.observed').map(e => e.fields.remoteStatus)).toEqual(['in_progress', 'completed']);
      expect(find('provider.turn.poll').map(e => e.fields.pollCount)).toEqual([1, 2]);
      expect(find('provider.model.observed')).toHaveLength(0);
      balanced(5);
    }
  });

  it('bounds stalled error-body inspection to one second and preserves the original status', async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream({ cancel });
    const { api, transport } = client([new Response(stream, { status: 429, headers: { 'x-request-id': 'req_stalled' } })]);
    const started = performance.now();
    await expect(api.latestTurn('sess_test')).rejects.toMatchObject({ statusCode: 429, errorCode: 'unknown', providerRequestId: 'req_stalled' });
    expect(performance.now() - started).toBeLessThan(2500);
    expect(find('provider.error_envelope.unavailable')[0].fields.outcome).toBe('timeout');
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(transport).toHaveBeenCalledTimes(1);
    balanced(1);
  });

  it('does not apply the diagnostic timeout to a successful slow response body', async () => {
    const stream = new ReadableStream({ start(controller) {
      setTimeout(() => { controller.enqueue(new TextEncoder().encode(JSON.stringify({ data: [{ id: 'turn_test', status: 'completed' }] }))); controller.close(); }, 1100);
    } });
    const { api, transport } = client([new Response(stream)]);
    await expect(api.latestTurn('sess_test')).resolves.toEqual({ id: 'turn_test', status: 'completed' });
    expect(find('provider.error_envelope.unavailable')).toHaveLength(0);
    expect(transport).toHaveBeenCalledTimes(1);
    balanced(1);
  });

});


describe('provider observation error evidence', () => {
  const cases = [
    { label: 'absent error', status: 'completed', reported: undefined, expected: undefined },
    { label: 'null error', status: 'completed', reported: null, expected: undefined },
    { label: 'failed state without an error envelope', status: 'failed', reported: undefined, expected: undefined },
    { label: 'known reported error', status: 'failed', reported: { code: 'server_error', type: 'api_error', message: canary }, expected: { errorCode: 'server_error', errorType: 'api_error' } },
    { label: 'unknown reported error', status: 'failed', reported: { code: canary, type: canary, message: canary }, expected: { errorCode: 'unknown', errorType: 'unknown' } },
    { label: 'unstructured reported error', status: 'failed', reported: canary, expected: { errorCode: 'unknown', errorType: 'unknown' } }
  ];
  for (const route of ['list', 'single', 'items'] as const) {
    it.each(cases)(`${route}: preserves $label without manufacturing missing errors`, async ({ status, reported, expected }) => {
      const observed = { id: route === 'items' ? 'mcp_test' : 'turn_test', status,
        ...(reported === undefined ? {} : { error: reported }),
        type: 'mcp_call', name: 'get_product', turn_id: 'turn_test', arguments: canary, output: canary };
      const responses = route === 'items' ? [json({}), json({ data: [{ id: 'turn_test', status: 'completed' }] }),
        json({ data: [{ id: 'msg_test', turn_id: 'turn_test', role: 'assistant', content: [{ type: 'output_text', text: canary }] }, observed] })]
        : [json(route === 'list' ? { data: [observed] } : observed)];
      const { api, transport } = client(responses);
      if (route === 'items') await expect(api.waitForTurn({ sessionId: 'sess_test', previousTurnId: null })).resolves.toMatchObject({ answer: canary });
      else if (route === 'single') await expect(api.readTurn('sess_test', 'turn_test')).resolves.toMatchObject({ id: 'turn_test', status });
      else await expect(api.latestTurn('sess_test')).resolves.toEqual({ id: 'turn_test', status });
      const observation = find(route === 'items' ? 'provider.item.observed' : route === 'single' ? 'provider.http.response' : 'provider.turn.observed').at(-1);
      expect(observation).toBeDefined();
      if (route === 'single') expect(find('provider.turn.observed')).toHaveLength(0);
      else expect(observation!.fields.remoteStatus).toBe(status);
      if (expected && route !== 'single') expect(observation!.fields).toMatchObject(expected);
      else {
        expect(observation!.fields).not.toHaveProperty('errorCode');
        expect(observation!.fields).not.toHaveProperty('errorType');
      }
      const { projectDiagnosticFields } = await vi.importActual<typeof import('../src/observability/diagnostics.js')>('../src/observability/diagnostics.js');
      const projected = safeDiagnosticEvent(projectDiagnosticFields(observation!.fields));
      expect(diagnosticEventFailed(projected)).toBe(route !== 'single' && status === 'failed');
      if (!expected || route === 'single') {
        expect(projected).not.toHaveProperty('errorCode');
        expect(projected).not.toHaveProperty('errorType');
      }
      expect(transport).toHaveBeenCalledTimes(route === 'items' ? 3 : 1);
      balanced(route === 'items' ? 3 : 1);
    });
  }
});
