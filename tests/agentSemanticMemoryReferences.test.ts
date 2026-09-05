import { beforeEach, describe, expect, it, vi } from 'vitest';

const createStructuredJsonResponse = vi.hoisted(() => vi.fn());
vi.mock('../src/ai/openaiStructured.js', async (original) => ({ ...(await original<typeof import('../src/ai/openaiStructured.js')>()), createStructuredJsonResponse }));

import { AgentSemanticDecisionSchema, normalizeLedgerStateDeltaEvents } from '../src/ai/agentManagerContracts.js';
import { AgentManagerOrchestrator, OpenAIAgentManagerModel, validateAgentSemanticDecision, type AgentManagerReviewInput } from '../src/ai/agentManagerOrchestrator.js';
import { rankCatalogProductsByStructuredPreferences } from '../src/ai/agentManagerCardSelection.js';
import { buildRequirementProofs } from '../src/ai/requirementProofs.js';
import { reduceDialogueLedger } from '../src/ai/dialogueLedgerReducer.js';
import { emptyNeedState } from '../src/ai/needState.js';
import type { Message, Product } from '../src/shared/types.js';

const sessionId = '11111111-1111-4111-8111-111111111111';
const turnId = '22222222-2222-4222-8222-222222222222';
const now = '2026-09-05T16:00:00.000Z';
const session = { id: sessionId, status: 'active' as const, conversationNumber: 1, title: 'Memory test',
  needState: emptyNeedState(), createdAt: now, updatedAt: now, lastHeartbeatAt: now };
