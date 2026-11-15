import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { acceptCatalogReview, catalogUpdateSchema, readCatalogReviewState, reusableCatalogReview, reviewContext, reviewDigest, reviewSources } from '../src/ai/catalogReviewState.js';
import type { SearchReceipt } from '../src/ai/controlledWebSearch.js';
import type { Message } from '../src/shared/types.js';

const prefetch = { source_revision: 'snapshot', completeness: 'full' as const,
  items: ['a', 'b', 'c'].map(product_id => ({ product_id, name: `Model ${product_id}`, attributes: {},
    description: product_id, documents: [], original_card: { exact_variant: product_id } })) };
const context = reviewContext(['a', 'b', 'c'], prefetch, 'Задача', []);
const receipt = (responseId: string): SearchReceipt => ({ responseId, status: 'ok', model: 'model', usage: null,
  toolFees: null, monetaryCost: null, costStatus: 'unknown', findings: `Facts ${responseId}`, sources: [] });
const initial = () => acceptCatalogReview(JSON.stringify({ answer: 'Предварительный вывод', candidate_decisions: {
  a: { product_name: 'Model a', basis: 'Карточка a', decision: 'selected' },
  b: { product_name: 'Model b', basis: 'Карточка b', decision: 'rejected' },
  c: { product_name: 'Model c', basis: 'Не хватает сведений c', decision: 'uncertain' }
} }), context, [], 'resp_initial').state;
const patch = (base = initial(), candidate_updates: unknown[] = [], sources = reviewSources([receipt('source1')])) => ({
  base_digest: base.digest, source_review: Object.fromEntries(sources.map(s => [s.response_id, 'Проверена применимость к точному исполнению'])),
  candidate_updates, answer: 'Вывод по всему набору', selection_snapshots: [], availability: null
});

