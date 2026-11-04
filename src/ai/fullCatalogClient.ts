import { config } from '../config.js';

type JsonObject = Record<string, unknown>;
const asObject = (value: unknown): JsonObject | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : undefined;
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);

/** Read the full, already filtered snapshot without sending each product back through the model. */
export async function readFullCatalogSnapshot(firstPage: JsonObject, signal?: AbortSignal, transport: typeof fetch = fetch): Promise<JsonObject> {
  if (!config.BAKAUT_MCP_TOKEN) throw new Error('Catalog access is not configured');
  const criteria = asObject(firstPage.criteria);
  const filters = asObject(firstPage.applied_filters);
  const unsupported = firstPage.unsupported_filters;
  const semantic = Array.isArray(criteria?.semantic_requirements) && firstPage.semantic_scan_complete === true;
  if (!criteria || !filters || !Array.isArray(unsupported) || unsupported.length || firstPage.numeric_scan_complete !== true ||
      typeof firstPage.source_revision !== 'string' || typeof firstPage.snapshot !== 'string' ||
      typeof firstPage.count !== 'number' ||
      (semantic ? criteria.category != null : typeof criteria.category !== 'string' || !criteria.category) ||
      typeof criteria.query !== 'string' || criteria.query.trim()) {
    throw new Error('Catalog did not establish complete structured filter coverage');
  }
  const keys = ['category', 'min_nominal_kw', 'max_nominal_kw', 'max_price_rub',
    ...(semantic ? ['semantic_requirements'] as const : [])] as const;
  for (const key of keys) {
    const value = criteria[key];
    if (value !== null && value !== undefined && !same(value, filters[key])) throw new Error('Catalog filter coverage mismatch');
  }
  const base = new URL(config.BAKAUT_CATALOG_URL);
  if (base.protocol !== 'https:' || base.hostname !== 'catalog-search-production.up.railway.app') throw new Error('Catalog URL is not allowed');
  const request = { query: criteria.query, category: criteria.category,
    min_nominal_kw: criteria.min_nominal_kw ?? null, max_nominal_kw: criteria.max_nominal_kw ?? null,
    max_price_rub: criteria.max_price_rub ?? null, expected_revision: firstPage.source_revision,
    ...(semantic ? { semantic_requirements: criteria.semantic_requirements } : {}) };
  const response = await transport(new URL('/search-full', base), {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${config.BAKAUT_MCP_TOKEN}` },
    body: JSON.stringify(request), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000)
  });
  if (!response.ok) throw new Error(`Full catalog request failed (${response.status})`);
  const body = asObject(await response.json());
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
  if (semantic) {
    const excluded = asObject(body.excluded);
    const excludedIds = excluded ? Object.keys(excluded) : [];
    const visibleIds = new Set(ids);
    if (!excluded || typeof body.candidates_checked !== 'number' ||
        excludedIds.length + ids.length !== body.candidates_checked ||
        excludedIds.some((id) => visibleIds.has(id) || !Array.isArray(excluded[id]) || !(excluded[id] as unknown[]).length)) {
      throw new Error('Semantic catalog did not account for every product');
    }
    const uncertain = [...groups.needs_check as unknown[], ...groups.unknown as unknown[]].map((value) => {
      const item = asObject(value);
      if (!item) throw new Error('Invalid uncertain semantic product');
      return { ...item, match_status: 'uncertain' };
    });
    return { ...firstPage, items: [...items, ...uncertain], has_more: false, next_cursor: null,
      semantic_result_statuses: counts };
  }
  const pendingPriceItems = (groups.needs_check as unknown[]).filter((value) => {
    const item = asObject(value);
    return item && (item.price_rub === null || item.price_rub === undefined) &&
      Array.isArray(item.conditions) && item.conditions.length === 1 && item.conditions[0] === 'нет цены для проверки бюджета';
  });
  return { ...firstPage, items, pending_price_items: pendingPriceItems, has_more: false, next_cursor: null };
}
