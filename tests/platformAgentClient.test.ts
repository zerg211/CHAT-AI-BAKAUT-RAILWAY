import { describe, expect, it, vi } from 'vitest';
import { configureCatalogTools, extractAgentResult, PlatformAgentClient, PlatformAgentInputTooLargeError, PlatformAgentSessionFailedError } from '../src/ai/platformAgentClient.js';
import { normalizePublicCardDisplay, normalizePublicProductCards } from '../src/shared/publicChatHistory.js';
import { ALL_CATALOG_MATCHES, selectsAllCatalogMatches } from '../src/ai/catalogDecision.js';
import { readExactMentionPrefetch, readFullCatalogSnapshot, readFullKnownProducts, reselectFromBuyerMessage } from '../src/ai/fullCatalogClient.js';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { collectKnownProducts, modelProductContext, knownProductContext, knownProductHistory, knownProductHistoryNotice } from '../src/ai/platformProductContext.js';
import { ControlledResponsesClient, ControlledResponseFailure } from '../src/ai/controlledResponsesClient.js';
import type { Message } from '../src/shared/types.js';

vi.mock('../src/config.js', () => ({ config: { BAKAUT_MCP_TOKEN: 'mock-catalog-token', BAKAUT_CATALOG_URL: 'https://catalog-search-production.up.railway.app' } }));

