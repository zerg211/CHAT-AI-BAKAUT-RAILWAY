import { beforeEach, describe, expect, it, vi } from 'vitest';

const createStructuredJsonResponse = vi.hoisted(() => vi.fn());

vi.mock('../src/ai/openaiStructured.js', () => ({
  createStructuredJsonResponse
}));

import { OpenAIAgentManagerModel, type AgentManagerAnswerInput } from '../src/ai/agentManagerOrchestrator.js';
import { AgentManagerTurnBudget } from '../src/ai/agentManagerTurnBudget.js';
import { continuationValidationIssues } from '../src/ai/agentManagerContinuation.js';
import { getActiveDialogueNeed, reduceDialogueLedger } from '../src/ai/dialogueLedgerReducer.js';
import { emptyNeedState } from '../src/ai/needState.js';
import { AgentIntentContractSchema, normalizeLedgerStateDeltaEvents, type AgentIntentContract, type DialogueLedgerEvent, type LedgerStateDelta } from '../src/ai/agentManagerContracts.js';
import type { ConversationSession, Message, VerifiedProductFact } from '../src/shared/types.js';

describe('OpenAIAgentManagerModel semantic inputs', () => {
  beforeEach(() => {
    createStructuredJsonResponse.mockReset();
  });

  it.each([{ requirementIds: [] as string[] }, { requirementIds: ['req-noise'] }])('binds observation requirement references to the current IDs $requirementIds while allowing technical research', async ({ requirementIds }) => {
    const product = { id: 'exact-tss', name: 'ТСС SGG 5000N', specs: {} };
    const intent = AgentIntentContractSchema.parse({ userMessageSummary: 'First startup questions',
      dialogueUnderstanding: 'Read the exact model instructions', nextStepRationale: 'Resolve missing facts',
      requiresTools: true, toolRequests: [{ id: 'initial-details', tool: 'catalog.getProductDetails',
        args: { productIds: [product.id], canonicalProductIntent: 'generator' }, required: true, rationale: 'Get catalog facts', coversRequirementIds: [] }],
      selectionPolicy: { targetProductClass: 'generator', canonicalProductClass: 'generator', needAction: 'continue', alternativePolicy: 'same_class_only',
        reusePreviousCards: false, maxCards: 0, powerSource: 'any', phase: null, rationale: 'Technical consultation',
        requirements: requirementIds.map((id) => ({ id, kind: 'noise_db_max', value: 70, unit: 'dB', role: 'hard_constraint',
          strictness: 'strict', relation: 'must_have', evidence: 'up to 70 dB', verification: { mode: 'product_attribute' } })) },
      grounding: { taskType: 'technical_answer', responseMode: 'answer', sourcePolicy: 'conversation_only', webPurpose: 'none',
        requiredToolKinds: [], technicalAttributes: ['battery_required', 'engine_oil_type', 'first_start_procedure'], rationale: 'Exact model guidance' }
    });
    const decision = { action: 'continue', rationale: 'The instruction still has unresolved startup facts.',
      missingFacts: ['battery_required', 'first_start_procedure'], candidateProductIds: [product.id],
      toolRequests: [{ id: 'manual-next', tool: 'web.researchProductFacts', required: true, rationale: 'Read the exact manual',
        coversRequirementIds: requirementIds, args: { query: 'Exact model first startup', productNames: [product.name],
          canonicalProductIntent: 'generator', comparisonAttributes: ['battery_required', 'first_start_procedure'] } }] };
    createStructuredJsonResponse.mockResolvedValueOnce({ parsed: decision });
    const input = { session: { needState: emptyNeedState() }, userMessage: 'How to start it safely?', history: [],
      ledgerEvents: [], ledgerState: reduceDialogueLedger([]), intent, products: [product], toolResults: [],
      round: 1, remainingBudget: new AgentManagerTurnBudget().snapshot() };
    const result = await new OpenAIAgentManagerModel().assessObservations(input as never);
    const request = createStructuredJsonResponse.mock.calls[0]![0].request;
    for (const variant of request.text.format.schema.properties.toolRequests.items.anyOf) {
      const coverage = variant.properties.coversRequirementIds;
      if (requirementIds.length) expect(coverage.items.enum).toEqual(requirementIds);
      else expect(coverage.maxItems).toBe(0);
    }
    const data = JSON.parse(request.input.find((item: { role: string }) => item.role === 'user').content);
    expect(data.allowedRequirementIds).toEqual(requirementIds);
    expect(data.intent.grounding.technicalAttributes).toEqual(intent.grounding!.technicalAttributes);
    expect(continuationValidationIssues({ decision: result, intent, products: [product] })).toEqual([]);
    expect(result).toMatchObject({ action: 'continue', toolRequests: [{ tool: 'web.researchProductFacts', coversRequirementIds: requirementIds }] });
  });

  it('semantically classifies paraphrased internal research-process disclosure', async () => {
    createStructuredJsonResponse.mockResolvedValueOnce({
      parsed: {
        processDisclosure: true,
        evidence: 'Я обращался к доступным источникам',
        rationale: 'The answer describes how information was sought.',
        factualIssues: []
      }
    });

    const review = await new OpenAIAgentManagerModel().reviewCustomerLanguage({
      answerText: 'Я обращался к доступным источникам, но они не дали результата.',
      products: [],
      toolResults: []
    });

    expect(review.processDisclosure).toBe(true);
    expect(createStructuredJsonResponse).toHaveBeenCalledWith(expect.objectContaining({
      stage: 'agent_customer_language_review',
      transportMaxRetries: 0
    }));
    const request = createStructuredJsonResponse.mock.calls[0]?.[0]?.request as {
      input?: Array<{ role?: string; content?: string }>;
    };
    expect(request.input?.find((item) => item.role === 'system')?.content).toContain('при любой формулировке');
  });

  it('reviews grounded factual polarity using source-bound findings in the existing review call', async () => {
    const finding = { claim: 'The model has a manual starter.', sourceResultId: 'manual-read', reason: 'The exact model source confirms absence.' };
    createStructuredJsonResponse.mockResolvedValueOnce({ parsed: { processDisclosure: false, evidence: '', rationale: 'Fact polarity mismatch.', factualIssues: [finding] } });
    const review = await new OpenAIAgentManagerModel().reviewCustomerLanguage({
      answerText: finding.claim,
      products: [{ id: 'model-1', name: 'Exact model X100', specs: {} }],
      toolResults: [{
        requestId: 'manual-read', tool: 'web.researchProductFacts', status: 'ok', warnings: [],
        payload: { facts: [{ productName: 'Exact model X100', attribute: 'manual starter', value: 'absent', evidence: 'No recoil starter is fitted.' }] }
      }]
    });
    expect(review.factualIssues).toEqual([finding]);
    expect(createStructuredJsonResponse).toHaveBeenCalledTimes(1);
    const request = createStructuredJsonResponse.mock.calls[0]![0].request;
    const input = JSON.parse(request.input.find((item: { role: string }) => item.role === 'user').content);
    expect(input.toolResults).toEqual(expect.arrayContaining([expect.objectContaining({ requestId: 'manual-read' })]));
    expect(request.text.format.schema.properties.factualIssues.items.properties.sourceResultId.enum).toEqual(['manual-read']);
  });

  it('returns only structured verified-memory bindings for semantic attribute aliases', async () => {
    createStructuredJsonResponse.mockResolvedValueOnce({
      parsed: {
        matches: [{
          factId: 'fact-bison-usb',
          productName: 'BISON BS6250IE',
          attribute: 'usb_output_current'
        }]
      }
    });
    const now = new Date().toISOString();
    const fact: VerifiedProductFact = {
      id: 'fact-bison-usb',
      productId: null,
      productKey: 'bison bs6250ie',
      productName: 'BISON BS6250IE',
      attribute: 'usb_supported_current',
      value: '1 A и 2.1 A при 5 V',
      sourceType: 'web',
      sourceUrl: 'https://bisonpower.net/generator/inverter-generator/BS6250IE.html',
      sourceTitle: 'BISON BS6250IE specifications',
      evidence: 'DC USB output5V/1A/2.1A',
      sourceTier: 'official_page',
      sourceAuthority: 'manufacturer',
      observedAt: now,
      confidence: 'high',
      status: 'active',
      firstSeenAt: now,
      lastVerifiedAt: now,
      hitCount: 0,
      createdAt: now,
      updatedAt: now
    };

    const matches = await new OpenAIAgentManagerModel().matchVerifiedFactMemory({
      facts: [fact],
      requestedFactSlots: [{ productName: 'BISON BS6250IE', attribute: 'usb_output_current' }]
    });

    expect(matches).toEqual([{
      factId: 'fact-bison-usb',
      productName: 'BISON BS6250IE',
      attribute: 'usb_output_current'
    }]);
    expect(createStructuredJsonResponse).toHaveBeenCalledWith(expect.objectContaining({
      stage: 'verified_fact_memory_semantic_match',
      transportMaxRetries: 0
    }));
    const request = createStructuredJsonResponse.mock.calls[0][0].request;
    expect(request.text.format.schema.properties.matches.items.properties.factId.enum).toEqual(['fact-bison-usb']);
    expect(request.input[0].content).toContain('Related, broader, narrower');
    expect(request.input[0].content).toContain('untrusted quoted data');
  });

  it.each(['verified', 'conflicting'] as const)('carries %s exact-model saved evidence through observation, writer schema and factual review without a separate matching call', async (kind) => {
    const now = new Date().toISOString();
    const fact: VerifiedProductFact = {
      id: 'saved-force', productId: 'champion-pc5431f', productKey: 'championpc5431f', productName: 'CHAMPION PC5431F',
      attribute: 'centrifugal_force_kn', value: '8.2 kN', sourceType: 'web', confidence: 'high', status: 'active',
      sourceUrl: 'https://www.champion-tools.ru/shop/vibroplity/champion-pc5431f/',
      sourceTitle: 'CHAMPION PC5431F specifications', evidence: 'Centrifugal force 8.2 kN',
      firstSeenAt: now, lastVerifiedAt: now, createdAt: now, updatedAt: now, hitCount: 0
    };
    const userMessage = 'Remind me of its compaction force.';
    const input: AgentManagerAnswerInput = {
      session: { id: 'session', status: 'active', conversationNumber: 1, title: 'Plate', needState: emptyNeedState(),
        createdAt: now, updatedAt: now, lastHeartbeatAt: now },
      history: [], userMessage, ledgerEvents: [], ledgerState: reduceDialogueLedger([]),
      intent: AgentIntentContractSchema.parse({ userMessageSummary: userMessage, dialogueUnderstanding: 'Recall the selected model fact.',
        nextStepRationale: 'Use exact saved evidence.', requiresTools: false, toolRequests: [], riskFlags: [] }),
      products: [{ id: fact.productId!, name: fact.productName, specs: { weight_kg: 50 } }],
      toolResults: [], verifiedProductFacts: kind === 'verified' ? [fact] : [],
      conflictingVerifiedProductFacts: kind === 'conflicting' ? [fact, { ...fact, id: 'conflicting-force', value: '18 kN' }] : []
    };
    const answer = { answerText: 'Its compaction force is 8.2 kN.',
      factsUsed: kind === 'verified' ? [{ factKey: 'compaction_force', value: fact.value, sourceEventIds: ['verified_fact:saved-force'] }] : [],
      questionsAsked: [], toolResultIds: [], selectedProductIds: [], selectionRationale: 'Technical recap needs no card.', leadAction: 'none', riskFlags: [] };
    createStructuredJsonResponse
      .mockResolvedValueOnce({ parsed: { action: 'answer', rationale: 'The saved canonical attribute answers this wording.',
        missingFacts: [], candidateProductIds: [], toolRequests: [] } })
      .mockResolvedValueOnce({ parsed: answer })
      .mockResolvedValueOnce({ parsed: { processDisclosure: false, evidence: '', rationale: 'The exact-model fact supports the answer.', factualIssues: [] } });
    const model = new OpenAIAgentManagerModel();
    await model.assessObservations({ ...input, round: 1, remainingBudget: new AgentManagerTurnBudget().snapshot() });
    expect(await model.composeAnswer(input)).toMatchObject(answer);
    await model.reviewCustomerLanguage({ ...input, answerText: answer.answerText });

    expect(createStructuredJsonResponse.mock.calls.map(([call]) => call.stage)).toEqual([
      'agent_observation_decision', 'agent_answer_contract', 'agent_customer_language_review'
    ]);
    for (const [call] of createStructuredJsonResponse.mock.calls) {
      const data = JSON.parse(call.request.input.find((item: { role: string }) => item.role === 'user').content);
      const semanticFacts = (facts: VerifiedProductFact[]) => facts.map(({ hitCount, firstSeenAt, createdAt, updatedAt, catalogSourceHash, sourceFingerprint, ...evidence }) => evidence);
      expect(data.verifiedProductFacts).toEqual(semanticFacts(input.verifiedProductFacts ?? []));
      expect(data.conflictingVerifiedProductFacts).toEqual(semanticFacts(input.conflictingVerifiedProductFacts ?? []));
      expect(data.toolResults).toEqual([]);
    }
    const writer = createStructuredJsonResponse.mock.calls[1]![0].request;
    expect(writer.text.format.schema.properties.factsUsed.items.properties.sourceEventIds.items.enum)
      .toEqual(kind === 'verified' ? ['verified_fact:saved-force'] : undefined);
    if (kind === 'conflicting') {
      expect(writer.text.format.schema.properties.factsUsed.items.properties.sourceEventIds.maxItems).toBe(0);
    }
    const reviewer = createStructuredJsonResponse.mock.calls[2]![0].request;
    expect(reviewer.text.format.schema.properties.factualIssues.maxItems).toBe(5);
    expect(reviewer.text.format.schema.properties.factualIssues.items.properties.sourceResultId.enum)
      .toEqual(kind === 'verified' ? ['verified_fact:saved-force'] : ['verified_fact:saved-force', 'verified_fact:conflicting-force']);
  });

  it('shares full web product descriptions once across observation, answer and review without truncating source evidence', async () => {
    const product = { id: 'exact-product', name: 'Exact model', specs: { oil: '10W-30' },
      description: `${'Source description. '.repeat(100)}CRITICAL_SOURCE_TAIL`, raw: { manualNote: 'Do not fit a battery.' } };
    const toolResults = ['web-one', 'web-two'].map((requestId) => ({ requestId, tool: 'web.researchProductFacts' as const,
      status: 'ok' as const, warnings: [], payload: { products: [structuredClone(product)], facts: [] } }));
    const input = { session: { needState: emptyNeedState() }, history: [], userMessage: 'How to start it?', ledgerEvents: [],
      ledgerState: reduceDialogueLedger([]), products: [product], toolResults, verifiedProductFacts: [],
      intent: AgentIntentContractSchema.parse({ userMessageSummary: 'Startup', dialogueUnderstanding: 'Exact model',
        nextStepRationale: 'Read the source.', requiresTools: false, toolRequests: [], riskFlags: [] }),
      round: 1, remainingBudget: new AgentManagerTurnBudget().snapshot(), answerText: 'Use the manual starter.' };
    const original = structuredClone(input);
    createStructuredJsonResponse.mockRejectedValue(new Error('offline capture'));
    const model = new OpenAIAgentManagerModel();
    for (const method of ['assessObservations', 'composeAnswer', 'reviewCustomerLanguage'] as const) {
      await expect((model[method] as (input: unknown) => Promise<unknown>)(input)).rejects.toThrow('offline capture');
      const request = createStructuredJsonResponse.mock.calls.at(-1)![0].request;
      const content = request.input.find((item: { role: string }) => item.role === 'user').content;
      const data = JSON.parse(content);
      expect(content.split('CRITICAL_SOURCE_TAIL')).toHaveLength(2);
      expect(data.products[0]).toMatchObject({ description: product.description, raw: product.raw });
      expect(data.toolResults.every((result: { payload: Record<string, unknown> }) => !('products' in result.payload))).toBe(true);
      expect(data.toolResults.map((result: { payload: Record<string, unknown> }) => result.payload.productIds))
        .toEqual([[product.id], [product.id]]);
    }
    expect(input).toEqual(original);
  });

  it('creates ledger delta and executable intent in one structured semantic request', async () => {
    const now = new Date('2026-08-13T10:00:00.000Z').toISOString();
    const session: ConversationSession = {
      id: '11111111-1111-4111-8111-111111111111',
      status: 'active',
      conversationNumber: 1,
      title: 'Dialog #1',
      needState: emptyNeedState(),
      createdAt: now,
      updatedAt: now,
      lastHeartbeatAt: now
    };
    const history: Message[] = Array.from({ length: 20 }, (_, index) => ({
      id: `${String(index + 1).padStart(8, '0')}-1111-4111-8111-111111111111`,
      sessionId: session.id,
      role: index % 2 ? 'assistant' as const : 'user' as const,
      content: `message-${index + 1}`,
      metadata: {},
      createdAt: now
    }));
    history[1]!.metadata = { productCards: [], intentContract: { productMentions: [
      { name: 'ТСС SGG 5000N, артикул 060007', role: 'target_product', productClass: 'generator', evidence: 'ТСС SGG 5000N' },
      { name: 'Consumer MODEL 100', role: 'context_load_device', productClass: null, evidence: 'Consumer MODEL 100' }
    ] } };
    createStructuredJsonResponse.mockResolvedValueOnce({
      parsed: {
        ledgerDelta: { rationale: 'preserve the current need', events: [] },
        intent: {
          userMessageSummary: 'continue the current need',
          dialogueUnderstanding: 'the current turn has one coherent interpretation',
          nextStepRationale: 'answer without tools',
          requiresTools: false,
          toolRequests: [],
          riskFlags: []
        }
      }
    });

    const rejectedSemanticDecision = {
      ledgerDelta: { rationale: 'rejected interpretation', events: [] },
      intent: {
        userMessageSummary: 'rejected summary',
        dialogueUnderstanding: 'rejected understanding',
        nextStepRationale: 'rejected next step',
        requiresTools: false,
        toolRequests: [],
        riskFlags: []
      }
    };
    const decision = await (new OpenAIAgentManagerModel() as OpenAIAgentManagerModel & {
      decideTurn(input: unknown): Promise<{ ledgerDelta: unknown; intent: unknown }>;
    }).decideTurn({
      session,
      history,
      userMessage: history.at(-1)!.content,
      ledgerEvents: [],
      ledgerState: reduceDialogueLedger([]),
      rejectedSemanticDecision,
      semanticValidationIssues: [
        'required_catalog_tool_missing',
        'conditional_research_plan_missing',
        'generator_load_source_missing:1',
        'generator_load_scenario_load_semantics_mismatch:pump:well pump',
        'typed_requirement_coverage_missing:req_load:calc_load',
        'strict_requirement_shape_invalid:req_nominal:invalid_numeric_value',
        'active_requirement_mismatch:pump_rated_power_kw',
        'product_mention_evidence_not_in_current_message:0',
        'opened_need_action_mismatch:continue',
        'opened_need_product_class_mismatch:unknown:plate',
        'required_tool_request_missing:lead.capture',
        'catalog_tool_product_class_mismatch:mat_search:plateAccessory:plate',
        'required_primary_catalog_tool_missing:plate'
      ],
      semanticValidationIssueHistory: [
        'active_requirement_mismatch:generator_load_scenario'
      ]
    });

    expect(decision).toMatchObject({
      ledgerDelta: { events: [] },
      intent: { userMessageSummary: 'continue the current need' }
    });
    expect(createStructuredJsonResponse).toHaveBeenCalledTimes(1);
    expect(createStructuredJsonResponse.mock.calls[0]?.[0]?.stage).toBe('agent_semantic_decision');
    const request = createStructuredJsonResponse.mock.calls[0]?.[0]?.request as {
      input?: Array<{ role?: string; content?: string }>;
      text?: { format?: { schema?: { required?: string[] } } };
    };
    const input = JSON.parse(request.input?.find((item) => item.role === 'user')?.content ?? '{}') as {
      history?: unknown[];
      rejectedSemanticDecision?: unknown;
      semanticValidationIssueHistory?: string[];
      priorProductTargets?: unknown[];
    };
    expect(input.history).toHaveLength(20);
    expect(input.priorProductTargets).toEqual([{
      name: 'ТСС SGG 5000N, артикул 060007', productClass: 'generator', messageId: history[1]!.id
    }]);
    expect(input.rejectedSemanticDecision).toEqual(rejectedSemanticDecision);
    expect(input.semanticValidationIssueHistory).toEqual([
      'active_requirement_mismatch:generator_load_scenario'
    ]);
    const systemPrompt = request.input?.find((item) => item.role === 'system')?.content ?? '';
    expect(systemPrompt).toContain('Исправь именно этот decision точечно');
    expect(systemPrompt).toContain('value.loads факта generator_load_scenario');
    expect(systemPrompt).toContain('Факты о мощности потребителя');
    expect(systemPrompt).toContain('productMentions.evidence');
    expect(systemPrompt).toContain('Для разрешённой анафоры сохрани историческую модель');
    expect(systemPrompt).toContain('sourceMessageId');
    expect(systemPrompt).not.toContain('убери mention, которого в текущей реплике нет');
    expect(systemPrompt).toContain('nominal_power_kw=true');
    expect(systemPrompt).toContain('не создавай need.opened');
    expect(systemPrompt).toContain('удали lead.capture из requiredToolKinds/toolRequests');
    expect(systemPrompt).toContain('writer предложит форму через leadAction="offer_form"');
    expect(systemPrompt).toContain('второй явно запрошенный');
    expect(systemPrompt).toContain('target_product productMention');
    expect(systemPrompt).toContain('Не возвращай ни одно из этих нарушений');
    expect(systemPrompt).toContain('active_requirement_mismatch:generator_load_scenario');
    expect(systemPrompt).toContain('taskType описывает цель обращения, responseMode — текущий шаг');
    expect(systemPrompt).toContain('product_selection + responseMode="clarify"');
    expect(systemPrompt).not.toContain('не оставляя product_selection без каталога');
    expect(systemPrompt).toContain('technicalAttributes сами по себе не доказывают пробел');
    expect(systemPrompt).toContain('Не подставляй конкретный класс ради прохождения проверки');
    expect(request).toMatchObject({ max_output_tokens: 3200 });
    expect(createStructuredJsonResponse.mock.calls[0]?.[0]).toMatchObject({ retryOutputTokenCap: 4800 });
    expect(request.text?.format?.schema?.required).toEqual(['ledgerDelta', 'intent']);
  });

  it('retains an inactive need selection while the same buyer turn resumes another need', async () => {
    const now = new Date().toISOString();
    const sessionId = '11111111-1111-4111-8111-111111111111';
    const userMessage = 'По виброплите понял, пока выберу первую. Теперь вернёмся к двум последним генераторам. Первый, инверторный EVOline, мне интереснее: сколько он стоит?';
    const priorEvents = normalizeLedgerStateDeltaEvents({ sessionId, turnId: '22222222-2222-4222-8222-222222222222', delta: { rationale: 'Two previously discussed needs.', events: [
      { eventType: 'need.opened', scope: 'need', payload: { needId: 'generator', productClass: 'generator',
        selectedProductIds: ['generator-1', 'generator-2'], selectionUpdateMode: 'replace', activate: true },
        source: 'llm_state_delta', evidence: 'Previously shown generators.', status: 'active' },
      { eventType: 'need.opened', scope: 'need', payload: { needId: 'plate', productClass: 'plate',
        selectedProductIds: ['plate-1', 'plate-2', 'plate-3'], selectionUpdateMode: 'replace', activate: true },
        source: 'llm_state_delta', evidence: 'Previously shown plates.', status: 'active' }
    ] } });
    const ledgerState = reduceDialogueLedger(priorEvents);
    const history: Message[] = [{ id: 'generator-cards', sessionId, role: 'assistant', content: 'Два генератора.', createdAt: now,
      metadata: { productCards: [{ id: 'generator-1', name: 'EVOline BPB 4000' }, { id: 'generator-2', name: 'TSS SGG 4000N' }] } },
    { id: 'plate-cards', sessionId, role: 'assistant', content: 'Три виброплиты.', createdAt: now,
      metadata: { productCards: [{ id: 'plate-1', name: 'STEM Techno SPC 101' }, { id: 'plate-2', name: 'CHAMPION PC5431F' }, { id: 'plate-3', name: 'TSS VP50' }] } }];
    const delta: LedgerStateDelta = { rationale: 'Save the plate choice before responding about the generator.', events: [
      { eventType: 'need.updated', scope: 'need', payload: { needId: 'plate', productClass: 'plate',
        selectedProductIds: ['plate-1'], selectionUpdateMode: 'replace', activate: false },
        source: 'llm_state_delta', evidence: 'По виброплите понял, пока выберу первую.', status: 'active' },
      { eventType: 'need.updated', scope: 'need', payload: { needId: 'generator', productClass: 'generator',
        selectedProductIds: ['generator-1'], selectionUpdateMode: 'replace', activate: true },
        source: 'llm_state_delta', evidence: 'Первый, инверторный EVOline, мне интереснее', status: 'active' }
    ] };
    createStructuredJsonResponse.mockResolvedValueOnce({ parsed: { ledgerDelta: delta, intent: {
      userMessageSummary: userMessage, dialogueUnderstanding: 'Record both choices and answer the generator question.',
      nextStepRationale: 'Check the selected generator price.', requiresTools: true,
      toolRequests: [{ id: 'generator-details', tool: 'catalog.getProductDetails', required: true,
        args: { productIds: ['generator-1'], canonicalProductIntent: 'generator' }, rationale: 'Read current price.' }], riskFlags: []
    } } });
    const decision = await new OpenAIAgentManagerModel().decideTurn({
      session: { id: sessionId, status: 'active', conversationNumber: 1, title: 'Two needs', needState: emptyNeedState(),
        createdAt: now, updatedAt: now, lastHeartbeatAt: now }, history, userMessage, ledgerEvents: priorEvents, ledgerState
    });
    expect(createStructuredJsonResponse).toHaveBeenCalledTimes(1);
    const request = createStructuredJsonResponse.mock.calls[0]![0].request;
    const input = JSON.parse(request.input.find((item: { role: string }) => item.role === 'user').content);
    expect(input.userMessage).toBe(userMessage);
    expect(input.existingState.needs).toEqual(expect.arrayContaining([
      expect.objectContaining({ needId: 'generator', selectedProductIds: ['generator-1', 'generator-2'] }),
      expect.objectContaining({ needId: 'plate', selectedProductIds: ['plate-1', 'plate-2', 'plate-3'] })
    ]));
    expect(input.priorVisibleProducts).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'plate-1', occurrences: [expect.objectContaining({ messageId: 'plate-cards', ordinal: 1 })] }),
      expect.objectContaining({ id: 'generator-1', occurrences: [expect.objectContaining({ messageId: 'generator-cards', ordinal: 1 })] })
    ]));
    const after = reduceDialogueLedger(normalizeLedgerStateDeltaEvents({ sessionId, turnId: '33333333-3333-4333-8333-333333333333', delta: decision.ledgerDelta }), ledgerState);
    expect(getActiveDialogueNeed(after)?.needId).toBe('generator');
    expect(after.needsById.plate).toMatchObject({ selectedProductIds: ['plate-1'], status: 'paused' });
    expect(after.needsById.generator).toMatchObject({ selectedProductIds: ['generator-1'] });
    const resumedPlate = reduceDialogueLedger(normalizeLedgerStateDeltaEvents({ sessionId, turnId: '44444444-4444-4444-8444-444444444444', delta: {
      rationale: 'Return to the previously selected plate.', events: [{ eventType: 'need.updated', scope: 'need',
        payload: { needId: 'plate', productClass: 'plate', selectedProductIds: [], selectionUpdateMode: 'preserve', activate: true },
        source: 'llm_state_delta', evidence: 'Вернёмся к выбранной виброплите.', status: 'active' }]
    } }), after);
    expect(resumedPlate.needsById.plate.selectedProductIds).toEqual(['plate-1']);
    const prompt = request.input.find((item: { role: string }) => item.role === 'system').content;
    expect(prompt).toContain('Сначала сохрани все независимые изменения потребностей');
    expect(prompt).toContain('Смена фокуса ответа не отменяет выбор');
  });

  it('includes guidance for generator_loads and calculator tool mismatches', async () => {
    const now = new Date('2026-08-13T10:00:00.000Z').toISOString();
    const session: ConversationSession = {
      id: '11111111-1111-4111-8111-111111111111',
      status: 'active',
      conversationNumber: 1,
      title: 'Dialog #1',
      needState: emptyNeedState(),
      createdAt: now,
      updatedAt: now,
      lastHeartbeatAt: now
    };
    const history: Message[] = [{
      id: '22222222-2222-4222-8222-222222222222',
      sessionId: session.id,
      role: 'user',
      content: 'Здравствуйте. Нужен генератор.',
      metadata: {},
      createdAt: now
    }];
    createStructuredJsonResponse.mockResolvedValueOnce({
      parsed: {
        ledgerDelta: { rationale: 'test', events: [] },
        intent: {
          userMessageSummary: 'test',
          dialogueUnderstanding: 'test',
          nextStepRationale: 'test',
          requiresTools: false,
          toolRequests: [],
          riskFlags: []
        }
      }
    });
    await (new OpenAIAgentManagerModel() as OpenAIAgentManagerModel & { decideTurn(input: unknown): Promise<unknown> }).decideTurn({
      session,
      history,
      userMessage: history[0]!.content,
      ledgerEvents: [],
      ledgerState: reduceDialogueLedger([]),
      semanticValidationIssues: ['active_requirement_mismatch:generator_loads', 'required_tool_request_missing:calculator.generatorLoad', 'typed_requirement_tool_mismatch:req_loads'],
      semanticValidationIssueHistory: []
    });
    const request = createStructuredJsonResponse.mock.calls[0]?.[0]?.request as { input?: Array<{ role?: string; content?: string }> };
    const systemPrompt = request.input?.find((item) => item.role === 'system')?.content ?? '';
    expect(systemPrompt).toContain('generator_loads');
    expect(systemPrompt).toContain('calculator.generatorLoad');
  });

  it('serializes durable fact provenance and the same redacted pending lead draft for reducer and planner', async () => {
    const now = new Date('2026-07-15T10:00:00.000Z').toISOString();
    const session: ConversationSession = {
      id: '11111111-1111-4111-8111-111111111111',
      status: 'active',
      conversationNumber: 1,
      title: 'Dialog #1',
      needState: emptyNeedState(),
      createdAt: now,
      updatedAt: now,
      lastHeartbeatAt: now
    };
    const history: Message[] = [{
      id: '22222222-2222-4222-8222-222222222222',
      sessionId: session.id,
      role: 'user',
      content: 'Алексей, лучше напишите.',
      metadata: {},
      createdAt: now
    }];
    const pendingLeadCaptureDraft = {
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      purpose: 'confirm a technical fact',
      buyerQuestion: 'Can you confirm the technical fact?',
      preferredContact: 'message' as const,
      hasName: false,
      hasPhone: true,
      hasEmail: false,
      missingFields: ['name' as const],
      expiresAt: now
    };
    const pendingExhaustedTechnicalHandoffs = [{
      handoffOfferMessageId: '33333333-3333-4333-8333-333333333333',
      buyerQuestion: 'Can you confirm the technical fact?',
      technicalAttributes: ['electric start'],
      sourceAttemptTiers: ['catalog', 'official_page', 'official_manual', 'reliable_secondary'] as const,
      offeredAt: now
    }];
    const intentContract: AgentIntentContract = {
      turnId: null,
      userMessageSummary: 'buyer supplied the missing name and preferred contact method',
      dialogueUnderstanding: 'continue the same pending technical handoff',
      nextStepRationale: 'capture the pending draft with current-message evidence',
      requiresTools: false,
      toolRequests: [],
      productMentions: [],
      selectionPolicy: {
        targetProductClass: null,
        canonicalProductClass: null,
        selectionGoal: 'preliminary_fit',
        needAction: 'continue',
        alternativePolicy: 'unknown',
        reusePreviousCards: false,
        maxCards: 0,
        powerSource: null,
        phase: null,
        requirements: [],
        rationale: 'no product selection in this turn'
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
      grounding: {
        taskType: 'lead_handoff',
        sourcePolicy: 'conversation_only',
        webPurpose: 'none',
        requiredToolKinds: [],
        technicalAttributes: [],
        rationale: 'the pending draft is trusted session state'
      },
      mustNotAskQuestionIds: [],
      riskFlags: []
    };
    createStructuredJsonResponse
      .mockResolvedValueOnce({ parsed: { rationale: 'continue the pending handoff', events: [] } })
      .mockResolvedValueOnce({ parsed: intentContract });
    const model = new OpenAIAgentManagerModel();
    const observedFact: DialogueLedgerEvent = {
      sessionId: session.id,
      turnId: '44444444-4444-4444-8444-444444444444',
      eventId: 'observed-product-weight',
      eventType: 'fact.observed',
      scope: 'product',
      payload: {
        factKey: 'product.weight_kg',
        value: 77,
        confidence: 0.7,
        needId: 'generator',
        productId: 'catalog-generator-a',
        unit: 'kg',
        relation: 'context',
        role: 'context'
      },
      evidence: 'Observed in an unconfirmed web result.',
      source: 'web',
      status: 'active',
      createdAt: now
    };
    const ledgerState = reduceDialogueLedger([{
      ...observedFact,
      eventId: 'open-generator',
      eventType: 'need.opened',
      scope: 'need',
      payload: { needId: 'generator', productClass: 'generator', activate: true }
    }, observedFact, {
      ...observedFact,
      eventId: 'saved-ranking-preference', eventType: 'fact.confirmed', scope: 'need',
      payload: { factKey: 'buyer_priority', value: 'удобнее для меня', needId: 'generator',
        role: 'preference', relation: 'preferred', ranking: { attribute: 'weight_kg', direction: 'minimize' } }
    }, {
      ...observedFact,
      eventId: 'open-secondary',
      eventType: 'need.opened',
      scope: 'need',
      payload: { needId: 'oil', productClass: 'engineOil', activate: false }
    }]);

    await model.proposeLedgerDelta({
      session,
      history,
      userMessage: history[0]!.content,
      ledgerEvents: [],
      ledgerState,
      pendingLeadCaptureDraft,
      pendingExhaustedTechnicalHandoffs: pendingExhaustedTechnicalHandoffs.map((context) => ({
        ...context,
        sourceAttemptTiers: [...context.sourceAttemptTiers]
      }))
    });
    await model.planTurn({
      session,
      history,
      userMessage: history[0]!.content,
      ledgerEvents: [],
      ledgerState,
      pendingLeadCaptureDraft,
      pendingExhaustedTechnicalHandoffs: pendingExhaustedTechnicalHandoffs.map((context) => ({
        ...context,
        sourceAttemptTiers: [...context.sourceAttemptTiers]
      }))
    });

    expect(createStructuredJsonResponse).toHaveBeenCalledTimes(2);
    expect(createStructuredJsonResponse.mock.calls.map((call) => call[0]?.stage)).toEqual([
      'agent_ledger_delta',
      'agent_intent_contract'
    ]);
    for (const call of createStructuredJsonResponse.mock.calls) {
      const request = call[0]?.request as { input?: Array<{ role?: string; content?: string }> } | undefined;
      const userInput = JSON.parse(
        request?.input?.find((item) => item.role === 'user')?.content ?? '{}'
      ) as {
        pendingLeadCaptureDraft?: Record<string, unknown>;
        pendingExhaustedTechnicalHandoffs?: unknown;
        existingState?: { activeNeedId?: string | null; facts?: Array<Record<string, unknown>> };
        ledger?: { activeNeedId?: string | null; facts?: Array<Record<string, unknown>> };
      };
      expect(userInput.pendingLeadCaptureDraft).toEqual(pendingLeadCaptureDraft);
      expect(userInput.pendingLeadCaptureDraft).not.toHaveProperty('phone');
      expect(userInput.pendingLeadCaptureDraft).not.toHaveProperty('email');
      if (call[0]?.stage === 'agent_intent_contract') {
        expect(userInput.pendingExhaustedTechnicalHandoffs).toEqual(pendingExhaustedTechnicalHandoffs);
      }
      const compactFact = (userInput.existingState ?? userInput.ledger)?.facts?.[0];
      expect((userInput.existingState ?? userInput.ledger)?.activeNeedId).toBe('generator');
      expect(compactFact).toMatchObject({
        eventType: 'fact.observed',
        source: 'web',
        confidence: 0.7,
        createdAt: now,
        scope: 'product',
        productId: 'catalog-generator-a',
        unit: 'kg',
        relation: 'context',
        role: 'context'
      });
      expect((userInput.existingState ?? userInput.ledger)?.facts?.find((fact) => fact.key === 'buyer_priority')).toMatchObject({
        value: 'удобнее для меня', ranking: { attribute: 'weight_kg', direction: 'minimize' }
      });
    }
    const plannerCall = createStructuredJsonResponse.mock.calls.find((call) => call[0]?.stage === 'agent_intent_contract');
    const plannerRequest = plannerCall?.[0]?.request as {
      input?: Array<{ role?: string; content?: string }>;
      text?: {
        verbosity?: string;
        format?: {
          description?: string;
          schema?: {
            properties?: {
              selectionPolicy?: {
                required?: string[];
                properties?: {
                  rankingObjectives?: {
                    items?: { properties?: { attribute?: { enum?: string[] }; direction?: { enum?: string[] } } };
                  };
                };
              };
            };
          };
        };
      };
    } | undefined;
    const plannerPrompt = plannerRequest?.input?.find((item) => item.role === 'system')?.content ?? '';
    expect(plannerRequest?.text?.verbosity).toBe('low');
    expect(plannerRequest?.text?.format?.description).toContain('concise');
    expect(plannerPrompt).toContain('shortest complete semantic JSON');
    expect(plannerPrompt).toContain('Do not restate the buyer request');
    expect(plannerPrompt).toContain('Упоминание поверхности/материала работы');
    expect(plannerPrompt).toContain('не strict requirement');
    expect(plannerPrompt).toContain('выдуманная совместимость/аксессуар');
    expect(plannerPrompt).toContain('kind="product_class"');
    expect(plannerPrompt).toContain('value = canonicalProductClass точно');
    expect(plannerPrompt).toContain('rankingObjectives');
    expect(plannerPrompt).toContain('weight_kg/minimize');
    expect(plannerPrompt).toContain('minimize');
    expect(plannerPrompt).toContain('для сравнения известных моделей');
    expect(plannerPrompt).toContain('catalog.getProductDetails');
    expect(plannerPrompt).toContain('ответил без конфликта');
    expect(plannerPrompt).toContain('явная просьба внешней проверки');
    expect(plannerPrompt).toContain('для availability_or_delivery ставь required только если сначала нужно найти или идентифицировать товар в каталоге');
    expect(plannerPrompt).toContain('Пока разрешённого контакта нет');
    expect(plannerPrompt).toContain('leadAction="offer_form"');
    expect(plannerPrompt).toContain('Если в одном ходе явно запрошены разные классы товаров');
    expect(plannerPrompt).toContain('не своди аксессуар к классу основного товара');
    expect(plannerPrompt).toContain('web request также несёт свой canonicalProductIntent');
    expect(plannerPrompt).not.toContain('смена задачи бюджет не сбрасывает');
    expect(plannerPrompt).toContain('Топливо/источник энергии не выдумывай');
    expect(plannerPrompt).toContain('catalog.search limit ставь с запасом');
    expect(plannerPrompt).toContain('catalog.search всегда имеет непустой args.query');
    expect(plannerPrompt).toContain('loads.kind — открытый семантический идентификатор');
    expect(plannerPrompt).not.toContain('loads.kind — канонические:');
    expect(plannerPrompt).toContain('текущего activeNeedId и явно общие scope=dialogue без needId');
    expect(plannerPrompt).toContain('те же kind, значение, единицу и relation, включая старые ходы');
    expect(plannerPrompt).toContain('локальные факты остаются у paused темы для возврата');
    expect(plannerPrompt).toContain('Общность не выводи из названия kind');
    expect(plannerPrompt).toContain('пересчитывай по нагрузкам активной задачи');
    expect(plannerPrompt).toContain('priorVisibleProducts.occurrences');
    expect(plannerPrompt).toContain('messageId/createdAt/ordinal');
    const rankingSchema = plannerRequest?.text?.format?.schema?.properties?.selectionPolicy?.properties?.rankingObjectives;
    expect(plannerRequest?.text?.format?.schema?.properties?.selectionPolicy?.required).toContain('rankingObjectives');
    expect(rankingSchema?.items?.properties?.attribute?.enum).toEqual(['weight_kg', 'price_rub', 'nominal_power_kw']);
    expect(rankingSchema?.items?.properties?.direction?.enum).toEqual(['minimize', 'maximize']);

    const reducerCall = createStructuredJsonResponse.mock.calls.find((call) => call[0]?.stage === 'agent_ledger_delta');
    const rankingPayloadSchema = (reducerCall?.[0]?.request as { text: { format: { schema: { properties: {
      events: { items: { properties: { payload: { required: string[]; properties: Record<string, unknown> } } } }
    } } } } }).text.format.schema.properties.events.items.properties.payload;
    expect(rankingPayloadSchema.required).toContain('ranking');
    expect(rankingPayloadSchema.properties.ranking).toMatchObject({
      anyOf: [{ type: 'object', required: ['attribute', 'direction'], properties: {
        attribute: { enum: ['weight_kg', 'price_rub', 'nominal_power_kw'] }, direction: { enum: ['minimize', 'maximize'] }
      } }, { type: 'null' }]
    });
    const reducerRequest = reducerCall?.[0]?.request as {
      input?: Array<{ role?: string; content?: string }>;
      text?: {
        verbosity?: string;
        format?: {
          description?: string;
          schema?: {
            properties?: {
              events?: {
                items?: {
                  properties?: {
                    payload?: { required?: string[]; properties?: Record<string, { enum?: unknown[] }> };
                  };
                };
              };
            };
          };
        };
      };
    } | undefined;
    const reducerPrompt = reducerRequest?.input?.find((item) => item.role === 'system')?.content ?? '';
    const ledgerPayloadSchema = reducerRequest?.text?.format?.schema?.properties?.events?.items?.properties?.payload;
    expect(reducerRequest?.text?.verbosity).toBe('low');
    expect(reducerRequest?.text?.format?.description).toContain('concise');
    expect(reducerPrompt).toContain('shortest complete semantic JSON');
    expect(reducerPrompt).toContain('rejectedProductIdsUpdateMode');
    expect(reducerPrompt).toContain('constraintsUpdateMode');
    expect(reducerPrompt).toContain('openQuestionsUpdateMode');
    expect(reducerPrompt).toContain('fact.observed');
    expect(reducerPrompt).toContain('confidence');
    expect(reducerPrompt).toContain('activate=false: она останется paused');
    expect(reducerPrompt).toContain('scope=product и productId');
    expect(reducerPrompt).toContain('Характеристика товара не становится hard_requirement покупателя');
    expect(ledgerPayloadSchema?.required).toEqual(expect.arrayContaining([
      'confidence',
      'relation',
      'constraintsUpdateMode',
      'openQuestionsUpdateMode',
      'rejectedProductIdsUpdateMode'
    ]));
    expect(ledgerPayloadSchema?.properties?.rejectedProductIdsUpdateMode?.enum)
      .toEqual(['merge', 'replace', 'clear', null]);
    expect(ledgerPayloadSchema?.properties?.relation?.enum)
      .toEqual(['must_have', 'must_not_have', 'preferred', 'not_required', 'context', null]);
  });

  it('routes current buyer wording into dynamic sales policy prompts for planner and answer', async () => {
    const now = new Date('2026-07-15T10:00:00.000Z').toISOString();
    const session: ConversationSession = {
      id: '11111111-1111-4111-8111-111111111111',
      status: 'active',
      conversationNumber: 1,
      title: 'Dialog #1',
      needState: emptyNeedState(),
      createdAt: now,
      updatedAt: now,
      lastHeartbeatAt: now
    };
    const history: Message[] = [{
      id: '22222222-2222-4222-8222-222222222222',
      sessionId: session.id,
      role: 'user',
      content: 'мне нужен резчик че у вас есть?',
      metadata: {},
      createdAt: now
    }];
    const ledgerState = reduceDialogueLedger([]);
    const intentContract: AgentIntentContract = {
      turnId: null,
      userMessageSummary: 'buyer asks for a cutter assortment',
      dialogueUnderstanding: 'ambiguous cutter request',
      nextStepRationale: 'ask material/work before selection',
      requiresTools: false,
      toolRequests: [],
      productMentions: [{ name: 'резчик', role: 'target_product', productClass: 'cutter', evidence: 'мне нужен резчик' }],
      selectionPolicy: {
        targetProductClass: 'резчик',
        canonicalProductClass: 'cutter',
        selectionGoal: 'browse_catalog',
        needAction: 'open',
        alternativePolicy: 'same_class_only',
        reusePreviousCards: false,
        maxCards: 0,
        powerSource: null,
        phase: null,
        requirements: [],
        rationale: 'ambiguous cutter wording needs material/work clarification'
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
      policyRuleIds: ['selection.cutter_ambiguous_material_question'],
      grounding: {
        taskType: 'product_selection',
        sourcePolicy: 'conversation_only',
        webPurpose: 'none',
        webRequirement: 'none',
        requiredToolKinds: [],
        technicalAttributes: [],
        buyerQuestion: 'мне нужен резчик че у вас есть?',
        rationale: 'clarification before tools'
      },
      mustNotAskQuestionIds: [],
      riskFlags: []
    };
    createStructuredJsonResponse
      .mockResolvedValueOnce({ parsed: intentContract })
      .mockResolvedValueOnce({ parsed: {
        answerText: 'Под резчиком могут иметь в виду разное. По какому материалу нужен рез?',
        factsUsed: [],
        questionsAsked: [{ questionId: 'cutter-material', text: 'по какому материалу нужен рез', reason: 'резчик is ambiguous without material/work' }],
        toolResultIds: [],
        leadAction: 'none',
        riskFlags: [],
        selectionReadiness: {
          productClass: 'cutter',
          status: 'needs_more_info',
          canShowProductCards: false,
          missingFacts: ['material_or_work'],
          rationale: 'ambiguous cutter wording'
        }
      } });
    const model = new OpenAIAgentManagerModel();

    await model.planTurn({ session, history, userMessage: history[0]!.content, ledgerEvents: [], ledgerState });
    await model.composeAnswer({
      session,
      history,
      userMessage: history[0]!.content,
      ledgerEvents: [],
      ledgerState,
      intent: intentContract,
      toolResults: [],
      products: [],
      structuredDeadlineAtMs: Date.parse(now) + 60_000
    });

    const plannerCall = createStructuredJsonResponse.mock.calls.find((call) => call[0]?.stage === 'agent_intent_contract');
    const answerCall = createStructuredJsonResponse.mock.calls.find((call) => call[0]?.stage === 'agent_answer_contract');
    const plannerPrompt = (plannerCall?.[0]?.request as { input?: Array<{ role?: string; content?: string }> })
      ?.input?.find((item) => item.role === 'system')?.content ?? '';
    const answerPrompt = (answerCall?.[0]?.request as { input?: Array<{ role?: string; content?: string }> })
      ?.input?.find((item) => item.role === 'system')?.content ?? '';

    expect(plannerPrompt).not.toContain('не планируй catalog.search');
    expect(plannerPrompt).toContain('needs_more_info');
    expect(plannerPrompt).toContain('missingFacts');
    expect(plannerPrompt).toContain('canShowProductCards');
    expect(answerCall?.[0]).toMatchObject({
      deadlineAtMs: Date.parse(now) + 60_000,
      minRetryRemainingMs: 10_000
    });
    const answerRequest = answerCall?.[0]?.request as { max_output_tokens?: number };
    expect(answerCall?.[0]?.retryOutputTokenCap).toBe(Math.ceil(Number(answerRequest.max_output_tokens) * 1.5));
    for (const prompt of [plannerPrompt, answerPrompt]) {
      expect(prompt).toContain('selection.cutter_ambiguous_material_question');
      expect(prompt).toContain('по какому материалу');
      expect(prompt).toContain('шовнарезчик');
      expect(prompt).toContain('бензорез');
    }
    expect(answerPrompt).toContain('Покупателю сообщай состояние товарного факта, а не процесс работы системы');
    expect(answerPrompt).toContain('Никогда не упоминай инструменты, web/внешний поиск, попытки, timeout/тайм-аут');
    expect(answerPrompt).toContain('это внутренний статус, не содержание ответа покупателю');
    expect(answerPrompt).toContain('не предлагай форму/специалиста только из-за такого статуса');
    expect(answerPrompt).toContain('не обрезай молча');
    expect(answerPrompt).not.toContain('recommendation_candidate → 2-4');
  });

});
