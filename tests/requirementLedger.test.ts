import { describe, expect, it } from 'vitest';
import { buildRequirementLedger } from '../src/ai/requirementLedger.js';
import { emptyNeedState, mergeProductSelectionState } from '../src/ai/needState.js';
import type { CustomerNeedState } from '../src/shared/types.js';

describe('requirement ledger', () => {
  it('combines active semantic requirements with hard selection constraints', () => {
    const base = emptyNeedState();
    const state: CustomerNeedState = {
      ...base,
      semanticMemory: {
        ...base.semanticMemory,
        activeRequirementIds: ['req-brand'],
        requirements: [{
          id: 'req-brand',
          kind: 'brand',
          value: { brand: 'TSS' },
          status: 'active',
          strictness: 'strictOnly',
          evidence: 'buyer asked for TSS',
          source: 'explicit_user',
          replacesRequirementIds: [],
          updatedAt: '2026-05-16T00:00:00.000Z'
        }],
        selectionPolicy: {
          primaryRequirementIds: ['req-brand'],
          alternativeMode: 'none',
          explanationRequired: false
        }
      },
      selectionState: mergeProductSelectionState(base.selectionState, {
        hardConstraints: {
          ...base.selectionState.hardConstraints,
          productIntent: 'generator',
          brandConstraint: 'TSS',
          fuel: 'gasoline'
        }
      })
    };

    const ledger = buildRequirementLedger({ needState: state });

    expect(ledger.activeRequirementIds).toEqual(['req-brand']);
    expect(ledger.primaryRequirementIds).toEqual(['req-brand']);
    expect(ledger.hardConstraintKeys).toEqual(expect.arrayContaining(['productIntent', 'brandConstraint', 'fuel']));
    expect(ledger.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'req-brand', kind: 'brand', source: 'explicit_user' }),
      expect.objectContaining({ id: 'selection:fuel', kind: 'fuel', source: 'selection_state' })
    ]));
  });

  it('warns when a hard constraint has no active semantic requirement mirror', () => {
    const base = emptyNeedState();
    const selectionState = mergeProductSelectionState(base.selectionState, {
      hardConstraints: {
        ...base.selectionState.hardConstraints,
        productIntent: 'generator',
        brandConstraint: 'TSS'
      }
    });

    const ledger = buildRequirementLedger({ needState: base, selectionState });

    expect(ledger.warnings).toEqual(expect.arrayContaining([
      'hard_constraint_without_active_semantic_requirement:brandConstraint'
    ]));
  });

  it('emits exact model token hard constraint keys without the internal selection prefix', () => {
    const base = emptyNeedState();
    const selectionState = mergeProductSelectionState(base.selectionState, {
      hardConstraints: {
        ...base.selectionState.hardConstraints,
        exactModelTokens: ['SGG 8000EH']
      }
    });

    const ledger = buildRequirementLedger({ needState: base, selectionState });

    expect(ledger.hardConstraintKeys).toContain('exactModelTokens');
    expect(ledger.hardConstraintKeys).not.toContain('selection:exactModelTokens');
  });
});
