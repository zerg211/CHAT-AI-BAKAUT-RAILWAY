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
});
