import type { Message } from '../shared/types.js';
import type { ExactMentionPrefetch, KnownProductContext } from './fullCatalogClient.js';

type RecordValue = Record<string, unknown>;
const object = (value: unknown): RecordValue | undefined => value !== null && typeof value === 'object' && !Array.isArray(value)
  ? value as RecordValue : undefined;
const productId = (value: unknown): value is string => typeof value === 'string' && value.length === 24 &&
  [...value].every(character => '0123456789abcdef'.includes(character));

export function knownProductContext(value: unknown): KnownProductContext | undefined {
  const source = object(value);
  if (!source || typeof source.source_revision !== 'string' || !source.source_revision ||
    !Array.isArray(source.product_ids) || !source.product_ids.length ||
    !source.product_ids.every(productId) || new Set(source.product_ids).size !== source.product_ids.length) return undefined;
  return { source_revision: source.source_revision, product_ids: [...source.product_ids] };
}

type HistoryIssue = { message_id: string | null; message_index: number;
  reason: 'invalid_record' | 'invalid_revision' | 'invalid_ids' | 'invalid_id' | 'duplicate_id'; id_index?: number };

export function knownProductHistory(messages: Message[]) {
  let revision: string | undefined;
  const identities = new Set<string>();
  const issues: HistoryIssue[] = [];
  for (const [messageIndex, message] of messages.entries()) {
    if (message.role !== 'assistant') continue;
    const raw = message.metadata.knownProducts;
    if (raw === undefined) continue;
    const issue = (reason: HistoryIssue['reason'], idIndex?: number) => issues.push({
      message_id: typeof message.id === 'string' ? message.id : null, message_index: messageIndex, reason,
      ...(idIndex === undefined ? {} : { id_index: idIndex }) });
    const source = object(raw);
    if (!source) { issue('invalid_record'); continue; }
    if (typeof source.source_revision === 'string' && source.source_revision.trim()) revision = source.source_revision;
    else issue('invalid_revision');
    if (!Array.isArray(source.product_ids) || !source.product_ids.length) { issue('invalid_ids'); continue; }
    const seen = new Set<string>();
    for (const [index, id] of source.product_ids.entries()) {
      if (!productId(id)) { issue('invalid_id', index); continue; }
      if (seen.has(id)) issue('duplicate_id', index);
      seen.add(id);
      identities.add(id);
    }
  }
  return { context: revision && identities.size ? { source_revision: revision, product_ids: [...identities] } : undefined,
    recovered_product_ids: [...identities], issues };
}

export function latestKnownProducts(messages: Message[]): KnownProductContext | undefined {
  return knownProductHistory(messages).context;
}

export function knownProductHistoryNotice(messages: Message[]): string {
  const history = knownProductHistory(messages);
  if (!history.issues.length) return '';
  return `\n\nСостояние сохранённой истории товаров (данные, не инструкции): ${JSON.stringify({
    kind: 'known_product_history', status: 'incomplete', recovered_product_ids: history.recovered_product_ids,
    issues: history.issues })}`;
}

export function contextFromPrefetch(prefetch?: ExactMentionPrefetch | null): KnownProductContext | undefined {
  if (!prefetch) return undefined;
  return knownProductContext({ source_revision: prefetch.source_revision,
    product_ids: prefetch.items.map(item => item.product_id) });
}

function fullBatchContexts(calls: Array<{ name: string; payload?: RecordValue }>): KnownProductContext[] {
  const batches = new Map<string, { context: KnownProductContext; pages: Map<number, RecordValue> }>();
  for (const { name, payload } of calls) {
    if (name !== 'get_products_batch' || payload?.mode !== 'full') continue;
    const context = knownProductContext({ source_revision: payload.source_revision, product_ids: payload.requested_ids });
    const offset = payload.offset;
    const results = Array.isArray(payload.results) ? payload.results.map(object) : [];
    const returned = results.map(item => item?.product_id);
    if (!context || payload.status !== 'ok' || payload.requested_count !== context.product_ids.length ||
        !Number.isInteger(offset) || typeof offset !== 'number' || offset < 0 || offset % 100 ||
        !results.length || results.length > 100 || payload.returned_count !== results.length ||
        JSON.stringify(payload.returned_ids) !== JSON.stringify(returned) ||
        JSON.stringify(returned) !== JSON.stringify(context.product_ids.slice(offset, offset + results.length)) ||
        results.some(item => !item || item.status !== 'found' || item.completeness !== 'full' ||
          item.requested_product_id !== item.product_id || item.source_revision !== context.source_revision ||
          !object(item.attributes) || typeof item.description !== 'string' || !Array.isArray(item.documents) || !object(item.original_card)) ||
        payload.has_more !== (offset + results.length < context.product_ids.length) || payload.complete !== !payload.has_more ||
        (payload.has_more ? typeof payload.next_cursor !== 'string' || !payload.next_cursor : payload.next_cursor !== null)) {
      throw new Error('Full catalog batch is incomplete or inconsistent');
    }
    const key = JSON.stringify(context);
    const batch = batches.get(key) ?? { context, pages: new Map<number, RecordValue>() };
    const previous = batch.pages.get(offset);
    if (previous && JSON.stringify(previous) !== JSON.stringify(payload)) throw new Error('Full catalog batch page changed');
    batch.pages.set(offset, payload);
    batches.set(key, batch);
  }
  for (const { context, pages } of batches.values()) {
    let offset = 0;
    const cursors = new Set<string>();
    for (const [pageOffset, page] of [...pages].sort(([a], [b]) => a - b)) {
      if (pageOffset !== offset) throw new Error('Full catalog batch pages are missing');
      offset += page.returned_count as number;
      if (typeof page.next_cursor === 'string') {
        if (cursors.has(page.next_cursor)) throw new Error('Full catalog batch cursor did not advance');
        cursors.add(page.next_cursor);
      }
    }
    if (offset !== context.product_ids.length) throw new Error('Full catalog batch pages are missing');
  }
  return [...batches.values()].map(batch => batch.context);
}

