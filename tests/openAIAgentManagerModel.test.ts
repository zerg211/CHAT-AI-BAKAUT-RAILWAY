import { beforeEach, describe, expect, it, vi } from 'vitest';

const createStructuredJsonResponse = vi.hoisted(() => vi.fn());

vi.mock('../src/ai/openaiStructured.js', () => ({
  createStructuredJsonResponse
}));

import { OpenAIAgentManagerModel } from '../src/ai/agentManagerOrchestrator.js';
import { reduceDialogueLedger } from '../src/ai/dialogueLedgerReducer.js';
import { emptyNeedState } from '../src/ai/needState.js';
import type { AgentIntentContract, DialogueLedgerEvent } from '../src/ai/agentManagerContracts.js';
import type { ConversationSession, Message, VerifiedProductFact } from '../src/shared/types.js';

describe('OpenAIAgentManagerModel semantic inputs', () => {
  beforeEach(() => {
    createStructuredJsonResponse.mockReset();
  });

  it('semantically classifies paraphrased internal research-process disclosure', async () => {
    createStructuredJsonResponse.mockResolvedValueOnce({
      parsed: {
        processDisclosure: true,
        evidence: 'Я обращался к доступным источникам',
        rationale: 'The answer describes how information was sought.'
      }
    });

    const review = await new OpenAIAgentManagerModel().reviewCustomerLanguage({
      answerText: 'Я обращался к доступным источникам, но они не дали результата.'
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
    };
    expect(input.history).toHaveLength(20);
    expect(input.rejectedSemanticDecision).toEqual(rejectedSemanticDecision);
    expect(input.semanticValidationIssueHistory).toEqual([
      'active_requirement_mismatch:generator_load_scenario'
    ]);
    const systemPrompt = request.input?.find((item) => item.role === 'system')?.content ?? '';
    expect(systemPrompt).toContain('Исправь именно этот decision точечно');
    expect(systemPrompt).toContain('value.loads факта generator_load_scenario');
    expect(systemPrompt).toContain('Факты о мощности потребителя');
    expect(systemPrompt).toContain('productMentions.evidence');
    expect(systemPrompt).toContain('nominal_power_kw=true');
    expect(systemPrompt).toContain('не создавай need.opened');
    expect(systemPrompt).toContain('удали lead.capture из requiredToolKinds/toolRequests');
    expect(systemPrompt).toContain('writer предложит форму через leadAction="offer_form"');
    expect(systemPrompt).toContain('второй явно запрошенный');
    expect(systemPrompt).toContain('target_product productMention');
    expect(systemPrompt).toContain('Не возвращай ни одно из этих нарушений');
    expect(systemPrompt).toContain('active_requirement_mismatch:generator_load_scenario');
    expect(request).toMatchObject({ max_output_tokens: 3200 });
    expect(createStructuredJsonResponse.mock.calls[0]?.[0]).toMatchObject({ retryOutputTokenCap: 4800 });
    expect(request.text?.format?.schema?.required).toEqual(['ledgerDelta', 'intent']);
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
        role: 'hard_requirement'
      },
      evidence: 'Observed in an unconfirmed web result.',
      source: 'web',
      status: 'active',
      createdAt: now
    };
    const ledgerState = reduceDialogueLedger([observedFact]);

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
        existingState?: { facts?: Array<Record<string, unknown>> };
        ledger?: { facts?: Array<Record<string, unknown>> };
      };
      expect(userInput.pendingLeadCaptureDraft).toEqual(pendingLeadCaptureDraft);
      expect(userInput.pendingLeadCaptureDraft).not.toHaveProperty('phone');
      expect(userInput.pendingLeadCaptureDraft).not.toHaveProperty('email');
      if (call[0]?.stage === 'agent_intent_contract') {
        expect(userInput.pendingExhaustedTechnicalHandoffs).toEqual(pendingExhaustedTechnicalHandoffs);
      }
      const compactFact = (userInput.existingState ?? userInput.ledger)?.facts?.[0];
      expect(compactFact).toMatchObject({
        eventType: 'fact.observed',
        source: 'web',
        confidence: 0.7,
        createdAt: now
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
    expect(plannerPrompt).toContain('смена задачи бюджет не сбрасывает');
    expect(plannerPrompt).toContain('Топливо/источник энергии не выдумывай');
    expect(plannerPrompt).toContain('catalog.search limit ставь с запасом');
    expect(plannerPrompt).toContain('молча не роняй ни одно');
    expect(plannerPrompt).toContain('пересчитывай заново под новую задачу');
    const rankingSchema = plannerRequest?.text?.format?.schema?.properties?.selectionPolicy?.properties?.rankingObjectives;
    expect(plannerRequest?.text?.format?.schema?.properties?.selectionPolicy?.required).toContain('rankingObjectives');
    expect(rankingSchema?.items?.properties?.attribute?.enum).toEqual(['weight_kg', 'price_rub', 'nominal_power_kw']);
    expect(rankingSchema?.items?.properties?.direction?.enum).toEqual(['minimize', 'maximize']);

    const reducerCall = createStructuredJsonResponse.mock.calls.find((call) => call[0]?.stage === 'agent_ledger_delta');
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
    expect(ledgerPayloadSchema?.required).toEqual(expect.arrayContaining([
      'confidence',
      'constraintsUpdateMode',
      'openQuestionsUpdateMode',
      'rejectedProductIdsUpdateMode'
    ]));
    expect(ledgerPayloadSchema?.properties?.rejectedProductIdsUpdateMode?.enum)
      .toEqual(['merge', 'replace', 'clear', null]);
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
