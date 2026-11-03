import { describe, expect, it, vi } from 'vitest';
import { enableCatalogBatchTool, extractAgentResult, PlatformAgentClient } from '../src/ai/platformAgentClient.js';
import { normalizePublicCardDisplay, normalizePublicProductCards } from '../src/shared/publicChatHistory.js';
import { ALL_CATALOG_MATCHES } from '../src/ai/catalogDecision.js';
import { readFullCatalogSnapshot } from '../src/ai/fullCatalogClient.js';

vi.mock('../src/config.js', () => ({ config: { BAKAUT_MCP_TOKEN: 'mock-catalog-token', BAKAUT_CATALOG_URL: 'https://catalog-search-production.up.railway.app' } }));

describe('Platform agent result', () => {
  it('preserves verified on-request status in public cards without overriding prices', () => {
    const cards = normalizePublicProductCards([{ id: 'a', name: 'A', priceOnRequest: true }, { id: 'b', name: 'B', price: 100, priceOnRequest: true }]);
    expect(cards[0].priceOnRequest).toBe(true);
    expect(cards[1].priceOnRequest).toBeUndefined();
  });
  it('adds batch access only to the saved catalog MCP while preserving web search and credentials', () => {
    const tools = [{ type: 'web_search', context_size: 'medium' }, { type: 'mcp', server_label: 'bakaut_catalog',
      credential_id: 'vault-credential', transport: { type: 'http', server_url: 'https://catalog.example/mcp' }, allowed_tools: ['search_products', 'get_product'] }];
    const updated = enableCatalogBatchTool(tools);
    expect(updated?.[0]).toEqual(tools[0]);
    expect(updated?.[1]).toMatchObject({ credential_id: 'vault-credential', transport: tools[1].transport,
      allowed_tools: ['search_products', 'get_product', 'get_products_batch'] });
    expect(tools[1].allowed_tools).toEqual(['search_products', 'get_product']);
  });
  it('keeps the first catalog page when the agent delegates all matching results to the catalog', () => {
    const page = { group: 'matches', count: 2, items: [{ product_id: 'p1' }], has_more: true, next_cursor: 'opaque' };
    const answer = JSON.stringify({ answer: 'Подобрал', selected: [ALL_CATALOG_MATCHES], rejected: [], uncertain: [] });
    const result = extractAgentResult([
      { turn_id: 't', type: 'mcp_call', name: 'search_products', arguments: {}, status: 'completed', output: { structuredContent: page } },
      { turn_id: 't', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: answer }] }
    ], 't');
    expect(result.page).toEqual(page);
  });

  it('retrieves the complete numeric snapshot and refuses unsupported filters', async () => {
    const criteria = { query: '', category: 'Инверторные генераторы', min_nominal_kw: 3, max_nominal_kw: 4, max_price_rub: 70000 };
    const first = { criteria, applied_filters: { category: criteria.category, min_nominal_kw: 3, max_nominal_kw: 4, max_price_rub: 70000 },
      unsupported_filters: [], numeric_scan_complete: true, source_revision: 'rev', snapshot: 'snap', count: 2 };
    const full = { ...first, status: 'ok', has_more: false, counts: { matches: 2, needs_check: 0, unknown: 0 },
      groups: { matches: [{ product_id: 'p1' }, { product_id: 'p2' }], needs_check: [], unknown: [] } };
    const transport = vi.fn(async () => new Response(JSON.stringify(full), { status: 200 })) as unknown as typeof fetch;
    const page = await readFullCatalogSnapshot(first, undefined, transport);
    expect(page.items).toEqual(full.groups.matches);
    await expect(readFullCatalogSnapshot({ ...first, unsupported_filters: ['query'] }, undefined, transport)).rejects.toThrow('coverage');
    expect(transport).toHaveBeenCalledOnce();
  });

  it('passes only price-only review candidates for website verification', async () => {
    const criteria = { query: '', category: 'Генераторы', min_nominal_kw: 5, max_nominal_kw: 6, max_price_rub: 100000 };
    const first = { criteria, applied_filters: { category: criteria.category, min_nominal_kw: 5, max_nominal_kw: 6, max_price_rub: 100000 },
      unsupported_filters: [], numeric_scan_complete: true, source_revision: 'rev', snapshot: 'snap', count: 0 };
    const priceOnly = { product_id: 'price', price_rub: null, conditions: ['нет цены для проверки бюджета'] };
    const conflict = { product_id: 'conflict', price_rub: null, conditions: ['противоречивые номинальные значения'] };
    const unknown = { product_id: 'unknown', price_rub: null, conditions: ['номинальная электрическая мощность не определена'] };
    const body = { ...first, status: 'ok', has_more: false, counts: { matches: 0, needs_check: 2, unknown: 1 },
      groups: { matches: [], needs_check: [priceOnly, conflict], unknown: [unknown] } };
    const transport = vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;
    const page = await readFullCatalogSnapshot(first, undefined, transport);
    expect(page.pending_price_items).toEqual([priceOnly]);
  });

  it('collects all pages of the current turn and ignores earlier turns', () => {
    const cursor = Buffer.from(JSON.stringify({ snapshot: 's1', revision: 'r1', group: 'matches', offset: 1 })).toString('base64url');
    const equivalentCursor = Buffer.from(JSON.stringify({ offset: 1, group: 'matches', revision: 'r1', snapshot: 's1' }, null, 2)).toString('base64url');
    const first = { group: 'matches', count: 2, source_revision: 'r1', items: [{ product_id: 'p1' }], has_more: true, next_cursor: cursor };
    const last = { ...first, items: [{ product_id: 'p2' }], has_more: false, next_cursor: null };
    const call = (page: unknown, args: unknown) => ({ turn_id: 'new', type: 'mcp_call', name: 'search_products', arguments: args, status: 'completed', output: { content: [{ type: 'text', text: JSON.stringify(page) }] } });
    const result = extractAgentResult([
      { turn_id: 'old', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: 'old' }] },
      call(last, { cursor: equivalentCursor }), call(first, {}),
      { turn_id: 'new', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: 'Найдены товары' }] }
    ], 'new');
    expect(result.answer).toBe('Найдены товары');
    expect(result.page?.items).toEqual([{ product_id: 'p1' }, { product_id: 'p2' }]);
    expect(result.page?.has_more).toBe(false);
  });
  it('fails instead of presenting an incomplete list as complete', () => {
    const next = Buffer.from(JSON.stringify({ snapshot: 's1', revision: 'r1', group: 'matches', offset: 1 })).toString('base64url');
    const page = { group: 'matches', count: 20, items: [{ product_id: 'p1' }], has_more: true, next_cursor: next };
    expect(() => extractAgentResult([{ turn_id: 'new', type: 'mcp_call', name: 'search_products', arguments: {}, status: 'completed', output: { structuredContent: page } }], 'new')).toThrow('incomplete');
  });

  it('recovers candidates only from completed search calls in the same Platform session', async () => {
    const replies = [
      { data: [{ id: 'current', status: 'completed' }, { id: 'prior', status: 'completed' }], has_more: false },
      { data: [
        { turn_id: 'other', type: 'mcp_call', name: 'search_products', status: 'completed', output: { structuredContent: { status: 'ok', items: [{ product_id: 'forged' }] } } },
        { turn_id: 'prior', type: 'mcp_call', name: 'search_products', status: 'completed', output: { structuredContent: { status: 'ok', items: [{ product_id: 'old', name: 'Old' }] } } }
      ], has_more: false }
    ];
    const transport = vi.fn(async () => new Response(JSON.stringify(replies.shift()), { status: 200 }));
    const client = new PlatformAgentClient('key', 'agent', [], transport as typeof fetch);
    const recovered = await client.findHistoricalCandidates('session', 'current', ['old', 'forged']);
    expect(recovered).toEqual([{ product_id: 'old', name: 'Old' }]);
    expect(transport.mock.calls.every((call) => String(call[0]).includes('/sessions/session/'))).toBe(true);
  });
  it('continues the same agent session with an idempotency key', async () => {
    const replies = [
      {}, { data: [{ id: 'turn-old' }] }, {}, {},
      { data: [{ id: 'turn-new', status: 'completed', usage: { total_tokens: 12 } }] },
      { data: [{ turn_id: 'turn-new', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: 'Готово' }] }] }
    ];
    const transport = vi.fn(async () => new Response(JSON.stringify(replies.shift()), { status: 200, headers: { 'content-type': 'application/json' } }));
    const client = new PlatformAgentClient('test-key', 'agent-id', [], transport as typeof fetch);
    const result = await client.run({ sessionId: 'session-id', message: 'Дальше', idempotencyKey: 'message-id' });
    expect(result.sessionId).toBe('session-id');
    expect(result.answer).toBe('Готово');
    const [, options] = transport.mock.calls[2] as unknown as [string, RequestInit];
    expect((options.headers as Record<string, string>)['Idempotency-Key']).toBe('message-id');
    expect(JSON.parse(String(options.body)).events[0].input[0].content[0].text).toContain('Дальше');
  });

  it('creates a session using the saved agent and stores its ID before polling', async () => {
    const replies = [
      { instructions: 'Исходные инструкции агента' }, { id: 'new-session' }, {}, { data: [{ id: 'new-turn', status: 'completed' }] },
      { data: [{ turn_id: 'new-turn', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: 'Ответ' }] }] }
    ];
    const transport = vi.fn(async () => new Response(JSON.stringify(replies.shift()), { status: 200, headers: { 'content-type': 'application/json' } }));
    const onSession = vi.fn(async () => undefined);
    const client = new PlatformAgentClient('test-key', 'saved-agent', ['vault-id'], transport as typeof fetch);
    const result = await client.run({ message: 'Подберите генератор', idempotencyKey: 'local-turn', onSession });
    const [, options] = transport.mock.calls[1] as unknown as [string, RequestInit];
    expect(JSON.parse(String(options.body))).toMatchObject({ agent_id: 'saved-agent', vault_ids: ['vault-id'], agent: { instructions: expect.stringContaining('Исходные инструкции агента'), text: { format: { type: 'json_schema' } } } });
    expect(onSession).toHaveBeenCalledWith('new-session');
    expect(result.answer).toBe('Ответ');
  });

  it('leaves deadline reconciliation to the assistant before cancelling', async () => {
    const controller = new AbortController();
    const events: string[] = [];
    let submitted = false;
    const transport = vi.fn(async (url: string, options: RequestInit) => {
      if (options.method === 'POST') {
        const event = JSON.parse(String(options.body)).events[0].type as string;
        events.push(event);
        if (event === 'agent.session.input.message') submitted = true;
        return new Response('{}', { status: 200 });
      }
      if (!submitted) return new Response(JSON.stringify({ data: [{ id: 'prior' }] }), { status: 200 });
      controller.abort();
      throw new DOMException('Aborted', 'AbortError');
    });
    const client = new PlatformAgentClient('test-key', 'agent-id', [], transport as typeof fetch);
    await expect(client.run({ sessionId: 'session', message: 'Запрос', idempotencyKey: 'turn', signal: controller.signal })).rejects.toThrow();
    expect(events).toEqual(['agent.session.input.message']);
  });

  it('checks completion again after cancelling a turn that was running at the deadline', async () => {
    const client = new PlatformAgentClient('test-key', 'agent-id');
    const latest = vi.spyOn(client, 'latestTurn').mockResolvedValueOnce({ id: 'new', status: 'in_progress' }).mockResolvedValueOnce({ id: 'new', status: 'completed' });
    const cancel = vi.spyOn(client, 'cancelTurn').mockRejectedValue(new Error('already completed'));
    const wait = vi.spyOn(client, 'waitForTurn').mockResolvedValue({ answer: 'готово' } as never);
    const signal = AbortSignal.timeout(5000);
    const result = await client.settleAtDeadline({ sessionId: 's', previousTurnId: 'old', signal });
    expect(result?.answer).toBe('готово');
    expect(latest).toHaveBeenCalledTimes(2);
    expect(cancel).toHaveBeenCalledOnce();
    expect(wait).toHaveBeenCalledWith({ sessionId: 's', previousTurnId: 'old', signal });
  });

  it('keeps the next-page control when restoring chat history', () => {
    expect(normalizePublicCardDisplay({ initialVisibleCount: 10, hasMore: true })).toEqual({ initialVisibleCount: 10, hasMore: true });
  });

  it('preserves more than 50 preloaded cards in chat history', () => {
    const cards = Array.from({ length: 70 }, (_, id) => ({ id: String(id), name: `Генератор ${id}`, specs: {}, reasons: [], caveats: [] }));
    expect(normalizePublicProductCards(cards)).toHaveLength(70);
  });
});
