import { describe, expect, it } from 'vitest';
import type { VerifiedProductFact } from '../src/shared/types.js';
import {
  matchingVerifiedFactsForRequest,
  verifiedFactCoverageForRequest,
  verifiedFactsCoverRequest
} from '../src/ai/verifiedFactMemory.js';

const now = new Date('2026-08-09T12:00:00.000Z');

function fact(input: Partial<VerifiedProductFact> & Pick<VerifiedProductFact, 'id' | 'value'>): VerifiedProductFact {
  return {
    id: input.id,
    productId: input.productId ?? '11111111-1111-4111-8111-111111111111',
    productKey: input.productKey ?? 'tss sgg 5000 eh',
    productName: input.productName ?? 'TSS SGG 5000 EH',
    attribute: input.attribute ?? 'nominal power',
    value: input.value,
    sourceType: input.sourceType ?? 'web',
    sourceUrl: input.sourceUrl === undefined ? `https://manufacturer.example/${input.id}` : input.sourceUrl,
    sourceTitle: input.sourceTitle ?? 'Official specification',
    evidence: input.evidence ?? `Nominal power ${input.value}`,
    confidence: input.confidence ?? 'high',
    status: input.status ?? 'active',
    firstSeenAt: input.firstSeenAt ?? now.toISOString(),
    lastVerifiedAt: input.lastVerifiedAt ?? now.toISOString(),
    hitCount: input.hitCount ?? 0,
    createdAt: input.createdAt ?? now.toISOString(),
    updatedAt: input.updatedAt ?? now.toISOString()
  };
}

describe('verified fact memory safety', () => {
  it('does not answer from a stale fact that has not been reverified within the memory TTL', () => {
    const stale = fact({
      id: 'stale-power',
      value: '5.0 kW',
      lastVerifiedAt: '2025-01-01T00:00:00.000Z'
    });

    const matching = matchingVerifiedFactsForRequest({
      facts: [stale],
      targetProductNames: ['TSS SGG 5000 EH'],
      comparisonAttributes: ['nominal power'],
      now
    });

    expect(matching).toEqual([]);
  });

  it('does not declare a requested attribute covered when active exact-product facts disagree', () => {
    const matching = matchingVerifiedFactsForRequest({
      facts: [
        fact({ id: 'power-five', value: '5.0 kW' }),
        fact({ id: 'power-six', value: '6.0 kW' })
      ],
      targetProductNames: ['TSS SGG 5000 EH'],
      comparisonAttributes: ['nominal power'],
      now
    });

    expect(verifiedFactsCoverRequest({
      facts: matching,
      comparisonAttributes: ['nominal power']
    })).toBe(false);
  });

  it('does not reuse a legacy web fact without an HTTP(S) provenance URL', () => {
    const matching = matchingVerifiedFactsForRequest({
      facts: [fact({ id: 'title-only', value: '5.0 kW', sourceUrl: null })],
      targetProductNames: ['TSS SGG 5000 EH'],
      comparisonAttributes: ['nominal power'],
      now
    });

    expect(matching).toEqual([]);
  });

  it('does not use maximum power as evidence for a nominal-power request', () => {
    const matching = matchingVerifiedFactsForRequest({
      facts: [fact({ id: 'maximum-power', attribute: 'maximum power', value: '5.5 kW' })],
      targetProductNames: ['TSS SGG 5000 EH'],
      comparisonAttributes: ['nominal power'],
      now
    });

    expect(matching).toEqual([]);
  });

  it('does not reuse a fuel-tank fact as the requested fuel type', () => {
    const matching = matchingVerifiedFactsForRequest({
      facts: [fact({
        id: 'fuel-tank-capacity',
        attribute: 'fuel tank capacity',
        value: '15 l'
      })],
      targetProductNames: ['TSS SGG 5000 EH'],
      comparisonAttributes: ['fuel type'],
      now
    });

    expect(matching).toEqual([]);
  });

  it.each(['power', 'start'])(
    'does not turn a short meaningful attribute into a wildcard: %s',
    (attribute) => {
      const unrelated = fact({
        id: `unrelated-${attribute}`,
        attribute: 'fuel tank capacity',
        value: '15 l'
      });

      const matching = matchingVerifiedFactsForRequest({
        facts: [unrelated],
        targetProductNames: ['TSS SGG 5000 EH'],
        comparisonAttributes: [attribute],
        now
      });

      expect(matching).toEqual([]);
      expect(verifiedFactsCoverRequest({
        facts: [unrelated],
        comparisonAttributes: [attribute]
      })).toBe(false);
    }
  );

  it('does not skip live research when the request has no reusable typed attribute', () => {
    const unrelated = fact({
      id: 'generic-memory-fact',
      attribute: 'fuel tank capacity',
      value: '15 l'
    });

    expect(matchingVerifiedFactsForRequest({
      facts: [unrelated],
      targetProductNames: ['TSS SGG 5000 EH'],
      comparisonAttributes: [],
      now
    })).toEqual([]);
    expect(verifiedFactsCoverRequest({
      facts: [unrelated],
      comparisonAttributes: []
    })).toBe(false);
  });

  it('keeps a fresh single-value exact-product fact eligible for a memory hit', () => {
    const matching = matchingVerifiedFactsForRequest({
      facts: [fact({ id: 'fresh-power', value: '5.0 kW' })],
      targetProductNames: ['TSS SGG 5000 EH'],
      comparisonAttributes: ['nominal power'],
      now
    });

    expect(matching.map((item) => item.id)).toEqual(['fresh-power']);
    expect(verifiedFactsCoverRequest({
      facts: matching,
      comparisonAttributes: ['nominal power']
    })).toBe(true);
  });

  it('requires every requested exact product to have a conflict-free value before skipping research', () => {
    const matching = matchingVerifiedFactsForRequest({
      facts: [fact({ id: 'first-model-only', value: '5.0 kW' })],
      targetProductNames: ['TSS SGG 5000 EH', 'TSS SGG 6000 EH'],
      comparisonAttributes: ['nominal power'],
      now
    });

    expect(verifiedFactsCoverRequest({
      facts: matching,
      targetProductNames: ['TSS SGG 5000 EH', 'TSS SGG 6000 EH'],
      comparisonAttributes: ['nominal power']
    })).toBe(false);
    const coverage = verifiedFactCoverageForRequest({
      facts: matching,
      targetProductNames: ['TSS SGG 5000 EH', 'TSS SGG 6000 EH'],
      comparisonAttributes: ['nominal power']
    });
    expect(coverage.missingAttributes).toEqual(['nominal power']);
    expect(coverage.missingFactSlots).toEqual([{
      productName: 'TSS SGG 6000 EH',
      attribute: 'nominal power'
    }]);
  });
});
