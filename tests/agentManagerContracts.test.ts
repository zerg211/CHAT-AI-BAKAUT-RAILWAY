import { describe, expect, it } from 'vitest';
import {
  AgentIntentContractSchema,
  DialogueLedgerEventSchema,
  createStableLedgerEventId,
  parseAnswerContractModelOutput,
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
  it('normalizes an empty product class for a non-product answer instead of failing the turn', () => {
    const result = parseAnswerContractModelOutput({
      answerText: 'КЕДР.',
      factsUsed: [],
      questionsAsked: [],
      toolResultIds: [],
      selectedProductIds: [],
      leadAction: 'none',
      riskFlags: [],
      selectionReadiness: {
        productClass: '',
        status: 'not_applicable',
        canShowProductCards: false,
        missingFacts: [],
        rationale: 'The buyer asked for a fact already present in the conversation.'
      }
    });

    expect(result.selectionReadiness?.productClass).toBe('unknown');
  });

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

  it('restricts canonical product classes to the runtime ontology', () => {
    const baseIntent = {
      userMessageSummary: 'select a vibration plate',
      dialogueUnderstanding: 'the buyer needs a plate compactor',
      nextStepRationale: 'search the matching catalog class',
      requiresTools: false,
      toolRequests: [],
      productMentions: [],
      selectionPolicy: {
        targetProductClass: 'виброплита',
        canonicalProductClass: 'plate',
        selectionGoal: 'preliminary_fit',
        needAction: 'continue',
        alternativePolicy: 'same_class_only',
        reusePreviousCards: false,
        maxCards: 4,
        powerSource: 'any',
        phase: 'any',
        requirements: [],
        rationale: 'plate is a known canonical class'
      },
      leadCaptureAuthorization: {
        authorized: false,
        contactSource: 'none',
        handoffKind: 'none',
        purpose: null,
        buyerQuestion: null,
        evidence: null,
        pendingDraftId: null
      },
      policyRuleIds: [],
      mustNotAskQuestionIds: [],
      riskFlags: []
    };

    expect(AgentIntentContractSchema.safeParse(baseIntent).success).toBe(true);
    const { handoffKind: _handoffKind, ...authorizationWithoutKind } = baseIntent.leadCaptureAuthorization;
    expect(AgentIntentContractSchema.safeParse({
      ...baseIntent,
      leadCaptureAuthorization: authorizationWithoutKind
    }).success).toBe(false);
    expect(AgentIntentContractSchema.safeParse({
      ...baseIntent,
      selectionPolicy: {
        ...baseIntent.selectionPolicy,
        canonicalProductClass: 'виброплита'
      }
    }).success).toBe(false);
  });

  it('rejects cross-field lead authorization drift instead of repairing planner meaning', () => {
    const parsed = AgentIntentContractSchema.safeParse({
      userMessageSummary: 'buyer asks how to check delivery',
      dialogueUnderstanding: 'the buyer has not supplied contact details',
      nextStepRationale: 'offer the contact form without claiming a handoff',
      requiresTools: false,
      toolRequests: [],
      leadCaptureAuthorization: {
        authorized: false,
        contactSource: 'current_message',
        handoffKind: 'commercial_followup',
        handoffOfferMessageId: null,
        purpose: 'check delivery',
        buyerQuestion: 'How is delivery checked?',
        evidence: 'the buyer asks about delivery',
        pendingDraftId: null
      },
      policyRuleIds: [],
      mustNotAskQuestionIds: [],
      riskFlags: []
    });

    expect(parsed.success).toBe(false);
  });

  it('requires a scoped draft id before a name-only turn may continue partial lead capture', () => {
    const baseIntent = {
      userMessageSummary: 'buyer supplied the missing name',
      dialogueUnderstanding: 'this continues the pending specialist handoff',
      nextStepRationale: 'complete the same lead draft',
      requiresTools: true,
      toolRequests: [{
        id: 'lead-capture-name',
        tool: 'lead.capture',
        args: { contact: { name: 'Алексей', preferredContact: 'message' } },
        rationale: 'complete the pending contact',
        required: true
      }],
      leadCaptureAuthorization: {
        authorized: true,
        contactSource: 'pending_draft',
        handoffKind: 'technical_followup',
        handoffOfferMessageId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        purpose: 'verify the exact start method',
        buyerQuestion: 'Проверьте, есть ли электростартер',
        evidence: 'Алексей, лучше напишите',
        pendingDraftId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
      },
      mustNotAskQuestionIds: [],
      riskFlags: []
    };

    expect(AgentIntentContractSchema.safeParse(baseIntent).success).toBe(true);
    expect(AgentIntentContractSchema.safeParse({
      ...baseIntent,
      leadCaptureAuthorization: {
        ...baseIntent.leadCaptureAuthorization,
        pendingDraftId: null
      }
    }).success).toBe(false);
    expect(AgentIntentContractSchema.safeParse({
      ...baseIntent,
      leadCaptureAuthorization: {
        ...baseIntent.leadCaptureAuthorization,
        contactSource: 'current_message'
      }
    }).success).toBe(false);
  });

  it('keeps OpenAI structured-output limits aligned with runtime Zod contracts', () => {
    const formats = agentManagerStructuredFormats as any;
    const intent = formats.intentContractFormat.format.schema;
    const toolVariants = intent.properties.toolRequests.items.anyOf as any[];
    const toolArgs = (tool: string) => toolVariants.find((variant) =>
      variant.properties.tool.enum.includes(tool)
    ).properties.args.properties;

    expect(toolArgs('catalog.search').query).toMatchObject({ type: 'string', minLength: 1 });
    expect(toolArgs('catalog.getProductDetails').query.type).toEqual(['string', 'null']);
    const loadKind = toolArgs('calculator.generatorLoad').loads.items.properties.kind;
    expect(loadKind.enum).toBeUndefined();
    expect(loadKind.description).toContain('open semantic identifier');
    const ledgerLoadKind = formats.ledgerDeltaFormat.format.schema.properties.events.items.properties.payload
      .properties.value.anyOf[1].properties.loads.items.properties.kind;
    expect(ledgerLoadKind).toEqual(loadKind);
    expect(toolArgs('catalog.search').comparisonAttributes.maxItems).toBe(12);
    expect(toolArgs('catalog.getProductDetails').productIds.maxItems).toBe(8);
    expect(toolArgs('catalog.getProductDetails').productNames.maxItems).toBe(4);
    expect(toolArgs('catalog.getProductDetails').comparisonAttributes.maxItems).toBe(12);
    expect(toolArgs('calculator.generatorLoad').loads.maxItems).toBe(24);
    expect(toolArgs('calculator.generatorLoad').loads.items.properties.basisSignals.maxItems).toBe(8);
    expect(toolArgs('calculator.generatorLoad').simultaneousStartingKinds.maxItems).toBe(24);
    expect(toolArgs('web.researchProductFacts').productNames.maxItems).toBe(4);
    expect(toolArgs('web.researchProductFacts').comparisonAttributes.maxItems).toBe(12);
    expect(toolVariants[0].properties.coversRequirementIds.maxItems).toBe(40);
    expect(intent.properties.selectionPolicy.properties.maxCards).toMatchObject({
      type: ['integer', 'null'],
      minimum: 0,
      maximum: 8
    });
    expect(intent.properties.selectionPolicy.properties.requirements.maxItems).toBe(40);
    expect(intent.properties.leadCaptureAuthorization.properties.contactSource.enum).toContain('pending_draft');
    expect(intent.properties.leadCaptureAuthorization.properties.handoffKind.enum).toContain('technical_followup');
    expect(intent.properties.leadCaptureAuthorization.required).toEqual(expect.arrayContaining([
      'handoffKind',
      'handoffOfferMessageId',
      'buyerQuestion',
      'pendingDraftId'
    ]));
    expect(intent.properties.grounding.required).toContain('buyerQuestion');
    expect(formats.ledgerDeltaFormat.format.schema.properties.events.maxItems).toBe(40);
    expect(formats.answerContractFormat.format.schema.properties.selectedProductIds.maxItems).toBe(8);
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

  it('defaults omitted product mentions to an empty list', () => {
    const result = AgentIntentContractSchema.parse({
      turnId: 'planner-local-turn-id',
      userMessageSummary: 'buyer asks about generator sizing',
      dialogueUnderstanding: 'the planner did not return product mentions',
      nextStepRationale: 'continue with existing tool decision',
      requiresTools: false,
      toolRequests: [],
      mustNotAskQuestionIds: [],
      riskFlags: []
    });

    expect(result.productMentions).toEqual([]);
    expect(result.grounding).toMatchObject({
      taskType: 'lead_handoff',
      sourcePolicy: 'conversation_only',
      webPurpose: 'none',
      requiredToolKinds: [],
      technicalAttributes: []
    });
  });

  it('parses strict product mention roles from planner output', () => {
    const result = AgentIntentContractSchema.parse({
      turnId: 'planner-local-turn-id',
      userMessageSummary: 'buyer compares exact generator and a pump load',
      dialogueUnderstanding: 'the named generator is the target, and the pump is only load context',
      nextStepRationale: 'verify exact product facts and keep load context separate',
      requiresTools: true,
      toolRequests: [],
      grounding: {
        taskType: 'technical_answer',
        sourcePolicy: 'web_required',
        webPurpose: 'technical_specs',
        requiredToolKinds: ['web.researchProductFacts'],
        technicalAttributes: ['start method'],
        rationale: 'exact generator facts need evidence'
      },
      productMentions: [
        {
          name: 'TSS SGG 10000EHA',
          role: 'target_product',
          productClass: 'generator',
          evidence: 'buyer asked about TSS SGG 10000EHA'
        },
        {
          name: 'pump',
          role: 'context_load_device',
          productClass: null,
          evidence: 'buyer mentioned a pump as load context'
        }
      ],
      mustNotAskQuestionIds: [],
      riskFlags: []
    });

    expect(result.productMentions.map((mention) => mention.role)).toEqual([
      'target_product',
      'context_load_device'
    ]);
    expect(result.grounding.sourcePolicy).toBe('web_required');
  });

  it('rejects unknown product mention roles and extra fields', () => {
    const result = AgentIntentContractSchema.safeParse({
      turnId: 'planner-local-turn-id',
      userMessageSummary: 'buyer mentions products',
      dialogueUnderstanding: 'planner returned an invalid mention role',
      nextStepRationale: 'reject invalid structured data',
      requiresTools: false,
      toolRequests: [],
      productMentions: [{
        name: 'TSS SGG 10000EHA',
        role: 'primary_target',
        evidence: 'buyer mentioned it',
        extra: true
      }],
      mustNotAskQuestionIds: [],
      riskFlags: []
    });

    expect(result.success).toBe(false);
  });

  it('parses typed-tool requirement verification while legacy requirements remain parseable without it', () => {
    const base = {
      userMessageSummary: 'size a generator for simultaneous loads',
      dialogueUnderstanding: 'the operating condition is consumed by a typed load calculation',
      nextStepRationale: 'calculate the deterministic minimum',
      requiresTools: true,
      productMentions: [],
      policyRuleIds: [],
      mustNotAskQuestionIds: [],
      riskFlags: []
    };
    const typed = AgentIntentContractSchema.parse({
      ...base,
      toolRequests: [{
        id: 'load-calculation',
        tool: 'calculator.generatorLoad',
        args: { loads: [] },
        rationale: 'consume simultaneous operation in the calculator',
        required: true,
        coversRequirementIds: ['simultaneous-loads']
      }],
      selectionPolicy: {
        targetProductClass: 'generator',
        canonicalProductClass: 'generator',
        selectionGoal: 'preliminary_fit',
        needAction: 'continue',
        alternativePolicy: 'same_class_only',
        reusePreviousCards: false,
        maxCards: 4,
        powerSource: 'any',
        phase: 'single_phase',
        requirements: [{
          id: 'simultaneous-loads',
          kind: 'generator_load_scenario',
          value: true,
          unit: null,
          relation: 'must_have',
          role: 'hard_constraint',
          strictness: 'strict',
          evidence: 'the two loads run simultaneously',
          verification: {
            mode: 'typed_tool',
            toolRequestId: 'load-calculation',
            tool: 'calculator.generatorLoad',
            verifier: 'generator_load_profile',
            bindAs: 'nominal_power_min_kw'
          }
        }],
        rationale: 'typed derived constraint'
      }
    });
    expect(typed.toolRequests[0]?.coversRequirementIds).toEqual(['simultaneous-loads']);
    expect(typed.selectionPolicy?.requirements[0]?.verification).toMatchObject({ mode: 'typed_tool' });
    expect(typed.selectionPolicy?.selectionGoal).toBe('preliminary_fit');
    expect(typed.selectionPolicy?.requirements[0]?.relation).toBe('must_have');

    const legacy = AgentIntentContractSchema.parse({
      ...base,
      toolRequests: [],
      selectionPolicy: {
        targetProductClass: 'generator',
        canonicalProductClass: 'generator',
        needAction: 'continue',
        alternativePolicy: 'same_class_only',
        reusePreviousCards: false,
        maxCards: 0,
        powerSource: 'any',
        phase: 'any',
        requirements: [{
          id: 'legacy-noise',
          kind: 'noise_max_db',
          value: 60,
          unit: 'dB',
          role: 'hard_constraint',
          strictness: 'strict',
          evidence: 'no more than 60 dB'
        }],
        rationale: 'legacy persisted contract'
      }
    });
    expect(legacy.selectionPolicy?.requirements[0]?.verification).toBeUndefined();
  });

  it('rejects generator load items without executable semantic provenance', () => {
    const result = AgentIntentContractSchema.safeParse({
      userMessageSummary: 'calculate a generator load',
      dialogueUnderstanding: 'the pump power has mixed provenance',
      nextStepRationale: 'run the typed calculator',
      requiresTools: true,
      toolRequests: [{
        id: 'load-calculation',
        tool: 'calculator.generatorLoad',
        args: {
          loads: [{
            kind: 'pump',
            name: 'well pump',
            count: 1,
            runningKw: 0.75,
            startingKw: 2.25,
            source: null,
            runningSource: 'explicit_user',
            startingSource: 'estimated_average',
            operationMode: 'continuous',
            coRunningGroup: null,
            evidence: '750 W well pump',
            basisKind: 'specific_type_or_function',
            basisSignals: ['consumer_type_known', 'voltage_or_phase_known', 'explicit_power']
          }]
        },
        rationale: 'calculate the load',
        required: true,
        coversRequirementIds: []
      }],
      riskFlags: []
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
