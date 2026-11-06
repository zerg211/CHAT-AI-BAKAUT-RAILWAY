import { diagnosticSpan, diagnosticEvent } from '../observability/diagnostics.js';
import { config } from '../config.js';

type JsonObject = Record<string, unknown>;
const asObject = (value: unknown): JsonObject | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : undefined;
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);

export type ExactMentionPrefetch = { source_revision: string; items: JsonObject[] };

export async function reselectFromBuyerMessage(page: JsonObject, message: string, signal?: AbortSignal,
  transport: typeof fetch = fetch): Promise<JsonObject | null> {
  const criteria = asObject(page.criteria);
  if (page.selection_mode !== 'semantic' || page.selected_count !== 0 ||
      typeof page.uncertain_count !== 'number' || page.uncertain_count < 1 ||
      !criteria || typeof criteria.category !== 'string' || !criteria.category ||
      typeof page.source_revision !== 'string' || !message.trim() || message.length > 600) return null;
  if (!config.BAKAUT_MCP_TOKEN) throw new Error('Catalog access is not configured');
  const base = new URL(config.BAKAUT_CATALOG_URL);
  if (base.protocol !== 'https:' || base.hostname !== 'catalog-search-production.up.railway.app') throw new Error('Catalog URL is not allowed');
  const body = { requirement: message, category: criteria.category,
    min_nominal_kw: criteria.min_nominal_kw ?? null, max_nominal_kw: criteria.max_nominal_kw ?? null,
    max_price_rub: criteria.max_price_rub ?? null, expected_revision: page.source_revision };
  const expectedCriteria = { requirement: body.requirement, category: body.category,
    min_nominal_kw: body.min_nominal_kw, max_nominal_kw: body.max_nominal_kw, max_price_rub: body.max_price_rub };
  const response = await transport(new URL('/semantic-select-buyer', base), {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${config.BAKAUT_MCP_TOKEN}` },
    body: JSON.stringify(body), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(45_000)]) : AbortSignal.timeout(45_000)
  });
  if (!response.ok) throw new Error(`Buyer catalog recheck failed (${response.status})`);
  const checked = asObject(await response.json());
  if (!checked || checked.status !== 'ok' || checked.selection_mode !== 'semantic' ||
      checked.source_revision !== page.source_revision || !same(checked.criteria, expectedCriteria) ||
      checked.candidate_count !== page.candidate_count || checked.source_scan_complete !== true ||
      typeof checked.selected_count !== 'number' || typeof checked.uncertain_count !== 'number' ||
      typeof checked.rejected_count !== 'number' ||
      checked.selected_count + checked.uncertain_count + checked.rejected_count !== checked.candidate_count) {
    diagnosticEvent('catalog.buyer_recheck.mismatch', {
      statusOk: checked?.status === 'ok', modeMatches: checked?.selection_mode === 'semantic',
      revisionMatches: checked?.source_revision === page.source_revision,
      criteriaMatches: same(checked?.criteria, expectedCriteria),
      candidateCountMatches: checked?.candidate_count === page.candidate_count,
      sourceScanComplete: checked?.source_scan_complete === true,
      countsValid: typeof checked?.selected_count === 'number' &&
        typeof checked?.uncertain_count === 'number' && typeof checked?.rejected_count === 'number' &&
        checked.selected_count + checked.uncertain_count + checked.rejected_count === checked.candidate_count
    });
    throw new Error('Buyer catalog recheck is inconsistent');
  }
  diagnosticEvent('catalog.buyer_recheck.completed', { selectedCount: checked.selected_count,
    uncertainCount: checked.uncertain_count, candidateCount: checked.candidate_count });
  return checked;
}

/** Exact identity evidence only; broad or oversized requests retain the regular agent tools. */
export async function readExactMentionPrefetch(message: string, signal?: AbortSignal,
  transport: typeof fetch = fetch): Promise<ExactMentionPrefetch | null> {
  if (!config.BAKAUT_MCP_TOKEN || !config.BAKAUT_CATALOG_URL || message.length > 2000) return null;
  const base = new URL(config.BAKAUT_CATALOG_URL);
  if (base.protocol !== 'https:' || base.hostname !== 'catalog-search-production.up.railway.app') throw new Error('Catalog URL is not allowed');
  const response = await diagnosticSpan('catalog.exact_prefetch', async () => transport(new URL('/mentioned-products', base), {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${config.BAKAUT_MCP_TOKEN}` },
    body: JSON.stringify({ message }),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(1500)]) : AbortSignal.timeout(1500)
  }));
  if (!response.ok) throw new Error(`Exact catalog prefetch failed (${response.status})`);
  const body = asObject(await response.json());
  if (!body || body.status !== 'ok' || body.match_basis !== 'exact_model_or_sku_mention' ||
      typeof body.source_revision !== 'string' || !body.source_revision || !Array.isArray(body.items) ||
      body.count !== body.items.length || body.items.length > 4324) throw new Error('Invalid exact catalog prefetch');
  const items = body.items.map(asObject);
  const ids = items.map((item) => item?.product_id);
  if (items.some((item) => !item || item.status !== 'found' || item.source_revision !== body.source_revision ||
      typeof item.name !== 'string' || typeof item.product_id !== 'string' ||
      !Array.isArray(item.matched_aliases) || !item.matched_aliases.length) ||
      new Set(ids).size !== ids.length) throw new Error('Invalid exact catalog identities');
  const evidence = { source_revision: body.source_revision, items: items as JsonObject[] };
  if (!items.length || Buffer.byteLength(JSON.stringify(evidence), 'utf8') > 128_000) return null;
  diagnosticEvent('catalog.exact_prefetch.ready', { itemCount: items.length, sourceRevision: body.source_revision });
  return evidence;
}

