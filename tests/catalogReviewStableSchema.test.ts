import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { acceptCatalogReview, catalogUpdateSchema, readCatalogReviewState, reviewDigest } from '../src/ai/catalogReviewState.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/catalog-review-v1-plan.json', import.meta.url), 'utf8'));
const { context, sources, base } = fixture.plan.review;
const ids = context.candidate_ids;
const patch = () => ({ ...structuredClone(fixture.answer), source_review: [{ response_id: sources[0].response_id, assessment: 'Exact variant checked' }] });
const apply = (answer: unknown, state = base, currentSources = sources) => acceptCatalogReview(JSON.stringify(answer), context, currentSources, 'resp_v2', state, 'identity_updates_v2');

describe('stable catalog continuation contract v2', () => {
  it('keeps the schema identical when both base digest and source set change', () => {
    const first = apply(patch()).state;
    const moreSources = [...sources, { response_id: 'new_source', digest: 'new_source_digest' }];
    const second = apply({ ...patch(), base_digest: first.digest, candidate_updates: [], source_review: [
      { response_id: 'new_source', assessment: 'New source checked' }, ...patch().source_review
    ] }, first, moreSources).state;
    expect(second.digest).not.toBe(base.digest);
    expect(second.sources).toHaveLength(2);
    expect(catalogUpdateSchema(second)).toEqual(catalogUpdateSchema(base));
    expect(catalogUpdateSchema(second).properties.base_digest).not.toHaveProperty('enum');
    expect(catalogUpdateSchema(second).properties.candidate_updates.items.properties.product_id.enum).toEqual(ids);
  });

  it.each([
    ['foreign digest', () => ({ ...patch(), base_digest: 'foreign' })],
    ['missing digest', () => { const p: any = patch(); delete p.base_digest; return p; }],
    ['unknown source', () => ({ ...patch(), source_review: [{ response_id: 'other', assessment: 'Applies' }] })],
    ['duplicate source', () => ({ ...patch(), source_review: [...patch().source_review, ...patch().source_review] })],
    ['missing source', () => ({ ...patch(), source_review: [] })],
    ['missing source field', () => { const p: any = patch(); delete p.source_review; return p; }],
    ['missing source ID', () => ({ ...patch(), source_review: [{ assessment: 'Applies' }] })],
    ['empty source assessment', () => ({ ...patch(), source_review: [{ response_id: sources[0].response_id, assessment: ' ' }] })],
    ['unknown source field', () => ({ ...patch(), source_review: [{ ...patch().source_review[0], extra: 'Ignored?' }] })],
    ['duplicate product', () => ({ ...patch(), candidate_updates: [...patch().candidate_updates, ...patch().candidate_updates] })],
    ['unknown product', () => ({ ...patch(), candidate_updates: [{ ...patch().candidate_updates[0], product_id: 'foreign' }] })],
    ['wrong exact variant', () => ({ ...patch(), candidate_updates: [{ ...patch().candidate_updates[0], product_name: 'Other variant' }] })],
    ['empty basis', () => ({ ...patch(), candidate_updates: [{ ...patch().candidate_updates[0], basis: '' }] })],
    ['missing updates', () => { const p: any = patch(); delete p.candidate_updates; return p; }],
    ['legacy source map', () => structuredClone(fixture.answer)]
  ])('rejects %s without mutating the old state', (_label, make) => {
    const before = structuredClone(base);
    expect(() => apply(make())).toThrow();
    expect(base).toEqual(before);
  });

  it('rejects an outdated digest, incomplete state and unsupported explicit versions', () => {
    const current = apply(patch()).state;
    expect(() => apply(patch(), current)).toThrow('base');
    const incomplete = structuredClone(base); delete incomplete.decisions[ids[0]];
    const { digest: _digest, ...body } = incomplete; incomplete.digest = reviewDigest(body);
    expect(() => apply({ ...patch(), base_digest: incomplete.digest }, incomplete)).toThrow('integrity');
    expect(() => acceptCatalogReview(JSON.stringify(patch()), context, sources, 'resp', base, 'future_version')).toThrow();
    expect(() => acceptCatalogReview(JSON.stringify(patch()), context, sources, 'resp', base, 'identity_updates_v1')).toThrow();
    expect(() => acceptCatalogReview(JSON.stringify(fixture.answer), context, sources, 'resp', base, 'identity_updates_v1')).not.toThrow();
  });

  it('handles every candidate, arbitrary prior decisions, no changes and JSONB reordering', () => {
    const updates = ids.map((id: string, i: number) => ({ product_id: id, product_name: base.decisions[id].product_name,
      basis: `New exact basis ${i}`, decision: i === 0 ? 'rejected' : 'selected' }));
    const result = apply({ ...patch(), candidate_updates: updates });
    expect(JSON.parse(result.answer)).toMatchObject({ selected: ids.slice(1), rejected: [ids[0]], uncertain: [] });
    const saved = JSON.parse(JSON.stringify(result.state, (_key, value) => value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).reverse()) : value));
    const restored = readCatalogReviewState(saved);
    const unchanged = apply({ ...patch(), base_digest: restored.digest, candidate_updates: [] }, restored);
    expect(unchanged.state.decisions).toEqual(result.state.decisions);
    expect(JSON.parse(unchanged.answer).selected).toEqual(ids.slice(1));
    const reversed = apply({ ...patch(), base_digest: restored.digest, candidate_updates: [{ ...updates[0], decision: 'selected' }] }, restored);
    expect(JSON.parse(reversed.answer).selected).toEqual(ids);
  });

  it('requires exactly all source assessments in any array order and allows no sources', () => {
    const more = [...sources, { response_id: 'second', digest: 'second' }];
    expect(() => apply(patch(), base, more)).toThrow('incomplete');
    const result = apply({ ...patch(), source_review: [{ response_id: 'second', assessment: 'Second' }, ...patch().source_review] }, base, more);
    expect(Object.keys(result.state.source_review)).toHaveLength(2);
    const noSources = apply({ ...patch(), source_review: [] }, base, []);
    expect(noSources.state.source_review).toEqual({});
    const saved = apply(patch()).state;
    expect(() => apply({ ...patch(), base_digest: saved.digest }, saved, [{ ...sources[0], digest: 'changed' }])).toThrow('base');
    expect(() => apply({ ...patch(), base_digest: saved.digest, source_review: [] }, saved, [])).toThrow('base');
  });
});
