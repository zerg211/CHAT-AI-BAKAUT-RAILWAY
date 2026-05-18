import { describe, expect, it } from 'vitest';
import { applyContractNeedDelta } from '../src/ai/requirementDelta.js';
import { emptyNeedState } from '../src/ai/needState.js';

describe('contract requirement delta', () => {
  it('returns the same state object when the contract has no delta', () => {
    const base = emptyNeedState();
    const state = applyContractNeedDelta({
      needState: base,
      needDelta: {
        newRequirements: [],
        confirmedRequirements: [],
        changedRequirements: [],
        supersededRequirementIds: [],
        rejectedProductIds: []
      }
    });

    expect(state).toBe(base);
  });

  it('adds new and confirmed requirements to need state', () => {
    const state = applyContractNeedDelta({
      needState: emptyNeedState(),
      needDelta: {
        newRequirements: ['diesel generator'],
        confirmedRequirements: ['380 V'],
        changedRequirements: [],
        supersededRequirementIds: [],
        rejectedProductIds: []
      }
    });

    expect(state.explicitNeeds.map((item) => item.value)).toEqual(['380 V', 'diesel generator']);
    expect(state.semanticMemory.requirements.map((item) => item.value.text)).toEqual(['diesel generator']);
  });

  it('marks superseded requirements inactive and records changed requirements', () => {
    const base = emptyNeedState();
    const previous = {
      id: 'old-power',
      kind: 'powerKw' as const,
      value: { min: 5 },
      status: 'active' as const,
      strictness: 'strictOnly' as const,
      evidence: 'old',
      source: 'explicit_user' as const,
      replacesRequirementIds: [],
      updatedAt: '2026-05-01T00:00:00.000Z'
    };
    const state = applyContractNeedDelta({
      needState: {
        ...base,
        semanticMemory: {
          ...base.semanticMemory,
          activeRequirementIds: ['old-power'],
          requirements: [previous]
        }
      },
      needDelta: {
        newRequirements: [],
        confirmedRequirements: [],
        changedRequirements: ['now 10 kW'],
        supersededRequirementIds: ['old-power'],
        rejectedProductIds: []
      }
    });

    expect(state.semanticMemory.requirements.find((item) => item.id === 'old-power')?.status).toBe('superseded');
    expect(state.contradictions.map((item) => item.value)).toEqual(['now 10 kW']);
    expect(state.semanticMemory.activeRequirementIds).not.toContain('old-power');
  });
});