async function readSemanticSelection(page: JsonObject, signal: AbortSignal | undefined, transport: typeof fetch): Promise<JsonObject> {
  const criteria = asObject(page.criteria);
  if (page.status !== 'ok' || page.selection_mode !== 'semantic' || page.source_scan_complete !== true ||
      page.numeric_scan_complete !== true || !criteria ||
      (criteria.category !== null && typeof criteria.category !== 'string') ||
      typeof criteria.requirement !== 'string' || !criteria.requirement ||
      typeof page.source_revision !== 'string' || typeof page.snapshot !== 'string' ||
      typeof page.status_blob !== 'string' || !page.status_blob ||
      typeof page.candidate_count !== 'number' || typeof page.selected_count !== 'number' ||
      typeof page.uncertain_count !== 'number' || typeof page.rejected_count !== 'number' ||
      page.selected_count + page.uncertain_count + page.rejected_count !== page.candidate_count) {
    throw new Error('Semantic catalog coverage is incomplete');
  }
  const base = new URL(config.BAKAUT_CATALOG_URL);
  if (base.protocol !== 'https:' || base.hostname !== 'catalog-search-production.up.railway.app') throw new Error('Catalog URL is not allowed');
  const response = await transport(new URL('/semantic-selection', base), {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${config.BAKAUT_MCP_TOKEN}` },
    body: JSON.stringify({ criteria, status_blob: page.status_blob, candidate_count: page.candidate_count,
      snapshot: page.snapshot, expected_revision: page.source_revision }),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000)
  });
  if (!response.ok) {
    const failure = asObject(await response.json().catch(() => null));
    diagnosticEvent('catalog.semantic_snapshot.rejected', {
      statusCode: response.status,
      reason: typeof failure?.error === 'string' ? failure.error :
        typeof failure?.status === 'string' ? failure.status : 'unknown'
    });
    throw new Error(`Semantic catalog hydration failed (${response.status})`);
  }
  const body = asObject(await response.json());
  const selectedCount = page.selected_count as number;
  const uncertainCount = page.uncertain_count as number;
  if (!body || body.status !== 'ok' || body.source_revision !== page.source_revision || !Array.isArray(body.items) ||
      body.items.length !== selectedCount + uncertainCount ||
      body.items.some((value, index) => typeof asObject(value)?.product_id !== 'string' ||
        (index < selectedCount ? asObject(value)?.match_status === 'uncertain' : asObject(value)?.match_status !== 'uncertain')) ||
      new Set(body.items.map((value) => asObject(value)?.product_id)).size !== body.items.length) {
    throw new Error('Semantic catalog hydration did not match the selection');
  }
  diagnosticEvent('catalog.semantic_snapshot.validated', { candidateCount: page.candidate_count,
    selectedCount: page.selected_count, uncertainCount: page.uncertain_count, rejectedCount: page.rejected_count });
  return { ...page, items: body.items.slice(0, selectedCount),
    uncertain_items: body.items.slice(selectedCount), count: selectedCount, has_more: false, next_cursor: null };
}

async function readSemanticSelections(page: JsonObject, signal: AbortSignal | undefined, transport: typeof fetch): Promise<JsonObject> {
  if (!Array.isArray(page.selections) || page.selections.length < 2 ||
      page.selections.some((item) => !asObject(item))) throw new Error('Semantic catalog selections are invalid');
  const selections = page.selections as JsonObject[];
  const revisions = new Set(selections.map((item) => item.source_revision));
  if (revisions.size !== 1 || !revisions.has(page.source_revision)) throw new Error('Semantic catalog revisions differ');
  const loaded = await Promise.all(selections.map((item) => readSemanticSelection(item, signal, transport)));
  const byId = new Map<string, JsonObject>();
  for (const selection of loaded) for (const raw of [...selection.items as unknown[], ...selection.uncertain_items as unknown[]]) {
    const item = asObject(raw)!;
    const id = item.product_id as string;
    const previous = byId.get(id);
    if (!previous || (previous.match_status === 'uncertain' && item.match_status !== 'uncertain')) byId.set(id, item);
  }
  const sort = (a: JsonObject, b: JsonObject) => {
    const priceA = typeof a.price_rub === 'number' ? a.price_rub : Number.POSITIVE_INFINITY;
    const priceB = typeof b.price_rub === 'number' ? b.price_rub : Number.POSITIVE_INFINITY;
    return priceA - priceB || String(a.name ?? '').localeCompare(String(b.name ?? ''), 'ru');
  };
  const items = [...byId.values()].filter((item) => item.match_status !== 'uncertain').sort(sort);
  const uncertainItems = [...byId.values()].filter((item) => item.match_status === 'uncertain').sort(sort);
  const budgets = selections.map((item) => asObject(item.criteria)?.max_price_rub);
  const sharedBudget = budgets.every((value) => same(value, budgets[0])) ? budgets[0] : null;
  return { ...page, items, uncertain_items: uncertainItems, count: items.length,
    criteria: { max_price_rub: sharedBudget },
    has_more: false, next_cursor: null };
}

async function readNumericSelections(page: JsonObject, signal: AbortSignal | undefined, transport: typeof fetch): Promise<JsonObject> {
  if (!Array.isArray(page.selections) || page.selections.length < 2 ||
      page.selections.some((item) => !asObject(item) || asObject(item)?.source_revision !== page.source_revision)) {
    throw new Error('Numeric catalog selections are invalid');
  }
  const loaded = await Promise.all((page.selections as JsonObject[])
    .map((item) => readFullCatalogSnapshot(item, signal, transport)));
  const confirmed = new Map<string, JsonObject>();
  const pending = new Map<string, JsonObject>();
  const uncertain = new Map<string, JsonObject>();
  for (const selection of loaded) {
    for (const item of selection.items as JsonObject[]) confirmed.set(item.product_id as string, item);
    for (const item of selection.pending_price_items as JsonObject[]) pending.set(item.product_id as string, item);
    for (const item of selection.uncertain_items as JsonObject[]) uncertain.set(item.product_id as string, item);
  }
  for (const id of confirmed.keys()) { pending.delete(id); uncertain.delete(id); }
  for (const id of pending.keys()) uncertain.delete(id);
  const budgets = loaded.map((item) => asObject(item.criteria)?.max_price_rub);
  if (!budgets.every((value) => same(value, budgets[0]))) throw new Error('Numeric catalog budgets differ');
  const ordered = (values: Map<string, JsonObject>) => [...values.values()].sort((a, b) =>
    (typeof a.price_rub === 'number' ? a.price_rub : Infinity) -
    (typeof b.price_rub === 'number' ? b.price_rub : Infinity) ||
    String(a.name ?? '').localeCompare(String(b.name ?? ''), 'ru'));
  return { ...page, items: ordered(confirmed), count: confirmed.size,
    pending_price_items: ordered(pending), uncertain_items: ordered(uncertain),
    criteria: { max_price_rub: budgets[0] }, has_more: false, next_cursor: null };
}

/** Read the full, already filtered snapshot without sending each product back through the model. */
export async function readFullCatalogSnapshot(firstPage: JsonObject, signal?: AbortSignal, transport: typeof fetch = fetch): Promise<JsonObject> {
  return diagnosticSpan('catalog.full_snapshot', async () => {
  if (!config.BAKAUT_MCP_TOKEN) throw new Error('Catalog access is not configured');
  if (firstPage.selection_mode === 'semantic') return readSemanticSelection(firstPage, signal, transport);
  if (firstPage.selection_mode === 'semantic_multi') return readSemanticSelections(firstPage, signal, transport);
  if (firstPage.selection_mode === 'numeric_multi') return readNumericSelections(firstPage, signal, transport);
  const criteria = asObject(firstPage.criteria);
  const filters = asObject(firstPage.applied_filters);
  const unsupported = firstPage.unsupported_filters;
  if (!criteria || !filters || !Array.isArray(unsupported) || unsupported.length || firstPage.numeric_scan_complete !== true ||
      typeof firstPage.source_revision !== 'string' || typeof firstPage.snapshot !== 'string' ||
      typeof firstPage.count !== 'number' || typeof criteria.category !== 'string' || !criteria.category ||
      typeof criteria.query !== 'string' || criteria.query.trim()) {
    throw new Error('Catalog did not establish complete structured filter coverage');
  }
  const keys = ['category', 'min_nominal_kw', 'max_nominal_kw', 'max_price_rub'] as const;
  for (const key of keys) {
    const value = criteria[key];
    if (value !== null && value !== undefined && !same(value, filters[key])) throw new Error('Catalog filter coverage mismatch');
  }
  const base = new URL(config.BAKAUT_CATALOG_URL);
  if (base.protocol !== 'https:' || base.hostname !== 'catalog-search-production.up.railway.app') throw new Error('Catalog URL is not allowed');
  const request = { query: criteria.query, category: criteria.category,
    min_nominal_kw: criteria.min_nominal_kw ?? null, max_nominal_kw: criteria.max_nominal_kw ?? null,
    max_price_rub: criteria.max_price_rub ?? null, expected_revision: firstPage.source_revision };
  const response = await diagnosticSpan('catalog.http.headers', async () => transport(new URL('/search-full', base), {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${config.BAKAUT_MCP_TOKEN}` },
    body: JSON.stringify(request), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000)
  }), { endpoint: '/search-full', method: 'POST' });
  diagnosticEvent('catalog.http.response', { statusCode: response.status, endpoint: '/search-full', method: 'POST' });
  if (!response.ok) throw new Error(`Full catalog request failed (${response.status})`);
  const body = asObject(await diagnosticSpan('catalog.http.body_parse', async () => response.json()));
  const groups = asObject(body?.groups);
  const counts = asObject(body?.counts);
  if (!body || body.status !== 'ok' || body.source_revision !== firstPage.source_revision || body.snapshot !== firstPage.snapshot ||
      !same(body.criteria, criteria) || !same(body.applied_filters, filters) || !same(body.unsupported_filters, unsupported) ||
      body.has_more !== false || body.count !== firstPage.count || !groups || !counts ||
      !['matches', 'needs_check', 'unknown'].every((name) => Array.isArray(groups[name]) && groups[name].length === counts[name])) {
    throw new Error('Full catalog snapshot did not match the agent search');
  }
  const items = groups.matches as unknown[];
  if (items.length !== firstPage.count) throw new Error('Full catalog result count mismatch');
  const ids = Object.values(groups).flatMap((group) => Array.isArray(group) ? group.map((item) => asObject(item)?.product_id) : []);
  if (ids.some((id) => typeof id !== 'string' || !id) || new Set(ids).size !== ids.length) throw new Error('Full catalog contains duplicate or invalid product identities');
  const pendingPriceItems = (groups.needs_check as unknown[]).filter((value) => {
    const item = asObject(value);
    return item && (item.price_rub === null || item.price_rub === undefined) &&
      Array.isArray(item.conditions) && item.conditions.length === 1 && item.conditions[0] === 'нет цены для проверки бюджета';
  });
  const pendingIds = new Set(pendingPriceItems.map((value) => asObject(value)?.product_id));
  const uncertainItems = [...groups.needs_check as JsonObject[], ...groups.unknown as JsonObject[]]
    .filter((item) => !pendingIds.has(item.product_id))
    .map((item) => ({ ...item, match_status: 'uncertain' }));
  diagnosticEvent('catalog.full_snapshot.validated', { itemCount: items.length, unknownCount: pendingPriceItems.length + uncertainItems.length, sourceRevision:firstPage.source_revision,snapshotId:firstPage.snapshot });
  return { ...firstPage, items, pending_price_items: pendingPriceItems,
    uncertain_items: uncertainItems, has_more: false, next_cursor: null };
  });
}
