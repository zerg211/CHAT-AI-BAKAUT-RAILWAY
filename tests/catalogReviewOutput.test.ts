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
});
