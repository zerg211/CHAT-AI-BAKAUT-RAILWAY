import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('adversarial acceptance case inventory', () => {
  it('defines explicit expectations without treating mocked answers as live-model results', () => {
    const suite = JSON.parse(readFileSync(new URL('./fixtures/adversarial-catalog-eval.json', import.meta.url), 'utf8'));
    expect(suite.model_quality).toBe('NOT_RUN');
    expect(suite.cases.map((item: { id: string }) => item.id)).toEqual([
      'dpu6555_narrow_trench', 'complete_modification_comparison', 'synonym_discovery', 'lossless_raw_fields',
      'multi_category', 'revision_change', 'unknown_capability', 'web_unavailable'
    ]);
    for (const item of suite.cases) {
      expect(item.question.length).toBeGreaterThan(10);
      expect(item.expected.length).toBeGreaterThanOrEqual(2);
      expect(item.evidence).toContain('tests/');
      expect(item.model_quality).toBe('NOT_RUN');
    }
  });
});
