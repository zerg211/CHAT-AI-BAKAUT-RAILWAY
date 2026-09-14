import { describe, expect, it } from 'vitest';
import type { AnswerContract, ToolResult } from '../src/ai/agentManagerContracts.js';
import { answerEvidenceItemsForModel, resolveAnswerEvidenceBindings } from '../src/ai/answerEvidenceBindings.js';

const research: ToolResult = {
  requestId: 'research', tool: 'web.researchProductFacts', status: 'ok', warnings: [],
  payload: {
    products: [{ id: 'stale', name: 'Fubag BS 8000', specs: { weight_kg: 89.2 } }],
    facts: [{ productName: 'Fubag BS 8000', attribute: 'noise_value', value: '84 dB', evidence: 'Уровень шума, дб 84',
      sourceType: 'web', evidenceVerifiedExact: true }],
    answerGuidance: { coverage: [{ productName: 'Fubag BS 8000', attribute: 'weight_net_kg', status: 'not_confirmed', value: 'Масса нетто не указана', evidence: 'Вес, кг 93.5 — без обозначения массы нетто', evidenceVerifiedExact: true }] }
  }
};

function answer(fact: AnswerContract['factsUsed'][number]): AnswerContract {
  return { answerText: 'x', factsUsed: [fact], questionsAsked: [], toolResultIds: ['research'],
    leadAction: 'none', riskFlags: [] };
}

