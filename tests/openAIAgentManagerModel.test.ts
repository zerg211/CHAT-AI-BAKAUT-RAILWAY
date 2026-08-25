import { beforeEach, describe, expect, it, vi } from 'vitest';

const createStructuredJsonResponse = vi.hoisted(() => vi.fn());

vi.mock('../src/ai/openaiStructured.js', () => ({
  createStructuredJsonResponse
}));

import { OpenAIAgentManagerModel } from '../src/ai/agentManagerOrchestrator.js';
import { reduceDialogueLedger } from '../src/ai/dialogueLedgerReducer.js';
import { emptyNeedState } from '../src/ai/needState.js';
import type { AgentIntentContract, DialogueLedgerEvent } from '../src/ai/agentManagerContracts.js';
import type { ConversationSession, Message } from '../src/shared/types.js';

describe('OpenAIAgentManagerModel semantic inputs', () => {
  beforeEach(() => {
    createStructuredJsonResponse.mockReset();
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

    const decision = await (new OpenAIAgentManagerModel() as OpenAIAgentManagerModel & {
      decideTurn(input: unknown): Promise<{ ledgerDelta: unknown; intent: unknown }>;
    }).decideTurn({
      session,
      history,
      userMessage: history.at(-1)!.content,
      ledgerEvents: [],
      ledgerState: reduceDialogueLedger([])
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
    };
    expect(input.history).toHaveLength(20);
    expect(request).toMatchObject({ max_output_tokens: 3200 });
    expect(request.text?.format?.schema?.required).toEqual(['ledgerDelta', 'intent']);
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
      products: []
    });

    const plannerCall = createStructuredJsonResponse.mock.calls.find((call) => call[0]?.stage === 'agent_intent_contract');
    const answerCall = createStructuredJsonResponse.mock.calls.find((call) => call[0]?.stage === 'agent_answer_contract');
    const plannerPrompt = (plannerCall?.[0]?.request as { input?: Array<{ role?: string; content?: string }> })
      ?.input?.find((item) => item.role === 'system')?.content ?? '';
    const answerPrompt = (answerCall?.[0]?.request as { input?: Array<{ role?: string; content?: string }> })
      ?.input?.find((item) => item.role === 'system')?.content ?? '';

    expect(plannerPrompt).toContain('не планируй catalog.search');
    for (const prompt of [plannerPrompt, answerPrompt]) {
      expect(prompt).toContain('selection.cutter_ambiguous_material_question');
      expect(prompt).toContain('по какому материалу');
      expect(prompt).toContain('шовнарезчик');
      expect(prompt).toContain('бензорез');
    }
  });

});
