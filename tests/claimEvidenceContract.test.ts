import { describe, expect, it } from 'vitest';
import {
  validateClaimEvidence,
  validateFactClaimAuditEvidence,
  type CustomerFacingClaim,
  type EvidenceTuple
} from '../src/ai/evidence/claimEvidenceContract.js';

function claim(overrides: Partial<CustomerFacingClaim> = {}): CustomerFacingClaim {
  return {
    id: 'claim-1',
    type: 'stock',
    text: 'Эта модель есть в наличии',
    evidenceIds: ['ev-1'],
    ...overrides
  };
}

function evidence(overrides: Partial<EvidenceTuple> = {}): EvidenceTuple {
  return {
    id: 'ev-1',
    claimType: 'stock',
    source: 'catalog',
    confidence: 0.9,
    allowedCustomerWording: 'confident',
    ...overrides
  };
}

describe('claim evidence contract', () => {
  it('blocks live stock claims when the only evidence is catalog presence', () => {
    const result = validateClaimEvidence({
      claims: [claim()],
      evidence: [evidence({ source: 'catalog' })]
    });

    expect(result.ok).toBe(false);
    expect(result.violations[0]).toMatchObject({
      claimId: 'claim-1',
      reason: 'stock_claim_requires_live_warehouse_or_manager_evidence'
    });
  });

  it('allows live stock claims with warehouse or manager evidence', () => {
    const result = validateClaimEvidence({
      claims: [claim()],
      evidence: [evidence({ source: 'warehouse' })]
    });

    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
  });

  it('blocks stale or low-confidence evidence for customer-facing claims', () => {
    const result = validateClaimEvidence({
      claims: [claim({ evidenceIds: ['stale', 'low-confidence'] })],
      evidence: [
        evidence({ id: 'stale', source: 'warehouse', confidence: 0.95, freshness: '2026-01-01T00:00:00.000Z' }),
        evidence({ id: 'low-confidence', source: 'warehouse', confidence: 0.4, freshness: '2026-06-11T10:00:00.000Z' })
      ]
    }, {
      now: new Date('2026-06-11T12:00:00.000Z'),
      maxAgeMs: 60 * 60 * 1000,
      minConfidence: 0.7
    });

    expect(result.ok).toBe(false);
    expect(result.violations.map((item) => item.reason)).toEqual(expect.arrayContaining([
      'evidence_stale',
      'evidence_confidence_too_low'
    ]));
  });

  it('blocks evidence attached to a different product or attribute', () => {
    const result = validateClaimEvidence({
      claims: [claim({ productId: 'sku-1', attribute: 'stock', evidenceIds: ['ev-1'] })],
      evidence: [evidence({ id: 'ev-1', source: 'warehouse', productId: 'sku-2', attribute: 'delivery' })]
    });

    expect(result.ok).toBe(false);
    expect(result.violations.map((item) => item.reason)).toEqual(expect.arrayContaining([
      'evidence_product_mismatch',
      'evidence_attribute_mismatch'
    ]));
  });

  it('blocks exact delivery and discount claims without operational evidence', () => {
    const result = validateClaimEvidence({
      claims: [
        claim({ id: 'delivery', type: 'delivery', text: 'Доставим завтра', evidenceIds: ['delivery-ev'] }),
        claim({ id: 'discount', type: 'discount', text: 'Сделаем скидку 10%', evidenceIds: ['discount-ev'] })
      ],
      evidence: [
        evidence({ id: 'delivery-ev', claimType: 'delivery', source: 'catalog' }),
        evidence({ id: 'discount-ev', claimType: 'discount', source: 'web' })
      ]
    });

    expect(result.ok).toBe(false);
    expect(result.violations.map((item) => item.reason)).toEqual([
      'delivery_claim_requires_logistics_or_manager_evidence',
      'discount_claim_requires_manager_evidence'
    ]);
  });

  it('blocks confident wording when evidence is explicitly limited to manager check wording', () => {
    const result = validateClaimEvidence({
      claims: [claim({ type: 'spec', text: 'Точно 5 кВт' })],
      evidence: [evidence({ claimType: 'spec', source: 'web', allowedCustomerWording: 'manager_check_required' })]
    });

    expect(result.ok).toBe(false);
    expect(result.violations[0]?.reason).toBe('claim_wording_exceeds_evidence_permission');
  });

  it('blocks mismatched evidence types instead of accepting any referenced evidence id', () => {
    const result = validateClaimEvidence({
      claims: [claim({ type: 'stock', evidenceIds: ['delivery-ev'] })],
      evidence: [evidence({ id: 'delivery-ev', claimType: 'delivery', source: 'warehouse' })]
    });

    expect(result.ok).toBe(false);
    expect(result.violations[0]?.reason).toBe('evidence_type_mismatch');
  });

  it('does not let verification wording mask a confident commercial promise', () => {
    const result = validateFactClaimAuditEvidence({
      version: 1,
      claims: [{
        kind: 'availability',
        text: 'Товар есть в наличии, я проверю склад перед оформлением.',
        requiredSource: 'specialist',
        groundingStatus: 'requires_specialist_verification',
        matchedProductIds: []
      }],
      warnings: []
    });

    expect(result.ok).toBe(false);
    expect(result.violations[0]?.reason).toBe('stock_claim_requires_live_warehouse_or_manager_evidence');
  });

  it('converts fact-claim audit commercial warnings into evidence-contract violations', () => {
    const result = validateFactClaimAuditEvidence({
      version: 1,
      claims: [{
        kind: 'availability',
        text: 'Товар есть в наличии.',
        requiredSource: 'specialist',
        groundingStatus: 'ungrounded',
        matchedProductIds: [],
        warning: 'availability_claim_without_specialist_verification_wording'
      }],
      warnings: ['availability_claim_without_specialist_verification_wording']
    });

    expect(result.ok).toBe(false);
    expect(result.violations[0]).toMatchObject({
      reason: 'stock_claim_requires_live_warehouse_or_manager_evidence'
    });
  });
});