describe('durable model catalog decisions', () => {
  it('preserves the exact basis text including surrounding whitespace when validating its digest', () => {
    const candidate_decisions = Object.fromEntries(Object.entries(initial().decisions).map(([id, decision]) =>
      [id, { product_name: decision.product_name, basis: ` ${decision.basis}\n`, decision: decision.decision }]));
    const { state } = acceptCatalogReview(JSON.stringify({ answer: 'Вывод', candidate_decisions }), context, [], 'resp');
    expect(state.decisions.a.basis).toBe(' Карточка a\n');
    expect(readCatalogReviewState(JSON.parse(JSON.stringify(state)))).toEqual(state);
  });
  it('lets the model revise selected and rejected IDs, retain all other bases, then revise again or change nothing', () => {
    const base = initial(); const before = structuredClone(base);
    const sources = reviewSources([receipt('source1')]);
    const changed = acceptCatalogReview(JSON.stringify(patch(base, [
      { product_id: 'a', product_name: 'Model a', basis: 'Документ: другое исполнение', decision: 'rejected' },
      { product_id: 'b', product_name: 'Model b', basis: 'Документ: подходит', decision: 'selected' }
    ])), context, sources, 'resp_second', base);
    expect(JSON.parse(changed.answer)).toMatchObject({ selected: ['b'], rejected: ['a'], uncertain: ['c'] });
    expect(changed.state.decisions.c).toEqual(base.decisions.c);
    expect(changed.state.decisions.b).toMatchObject({ response_id: 'resp_second', considered_source_ids: ['source1'] });
    expect(base).toEqual(before);
    const more = reviewSources([receipt('source1'), receipt('source2')]);
    const third = acceptCatalogReview(JSON.stringify(patch(changed.state, [
      { product_id: 'c', product_name: 'Model c', basis: 'Новый документ c', decision: 'selected' }
    ], more)), context, more, 'resp_third', changed.state);
    const unchanged = acceptCatalogReview(JSON.stringify(patch(third.state, [], more)), context, more, 'resp_fourth', third.state);
    expect(JSON.parse(unchanged.answer).selected).toEqual(['b', 'c']);
    expect(unchanged.state.decisions).toEqual(third.state.decisions);
    expect(Object.keys(unchanged.state.decisions)).toEqual(['a', 'b', 'c']);
    expect(catalogUpdateSchema(base).properties.candidate_updates.items.properties.product_id.enum).toEqual(['a', 'b', 'c']);
  });

  it.each([
    ['foreign ID', { product_id: 'foreign', product_name: 'Model a', basis: 'Reason', decision: 'selected' }],
    ['wrong exact variant', { product_id: 'a', product_name: 'Model b', basis: 'Reason', decision: 'selected' }],
    ['empty basis', { product_id: 'a', product_name: 'Model a', basis: ' ', decision: 'selected' }],
    ['invalid decision', { product_id: 'a', product_name: 'Model a', basis: 'Reason', decision: 'maybe' }]
  ])('rejects %s without changing the base', (_label, update) => {
    const base = initial(); const before = structuredClone(base);
    expect(() => acceptCatalogReview(JSON.stringify(patch(base, [update])), context, reviewSources([receipt('source1')]), 'resp', base)).toThrow();
    expect(base).toEqual(before);
  });

  it('rejects duplicate IDs, wrong base, incomplete source assessment and competing full classifications', () => {
    const base = initial(); const sources = reviewSources([receipt('source1')]);
    const update = { product_id: 'a', product_name: 'Model a', basis: 'Reason', decision: 'selected' };
    for (const value of [patch(base, [update, update]), { ...patch(base), base_digest: 'other' },
      { ...patch(base), source_review: {} }, { ...patch(base), source_review: { source1: ' ' } },
      { ...patch(base), selected: ['a'] }, { ...patch(base), candidate_decisions: {} }]) {
      expect(() => acceptCatalogReview(JSON.stringify(value), context, sources, 'resp', base)).toThrow();
    }
  });

  it('survives JSONB key reordering, rejects tampering and missing decisions, and never mutates inputs', () => {
    const base = initial(); const before = structuredClone(base);
    const reordered = JSON.parse(JSON.stringify(base, (_key, value) => value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).reverse()) : value));
    expect(readCatalogReviewState(reordered)).toEqual(base);
    const tampered = structuredClone(base); tampered.decisions.a.basis = 'Substitution';
    expect(() => readCatalogReviewState(tampered)).toThrow('integrity');
    delete tampered.decisions.a;
    const { digest: _digest, ...body } = tampered;
    tampered.digest = reviewDigest(body);
    expect(() => readCatalogReviewState(tampered)).toThrow('integrity');
    const result = acceptCatalogReview(JSON.stringify(patch(base)), context, reviewSources([receipt('source1')]), 'resp', base);
    result.state.context.candidates.a.name = 'Mutated result';
    expect(base).toEqual(before);
    expect(context.candidates.a.name).toBe('Model a');
  });

  it('invalidates old decisions after changed conditions, history, displayed products, IDs, cards or snapshot', () => {
    const base = initial();
    const history: Message[] = [{ id: 'm', sessionId: 's', createdAt: '2026-11-15T00:00:00Z', role: 'assistant', content: 'Эти варианты', metadata: { productCards: [{ id: 'a' }] } }];
    const withHistory = { ...context, scope_digest: reviewContext(['a', 'b', 'c'], prefetch, 'Задача', history).scope_digest };
    for (const changed of [reviewContext(['a', 'b', 'c'], prefetch, 'Другая задача', []), withHistory,
      reviewContext(['a', 'b'], prefetch, 'Задача', []),
      reviewContext(['a', 'b', 'c'], { ...prefetch, source_revision: 'new' }, 'Задача', []),
      reviewContext(['a', 'b', 'c'], { ...prefetch, items: prefetch.items.map(item => ({ ...item, original_card: { exact_variant: 'new' } })) }, 'Задача', [])]) {
      expect(reusableCatalogReview(base, changed, [])).toBeUndefined();
    }
    const otherHistory = structuredClone(history); otherHistory[0].metadata.productCards = [{ id: 'b' }] as never;
    expect(reviewContext(['a', 'b', 'c'], prefetch, 'Задача', otherHistory).scope_digest).not.toBe(withHistory.scope_digest);
    const extraOriginal = { ...prefetch, items: [...prefetch.items, { ...prefetch.items[0], product_id: 'reference-model' }] };
    expect(reusableCatalogReview(base, reviewContext(['a', 'b', 'c'], extraOriginal, 'Задача', []), [])).toBeUndefined();
  });

  it('accepts added sources but invalidates missing or replaced sources, including same response ID', () => {
    const sources = reviewSources([receipt('source1')]);
    const base = acceptCatalogReview(JSON.stringify(patch()), context, sources, 'resp', initial()).state;
    expect(reusableCatalogReview(base, context, reviewSources([receipt('source1'), receipt('source2')]))).toEqual(base);
    expect(reusableCatalogReview(base, context, [])).toBeUndefined();
    expect(reusableCatalogReview(base, context, reviewSources([{ ...receipt('source1'), findings: 'Changed facts' }]))).toBeUndefined();
    expect(() => reviewSources([receipt('same'), receipt('same')])).toThrow('Duplicate');
  });

  it('replays the saved 132-candidate audit into all 34 expected IDs with two model-specified updates', () => {
    const fixture = JSON.parse(readFileSync(new URL('./fixtures/catalog-review-132.json', import.meta.url), 'utf8'));
    const cards = { source_revision: 'saved-audit', completeness: 'full' as const, items: fixture.candidates.map((row: any) => ({
      product_id: row.id, name: row.name, attributes: { facts: row.facts }, description: '', documents: [], original_card: row
    })) };
    const ids = cards.items.map((item: any) => item.product_id);
    const ctx = reviewContext(ids, cards, 'Инверторные генераторы, номинал 3–4 кВт', []);
    let saved = acceptCatalogReview(JSON.stringify({ candidate_decisions: fixture.initial_decisions, answer: 'Первичная оценка' }), ctx, [], 'initial').state;
    const initialState = structuredClone(saved);
    const updates = [
      { product_id: '1a782d50f008ce5591d7a338', basis: 'Текущее исполнение 060048: номинал 4,2 кВт; конфликт со старым названием 3,8 кВт.', decision: 'rejected' },
      { product_id: 'f43f3db8231055a464b61c9f', basis: 'Исполнение 060038: номинал 3,0 кВт по совместной проверке источников.', decision: 'selected' }
    ].map(update => ({ ...update, product_name: fixture.initial_decisions[update.product_id].product_name }));
    for (const [index, update] of updates.entries()) {
      const sources = reviewSources(Array.from({ length: index + 1 }, (_, i) => receipt(`source${i}`)));
      saved = acceptCatalogReview(JSON.stringify(patch(saved, [update], sources)), ctx, sources, `review${index}`, saved).state;
      saved = readCatalogReviewState(JSON.parse(JSON.stringify(saved)));
    }
    const selected = Object.keys(saved.decisions).filter(id => saved.decisions[id].decision === 'selected');
    expect(selected.sort()).toEqual([...fixture.expected_selected].sort());
    expect(Object.keys(saved.decisions)).toHaveLength(132);
    for (const id of ids.filter((id: string) => !updates.some(update => update.product_id === id))) {
      expect(saved.decisions[id]).toEqual(initialState.decisions[id]);
    }
    expect(Object.values(saved.decisions).every(item => item.basis.trim().length > 0)).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(updates))).toBeLessThan(Buffer.byteLength(JSON.stringify(fixture.initial_decisions)));
  });
});