const firstMessage = 'Бензиновый генератор, чайник 2 кВт и свет 500 Вт одновременно. Бюджет 55000, розетки 220 В. Небольшой запас; при близкой мощности подешевле.';
const correction = 'Сверил шильдик: чайник 3 кВт, свет 500 Вт, всё одновременно. Бюджет 70000. Эти два генератора теперь подходят?';
const facts = [
  { kind: 'fuel_type', value: 'gasoline', unit: null },
  { kind: 'voltage_v', value: 220, unit: 'V' },
  { kind: 'budget_max_rub', value: 55000, unit: 'RUB' },
  { kind: 'nominal_power_min_kw', value: 2.5, unit: 'kW' },
  { kind: 'nominal_power_preference', value: 'небольшой запас', unit: null, ranking: { attribute: 'nominal_power_kw', direction: 'minimize' } },
  { kind: 'price_preference', value: 'подешевле при близкой мощности', unit: null, ranking: { attribute: 'price_rub', direction: 'minimize' } }
];
function scenario(power: number) {
  return { loads: [{ kind: 'kettle', name: 'чайник', count: 1, runningKw: power, startingKw: power,
    source: 'explicit_user', runningSource: 'explicit_user', startingSource: 'explicit_user', operationMode: 'continuous',
    coRunningGroup: null, evidence: `чайник ${power} кВт`, basisKind: 'exact_power', basisSignals: ['explicit_power'] },
  { kind: 'lighting', name: 'свет', count: 1, runningKw: 0.5, startingKw: 0.5,
    source: 'explicit_user', runningSource: 'explicit_user', startingSource: 'explicit_user', operationMode: 'continuous',
    coRunningGroup: null, evidence: 'свет 500 Вт', basisKind: 'exact_power', basisSignals: ['explicit_power'] }],
  simultaneousRunning: true, simultaneousStarting: true };
}
function initialDecision() {
  return AgentSemanticDecisionSchema.parse({ ledgerDelta: { rationale: 'Store the stated constraints and separate preferences.', events: [
    { eventType: 'need.opened', scope: 'need', payload: { needId: 'generator', productClass: 'generator', activate: true },
      evidence: firstMessage, source: 'llm_state_delta', status: 'active' },
    ...facts.map((fact) => ({ eventType: 'fact.confirmed', scope: 'need', payload: { factKey: fact.kind, value: fact.value,
      unit: fact.unit, needId: 'generator', productClass: 'generator', role: fact.ranking ? 'preference' : 'hard_requirement',
      relation: fact.ranking ? 'preferred' : 'must_have', ranking: fact.ranking ?? null, confidence: 1 },
    evidence: firstMessage, source: 'llm_state_delta', status: 'active' })),
    { eventType: 'fact.confirmed', scope: 'need', payload: { factKey: 'generator_load_scenario', value: scenario(2),
      needId: 'generator', productClass: 'generator', role: 'hard_requirement', confidence: 1 }, evidence: firstMessage,
    source: 'llm_state_delta', status: 'active' }
  ] }, intent: { userMessageSummary: 'Select two generators.', dialogueUnderstanding: 'Concrete 2.5 kW load, limited budget and two preferences.',
    nextStepRationale: 'Calculate and search.', requiresTools: true, toolRequests: [
      { id: 'calc', tool: 'calculator.generatorLoad', args: scenario(2), required: true, rationale: 'Calculate stated load.', coversRequirementIds: ['load'] },
      { id: 'search', tool: 'catalog.search', args: { query: 'бензиновый генератор', canonicalProductIntent: 'generator' }, required: true, rationale: 'Find matching models.' }
    ], productMentions: [], selectionPolicy: { targetProductClass: 'generator', canonicalProductClass: 'generator', needAction: 'open',
      selectionGoal: 'preliminary_fit', alternativePolicy: 'same_class_only', phase: 'single_phase', powerSource: 'fuel',
      reusePreviousCards: false, maxCards: 2, rationale: 'Use explicit constraints.',
      requirements: [...facts.map((fact) => ({ id: fact.kind, kind: fact.kind, value: fact.value, unit: fact.unit,
        role: fact.ranking ? 'preference' : 'hard_constraint', relation: fact.ranking ? 'preferred' : 'must_have',
        strictness: fact.ranking ? 'preferred' : 'strict', evidence: firstMessage, verification: { mode: 'product_attribute' } })),
      { id: 'load', kind: 'generator_load_scenario', value: true, unit: null, role: 'hard_constraint', strictness: 'strict', relation: 'must_have',
        evidence: firstMessage, verification: { mode: 'typed_tool', toolRequestId: 'calc', tool: 'calculator.generatorLoad', verifier: 'generator_load_profile', bindAs: 'nominal_power_min_kw' } }],
      rankingObjectives: facts.filter(f => f.ranking).map(f => ({ requirementId: f.kind, ...f.ranking })) },
    grounding: { taskType: 'product_selection', responseMode: 'recommend', sourcePolicy: 'catalog_required', catalogRequirement: 'required',
      webPurpose: 'none', webRequirement: 'none', buyerRequestedWeb: false, requiredToolKinds: ['calculator.generatorLoad', 'catalog.search'],
      technicalAttributes: [], rationale: 'Catalog and calculation suffice.' } } });
}
const history: Message[] = [{ id: 'previous-selection', sessionId, role: 'assistant', createdAt: now, content: 'Два генератора.', metadata: {
  productCards: [{ id: 'gg3300', name: 'CHAMPION GG3300' }, { id: 'ap3100', name: 'A-iPower LITE AP3100' }],
  intentContract: { selectionPolicy: { canonicalProductClass: 'generator' } }
} }];