describe('Platform agent result', () => {
  it.each(['get_product', 'get_products_batch'])('retains comparison-only subjects read by %s without prefetch', name => {
    const ids = ['000000000000000000000001', '000000000000000000000002'];
    const items = ids.map(product_id => ({ product_id, requested_product_id: product_id, name: product_id, status: 'found',
      source_revision: 'rev', completeness: 'full', attributes: {}, description: '', documents: [], original_card: {} }));
    const calls = (name === 'get_product' ? items : [{ status: 'ok', mode: 'full', source_revision: 'rev', results: items,
      requested_ids: ids, requested_count: 2, returned_ids: ids, returned_count: 2, offset: 0, has_more: false, complete: true, next_cursor: null }])
      .map(output => ({ turn_id: 't', type: 'mcp_call', server_label: 'bakaut_catalog', name, status: 'completed', output: { structuredContent: output } }));
    const reply = (comparison_ids: string[]) => ({ turn_id: 't', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text',
      text: JSON.stringify({ answer: 'Сравнение.', selected: [], rejected: [], uncertain: [], comparison_ids,
        recommendation_status: 'not_applicable', selection_snapshots: [] }) }] });
    expect(extractAgentResult([...calls, reply(ids)], 't').page?.items).toEqual(items);
    expect(extractAgentResult([...calls, reply([...ids, 'unknown'])], 't').page).toBeUndefined();
  });
  it('retains comparison-only full-prefetch subjects without marking them as selected', () => {
    const ids = ['000000000000000000000001', '000000000000000000000002'];
    const prefetch = { source_revision: 'rev', completeness: 'full' as const,
      items: ids.map(product_id => ({ product_id, name: product_id, attributes: {}, description: '', documents: [], original_card: {} })) };
    const answer = JSON.stringify({ answer: 'Сравнение.', selected: [], rejected: [], uncertain: [],
      comparison_ids: ids, recommendation_status: 'not_applicable', selection_snapshots: [] });
    const result = extractAgentResult([{ turn_id: 't', role: 'assistant', phase: 'final_answer',
      content: [{ type: 'output_text', text: answer }] }], 't', prefetch);
    expect(result.page).toMatchObject({ selection_mode: 'exact_prefetch', source_revision: 'rev', items: prefetch.items });
    expect(JSON.parse(result.answer).selected).toEqual([]);
  });
  it('preserves more identities than the former fixed catalog size', () => {
    const product_ids = Array.from({ length: 4325 }, (_, index) => index.toString(16).padStart(24, '0'));
    expect(knownProductContext({ source_revision: 'rev', product_ids })?.product_ids).toEqual(product_ids);
    const cards = product_ids.map(id => ({ id, name: id, specs: {}, reasons: [], caveats: [] }));
    expect(normalizePublicProductCards(cards)).toHaveLength(4325);
  });
  it('keeps all twelve large exact cards including descriptions, documents and original links', async () => {
    const items = Array.from({ length: 12 }, (_, index) => ({ status: 'found', source_revision: 'rev',
      product_id: String(index).padStart(24, '0'), name: `DPU variant ${index}`, matched_aliases: ['dpu6555'],
      attributes: { 'Рабочая ширина': `${710 + index} мм` }, description: 'Полное исходное описание. '.repeat(1000),
      documents: [{ название: 'Руководство', ссылка: `https://example.test/manual-${index}.pdf` }],
      original_card: { фотографии_товара: [{ ссылка: `https://example.test/photo-${index}.jpg` }],
        особенности: `Уникальная особенность исполнения ${index}` } }));
    expect(Buffer.byteLength(JSON.stringify(items), 'utf8')).toBeGreaterThan(128_000);
    const transport = vi.fn(async () => new Response(JSON.stringify({ status: 'ok',
      match_basis: 'exact_model_or_sku_mention', source_revision: 'rev', count: items.length, items }))) as unknown as typeof fetch;
    const evidence = await readExactMentionPrefetch('DPU 6555', undefined, transport);
    expect(evidence?.items).toEqual(items);
    expect(evidence?.completeness).toBe('full');
  });
  it('preserves identity-only prefetch as a full-read requirement instead of claiming full cards', async () => {
    const items = ['a', 'b'].map(product_id => ({ status: 'found', source_revision: 'rev', product_id,
      name: product_id, matched_aliases: ['dpu6555'] }));
    const transport = vi.fn(async () => new Response(JSON.stringify({ status: 'ok',
      match_basis: 'exact_model_or_sku_mention', source_revision: 'rev', count: items.length, items }))) as unknown as typeof fetch;
    const evidence = await readExactMentionPrefetch('DPU 6555', undefined, transport);
    expect(evidence).toEqual({ source_revision: 'rev', items, completeness: 'full_read_required' });
    expect(transport).toHaveBeenCalledOnce();
  });
  it('hydrates more than one hundred known products in order without dropping any original data', async () => {
    const product_ids = Array.from({ length: 112 }, (_, index) => String(index).padStart(24, '0'));
    const transport = vi.fn(async (_url: URL, options: RequestInit) => {
      const body = JSON.parse(String(options.body));
      expect(body.identifiers).toEqual(product_ids);
      expect(body).toMatchObject({ expected_revision: 'rev', mode: 'full' });
      const offset = body.cursor ? 100 : 0;
      const returned_ids = product_ids.slice(offset, offset + 100);
      const has_more = offset + returned_ids.length < product_ids.length;
      return new Response(JSON.stringify({ status: 'ok', mode: 'full', source_revision: 'rev',
        requested_ids: product_ids, requested_count: product_ids.length, returned_ids,
        returned_count: returned_ids.length, offset, has_more, complete: !has_more,
        next_cursor: has_more ? 'page-100' : null,
        results: returned_ids.map(product_id => ({ requested_product_id: product_id, product_id,
          status: 'found', completeness: 'full', source_revision: 'rev', name: product_id,
          attributes: { 'Ширина': '710 мм' }, description: `Description ${product_id}`,
          documents: [{ ссылка: 'https://example.test/manual.pdf' }],
          original_card: { дополнительная_информация: product_id, фотографии_товара: ['photo.jpg'] } })) }));
    }) as unknown as typeof fetch;
    const context = await readFullKnownProducts({ source_revision: 'rev', product_ids }, undefined, transport);
    expect(context.items.map(item => item.product_id)).toEqual(product_ids);
    expect(context.items[111].original_card).toEqual({ дополнительная_информация: product_ids[111], фотографии_товара: ['photo.jpg'] });
    expect(transport).toHaveBeenCalledTimes(2);
  });
  it('rejects changed revisions, missing fields and incomplete known-product pages', async () => {
    const id = '000000000000000000000001';
    const valid = { status: 'ok', mode: 'full', source_revision: 'rev', requested_ids: [id], requested_count: 1,
      returned_ids: [id], returned_count: 1, offset: 0, has_more: false, complete: true, next_cursor: null,
      results: [{ requested_product_id: id, product_id: id, status: 'found', completeness: 'full',
        source_revision: 'rev', name: 'DPU', attributes: {}, description: 'all text', documents: [], original_card: {} }] };
    for (const broken of [{ ...valid, source_revision: 'new' }, { ...valid, returned_ids: ['other'] },
      { ...valid, complete: false }, { ...valid, results: [{ ...valid.results[0], description: undefined }] },
      { ...valid, results: [{ requested_product_id: id, status: 'not_found' }] }]) {
      const transport = vi.fn(async () => new Response(JSON.stringify(broken))) as unknown as typeof fetch;
      await expect(readFullKnownProducts({ source_revision: 'rev', product_ids: [id] }, undefined, transport))
        .rejects.toThrow('Known product hydration is incomplete or inconsistent');
    }
  });
  it('separates unknown projection fields from missing values and provides lossless full continuation', () => {
    const script = `
import sys,sqlite3,json
sys.path.insert(0,'catalog-service')
from knowledge import Knowledge
from get_products_batch import get_products_batch
k=Knowledge.__new__(Knowledge)
k.db=sqlite3.connect(':memory:');k.db.row_factory=sqlite3.Row;k.revision='rev'
k.db.execute('CREATE TABLE products (id TEXT,sku TEXT,title TEXT,category TEXT,url TEXT,price REAL,powers TEXT,source TEXT,sha TEXT,raw TEXT)')
ids=[str(i).zfill(24) for i in range(112)]
for ident in ids:
    card={'название':'DPU '+ident,'характеристики':{'Рабочая ширина':'710 мм','Поле без значения':None},'описание':'Full text '+ident,'документы':[{'ссылка':'https://example.test/manual.pdf'}],'фотографии_товара':[{'ссылка':'https://example.test/photo.jpg'}],'особенности':'Unique '+ident}
    k.db.execute('INSERT INTO products VALUES (?,?,?,?,?,?,?,?,?,?)',(ident,ident,'DPU '+ident,'category','https://example.test/'+ident,100,'[]','s','sha',json.dumps(card)))
projection=get_products_batch(k,[ids[0]],['working_width','Рабочая ширина','Поле без значения'],'rev')['results'][0]
assert projection['field_status']=={'working_width':'unknown_field','Рабочая ширина':'found','Поле без значения':'missing_value'}
assert projection['fields']['working_width'] is None
assert projection['full_product']['attributes']['Рабочая ширина']=='710 мм'
assert projection['full_product']['description']=='Full text '+ids[0]
assert projection['full_product']['original_card']['фотографии_товара'][0]['ссылка'].endswith('photo.jpg')
first=get_products_batch(k,ids,expected_revision='rev',mode='full')
assert first['requested_ids']==ids and first['returned_ids']==ids[:100] and first['has_more'] and not first['complete']
second=get_products_batch(k,ids,expected_revision='rev',mode='full',cursor=first['next_cursor'])
assert second['returned_ids']==ids[100:] and second['complete'] and second['next_cursor'] is None
assert second['results'][-1]['original_card']['особенности']=='Unique '+ids[-1]
for revision,requested in [('changed',ids),('rev',list(reversed(ids)))]:
    try:
        get_products_batch(k,requested,expected_revision=revision,mode='full',cursor=first['next_cursor'])
        raise AssertionError('inconsistent cursor accepted')
    except ValueError:pass
k.revision='new'
try:
    get_products_batch(k,ids,mode='full',cursor=first['next_cursor'])
    raise AssertionError('stale cursor accepted')
except ValueError:pass
k.db.close()
`;
    const run = spawnSync(process.platform === 'win32' ? 'python' : 'python3', ['-B', '-c', script], { encoding: 'utf8' });
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
  });
  it('never completes a full Python batch containing a missing product on any page', () => {
    const script = `
import sys
sys.path.insert(0,'catalog-service')
from get_products_batch import get_products_batch
class Catalog:
    revision='rev'
    def get_product(self,identifier,fields):
        if identifier=='f'*24:return {'status':'not_found','source_revision':'rev'}
        return {'status':'found','product_id':identifier,'source_revision':'rev'}
k=Catalog()
assert get_products_batch(k,['f'*24],['description'],'rev')['results'][0]['status']=='not_found'
for ids,cursor in [(['f'*24],None),([str(i).zfill(24) for i in range(100)]+['f'*24],'continuation')]:
    if cursor:cursor=get_products_batch(k,ids,mode='full',expected_revision='rev')['next_cursor']
    try:
        get_products_batch(k,ids,mode='full',expected_revision='rev',cursor=cursor)
        raise AssertionError('missing card reported as a complete full batch')
    except ValueError as error:assert 'not found' in str(error)
`;
    const run = spawnSync(process.platform === 'win32' ? 'python' : 'python3', ['-B', '-c', script], { encoding: 'utf8' });
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
  });
  it('rechecks a zero-result semantic search against the buyer message without carrying agent-added conditions', async () => {
    const first = { selection_mode: 'semantic', selected_count: 0, uncertain_count: 3, candidate_count: 39,
      source_revision: 'rev', criteria: { requirement: 'agent-added condition', category: 'Алмазные диски',
        min_nominal_kw: null, max_nominal_kw: null, max_price_rub: null } };
    const checked = { status: 'ok', selection_mode: 'semantic', source_scan_complete: true, source_revision: 'rev',
      criteria: { requirement: 'Какие диски подойдут для K760?', category: 'Алмазные диски',
        min_nominal_kw: null, max_nominal_kw: null, max_price_rub: null }, candidate_count: 39,
      selected_count: 3, uncertain_count: 19, rejected_count: 17 };
    const transport = vi.fn(async (_url: URL, options: RequestInit) => {
      expect(JSON.parse(String(options.body))).toMatchObject({ requirement: checked.criteria.requirement,
        category: checked.criteria.category, expected_revision: 'rev' });
      return new Response(JSON.stringify(checked));
    }) as unknown as typeof fetch;
    expect(await reselectFromBuyerMessage(first, checked.criteria.requirement, undefined, transport)).toEqual(checked);
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it('resolves model names despite spacing in the original title without hiding variants', () => {
    const script = `
import sys,sqlite3,json
sys.path.insert(0,'catalog-service')
from knowledge import Knowledge
k=Knowledge.__new__(Knowledge)
k.db=sqlite3.connect(':memory:')
k.db.row_factory=sqlite3.Row
k.revision='rev'
k.db.execute('CREATE TABLE products (id TEXT,sku TEXT,title TEXT,category TEXT,url TEXT,price REAL,powers TEXT,source TEXT,sha TEXT,raw TEXT)')
for ident,title in [('a','Бензорез Husqvarna K 770/12"'),('b','Бензорез Husqvarna K 770 Rescue'),('c','Бензорез Husqvarna K 970'),('d','Бензорез Husqvarna K 7700'),('e','Generator TEST G7000')]:
    k.db.execute('INSERT INTO products VALUES (?,?,?,?,?,?,?,?,?,?)',(ident,ident,title,'Резчики','https://example.test/'+ident,100,'[]','s','h','{}'))
result=k.get_product('Husqvarna K770')
assert result['status']=='ambiguous' and {item['product_id'] for item in result['candidates']}=={'a','b'}
assert k.get_product('K770')['status']=='ambiguous'
assert k.get_product('Husqvarna K 970')['status']=='found'
assert k.get_product('G700')['status']=='not_found'
mentioned=k.mentioned_products('Сравните Husqvarna K770 с K970')
assert mentioned['count']==3 and {item['product_id'] for item in mentioned['items']}=={'a','b','c'}
assert all(item['source_revision']=='rev' and item['status']=='found' for item in mentioned['items'])
`;
    const run = spawnSync(process.platform === 'win32' ? 'python' : 'python3', ['-c', script], { encoding: 'utf8' });
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
  });
  it('accepts all variants returned by an exact catalog product lookup', () => {
    const candidates = ['a', 'b', 'c'].map((product_id) => ({ product_id, name: product_id, price_rub: 100 }));
    const answer = JSON.stringify({ answer: 'Есть три варианта', selected: ['a', 'b', 'c'], rejected: [], uncertain: [], selection_snapshots: [] });
    const result = extractAgentResult([
      { turn_id: 't', type: 'mcp_call', name: 'get_product', status: 'completed',
        output: { structuredContent: { status: 'ambiguous', source_revision: 'rev', candidates } } },
      { turn_id: 't', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: answer }] }
    ], 't');
    expect(result.page?.items).toEqual(candidates);
    expect(result.page?.source_revision).toBe('rev');
  });
  it('uses every exact prefetched identity and ignores unrelated reference reads', () => {
    const candidates = ['a', 'b'].map((product_id) => ({ product_id, name: product_id, status: 'found', source_revision: 'rev' }));
    const prefetch = { source_revision: 'rev', items: candidates };
    const answer = JSON.stringify({ answer: 'Два варианта', selected: ['a'], rejected: [], uncertain: ['b'], selection_snapshots: [] });
    const result = extractAgentResult([
      { turn_id: 't', type: 'mcp_call', name: 'get_product', status: 'completed',
        output: { structuredContent: { status: 'found', source_revision: 'rev', product_id: 'reference', name: 'Reference' } } },
      { turn_id: 't', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: answer }] }
    ], 't', prefetch);
    expect(result.page?.selection_mode).toBe('exact_prefetch');
    expect((result.page?.items as Array<{ product_id: string }>).map((item) => item.product_id)).toEqual(['a', 'b']);
    const missing = extractAgentResult([{ turn_id: 't', role: 'assistant', phase: 'final_answer',
      content: [{ type: 'output_text', text: JSON.stringify({ answer: 'Один', selected: ['a'], rejected: [], uncertain: [], selection_snapshots: [] }) }] }], 't', prefetch);
    expect(missing.page?.items).toEqual([candidates[0]]);
    const unrelated = extractAgentResult([
      { turn_id: 't', type: 'mcp_call', name: 'get_product', status: 'completed',
        output: { structuredContent: { status: 'found', source_revision: 'rev', product_id: 'reference', name: 'Reference' } } },
      { turn_id: 't', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text',
        text: JSON.stringify({ answer: 'Reference', selected: ['reference'], rejected: [], uncertain: [], selection_snapshots: [] }) }] }
    ], 't', prefetch);
    expect(unrelated.page?.items).toEqual([{ status: 'found', source_revision: 'rev', product_id: 'reference', name: 'Reference' }]);
  });
  it('validates exact prefetch revisions and keeps all returned identities', async () => {
    const items = ['a', 'b'].map((product_id) => ({ status: 'found', source_revision: 'rev', product_id,
      name: product_id, matched_aliases: ['k770'] }));
    const transport = vi.fn(async () => new Response(JSON.stringify({ status: 'ok', match_basis: 'exact_model_or_sku_mention',
      source_revision: 'rev', count: 2, items }), { status: 200 })) as unknown as typeof fetch;
    const prefetch = await readExactMentionPrefetch('Покажи K770', undefined, transport);
    expect(prefetch?.items.map((item) => item.product_id)).toEqual(['a', 'b']);
    expect(transport).toHaveBeenCalledOnce();
  });
  it('puts exact source fields in the first Platform Agent input without another catalog call', async () => {
    const prefetch = { source_revision: 'rev', items: ['a', 'b'].map((product_id, index) => ({
      status: 'found', source_revision: 'rev', product_id, name: `K 770 ${index}`, sku: product_id,
      source_file: `${product_id}.json`, source_sha256: 'sha', matched_aliases: ['k770'],
      attributes: { 'Масса без режущего оборудования': index ? '10,1 кг' : '10,0 кг' }
    })) };
    let submitted = '';
    const transport = vi.fn(async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname;
      if (path === '/v1/agents/agent') return new Response(JSON.stringify({ instructions: 'Saved instructions', tools: [] }));
      if (path === '/v1/agents/sessions' && init?.method === 'POST') {
        submitted = JSON.stringify(JSON.parse(String(init.body)).input);
        return new Response(JSON.stringify({ id: 'sess' }));
      }
      if (path === '/v1/agents/sessions/sess') return new Response(JSON.stringify({ agent: { model: 'gpt-6-luna' } }));
      if (path.endsWith('/turns')) return new Response(JSON.stringify({ data: [{ id: 'turn', status: 'completed' }] }));
      if (path.endsWith('/items')) return new Response(JSON.stringify({ data: [{ turn_id: 'turn', role: 'assistant', phase: 'final_answer',
        content: [{ type: 'output_text', text: JSON.stringify({ answer: 'Два варианта', selected: ['a', 'b'], rejected: [], uncertain: [], selection_snapshots: [] }) }] }] }));
      throw new Error(`Unexpected request ${path}`);
    }) as unknown as typeof fetch;
    const result = await new PlatformAgentClient('key', 'agent', [], transport).run({
      message: 'Сравните K770 по массе', idempotencyKey: 'turn', prefetch
    });
    expect(submitted).toContain('Масса без режущего оборудования');
    expect(submitted).toContain('10,0 кг');
    expect(submitted).toContain('10,1 кг');
    expect((result.page?.items as Array<{ product_id: string }>).map((item) => item.product_id)).toEqual(['a', 'b']);
    expect(transport).toHaveBeenCalledTimes(5);
  });
  it.each([12, 112])('submits every complete card of a %i product set above 256 KB to the actual agent transport', async count => {
    const prefetch = { source_revision: 'rev', items: Array.from({ length: count }, (_, i) => ({
      status: 'found', product_id: String(i).padStart(24, '0'), source_revision: 'rev', name: `Variant ${i}`,
      attributes: { 'Рабочая ширина': `${710 + i} мм` }, description: `Description ${i}. ` + 'Полный текст. '.repeat(1200),
      documents: [{ ссылка: `https://example.test/manual-${i}.pdf` }],
      original_card: { особенности: `Unique ${i}`, неизвестное_поле: { значение: i } }
    })) };
    expect(Buffer.byteLength(JSON.stringify(prefetch))).toBeGreaterThan(256_000);
    let submitted = '';
    const transport = vi.fn(async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname;
      if (path === '/v1/agents/agent') return new Response(JSON.stringify({ instructions: 'Saved instructions', tools: [] }));
      if (path === '/v1/agents/sessions' && init?.method === 'POST') {
        const body = JSON.parse(String(init.body));
        submitted = typeof body.input === 'string' ? body.input : body.input.flatMap((message: { content: { text: string }[] }) => message.content).map((part: { text: string }) => part.text).join('');
        if (count > 100) {
          expect(Array.isArray(body.input)).toBe(true);
          expect(body.input[0].content.every((part: { text: string }) => part.text.length <= 1_048_576)).toBe(true);
        }
        expect(body.agent.text.format.schema.required).toContain('availability');
        return new Response(JSON.stringify({ id: 'sess' }));
      }
      if (path === '/v1/agents/sessions/sess') return new Response(JSON.stringify({ agent: { model: 'test-model' } }));
      if (path.endsWith('/turns')) return new Response(JSON.stringify({ data: [{ id: 'turn', status: 'completed' }] }));
      if (path.endsWith('/items')) return new Response(JSON.stringify({ data: [{ turn_id: 'turn', role: 'assistant', phase: 'final_answer',
        content: [{ type: 'output_text', text: JSON.stringify({ answer: 'Сравнение всех вариантов', selected: [],
          rejected: [], uncertain: [], selection_snapshots: [], availability: null }) }] }] }));
      throw new Error(`Unexpected request ${path}`);
    }) as unknown as typeof fetch;
    await new PlatformAgentClient('key', 'agent', [], transport).run({ message: 'Чем отличаются между собой?', idempotencyKey: 'turn', prefetch });
    expect(submitted).toContain(JSON.stringify(modelProductContext(prefetch)));
    expect(modelProductContext(prefetch)).toMatchObject({ completeness: 'full',
      product_ids: prefetch.items.map(item => item.product_id), products: prefetch.items });
    expect(transport).toHaveBeenCalledTimes(5);
  });
  it('hydrates an identity-only context before any agent submission and refuses incomplete data', async () => {
    const id = '000000000000000000000001';
    const product = { requested_product_id: id, status: 'found', completeness: 'full', source_revision: 'rev',
      product_id: id, name: 'DPU', attributes: { 'Ширина': '710 мм' }, description: 'Complete source', documents: [], original_card: { особенности: 'All fields' } };
    const prefetch = { source_revision: 'rev', completeness: 'full_read_required' as const, items: [{ product_id: id }] };
    expect(() => modelProductContext(prefetch)).toThrow('not been fully read');
    let phase = 0;
    const transport = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const path = new URL(url).pathname;
      if (path === '/products-full') {
        expect(phase).toBe(0); phase = 1;
        return new Response(JSON.stringify({ status: 'ok', mode: 'full', source_revision: 'rev', requested_ids: [id],
          requested_count: 1, returned_ids: [id], returned_count: 1, offset: 0, complete: true, has_more: false, next_cursor: null, results: [product] }));
      }
      expect(phase).toBe(1);
      if (path === '/v1/agents/agent') return new Response(JSON.stringify({ instructions: 'Saved', tools: [] }));
      if (path === '/v1/agents/sessions' && init?.method === 'POST') {
        expect(JSON.parse(String(init.body)).input).toContain(JSON.stringify(product));
        return new Response(JSON.stringify({ id: 'sess' }));
      }
      if (path === '/v1/agents/sessions/sess') return new Response(JSON.stringify({ agent: { model: 'test-model' } }));
      if (path.endsWith('/turns')) return new Response(JSON.stringify({ data: [{ id: 'turn', status: 'completed' }] }));
      if (path.endsWith('/items')) return new Response(JSON.stringify({ data: [{ turn_id: 'turn', role: 'assistant', phase: 'final_answer',
        content: [{ type: 'output_text', text: JSON.stringify({ answer: 'Подробности', selected: [], rejected: [], uncertain: [], availability: null }) }] }] }));
      throw new Error(`Unexpected ${path}`);
    }) as unknown as typeof fetch;
    const onBeforeSubmit = vi.fn(async () => undefined);
    const result = await new PlatformAgentClient('key', 'agent', [], transport).run({ message: 'Сравните', idempotencyKey: 'turn', prefetch, onBeforeSubmit });
    expect(result.knownProducts?.product_ids).toEqual([id]);
    expect(onBeforeSubmit).toHaveBeenCalledWith('sess', null, true, expect.any(String),
      expect.objectContaining({ completeness: 'full', items: [product] }));
    const failed = vi.fn(async () => new Response(JSON.stringify({ status: 'ok', results: [] }))) as unknown as typeof fetch;
    await expect(new PlatformAgentClient('key', 'agent', [], failed).run({ message: 'Сравните', idempotencyKey: 'turn', prefetch }))
      .rejects.toThrow('incomplete or inconsistent');
    expect(failed).toHaveBeenCalledOnce();
  });
  it('remembers every exact discovered identity even when no card was selected for display', () => {
    const ids = Array.from({ length: 12 }, (_, i) => String(i).padStart(24, '0'));
    const result = extractAgentResult([
      { turn_id: 't', type: 'mcp_call', server_label: 'bakaut_catalog', status: 'completed', name: 'get_product',
        output: { structuredContent: { status: 'ambiguous', source_revision: 'rev', candidates: ids.map(product_id => ({ product_id })) } } },
      { turn_id: 'other', type: 'mcp_call', server_label: 'bakaut_catalog', status: 'completed', name: 'get_product',
        output: { structuredContent: { status: 'found', source_revision: 'rev', product_id: 'ffffffffffffffffffffffff' } } },
      { turn_id: 't', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text',
        text: JSON.stringify({ answer: 'Уточните исполнение', selected: [], rejected: [], uncertain: [], availability: null }) }] }
    ], 't');
    expect(result.knownProducts).toEqual({ source_revision: 'rev', product_ids: ids });
    expect(result.page).toBeUndefined();
    const prefetch = { source_revision: 'rev', items: ids.map(product_id => ({ product_id })) };
    const readOne = { name: 'get_product', payload: { status: 'found', source_revision: 'rev', product_id: ids[0] } };
    expect(collectKnownProducts([readOne], prefetch)?.product_ids).toEqual(ids);
    expect(() => collectKnownProducts([{ ...readOne, payload: { ...readOne.payload, source_revision: 'new' } }], prefetch))
      .toThrow('revisions differ');
  });
  it('retains unshown search and semantic candidates as known products', () => {
    const ids = Array.from({ length: 12 }, (_, i) => i.toString(16).padStart(24, '0'));
    const calls = [
      { name: 'search_products', payload: { status: 'ok', source_revision: 'rev', items: ids.slice(0, 2).map(product_id => ({ product_id })) } },
      { name: 'semantic_select_products', payload: { status: 'ok', source_revision: 'rev', candidate_count: ids.length, candidate_ids: ids } }
    ];
    expect(collectKnownProducts(calls)).toEqual({ source_revision: 'rev', product_ids: ids });
    expect(() => collectKnownProducts([{ name: 'semantic_select_products', payload: {
      status: 'ok', source_revision: 'rev', candidate_count: 2, candidate_ids: [ids[0]] } }]))
      .toThrow('incomplete or duplicated');
  });
  it('rejects malformed successful discoveries instead of silently forgetting identities', () => {
    const id = '0123456789abcdef01234567';
    for (const call of [
      { name: 'semantic_select_products', payload: { status: 'ok', source_revision: 'rev', candidate_count: 2, candidate_ids: [id, 'bad-id'] } },
      { name: 'semantic_select_products', payload: { status: 'ok', source_revision: 'rev', candidate_count: 1 } },
      { name: 'search_products', payload: { status: 'ok', source_revision: 'rev', items: [{ product_id: id }, { product_id: 'bad-id' }] } },
      { name: 'search_products', payload: { status: 'ok', items: [{ product_id: id }] } }
    ]) expect(() => collectKnownProducts([call])).toThrow();
  });
  it('preserves every discovered identity for controlled review and rejects incomplete pages', () => {
    const ids = Array.from({ length: 112 }, (_, index) => index.toString(16).padStart(24, '0'));
    const discovery = { turn_id: 't', type: 'mcp_call', server_label: 'bakaut_catalog', name: 'semantic_select_products', status: 'completed',
      output: { structuredContent: { status: 'ok', selection_mode: 'candidate_discovery', source_revision: 'rev',
        complete: true, suitability_decided: false, candidate_count: ids.length, candidate_ids: ids } } };
    const pages = [0, 100].map(offset => {
      const returned_ids = ids.slice(offset, offset + 100), has_more = offset + returned_ids.length < ids.length;
      return { turn_id: 't', type: 'mcp_call', server_label: 'bakaut_catalog', name: 'get_products_batch', status: 'completed',
        output: { structuredContent: { status: 'ok', mode: 'full', source_revision: 'rev', requested_ids: ids,
          requested_count: ids.length, offset, returned_ids, returned_count: returned_ids.length, has_more,
          complete: !has_more, next_cursor: has_more ? 'next' : null,
          results: returned_ids.map(product_id => ({ product_id, requested_product_id: product_id, status: 'found',
            completeness: 'full', source_revision: 'rev', name: product_id, attributes: {}, description: product_id,
            documents: [], original_card: { unique: product_id } })) } } };
    });
    const reply = (rejected: string[]) => ({ turn_id: 't', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text',
      text: JSON.stringify({ answer: 'Результат', selected: [ids[0]], uncertain: [ids[1]], rejected, selection_snapshots: [], availability: null }) }] });
    const result = extractAgentResult([discovery, ...pages, reply(ids.slice(2))], 't');
    expect(result.knownProducts?.product_ids).toEqual(ids);
    expect(result.page?.candidate_ids).toEqual(ids);
    expect(() => extractAgentResult([discovery, pages[0], reply(ids.slice(2))], 't')).toThrow('pages are missing');
    const changed = structuredClone(pages);
    changed[1].output.structuredContent.source_revision = 'other';
    expect(() => extractAgentResult([discovery, ...changed, reply(ids.slice(2))], 't')).toThrow();
  });
  it('rejects old or unlabelled semantic selections in the active provider path', () => {
    const reply = { turn_id: 't', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: '{}' }] };
    const old = { turn_id: 't', type: 'mcp_call', server_label: 'bakaut_catalog', name: 'semantic_select_products', status: 'completed',
      output: { structuredContent: { status: 'ok', selection_mode: 'semantic', items: [] } } };
    expect(() => extractAgentResult([old, reply], 't', null, true)).toThrow('Legacy or untrusted');
    const unlabelled = { ...old, server_label: undefined, output: { structuredContent: { status: 'ok',
      selection_mode: 'candidate_discovery', candidate_ids: [], candidate_count: 0, source_revision: 'rev',
      complete: true, suitability_decided: false } } };
    expect(() => extractAgentResult([unlabelled, reply], 't', null, true)).toThrow('Legacy or untrusted');
    expect(() => extractAgentResult([{ ...old, status: 'failed' }, reply], 't', null, true)).toThrow('did not complete');
  });
  it('unions overlapping candidate categories only when their revision agrees', () => {
    const ids = ['000000000000000000000001', '000000000000000000000002', '000000000000000000000003'];
    const discovery = (candidate_ids: string[], source_revision = 'rev') => ({ turn_id: 't', type: 'mcp_call',
      server_label: 'bakaut_catalog', name: 'semantic_select_products', status: 'completed', output: { structuredContent: {
        status: 'ok', selection_mode: 'candidate_discovery', complete: true, suitability_decided: false,
        source_revision, candidate_count: candidate_ids.length, candidate_ids } } });
    const reply = { turn_id: 't', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: '{}' }] };
    const result = extractAgentResult([discovery(ids.slice(0, 2)), discovery(ids.slice(1)), reply], 't', null, true);
    expect(result.page?.candidate_ids).toEqual(ids);
    expect(() => extractAgentResult([discovery(ids.slice(0, 2)), discovery(ids.slice(1), 'other'), reply], 't', null, true))
      .toThrow('revisions differ');
  });
  it('stops an oversized complete request before submission instead of trimming cards or claiming complete delivery', async () => {
    const prefetch = { source_revision: 'rev', items: [{ product_id: '000000000000000000000001',
      description: 'x'.repeat(4_194_304), attributes: {}, documents: [], original_card: {} }] };
    const transport = vi.fn(async () => new Response(JSON.stringify({ instructions: 'Saved', tools: [] }))) as unknown as typeof fetch;
    await expect(new PlatformAgentClient('key', 'agent', [], transport).run({ message: 'Сравните', idempotencyKey: 'turn', prefetch }))
      .rejects.toBeInstanceOf(PlatformAgentInputTooLargeError);
    expect(transport).toHaveBeenCalledOnce();
    expect(JSON.stringify(modelProductContext(prefetch))).toContain('x'.repeat(4_194_304));
  });
  it('keeps every character across multipart follow-up input without splitting a Unicode surrogate pair', async () => {
    const text = 'x'.repeat(1_048_575) + '😀' + 'конец';
    const transport = vi.fn(async () => new Response('{}')) as unknown as typeof fetch;
    await new PlatformAgentClient('key', 'agent', [], transport).submitMessage('sess', text, 'turn');
    const options = (transport as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1] as RequestInit;
    const parts = JSON.parse(String(options.body)).events[0].input[0].content as { text: string }[];
    expect(parts).toHaveLength(2);
    expect(parts.every(part => part.text.length <= 1_048_576)).toBe(true);
    expect(parts.map(part => part.text).join('')).toBe(text);
    expect(parts[1].text.startsWith('😀')).toBe(true);
  });
  it.each([12, 112])('retains a full %i-product batch without display and validates every page before a reply', count => {
    const ids = Array.from({ length: count }, (_, i) => String(i).padStart(24, '0'));
    const calls = Array.from({ length: Math.ceil(count / 100) }, (_, i) => {
      const offset = i * 100, returned_ids = ids.slice(offset, offset + 100), has_more = offset + returned_ids.length < count;
      return { turn_id: 't', type: 'mcp_call', server_label: 'bakaut_catalog', status: 'completed', name: 'get_products_batch',
        output: { structuredContent: { status: 'ok', mode: 'full', source_revision: 'rev', requested_ids: ids, requested_count: count,
          returned_ids, returned_count: returned_ids.length, offset, has_more, complete: !has_more, next_cursor: has_more ? 'cursor100' : null,
          results: returned_ids.map(product_id => ({ product_id, requested_product_id: product_id, status: 'found', completeness: 'full',
            source_revision: 'rev', name: product_id, attributes: {}, description: product_id, documents: [], original_card: { id: product_id } })) } } };
    });
    const reply = (selected: string[]) => ({ turn_id: 't', role: 'assistant', phase: 'final_answer',
      content: [{ type: 'output_text', text: JSON.stringify({ answer: 'Вот сведения', selected, rejected: [], uncertain: [], availability: null }) }] });
    const unshown = extractAgentResult([...calls, reply([])], 't');
    expect(unshown.knownProducts).toEqual({ source_revision: 'rev', product_ids: ids });
    expect(unshown.page).toBeUndefined();
    const one = extractAgentResult([...calls, reply([ids[0]])], 't');
    expect((one.page?.items as { product_id: string }[]).map(item => item.product_id)).toEqual([ids[0]]);
    expect(one.knownProducts?.product_ids).toEqual(ids);
    const changed = structuredClone(calls);
    changed[0].output.structuredContent.source_revision = 'other';
    expect(() => extractAgentResult([...changed, reply([])], 't')).toThrow('incomplete or inconsistent');
    if (count > 100) expect(() => extractAgentResult([calls[0], reply([])], 't')).toThrow('pages are missing');
  });
  it('shows a newly looked-up model alongside a prior context without losing the twelve old identities', () => {
    const previous = Array.from({ length: 12 }, (_, i) => ({ product_id: String(i).padStart(24, '0'), name: `Prior ${i}` }));
    const fresh = { status: 'found', source_revision: 'rev', product_id: 'ffffffffffffffffffffffff', name: 'New model' };
    const result = extractAgentResult([
      { turn_id: 't', type: 'mcp_call', server_label: 'bakaut_catalog', name: 'get_product', status: 'completed', output: { structuredContent: fresh } },
      { turn_id: 't', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: JSON.stringify({
        answer: 'Вот новая модель', selected: [fresh.product_id], rejected: [], uncertain: [], availability: null }) }] }
    ], 't', { source_revision: 'rev', items: previous });
    expect(result.page?.items).toEqual([fresh]);
    expect(result.knownProducts?.product_ids).toEqual([...previous.map(item => item.product_id), fresh.product_id]);
  });
  it('does not make unrelated product lookups part of the answer selection', () => {
    const products = ['a', 'b'].map((product_id) => ({ product_id, name: product_id, price_rub: 100 }));
    const answer = JSON.stringify({ answer: 'Подробнее о товаре A', selected: ['a'], rejected: [], uncertain: [] });
    const result = extractAgentResult([
      ...products.map((product) => ({ turn_id: 't', type: 'mcp_call', name: 'get_product', status: 'completed',
        output: { structuredContent: { status: 'found', source_revision: 'rev', candidates: [], ...product } } })),
      { turn_id: 't', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: answer }] }
    ], 't');
    expect(result.page?.items).toHaveLength(1);
    expect((result.page?.items as Array<{ product_id: string }>)[0].product_id).toBe('a');
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
  it('uses one MCP tool set for catalog and web facts when the native tool combination fails', () => {
    const tools = [{ type: 'web_search', context_size: 'medium' }, { type: 'mcp', server_label: 'bakaut_catalog',
      credential_id: 'vault-credential', transport: { type: 'http', server_url: 'https://catalog.example/mcp' }, allowed_tools: ['search_products', 'get_product', 'semantic_rank_products'] }];
    const updated = configureCatalogTools(tools);
    expect(updated).toHaveLength(1);
    expect(updated?.[0]).toMatchObject({ credential_id: 'vault-credential', transport: tools[1].transport,
      allowed_tools: ['list_categories', 'get_product', 'get_products_batch', 'semantic_select_products', 'web_search_facts'] });
    expect(tools[1].allowed_tools).toEqual(['search_products', 'get_product', 'semantic_rank_products']);
    expect(configureCatalogTools(updated)).toBeUndefined();
  });
  it('marks a completed web facts MCP call as web research and exposes its usage', () => {
    const result = extractAgentResult([
      { turn_id: 'turn', type: 'mcp_call', name: 'web_search_facts', status: 'completed', output: {
        structuredContent: { status: 'ok', answer: 'Проверенный факт', usage: { run_id: 'web-run', model: 'gpt-6-luna', input_tokens: 15, output_tokens: 4 } }
      } },
      { turn_id: 'turn', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: JSON.stringify({
        answer: 'Проверенный факт', selected: [], rejected: [], uncertain: [], selection_snapshots: []
      }) }] }
    ], 'turn');
    expect(result.usedWebSearch).toBe(true);
    expect(result.webSearchUsages).toEqual([{ run_id: 'web-run', model: 'gpt-6-luna', input_tokens: 15, output_tokens: 4 }]);
  });
  it('does not claim web research when the budget context is unavailable', () => {
    const result = extractAgentResult([
      { turn_id: 'turn', type: 'mcp_call', name: 'web_search_facts', status: 'completed', output: {
        structuredContent: { status: 'unavailable', reason: 'trusted_budget_context_unavailable' }
      } },
      { turn_id: 'turn', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: JSON.stringify({
        answer: 'Предварительный ответ', selected: [], rejected: [], uncertain: [], selection_snapshots: []
      }) }] }
    ], 'turn');
    expect(result.usedWebSearch).toBe(false);
    expect(result.webSearchUsages).toEqual([]);
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
    expect((hydrated.items as unknown[]).length).toBe(2);
    expect((hydrated.uncertain_items as unknown[]).length).toBe(1);
    expect(transport).toHaveBeenCalledOnce();
    const [, options] = vi.mocked(transport).mock.calls[0] as [URL, RequestInit];
    expect(JSON.parse(String(options.body))).toMatchObject({ snapshot: 'semantic-snap', status_blob: 'JQ', candidate_count: 4 });
    await expect(readFullCatalogSnapshot({ ...selection, candidate_count: 5 }, undefined, transport)).rejects.toThrow('coverage');
  });

  it('preserves the agent refusal instead of forcing a semantic snapshot into the widget', () => {
    const selection = { status: 'ok', selection_mode: 'semantic', source_scan_complete: true,
      numeric_scan_complete: true, source_revision: 'rev', snapshot: 'disk-snap', candidate_count: 2,
      selected_count: 1, uncertain_count: 1, rejected_count: 0, status_blob: 'CQ',
      criteria: { category: 'Алмазные диски', requirement: 'для резчика' }, items: [{ product_id: 'disk' }] };
    const answer = JSON.stringify({ answer: 'Ничего нет', selected: [], rejected: [], uncertain: [],
      selection_snapshots: ['disk-snap'] });
    const result = extractAgentResult([
      { turn_id: 't', type: 'mcp_call', name: 'semantic_select_products', status: 'completed',
        output: { structuredContent: selection } },
      { turn_id: 't', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text',
        text: answer }] }
    ], 't');
    expect(result.answer).toBe(answer);
    expect(selectsAllCatalogMatches(result.answer)).toBe(false);
    expect(result.page).toEqual(selection);
  });

  it('shows only the corrected semantic selection and no cards after a repeated rejection', () => {
    const selection = (snapshot: string) => ({ status: 'ok', selection_mode: 'semantic',
      source_scan_complete: true, numeric_scan_complete: true, source_revision: 'rev', snapshot,
      candidate_count: 2, selected_count: 2, uncertain_count: 0, rejected_count: 0,
      criteria: { category: 'Глубинные вибраторы для бетона', requirement: 'отдельный электропривод' },
      selected_names: ['Электропривод', 'Готовый вибратор'], items: [{ product_id: 'drive' }, { product_id: 'machine' }] });
    const first = selection('wrong-first');
    const corrected = { ...selection('corrected-second'), selected_count: 1, rejected_count: 1,
      selected_names: ['Электропривод'], items: [{ product_id: 'drive' }] };
    const calls = [first, corrected].map((page) => ({ turn_id: 't', type: 'mcp_call',
      name: 'semantic_select_products', status: 'completed', output: { structuredContent: page } }));
    const final = (snapshots: string[], selected: string[]) => ({ turn_id: 't', role: 'assistant',
      phase: 'final_answer', content: [{ type: 'output_text', text: JSON.stringify({
        answer: 'Подбор завершён', selected, rejected: [], uncertain: [], selection_snapshots: snapshots
      }) }] });

    const repaired = extractAgentResult([...calls, final(['corrected-second'], [ALL_CATALOG_MATCHES])], 't');
    expect(repaired.page).toEqual(corrected);
    const refused = extractAgentResult([...calls, final([], [])], 't');
    expect(refused.page).toBeUndefined();
  });

  it('does not publish a semantic search when the agent answer is unusable', () => {
    const selection = { status: 'ok', selection_mode: 'semantic', source_scan_complete: true,
      numeric_scan_complete: true, source_revision: 'rev', snapshot: 'only-snap', candidate_count: 2,
      selected_count: 1, uncertain_count: 1, rejected_count: 0, status_blob: 'CQ',
      criteria: { category: 'Алмазные диски', requirement: 'для резчика' }, items: [{ product_id: 'disk' }] };
    const call = { turn_id: 't', type: 'mcp_call', name: 'semantic_select_products', status: 'completed',
      output: { structuredContent: selection } };
    const reply = (text: string) => ({ turn_id: 't', role: 'assistant', phase: 'final_answer',
      content: [{ type: 'output_text', text }] });
    for (const text of ['', 'Ответ не в JSON']) {
      const result = extractAgentResult([call, reply(text)], 't');
      expect(result.page).toBeUndefined();
    }
    const confirmed = extractAgentResult([call, reply(JSON.stringify({ answer: 'Есть варианты',
      selected: [ALL_CATALOG_MATCHES], rejected: [], uncertain: [], selection_snapshots: [] }))], 't');
    expect(confirmed.page).toEqual(selection);
    expect(selectsAllCatalogMatches(confirmed.answer)).toBe(true);
    expect(JSON.parse(confirmed.answer).selection_snapshots).toEqual(['only-snap']);
    const exploratory = extractAgentResult([call, reply(JSON.stringify({ answer: 'Нужно уточнить задачу',
      selected: [], rejected: [], uncertain: [], selection_snapshots: [] }))], 't');
    expect(exploratory.page).toBeUndefined();
    const changedId = extractAgentResult([call, reply(JSON.stringify({ answer: 'Есть варианты',
      selected: [ALL_CATALOG_MATCHES], rejected: [], uncertain: [], selection_snapshots: ['foreign'] }))], 't');
    expect(changedId.page).toEqual(selection);
    expect(JSON.parse(changedId.answer).selection_snapshots).toEqual(['only-snap']);
    expect(() => extractAgentResult([call, reply(JSON.stringify({ answer: 'Нужно уточнить задачу',
      selected: [], rejected: [], uncertain: [], selection_snapshots: ['foreign'] }))], 't'))
      .toThrow('unavailable');
  });

  it('uses one completed numeric search when the full-list marker has an empty snapshot list', () => {
    const page = { status: 'ok', group: 'matches', source_revision: 'rev', snapshot: 'numeric-snap',
      criteria: { category: 'Генераторы', query: '', min_nominal_kw: 5, max_nominal_kw: 6, max_price_rub: null },
      numeric_scan_complete: true, unsupported_filters: [], count: 1,
      items: [{ product_id: 'generator' }], has_more: false };
    const answer = JSON.stringify({ answer: 'Подобрал', selected: [ALL_CATALOG_MATCHES], rejected: [],
      uncertain: [], selection_snapshots: [] });
    const result = extractAgentResult([
      { turn_id: 't', type: 'mcp_call', name: 'search_products', status: 'completed', arguments: {},
        output: { structuredContent: page } },
      { turn_id: 't', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: answer }] }
    ], 't');
    expect(result.page).toEqual(page);
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
    const wrongAnswer = JSON.stringify({ answer: 'Есть диски', selected: [ALL_CATALOG_MATCHES], rejected: [],
      uncertain: [], selection_snapshots: ['a', 'foreign'] });
    expect(() => extractAgentResult([call(selection('a', 'Алмазные диски')),
      call(selection('b', 'Абразивные диски')),
      { turn_id: 't', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: wrongAnswer }] }], 't'))
      .toThrow('unavailable');
    const transport = vi.fn(async (_url: URL | RequestInfo, options?: RequestInit) => {
      const category = JSON.parse(String(options?.body)).criteria.category;
      const first = category === 'Алмазные диски';
      return new Response(JSON.stringify({ status: 'ok', source_revision: 'rev', items: first ?
        [{ product_id: 'a1', name: 'A', price_rub: 200 }, { product_id: 'a2', name: 'A?', price_rub: 300, match_status: 'uncertain' }] :
        [{ product_id: 'b1', name: 'B', price_rub: 100 }, { product_id: 'b2', name: 'B?', price_rub: 400, match_status: 'uncertain' }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const loaded = await readFullCatalogSnapshot(result.page!, undefined, transport);
    expect((loaded.items as Array<{ product_id: string }>).map((item) => item.product_id)).toEqual(['b1', 'a1']);
    expect((loaded.uncertain_items as Array<{ product_id: string }>).map((item) => item.product_id)).toEqual(['a2', 'b2']);
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
  it('upgrades the structured output of an existing session and continues it with an idempotency key', async () => {
    const replies = [
      {}, {}, { data: [{ id: 'turn-old' }] }, {}, {},
      { data: [{ id: 'turn-new', status: 'completed', usage: { total_tokens: 12 } }] },
      { data: [{ turn_id: 'turn-new', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: 'Готово' }] }] }
    ];
    const transport = vi.fn(async () => new Response(JSON.stringify(replies.shift()), { status: 200, headers: { 'content-type': 'application/json' } }));
    const client = new PlatformAgentClient('test-key', 'agent-id', [], transport as typeof fetch);
    const result = await client.run({ sessionId: 'session-id', message: 'Дальше', idempotencyKey: 'message-id' });
    expect(result.sessionId).toBe('session-id');
    expect(result.answer).toBe('Готово');
    const [, upgrade] = transport.mock.calls[1] as unknown as [string, RequestInit];
    expect(JSON.parse(String(upgrade.body)).agent.text.format.schema.required).toContain('availability');
    const [, options] = transport.mock.calls[3] as unknown as [string, RequestInit];
    expect((options.headers as Record<string, string>)['Idempotency-Key']).toBe('message-id');
    expect(JSON.parse(String(options.body)).events[0].input[0].content[0].text).toContain('Дальше');
  });
  it('stops waiting when the agent session fails without creating a turn', async () => {
    const transport = vi.fn(async (url: string) => new Response(JSON.stringify(
      url.endsWith('/turns?limit=1&order=desc') ? { data: [] } : { status: 'failed', error: 'An internal error occurred.' }
    ))) as unknown as typeof fetch;
    const client = new PlatformAgentClient('key', 'agent', [], transport);
    await expect(client.waitForTurn({ sessionId: 'failed-session', previousTurnId: null }))
      .rejects.toBeInstanceOf(PlatformAgentSessionFailedError);
    expect(transport).toHaveBeenCalledTimes(2);
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

  it.each(['session', 'checkpoint'] as const)('cancels an already submitted session when its %s persistence fails', async (stage) => {
    const transport = vi.fn(async (url: string, options?: RequestInit) => {
      if (url.endsWith('/agents/saved-agent') && options?.method === 'GET') return Response.json({ instructions: 'test' });
      if (url.endsWith('/agents/sessions') && options?.method === 'POST') return Response.json({ id: 'new-session' });
      throw new Error('Unexpected provider request');
    });
    const client = new PlatformAgentClient('test-key', 'saved-agent', [], transport as typeof fetch);
    const cancel = vi.spyOn(client, 'cancelTurn').mockResolvedValue(undefined);
    const wait = vi.spyOn(client, 'waitForTurn');
    const failure = new Error('persistence failed');
    await expect(client.run({ message: 'Запрос', idempotencyKey: 'turn',
      onSession: async () => { if (stage === 'session') throw failure; },
      onBeforeSubmit: async () => { if (stage === 'checkpoint') throw failure; }
    })).rejects.toBe(failure);
    expect(cancel).toHaveBeenCalledExactlyOnceWith('new-session');
    expect(wait).not.toHaveBeenCalled();
    expect(transport.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(1);
  });

  it('leaves deadline reconciliation to the assistant before cancelling', async () => {
    const controller = new AbortController();
    const events: string[] = [];
    let submitted = false;
    const transport = vi.fn(async (url: string, options: RequestInit) => {
      if (options.method === 'POST') {
        if (!url.endsWith('/events')) return new Response('{}', { status: 200 });
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

  it('lets a running turn finish during deadline recovery without cancelling it', async () => {
    const client = new PlatformAgentClient('test-key', 'agent-id');
    const latest = vi.spyOn(client, 'latestTurn').mockResolvedValue({ id: 'new', status: 'in_progress' });
    const cancel = vi.spyOn(client, 'cancelTurn').mockResolvedValue(undefined);
    const wait = vi.spyOn(client, 'waitForTurn').mockResolvedValue({ answer: 'готово' } as never);
    const signal = AbortSignal.timeout(5000);
    const result = await client.settleAtDeadline({ sessionId: 's', previousTurnId: 'old', signal });
    expect(result?.answer).toBe('готово');
    expect(latest).toHaveBeenCalledOnce();
    expect(cancel).not.toHaveBeenCalled();
    expect(wait).toHaveBeenCalledWith({ sessionId: 's', previousTurnId: 'old', signal, prefetch: undefined });
  });
  it('uses Responses retrieval and cancellation for a controlled checkpoint without calling an Agents session', async () => {
    const transport = vi.fn(async () => new Response(JSON.stringify({ id: 'resp_controlled', status: 'in_progress',
      model: 'gpt-6-luna', usage: { total_tokens: 100 } }))) as unknown as typeof fetch;
    const client = new PlatformAgentClient('key', 'saved', [], transport);
    expect(await client.latestTurn('controlled:resp_controlled')).toEqual({ id: 'resp_controlled', status: 'in_progress' });
    await client.cancelTurn('controlled:resp_controlled');
    await client.readTurn('', 'resp_controlled');
    const calls = (transport as unknown as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.map(([url]) => new URL(String(url)).pathname)).toEqual([
      '/v1/responses/resp_controlled', '/v1/responses/resp_controlled/cancel', '/v1/responses/resp_controlled'
    ]);
    expect(calls[1][1].method).toBe('POST');
    expect(calls.every(([, init]) => !init.headers['OpenAI-Beta'])).toBe(true);
  });

  it('checks completion again after grace expires and cancellation races completion', async () => {
    const client = new PlatformAgentClient('test-key', 'agent-id');
    const latest = vi.spyOn(client, 'latestTurn').mockResolvedValueOnce({ id: 'new', status: 'in_progress' })
      .mockResolvedValueOnce({ id: 'new', status: 'in_progress' }).mockResolvedValueOnce({ id: 'new', status: 'completed' });
    const cancel = vi.spyOn(client, 'cancelTurn').mockRejectedValue(new Error('already completed'));
    const controller = new AbortController();
    const wait = vi.spyOn(client, 'waitForTurn').mockImplementationOnce(async () => {
      controller.abort();
      throw new DOMException('deadline', 'AbortError');
    }).mockResolvedValueOnce({ answer: 'готово' } as never);
    const signal = controller.signal;
    const result = await client.settleAtDeadline({ sessionId: 's', previousTurnId: 'old', signal });
    expect(result?.answer).toBe('готово');
    expect(latest).toHaveBeenCalledTimes(3);
    expect(cancel).toHaveBeenCalledOnce();
    expect(wait).toHaveBeenCalledTimes(2);
  });

  it('cancels a turn that remains active after the recovery grace', async () => {
    const client = new PlatformAgentClient('test-key', 'agent-id');
    vi.spyOn(client, 'latestTurn').mockResolvedValue({ id: 'new', status: 'in_progress' });
    const cancel = vi.spyOn(client, 'cancelTurn').mockResolvedValue(undefined);
    const controller = new AbortController();
    vi.spyOn(client, 'waitForTurn').mockImplementation(async () => {
      controller.abort();
      throw new DOMException('deadline', 'AbortError');
    });
    const result = await client.settleAtDeadline({ sessionId: 's', previousTurnId: 'old', signal: controller.signal });
    expect(result).toBeNull();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('does not mistake an invalid completed answer for a deadline timeout', async () => {
    const client = new PlatformAgentClient('test-key', 'agent-id');
    vi.spyOn(client, 'latestTurn').mockResolvedValue({ id: 'new', status: 'in_progress' });
    const cancel = vi.spyOn(client, 'cancelTurn').mockResolvedValue(undefined);
    vi.spyOn(client, 'waitForTurn').mockRejectedValue(new Error('Invalid catalog product identity'));
    await expect(client.settleAtDeadline({ sessionId: 's', previousTurnId: 'old', signal: AbortSignal.timeout(5000) }))
      .rejects.toThrow('Invalid catalog product identity');
    expect(cancel).not.toHaveBeenCalled();
  });

  it('keeps the next-page control when restoring chat history', () => {
    expect(normalizePublicCardDisplay({ initialVisibleCount: 10, hasMore: true })).toEqual({ initialVisibleCount: 10, hasMore: true });
  });

  it('preserves more than 50 preloaded cards in chat history', () => {
    const cards = Array.from({ length: 70 }, (_, id) => ({ id: String(id), name: `Генератор ${id}`, specs: {}, reasons: [], caveats: [] }));
    expect(normalizePublicProductCards(cards)).toHaveLength(70);
  });
});

describe('Controlled Responses original context', () => {
  const historyMessage = (role: Message['role'], content: string, id: string, metadata: Message['metadata'] = {}): Message =>
    ({ role, content, id, sessionId: 'chat', createdAt: '2026-11-13T00:00:00Z', metadata });
  const fullCards = (count = 12) => ({ source_revision: 'revision', completeness: 'full' as const,
    items: Array.from({ length: count }, (_, i) => ({ product_id: i.toString(16).padStart(24, '0'), source_revision: 'revision',
      name: `Model ${i}`, attributes: { 'Ширина': `${i} мм` }, description: `Описание ${i}. `.repeat(1200),
      documents: [{ ссылка: `https://example.test/manual-${i}.pdf` }], original_card: {
        наименование: `Model ${i}`, особенности: `Unique ${i}`, фотографии: [`https://example.test/photo-${i}.jpg`], extra: { i } } })) });
  function harness(options: { count?: unknown; model?: string; completed?: Record<string, unknown>; initial?: Record<string, unknown> } = {}) {
    const usage = { input_tokens: 1000, output_tokens: 200, total_tokens: 1200, input_tokens_details: { cached_tokens: 100 } };
    const final = { id: 'resp_controlled', status: 'completed', model: 'gpt-6-luna', truncation: 'disabled', usage,
      output: [{ type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: JSON.stringify({
        answer: 'Полное сравнение', selected: [], rejected: [], uncertain: [], selection_snapshots: [], availability: null }) }] }], ...options.completed };
    const transport = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const path = new URL(url).pathname;
      if (path === '/v1/agents/saved') return new Response(JSON.stringify({ model: options.model ?? 'gpt-6-luna', instructions: 'Saved instructions',
        reasoning: { effort: 'medium' }, service_tier: 'default', tools: [{ authorization: 'saved-credential-must-not-copy' }] }));
      if (path === '/v1/responses/input_tokens') return new Response(JSON.stringify({ object: 'response.input_tokens', input_tokens: options.count ?? 1000 }));
      if (path === '/v1/responses' && init?.method === 'POST') return new Response(JSON.stringify({ id: 'resp_controlled', status: 'queued', model: 'gpt-6-luna', ...options.initial }));
      if (path === '/v1/responses/resp_controlled') return new Response(JSON.stringify(final));
      throw new Error('Unexpected controlled transport request');
    });
    return { client: new ControlledResponsesClient('mock-key', 'saved', transport as typeof fetch), transport, usage };
  }

  it('carries synthetic validated recovered chunks from Python full hydration to the controlled model request', async () => {
    const python = spawnSync('python', ['-X', 'utf8', '-B', 'tests/fixtures/synthetic_enriched_batch.py'],
      { encoding: 'utf8', maxBuffer: 8_000_000 });
    expect(python.status, python.stderr).toBe(0);
    const fixture = JSON.parse(python.stdout);
    const id = 'e'.repeat(24);
    const catalog = vi.fn(async () => Response.json(fixture.batch)) as unknown as typeof fetch;
    const prefetch = await readFullKnownProducts({ source_revision: 'fixture-revision', product_ids: [id] }, undefined, catalog);
    expect(prefetch.items[0].original_card).toEqual(fixture.original);
    expect(modelProductContext(prefetch).products[0].original_card).toEqual(fixture.original);
    const { client, transport } = harness();
    const plan = await client.prepare({ message: 'Опишите известный товар', history: [], prefetch });
    const input = plan.request.input as Array<{ content: Array<{ text: string }> }>;
    const text = input[1].content.map(part => part.text).join('');
    const delivered = JSON.parse(text.slice(text.indexOf('{')));
    expect(delivered.products[0].original_card).toEqual(fixture.original);
    expect(delivered.products[0].original_card.enriched_knowledge.chunks).toEqual(fixture.original.enriched_knowledge.chunks);
    expect(delivered.products[0].original_card.enriched_knowledge.chunks[0].text.length).toBeGreaterThan(250_000);
    expect(transport.mock.calls.every(([url]) => new URL(url).pathname !== '/v1/responses')).toBe(true);
    const overflow = harness({ count: 1_000_000 });
    await expect(overflow.client.prepare({ message: 'Опишите известный товар', history: [], prefetch })).rejects.toThrow('exceeds the model context budget');
    expect(overflow.transport.mock.calls.every(([url]) => new URL(url).pathname !== '/v1/responses')).toBe(true);
  });

  it('carries real Python full pages through known-product hydration into the prepared input', async () => {
    const python = spawnSync(process.platform === 'win32' ? 'python' : 'python3',
      ['-X', 'utf8', '-B', 'tests/fixtures/synthetic_multipage_batch.py'], { encoding: 'utf8', maxBuffer: 16_000_000 });
    expect(python.status, python.stderr).toBe(0);
    const fixture = JSON.parse(python.stdout);
    expect(fixture.ids).toHaveLength(112);
    expect(fixture.pages.map((page: { returned_count: number }) => page.returned_count)).toEqual([100, 12]);
    const servePages = (secondPage = fixture.pages[1]) => {
      let requests = 0;
      const fetchPage = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body));
        expect(body.identifiers).toEqual(fixture.ids);
        expect(body.expected_revision).toBe(fixture.revision);
        expect(body.mode).toBe('full');
        expect(body.cursor).toBe(requests === 0 ? undefined : fixture.pages[0].next_cursor);
        expect(requests).toBeLessThan(2);
        return Response.json(requests++ === 0 ? fixture.pages[0] : secondPage);
      });
      return fetchPage;
    };
    const catalog = servePages();
    const known = { source_revision: fixture.revision, product_ids: fixture.ids };
    const prefetch = await readFullKnownProducts(known, undefined, catalog as typeof fetch);
    expect(catalog).toHaveBeenCalledTimes(2);
    expect(prefetch.items).toEqual(fixture.pages.flatMap((page: { results: unknown[] }) => page.results));
    expect(prefetch.items.map(item => item.product_id)).toEqual(fixture.ids);
    expect(prefetch.items.map(item => item.original_card)).toEqual(fixture.cards);
    expect(modelProductContext(prefetch).products).toEqual(prefetch.items);
    const { client, transport } = harness();
    const plan = await client.prepare({ message: 'Опишите весь известный набор', history: [], prefetch });
    const input = plan.request.input as Array<{ content: Array<{ text: string }> }>;
    const text = input[1].content.map(part => part.text).join('');
    const delivered = JSON.parse(text.slice(text.indexOf('{')));
    expect(delivered.product_ids).toEqual(fixture.ids);
    expect(delivered.products).toEqual(prefetch.items);
    expect(delivered.products.map((item: { original_card: unknown }) => item.original_card)).toEqual(fixture.cards);
    expect(transport.mock.calls.every(([url]) => new URL(url).pathname !== '/v1/responses')).toBe(true);

    const changed = { ...fixture.pages[1], source_revision: 'another-revision' };
    const incomplete = { ...fixture.pages[1], results: fixture.pages[1].results.slice(0, -1) };
    for (const broken of [changed, incomplete]) {
      const brokenCatalog = servePages(broken);
      await expect(readFullKnownProducts(known, undefined, brokenCatalog as typeof fetch))
        .rejects.toThrow('Known product hydration is incomplete or inconsistent');
      expect(brokenCatalog).toHaveBeenCalledTimes(2);
    }
  });

  it('passes twelve real local DPU 6555 originals and a labelled synthetic nested control through the active full-card chain', async () => {
    const fixture = JSON.parse(readFileSync(new URL('./fixtures/dpu6555-local-originals.json', import.meta.url), 'utf8'));
    expect(fixture.revision_kind).toBe('fixture_not_live_catalog');
    expect(fixture.source).toBe('товары_база_знаний local snapshot');
    expect(fixture.items).toHaveLength(12);
    const python = spawnSync('python', ['-X', 'utf8', '-B', 'tests/fixtures/dpu6555_batch.py'],
      { encoding: 'utf8', maxBuffer: 8_000_000 });
    expect(python.status, python.stderr).toBe(0);
    const batch = JSON.parse(python.stdout);
    const ids = fixture.items.map((item: { product_id: string }) => item.product_id);
    expect(batch.requested_ids).toEqual(ids);
    const catalogTransport = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toMatchObject({ identifiers: ids, expected_revision: fixture.revision, mode: 'full' });
      return Response.json(batch);
    }) as unknown as typeof fetch;
    const prefetch = await readFullKnownProducts({ source_revision: fixture.revision, product_ids: ids }, undefined, catalogTransport);
    const { client, transport } = harness();
    const plan = await client.prepare({ message: 'Сравните все модификации DPU 6555 для траншеи, включая габариты.', history: [], prefetch });
    const input = plan.request.input as Array<{ content: Array<{ text: string }> }>;
    const text = input[1].content.map(part => part.text).join('');
    const delivered = JSON.parse(text.slice(text.indexOf('{')));
    expect(delivered.source_revision).toBe(fixture.revision);
    expect(delivered.product_ids).toEqual(ids);
    expect(delivered.products).toHaveLength(12);
    for (let i = 0; i < 12; i++) {
      expect(delivered.products[i].original_card).toEqual(fixture.items[i].original);
      expect(delivered.products[i].documents).toEqual(fixture.items[i].original.документы ?? []);
      expect(delivered.products[i].source_file).toBe(fixture.items[i].source_file);
      expect(delivered.products[i].source_sha256).toBe(fixture.items[i].source_sha256);
    }
    const hs = delivered.products.find((item: { sku: string }) => item.sku === '5100015773').original_card;
    expect(hs.характеристики['Ширина основания, мм']).toBe('550');
    expect(hs.характеристики['Размер плиты']).toBe('900×550 мм (длина×ширина), толщина 12 мм; ширина по раме 710 мм / 860 мм (ap)');
    expect(hs.характеристики['Рабочие габариты дхшхв']).toBe('900х860х1450 мм');
    const controlPython = spawnSync('python', ['-X', 'utf8', '-B', 'tests/fixtures/dpu6555_batch.py', '--synthetic-extra'],
      { encoding: 'utf8', maxBuffer: 8_000_000 });
    expect(controlPython.status, controlPython.stderr).toBe(0);
    const controlBatch = JSON.parse(controlPython.stdout);
    const controlIds = [...ids, 'f'.repeat(24)];
    const controlPrefetch = await readFullKnownProducts({ source_revision: fixture.revision, product_ids: controlIds }, undefined,
      vi.fn(async () => Response.json(controlBatch)) as unknown as typeof fetch);
    const controlPlan = await client.prepare({ message: 'Сравните полный набор.', history: [], prefetch: controlPrefetch });
    const controlInput = controlPlan.request.input as Array<{ content: Array<{ text: string }> }>;
    const controlText = controlInput[1].content.map(part => part.text).join('');
    const controlDelivered = JSON.parse(controlText.slice(controlText.indexOf('{')));
    expect(controlDelivered.products[12].source_file).toBe('synthetic-control-not-a-real-product.json');
    expect(controlDelivered.products[12].original_card.дополнительное_поле_проверки).toEqual({ вложенная_карта: { неизвестное: ['α', { условие: 'без потерь' }] } });
    expect(transport.mock.calls.every(([url]) => new URL(url).pathname !== '/v1/responses')).toBe(true);
  });

  it.each([12, 112])('submits all %i original cards and all private history with one generation and no stored credentials', async count => {
    const { client, transport } = harness();
    const prefetch = fullCards(count);
    const message = 'Сравни их и новую модель';
    const history = Array.from({ length: 24 }, (_, i) => historyMessage(i % 2 ? 'assistant' : 'user', `Реплика ${i}`, String(i),
      i % 2 ? { productCards: [{ id: prefetch.items[i % count].product_id }] } : {}));
    history.push(historyMessage('user', message, 'current'));
    const plan = await client.prepare({ message, history, prefetch });
    expect(plan.inputTokens).toBe(1000);
    expect(plan.reserveTokens).toBe(129_000);
    expect(plan.manifest.product_ids).toEqual(prefetch.items.map(item => item.product_id));
    expect(plan.request).toMatchObject({ model: 'gpt-6-luna', reasoning: { effort: 'medium' }, service_tier: 'default', truncation: 'disabled',
      background: true, store: true, max_output_tokens: 128_000, text: { format: { name: 'bakaut_buyer_answer', strict: true } } });
    for (const forbidden of ['context_management', 'conversation', 'previous_response_id']) expect(plan.request).not.toHaveProperty(forbidden);
    const serial = JSON.stringify(plan);
    expect(serial).not.toContain('mock-catalog-token');
    expect(serial).not.toContain('mock-key');
    expect(serial).not.toContain('saved-credential');
    const input = plan.request.input as Array<{ content: Array<{ text: string }> }>;
    expect(input.every(item => item.content.every(part => part.text.length <= 1_048_576))).toBe(true);
    const historyText = input[0].content.map(part => part.text).join('');
    for (let i = 0; i < 24; i++) expect(historyText).toContain(`Реплика ${i}`);
    expect(historyText).not.toContain(message);
    expect(historyText).toContain('shown_product_ids');
    const cardsText = input[1].content.map(part => part.text).join('');
    expect(cardsText).toContain(JSON.stringify(modelProductContext(prefetch)));
    const countBody = JSON.parse(String(transport.mock.calls[1][1]?.body));
    const responseId = await client.submit(JSON.parse(serial), 'turn-key');
    expect(responseId).toBe('resp_controlled');
    const submittedBody = JSON.parse(String(transport.mock.calls[2][1]?.body));
    for (const field of ['model', 'input', 'instructions', 'tools', 'text', 'reasoning', 'truncation']) expect(submittedBody[field]).toEqual(countBody[field]);
    expect(submittedBody.tools[0].authorization).toBe('mock-catalog-token');
    expect(submittedBody.text.format.schema.required).toContain('availability');
    const result = await client.wait(JSON.parse(serial), responseId);
    expect(result.knownProducts?.product_ids).toEqual(plan.manifest.product_ids);
    expect(result.contextReceipt.product_ids).toEqual(plan.manifest.product_ids);
    expect(JSON.stringify(result.contextReceipt)).not.toContain('Реплика');
    expect(transport.mock.calls.filter(([url, init]) => new URL(url).pathname === '/v1/responses' && init?.method === 'POST')).toHaveLength(1);
    expect(Object.isFrozen(plan.request)).toBe(true);
  });

  it('carries all 132 identity-keyed model decisions through a saved response into catalog groups', async () => {
    const prefetch = fullCards(133);
    const ids = prefetch.items.slice(0, 132).map(item => item.product_id);
    const decisions = Object.fromEntries(ids.map((id, i) => [id, i < 31 ? 'selected' : i < 130 ? 'rejected' : 'uncertain']));
    const answer = { answer: 'Подбор по задаче', candidate_decisions: decisions, comparison_ids: [],
      recommendation_status: 'confirmed', selection_snapshots: [], availability: null };
    const { client, transport } = harness({ completed: { output: [{ type: 'message', role: 'assistant', phase: 'final_answer',
      content: [{ type: 'output_text', text: JSON.stringify(answer) }] }] } });
    const plan = await client.prepare({ message: 'Все подходящие товары без ограничения цены', history: [], prefetch, classificationIds: ids });
    const schema = (plan.request.text as any).format.schema;
    expect(schema.properties.candidate_decisions.required).toEqual(ids);
    expect(schema.properties.selected).toBeUndefined();
    expect(plan.manifest.classification_ids).toEqual(ids);
    await client.submit(plan, 'review-turn');
    const saved = JSON.parse(JSON.stringify(plan));
    const result = await client.wait(saved, 'resp_controlled');
    const groups = JSON.parse(result.answer);
    expect(groups.selected).toEqual(ids.slice(0, 31));
    expect(groups.rejected).toEqual(ids.slice(31, 130));
    expect(groups.uncertain).toEqual(ids.slice(130));
    expect(result.page?.items).toHaveLength(132);
    expect(result.knownProducts?.product_ids).toHaveLength(133);
    expect(transport.mock.calls.filter(([url, init]) => new URL(url).pathname === '/v1/responses' && init?.method === 'POST')).toHaveLength(1);
  });
  it('resumes a saved request after JSON object keys are reordered without resubmitting or accepting changed content', async () => {
    const { client, transport } = harness();
    const plan = await client.prepare({ message: 'Сравните товары', history: [], prefetch: fullCards(2) });
    await client.submit(plan, 'saved-turn');
    function reorder(value: unknown): unknown {
      if (Array.isArray(value)) return value.map(reorder);
      if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).reverse().map(([key, item]) => [key, reorder(item)]));
      return value;
    }
    const saved = reorder(JSON.parse(JSON.stringify(plan))) as typeof plan;
    await expect(client.wait(saved, 'resp_controlled')).resolves.toMatchObject({ turnId: 'resp_controlled' });
    expect(transport.mock.calls.filter(([url, init]) => new URL(url).pathname === '/v1/responses' && init?.method === 'POST')).toHaveLength(1);
    const calls = transport.mock.calls.length;
    saved.prefetch.items[0].description = 'Подменённые данные';
    await expect(client.wait(saved, 'resp_controlled')).rejects.toThrow('snapshot integrity');
    expect(transport).toHaveBeenCalledTimes(calls);
  });

  it('delivers damaged history as explicit data while preserving full cards and immutable replay', async () => {
    const { client, transport } = harness();
    const prefetch = fullCards();
    const id = String(prefetch.items[0].product_id);
    const history = [historyMessage('assistant', 'Прежний товар', 'old', {
      knownProducts: { source_revision: prefetch.source_revision, product_ids: [id, 'broken-id', id] }
    })];
    const original = JSON.stringify(history);
    const parsed = knownProductHistory(history);
    expect(parsed.context).toEqual({ source_revision: prefetch.source_revision, product_ids: [id] });
    expect(parsed.issues.map(issue => issue.reason)).toEqual(['invalid_id', 'duplicate_id']);
    expect(knownProductContext(history[0].metadata.knownProducts)).toBeUndefined();
    const plan = await client.prepare({ message: 'Чем инвертор отличается от обычного генератора?', history, prefetch });
    const input = plan.request.input as Array<{ content: Array<{ text: string }> }>;
    const text = input[0].content.map(part => part.text).join('');
    expect(text).toContain('"status":"incomplete"');
    expect(text).toContain('"message_id":"old"');
    expect(text).toContain(id);
    expect(text).not.toContain('broken-id');
    expect(JSON.stringify(input[1])).toContain('original_card');
    const replay = JSON.parse(JSON.stringify(plan));
    await client.submit(replay, 'history-recovery');
    await client.wait(replay, 'resp_controlled');
    await client.wait(replay, 'resp_controlled');
    expect(transport.mock.calls.filter(([url, init]) => new URL(url).pathname === '/v1/responses' && init?.method === 'POST')).toHaveLength(1);
    expect(JSON.stringify(history)).toBe(original);
  });

  it('reports fully damaged history without inventing IDs or treating unrelated user metadata as memory', () => {
    const id = '000000000000000000000001';
    const history = [historyMessage('user', 'Вопрос', 'user', { knownProducts: { source_revision: 'rev', product_ids: [id] } }),
      historyMessage('assistant', 'Ответ', 'old', { knownProducts: { source_revision: 'rev', product_ids: ['invalid'] } })];
    expect(knownProductHistory(history)).toMatchObject({ context: undefined, recovered_product_ids: [],
      issues: [{ message_id: 'old', reason: 'invalid_id' }] });
    expect(knownProductHistoryNotice(history)).toContain('"status":"incomplete"');
    expect(knownProductHistoryNotice([history[0]])).toBe('');
  });

  it.each([922_001, -1, 1.5, '1000'])('rejects overflowing or invalid token count %s without generating', async count => {
    const { client, transport } = harness({ count });
    await expect(client.prepare({ message: 'Сравни', history: [], prefetch: fullCards() })).rejects.toThrow();
    expect(transport.mock.calls).toHaveLength(2);
  });

  it('rejects unknown models before counting and never silently changes the saved model', async () => {
    const { client, transport } = harness({ model: 'gpt-6-astra' });
    await expect(client.prepare({ message: 'Сравни', history: [], prefetch: fullCards() })).rejects.toThrow('no verified context limits');
    expect(transport.mock.calls).toHaveLength(1);
  });

  it('checks deserialized snapshots before submit or recovery rather than relying on Object.freeze', async () => {
    const { client, transport } = harness();
    const plan = await client.prepare({ message: 'Сравни', history: [], prefetch: fullCards() });
    const modified = JSON.parse(JSON.stringify(plan));
    modified.request.input[1].content[0].text = 'Only one card';
    await expect(client.submit(modified, 'turn')).rejects.toThrow('integrity');
    await expect(client.wait(modified, 'resp_controlled')).rejects.toThrow('integrity');
    expect(transport.mock.calls).toHaveLength(2);
  });

  it.each([{ output: [{ type: 'compaction', encrypted_content: 'opaque' }] }, { truncation: 'auto' },
    { previous_response_id: 'resp_hidden' }, { conversation: { id: 'conv_hidden' } },
    { input_transformations: [{ type: 'reasoning', action: 'removed' }] },
    { output: [{ type: 'message', role: 'assistant', status: 'incomplete', content: [{ type: 'output_text', text: 'partial' }] }] },
    { context_management: [{ type: 'compaction', compact_threshold: 1000 }] }, { status: 'incomplete' }, { status: 'failed' }, { status: 'cancelled' }])(
    'rejects altered context or noncomplete outputs and retains billable usage: %j', async completed => {
      const { client, usage } = harness({ completed });
      const plan = await client.prepare({ message: 'Сравни', history: [], prefetch: fullCards() });
      try { await client.wait(plan, 'resp_controlled'); throw new Error('Expected failure'); }
      catch (error) {
        expect(error).toBeInstanceOf(ControlledResponseFailure);
        expect((error as ControlledResponseFailure).response).toEqual({ id: 'resp_controlled', model: 'gpt-6-luna', usage });
      }
    });

  it('adapts native MCP JSON outputs and combines a new model with every prior identity', async () => {
    const fresh = { product_id: 'ffffffffffffffffffffffff', source_revision: 'revision', status: 'found', name: 'Fresh' };
    const { client } = harness({ completed: { output: [
      { type: 'mcp_call', name: 'get_product', server_label: 'bakaut_catalog', arguments: '{}', output: JSON.stringify(fresh) },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify({ answer: 'Вот новая модель',
        selected: [fresh.product_id], rejected: [], uncertain: [], selection_snapshots: [], availability: null }) }] }
    ] } });
    const plan = await client.prepare({ message: 'А новая модель?', history: [], prefetch: fullCards() });
    const result = await client.wait(plan, 'resp_controlled');
    expect(result.page?.items).toEqual([fresh]);
    expect(result.knownProducts?.product_ids).toEqual([...plan.manifest.product_ids, fresh.product_id]);
    expect(result.contextReceipt).toMatchObject({ manifest_scope: 'initial_original_cards', budget_scope: 'initial_input_plus_output' });
    expect(result.contextReceipt.product_ids).toEqual(plan.manifest.product_ids);
    expect(result.contextReceipt.late_tool_outputs).toEqual([{ tool: 'get_product', sha256: expect.any(String) }]);
  });

  it('never retries an uncertain generation POST', async () => {
    const base = harness();
    const transport = vi.fn(async (url: string | URL, init?: RequestInit) => {
      if (new URL(url).pathname === '/v1/responses') throw new Error('SENSITIVE_PROVIDER_NETWORK_TEXT');
      return base.transport(url, init);
    });
    const client = new ControlledResponsesClient('mock-key', 'saved', transport as typeof fetch);
    const plan = await client.prepare({ message: 'Сравни', history: [], prefetch: fullCards() });
    await expect(client.submit(plan, 'turn')).rejects.toThrow('outcome is unknown');
    expect(transport.mock.calls.filter(([url]) => new URL(url).pathname === '/v1/responses')).toHaveLength(1);
  });
  it('accepts a canonical snapshot of the requested alias and preserves its effective service tier', async () => {
    const { client } = harness({ completed: { model: 'gpt-6-luna-2026-11-01', service_tier: 'default' } });
    const plan = await client.prepare({ message: 'Сравни', history: [], prefetch: fullCards() });
    const result = await client.wait(plan, 'resp_controlled');
    expect(plan.model).toBe('gpt-6-luna');
    expect(result.model).toBe('gpt-6-luna-2026-11-01');
    expect(result.service_tier).toBe('default');
  });
  it('rejects a completed response with no model identity instead of assuming the requested alias', async () => {
    const { client } = harness({ completed: { model: undefined } });
    const plan = await client.prepare({ message: 'Сравни', history: [], prefetch: fullCards() });
    await expect(client.wait(plan, 'resp_controlled')).rejects.toBeInstanceOf(ControlledResponseFailure);
  });
  it.each([400, 401, 429])('distinguishes an explicit HTTP %i rejection from an uncertain transport outcome', async status => {
    const base = harness();
    const transport = vi.fn(async (url: string | URL, init?: RequestInit) => new URL(url).pathname === '/v1/responses'
      ? new Response('SENSITIVE_PROVIDER_ERROR', { status }) : base.transport(url, init));
    const client = new ControlledResponsesClient('mock-key', 'saved', transport as typeof fetch);
    const plan = await client.prepare({ message: 'Сравни', history: [], prefetch: fullCards() });
    await expect(client.submit(plan, 'turn')).rejects.toMatchObject({ name: 'ControlledRequestRejected', statusCode: status });
  });
});
