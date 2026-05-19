import { describe, expect, it } from 'vitest';
import type { DialogueLedgerEvent } from '../src/ai/agentManagerContracts.js';
import { deriveNeedStateSnapshotFromLedger, reduceDialogueLedger } from '../src/ai/dialogueLedgerReducer.js';

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
        payload: { factKey: 'need.generator_use', value: 'coffee point' }
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
});