async function seed() {
  createStructuredJsonResponse.mockResolvedValueOnce({ parsed: initialDecision() });
  const decision = await new OpenAIAgentManagerModel().decideTurn({ session, history: [], userMessage: firstMessage, ledgerEvents: [], ledgerState: reduceDialogueLedger([]) });
  const validated = validateAgentSemanticDecision({ decision, previousLedgerState: reduceDialogueLedger([]), sessionId, turnId, userMessage: firstMessage });
  expect(validated.issues).toEqual([]);
  return { ledgerState: validated.ledgerState, ledgerEvents: normalizeLedgerStateDeltaEvents({ sessionId, turnId, delta: decision.ledgerDelta }) };
}
function refCorrection(context: any) {
  const refs = context.memoryReferences.facts;
  const ref = (kind: string) => refs.find((item: any) => item.factKey === kind).factRef;
  const wire: any = structuredClone(initialDecision());
  wire.ledgerDelta = { rationale: 'Update only load and budget, retain other constraints and preferences.', events: [], memoryActions: [
    ...['fuel_type', 'voltage_v', 'nominal_power_preference', 'price_preference'].map(kind => ({ factRef: ref(kind), action: 'retain' })),
    ...[{ kind: 'budget_max_rub', value: 70000, unit: 'RUB', evidence: 'Бюджет 70000' },
      { kind: 'nominal_power_min_kw', value: 3.5, unit: 'kW', evidence: 'чайник 3 кВт, свет 500 Вт' },
      { kind: 'generator_load_scenario', value: scenario(3), unit: null, evidence: 'чайник 3 кВт, свет 500 Вт, всё одновременно' }]
      .map(item => ({ factRef: ref(item.kind), action: 'update', value: item.value, unit: item.unit, relation: 'must_have', ranking: null, evidence: item.evidence }))
  ] };
  wire.intent.selectionPolicy.needAction = 'continue';
  wire.intent.selectionPolicy.requirements = refs.filter((item: any) => item.needId === 'generator').map((item: any) => ({
    factRef: item.factRef, verification: item.factKey === 'generator_load_scenario'
      ? { mode: 'typed_tool', toolRequestId: 'calc', tool: 'calculator.generatorLoad', verifier: 'generator_load_profile', bindAs: 'nominal_power_min_kw' }
      : { mode: 'product_attribute' }
  }));
  wire.intent.selectionPolicy.rankingObjectives = ['price_preference', 'nominal_power_preference'].map(kind => ({ factRef: ref(kind) }));
  wire.intent.toolRequests[0].args = scenario(3);
  wire.intent.toolRequests[0].coversRequirementIds = [ref('generator_load_scenario')];
  wire.intent.productMentions = context.memoryReferences.productTargets.map((target: any) => ({
    targetRef: target.targetRef, role: 'catalog_candidate', evidence: 'Эти два генератора'
  }));
  return wire;
}

