import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  coerceMentionedProducts,
  coerceSemanticMemory,
  coerceSemanticRequirements,
  coerceSemanticValue
} from '../src/ai/semanticMemoryCoercion.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('semantic memory coercion', () => {
  it('keeps semantic value coercion limited to supported primitive fields', () => {
    expect(coerceSemanticValue({
      text: '  heavy plate  ',
      min: 90,
      max: null,
      unit: 'kg',
      productClass: 'plate',
      brand: '',
      amount: 120000,
      ignored: 'value'
    })).toEqual({
      text: 'heavy plate',
      min: 90,
      unit: 'kg',
      productClass: 'plate',
      amount: 120000
    });
  });

  it('coerces semantic requirements with the same defaults and limits', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-21T10:11:12.000Z'));

    const requirements = coerceSemanticRequirements([
      {
        kind: 'weightKg',
        value: { min: 90, max: 120, unit: 'kg' },
        status: 'bad',
        strictness: 'bad',
        source: 'bad',
        replacesRequirementIds: [' a ', '', 'b'],
        evidence: '  user asked for heavy plate  '
      },
      { kind: 'unknown', value: { text: 'ignored' } }
    ]);

    expect(requirements).toEqual([{
      id: 'weightKg:0',
      kind: 'weightKg',
      value: { min: 90, max: 120, unit: 'kg' },
      status: 'active',
      strictness: 'targetRange',
      evidence: 'user asked for heavy plate',
      source: 'llm_inference',
      replacesRequirementIds: ['a', 'b'],
      updatedAt: '2026-05-21T10:11:12.000Z'
    }]);
  });

  it('coerces mentioned products with compact normalized tokens', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-21T10:11:12.000Z'));

    expect(coerceMentionedProducts([
      {
        token: '  RD 8910E  ',
        normalizedToken: '',
        role: 'availabilityCheck',
        status: 'foundInCatalog',
        productIds: [' p1 ', '', 'p2'],
        evidence: ' selected card '
      }
    ])).toEqual([{
      token: 'RD 8910E',
      normalizedToken: 'rd8910e',
      role: 'availabilityCheck',
      status: 'foundInCatalog',
      productIds: ['p1', 'p2'],
      evidence: 'selected card',
      updatedAt: '2026-05-21T10:11:12.000Z'
    }]);
  });

  it('coerces full semantic memory contract for need updates', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-21T10:11:12.000Z'));

    const memory = coerceSemanticMemory({
      activeRequirementIds: [' req1 ', '', 'req2'],
      requirements: [{
        id: ' req1 ',
        kind: 'brand',
        value: { brand: 'Honda' },
        status: 'paused',
        strictness: 'fallbackAllowed',
        evidence: 'buyer prefers brand',
        source: 'explicit_user',
        replacesRequirementIds: []
      }],
      mentionedProducts: [],
      selectionPolicy: {
        primaryRequirementIds: [' req1 '],
        alternativeMode: 'afterPrimary',
        explanationRequired: true
      },
      botCommitments: [
        { kind: 'availability', text: 'manager must verify stock', productIds: ['p1'], evidence: 'business policy' },
        { kind: 'bad', text: 'ignored', productIds: [], evidence: '' }
      ]
    });

    expect(memory).toEqual({
      version: 1,
      activeRequirementIds: ['req1', 'req2'],
      requirements: [{
        id: 'req1',
        kind: 'brand',
        value: { brand: 'Honda' },
        status: 'paused',
        strictness: 'fallbackAllowed',
        evidence: 'buyer prefers brand',
        source: 'explicit_user',
        replacesRequirementIds: [],
        updatedAt: '2026-05-21T10:11:12.000Z'
      }],
      mentionedProducts: [],
      selectionPolicy: {
        primaryRequirementIds: ['req1'],
        alternativeMode: 'afterPrimary',
        explanationRequired: true
      },
      botCommitments: [{
        kind: 'availability',
        text: 'manager must verify stock',
        productIds: ['p1'],
        evidence: 'business policy',
        updatedAt: '2026-05-21T10:11:12.000Z'
      }]
    });
  });
});
