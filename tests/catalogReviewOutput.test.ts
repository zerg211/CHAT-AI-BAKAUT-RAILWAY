import { describe, expect, it } from 'vitest';
import { catalogReviewSchema, normalizeCatalogReview } from '../src/ai/catalogReviewOutput.js';

describe('identity-keyed catalog review', () => {
  const ids = Array.from({ length: 132 }, (_, i) => i.toString(16).padStart(24, '0'));
  const choices = Object.fromEntries(ids.map((id, index) => [id, index < 31 ? 'selected' : index < 130 ? 'rejected' : 'uncertain']));
  it('requires every candidate and preserves all model decisions without inferring suitability', () => {
    const schema = catalogReviewSchema(ids);
    expect(Object.keys(schema.properties)[0]).toBe('candidate_decisions');
    expect(schema.properties.candidate_decisions.required).toEqual(ids);
    expect(schema.properties.candidate_decisions.additionalProperties).toBe(false);
    const result = JSON.parse(normalizeCatalogReview(JSON.stringify({ answer: 'Вывод модели', candidate_decisions: choices }), ids));
    expect(result.selected).toEqual(ids.slice(0, 31));
    expect(result.rejected).toEqual(ids.slice(31, 130));
    expect(result.uncertain).toEqual(ids.slice(130));
    expect(result.answer).toBe('Вывод модели');
  });
  it.each(['missing', 'foreign', 'invalid', 'conflicting_arrays'])('rejects %s decisions without inventing a fallback', kind => {
    const candidate_decisions = { ...choices };
    if (kind === 'missing') delete candidate_decisions[ids[0]];
    if (kind === 'foreign') { delete candidate_decisions[ids[0]]; candidate_decisions.foreign = 'selected'; }
    if (kind === 'invalid') candidate_decisions[ids[0]] = 'probably';
    const text = JSON.stringify({ candidate_decisions, ...(kind === 'conflicting_arrays' ? { selected: [] } : {}) });
    expect(() => normalizeCatalogReview(text, ids)).toThrow('Incomplete catalog review');
  });
  it('binds every decision to the exact product name and a factual basis before the verdict', () => {
    const names = Object.fromEntries(ids.map((id, index) => [id, `Exact model ${index}`]));
    const assessments = Object.fromEntries(ids.map(id => [id, { product_name: names[id], basis: 'Facts from this card', decision: choices[id] }]));
    const schema = catalogReviewSchema(ids, names);
    const first = schema.properties.candidate_decisions.properties[ids[0]] as any;
    expect(first.properties.product_name.enum).toEqual(['Exact model 0']);
    expect(Object.keys(first.properties)).toEqual(['product_name', 'basis', 'decision']);
    const result = JSON.parse(normalizeCatalogReview(JSON.stringify({ answer: 'Все результаты в карточках', candidate_decisions: assessments }), ids, names));
    expect(result.selected).toEqual(ids.slice(0, 31));
    expect(result.rejected).toEqual(ids.slice(31, 130));
    expect(result.uncertain).toEqual(ids.slice(130));
    assessments[ids[0]].product_name = names[ids[1]];
    expect(() => normalizeCatalogReview(JSON.stringify({ candidate_decisions: assessments }), ids, names)).toThrow('Incomplete catalog review');
    assessments[ids[0]].product_name = names[ids[0]];
    assessments[ids[0]].basis = ' ';
    expect(() => normalizeCatalogReview(JSON.stringify({ candidate_decisions: assessments }), ids, names)).toThrow('Incomplete catalog review');
  });
});
