import { describe, expect, it } from 'vitest';
import type { DialogueLedgerEvent } from '../src/ai/agentManagerContracts.js';
import { budgetMaxFromNeedState } from '../src/ai/agentManagerCardSelection.js';
import {
  deriveNeedStateSnapshotFromLedger,
  parseReducedDialogueLedgerState,
  reduceDialogueLedger
} from '../src/ai/dialogueLedgerReducer.js';
import { emptyNeedState } from '../src/ai/needState.js';

const sessionId = '11111111-1111-4111-8111-111111111111';
const turnId = '22222222-2222-4222-8222-222222222222';

function event(input: Partial<DialogueLedgerEvent> & Pick<DialogueLedgerEvent, 'eventId' | 'eventType' | 'payload'>): DialogueLedgerEvent {
  return {
    sessionId,
    turnId,
    scope: 'dialogue',
    evidence: 'test evidence',
    source: 'llm_state_delta',
    status: 'active',
    ...input
  };
}

describe('dialogue ledger reducer', () => {
  it('round trips explicit ranking tuples, nonnumeric null and legacy absence without changing values', () => {
    const events = [
      event({ eventId: 'need', eventType: 'need.opened', scope: 'need', payload: { needId: 'selection', productClass: 'plate', activate: true } }),
      ...[{ attribute: 'price_rub', direction: 'minimize' }, null, undefined].map((ranking, index) => event({
        eventId: `pref-${index}`, eventType: 'fact.confirmed', scope: 'need', payload: {
          needId: 'selection', factKey: `preference_${index}`, value: 'как мне удобнее', unit: 'choice',
          role: 'preference', relation: 'preferred', ...(ranking === undefined ? {} : { ranking })
        }
      }))
    ];
    const initial = reduceDialogueLedger(events);
    const replayed = reduceDialogueLedger([], parseReducedDialogueLedgerState(JSON.parse(JSON.stringify(initial))));
    expect(replayed.factsByKey['selection::preference_0']).toMatchObject({
      ranking: { attribute: 'price_rub', direction: 'minimize' }, value: 'как мне удобнее', unit: 'choice'
    });
    expect(replayed.factsByKey['selection::preference_1']?.ranking).toBeNull();
    expect(replayed.factsByKey['selection::preference_2']?.ranking).toBeUndefined();
  });

  it('keeps nonactivated needs paused and switches or resumes only through explicit activation', () => {
    const primary = event({ eventId: 'primary', eventType: 'need.opened', scope: 'need', payload: {
      needId: 'primary', productClass: 'generator', activate: true
    } });
    const secondary = event({ eventId: 'secondary', eventType: 'need.opened', scope: 'need', payload: {
      needId: 'secondary', productClass: 'engineOil', activate: false, status: 'open'
    } });
    const initial = reduceDialogueLedger([primary, secondary]);
    expect(initial.needsById.secondary?.status).toBe('paused');
    expect(deriveNeedStateSnapshotFromLedger(initial).selectionState.currentProductClass).toBe('generator');

    const updated = reduceDialogueLedger([event({
      eventId: 'secondary-update', eventType: 'need.updated', scope: 'need',
      payload: { needId: 'secondary', status: 'open', activate: false, summary: 'Oil for later' }
    })], initial);
    expect(updated.needsById.secondary?.status).toBe('paused');
    const resumed = reduceDialogueLedger([event({
      eventId: 'resume-secondary', eventType: 'need.updated', scope: 'need',
      payload: { needId: 'secondary', activate: true }
    })], parseReducedDialogueLedgerState(JSON.parse(JSON.stringify(updated))));
    expect(resumed.needsById.primary?.status).toBe('paused');
    expect(deriveNeedStateSnapshotFromLedger(resumed).selectionState.currentProductClass).toBe('engineOil');

    const returned = reduceDialogueLedger([event({
      eventId: 'resume-primary', eventType: 'need.updated', scope: 'need',
      payload: { needId: 'primary', activate: true }
    })], resumed);
    expect(deriveNeedStateSnapshotFromLedger(returned).selectionState.currentProductClass).toBe('generator');
  });

  it('does not reactivate a closed need from its last scoped fact or the previous snapshot', () => {
    const state = reduceDialogueLedger([
      event({ eventId: 'primary', eventType: 'need.opened', scope: 'need', payload: {
        needId: 'primary', productClass: 'generator', activate: true
      } }),
      event({ eventId: 'budget', eventType: 'fact.confirmed', scope: 'need', payload: {
        needId: 'primary', productClass: 'generator', factKey: 'budget_max_rub', value: 100000,
        role: 'hard_requirement'
      } })
    ]);
    const base = deriveNeedStateSnapshotFromLedger(state);
    const closed = reduceDialogueLedger([event({
      eventId: 'close', eventType: 'need.closed', scope: 'need', payload: { needId: 'primary' }
    })], state);
    const snapshot = deriveNeedStateSnapshotFromLedger(closed, base);
    expect(snapshot.selectionState.currentProductClass).toBe('unknown');
    expect(snapshot.constraints).toEqual([]);
    expect(snapshot.activeNeeds.every((need) => need.status === 'closed')).toBe(true);
  });

  it('preserves product identity, scope, unit and relation through long snapshot replay', () => {
    const events: DialogueLedgerEvent[] = [
      event({ eventId: 'need', eventType: 'need.opened', scope: 'need', payload: {
        needId: 'comparison', productClass: 'plate', activate: true
      } }),
      ...['a', 'b'].map((productId, index) => event({
        eventId: `weight-${productId}`, eventType: 'fact.confirmed', scope: 'product',
        source: 'catalog', payload: {
          needId: 'comparison', productId, factKey: 'weight_kg', value: 30 + index * 40,
          unit: 'kg', relation: 'context', role: 'context'
        }
      })),
      event({ eventId: 'global-budget', eventType: 'fact.confirmed', scope: 'dialogue', payload: {
        factKey: 'budget_max_rub', value: 100000, unit: 'RUB', relation: 'must_have', role: 'hard_requirement'
      } }),
      event({ eventId: 'local-budget', eventType: 'fact.confirmed', scope: 'need', payload: {
        needId: 'comparison', factKey: 'budget_max_rub', value: 80000,
        unit: 'RUB', relation: 'must_have', role: 'hard_requirement'
      } }),
      ...Array.from({ length: 81 }, (_, index) => event({
        eventId: `context-${index}`, eventType: 'fact.confirmed', scope: 'need',
        payload: { needId: 'comparison', factKey: 'context', value: index, role: 'context' }
      })),
      event({ eventId: 'weight-a-updated', eventType: 'fact.confirmed', scope: 'product', source: 'catalog', payload: {
        needId: 'comparison', productId: 'a', factKey: 'weight_kg', value: 32,
        unit: 'kg', relation: 'context', role: 'context', supersedesEventIds: ['weight-a']
      } })
    ];
    const stored = parseReducedDialogueLedgerState(JSON.parse(JSON.stringify(reduceDialogueLedger(events.slice(0, 80)))));
    const result = reduceDialogueLedger(events.slice(80), stored);
    expect(result.factsByKey).toEqual(reduceDialogueLedger(events).factsByKey);
    const facts = Object.values(result.factsByKey);
    expect(facts.filter((fact) => fact.factKey === 'weight_kg')).toHaveLength(2);
    expect(facts).toEqual(expect.arrayContaining([
      expect.objectContaining({ productId: 'a', value: 32, scope: 'product', unit: 'kg', relation: 'context' }),
      expect.objectContaining({ productId: 'b', value: 70, scope: 'product', unit: 'kg', relation: 'context' }),
      expect.objectContaining({ factKey: 'budget_max_rub', value: 100000, scope: 'dialogue' }),
      expect.objectContaining({ factKey: 'budget_max_rub', value: 80000, scope: 'need', needId: 'comparison' })
    ]));
  });

  it('requests raw-event replay for legacy snapshots that lost scope or contain ambiguous active needs', () => {
    const state = reduceDialogueLedger([event({
      eventId: 'fact', eventType: 'fact.confirmed', scope: 'product',
      payload: { factKey: 'weight_kg', value: 30, productId: 'a' }
    })]);
    const legacy = JSON.parse(JSON.stringify(state));
    for (const fact of Object.values(legacy.factsByKey) as Array<Record<string, unknown>>) delete fact.scope;
    expect(() => parseReducedDialogueLedgerState(legacy)).toThrowError('invalid_dialogue_ledger_snapshot');

    const needs = reduceDialogueLedger(['a', 'b'].map((needId) => event({
      eventId: needId, eventType: 'need.opened', scope: 'need', payload: { needId, activate: true }
    })));
    needs.needsById.a!.status = 'open';
    expect(() => parseReducedDialogueLedgerState(needs)).toThrowError('invalid_dialogue_ledger_snapshot');
  });

  it('deduplicates events by eventId', () => {
    const state = reduceDialogueLedger([
      event({ eventId: 'same', eventType: 'fact.confirmed', payload: { factKey: 'need.power_kw', value: 5 } }),
      event({ eventId: 'same', eventType: 'fact.confirmed', payload: { factKey: 'need.power_kw', value: 7 } })
    ]);

    expect(state.eventIds).toEqual(['same']);
    expect(state.factsByKey['need.power_kw']?.value).toBe(5);
  });

  it('supersedes older facts with the same fact key', () => {
    const state = reduceDialogueLedger([
      event({ eventId: 'old', eventType: 'fact.confirmed', payload: { factKey: 'need.generator_use', value: 'home' } }),
      event({ eventId: 'new', eventType: 'fact.confirmed', payload: { factKey: 'need.generator_use', value: 'coffee point' } })
    ]);

    expect(state.factsByKey['need.generator_use']).toMatchObject({
      eventId: 'new',
      value: 'coffee point',
      status: 'active'
    });
  });

  it('closes questions when an answer event references them', () => {
    const state = reduceDialogueLedger([
      event({
        eventId: 'q1',
        eventType: 'question.asked',
        scope: 'question',
        payload: { questionId: 'q.power', text: 'What is the coffee machine power?' }
      }),
      event({
        eventId: 'a1',
        eventType: 'question.answered',
        scope: 'question',
        payload: { questionId: 'q.power', answer: '3.2 kW' }
      })
    ]);

    expect(state.openQuestions).toHaveLength(0);
    expect(state.questionsById['q.power']).toMatchObject({ status: 'answered', answer: '3.2 kW' });
  });

  it('derives a read-only legacy needState snapshot from active ledger facts', () => {
    const state = reduceDialogueLedger([
      event({
        eventId: 'need',
        eventType: 'fact.confirmed',
        payload: { factKey: 'need.generator_use', value: 'coffee point', productClass: 'generator', role: 'context' }
      }),
      event({
        eventId: 'load',
        eventType: 'fact.confirmed',
        payload: { factKey: 'load.coffee_machine_kw', value: 3.2 }
      }),
      event({
        eventId: 'q1',
        eventType: 'question.asked',
        scope: 'question',
        payload: { questionId: 'q.vitrine_start', text: 'Need display fridge starting load?' }
      })
    ]);

    const snapshot = deriveNeedStateSnapshotFromLedger(state);

    expect(snapshot.confirmedFacts.map((fact) => fact.value)).toEqual(expect.arrayContaining([
      'need.generator_use: coffee point',
      'load.coffee_machine_kw: 3.2'
    ]));
    expect(snapshot.activeNeeds[0]).toMatchObject({
      id: 'ledger-current',
      productClass: 'generator',
      openQuestions: ['Need display fridge starting load?']
    });
  });

  it('keeps switched needs separate and restores a paused topic without leaking constraints', () => {
    const state = reduceDialogueLedger([
      event({
        eventId: 'need-generator',
        eventType: 'need.opened',
        scope: 'need',
        payload: {
          needId: 'generator-shop',
          productClass: 'generator',
          summary: 'Generator for a coffee point',
          constraints: [],
          openQuestions: [],
          selectedProductIds: [],
          rejectedProductIds: [],
          status: 'open',
          activate: true
        }
      }),
      event({
        eventId: 'generator-budget-old',
        eventType: 'fact.confirmed',
        payload: {
          factKey: 'budget.max_rub',
          value: 120000,
          needId: 'generator-shop',
          productClass: 'generator',
          role: 'hard_requirement'
        }
      }),
      event({
        eventId: 'need-plate',
        eventType: 'need.opened',
        scope: 'need',
        payload: {
          needId: 'plate-yard',
          productClass: 'plate',
          summary: 'Plate for a private yard',
          constraints: ['one-person loading'],
          openQuestions: [],
          selectedProductIds: [],
          rejectedProductIds: ['plate-heavy'],
          status: 'open',
          activate: true
        }
      }),
      event({
        eventId: 'generator-resume',
        eventType: 'need.updated',
        scope: 'need',
        payload: {
          needId: 'generator-shop',
          productClass: 'generator',
          summary: 'Generator for a coffee point',
          constraints: [],
          openQuestions: ['Confirm refrigerator starting load'],
          selectedProductIds: [],
          rejectedProductIds: [],
          status: 'open',
          activate: true
        }
      }),
      event({
        eventId: 'generator-budget-new',
        eventType: 'fact.confirmed',
        payload: {
          factKey: 'budget.max_rub',
          value: 150000,
          needId: 'generator-shop',
          productClass: 'generator',
          role: 'hard_requirement',
          supersedesEventIds: ['generator-budget-old']
        }
      })
    ]);

    const snapshot = deriveNeedStateSnapshotFromLedger(state);

    expect(state.needsById['generator-shop']?.status).toBe('open');
    expect(state.needsById['plate-yard']?.status).toBe('paused');
    expect(state.factsByKey['generator-shop::budget.max_rub']?.value).toBe(150000);
    expect(snapshot.activeNeeds).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'generator-shop', status: 'open', productClass: 'generator' }),
      expect.objectContaining({ id: 'plate-yard', status: 'paused', productClass: 'plate' })
    ]));
    expect(snapshot.selectionState.currentProductClass).toBe('generator');
    expect(snapshot.selectionState.rejectedProducts).not.toContainEqual(expect.objectContaining({ productId: 'plate-heavy' }));
    expect(budgetMaxFromNeedState(snapshot)).toBe(150000);
  });

  it('does not leak a paused need budget or product selections into a newly active topic', () => {
    const base = emptyNeedState();
    base.selectionState.currentProductClass = 'generator';
    base.selectionState.targetProductClass = 'generator';
    base.selectionState.hardConstraints.budgetMax = 50000;
    base.selectionState.selectedProductIds = ['old-generator'];
    base.semanticMemory.requirements = [{
      id: 'old-budget',
      kind: 'budgetRub',
      value: { max: 50000 },
      status: 'active',
      strictness: 'strictOnly',
      source: 'explicit_user',
      evidence: 'old generator budget',
      replacesRequirementIds: [],
      updatedAt: '2026-07-11T00:00:00.000Z'
    }];
    base.semanticMemory.activeRequirementIds = ['old-budget'];

    const state = reduceDialogueLedger([
      event({
        eventId: 'generator-need',
        eventType: 'need.opened',
        scope: 'need',
        payload: {
          needId: 'generator',
          productClass: 'generator',
          summary: 'Generator selection',
          selectedProductIds: ['old-generator'],
          rejectedProductIds: ['rejected-generator'],
          status: 'open',
          activate: true
        }
      }),
      event({
        eventId: 'generator-budget',
        eventType: 'fact.confirmed',
        payload: {
          factKey: 'budget.max_rub',
          value: 50000,
          needId: 'generator',
          productClass: 'generator',
          role: 'hard_requirement'
        }
      }),
      event({
        eventId: 'plate-need',
        eventType: 'need.opened',
        scope: 'need',
        payload: {
          needId: 'plate',
          productClass: 'plate',
          summary: 'Plate selection',
          constraints: ['one-person loading'],
          selectedProductIds: ['current-plate'],
          rejectedProductIds: ['rejected-plate'],
          status: 'open',
          activate: true
        }
      })
    ]);

    const snapshot = deriveNeedStateSnapshotFromLedger(state, base);

    expect(state.needsById.generator?.status).toBe('paused');
    expect(snapshot.selectionState.currentProductClass).toBe('plate');
    expect(snapshot.selectionState.hardConstraints.budgetMax).toBeUndefined();
    expect(snapshot.selectionState.selectedProductIds).toEqual(['current-plate']);
    expect(snapshot.selectionState.rejectedProducts).toEqual([
      expect.objectContaining({ productId: 'rejected-plate' })
    ]);
    expect(snapshot.semanticMemory.requirements).toEqual([]);
    expect(snapshot.confirmedFacts.map((fact) => fact.value)).not.toContain('budget.max_rub: 50000');
    expect(snapshot.constraints.map((constraint) => constraint.value)).not.toContain('budget.max_rub: 50000');
    expect(budgetMaxFromNeedState(snapshot)).toBeUndefined();
  });

  it('rehydrates snapshot plus tail identically after more than 80 events', () => {
    const events: DialogueLedgerEvent[] = [event({
      eventId: 'need-long',
      eventType: 'need.opened',
      scope: 'need',
      payload: {
        needId: 'long-selection',
        productClass: 'generator',
        summary: 'Long generator selection',
        constraints: [],
        openQuestions: [],
        selectedProductIds: [],
        rejectedProductIds: [],
        status: 'open',
        activate: true
      }
    })];
    for (let index = 1; index <= 90; index += 1) {
      events.push(event({
        eventId: `fact-${index}`,
        eventType: 'fact.confirmed',
        payload: {
          factKey: 'budget.max_rub',
          value: index * 1000,
          needId: 'long-selection',
          productClass: 'generator',
          role: 'hard_requirement'
        }
      }));
    }

    const full = reduceDialogueLedger(events);
    const snapshot = parseReducedDialogueLedgerState(JSON.parse(JSON.stringify(reduceDialogueLedger(events.slice(0, 80)))));
    const rehydrated = reduceDialogueLedger(events.slice(80), snapshot);

    expect(rehydrated.eventIds).toEqual(full.eventIds);
    expect(rehydrated.factsByKey).toEqual(full.factsByKey);
    expect(rehydrated.needsById).toEqual(full.needsById);
    expect(deriveNeedStateSnapshotFromLedger(rehydrated).selectionState.currentProductClass).toBe('generator');
  });

  it('does not let an empty LLM selection erase system-validated product ids', () => {
    const state = reduceDialogueLedger([
      event({
        eventId: 'validated-selection',
        eventType: 'need.opened',
        scope: 'need',
        source: 'system_reducer',
        payload: {
          needId: 'generator',
          productClass: 'generator',
          summary: 'Generator selection',
          selectedProductIds: ['validated-generator'],
          rejectedProductIds: [],
          status: 'selected',
          activate: true
        }
      }),
      event({
        eventId: 'llm-empty-update',
        eventType: 'need.updated',
        scope: 'need',
        source: 'llm_state_delta',
        payload: {
          needId: 'generator',
          productClass: 'generator',
          summary: 'Continue selection',
          selectedProductIds: [],
          rejectedProductIds: [],
          status: 'open',
          activate: true
        }
      })
    ]);

    expect(state.needsById.generator?.selectedProductIds).toEqual(['validated-generator']);
  });

  it('applies explicit replace and clear selection modes without preserving stale product ids', () => {
    const opened = event({
      eventId: 'validated-selection',
      eventType: 'need.opened',
      scope: 'need',
      source: 'system_reducer',
      payload: {
        needId: 'generator',
        productClass: 'generator',
        summary: 'Generator selection',
        selectedProductIds: ['old-generator'],
        rejectedProductIds: [],
        selectionUpdateMode: 'replace',
        invalidatedProductIds: [],
        status: 'selected',
        activate: true
      }
    });
    const replaceUpdate = event({
      eventId: 'requirements-changed',
      eventType: 'need.updated',
      scope: 'need',
      source: 'llm_state_delta',
      payload: {
        needId: 'generator',
        productClass: 'generator',
        summary: 'Generator with changed hard requirements',
        selectedProductIds: [],
        rejectedProductIds: [],
        selectionUpdateMode: 'replace',
        invalidatedProductIds: ['old-generator'],
        status: 'open',
        activate: true
      }
    });
    const clearUpdate = event({
      eventId: 'selection-cleared',
      eventType: 'need.updated',
      scope: 'need',
      source: 'llm_state_delta',
      payload: {
        needId: 'generator',
        productClass: 'generator',
        summary: 'Generator selection reset',
        selectedProductIds: [],
        rejectedProductIds: [],
        selectionUpdateMode: 'clear',
        invalidatedProductIds: ['old-generator'],
        status: 'open',
        activate: true
      }
    });

    expect(reduceDialogueLedger([opened, replaceUpdate]).needsById.generator?.selectedProductIds).toEqual([]);
    expect(reduceDialogueLedger([opened, clearUpdate]).needsById.generator?.selectedProductIds).toEqual([]);
  });

  it('preserves only non-invalidated products when selection mode is explicit', () => {
    const state = reduceDialogueLedger([
      event({
        eventId: 'validated-selection',
        eventType: 'need.opened',
        scope: 'need',
        source: 'system_reducer',
        payload: {
          needId: 'generator',
          productClass: 'generator',
          summary: 'Generator selection',
          selectedProductIds: ['stale-generator', 'still-valid-generator'],
          rejectedProductIds: [],
          selectionUpdateMode: 'replace',
          invalidatedProductIds: [],
          status: 'selected',
          activate: true
        }
      }),
      event({
        eventId: 'preserve-valid-selection',
        eventType: 'need.updated',
        scope: 'need',
        source: 'llm_state_delta',
        payload: {
          needId: 'generator',
          productClass: 'generator',
          summary: 'Continue selection after one constraint changed',
          selectedProductIds: [],
          rejectedProductIds: [],
          selectionUpdateMode: 'preserve',
          invalidatedProductIds: ['stale-generator'],
          status: 'selected',
          activate: true
        }
      })
    ]);

    expect(state.needsById.generator?.selectedProductIds).toEqual(['still-valid-generator']);
  });

  it('removes a validated product when the LLM records an explicit buyer rejection', () => {
    const state = reduceDialogueLedger([
      event({
        eventId: 'validated-selection',
        eventType: 'need.opened',
        scope: 'need',
        source: 'system_reducer',
        payload: {
          needId: 'generator',
          productClass: 'generator',
          summary: 'Generator selection',
          selectedProductIds: ['rejected-generator', 'still-valid-generator'],
          rejectedProductIds: [],
          status: 'selected',
          activate: true
        }
      }),
      event({
        eventId: 'buyer-rejected-one',
        eventType: 'need.updated',
        scope: 'need',
        source: 'llm_state_delta',
        payload: {
          needId: 'generator',
          productClass: 'generator',
          summary: 'Buyer rejected one option',
          selectedProductIds: [],
          rejectedProductIds: ['rejected-generator'],
          status: 'open',
          activate: true
        }
      })
    ]);

    expect(state.needsById.generator?.selectedProductIds).toEqual(['still-valid-generator']);
    expect(state.needsById.generator?.rejectedProductIds).toEqual(['rejected-generator']);
  });

  it('preserves product rejections until an explicit typed operation changes them', () => {
    const opened = event({
      eventId: 'opened-with-rejections',
      eventType: 'need.opened',
      scope: 'need',
      payload: {
        needId: 'generator',
        productClass: 'generator',
        summary: 'Generator selection',
        rejectedProductIds: ['too-heavy', 'too-expensive'],
        status: 'open',
        activate: true
      }
    });
    const mandatoryEmptyUpdate = event({
      eventId: 'mandatory-empty-rejections',
      eventType: 'need.updated',
      scope: 'need',
      payload: {
        needId: 'generator',
        productClass: 'generator',
        summary: 'Continue the same selection',
        rejectedProductIds: [],
        status: 'open',
        activate: true
      }
    });
    const mergedRejection = event({
      eventId: 'merge-another-rejection',
      eventType: 'need.updated',
      scope: 'need',
      payload: {
        needId: 'generator',
        rejectedProductIds: ['too-loud'],
        rejectedProductIdsUpdateMode: 'merge',
        status: 'open',
        activate: true
      }
    });
    const explicitUnreject = event({
      eventId: 'explicit-unreject-by-replace',
      eventType: 'need.updated',
      scope: 'need',
      payload: {
        needId: 'generator',
        rejectedProductIds: ['too-heavy', 'too-loud'],
        rejectedProductIdsUpdateMode: 'replace',
        status: 'open',
        activate: true
      }
    });
    const explicitClear = event({
      eventId: 'explicit-clear-rejections',
      eventType: 'need.updated',
      scope: 'need',
      payload: {
        needId: 'generator',
        rejectedProductIds: [],
        rejectedProductIdsUpdateMode: 'clear',
        status: 'open',
        activate: true
      }
    });

    expect(reduceDialogueLedger([opened, mandatoryEmptyUpdate]).needsById.generator?.rejectedProductIds)
      .toEqual(['too-heavy', 'too-expensive']);
    expect(reduceDialogueLedger([opened, mandatoryEmptyUpdate, mergedRejection]).needsById.generator?.rejectedProductIds)
      .toEqual(['too-heavy', 'too-expensive', 'too-loud']);
    expect(reduceDialogueLedger([opened, mandatoryEmptyUpdate, mergedRejection, explicitUnreject]).needsById.generator?.rejectedProductIds)
      .toEqual(['too-heavy', 'too-loud']);
    expect(reduceDialogueLedger([
      opened,
      mandatoryEmptyUpdate,
      mergedRejection,
      explicitUnreject,
      explicitClear
    ]).needsById.generator?.rejectedProductIds).toEqual([]);
  });

  it('preserves constraints and open questions until explicit replace or clear operations', () => {
    const opened = event({
      eventId: 'opened-with-need-state',
      eventType: 'need.opened',
      scope: 'need',
      payload: {
        needId: 'generator',
        productClass: 'generator',
        summary: 'Generator selection',
        constraints: ['up to 80 kg'],
        openQuestions: ['Confirm the starting current'],
        status: 'open',
        activate: true
      }
    });
    const mandatoryEmptyUpdate = event({
      eventId: 'mandatory-empty-need-state',
      eventType: 'need.updated',
      scope: 'need',
      payload: {
        needId: 'generator',
        constraints: [],
        openQuestions: [],
        status: 'open',
        activate: true
      }
    });
    const explicitReplace = event({
      eventId: 'replace-need-state',
      eventType: 'need.updated',
      scope: 'need',
      payload: {
        needId: 'generator',
        constraints: ['up to 100000 RUB'],
        constraintsUpdateMode: 'replace',
        openQuestions: ['Confirm the phase'],
        openQuestionsUpdateMode: 'replace',
        status: 'open',
        activate: true
      }
    });
    const explicitClear = event({
      eventId: 'clear-need-state',
      eventType: 'need.updated',
      scope: 'need',
      payload: {
        needId: 'generator',
        constraints: [],
        constraintsUpdateMode: 'clear',
        openQuestions: [],
        openQuestionsUpdateMode: 'clear',
        status: 'open',
        activate: true
      }
    });

    expect(reduceDialogueLedger([opened, mandatoryEmptyUpdate]).needsById.generator).toMatchObject({
      constraints: ['up to 80 kg'],
      openQuestions: ['Confirm the starting current']
    });
    expect(reduceDialogueLedger([opened, mandatoryEmptyUpdate, explicitReplace]).needsById.generator).toMatchObject({
      constraints: ['up to 100000 RUB'],
      openQuestions: ['Confirm the phase']
    });
    expect(reduceDialogueLedger([opened, mandatoryEmptyUpdate, explicitReplace, explicitClear]).needsById.generator)
      .toMatchObject({ constraints: [], openQuestions: [] });
  });

  it('keeps observed facts epistemically distinct and does not displace an active confirmed fact', () => {
    const state = reduceDialogueLedger([
      event({
        eventId: 'confirmed-budget',
        eventType: 'fact.confirmed',
        scope: 'need',
        createdAt: '2026-08-09T10:00:00.000Z',
        payload: {
          factKey: 'budget.max_rub',
          value: 100000,
          needId: 'generator',
          role: 'hard_requirement',
          confidence: 1
        },
        evidence: 'Buyer explicitly confirmed the budget.',
        source: 'llm_state_delta'
      }),
      event({
        eventId: 'observed-budget-conflict',
        eventType: 'fact.observed',
        scope: 'need',
        createdAt: '2026-08-09T10:01:00.000Z',
        payload: {
          factKey: 'budget.max_rub',
          value: 120000,
          needId: 'generator',
          role: 'hard_requirement',
          confidence: 1
        },
        evidence: 'A later tool observation suggested another number.',
        source: 'tool_result'
      }),
      event({
        eventId: 'observed-weight',
        eventType: 'fact.observed',
        scope: 'product',
        createdAt: '2026-08-09T10:02:00.000Z',
        payload: {
          factKey: 'product.weight_kg',
          value: 77,
          needId: 'generator',
          role: 'hard_requirement',
          confidence: 1
        },
        evidence: 'Observed in an unconfirmed tool result.',
        source: 'tool_result'
      })
    ]);

    expect(state.factsByKey['generator::budget.max_rub']).toMatchObject({
      eventId: 'confirmed-budget',
      eventType: 'fact.confirmed',
      source: 'llm_state_delta',
      confidence: 1,
      createdAt: '2026-08-09T10:00:00.000Z'
    });
    expect(state.factsByKey['generator::product.weight_kg']).toMatchObject({
      eventType: 'fact.observed',
      source: 'tool_result',
      confidence: 0.5,
      createdAt: '2026-08-09T10:02:00.000Z'
    });

    const compacted = parseReducedDialogueLedgerState(JSON.parse(JSON.stringify(state)));
    expect(compacted.factsByKey['generator::product.weight_kg']).toMatchObject({
      eventType: 'fact.observed',
      source: 'tool_result',
      confidence: 0.5,
      createdAt: '2026-08-09T10:02:00.000Z'
    });
    const snapshot = deriveNeedStateSnapshotFromLedger(compacted);
    expect(snapshot.confirmedFacts.map((fact) => fact.value)).toContain('budget.max_rub: 100000');
    expect(snapshot.confirmedFacts.find((fact) => fact.value === 'budget.max_rub: 100000')?.updatedAt)
      .toBe('2026-08-09T10:00:00.000Z');
    expect(snapshot.confirmedFacts.map((fact) => fact.value)).not.toContain('product.weight_kg: 77');
    expect(snapshot.constraints.map((fact) => fact.value)).not.toContain('product.weight_kg: 77');
    expect(snapshot.uncertainInferences).toContainEqual(expect.objectContaining({
      value: 'product.weight_kg: 77',
      updatedAt: '2026-08-09T10:02:00.000Z',
      confidence: 0.5
    }));
  });

  it('rejects malformed nested snapshot entries instead of trusting unsafe casts', () => {
    expect(() => parseReducedDialogueLedgerState({
      eventIds: ['bad-fact'],
      factsByKey: {
        bad: {
          factKey: 'budget.max_rub',
          value: 100000,
          eventId: 'bad-fact',
          status: 'active',
          evidence: 'missing source and epistemic metadata'
        }
      },
      questionsById: {},
      needsById: {},
      warnings: []
    })).toThrowError('invalid_dialogue_ledger_snapshot');
  });
});