describe('claim-level answer evidence bindings', () => {
  it('does not expose nested stale catalog context as web evidence', () => {
    const resolution = resolveAnswerEvidenceBindings({
      answer: answer({ factKey: 'weight', sourceEventIds: ['research'], evidenceItemIds: ['research:product:stale:spec:weight_kg'],
        productName: 'Fubag BS 8000', attribute: 'weight_kg', claimKind: 'confirmed_value', value: 89.2 }),
      toolResults: [research]
    });
    expect(resolution.issues.map((issue) => issue.code)).toContain('numeric_fact_evidence_binding_unknown');
  });

  it('rejects a changed number even with the same request id and evidence item', () => {
    const resolution = resolveAnswerEvidenceBindings({
      answer: answer({ factKey: 'noise', sourceEventIds: ['research'], evidenceItemIds: ['research:fact:0'],
        productName: 'Fubag BS 8000', attribute: 'noise_value', claimKind: 'confirmed_value', value: '88.1 dB' }),
      toolResults: [research]
    });
    expect(resolution.issues.map((issue) => issue.code)).toContain('numeric_fact_value_not_in_bound_evidence');
  });

  it('matches complete numeric tokens rather than substrings', () => {
    const changed = structuredClone(research);
    (changed.payload.facts as Array<Record<string, unknown>>)[0]!.value = '184 dB';
    (changed.payload.facts as Array<Record<string, unknown>>)[0]!.evidence = 'Уровень шума, дб 184';
    const resolution = resolveAnswerEvidenceBindings({
      answer: answer({ factKey: 'noise', sourceEventIds: ['research'], evidenceItemIds: ['research:fact:0'],
        productName: 'Fubag BS 8000', attribute: 'noise_value', claimKind: 'confirmed_value', value: '84 dB' }),
      toolResults: [changed]
    });
    expect(resolution.issues.map((issue) => issue.code)).toContain('numeric_fact_value_not_in_bound_evidence');
  });

  it('preserves leading-zero and long integer identifiers exactly', () => {
    const changed = structuredClone(research);
    (changed.payload.facts as Array<Record<string, unknown>>)[0]!.value = 'SKU 064109112345678901';
    (changed.payload.facts as Array<Record<string, unknown>>)[0]!.evidence = 'SKU 064109112345678901';
    const resolution = resolveAnswerEvidenceBindings({
      answer: answer({ factKey: 'sku', sourceEventIds: ['research'], evidenceItemIds: ['research:fact:0'],
        productName: 'Fubag BS 8000', attribute: 'noise_value', claimKind: 'confirmed_value', value: 'SKU 64109112345678901' }),
      toolResults: [changed]
    });
    expect(resolution.issues.map((issue) => issue.code)).toContain('numeric_fact_value_not_in_bound_evidence');
  });

  it('binds an exact confirmed value and preserves its evidence path', () => {
    const resolution = resolveAnswerEvidenceBindings({
      answer: answer({ factKey: 'noise', sourceEventIds: ['research'], evidenceItemIds: ['research:fact:0'],
        productName: 'Fubag BS 8000', attribute: 'noise_value', claimKind: 'confirmed_value', value: '84 dB' }),
      toolResults: [research]
    });
    expect(resolution.issues).toEqual([]);
    expect(resolution.bindings[0]).toMatchObject({ evidenceItemId: 'research:fact:0', evidencePath: 'payload.facts[0]' });
  });

  it('allows a source label but not a confirmed net value from not-confirmed coverage', () => {
    const base = { factKey: 'weight-label', sourceEventIds: ['research'], evidenceItemIds: ['research:coverage:0'],
      productName: 'Fubag BS 8000', attribute: 'weight_net_kg', value: '93.5 kg' };
    expect(resolveAnswerEvidenceBindings({ answer: answer({ ...base, claimKind: 'source_label' }), toolResults: [research] }).issues).toEqual([]);
    expect(resolveAnswerEvidenceBindings({ answer: answer({ ...base, claimKind: 'confirmed_value' }), toolResults: [research] }).issues
      .map((issue) => issue.code)).toContain('unconfirmed_evidence_used_as_confirmed_value');
  });

  it('does not let a null or related-model name bypass product scope', () => {
    for (const productName of [null, 'Fubag BS 8000 A ES']) {
      const resolution = resolveAnswerEvidenceBindings({
        answer: answer({ factKey: 'noise', sourceEventIds: ['research'], evidenceItemIds: ['research:fact:0'],
          productName, attribute: 'noise_value', claimKind: 'confirmed_value', value: '84 dB' }),
        toolResults: [research]
      });
      expect(resolution.issues.map((issue) => issue.code)).toContain('fact_evidence_product_mismatch');
    }
  });

  it('excludes unverified web facts and requires page text to be presented as a source label', () => {
    const unverified = structuredClone(research);
    delete (unverified.payload.facts as Array<Record<string, unknown>>)[0]!.evidenceVerifiedExact;
    expect(resolveAnswerEvidenceBindings({
      answer: answer({ factKey: 'noise', sourceEventIds: ['research'], evidenceItemIds: ['research:fact:0'],
        productName: 'Fubag BS 8000', attribute: 'noise_value', claimKind: 'confirmed_value', value: '84 dB' }),
      toolResults: [unverified]
    }).issues.map((issue) => issue.code)).toContain('numeric_fact_evidence_binding_unknown');

    const page: ToolResult = { requestId: 'page', tool: 'site.readFirstPartyPage', status: 'ok', warnings: [],
      payload: { title: 'Купить генератор выгодно', productIdentity: { title: 'Fubag BS 8000' }, text: 'Вес, кг 93.5' } };
    const base = { factKey: 'weight-label', sourceEventIds: ['page'], evidenceItemIds: ['page:page:text:0'],
      productName: 'Fubag BS 8000', attribute: 'page_text', value: '93.5 kg' };
    expect(resolveAnswerEvidenceBindings({ answer: answer({ ...base, claimKind: 'confirmed_value' }), toolResults: [page] })
      .issues.map((issue) => issue.code)).toContain('unconfirmed_evidence_used_as_confirmed_value');
    expect(resolveAnswerEvidenceBindings({ answer: answer({ ...base, claimKind: 'source_label' }), toolResults: [page] })
      .issues).toEqual([]);

    const unverifiedCoverage = structuredClone(research);
    const unverifiedGuidance = unverifiedCoverage.payload.answerGuidance as { coverage: Array<Record<string, unknown>> };
    delete unverifiedGuidance.coverage[0]!.evidenceVerifiedExact;
    expect(resolveAnswerEvidenceBindings({
      answer: answer({ factKey: 'weight-label', sourceEventIds: ['research'], evidenceItemIds: ['research:coverage:0'],
        productName: 'Fubag BS 8000', attribute: 'weight_net_kg', claimKind: 'source_label', value: '93.5 kg' }),
      toolResults: [unverifiedCoverage]
    }).issues.map((issue) => issue.code)).toContain('numeric_source_label_evidence_unverified');
  });

  it('prioritizes validated research and bounds writer evidence previews', () => {
    const catalog: ToolResult = { requestId: 'catalog', tool: 'catalog.search', status: 'ok', warnings: [], payload: {
      products: Array.from({ length: 50 }, (_, index) => ({ id: `p${index}`, name: `P${index}`,
        specs: { [`spec_${index}`]: 'x'.repeat(1000), another: index } }))
    } };
    const hints = answerEvidenceItemsForModel([catalog, research], 5);
    expect(hints[0]?.id).toBe('research:fact:0');
    expect(hints).toHaveLength(5);
    expect(hints.every((item) => item.evidence.length <= 640 && String(item.value).length <= 320)).toBe(true);
  });
});
