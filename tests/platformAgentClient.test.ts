import { describe, expect, it, vi } from 'vitest';
import { configureCatalogTools, extractAgentResult, PlatformAgentClient } from '../src/ai/platformAgentClient.js';
import { normalizePublicCardDisplay, normalizePublicProductCards } from '../src/shared/publicChatHistory.js';
import { ALL_CATALOG_MATCHES } from '../src/ai/catalogDecision.js';
import { readFullCatalogSnapshot } from '../src/ai/fullCatalogClient.js';
import { spawnSync } from 'node:child_process';

vi.mock('../src/config.js', () => ({ config: { BAKAUT_MCP_TOKEN: 'mock-catalog-token', BAKAUT_CATALOG_URL: 'https://catalog-search-production.up.railway.app' } }));

describe('Platform agent result', () => {
  it('resolves model names despite spacing in the original title without hiding variants', () => {
    const script = `
import sys,sqlite3,json
sys.path.insert(0,'catalog-service')
from knowledge import Knowledge
k=Knowledge.__new__(Knowledge)
k.db=sqlite3.connect(':memory:')
k.db.row_factory=sqlite3.Row
k.db.execute('CREATE TABLE products (id TEXT,sku TEXT,title TEXT,category TEXT,url TEXT,price REAL,powers TEXT,source TEXT,sha TEXT,raw TEXT)')
for ident,title in [('a','Бензорез Husqvarna K 770/12"'),('b','Бензорез Husqvarna K 770 Rescue'),('c','Бензорез Husqvarna K 970')]:
    k.db.execute('INSERT INTO products VALUES (?,?,?,?,?,?,?,?,?,?)',(ident,ident,title,'Резчики','https://example.test/'+ident,100,'[]','s','h','{}'))
result=k.get_product('Husqvarna K770')
assert result['status']=='ambiguous' and {item['product_id'] for item in result['candidates']}=={'a','b'}
assert k.get_product('K770')['status']=='ambiguous'
assert k.get_product('Husqvarna K 970')['status']=='found'
`;
    const run = spawnSync(process.platform === 'win32' ? 'python' : 'python3', ['-c', script], { encoding: 'utf8' });
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
  });
  it('returns text matches beyond 30 and 100 without claiming semantic completeness', () => {
    const script = `
import sys,sqlite3,json
sys.path.insert(0,'catalog-service')
from knowledge import Knowledge
k=Knowledge.__new__(Knowledge)
k.db=sqlite3.connect(':memory:')
k.db.row_factory=sqlite3.Row
k.revision='rev';k.snapshots={};k.log=[]
k.db.execute('CREATE TABLE products (id TEXT,sku TEXT,title TEXT,category TEXT,url TEXT,price REAL,powers TEXT,source TEXT,sha TEXT,raw TEXT)')
k.db.execute('CREATE VIRTUAL TABLE docs USING fts5(id UNINDEXED,title,body)')
for n in range(135):
    key=str(n)
    k.db.execute('INSERT INTO products VALUES (?,?,?,?,?,?,?,?,?,?)',(key,key,'pump '+key,'category','https://example.test/'+key,1,'[]','s','h','{}'))
    k.db.execute('INSERT INTO docs VALUES (?,?,?)',(key,'pump '+key,''))
r=k.search_products(query='pump')
assert len(r['items'])==135 and r['count']==135 and not r['has_more']
assert 'semantic_query_completeness' in r['unsupported_filters'] and not r['numeric_scan_complete']
assert 'price_current' not in r
assert 'price_current' not in k.get_product('0')
`;
    const run = spawnSync(process.platform === 'win32' ? 'python' : 'python3', ['-c', script], { encoding: 'utf8' });
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
  });
  it('preserves verified on-request status in public cards without overriding prices', () => {
    const cards = normalizePublicProductCards([{ id: 'a', name: 'A', priceOnRequest: true }, { id: 'b', name: 'B', price: 100, priceOnRequest: true }]);
    expect(cards[0].priceOnRequest).toBe(true);
    expect(cards[1].priceOnRequest).toBeUndefined();
  });
  it('preserves uncertain product status across chat history', () => {
    const cards = normalizePublicProductCards([{ id: 'a', name: 'A', matchStatus: 'uncertain' }]);
    expect(cards[0].matchStatus).toBe('uncertain');
  });
  it('replaces ranking with category discovery while preserving web search and credentials', () => {
    const tools = [{ type: 'web_search', context_size: 'medium' }, { type: 'mcp', server_label: 'bakaut_catalog',
      credential_id: 'vault-credential', transport: { type: 'http', server_url: 'https://catalog.example/mcp' }, allowed_tools: ['search_products', 'get_product', 'semantic_rank_products'] }];
    const updated = configureCatalogTools(tools);
    expect(updated?.[0]).toEqual(tools[0]);
    expect(updated?.[1]).toMatchObject({ credential_id: 'vault-credential', transport: tools[1].transport,
      allowed_tools: ['search_products', 'get_product', 'list_categories', 'get_products_batch', 'semantic_select_products'] });
    expect(tools[1].allowed_tools).toEqual(['search_products', 'get_product', 'semantic_rank_products']);
    expect(configureCatalogTools(updated)).toBeUndefined();
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

  it('loads all semantic matches and uncertain products by exact ID, rejecting incomplete coverage', async () => {
    const selection = { status: 'ok', selection_mode: 'semantic', source_scan_complete: true, numeric_scan_complete: true,
      source_revision: 'rev', snapshot: 'semantic-snap', candidate_count: 4,
      criteria: { requirement: 'для работы с плиткой', category: 'Виброплиты' },
      selected_count: 2, uncertain_count: 1, rejected_count: 1, status_blob: 'JQ', items: [{ product_id: 'p1' }] };
    const answer = JSON.stringify({ answer: 'Подобрал', selected: [ALL_CATALOG_MATCHES], rejected: [], uncertain: [],
      selection_snapshots: ['semantic-snap'] });
    const call = { turn_id: 't', type: 'mcp_call', name: 'semantic_select_products', status: 'completed',
      output: { content: [{ type: 'text', text: JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(selection) }] }) }] } };
    const reply = { turn_id: 't', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: answer }] };
    const result = extractAgentResult([call, reply], 't');
    expect(result.page).toEqual(selection);
    const transport = vi.fn(async () => new Response(JSON.stringify({ status: 'ok', source_revision: 'rev',
      items: [{ product_id: 'p1' }, { product_id: 'p2' }, { product_id: 'p3', match_status: 'uncertain' }] }), { status: 200 })) as unknown as typeof fetch;
    const hydrated = await readFullCatalogSnapshot(result.page!, undefined, transport);
    expect((hydrated.items as unknown[]).length).toBe(3);
    expect(transport).toHaveBeenCalledOnce();
    const [, options] = vi.mocked(transport).mock.calls[0] as [URL, RequestInit];
    expect(JSON.parse(String(options.body))).toMatchObject({ snapshot: 'semantic-snap', status_blob: 'JQ', candidate_count: 4 });
    await expect(readFullCatalogSnapshot({ ...selection, candidate_count: 5 }, undefined, transport)).rejects.toThrow('coverage');
  });

  it('combines complete semantic selections from separate categories before showing products', async () => {
    const selection = (snapshot: string, category: string) => ({ status: 'ok', selection_mode: 'semantic',
      source_scan_complete: true, numeric_scan_complete: true, source_revision: 'rev', snapshot,
      candidate_count: 2, selected_count: 1, uncertain_count: 1, rejected_count: 0, status_blob: 'CQ',
      criteria: { requirement: 'для бетона', category, min_nominal_kw: null, max_nominal_kw: null, max_price_rub: null },
      items: [{ product_id: category + '-preview' }] });
    const call = (value: unknown) => ({ turn_id: 't', type: 'mcp_call', name: 'semantic_select_products', status: 'completed',
      output: { structuredContent: value } });
    const answer = JSON.stringify({ answer: 'Есть диски', selected: [ALL_CATALOG_MATCHES], rejected: [], uncertain: [],
      selection_snapshots: ['a', 'b'] });
    const result = extractAgentResult([call(selection('a', 'Алмазные диски')), call(selection('b', 'Абразивные диски')),
      { turn_id: 't', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: answer }] }], 't');
    expect(result.page?.selection_mode).toBe('semantic_multi');
    const transport = vi.fn(async (_url: URL | RequestInfo, options?: RequestInit) => {
      const category = JSON.parse(String(options?.body)).criteria.category;
      const first = category === 'Алмазные диски';
      return new Response(JSON.stringify({ status: 'ok', source_revision: 'rev', items: first ?
        [{ product_id: 'a1', name: 'A', price_rub: 200 }, { product_id: 'a2', name: 'A?', price_rub: 300, match_status: 'uncertain' }] :
        [{ product_id: 'b1', name: 'B', price_rub: 100 }, { product_id: 'b2', name: 'B?', price_rub: 400, match_status: 'uncertain' }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const loaded = await readFullCatalogSnapshot(result.page!, undefined, transport);
    expect((loaded.items as Array<{ product_id: string }>).map((item) => item.product_id)).toEqual(['b1', 'a1', 'a2', 'b2']);
    expect(transport).toHaveBeenCalledTimes(2);
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
    expect(page.uncertain_items).toEqual([
      { ...conflict, match_status: 'uncertain' }, { ...unknown, match_status: 'uncertain' }
    ]);
  });

  it('hydrates complete numeric searches from two categories without losing candidates', async () => {
    const first = (category: string, snapshot: string) => ({ status: 'ok', group: 'matches',
      criteria: { query: '', category, min_nominal_kw: 5, max_nominal_kw: 6, max_price_rub: 100000 },
      applied_filters: { category, min_nominal_kw: 5, max_nominal_kw: 6, max_price_rub: 100000 },
      unsupported_filters: [], numeric_scan_complete: true, source_revision: 'rev', snapshot,
      count: 1, items: [{ product_id: snapshot }], has_more: false });
    const a = first('Бензиновые генераторы', 'a');
    const b = first('Инверторные генераторы', 'b');
    const answer = JSON.stringify({ answer: 'Подобрал', selected: [ALL_CATALOG_MATCHES], rejected: [], uncertain: [],
      selection_snapshots: ['a', 'b'] });
    const call = (page: unknown) => ({ turn_id: 't', type: 'mcp_call', name: 'search_products', arguments: {},
      status: 'completed', output: { structuredContent: page } });
    const result = extractAgentResult([call(a), call(b),
      { turn_id: 't', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: answer }] }], 't');
    expect(result.page?.selection_mode).toBe('numeric_multi');
    const transport = vi.fn(async (_url: URL | RequestInfo, options?: RequestInit) => {
      const category = JSON.parse(String(options?.body)).category;
      const benzine = category === 'Бензиновые генераторы';
      const page = benzine ? a : b;
      return new Response(JSON.stringify({ ...page, has_more: false,
        counts: { matches: 1, needs_check: 0, unknown: benzine ? 1 : 0 },
        groups: { matches: [{ product_id: benzine ? 'a1' : 'b1', price_rub: benzine ? 50000 : 40000 }],
          needs_check: [], unknown: benzine ? [{ product_id: 'a2', price_rub: 30000 }] : [] } }), { status: 200 });
    }) as unknown as typeof fetch;
    const loaded = await readFullCatalogSnapshot(result.page!, undefined, transport);
    expect((loaded.items as Array<{ product_id: string }>).map((item) => item.product_id)).toEqual(['b1', 'a1']);
    expect(loaded.uncertain_items).toEqual([{ product_id: 'a2', price_rub: 30000, match_status: 'uncertain' }]);
    expect(transport).toHaveBeenCalledTimes(2);
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
  it('reads every page from nested Platform MCP tool outputs', () => {
    const cursor = Buffer.from(JSON.stringify({ snapshot: 's', revision: 'r', group: 'matches', offset: 1 })).toString('base64url');
    const first = { status: 'ok', snapshot: 's', group: 'matches', source_revision: 'r', criteria: {}, count: 2,
      items: [{ product_id: 'a' }], has_more: true, next_cursor: cursor };
    const last = { ...first, items: [{ product_id: 'b' }], has_more: false, next_cursor: null };
    const call = (page: unknown, args: unknown) => ({ turn_id: 't', type: 'mcp_call', name: 'search_products',
      arguments: args, status: 'completed', output: { content: [{ type: 'text', text: JSON.stringify({
        content: [{ type: 'text', text: JSON.stringify(page) }], structuredContent: null, isError: false
      }) }] } });
    const answer = JSON.stringify({ answer: 'Подобрал', selected: ['a', 'b'], rejected: [], uncertain: [], selection_snapshots: ['s'] });
    const result = extractAgentResult([call(first, {}), call(last, { cursor }),
      { turn_id: 't', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: answer }] }], 't');
    expect(result.page?.items).toEqual([{ product_id: 'a' }, { product_id: 'b' }]);
  });
  it('rejects a truncated nested catalog page instead of treating its products as complete', () => {
    const output = { content: [{ type: 'text', text: JSON.stringify({ content: [{ type: 'text',
      text: '{"status":"ok","group":"matches","items":[{"product_id":"a"},truncated…' }],
      structuredContent: null, isError: false }) }] };
    expect(() => extractAgentResult([{ turn_id: 't', type: 'mcp_call', name: 'search_products',
      arguments: {}, status: 'completed', output }], 't')).toThrow('malformed');
  });
  it('allows a valid selected search after an exploratory category error', () => {
    const wrap = (page: unknown) => ({ content: [{ type: 'text', text: JSON.stringify({
      content: [{ type: 'text', text: JSON.stringify(page) }], structuredContent: null, isError: false
    }) }] });
    const answer = JSON.stringify({ answer: 'Подобрал', selected: ['a'], rejected: [], uncertain: [], selection_snapshots: ['s'] });
    const result = extractAgentResult([
      { turn_id: 't', type: 'mcp_call', name: 'search_products', arguments: { category: 'wrong' },
        status: 'completed', output: wrap({ status: 'category_not_found', categories: ['Виброплиты'] }) },
      { turn_id: 't', type: 'mcp_call', name: 'search_products', arguments: { category: 'Виброплиты' },
        status: 'completed', output: wrap({ status: 'ok', snapshot: 's', group: 'matches', source_revision: 'r',
          criteria: {}, count: 1, items: [{ product_id: 'a' }], has_more: false }) },
      { turn_id: 't', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: answer }] }
    ], 't');
    expect(result.page?.items).toEqual([{ product_id: 'a' }]);
  });
  it('fails instead of presenting an incomplete list as complete', () => {
    const next = Buffer.from(JSON.stringify({ snapshot: 's1', revision: 'r1', group: 'matches', offset: 1 })).toString('base64url');
    const page = { group: 'matches', count: 20, items: [{ product_id: 'p1' }], has_more: true, next_cursor: next };
    expect(() => extractAgentResult([{ turn_id: 'new', type: 'mcp_call', name: 'search_products', arguments: {}, status: 'completed', output: { structuredContent: page } }], 'new')).toThrow('incomplete');
  });

  it('uses explicitly selected searches, ignoring incomplete reference searches even with overlapping items', () => {
    const next = Buffer.from(JSON.stringify({ snapshot: 'reference', revision: 'r', group: 'matches', offset: 1 })).toString('base64url');
    const call = (page: unknown) => ({ turn_id: 't', type: 'mcp_call', name: 'search_products', arguments: {},
      status: 'completed', output: { structuredContent: page } });
    const reference = { snapshot: 'reference', group: 'matches', count: 2, source_revision: 'r',
      items: [{ product_id: 'a' }], has_more: true, next_cursor: next };
    const first = { snapshot: 'first', group: 'matches', count: 2, source_revision: 'r',
      items: [{ product_id: 'a' }, { product_id: 'b' }], has_more: false, next_cursor: null };
    const second = { snapshot: 'second', group: 'matches', count: 2, source_revision: 'r',
      items: [{ product_id: 'b' }, { product_id: 'c' }], has_more: false, next_cursor: null };
    const answer = JSON.stringify({ answer: 'Подобрал', selected: ['a', 'c'], rejected: ['b'], uncertain: [],
      selection_snapshots: ['first', 'second'] });
    const result = extractAgentResult([call(reference), call(first), call(second),
      { turn_id: 't', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: answer }] }], 't');
    expect(result.page?.items).toEqual([{ product_id: 'a' }, { product_id: 'b' }, { product_id: 'c' }]);
  });

  it('rejects an incomplete or fabricated explicitly selected search', () => {
    const next = Buffer.from(JSON.stringify({ snapshot: 's', revision: 'r', group: 'matches', offset: 1 })).toString('base64url');
    const call = { turn_id: 't', type: 'mcp_call', name: 'search_products', arguments: {}, status: 'completed',
      output: { structuredContent: { snapshot: 's', group: 'matches', count: 2, source_revision: 'r',
        items: [{ product_id: 'a' }], has_more: true, next_cursor: next } } };
    const reply = (id: string) => ({ turn_id: 't', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text',
      text: JSON.stringify({ answer: 'Подобрал', selected: ['a'], rejected: [], uncertain: [], selection_snapshots: [id] }) }] });
    expect(() => extractAgentResult([call, reply('s')], 't')).toThrow('incomplete');
    expect(() => extractAgentResult([call, reply('other')], 't')).toThrow('unavailable');
  });

  it('recovers candidates only from completed search calls in the same Platform session', async () => {
    const replies = [
      { data: [{ id: 'current', status: 'completed' }, { id: 'prior', status: 'completed' }], has_more: false },
      { data: [
        { turn_id: 'other', type: 'mcp_call', name: 'search_products', status: 'completed', output: { structuredContent: { status: 'ok', items: [{ product_id: 'forged' }] } } },
        { turn_id: 'prior', type: 'mcp_call', name: 'search_products', status: 'completed', output: { content: [{ type: 'text', text: JSON.stringify({
          content: [{ type: 'text', text: JSON.stringify({ status: 'ok', items: [{ product_id: 'old', name: 'Old' }] }) }],
          structuredContent: null, isError: false
        }) }] } }
      ], has_more: false }
    ];
    const transport = vi.fn(async (_url: RequestInfo | URL) => new Response(JSON.stringify(replies.shift()), { status: 200 }));
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
    const request = JSON.parse(String(options.body));
    expect(request).toMatchObject({ agent_id: 'saved-agent', vault_ids: ['vault-id'], agent: { instructions: expect.stringContaining('Исходные инструкции агента'), text: { format: { type: 'json_schema' } } } });
    expect(request.agent.instructions).toContain('без общих оговорок о возможной неактуальности');
    expect(request.agent.instructions).toContain('не ограничивай поиск одной категорией');
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
