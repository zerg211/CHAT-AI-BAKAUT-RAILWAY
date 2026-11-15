import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message } from '../src/shared/types.js';
import { buildLeadProductReferences, normalizeLeadProductReferences } from '../src/ai/leadProductReferences.js';

const ids = ['a'.repeat(24), 'b'.repeat(24)];
const sessionId = randomUUID(), requestId = randomUUID();
const url = 'https://bakautprof.ru/catalog/vibroplity/saved-model/';
let messageNumber = 0;
function message(metadata: Message['metadata'] = {}): Message {
  return { id: randomUUID(), sessionId, role: 'assistant', content: 'Сохранённые карточки',
    createdAt: new Date(Date.UTC(2026, 10, 15) + messageNumber++ * 1000).toISOString(), metadata: {
    runtimeMode: 'openai_responses_saved_agent', catalogRevision: 'historical-v1',
    knownProducts: { source_revision: 'historical-v1', product_ids: ids },
    productCards: ids.map((id, index) => ({ id, name: `Модель 🛠 ${index}`, sourceUrl: `${url}${index}/` })), ...metadata } };
}
function resolve(messages: Message[], productIds = ids) {
  return buildLeadProductReferences({ messages, requestId, productIds });
}

beforeEach(() => { messageNumber = 0; vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Network forbidden'); })); });
afterEach(() => { expect(fetch).not.toHaveBeenCalled(); vi.unstubAllGlobals(); });

describe('saved lead product references', () => {
  it('retains several identities, Unicode names, exact links and per-card historical provenance', () => {
    const source = message();
    expect(resolve([source])).toEqual(ids.map((productId, index) => ({ productId, status: 'saved_card',
      name: `Модель 🛠 ${index}`, sourceUrl: `${url}${index}/`, sourceMessageId: source.id, catalogRevision: 'historical-v1' })));
  });

  it('anchors to first saved request occurrence and never substitutes later catalog versions', () => {
    const before = message(), offered = message({ productCards: [], availabilityRequest: { id: requestId } });
    const later = message({ catalogRevision: 'new-v2', knownProducts: { source_revision: 'new-v2', product_ids: ids },
      availabilityRequest: { id: requestId }, productCards: ids.map(id => ({ id, name: 'NEW MODEL', sourceUrl: url })) });
    expect(resolve([before, offered, later])).toEqual(resolve([before, offered]));
    expect(resolve([before, offered, later])[0]).toMatchObject({ sourceMessageId: before.id, catalogRevision: 'historical-v1' });
    expect(JSON.stringify(resolve([before, offered, later]))).not.toContain('NEW MODEL');
  });

  it('accepts a card saved on the first request message and does not inspect suitability', () => {
    const source = message({ availabilityRequest: { id: requestId },
      productCards: [{ id: ids[0], name: 'Проверяемая модель', sourceUrl: url, matchStatus: 'uncertain' }] });
    expect(resolve([source], [ids[0]])[0]).toMatchObject({ status: 'saved_card', name: 'Проверяемая модель' });
  });

  it('does not guess between source messages tied by timestamp', () => {
    const first = message(), second = { ...message(), createdAt: first.createdAt };
    for (const history of [[first, second], [second, first]]) expect(resolve(history)[0])
      .toEqual({ productId: ids[0], status: 'unavailable', reason: 'ambiguous_card' });
  });

  it('does not guess whether a separate card tied with the request came before it', () => {
    const old = message(), card = message();
    const offered = { ...message({ productCards: [], availabilityRequest: { id: requestId } }), createdAt: card.createdAt };
    for (const history of [[card, offered], [offered, card], [old, card, offered], [old, offered, card]]) {
      expect(resolve(history)[0]).toMatchObject({ status: 'unavailable', reason: 'ambiguous_card' });
    }
  });

  it('keeps the atomic card on the unique request message despite separate tied cards', () => {
    const offered = message({ availabilityRequest: { id: requestId } });
    const separate = { ...message(), createdAt: offered.createdAt };
    for (const history of [[offered, separate], [separate, offered]]) expect(resolve(history)[0])
      .toMatchObject({ status: 'saved_card', sourceMessageId: offered.id });
  });

  it('does not choose an anchor arbitrarily when request messages share one timestamp', () => {
    const first = message({ availabilityRequest: { id: requestId } });
    const second = { ...message({ availabilityRequest: { id: requestId } }), createdAt: first.createdAt };
    for (const history of [[first, second], [second, first]]) expect(resolve(history))
      .toEqual(ids.map(productId => ({ productId, status: 'unavailable', reason: 'ambiguous_card' })));
  });

  it('leaves missing and foreign cards unavailable while retaining every requested ID', () => {
    expect(resolve([message({ productCards: [{ id: 'c'.repeat(24), name: 'Foreign model', sourceUrl: url }] })]))
      .toEqual(ids.map(productId => ({ productId, status: 'unavailable', reason: 'missing_card' })));
    expect(resolve([{ ...message(), role: 'user' }])).toEqual(resolve([]));
  });

  it('does not choose between duplicate cards or fall back to an older name', () => {
    const ambiguous = message({ productCards: [{ id: ids[0], name: 'A' }, { id: ids[0], name: 'B' }] });
    expect(resolve([message(), ambiguous])[0]).toEqual({ productId: ids[0], status: 'unavailable', reason: 'ambiguous_card' });
  });

  it.each([
    { catalogRevision: undefined }, { catalogRevision: 'wrong-version' }, { knownProducts: undefined },
    { knownProducts: { source_revision: 'historical-v1', product_ids: ['c'.repeat(24)] } }, { runtimeMode: 'unknown' }
  ])('rejects unverified snapshot provenance %j', metadata => {
    expect(resolve([message(), message(metadata)])[0]).toEqual({ productId: ids[0], status: 'unavailable', reason: 'unverified_card' });
  });

  it('requires a saved message identity and does not fall back after malformed metadata', () => {
    expect(resolve([{ ...message(), id: 'not-a-message-id' }])[0]).toMatchObject({ status: 'unavailable', reason: 'unverified_card' });
  });

  it.each(['javascript:alert(1)', 'http://bakautprof.ru/catalog/model/', 'https://evil.example/catalog/model/',
    'https://bakautprof.ru.evil.example/catalog/model/', 'https://user:password@bakautprof.ru/catalog/model/',
    'https://bakautprof.ru:8443/catalog/model/', 'https://bakautprof.ru/catalog/model/?token=private',
    'https://bakautprof.ru/catalog/model/#secret', 'https://bakautprof.ru/contacts/',
    'https://bakautprof.ru/catalog/model/\nspoof', 'https://bakautprof.ru/catalog/../contacts/',
    'https://bakautprof.ru/catalog/model/\u0085spoof', 'https://bakautprof.ru/catalog/model/\u2028spoof',
    'https://bakautprof.ru/catalog/model/\u2029spoof'])('omits unsafe URL %s without dropping the name or ID', sourceUrl => {
    const result = resolve([message({ productCards: [{ id: ids[0], name: 'Верное название 🛠', sourceUrl }] })]);
    expect(result[0]).toMatchObject({ productId: ids[0], status: 'saved_card', name: 'Верное название 🛠', sourceUrl: null });
  });

  it.each([undefined, '', 'spoof\nID: other', '🛠'.repeat(501), 'name\u0085ID: other', 'name\u2028ID: other',
    'name\u2029ID: other'])('does not invent or truncate missing/invalid name %j', name => {
    expect(resolve([message({ productCards: [{ id: ids[0], name, sourceUrl: url }] })])[0])
      .toMatchObject({ status: 'saved_card', productId: ids[0], name: null, sourceUrl: url });
  });

  it('preserves the full500-code-point Unicode name', () => {
    const name = 'Я'.repeat(250) + '🛠'.repeat(250);
    expect(resolve([message({ productCards: [{ id: ids[0], name, sourceUrl: url }] })])[0]).toMatchObject({ name });
  });

  it('distinguishes absent legacy references from explicit unavailable new references', () => {
    expect(normalizeLeadProductReferences(undefined, ids)).toBeUndefined();
    expect(normalizeLeadProductReferences(null, ids)).toEqual(ids.map(productId => ({ productId, status: 'unavailable', reason: 'invalid_reference' })));
    expect(normalizeLeadProductReferences(resolve([]), ids)).toEqual(resolve([]));
  });

  it('validates stored references by exact ID, rejects duplicates, and drops unsafe fields', () => {
    const saved = resolve([message()]);
    expect(normalizeLeadProductReferences([saved[0], saved[0]], ids)).toEqual([
      { productId: ids[0], status: 'unavailable', reason: 'ambiguous_card' },
      { productId: ids[1], status: 'unavailable', reason: 'invalid_reference' }
    ]);
    expect(normalizeLeadProductReferences([{ ...saved[0], sourceUrl: 'javascript:bad' }], [ids[0]])?.[0])
      .toMatchObject({ productId: ids[0], name: 'Модель 🛠 0', sourceUrl: null });
  });

  it('restores explicit null fields after PostgreSQL JSONB strips null object keys', () => {
    const stored = { productId: ids[0], status: 'saved_card', sourceMessageId: randomUUID(), catalogRevision: 'historical-v1' };
    expect(normalizeLeadProductReferences([stored], [ids[0]]))
      .toEqual([{ ...stored, name: null, sourceUrl: null }]);
  });
});
