import { describe, expect, it } from 'vitest';
import {
  DialogueLedgerEventSchema,
  createStableLedgerEventId,
  normalizeLedgerStateDeltaEvents,
  type LedgerStateDelta
} from '../src/ai/agentManagerContracts.js';

const sessionId = '11111111-1111-4111-8111-111111111111';
const turnId = '22222222-2222-4222-8222-222222222222';

describe('agent manager contracts', () => {
  it('requires evidence, source, and status for ledger events', () => {
    const result = DialogueLedgerEventSchema.safeParse({
      sessionId,
      turnId,
      eventId: 'event',
      eventType: 'fact.confirmed',
      scope: 'dialogue',
      payload: { factKey: 'load.coffee_machine_kw', value: 3.2 },
      evidence: '',
      source: 'llm_state_delta',
      status: 'active'
    });

    expect(result.success).toBe(false);
  });

  it('creates stable event ids from sorted semantic content', () => {
    const left = createStableLedgerEventId({
      sessionId,
      turnId,
      eventType: 'fact.confirmed',
      scope: 'dialogue',
      payload: { b: 2, a: 1 },
      evidence: 'buyer wrote it',
      source: 'llm_state_delta',
      status: 'active'
    });
    const right = createStableLedgerEventId({
      sessionId,
      turnId,
      eventType: 'fact.confirmed',
      scope: 'dialogue',
      payload: { a: 1, b: 2 },
      evidence: 'buyer wrote it',
      source: 'llm_state_delta',
      status: 'active'
    });

    expect(left).toBe(right);
  });

  it('normalizes LLM state delta into concrete turn-scoped ledger events', () => {
    const delta: LedgerStateDelta = {
      rationale: 'Buyer provided the coffee machine load.',
      events: [{
        eventType: 'fact.confirmed',
        scope: 'dialogue',
        payload: { factKey: 'load.coffee_machine_kw', value: 3.2 },
        evidence: 'Кофемашина 3,2 кВт',
        source: 'llm_state_delta',
        status: 'active'
      }]
    };

    const events = normalizeLedgerStateDeltaEvents({ sessionId, turnId, delta });

    expect(events[0]).toMatchObject({
      sessionId,
      turnId,
      eventType: 'fact.confirmed',
      eventId: expect.stringContaining('fact.confirmed:')
    });
  });

  it('does not trust LLM-provided event ids for idempotency', () => {
    const delta: LedgerStateDelta = {
      rationale: 'Same fact should get the same stable event id.',
      events: [{
        eventId: 'llm-random-id',
        eventType: 'fact.confirmed',
        scope: 'dialogue',
        payload: { factKey: 'load.coffee_machine_kw', value: 3.2 },
        evidence: 'Кофемашина 3,2 кВт',
        source: 'llm_state_delta',
        status: 'active'
      }]
    };

    const [event] = normalizeLedgerStateDeltaEvents({ sessionId, turnId, delta });

    expect(event.eventId).not.toBe('llm-random-id');
    expect(event.eventId).toContain('fact.confirmed:');
  });
});
