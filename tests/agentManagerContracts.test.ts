import { describe, expect, it } from 'vitest';
import {
  AgentIntentContractSchema,
  DialogueLedgerEventSchema,
  createStableLedgerEventId,
  normalizeLedgerStateDeltaEvents,
  type LedgerStateDelta
} from '../src/ai/agentManagerContracts.js';
import { agentManagerStructuredFormats } from '../src/ai/agentManagerOrchestrator.js';

const sessionId = '11111111-1111-4111-8111-111111111111';
const turnId = '22222222-2222-4222-8222-222222222222';

function walkJsonSchemaObjects(schema: unknown, visit: (schema: Record<string, unknown>, path: string) => void, path = '$') {
  if (!schema || typeof schema !== 'object') return;
  const object = schema as Record<string, unknown>;
  const looksLikeObjectSchema = object.type === 'object' || Boolean(object.properties);
  if (looksLikeObjectSchema) visit(object, path);
  const properties = object.properties;
  if (properties && typeof properties === 'object') {
    for (const [key, value] of Object.entries(properties as Record<string, unknown>)) {
      walkJsonSchemaObjects(value, visit, `${path}.properties.${key}`);
    }
  }
  if (object.items) walkJsonSchemaObjects(object.items, visit, `${path}.items`);
  for (const key of ['anyOf', 'oneOf', 'allOf'] as const) {
    const variants = object[key];
    if (Array.isArray(variants)) {
      variants.forEach((variant, index) => walkJsonSchemaObjects(variant, visit, `${path}.${key}[${index}]`));
    }
  }
}

describe('agent manager contracts', () => {
  it('uses strict OpenAI response-format schemas without open object payloads', () => {
    for (const [name, format] of Object.entries(agentManagerStructuredFormats)) {
      const schema = format.format.schema;
      walkJsonSchemaObjects(schema, (object, path) => {
        expect(object.additionalProperties, `${name} ${path}`).toBe(false);
        const properties = object.properties && typeof object.properties === 'object'
          ? Object.keys(object.properties as Record<string, unknown>)
          : [];
        if (properties.length) {
          expect(object.required, `${name} ${path}`).toEqual(expect.arrayContaining(properties));
        }
      });
    }
  });

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

  it('does not require planner-provided turnId to be a trusted UUID', () => {
    const result = AgentIntentContractSchema.safeParse({
      turnId: 'planner-local-turn-id',
      userMessageSummary: 'buyer asks about generator sizing',
      dialogueUnderstanding: 'the real turn id is owned by server code, not by the LLM',
      nextStepRationale: 'answer with calculation',
      requiresTools: false,
      toolRequests: [],
      mustNotAskQuestionIds: [],
      riskFlags: []
    });

    expect(result.success).toBe(true);
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
