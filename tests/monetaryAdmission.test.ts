import { afterEach, describe, expect, it, vi } from 'vitest';
import { config } from '../src/config.js';
import { pool } from '../src/db/pool.js';
import { assertOpenAIUsageBudget, releaseOpenAIUsageReservation, runWithOpenAIUsageContext } from '../src/ai/openaiUsageGuard.js';
import { continueAfterWebSearch } from '../src/ai/controlledWebContinuation.js';
import { ControlledResponsesClient } from '../src/ai/controlledResponsesClient.js';
import { ControlledWebSearchProvider } from '../src/ai/controlledWebSearchProvider.js';
import { PlatformAgentClient } from '../src/ai/platformAgentClient.js';

const original = { enabled: config.OPENAI_MONETARY_GUARD_ENABLED, policy: config.OPENAI_MONETARY_POLICY_JSON,
  guard: config.OPENAI_USAGE_GUARD_ENABLED, tokens: config.OPENAI_DAILY_TOKEN_BUDGET, minimum: config.OPENAI_BUDGET_GUARD_RESERVE_TOKENS,
  catalogToken: config.BAKAUT_MCP_TOKEN, catalogUrl: config.BAKAUT_CATALOG_URL };
afterEach(() => {
  config.OPENAI_MONETARY_GUARD_ENABLED = original.enabled; config.OPENAI_MONETARY_POLICY_JSON = original.policy;
  config.OPENAI_USAGE_GUARD_ENABLED = original.guard; config.OPENAI_DAILY_TOKEN_BUDGET = original.tokens;
  config.OPENAI_BUDGET_GUARD_RESERVE_TOKENS = original.minimum; vi.restoreAllMocks();
  config.BAKAUT_MCP_TOKEN = original.catalogToken; config.BAKAUT_CATALOG_URL = original.catalogUrl;
});
const policy = { version: 'fixture-only', model: 'fixture-model', tier: 'fixture-tier', validUntil: 4_000_000_000_000,
  capNano: '4', inputNanoPerMillion: '1', outputNanoPerMillion: '1', otherFeesNano: '1' };
const bound = { inputTokens: 1_000_001, outputTokens: 1, tier: 'fixture-tier', tools: [] };
const inTurn = <T>(f: () => Promise<T>) => runWithOpenAIUsageContext({ sessionId: 's', turnId: 't' }, f);