describe('initial semantic producer memory references', () => {
  beforeEach(() => { createStructuredJsonResponse.mockReset(); });

  it('runs two producer turns and preserves preference identities while correcting load and budget', async () => {
    const state = await seed();
    createStructuredJsonResponse.mockImplementationOnce(async ({ request }) => {
      const context = JSON.parse(request.input.find((x: any) => x.role === 'user').content);
      return { parsed: refCorrection(context) };
    });
    const decision = await new OpenAIAgentManagerModel().decideTurn({ session, history, userMessage: correction, ...state });
    const validation = validateAgentSemanticDecision({ decision, previousLedgerState: state.ledgerState, sessionId, turnId,
      history, userMessage: correction });
    expect(validation.issues).toEqual([]);
    expect(decision.intent.selectionPolicy!.requirements).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'budget_max_rub', value: 70000 }),
      expect.objectContaining({ kind: 'nominal_power_min_kw', value: 3.5 }),
      expect.objectContaining({ kind: 'nominal_power_preference', value: 'небольшой запас' }),
      expect.objectContaining({ kind: 'price_preference', value: 'подешевле при близкой мощности' })
    ]));
    expect(decision.intent.selectionPolicy!.rankingObjectives!.map(x => x.attribute)).toEqual(['price_rub', 'nominal_power_kw']);
    expect(decision.intent.productMentions).toEqual(history[0]!.metadata.productCards instanceof Array
      ? history[0]!.metadata.productCards.map((card: any) => ({ name: card.name, productClass: 'generator', role: 'catalog_candidate',
        evidence: 'Эти два генератора', sourceMessageId: history[0]!.id })) : []);
    expect(JSON.stringify(decision)).not.toContain('memoryActions');
    expect(createStructuredJsonResponse).toHaveBeenCalledTimes(2);
  });

  it('repairs a duplicate reference write inside the existing generation loop before applying any delta', async () => {
    const state = await seed();
    const checkpoints: unknown[] = [], traces: unknown[] = [], writes: any[] = [];
    const user = { id: '33333333-3333-4333-8333-333333333333', sessionId, role: 'user' as const,
      content: correction, metadata: {}, createdAt: now };
    let currentTurn: any = { id: turnId, sessionId, userMessageId: user.id, assistantMessageId: null, status: 'received',
      requestHash: 'memory-repair', createdAt: now, updatedAt: now };
    const messages: Message[] = [...history, user];
    const conversations = { getSession: async () => session, listMessages: async () => messages, getTurn: async () => currentTurn,
      updateTurn: async (input: any) => (currentTurn = { ...currentTurn, ...input }),
      addUserMessageForTurn: async () => user, getFinalAnswerContract: async () => null,
      listTurnCheckpoints: async () => checkpoints, upsertTurnCheckpoint: async (input: any) => (checkpoints.push(input), input),
      listDialogueLedgerEvents: async () => state.ledgerEvents.map(event => ({ session_id: event.sessionId, turn_id: event.turnId,
        event_id: event.eventId, event_type: event.eventType, scope: event.scope, payload: event.payload,
        source: event.source, evidence: event.evidence, status: event.status })),
      upsertDialogueLedgerEvent: async (input: any) => (writes.push(input), input),
      listToolArtifacts: async () => [], saveAnswerContract: async () => null,
      addAgentTrace: async (input: any) => traces.push(input),
      addAssistantMessageForTurn: async (input: any) => {
        const assistant = { id: '44444444-4444-4444-8444-444444444444', sessionId, role: 'assistant' as const,
          content: input.content, metadata: input.metadata, createdAt: now };
        messages.push(assistant); currentTurn = { ...currentTurn, status: 'completed', assistantMessageId: assistant.id }; return assistant;
      } };
    let attempt = 0;
    createStructuredJsonResponse.mockImplementation(async ({ request }) => {
      const context = JSON.parse(request.input.find((x: any) => x.role === 'user').content);
      const wire = refCorrection(context);
      if (++attempt === 1) wire.ledgerDelta.events.push({ eventType: 'fact.confirmed', scope: 'need',
        payload: { factKey: 'budget_max_rub', value: 70000, unit: 'RUB', needId: 'generator', role: 'hard_requirement' },
        evidence: 'Бюджет 70000', source: 'llm_state_delta', status: 'active' });
      else {
        expect(writes).toEqual([]);
        expect(context.semanticReferenceRepairs).toEqual([expect.objectContaining({
          factRef: 'generator::budget_max_rub', inlineEventPolicy: 'new_facts_only', memoryActionPolicy: 'one_action_for_existing_fact'
        })]);
        expect(request.input.find((x: any) => x.role === 'system').content).toContain('duplicate_memory_fact_write');
      }
      wire.intent.requiresTools = false; wire.intent.toolRequests = [];
      wire.intent.selectionPolicy.maxCards = 0;
      wire.intent.selectionPolicy.requirements = wire.intent.selectionPolicy.requirements.filter((r: any) => !r.factRef.endsWith('::generator_load_scenario'));
      Object.assign(wire.intent.grounding, { taskType: 'technical_answer', responseMode: 'answer', sourcePolicy: 'conversation_only',
        catalogRequirement: 'none', requiredToolKinds: [] });
      return { parsed: wire };
    });
    class RepairModel extends OpenAIAgentManagerModel {
      override async composeAnswer() { return { answerText: 'Новые условия учёл.', factsUsed: [], questionsAsked: [],
        selectedProductIds: [], toolResultIds: [], leadAction: 'none' as const, riskFlags: [] }; }
      override async reviewCustomerLanguage() { return { processDisclosure: false, evidence: '', rationale: 'No disclosure.', factualIssues: [] }; }
    }
    const result = await new AgentManagerOrchestrator(conversations as never, {} as never, {} as never, new RepairModel())
      .generateAnswer({ sessionId, turnId, userMessage: correction });
    expect(result.answer).toBe('Новые условия учёл.');
    expect(attempt).toBe(2);
    expect(writes.filter(write => write.payload.factKey === 'budget_max_rub')).toHaveLength(1);
    expect(traces).toContainEqual(expect.objectContaining({ eventType: 'semantic_decision_schema_invalid' }));
  });

  it.each(['unknown fact', 'duplicate action', 'retain with changed value', 'retain plus inline write', 'update without current evidence',
    'retract without current evidence', 'unknown target', 'historical evidence quote'])(
    'rejects %s at the public producer boundary', async (attack) => {
      const state = await seed();
      createStructuredJsonResponse.mockImplementationOnce(async ({ request }) => {
        const context = JSON.parse(request.input.find((x: any) => x.role === 'user').content);
        const wire = refCorrection(context);
        const actions = wire.ledgerDelta.memoryActions;
        if (attack === 'unknown fact') actions[0].factRef = 'foreign-session::budget_max_rub';
        if (attack === 'duplicate action') actions.push(structuredClone(actions[0]));
        if (attack === 'retain with changed value') actions[0].value = 'diesel';
        if (attack === 'retain plus inline write') wire.ledgerDelta.events.push({ eventType: 'fact.confirmed', scope: 'need',
          payload: { factKey: 'fuel_type', value: 'diesel', needId: 'generator', role: 'hard_requirement' },
          evidence: correction, source: 'llm_state_delta', status: 'active' });
        if (attack === 'update without current evidence') actions[4].evidence = 'not present in this buyer turn';
        if (attack === 'retract without current evidence') actions[0] = { factRef: actions[0].factRef, action: 'retract', evidence: 'old quote only' };
        if (attack === 'unknown target') wire.intent.productMentions[0].targetRef = 'target:invented';
        if (attack === 'historical evidence quote') wire.intent.productMentions[0].evidence = 'CHAMPION GG3300';
        return { parsed: wire };
      });
      await expect(new OpenAIAgentManagerModel().decideTurn({ session, history, userMessage: correction, ...state })).rejects.toThrow();
    }
  );

  it('updates and retracts explicitly changed preferences without retaining their old values or ranking', async () => {
    const state = await seed();
    const userMessage = `${correction} Теперь хочу больше мощности, цену пока не учитывайте.`;
    createStructuredJsonResponse.mockImplementationOnce(async ({ request }) => {
      const context = JSON.parse(request.input.find((x: any) => x.role === 'user').content);
      const wire = refCorrection(context);
      const price = context.memoryReferences.facts.find((f: any) => f.factKey === 'price_preference').factRef;
      wire.ledgerDelta.memoryActions = wire.ledgerDelta.memoryActions.map((action: any) => action.factRef === price
        ? { factRef: price, action: 'retract', evidence: 'цену пока не учитывайте' }
        : action.factRef.endsWith('::nominal_power_preference')
          ? { factRef: action.factRef, action: 'update', value: 'больше мощности', unit: null, relation: 'preferred',
            ranking: { attribute: 'nominal_power_kw', direction: 'maximize' }, evidence: 'хочу больше мощности' } : action);
      wire.intent.selectionPolicy.requirements = wire.intent.selectionPolicy.requirements.filter((r: any) => r.factRef !== price);
      wire.intent.selectionPolicy.rankingObjectives = wire.intent.selectionPolicy.rankingObjectives.filter((r: any) => r.factRef !== price);
      return { parsed: wire };
    });
    const decision = await new OpenAIAgentManagerModel().decideTurn({ session, history, userMessage, ...state });
    const validation = validateAgentSemanticDecision({ decision, previousLedgerState: state.ledgerState, sessionId, turnId, history, userMessage });
    expect(validation.issues).toEqual([]);
    expect(decision.intent.selectionPolicy!.rankingObjectives).toEqual([{ requirementId: 'generator::nominal_power_preference', attribute: 'nominal_power_kw', direction: 'maximize' }]);
    expect(validation.ledgerState.factsByKey['generator::price_preference']!.status).toBe('negated');
  });

  it('does not apply a dormant other-need requirement to the currently selected product class', async () => {
    const state = await seed();
    const extra = normalizeLedgerStateDeltaEvents({ sessionId, turnId, delta: { rationale: 'Separate plate budget.', events: [
      { eventType: 'need.opened', scope: 'need', payload: { needId: 'plate', productClass: 'plate', activate: false }, evidence: 'A separate plate need.', source: 'llm_state_delta', status: 'active' },
      { eventType: 'fact.confirmed', scope: 'need', payload: { factKey: 'budget_max_rub', value: 10000, unit: 'RUB',
        needId: 'plate', productClass: 'plate', role: 'hard_requirement', confidence: 1 }, evidence: 'Plate budget 10000.', source: 'llm_state_delta', status: 'active' }
    ] } });
    state.ledgerEvents.push(...extra);
    state.ledgerState = reduceDialogueLedger(extra, state.ledgerState);
    createStructuredJsonResponse.mockImplementationOnce(async ({ request }) => {
      const context = JSON.parse(request.input.find((x: any) => x.role === 'user').content);
      const wire = refCorrection(context);
      wire.intent.selectionPolicy.requirements.push({ factRef: 'plate::budget_max_rub', verification: { mode: 'product_attribute' } });
      return { parsed: wire };
    });
    await expect(new OpenAIAgentManagerModel().decideTurn({ session, history, userMessage: correction, ...state })).rejects.toThrow('memory_requirement_scope_mismatch');
  });

  it('does not contradict explicit ranking order in planner or writer instructions', async () => {
    const state = await seed();
    const plannerPrompt = createStructuredJsonResponse.mock.calls[0]![0].request.input.find((x: any) => x.role === 'system').content;
    createStructuredJsonResponse.mockRejectedValueOnce(new Error('capture writer request'));
    await expect(new OpenAIAgentManagerModel().composeAnswer({ session, history, userMessage: correction, ...state,
      intent: initialDecision().intent, products: [], toolResults: [] })).rejects.toThrow('capture writer request');
    const writerPrompt = createStructuredJsonResponse.mock.calls[1]![0].request.input.find((x: any) => x.role === 'system').content;
    for (const prompt of [plannerPrompt, writerPrompt]) {
      expect(prompt).toContain('порядок rankingObjectives');
      expect(prompt).not.toContain('первая карточка — минимальный номинал');
      expect(prompt).not.toContain('Первая карточка всегда ближайший');
      expect(prompt).not.toContain('fit = сначала минимальное превышение');
    }
  });

  it.each(['price', 'nominal'] as const)('honors %s priority at the final review boundary while preserving the capacity minimum', async (priority) => {
    const intent = initialDecision().intent;
    if (priority === 'price') intent.selectionPolicy!.rankingObjectives!.reverse();
    const makeProduct = (id: string, nominal: number, price: number): Product => ({ id, name: `Generator ${id}`, brand: 'TEST',
      category: 'Generators', price, currency: 'RUB', sourceUrl: `https://example.test/${id}`, specs: {
        'Nominal power': `${nominal} kW`, 'вид топлива': 'бензиновые', 'напряжение, в': '230В', 'число фаз': 'однофазные' } });
    const small = makeProduct('closer-expensive', 2.6, 30000), large = makeProduct('larger-cheaper', 6, 20000),
      inadequate = makeProduct('underpowered', 2, 10000);
    const products = [small, large];
    const ranked = rankCatalogProductsByStructuredPreferences({ products, intent });
    expect(ranked[0]!.id).toBe(priority === 'price' ? large.id : small.id);
    const toolResults: AgentManagerReviewInput['toolResults'] = [
      { requestId: 'search', tool: 'catalog.search', status: 'ok', payload: { products: [...products, inadequate] }, warnings: [] },
      { requestId: 'calc', tool: 'calculator.generatorLoad', status: 'ok', payload: { profile: { requiredNominalKw: 2.5 } }, warnings: [] }
    ];
    const proofs = buildRequirementProofs({ products: [...products, inadequate], intent, toolResults });
    expect(proofs).toContainEqual(expect.objectContaining({ productId: large.id, requirementId: 'nominal_power_min_kw', status: 'satisfied' }));
    expect(proofs).toContainEqual(expect.objectContaining({ productId: inadequate.id, requirementId: 'nominal_power_min_kw', status: 'violated' }));
    const orchestrator = new AgentManagerOrchestrator({} as never, {} as never, {} as never,
      { reviewCustomerLanguage: async () => ({ processDisclosure: false, evidence: '', rationale: 'No disclosure.' }) } as never);
    const review = await (orchestrator as unknown as { review(input: AgentManagerReviewInput): Promise<{ issues: Array<{ code: string }> }> }).review({
      session, history, userMessage: 'Цена важнее лишней мощности.', ledgerEvents: [], ledgerState: reduceDialogueLedger([]), intent, products, toolResults,
      answer: { answerText: 'Этот вариант дешевле и покрывает указанную нагрузку.', factsUsed: [], questionsAsked: [],
        selectedProductIds: [large.id], selectionRationale: 'Цена ниже при достаточной мощности.', toolResultIds: ['search', 'calc'],
        leadAction: 'none', riskFlags: [] }
    });
    expect(review.issues.some(issue => issue.code === 'generator_selection_grossly_oversized')).toBe(priority === 'nominal');
  });
});