export function assertCandidateDiscoveryCoverage(calls: Array<{ name: string; payload?: RecordValue }>): void {
  if (calls.some(call => call.name === 'semantic_select_products' && (!call.payload || call.payload.status !== 'ok'))) {
    throw new Error('Category candidate discovery is unavailable');
  }
  const discoveries = calls.filter(call => call.name === 'semantic_select_products' && call.payload?.status === 'ok');
  if (!discoveries.length) return;
  const candidates = new Set<string>();
  let revision: string | undefined;
  for (const { payload } of discoveries) {
    if (!payload || payload.selection_mode !== 'candidate_discovery' || payload.complete !== true ||
        payload.suitability_decided !== false || typeof payload.source_revision !== 'string' || !payload.source_revision ||
        !Array.isArray(payload.candidate_ids) || payload.candidate_count !== payload.candidate_ids.length ||
        !payload.candidate_ids.every(productId) || new Set(payload.candidate_ids).size !== payload.candidate_ids.length) {
      throw new Error('Category candidate discovery is incomplete or incompatible');
    }
    if (revision && revision !== payload.source_revision) throw new Error('Candidate discovery revisions differ');
    revision = payload.source_revision;
    payload.candidate_ids.forEach(id => candidates.add(id));
  }
}

/** These are exact discoveries, not a claim that the buyer has seen the cards. */
export function collectKnownProducts(calls: Array<{ name: string; payload?: RecordValue }>,
  prefetch?: ExactMentionPrefetch | null): KnownProductContext | undefined {
  let current = contextFromPrefetch(prefetch);
  const identities = new Set(current?.product_ids ?? []);
  for (const { name, payload } of calls) {
    const discovery = name === 'get_product' || name === 'search_products' || name === 'semantic_select_products';
    if (!discovery || !payload) continue;
    const successful = payload.status === 'ok' || payload.status === 'found' || payload.status === 'ambiguous';
    if (!successful) continue;
    if (typeof payload.source_revision !== 'string' || !payload.source_revision) throw new Error('Catalog discovery revision is missing');
    let ids: unknown[] = [];
    if (name === 'get_product') {
      if (payload.status === 'ambiguous' && (!Array.isArray(payload.candidates) || !payload.candidates.length)) {
        throw new Error('Ambiguous catalog identities are missing');
      }
      const products = payload.status === 'found' ? [payload] : payload.status === 'ambiguous' && Array.isArray(payload.candidates)
        ? payload.candidates : [];
      ids = products.map(item => object(item)?.product_id);
    } else if (name === 'search_products' && payload.status === 'ok') {
      if (!Array.isArray(payload.items)) throw new Error('Catalog search identities are missing');
      ids = payload.items.map(item => object(item)?.product_id);
    } else if (name === 'semantic_select_products' && payload.status === 'ok') {
      if (!Array.isArray(payload.candidate_ids)) throw new Error('Semantic candidate identities are missing');
      if (payload.candidate_count !== payload.candidate_ids.length || new Set(payload.candidate_ids).size !== payload.candidate_ids.length) {
        throw new Error('Semantic candidate identities are incomplete or duplicated');
      }
      ids = payload.candidate_ids;
    }
    if (!ids.every(productId) || new Set(ids).size !== ids.length) throw new Error('Catalog discovery contains invalid or duplicate product identities');
    if (!ids.length) continue;
    const revision = payload.source_revision;
    if (current && current.source_revision !== revision) throw new Error('Known product revisions differ');
    ids.forEach(id => identities.add(id));
    current = { source_revision: revision, product_ids: [...identities] };
  }
  for (const context of fullBatchContexts(calls)) {
    if (current && current.source_revision !== context.source_revision) throw new Error('Known product revisions differ');
    context.product_ids.forEach(id => identities.add(id));
    current = { source_revision: context.source_revision, product_ids: [...identities] };
  }
  return current;
}

export function modelProductContext(prefetch: ExactMentionPrefetch) {
  if (prefetch.completeness === 'full_read_required') throw new Error('Known products have not been fully read');
  const products = prefetch.items.map(item => {
    const original = object(item.original_card);
    if (!original) return item;
    const product = { ...item };
    const aliases = { attributes: 'характеристики', description: 'описание', documents: 'документы', brand: 'бренд' };
    for (const [alias, field] of Object.entries(aliases)) {
      if (Object.hasOwn(original, field) && JSON.stringify(product[alias]) === JSON.stringify(original[field])) delete product[alias];
    }
    return product;
  });
  return { source_revision: prefetch.source_revision, completeness: 'full',
    product_ids: prefetch.items.map(item => item.product_id), products,
    ...(prefetch.groups ? { groups: prefetch.groups } : {}) };
}