describe('opt-in monetary reservation in existing guard', () => {
  it('rounds each component upward and retains unknown reservations across repeats', async () => {
    config.OPENAI_MONETARY_GUARD_ENABLED = true; config.OPENAI_MONETARY_POLICY_JSON = JSON.stringify(policy);
    config.OPENAI_USAGE_GUARD_ENABLED = true; config.OPENAI_DAILY_TOKEN_BUDGET = 100; config.OPENAI_BUDGET_GUARD_RESERVE_TOKENS = 0;
    const rows: { key: string; amount: bigint }[] = [];
    const query = vi.fn(async (sql: string, args: unknown[] = []) => {
      if (sql.includes('AS committed_nano')) return { rows: [{ committed_nano: String(rows.reduce((sum, row) => sum + row.amount, 0n)), unpriced: 0 }] };
      if (sql.includes('matching_operations')) return { rows: [{ committed_tokens: 0, matching_operations: rows.filter(row => row.key === args[2]).length }] };
      if (sql.includes('AS used_tokens')) return { rows: [{ used_tokens: 0, reserved_tokens: 0 }] };
      if (sql.includes('INSERT INTO openai_usage_reservations')) { rows.push({ key: String(args[8]), amount: BigInt(String(args[9])) }); return { rows: [{ id: 'id' }] }; }
      return { rows: [] };
    });
    vi.spyOn(pool, 'connect').mockResolvedValue({ query, release: vi.fn() } as never);
    const release = vi.spyOn(pool, 'query');
    config.OPENAI_MONETARY_POLICY_JSON = JSON.stringify({ ...policy, capNano: '3' });
    await expect(inTurn(() => assertOpenAIUsageBudget('platform_agent', 'fixture-model', 1, 'answer', bound))).rejects.toThrow('monetary turn');
    expect(rows).toHaveLength(0);
    config.OPENAI_MONETARY_POLICY_JSON = JSON.stringify(policy);
    await inTurn(() => assertOpenAIUsageBudget('platform_agent', 'fixture-model', 1, 'answer', bound));
    expect(rows[0].amount).toBe(4n);
    config.OPENAI_MONETARY_POLICY_JSON = JSON.stringify({ ...policy, capNano: '8' });
    await expect(inTurn(() => assertOpenAIUsageBudget('platform_agent', 'fixture-model', 1, 'answer', bound))).rejects.toThrow('turn reservation unavailable');
    config.OPENAI_MONETARY_POLICY_JSON = JSON.stringify(policy);
    await expect(inTurn(() => assertOpenAIUsageBudget('platform_agent', 'fixture-model', 1, 'second', bound))).rejects.toThrow('monetary turn');
    expect(query.mock.calls.find(([sql]) => sql.includes('AS committed_nano'))?.[0]).not.toContain('expires_at');
    await releaseOpenAIUsageReservation('id');
    expect(release).not.toHaveBeenCalled();
    expect(rows).toHaveLength(1);
  });

  it('refuses a turn with any older unpriced reservation', async () => {
    config.OPENAI_MONETARY_GUARD_ENABLED = true; config.OPENAI_MONETARY_POLICY_JSON = JSON.stringify(policy); config.OPENAI_USAGE_GUARD_ENABLED = true;
    const query = vi.fn(async (sql: string) => sql.includes('AS committed_nano')
      ? { rows: [{ committed_nano: '0', unpriced: 1 }] } : { rows: [] });
    vi.spyOn(pool, 'connect').mockResolvedValue({ query, release: vi.fn() } as never);
    await expect(inTurn(() => assertOpenAIUsageBudget('platform_agent', 'fixture-model', 1, 'answer', bound))).rejects.toThrow('monetary turn');
    expect(query.mock.calls.some(([sql]) => sql.includes('INSERT INTO openai_usage_reservations'))).toBe(false);
    expect(query.mock.calls.some(([sql]) => sql === 'ROLLBACK')).toBe(true);
  });

  it('rejects missing or stale pricing, tier, fees, bound, and hosted tools before connecting', async () => {
    config.OPENAI_MONETARY_GUARD_ENABLED = true; config.OPENAI_USAGE_GUARD_ENABLED = true;
    const connect = vi.spyOn(pool, 'connect');
    for (const [p, b] of [[undefined, bound], [{ ...policy, validUntil: 1 }, bound], [{ ...policy, otherFeesNano: undefined }, bound],
      [policy, { ...bound, tier: undefined }], [policy, { ...bound, tools: [{ type: 'mcp' }] }], [policy, undefined]] as const) {
      config.OPENAI_MONETARY_POLICY_JSON = p ? JSON.stringify(p) : undefined;
      await expect(inTurn(() => assertOpenAIUsageBudget('platform_agent', 'fixture-model', 1, 'answer', b))).rejects.toThrow('Monetary admission unavailable');
    }
    expect(connect).not.toHaveBeenCalled();
  });

  it('stops a real continuation caller before provider submission when the bound is unavailable', async () => {
    config.OPENAI_MONETARY_GUARD_ENABLED = true; config.OPENAI_MONETARY_POLICY_JSON = JSON.stringify(policy); config.OPENAI_USAGE_GUARD_ENABLED = true;
    const submit = vi.fn();
    const client = { prepare: vi.fn(async () => ({ model: 'fixture-model', reserveTokens: 10 })), submit, wait: vi.fn() };
    const conversations = { upsertTurnCheckpoint: vi.fn() };
    await expect(inTurn(() => continueAfterWebSearch({ sessionId: 's', turnId: 't', ownerId: 'o', message: 'x', history: [],
      prefetch: { source_revision: 'r', items: [] }, receipt: { status: 'unavailable', responseId: 'r', model: 'fixture-model',
        usage: null, toolFees: null, monetaryCost: null, costStatus: 'unknown', sources: [], findings: '' } },
      { client: client as never, conversations: conversations as never }))).rejects.toThrow('Monetary admission unavailable');
    expect(submit).not.toHaveBeenCalled();
  });

  it('stops the controlled client before even token counting when MCP costs are unbounded', async () => {
    config.OPENAI_MONETARY_GUARD_ENABLED = true;
    const transport = vi.fn();
    const client = new ControlledResponsesClient('fixture', 'fixture', transport as never);
    await expect(client.prepare({ message: 'fixture', history: [], prefetch: { source_revision: 'r', items: [] } }))
      .rejects.toThrow('cannot bound MCP and token counting');
    expect(transport).not.toHaveBeenCalled();
  });

  it('blocks a previously prepared plan before POST while preserving GET recovery and off-mode submit', async () => {
    config.OPENAI_MONETARY_GUARD_ENABLED = false;
    config.BAKAUT_MCP_TOKEN = 'fixture-token'; config.BAKAUT_CATALOG_URL = 'https://catalog-search-production.up.railway.app';
    const transport = vi.fn(async (url: string | URL | Request) => {
      const path = new URL(String(url)).pathname;
      if (path === '/v1/agents/fixture') return Response.json({ model: 'gpt-6-luna', instructions: 'fixture' });
      if (path === '/v1/responses/input_tokens') return Response.json({ object: 'response.input_tokens', input_tokens: 20 });
      if (path === '/v1/responses') return Response.json({ id: 'resp_fixture', status: 'queued', model: 'gpt-6-luna' });
      if (path === '/v1/responses/resp_fixture') return Response.json({ id: 'resp_fixture', status: 'failed', model: 'gpt-6-luna' });
      throw new Error('Unexpected transport');
    });
    const client = new ControlledResponsesClient('fixture', 'fixture', transport as typeof fetch);
    const id = 'e'.repeat(24);
    const plan = await client.prepare({ message: 'fixture', history: [], prefetch: { source_revision: 'r', items: [{
      product_id: id, source_revision: 'r', attributes: {}, description: '', documents: [], original_card: {} }] } });
    config.OPENAI_MONETARY_GUARD_ENABLED = true;
    const before = transport.mock.calls.length;
    await expect(client.submit(plan, 'turn')).rejects.toThrow('cannot bound MCP and token counting');
    expect(transport).toHaveBeenCalledTimes(before);
    await expect(client.wait(plan, 'resp_fixture')).rejects.toThrow('did not complete');
    expect(new URL(String(transport.mock.calls.at(-1)?.[0])).pathname).toBe('/v1/responses/resp_fixture');
    config.OPENAI_MONETARY_GUARD_ENABLED = false;
    expect(await client.submit(plan, 'turn')).toBe('resp_fixture');
    expect(transport.mock.calls.filter(([url]) => new URL(String(url)).pathname === '/v1/responses')).toHaveLength(1);
  });

  it('does not submit a saved pre-existing continuation when monetary mode is enabled', async () => {
    config.OPENAI_MONETARY_GUARD_ENABLED = true;
    const submit = vi.fn();
    const client = { prepare: vi.fn(), submit, wait: vi.fn() };
    const input = { sessionId: 's', turnId: 't', ownerId: 'o', message: 'x', history: [],
      prefetch: { source_revision: 'r', items: [] }, receipt: { status: 'unavailable' as const, responseId: 'r', model: 'fixture-model',
        usage: null, toolFees: null, monetaryCost: null, costStatus: 'unknown' as const, sources: [], findings: '' } };
    const saved = { sessionId: 's', turnId: 't', searchResponseId: 'r', attempted: false, responseId: null,
      reservationId: 'old-reservation', plan: {} };
    await expect(inTurn(() => continueAfterWebSearch(input, { client: client as never, conversations: {} as never }, saved as never)))
      .rejects.toThrow('requires reconciliation');
    expect(submit).not.toHaveBeenCalled();
  });

  it('blocks direct web submission but allows retrieval and off-mode submission', async () => {
    const transport = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => Response.json(init?.method === 'POST'
      ? { id: 'resp_fixture', model: 'fixture-model', status: 'queued' }
      : { id: 'resp_fixture', model: 'fixture-model', status: 'completed', output: [] }));
    const provider = new ControlledWebSearchProvider('fixture', 'fixture-model', 10, transport as typeof fetch);
    config.OPENAI_MONETARY_GUARD_ENABLED = true;
    await expect(provider.submit('test', 'key')).rejects.toThrow('direct web search');
    expect(transport).not.toHaveBeenCalled();
    expect((await provider.read('resp_fixture')).status).toBe('unavailable');
    expect(transport.mock.calls[0][1]?.method).toBe('GET');
    config.OPENAI_MONETARY_GUARD_ENABLED = false;
    expect(await provider.submit('test', 'key')).toBe('resp_fixture');
    expect(transport.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
  });

  it('blocks direct agent run and message submission while preserving GET and off-mode calls', async () => {
    const transport = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      if (path === '/v1/agents/fixture' && init?.method === 'GET') return Response.json({ instructions: 'fixture' });
      if (path === '/v1/agents/sessions' && init?.method === 'POST') return Response.json({ id: 'session' });
      if (path.endsWith('/events') && init?.method === 'POST') return Response.json({});
      if (path.endsWith('/turns') && init?.method === 'GET') return Response.json({ data: [] });
      throw new Error('Unexpected transport');
    });
    const client = new PlatformAgentClient('fixture', 'fixture', [], transport as typeof fetch);
    config.OPENAI_MONETARY_GUARD_ENABLED = true;
    await expect(client.run({ message: 'test', idempotencyKey: 'key' })).rejects.toThrow('platform agent submission');
    await expect(client.submitMessage('session', 'test', 'key')).rejects.toThrow('platform agent submission');
    expect(transport).not.toHaveBeenCalled();
    expect(await client.latestTurn('session')).toBeNull();
    config.OPENAI_MONETARY_GUARD_ENABLED = false;
    await client.submitMessage('session', 'test', 'key');
    vi.spyOn(client, 'waitForTurn').mockResolvedValue({ answer: 'fixture' } as never);
    await client.run({ message: 'test', idempotencyKey: 'key2' });
    expect(transport.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(2);
  });
});
