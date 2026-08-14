import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  AgentManagerOrchestrator,
  RECOVERY_LEASE_WAIT_LIMIT_MS,
  enforceSearchBeforeTechnicalSpecialist,
  isPreSendReviewStructuredOutputError,
  orderToolRequestsForSelectionDependencies,
  repairIntentForCatalogClarificationBeforeTools,
  pendingLeadCaptureDraftMatchesAuthorizationScope,
  repairIntentForOpenEndedRequirementWebCoverage,
  repairIntentForNewNeedFinalFit,
  repairIntentForRequestedTechnicalAttributeWebCoverage,
  repairIntentForTypedToolRequirementCoverage,
  productMatchesExactTargetIdentity,
  trustedPendingExhaustedTechnicalHandoffs,
  webResearchResultProvesSourceExhaustion,
  type AgentManagerModel
} from '../src/ai/agentManagerOrchestrator.js';
import { DEFAULT_AGENT_MANAGER_TURN_LIMITS } from '../src/ai/agentManagerTurnBudget.js';
import {
  AgentIntentContractSchema,
  normalizeLedgerStateDeltaEvents,
  type AgentIntentContract,
  type DialogueLedgerEvent,
  type LedgerStateDelta,
  type ToolRequest,
  type ToolResult
} from '../src/ai/agentManagerContracts.js';
import { reduceDialogueLedger } from '../src/ai/dialogueLedgerReducer.js';
import { assessStrictSelectionRequirements, budgetMaxFromNeedState, gateStrictSelectionRequirements } from '../src/ai/agentManagerCardSelection.js';
import { emptyNeedState } from '../src/ai/needState.js';
import { config } from '../src/config.js';
import type { ConversationSession, ConversationTurn, LeadCaptureDraft, Message, Product, ProductCard } from '../src/shared/types.js';

const sessionId = '11111111-1111-4111-8111-111111111111';
const turnId = '22222222-2222-4222-8222-222222222222';
const userMessageId = '33333333-3333-4333-8333-333333333333';
const exhaustedTechnicalHandoffOfferId = '55555555-5555-4555-8555-555555555555';

function technicalHandoffScopeHash(
  purpose: string,
  buyerQuestion: string,
  handoffOfferMessageId = exhaustedTechnicalHandoffOfferId
) {
  return createHash('sha256')
    .update(JSON.stringify([
      sessionId,
      purpose,
      buyerQuestion,
      `technical_handoff_offer:${handoffOfferMessageId}`
    ]))
    .digest('hex');
}

function leadActionFingerprintFixture(input: {
  turnId: string;
  userMessage: string;
  contactSource: 'current_message' | 'pending_draft' | 'existing_session';
  handoffKind: 'technical_followup' | 'commercial_followup' | 'purchase_request';
  handoffOfferMessageId?: string;
  pendingDraftId?: string;
  purpose: string;
  buyerQuestion: string;
  evidence: string;
  evidencedName?: string;
  preferredContact?: 'message' | 'call';
}) {
  return createHash('sha256').update(JSON.stringify([
    'lead.capture:v1',
    sessionId,
    input.turnId,
    input.userMessage,
    'lead.capture',
    'authorized',
    input.contactSource,
    input.handoffKind,
    input.handoffOfferMessageId ?? '',
    input.pendingDraftId ?? '',
    input.purpose,
    input.buyerQuestion,
    input.evidence,
    input.evidencedName ?? '',
    input.preferredContact ?? ''
  ])).digest('hex');
}

function session(): ConversationSession {
  const now = new Date('2026-05-19T12:00:00.000Z').toISOString();
  return {
    id: sessionId,
    status: 'active',
    conversationNumber: 1,
    title: 'Dialog #1',
    needState: {
      ...emptyNeedState(),
      activeNeeds: [{
        id: 'generator',
        productClass: 'generator',
        summary: 'legacy open question',
        constraints: [],
        openQuestions: ['What is the coffee machine power?'],
        selectedProductIds: [],
        status: 'open',
        updatedAt: now
      }]
    },
    createdAt: now,
    updatedAt: now,
    lastHeartbeatAt: now
  };
}

function turn(status: ConversationTurn['status'] = 'received'): ConversationTurn {
  const now = new Date('2026-05-19T12:00:00.000Z').toISOString();
  return {
    id: turnId,
    sessionId,
    userMessageId,
    assistantMessageId: null,
    status,
    requestHash: 'hash',
    createdAt: now,
    updatedAt: now
  };
}

function message(content: string, role: Message['role'] = 'user'): Message {
  return {
    id: role === 'user' ? userMessageId : 'assistant-id',
    sessionId,
    role,
    content,
    metadata: {},
    createdAt: new Date('2026-05-19T12:00:00.000Z').toISOString()
  };
}

function product(id: string, name: string, category = 'Generators'): Product {
  return {
    id,
    name,
    brand: 'TEST',
    category,
    price: 1000,
    currency: 'RUB',
    sourceUrl: `https://example.test/${id}`,
    specs: { power: '5 kW' }
  };
}

function generatorProductWithPower(id: string, name: string, nominalKw: number): Product {
  return {
    id,
    name,
    brand: 'TEST',
    category: 'Generators',
    price: 1000,
    currency: 'RUB',
    sourceUrl: `https://example.test/${id}`,
    specs: { 'Nominal power': `${nominalKw} kW` }
  };
}

class FakeConversations {
  messages: Message[] = [message('Coffee machine 3.2 kW, grinder 400 W, is 5 kW enough?')];
  turn: ConversationTurn = turn();
  ledgerEvents: unknown[] = [];
  checkpoints: unknown[] = [];
  toolArtifacts: unknown[] = [];
  answerContracts: unknown[] = [];
  finalAnswerContract: unknown | null = null;
  traces: unknown[] = [];
  assistantSaves: unknown[] = [];
  outbox: unknown[] = [];
  addMessage = vi.fn(async (input: { role: Message['role']; content: string; metadata?: Record<string, unknown> }) => {
    const saved = message(input.content, input.role);
    this.messages.push(saved);
    return saved;
  });
  async addUserMessageForTurn(input: { content: string }) {
    if (this.turn.userMessageId) {
      const existing = this.messages.find((item) => item.id === this.turn.userMessageId && item.role === 'user');
      if (existing) return existing;
    }
    const saved = await this.addMessage({ role: 'user', content: input.content });
    this.turn = { ...this.turn, userMessageId: saved.id, stage: 'user_message_saved' };
    return saved;
  }
  async getSession() { return session(); }
  async listMessages() { return this.messages; }
  async getTurn() { return this.turn; }
  async updateTurn(input: Partial<ConversationTurn> & { userMessageId?: string | null; assistantMessageId?: string | null }) {
    this.turn = { ...this.turn, ...input, id: this.turn.id, sessionId: this.turn.sessionId } as ConversationTurn;
    return this.turn;
  }
  async beginRecoveryAttempt() {
    if (['completed', 'recovered'].includes(this.turn.status) || (this.turn.recoveryAttempts ?? 0) >= 1) return null;
    this.turn = { ...this.turn, recoveryAttempts: (this.turn.recoveryAttempts ?? 0) + 1 };
    return this.turn;
  }
  async upsertTurnCheckpoint(input: unknown) { this.checkpoints.push(input); return input; }
  async listTurnCheckpoints() { return this.checkpoints; }
  async listDialogueLedgerEvents() { return this.ledgerEvents; }
  async upsertDialogueLedgerEvent(input: unknown) { this.ledgerEvents.push(input); return input; }
  async saveToolArtifact(input: unknown) { this.toolArtifacts.push(input); return input; }
  async listToolArtifacts() { return this.toolArtifacts; }
  async saveAnswerContract(input: unknown) { this.answerContracts.push(input); return input; }
  async getFinalAnswerContract() { return this.finalAnswerContract; }
  async enqueueLeadOutbox(input: unknown) {
    const saved = { ...(input as Record<string, unknown>), id: `outbox-${this.outbox.length + 1}`, status: 'pending' };
    this.outbox.push(saved);
    return saved;
  }
  async addAgentTrace(input: unknown) { this.traces.push(input); return input; }
  async addAssistantMessageForTurn(input: {
    content: string;
    metadata?: Record<string, unknown>;
    recovered?: boolean;
    executionOwner?: string;
    answerContract?: unknown;
    review?: unknown;
    responsePayload?: unknown;
  }) {
    if (['completed', 'recovered'].includes(this.turn.status)) return null;
    this.assistantSaves.push(input);
    this.answerContracts.push({
      status: 'final',
      answerText: input.content,
      contract: input.answerContract,
      review: input.review,
      responsePayload: input.responsePayload
    });
    const saved = message(input.content, 'assistant');
    saved.metadata = input.metadata ?? {};
    this.messages.push(saved);
    this.turn = { ...this.turn, assistantMessageId: saved.id, status: input.recovered ? 'recovered' : 'completed' };
    return saved;
  }
}

class FakeProducts {
  async searchProducts(_query?: string, _limit?: number): Promise<Product[]> {
    return [
      { ...product('p1', 'Generator 5 kW'), specs: { 'Nominal power': '5 kW' } },
      { ...product('p2', 'Generator 6 kW'), specs: { 'Nominal power': '6 kW' } }
    ];
  }
  async recordDataQualityIssue() {
    return null;
  }
}

class HybridProducts extends FakeProducts {
  vectorCalls = 0;

  async searchProducts() {
    return [product('text-product', 'Generator text match 6 kW')];
  }

  async getEmbeddingCoverage() {
    return { target: 'products', total: 10, embedded: 10, usable: 10, coverage: 1 };
  }

  async vectorSearch() {
    this.vectorCalls += 1;
    return [product('vector-product', 'Generator vector match 7 kW')];
  }
}

function exhaustedTechnicalHandoffHistory(originalQuestion: string): Message[] {
  const previousIntent: AgentIntentContract = {
    userMessageSummary: 'technical research exhausted',
    dialogueUnderstanding: 'the decisive exact fact remains unconfirmed after all source tiers',
    nextStepRationale: 'offer to return the specialist result',
    requiresTools: true,
    toolRequests: [{
      id: 'prior-web-research',
      tool: 'web.researchProductFacts',
      args: {
        query: originalQuestion,
        productNames: [],
        comparisonAttributes: ['technical fact'],
        comparisonAttributeBindings: []
      },
      rationale: 'exhaust available sources before handoff',
      required: true
    }],
    grounding: {
      taskType: 'technical_answer',
      sourcePolicy: 'web_required',
      webPurpose: 'technical_specs',
      webRequirement: 'independent_required',
      requiredToolKinds: ['web.researchProductFacts'],
      technicalAttributes: ['technical fact'],
      buyerQuestion: originalQuestion,
      rationale: 'verify the technical fact before handoff'
    },
    productMentions: [],
    selectionPolicy: currentNoProductSelectionPolicy(),
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
  const assistant = message('Оставьте номер телефона и скажите, как удобнее получить результат: сообщением или звонком.', 'assistant');
  assistant.id = exhaustedTechnicalHandoffOfferId;
  assistant.metadata = {
    effectiveIntentContract: previousIntent,
    answerContract: {
      answerText: assistant.content,
      factsUsed: [],
      questionsAsked: [],
      toolResultIds: ['prior-web-research'],
      selectedProductIds: [],
      leadAction: 'offer_form',
      riskFlags: []
    },
    toolResults: [{
      requestId: 'prior-web-research',
      tool: 'web.researchProductFacts',
      status: 'ok',
      payload: {
        usedWebSearch: true,
        searchDisposition: 'completed',
        sourcesExhausted: true,
        researchOutcome: 'exhausted',
        sourceAttempts: [
          { tier: 'catalog', outcome: 'not_found' },
          { tier: 'official_page', outcome: 'not_found', query: 'official product page technical fact' },
          { tier: 'official_manual', outcome: 'not_found', query: 'official manual technical fact PDF' },
          { tier: 'reliable_secondary', outcome: 'not_found', query: 'reliable distributor technical fact' }
        ]
      },
      warnings: []
    }]
  };
  return [
    { ...message(originalQuestion), id: '44444444-4444-4444-8444-444444444444' },
    { ...message('What voltage and nominal power do you need?', 'assistant'), id: '44444444-4444-4444-8444-444444444445' },
    { ...message('380 V and about 8 kW nominal.', 'user'), id: '44444444-4444-4444-8444-444444444446' },
    assistant
  ];
}

function exhaustedWebResearchResult(warnings: string[] = [], errorCode?: string): ToolResult {
  return {
    requestId: 'exhausted-web-research',
    tool: 'web.researchProductFacts',
    status: 'ok',
    payload: {
      usedWebSearch: true,
      searchDisposition: 'completed',
      sourcesExhausted: true,
      researchOutcome: 'exhausted',
      sourceAttempts: [
        { tier: 'catalog', outcome: 'not_found' },
        { tier: 'official_page', outcome: 'not_found', query: 'official product page technical fact' },
        { tier: 'official_manual', outcome: 'not_found', query: 'official manual technical fact PDF' },
        { tier: 'reliable_secondary', outcome: 'not_found', query: 'reliable distributor technical fact' }
      ]
    },
    warnings,
    ...(errorCode ? { errorCode } : {})
  };
}

describe('trusted exhausted technical handoff provenance', () => {
  it('defers any lead side effect when the planner omitted explicit grounding', () => {
    const buyerQuestion = 'Please verify the generator start method.';
    const parsed = AgentIntentContractSchema.parse({
      userMessageSummary: 'technical question mislabeled as a commercial follow-up',
      dialogueUnderstanding: 'legacy planner output omitted grounding',
      nextStepRationale: 'unsafe lead attempt under test',
      requiresTools: true,
      toolRequests: [{
        id: 'lead.capture:omitted-grounding',
        tool: 'lead.capture',
        args: { contact: { name: 'Alexey' } },
        rationale: 'unsafe omitted-grounding lead',
        required: true
      }],
      selectionPolicy: currentNoProductSelectionPolicy(),
      leadCaptureAuthorization: {
        authorized: true,
        contactSource: 'current_message',
        handoffKind: 'commercial_followup',
        purpose: 'verify the generator start method',
        buyerQuestion,
        evidence: 'Alexey, +7 900 000-00-11',
        pendingDraftId: null
      },
      policyRuleIds: [],
      mustNotAskQuestionIds: [],
      riskFlags: []
    });

    const repaired = enforceSearchBeforeTechnicalSpecialist(parsed);

    expect(repaired.toolRequests.some((request) => request.tool === 'lead.capture')).toBe(false);
    expect(repaired.riskFlags).toContain('planner_deferred_lead_until_explicit_grounding');
  });

  it('does not let a technical offer-bound draft be consumed under a commercial label', () => {
    const buyerQuestion = 'Please verify the exact start method.';
    const purpose = 'verify the exact start method';
    const draft = {
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      sessionId,
      purpose,
      buyerQuestion,
      scopeHash: technicalHandoffScopeHash(purpose, buyerQuestion)
    };
    expect(pendingLeadCaptureDraftMatchesAuthorizationScope(draft, {
      authorized: true,
      contactSource: 'current_message',
      handoffKind: 'commercial_followup',
      purpose,
      buyerQuestion,
      evidence: 'Alexey',
      pendingDraftId: draft.id
    })).toBe(false);
    expect(pendingLeadCaptureDraftMatchesAuthorizationScope(draft, {
      authorized: true,
      contactSource: 'pending_draft',
      handoffKind: 'commercial_followup',
      purpose,
      buyerQuestion,
      evidence: 'Alexey',
      pendingDraftId: draft.id
    })).toBe(false);
    expect(pendingLeadCaptureDraftMatchesAuthorizationScope(draft, {
      authorized: true,
      contactSource: 'pending_draft',
      handoffKind: 'technical_followup',
      handoffOfferMessageId: exhaustedTechnicalHandoffOfferId,
      purpose,
      buyerQuestion,
      evidence: 'Alexey',
      pendingDraftId: draft.id
    })).toBe(true);
  });

  it.each([
    'source_evidence_fetch_failed',
    'source_evidence_empty',
    'source_evidence_unsupported_binary',
    'source_evidence_pdf_parse_failed',
    'source_evidence_pdf_parse_timed_out',
    'source_evidence_pdf_parser_busy',
    'source_evidence_pdf_too_large',
    'source_evidence_pdf_text_empty',
    'source_evidence_pdf_truncated_to_safe_page_limit',
    'source_evidence_pdf_source_cap_reached'
  ])('does not accept contradictory source exhaustion with unread evidence: %s', (warning) => {
    expect(webResearchResultProvesSourceExhaustion(exhaustedWebResearchResult([warning]))).toBe(false);
  });

  it('does not accept source exhaustion after a budget skip or tool error', () => {
    expect(webResearchResultProvesSourceExhaustion(exhaustedWebResearchResult([
      'exact_target_external_retry_skipped_insufficient_budget'
    ]))).toBe(false);
    expect(webResearchResultProvesSourceExhaustion(exhaustedWebResearchResult([], 'turn_budget_exceeded'))).toBe(false);
  });

  it.each([
    'source_tier_attempts_incomplete_after_retry',
    'tool_execution_error',
    'tool_result_rejected_by_local_bounds',
    'tool_not_implemented',
    'web_research_not_needed:catalog_requirements_satisfied'
  ])('does not accept contradictory source exhaustion with an execution warning: %s', (warning) => {
    expect(webResearchResultProvesSourceExhaustion(exhaustedWebResearchResult([warning]))).toBe(false);
  });

  it('checks payload warnings and payload errors as well as the ToolResult envelope', () => {
    const payloadWarning = exhaustedWebResearchResult();
    (payloadWarning.payload as Record<string, unknown>).warnings = ['source_evidence_pdf_parse_failed'];
    expect(webResearchResultProvesSourceExhaustion(payloadWarning)).toBe(false);

    const payloadError = exhaustedWebResearchResult();
    (payloadError.payload as Record<string, unknown>).error = { code: 'source_fetch_failed' };
    expect(webResearchResultProvesSourceExhaustion(payloadError)).toBe(false);
  });

  it('does not accept duplicate source tiers or cosmetically duplicated web queries', () => {
    const duplicateTier = exhaustedWebResearchResult();
    const duplicateTierPayload = duplicateTier.payload as { sourceAttempts: Array<Record<string, unknown>> };
    duplicateTierPayload.sourceAttempts.push({
      tier: 'official_manual',
      outcome: 'unreadable',
      query: 'another manual query'
    });
    expect(webResearchResultProvesSourceExhaustion(duplicateTier)).toBe(false);

    const duplicateQueries = exhaustedWebResearchResult();
    const duplicateQueryPayload = duplicateQueries.payload as { sourceAttempts: Array<Record<string, unknown>> };
    duplicateQueryPayload.sourceAttempts = [
      { tier: 'catalog', outcome: 'not_found' },
      { tier: 'official_page', outcome: 'not_found', query: 'same query!' },
      { tier: 'official_manual', outcome: 'not_found', query: ' same   query ? ' },
      { tier: 'reliable_secondary', outcome: 'not_found', query: 'same query.' }
    ];
    expect(webResearchResultProvesSourceExhaustion(duplicateQueries)).toBe(false);

    const punctuationOnly = exhaustedWebResearchResult();
    const punctuationPayload = punctuationOnly.payload as { sourceAttempts: Array<Record<string, unknown>> };
    punctuationPayload.sourceAttempts[1]!.query = '?!...';
    expect(webResearchResultProvesSourceExhaustion(punctuationOnly)).toBe(false);
  });

  it('still accepts clean completed source exhaustion after unsupported claims were rejected', () => {
    expect(webResearchResultProvesSourceExhaustion(exhaustedWebResearchResult([
      'source_evidence_validation_failed:semantic'
    ]))).toBe(true);
  });

  it('does not trust a metadata-only contact offer that was not visible to the buyer', () => {
    const history = exhaustedTechnicalHandoffHistory('Please verify the exact start method.');
    history.at(-1)!.content = 'I am still checking the available sources.';

    expect(trustedPendingExhaustedTechnicalHandoffs(history)).toEqual([]);
  });

  it('does not replay a buyerQuestion that contains contact PII', () => {
    const questionWithPhone = 'Please verify the exact start method; my phone is +7 900 000-00-11.';
    const history = exhaustedTechnicalHandoffHistory(questionWithPhone);

    expect(trustedPendingExhaustedTechnicalHandoffs(history)).toEqual([]);
  });

  it('does not replay a buyerQuestion that contains an explicitly supplied name', () => {
    const questionWithName = 'Меня зовут Алексей, проверьте точный способ запуска.';
    const history = exhaustedTechnicalHandoffHistory(questionWithName);

    expect(trustedPendingExhaustedTechnicalHandoffs(history)).toEqual([]);
  });

  it('does not replay a pronoun-name buyer question or a technical attribute containing PII', () => {
    const namedQuestion = 'Я Алексей, проверьте точный способ запуска.';
    expect(trustedPendingExhaustedTechnicalHandoffs(
      exhaustedTechnicalHandoffHistory(namedQuestion)
    )).toEqual([]);

    const history = exhaustedTechnicalHandoffHistory('Please verify the exact start method.');
    const assistant = history.at(-1)!;
    const intent = (assistant.metadata as { effectiveIntentContract: AgentIntentContract })
      .effectiveIntentContract;
    intent.grounding = {
      ...intent.grounding!,
      technicalAttributes: ['start method for +7 900 000-00-11']
    };
    expect(trustedPendingExhaustedTechnicalHandoffs(history)).toEqual([]);
  });

  it.each([
    'Я хочу узнать точный способ запуска.',
    'Я ищу генератор для мастерской.',
    'Подскажите, я могу подключить АВР?'
  ])('does not mistake an ordinary first-person business question for name PII: %s', (buyerQuestion) => {
    const history = exhaustedTechnicalHandoffHistory(buyerQuestion);

    expect(trustedPendingExhaustedTechnicalHandoffs(history)).toEqual([
      expect.objectContaining({ buyerQuestion })
    ]);
  });

  it('consumes an exhausted handoff after durable lead confirmation', () => {
    const originalQuestion = 'Please verify the exact start method.';
    const history = exhaustedTechnicalHandoffHistory(originalQuestion);
    const handoffOfferMessageId = history.at(-1)!.id;
    const confirmationTurnId = '66666666-6666-4666-8666-666666666660';
    const contactMessageText = 'Alexey, +7 900 000-00-11';
    const contactMessage = {
      ...message(contactMessageText),
      id: '66666666-6666-4666-8666-666666666661'
    };
    const priorIntent = (history.at(-1)!.metadata as { effectiveIntentContract: AgentIntentContract })
      .effectiveIntentContract;
    const confirmationIntent: AgentIntentContract = {
      ...priorIntent,
      toolRequests: [{
        id: 'lead-confirmed',
        tool: 'lead.capture',
        args: { contact: { name: 'Alexey', phone: '+7 900 000-00-11' } },
        rationale: 'complete the exact exhausted technical handoff',
        required: true
      }],
      grounding: {
        ...priorIntent.grounding!,
        taskType: 'lead_handoff',
        sourcePolicy: 'specialist_required',
        webPurpose: 'none',
        webRequirement: 'none',
        requiredToolKinds: ['lead.capture']
      },
      leadCaptureAuthorization: {
        authorized: true,
        contactSource: 'current_message',
        handoffKind: 'technical_followup',
        handoffOfferMessageId,
        purpose: 'verify the exact start method',
        buyerQuestion: originalQuestion,
        evidence: contactMessageText,
        pendingDraftId: null
      }
    };
    const confirmation = message('Спасибо, запрос передан.', 'assistant');
    confirmation.id = '77777777-7777-4777-8777-777777777777';
    confirmation.metadata = {
      turnId: confirmationTurnId,
      effectiveIntentContract: confirmationIntent,
      answerContract: {
        answerText: confirmation.content,
        factsUsed: [],
        questionsAsked: [],
        toolResultIds: ['lead-confirmed'],
        selectedProductIds: [],
        leadAction: 'confirm_contact_received',
        riskFlags: []
      },
      toolResults: [{
        requestId: 'lead-confirmed',
        tool: 'lead.capture',
        status: 'ok',
        payload: {
          leadId: '88888888-8888-4888-8888-888888888888',
          outbox: true,
          outboxId: '99999999-9999-4999-8999-999999999999',
          status: 'queued',
          actionFingerprint: leadActionFingerprintFixture({
            turnId: confirmationTurnId,
            userMessage: contactMessageText,
            contactSource: 'current_message',
            handoffKind: 'technical_followup',
            handoffOfferMessageId,
            purpose: 'verify the exact start method',
            buyerQuestion: originalQuestion,
            evidence: contactMessageText,
            evidencedName: 'Alexey'
          })
        },
        warnings: []
      }]
    };

    expect(trustedPendingExhaustedTechnicalHandoffs([...history, contactMessage, confirmation])).toEqual([]);
  });

  it('does not resurrect an older identical handoff after a newer offer is durably completed', () => {
    const originalQuestion = 'Please verify the exact start method.';
    const history = exhaustedTechnicalHandoffHistory(originalQuestion);
    const olderOffer = history.at(-1)!;
    const newerOfferId = '55555555-5555-4555-8555-555555555556';
    const confirmationTurnId = '66666666-6666-4666-8666-666666666662';
    const contactMessageText = 'Alexey, +7 900 000-00-11';
    const contactMessage = {
      ...message(contactMessageText),
      id: '66666666-6666-4666-8666-666666666663'
    };
    const newerOffer: Message = {
      ...olderOffer,
      id: newerOfferId,
      createdAt: new Date('2026-05-19T12:05:00.000Z').toISOString(),
      metadata: structuredClone(olderOffer.metadata)
    };
    const priorIntent = (newerOffer.metadata as { effectiveIntentContract: AgentIntentContract })
      .effectiveIntentContract;
    const confirmationIntent: AgentIntentContract = {
      ...priorIntent,
      toolRequests: [{
        id: 'lead-confirmed-newer-offer',
        tool: 'lead.capture',
        args: { contact: { name: 'Alexey', phone: '+7 900 000-00-11' } },
        rationale: 'complete the newer exhausted technical handoff',
        required: true
      }],
      grounding: {
        ...priorIntent.grounding!,
        taskType: 'lead_handoff',
        sourcePolicy: 'specialist_required',
        webPurpose: 'none',
        webRequirement: 'none',
        requiredToolKinds: ['lead.capture']
      },
      leadCaptureAuthorization: {
        authorized: true,
        contactSource: 'current_message',
        handoffKind: 'technical_followup',
        handoffOfferMessageId: newerOfferId,
        purpose: 'verify the exact start method',
        buyerQuestion: originalQuestion,
        evidence: contactMessageText,
        pendingDraftId: null
      }
    };
    const confirmation = message('The request was durably queued.', 'assistant');
    confirmation.id = '77777777-7777-4777-8777-777777777778';
    confirmation.createdAt = new Date('2026-05-19T12:06:00.000Z').toISOString();
    confirmation.metadata = {
      turnId: confirmationTurnId,
      effectiveIntentContract: confirmationIntent,
      answerContract: {
        answerText: confirmation.content,
        factsUsed: [],
        questionsAsked: [],
        toolResultIds: ['lead-confirmed-newer-offer'],
        selectedProductIds: [],
        leadAction: 'confirm_contact_received',
        riskFlags: []
      },
      toolResults: [{
        requestId: 'lead-confirmed-newer-offer',
        tool: 'lead.capture',
        status: 'ok',
        payload: {
          leadId: '88888888-8888-4888-8888-888888888889',
          outbox: true,
          outboxId: '99999999-9999-4999-8999-999999999990',
          status: 'queued',
          actionFingerprint: leadActionFingerprintFixture({
            turnId: confirmationTurnId,
            userMessage: contactMessageText,
            contactSource: 'current_message',
            handoffKind: 'technical_followup',
            handoffOfferMessageId: newerOfferId,
            purpose: 'verify the exact start method',
            buyerQuestion: originalQuestion,
            evidence: contactMessageText,
            evidencedName: 'Alexey'
          })
        },
        warnings: []
      }]
    };

    expect(trustedPendingExhaustedTechnicalHandoffs([
      ...history,
      newerOffer,
      contactMessage,
      confirmation
    ])).toEqual([]);
  });
});

class BrandedGeneratorProducts extends FakeProducts {
  async searchProducts(): Promise<Product[]> {
    return [
      { ...product('p1', 'TEST GX5000 Generator 5 kW'), specs: { 'Nominal power': '5 kW' } },
      { ...product('p2', 'TEST GX6000 Generator 6 kW'), specs: { 'Nominal power': '6 kW' } }
    ];
  }
}

class PlateProducts extends FakeProducts {
  async searchProducts() {
    return [
      product('plate-light', 'Vibroplita light 60 kg', 'vibroplity'),
      product('plate-mid', 'Vibroplita compact 72 kg', 'vibroplity')
    ];
  }
}

class FakeLeads {
  created: unknown[] = [];
  draftInputs: unknown[] = [];
  completionInputs: unknown[] = [];
  pendingDraft: LeadCaptureDraft | null = null;
  async getPendingLeadCaptureDraft() {
    return this.pendingDraft;
  }
  async upsertLeadCaptureDraft(input: {
    sessionId: string;
    originTurnId: string;
    originToolRequestId: string;
    purpose: string;
    buyerQuestion: string;
    preferredContact?: 'message' | 'call';
    name?: string;
    phone?: string;
    email?: string;
    consentEvidenceHash: string;
    scopeHash: string;
  }) {
    this.draftInputs.push(input);
    const now = new Date('2026-05-19T12:00:00.000Z').toISOString();
    this.pendingDraft = {
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      sessionId: input.sessionId,
      originTurnId: input.originTurnId,
      originToolRequestId: input.originToolRequestId,
      purpose: input.purpose,
      buyerQuestion: input.buyerQuestion,
      preferredContact: input.preferredContact ?? null,
      name: input.name ?? null,
      phone: input.phone ?? null,
      email: input.email ?? null,
      consentEvidenceHash: input.consentEvidenceHash,
      scopeHash: input.scopeHash,
      status: 'pending',
      expiresAt: new Date('2026-05-19T12:30:00.000Z').toISOString(),
      consumedByTurnId: null,
      consumedLeadId: null,
      createdAt: now,
      updatedAt: now
    };
    return this.pendingDraft;
  }
  async completeLeadCaptureDraft(input: {
    draftId: string;
    sessionId: string;
    turnId: string;
    name?: string;
    preferredContact?: 'message' | 'call';
  }) {
    this.completionInputs.push(input);
    if (!this.pendingDraft || this.pendingDraft.id !== input.draftId) return null;
    const createdAt = new Date('2026-05-19T12:00:00.000Z').toISOString();
    const lead = {
      id: 'lead-id',
      sessionId: input.sessionId,
      name: input.name ?? '',
      phone: this.pendingDraft.phone,
      email: this.pendingDraft.email,
      question: this.pendingDraft.buyerQuestion,
      status: 'pending_email',
      createdAt
    };
    this.created.push(lead);
    const completedDraft = {
      ...this.pendingDraft,
      status: 'consumed' as const,
      name: null,
      phone: null,
      email: null,
      preferredContact: input.preferredContact ?? this.pendingDraft.preferredContact,
      consumedByTurnId: input.turnId,
      consumedLeadId: lead.id
    };
    this.pendingDraft = null;
    return {
      draft: completedDraft,
      lead,
      outbox: {
        id: 'outbox-draft',
        leadId: lead.id,
        sessionId: input.sessionId,
        turnId: input.turnId,
        destination: 'lead_email',
        payload: {
          leadId: lead.id,
          purpose: completedDraft.purpose,
          question: completedDraft.buyerQuestion,
          preferredContact: completedDraft.preferredContact
        },
        status: 'pending',
        attemptCount: 0,
        createdAt,
        updatedAt: createdAt
      }
    };
  }
  async createLead(input: unknown) {
    this.created.push(input);
    return { id: 'lead-id', sessionId, name: 'Alexey', phone: '+7 900 000-00-11', status: 'pending_email', createdAt: new Date().toISOString() };
  }
}

function model(overrides: Partial<AgentManagerModel> = {}): AgentManagerModel {
  const implementation: AgentManagerModel = {
    async proposeLedgerDelta() {
      return {
        rationale: 'buyer provided a coffee machine load',
        events: [{
          eventType: 'question.answered',
          scope: 'question',
          payload: { questionId: 'q.coffee_power', answer: '3.2 kW', needId: 'generator' },
          evidence: 'Coffee machine 3.2 kW',
          source: 'llm_state_delta',
          status: 'closed'
        }, {
          eventType: 'fact.confirmed',
          scope: 'dialogue',
          payload: { factKey: 'load.coffee_machine_kw', value: 3.2, needId: 'generator', productClass: 'generator', role: 'hard_requirement' },
          evidence: 'Coffee machine 3.2 kW',
          source: 'llm_state_delta',
          status: 'active'
        }]
      };
    },
    async planTurn() {
      return {
        userMessageSummary: 'coffee point generator sizing',
        dialogueUnderstanding: 'buyer asks whether 5 kW is enough',
        nextStepRationale: 'calculate and answer',
        requiresTools: false,
        toolRequests: [],
        productMentions: [],
        selectionPolicy: {
          ...currentNoProductSelectionPolicy(),
          selectionGoal: 'browse_catalog'
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
          taskType: 'technical_answer',
          sourcePolicy: 'conversation_only',
          webPurpose: 'none',
          requiredToolKinds: [],
          technicalAttributes: [],
          rationale: 'the answer is grounded in the current conversation'
        },
        mustNotAskQuestionIds: ['q.coffee_power'],
        riskFlags: []
      };
    },
    async composeAnswer() {
      return {
        answerText: 'For this coffee point, 5 kW is on the edge: the 3.2 kW coffee machine plus display fridge and small loads leave little reserve.',
        factsUsed: [],
        questionsAsked: [],
        toolResultIds: [],
        leadAction: 'none',
        riskFlags: []
      };
    },
    async reviewAnswer() {
      return { verdict: 'pass', issues: [] };
    },
    ...overrides
  };
  const planTurn = implementation.planTurn;
  return {
    ...implementation,
    async planTurn(input) {
      const intent = await planTurn(input);
      return {
        ...intent,
        toolRequests: intent.toolRequests.map(modernizeLegacyUniversalToolFixture)
      };
    }
  };
}

const allowedToolArgKeys: Record<ToolRequest['tool'], Set<string>> = {
  'catalog.search': new Set([
    'query', 'semanticQuery', 'productIntent', 'canonicalProductIntent', 'powerSource', 'phase',
    'limit', 'comparisonAttributes', 'reason', 'notes'
  ]),
  'catalog.getProductDetails': new Set([
    'query', 'semanticQuery', 'productIntent', 'canonicalProductIntent', 'powerSource', 'phase',
    'productIds', 'productNames', 'comparisonAttributes', 'limit', 'reason', 'notes'
  ]),
  'calculator.generatorLoad': new Set([
    'query', 'semanticQuery', 'productIntent', 'canonicalProductIntent', 'powerSource', 'phase',
    'loads', 'simultaneousStarting', 'simultaneousStartingKinds', 'estimateBasis', 'reason', 'notes'
  ]),
  'web.researchProductFacts': new Set([
    'query', 'semanticQuery', 'productIntent', 'canonicalProductIntent', 'powerSource', 'phase',
    'productNames', 'comparisonAttributes', 'comparisonAttributeBindings', 'limit', 'reason', 'notes'
  ]),
  'lead.capture': new Set(['contact', 'reason', 'notes'])
};

function emptyLegacyUniversalPlaceholder(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (Array.isArray(value)) return value.length === 0;
  if (value && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).every(emptyLegacyUniversalPlaceholder);
  }
  return false;
}

function modernizeLegacyUniversalToolFixture(request: ToolRequest): ToolRequest {
  const allowed = allowedToolArgKeys[request.tool];
  return {
    ...request,
    args: Object.fromEntries(Object.entries(request.args).filter(([key, value]) =>
      allowed.has(key) || !emptyLegacyUniversalPlaceholder(value)
    ))
  };
}

function currentNoProductSelectionPolicy() {
  return {
    targetProductClass: null,
    canonicalProductClass: null,
    needAction: 'continue' as const,
    alternativePolicy: 'unknown' as const,
    reusePreviousCards: false,
    maxCards: 0,
    powerSource: null,
    phase: null,
    requirements: [],
    rationale: 'This recovered turn does not need product-card selection.'
  };
}

function structuredGeneratorCatalogIntent(): AgentIntentContract {
  return {
    userMessageSummary: 'buyer asks for a grounded generator recommendation',
    dialogueUnderstanding: 'catalog evidence is required for the current generator need',
    nextStepRationale: 'search the catalog and answer only from returned product facts',
    requiresTools: true,
    toolRequests: [{
      id: 'catalog-search',
      tool: 'catalog.search',
      args: {
        query: 'generator 5 kW',
        semanticQuery: 'generator 5 kW',
        productIntent: 'generator',
        canonicalProductIntent: 'generator',
        limit: 4
      },
      rationale: 'ground the recommendation in current catalog data',
      required: true
    }],
    productMentions: [],
    selectionPolicy: {
      targetProductClass: 'generator',
      canonicalProductClass: 'generator',
      needAction: 'continue',
      alternativePolicy: 'same_class_only',
      reusePreviousCards: false,
      maxCards: 4,
      powerSource: 'any',
      phase: 'any',
      requirements: [],
      rationale: 'typed catalog recommendation policy'
    },
    policyRuleIds: [],
    grounding: {
      taskType: 'product_selection',
      sourcePolicy: 'catalog_required',
      webPurpose: 'none',
      requiredToolKinds: ['catalog.search'],
      technicalAttributes: ['price', 'power'],
      rationale: 'recommendations must be supported by exact product evidence'
    },
    mustNotAskQuestionIds: [],
    riskFlags: []
  };
}

function typedGeneratorProofIntent(): AgentIntentContract {
  const intent = structuredGeneratorCatalogIntent();
  intent.toolRequests = [{
    id: 'load-calculation',
    tool: 'calculator.generatorLoad',
    args: {
      loads: [{
        name: 'borehole pump and angle grinder',
        count: 1,
        runningKw: 2.6,
        startingKw: 5.2,
        source: 'explicit_user',
        evidence: 'the pump and grinder can run simultaneously',
        basisKind: 'exact_power',
        basisSignals: ['explicit_power', 'simultaneous_operation_known']
      }],
      simultaneousStarting: false,
      simultaneousStartingKinds: [],
      estimateBasis: 'exact_or_user_provided'
    },
    rationale: 'derive the required generator minimum',
    required: true,
    coversRequirementIds: ['load-scenario']
  }, {
    ...intent.toolRequests[0]!,
    coversRequirementIds: ['derived-nominal-minimum']
  }];
  intent.selectionPolicy!.requirements = [{
    id: 'load-scenario',
    kind: 'generator_load_scenario',
    value: true,
    unit: null,
    role: 'hard_constraint',
    strictness: 'strict',
    evidence: 'the pump and grinder can run simultaneously',
    verification: {
      mode: 'typed_tool',
      toolRequestId: 'load-calculation',
      tool: 'calculator.generatorLoad',
      verifier: 'generator_load_profile',
      bindAs: 'nominal_power_min_kw'
    }
  }, {
    id: 'derived-nominal-minimum',
    kind: 'nominal_power_min_kw',
    value: null,
    unit: 'kW',
    role: 'hard_constraint',
    strictness: 'strict',
    evidence: 'the minimum is derived from the load profile',
    verification: {
      mode: 'typed_tool',
      toolRequestId: 'load-calculation',
      tool: 'calculator.generatorLoad',
      verifier: 'generator_load_profile',
      bindAs: 'nominal_power_min_kw'
    }
  }];
  return intent;
}

describe('AgentManagerOrchestrator', () => {
  it('recognizes the exact catalog model even when the buyer request contains engine details', () => {
    const exact = {
      ...product('bps-1550-aw', 'Wacker Neuson BPS 1550 Aw', 'Vibroplates'),
      sourceUrl: 'https://bakautprof.ru/catalog/vibroplity/bps-1550-aw/'
    };

    expect(productMatchesExactTargetIdentity(exact, 'Wacker Neuson BPS 1550 Aw')).toBe(true);
    expect(productMatchesExactTargetIdentity(exact, 'Wacker Neuson BPS 1550 Gw')).toBe(false);
  });

  it('keeps the recovery lease wait aligned with the bounded agent wall clock', () => {
    expect(RECOVERY_LEASE_WAIT_LIMIT_MS).toBe(DEFAULT_AGENT_MANAGER_TURN_LIMITS.maxWallTimeMs);
    expect(RECOVERY_LEASE_WAIT_LIMIT_MS).toBe(40_000);
  });

  it('repairs omitted preliminary comparison web coverage from exact catalog candidates once', () => {
    const intent = structuredGeneratorCatalogIntent();
    const productNames = ['FIRMAN RD3910E', 'FIRMAN RD4910E'];
    intent.toolRequests = [{
      id: 'exact-comparison-details',
      tool: 'catalog.getProductDetails',
      args: {
        productNames,
        productIntent: 'generator',
        canonicalProductIntent: 'generator',
        comparisonAttributes: ['operating mass', 'automatic start'],
        limit: 2
      },
      rationale: 'read the two exact catalog candidates',
      required: true
    }];
    intent.productMentions = productNames.map((name) => ({
      name,
      role: 'comparison_subject' as const,
      productClass: 'generator',
      evidence: `exact comparison candidate ${name}`
    }));
    intent.selectionPolicy = {
      ...intent.selectionPolicy!,
      selectionGoal: 'preliminary_fit',
      requirements: [{
        id: 'weight-limit',
        kind: 'weight_max_kg',
        value: 100,
        unit: 'kg',
        relation: 'must_have',
        role: 'hard_constraint',
        strictness: 'strict',
        evidence: 'the buyer needs a machine no heavier than 100 kg',
        verification: { mode: 'product_attribute' }
      }, {
        id: 'automatic-start',
        kind: 'autostart_required',
        value: true,
        unit: null,
        relation: 'must_have',
        role: 'hard_constraint',
        strictness: 'strict',
        evidence: 'automatic start is required',
        verification: { mode: 'product_attribute' }
      }]
    };
    intent.grounding = {
      taskType: 'comparison',
      sourcePolicy: 'catalog_required',
      webPurpose: 'none',
      webRequirement: 'none',
      requiredToolKinds: ['catalog.getProductDetails'],
      technicalAttributes: ['operating mass', 'automatic start'],
      buyerQuestion: 'Compare the operating mass and automatic start of these two models.',
      rationale: 'the exact catalog cards are the first evidence source'
    };

    const repaired = repairIntentForRequestedTechnicalAttributeWebCoverage(intent);
    const webRequests = repaired.intent.toolRequests.filter((request) =>
      request.tool === 'web.researchProductFacts'
    );

    expect(repaired.repairs).toEqual([{
      requestId: expect.any(String),
      attributes: ['operating mass', 'automatic start'],
      created: true
    }]);
    expect(webRequests).toHaveLength(1);
    expect(webRequests[0]).toMatchObject({
      required: true,
      coversRequirementIds: ['weight-limit', 'automatic-start'],
      args: {
        productNames,
        comparisonAttributes: ['operating mass', 'automatic start'],
        comparisonAttributeBindings: [{
          attribute: 'operating mass',
          requirementId: 'weight-limit'
        }, {
          attribute: 'automatic start',
          requirementId: 'automatic-start'
        }]
      }
    });
    expect(repaired.intent.grounding).toMatchObject({
      sourcePolicy: 'catalog_required',
      webPurpose: 'technical_specs',
      webRequirement: 'conditional_on_catalog_gap',
      requiredToolKinds: ['catalog.getProductDetails', 'web.researchProductFacts']
    });
    expect(repaired.intent.riskFlags).toContain('planner_repaired_requested_attribute_conditional_web');
    expect(orderToolRequestsForSelectionDependencies(
      repaired.intent.toolRequests,
      repaired.intent
    ).map((request) => request.tool)).toEqual([
      'catalog.getProductDetails',
      'web.researchProductFacts'
    ]);
    expect(AgentIntentContractSchema.parse(repaired.intent)).toBeDefined();

    expect(repairIntentForRequestedTechnicalAttributeWebCoverage(repaired.intent)).toEqual({
      intent: repaired.intent,
      repairs: []
    });
  });

  it('does not turn unbound catalog attributes into false terminal web gaps', () => {
    const intent = structuredGeneratorCatalogIntent();
    intent.selectionPolicy = {
      ...intent.selectionPolicy!,
      selectionGoal: 'preliminary_fit',
      requirements: [{
        id: 'load', kind: 'generator_load_scenario', value: true, unit: null,
        relation: 'must_have', role: 'hard_constraint', strictness: 'strict', evidence: 'four simultaneous loads',
        verification: {
          mode: 'typed_tool', tool: 'calculator.generatorLoad', toolRequestId: 'calc',
          bindAs: 'nominal_power_min_kw', verifier: 'generator_load_profile'
        }
      }, {
        id: 'fuel', kind: 'fuel_type', value: 'бензин', unit: null,
        relation: 'must_have', role: 'hard_constraint', strictness: 'strict', evidence: 'бензиновый',
        verification: { mode: 'product_attribute' }
      }, {
        id: 'phase', kind: 'phase', value: 'single_phase', unit: null,
        relation: 'must_have', role: 'hard_constraint', strictness: 'strict', evidence: '220 В',
        verification: { mode: 'product_attribute' }
      }, {
        id: 'start', kind: 'auto_start_required', value: true, unit: null,
        relation: 'must_have', role: 'hard_constraint', strictness: 'strict', evidence: 'с электростартом',
        verification: { mode: 'product_attribute' }
      }, {
        id: 'budget', kind: 'budget_max_rub', value: 150000, unit: 'RUB',
        relation: 'must_have', role: 'hard_constraint', strictness: 'strict', evidence: 'до 150 000 ₽',
        verification: { mode: 'product_attribute' }
      }]
    };
    intent.grounding = {
      ...intent.grounding!,
      sourcePolicy: 'catalog_required', webPurpose: 'none', webRequirement: 'none',
      technicalAttributes: ['номинальная мощность', 'тип топлива', 'фаза', 'электростарт', 'цена']
    };
    intent.toolRequests = [{
      id: 'catalog', tool: 'catalog.search', args: {}, rationale: 'find candidates', required: true,
      coversRequirementIds: ['fuel', 'phase', 'start', 'budget']
    }];

    const repaired = repairIntentForRequestedTechnicalAttributeWebCoverage(intent);
    const web = repaired.intent.toolRequests.find((request) => request.tool === 'web.researchProductFacts');

    expect(web?.args.comparisonAttributes).toEqual(['тип топлива', 'фаза', 'электростарт', 'цена']);
    expect(web?.args.comparisonAttributeBindings).toEqual([{ attribute: 'тип топлива', requirementId: 'fuel' }, {
      attribute: 'фаза', requirementId: 'phase'
    }, {
      attribute: 'электростарт', requirementId: 'start'
    }, {
      attribute: 'цена', requirementId: 'budget'
    }]);
    expect(web?.args.comparisonAttributes).not.toContain('номинальная мощность');
  });

  it('extends one compatible catalog-selection web request without names or duplicate attributes', () => {
    const intent = structuredGeneratorCatalogIntent();
    intent.selectionPolicy = {
      ...intent.selectionPolicy!,
      selectionGoal: 'preliminary_fit',
      requirements: [{
        id: 'weight-limit',
        kind: 'weight_max_kg',
        value: 100,
        unit: 'kg',
        relation: 'must_have',
        role: 'hard_constraint',
        strictness: 'strict',
        evidence: 'the buyer needs a machine no heavier than 100 kg',
        verification: { mode: 'product_attribute' }
      }, {
        id: 'automatic-start',
        kind: 'autostart_required',
        value: true,
        unit: null,
        relation: 'must_have',
        role: 'hard_constraint',
        strictness: 'strict',
        evidence: 'automatic start is required',
        verification: { mode: 'product_attribute' }
      }]
    };
    intent.grounding = {
      ...intent.grounding!,
      webPurpose: 'none',
      webRequirement: 'none',
      technicalAttributes: ['operating mass', 'automatic start']
    };
    intent.toolRequests = [intent.toolRequests[0]!, {
      id: 'existing-selection-web',
      tool: 'web.researchProductFacts',
      args: {
        query: 'verify the shortlisted catalog candidates',
        productIntent: 'generator',
        canonicalProductIntent: 'generator',
        productNames: [],
        comparisonAttributes: ['operating mass'],
        comparisonAttributeBindings: [{
          attribute: 'operating mass',
          requirementId: 'weight-limit'
        }]
      },
      rationale: 'verify one requested catalog gap',
      required: true,
      coversRequirementIds: ['weight-limit']
    }];

    const repaired = repairIntentForRequestedTechnicalAttributeWebCoverage(intent);
    const webRequests = repaired.intent.toolRequests.filter((request) =>
      request.tool === 'web.researchProductFacts'
    );

    expect(webRequests).toHaveLength(1);
    expect(webRequests[0]?.args.productNames).toEqual([]);
    expect(webRequests[0]?.args.comparisonAttributes).toEqual(['operating mass', 'automatic start']);
    expect(webRequests[0]?.args.comparisonAttributeBindings).toEqual([{
      attribute: 'operating mass',
      requirementId: 'weight-limit'
    }, {
      attribute: 'automatic start',
      requirementId: 'automatic-start'
    }]);
    expect(webRequests[0]?.coversRequirementIds).toEqual(['weight-limit', 'automatic-start']);
    expect(repaired.repairs).toEqual([{
      requestId: 'existing-selection-web',
      attributes: ['automatic start'],
      created: false
    }]);
  });

  it('merges requested attributes into a same-target web superset without adding a duplicate request', () => {
    const intent = structuredGeneratorCatalogIntent();
    const productNames = ['FIRMAN RD3910E', 'FIRMAN RD4910E'];
    intent.selectionPolicy = {
      ...intent.selectionPolicy!,
      selectionGoal: 'preliminary_fit',
      requirements: [{
        id: 'automatic-start',
        kind: 'autostart_required',
        value: true,
        unit: null,
        relation: 'must_have',
        role: 'hard_constraint',
        strictness: 'strict',
        evidence: 'automatic start is required',
        verification: { mode: 'product_attribute' }
      }]
    };
    intent.grounding = {
      ...intent.grounding!,
      taskType: 'comparison',
      webPurpose: 'none',
      webRequirement: 'none',
      requiredToolKinds: ['catalog.getProductDetails'],
      technicalAttributes: ['operating mass', 'automatic start']
    };
    intent.productMentions = productNames.map((name) => ({
      name,
      role: 'comparison_subject' as const,
      productClass: 'generator',
      evidence: `exact comparison candidate ${name}`
    }));
    intent.toolRequests = [{
      id: 'existing-exact-web',
      tool: 'web.researchProductFacts',
      args: {
        productNames,
        comparisonAttributes: ['operating mass', 'fuel consumption']
      },
      rationale: 'verify current facts for these exact comparison targets',
      required: true
    }, {
      id: 'exact-comparison-details',
      tool: 'catalog.getProductDetails',
      args: { productNames, comparisonAttributes: ['operating mass', 'automatic start'] },
      rationale: 'read the exact current catalog cards first',
      required: true
    }];

    const repaired = repairIntentForRequestedTechnicalAttributeWebCoverage(intent);
    const webRequests = repaired.intent.toolRequests.filter((request) =>
      request.tool === 'web.researchProductFacts'
    );

    expect(webRequests).toHaveLength(1);
    expect(webRequests[0]?.id).toBe('existing-exact-web');
    expect(webRequests[0]?.args.productNames).toEqual(productNames);
    expect(webRequests[0]?.args.comparisonAttributes).toEqual([
      'operating mass',
      'fuel consumption',
      'automatic start'
    ]);
    expect(repaired.repairs).toEqual([{
      requestId: 'existing-exact-web',
      attributes: ['automatic start'],
      created: false
    }]);
    expect(orderToolRequestsForSelectionDependencies(
      repaired.intent.toolRequests,
      repaired.intent
    ).map((request) => request.tool)).toEqual([
      'catalog.getProductDetails',
      'web.researchProductFacts'
    ]);
  });

  it('does not synthesize conditional web research outside the structured preliminary catalog contract', () => {
    const finalFit = structuredGeneratorCatalogIntent();
    finalFit.selectionPolicy = { ...finalFit.selectionPolicy!, selectionGoal: 'final_fit' };
    expect(repairIntentForRequestedTechnicalAttributeWebCoverage(finalFit)).toEqual({
      intent: finalFit,
      repairs: []
    });

    const noAttributes = structuredGeneratorCatalogIntent();
    noAttributes.selectionPolicy = { ...noAttributes.selectionPolicy!, selectionGoal: 'preliminary_fit' };
    noAttributes.grounding = { ...noAttributes.grounding!, technicalAttributes: [] };
    expect(repairIntentForRequestedTechnicalAttributeWebCoverage(noAttributes)).toEqual({
      intent: noAttributes,
      repairs: []
    });

    const noCatalog = structuredGeneratorCatalogIntent();
    noCatalog.selectionPolicy = { ...noCatalog.selectionPolicy!, selectionGoal: 'preliminary_fit' };
    noCatalog.toolRequests = [];
    expect(repairIntentForRequestedTechnicalAttributeWebCoverage(noCatalog)).toEqual({
      intent: noCatalog,
      repairs: []
    });
  });

  it('downgrades only an unnamed newly opened selection from final fit to preliminary fit', () => {
    const intent = structuredGeneratorCatalogIntent();
    intent.selectionPolicy = {
      ...intent.selectionPolicy!,
      selectionGoal: 'final_fit',
      needAction: 'open',
      reusePreviousCards: false
    };

    const repaired = repairIntentForNewNeedFinalFit(intent);

    expect(repaired.repaired).toBe(true);
    expect(repaired.intent.selectionPolicy?.selectionGoal).toBe('preliminary_fit');
    expect(repaired.intent.riskFlags).toContain('planner_repaired_new_need_final_fit_to_preliminary');

    const exactModelIntent: AgentIntentContract = {
      ...intent,
      productMentions: [{
        name: 'Husqvarna LFV 100',
        role: 'target_product',
        productClass: 'plate',
        evidence: 'Подтвердите Husqvarna LFV 100'
      }]
    };
    expect(repairIntentForNewNeedFinalFit(exactModelIntent)).toEqual({
      intent: exactModelIntent,
      repaired: false
    });

    const continuingIntent: AgentIntentContract = {
      ...intent,
      selectionPolicy: {
        ...intent.selectionPolicy!,
        needAction: 'continue'
      }
    };
    expect(repairIntentForNewNeedFinalFit(continuingIntent)).toEqual({
      intent: continuingIntent,
      repaired: false
    });

    const mislabeledNewNeedIntent: AgentIntentContract = {
      ...intent,
      selectionPolicy: {
        ...intent.selectionPolicy!,
        needAction: 'continue'
      }
    };
    const repairedFromLedgerLifecycle = repairIntentForNewNeedFinalFit(mislabeledNewNeedIntent, {
      openedNeedThisTurn: true
    });
    expect(repairedFromLedgerLifecycle.repaired).toBe(true);
    expect(repairedFromLedgerLifecycle.intent.selectionPolicy?.selectionGoal).toBe('preliminary_fit');
  });

  it('classifies only pre-send structured JSON failures for compact reviewer recovery', () => {
    expect(isPreSendReviewStructuredOutputError(
      new Error('agent_pre_send_review did not return a JSON object')
    )).toBe(true);
    expect(isPreSendReviewStructuredOutputError(
      new Error('agent_answer_contract did not return a JSON object')
    )).toBe(false);
    expect(isPreSendReviewStructuredOutputError(
      new Error('OpenAI authentication failed')
    )).toBe(false);
  });

  it('adds missing web research for an open-ended preliminary requirement without discarding catalog candidates', () => {
    const intent = structuredGeneratorCatalogIntent();
    intent.userMessageSummary = 'buyer needs a light plate compactor for paving tiles on a small site';
    intent.dialogueUnderstanding = 'the job application is relevant, but catalog cards do not prove it directly';
    intent.nextStepRationale = 'find plate candidates first, then verify the unconfirmed application fact';
    intent.toolRequests = [{
      ...intent.toolRequests[0]!,
      args: {
        query: 'лёгкая виброплита для тротуарной плитки',
        semanticQuery: 'виброплита для тротуарной плитки, самостоятельная перевозка',
        productIntent: 'виброплита',
        canonicalProductIntent: 'plate',
        limit: 6
      }
    }];
    intent.selectionPolicy = {
      ...intent.selectionPolicy!,
      targetProductClass: 'виброплита',
      canonicalProductClass: 'plate',
      selectionGoal: 'preliminary_fit',
      requirements: [{
        id: 'paving-application',
        kind: 'material',
        value: 'тротуарная плитка',
        unit: null,
        relation: 'must_have',
        role: 'hard_constraint',
        strictness: 'strict',
        evidence: 'для тротуарной плитки',
        verification: { mode: 'product_attribute' }
      }]
    };
    intent.grounding = {
      ...intent.grounding!,
      sourcePolicy: 'catalog_required',
      webPurpose: 'none',
      webRequirement: 'none',
      requiredToolKinds: ['catalog.search'],
      technicalAttributes: ['weight', 'application suitability']
    };

    const repaired = repairIntentForOpenEndedRequirementWebCoverage(intent);
    const webRequest = repaired.intent.toolRequests.find((request) => request.tool === 'web.researchProductFacts');

    expect(webRequest).toBeDefined();
    expect(webRequest).toMatchObject({
      required: true,
      coversRequirementIds: ['paving-application'],
      args: {
        productIntent: 'виброплита',
        canonicalProductIntent: 'plate',
        productNames: [],
        comparisonAttributes: ['material']
      }
    });
    expect(repaired.repairs).toEqual([{
      requestId: webRequest!.id,
      requirementIds: ['paving-application']
    }]);
    expect(repaired.intent.grounding).toMatchObject({
      sourcePolicy: 'web_required',
      webPurpose: 'technical_specs',
      webRequirement: 'independent_required',
      requiredToolKinds: expect.arrayContaining(['catalog.search', 'web.researchProductFacts'])
    });
    expect(repaired.intent.selectionPolicy?.requirements[0]?.verification).toEqual({
      mode: 'typed_tool',
      toolRequestId: webRequest!.id,
      tool: 'web.researchProductFacts',
      verifier: 'technical_source_review',
      bindAs: 'material'
    });
    expect(orderToolRequestsForSelectionDependencies(repaired.intent.toolRequests, repaired.intent)
      .map((request) => request.tool)).toEqual(['catalog.search', 'web.researchProductFacts']);
    expect(gateStrictSelectionRequirements(repaired.intent, 'plate', []).blockers).toEqual([]);
    expect(gateStrictSelectionRequirements(repaired.intent, 'plate', []).preliminaryUnverified).toEqual([
      expect.objectContaining({ id: 'paving-application', reason: 'typed_tool_result_missing' })
    ]);

    const finalFit = structuredClone(intent);
    finalFit.selectionPolicy!.selectionGoal = 'final_fit';
    expect(repairIntentForOpenEndedRequirementWebCoverage(finalFit)).toEqual({
      intent: finalFit,
      repairs: []
    });
  });

  it('repairs preliminary open-ended strict constraints onto the single required web verifier', () => {
    const intent = structuredGeneratorCatalogIntent();
    const catalogRequest: ToolRequest = {
      ...intent.toolRequests[0]!,
      coversRequirementIds: ['material-fit', 'loading-fit', 'weight-limit']
    };
    const webRequest: ToolRequest = {
      id: 'web-material-check',
      tool: 'web.researchProductFacts',
      args: {
        query: 'verify crushed-stone suitability of shortlisted plates',
        productIntent: 'виброплита',
        canonicalProductIntent: 'plate',
        productNames: []
      },
      rationale: 'verify the open-ended material application after catalog search',
      required: true,
      coversRequirementIds: []
    };
    intent.toolRequests = [catalogRequest, webRequest];
    intent.selectionPolicy = {
      ...intent.selectionPolicy!,
      targetProductClass: 'виброплита',
      canonicalProductClass: 'plate',
      selectionGoal: 'preliminary_fit',
      requirements: [{
        id: 'material-fit',
        kind: 'material',
        value: 'щебень',
        unit: null,
        role: 'hard_constraint',
        strictness: 'strict',
        evidence: 'для щебня',
        verification: { mode: 'product_attribute' }
      }, {
        id: 'loading-fit',
        kind: 'two_person_loading_suitability',
        value: true,
        unit: null,
        role: 'hard_constraint',
        strictness: 'strict',
        evidence: 'двое смогут погрузить в фургон',
        verification: { mode: 'product_attribute' }
      }, {
        id: 'weight-limit',
        kind: 'weight_max_kg',
        value: 100,
        unit: 'kg',
        role: 'hard_constraint',
        strictness: 'strict',
        evidence: 'не тяжелее 100 кг',
        verification: { mode: 'product_attribute' }
      }]
    };

    const repaired = repairIntentForOpenEndedRequirementWebCoverage(intent);

    expect(repaired.repairs).toEqual([{
      requestId: webRequest.id,
      requirementIds: ['material-fit', 'loading-fit']
    }]);
    expect(repaired.intent.toolRequests[0]?.coversRequirementIds).toEqual(['weight-limit']);
    expect(repaired.intent.toolRequests[1]?.coversRequirementIds).toEqual(['material-fit', 'loading-fit']);
    expect(repaired.intent.selectionPolicy?.requirements[0]?.verification).toEqual({
      mode: 'typed_tool',
      toolRequestId: webRequest.id,
      tool: 'web.researchProductFacts',
      verifier: 'technical_source_review',
      bindAs: 'material'
    });
    expect(repaired.intent.selectionPolicy?.requirements[1]?.verification).toEqual({
      mode: 'typed_tool',
      toolRequestId: webRequest.id,
      tool: 'web.researchProductFacts',
      verifier: 'technical_source_review',
      bindAs: 'two_person_loading_suitability'
    });
    expect(repaired.intent.riskFlags).toContain('planner_repaired_open_ended_requirement_web_coverage');
  });

  it('creates one automatic web verifier when none exists but does not guess between multiple verifiers', () => {
    const intent = structuredGeneratorCatalogIntent();
    intent.selectionPolicy = {
      ...intent.selectionPolicy!,
      targetProductClass: 'виброплита',
      canonicalProductClass: 'plate',
      selectionGoal: 'preliminary_fit',
      requirements: [{
        id: 'material-fit',
        kind: 'material',
        value: 'щебень',
        unit: null,
        role: 'hard_constraint',
        strictness: 'strict',
        evidence: 'для щебня',
        verification: { mode: 'product_attribute' }
      }]
    };

    const repairedWithoutWeb = repairIntentForOpenEndedRequirementWebCoverage(intent);
    const automaticWebRequest = repairedWithoutWeb.intent.toolRequests.find((request) =>
      request.tool === 'web.researchProductFacts'
    );
    expect(automaticWebRequest).toMatchObject({
      required: true,
      coversRequirementIds: ['material-fit']
    });
    expect(repairedWithoutWeb.repairs).toEqual([{
      requestId: automaticWebRequest!.id,
      requirementIds: ['material-fit']
    }]);

    const webRequest: ToolRequest = {
      id: 'web-one',
      tool: 'web.researchProductFacts',
      args: { query: 'verify material fit', productNames: [] },
      rationale: 'first possible owner',
      required: true,
      coversRequirementIds: []
    };
    intent.toolRequests = [intent.toolRequests[0]!, webRequest, { ...webRequest, id: 'web-two' }];
    expect(repairIntentForOpenEndedRequirementWebCoverage(intent)).toEqual({ intent, repairs: [] });
  });

  it('runs deterministic calculations before catalog and open-ended web research after catalog', () => {
    const intent = typedGeneratorProofIntent();
    const webRequest: ToolRequest = {
      id: 'web-check',
      tool: 'web.researchProductFacts',
      args: {
        query: 'verify the shortlisted generator models',
        productIntent: 'generator',
        canonicalProductIntent: 'generator',
        productNames: []
      },
      rationale: 'verify facts missing from catalog cards',
      required: true,
      coversRequirementIds: []
    };
    const requests = [webRequest, intent.toolRequests[1]!, intent.toolRequests[0]!];

    expect(orderToolRequestsForSelectionDependencies(requests, {
      ...intent,
      toolRequests: requests
    }).map((request) => request.tool)).toEqual([
      'calculator.generatorLoad',
      'catalog.search',
      'web.researchProductFacts'
    ]);
  });

  it('runs catalog before web research even when the web request is the typed preliminary proof', () => {
    const intent = structuredGeneratorCatalogIntent();
    const webRequest: ToolRequest = {
      id: 'web-material-check',
      tool: 'web.researchProductFacts',
      args: {
        query: 'verify application suitability of shortlisted models',
        productIntent: 'виброплита',
        canonicalProductIntent: 'plate',
        productNames: []
      },
      rationale: 'verify open-ended suitability after catalog retrieval',
      required: true,
      coversRequirementIds: ['material-fit']
    };
    intent.toolRequests = [webRequest, intent.toolRequests[0]!];
    intent.selectionPolicy = {
      ...intent.selectionPolicy!,
      targetProductClass: 'виброплита',
      canonicalProductClass: 'plate',
      selectionGoal: 'preliminary_fit',
      requirements: [{
        id: 'material-fit',
        kind: 'material',
        value: 'щебень',
        unit: null,
        role: 'hard_constraint',
        strictness: 'strict',
        evidence: 'для щебня',
        verification: {
          mode: 'typed_tool',
          toolRequestId: webRequest.id,
          tool: 'web.researchProductFacts',
          verifier: 'technical_source_review',
          bindAs: 'material_suitability'
        }
      }]
    };

    expect(orderToolRequestsForSelectionDependencies(intent.toolRequests, intent).map((request) => request.tool)).toEqual([
      'catalog.search',
      'web.researchProductFacts'
    ]);
  });

  it('repairs only the missing reverse coverage link for explicit supported typed proofs', () => {
    const source = typedGeneratorProofIntent();

    const repaired = repairIntentForTypedToolRequirementCoverage(source);

    expect(repaired.intent.toolRequests[0]?.coversRequirementIds).toEqual([
      'load-scenario',
      'derived-nominal-minimum'
    ]);
    expect(repaired.intent.toolRequests[1]?.coversRequirementIds).toEqual([]);
    expect(repaired.intent.riskFlags).toContain('planner_repaired_typed_requirement_coverage');
    expect(repaired.repairs).toEqual(expect.arrayContaining([
      { requestId: 'load-calculation', requirementIds: ['derived-nominal-minimum'] },
      { requestId: 'catalog-search', requirementIds: ['derived-nominal-minimum'] }
    ]));
  });

  it('does not repair malformed, optional, missing, mismatched, or unsupported typed proofs', () => {
    const cases: AgentIntentContract[] = [];

    const optionalRequest = typedGeneratorProofIntent();
    optionalRequest.toolRequests[0]!.required = false;
    cases.push(optionalRequest);

    const missingRequest = typedGeneratorProofIntent();
    const missingVerification = missingRequest.selectionPolicy!.requirements[1]!.verification;
    if (missingVerification?.mode === 'typed_tool') missingVerification.toolRequestId = 'missing-calculation';
    cases.push(missingRequest);

    const mismatchedRequest = typedGeneratorProofIntent();
    mismatchedRequest.toolRequests[0] = {
      id: 'load-calculation',
      tool: 'catalog.search',
      args: { query: 'generator' },
      rationale: 'wrong tool under the referenced request id',
      required: true,
      coversRequirementIds: ['load-scenario']
    };
    cases.push(mismatchedRequest);

    const unsupportedVerifier = typedGeneratorProofIntent();
    const unsupportedVerification = unsupportedVerifier.selectionPolicy!.requirements[1]!.verification;
    if (unsupportedVerification?.mode === 'typed_tool') unsupportedVerification.verifier = 'unsupported_profile';
    cases.push(unsupportedVerifier);

    const malformedShape = typedGeneratorProofIntent();
    malformedShape.selectionPolicy!.requirements[1]!.value = 5.5;
    cases.push(malformedShape);

    const duplicateRequirementId = typedGeneratorProofIntent();
    duplicateRequirementId.selectionPolicy!.requirements[1]!.id = 'load-scenario';
    cases.push(duplicateRequirementId);

    for (const intent of cases) {
      expect(repairIntentForTypedToolRequirementCoverage(intent)).toEqual({ intent, repairs: [] });
    }
  });

  it('answers two identical buyer actions as distinct sequential turns with their actual context', async () => {
    const secondTurnId = '44444444-4444-4444-8444-444444444444';
    class SequentialConversations extends FakeConversations {
      ledgerRows: Array<Record<string, unknown>> = [];

      async listDialogueLedgerEvents() {
        return this.ledgerRows;
      }

      async upsertDialogueLedgerEvent(input: Record<string, unknown>) {
        this.ledgerEvents.push(input);
        this.ledgerRows.push({
          session_id: input.sessionId,
          turn_id: input.turnId,
          event_id: input.eventId,
          event_type: input.eventType,
          scope: input.scope,
          payload: input.payload,
          evidence: input.evidence,
          source: input.source,
          status: input.status,
          event_seq: this.ledgerRows.length + 1
        });
        return input;
      }
    }

    const conversations = new SequentialConversations();
    conversations.messages = [];
    conversations.turn = { ...turn(), userMessageId: null };
    let deltaCall = 0;
    const plannedBuyerTurnCounts: number[] = [];
    let answerCall = 0;
    const repeatedText = 'Да';
    const orchestrator = new AgentManagerOrchestrator(
      conversations as never,
      new FakeProducts() as never,
      new FakeLeads() as never,
      model({
        async proposeLedgerDelta() {
          deltaCall += 1;
          return {
            rationale: `record repeated buyer action ${deltaCall}`,
            events: [{
              eventType: deltaCall === 1 ? 'need.opened' : 'need.updated',
              scope: 'need',
              payload: {
                needId: 'confirmation-thread',
                productClass: 'generator',
                summary: `Repeated confirmation action ${deltaCall}`,
                constraints: [],
                openQuestions: [],
                selectedProductIds: [],
                rejectedProductIds: [],
                status: 'open',
                activate: true
              },
              evidence: repeatedText,
              source: 'llm_state_delta',
              status: 'active'
            }]
          };
        },
        async planTurn(input) {
          const buyerTurnCount = input.history.filter((item) => item.role === 'user').length;
          plannedBuyerTurnCounts.push(buyerTurnCount);
          return {
            userMessageSummary: `confirmation number ${plannedBuyerTurnCounts.at(-1)}`,
            dialogueUnderstanding: 'the same surface text is a new action in later context',
            nextStepRationale: 'answer this exact turn in sequence',
            requiresTools: false,
            toolRequests: [],
            selectionPolicy: {
              ...currentNoProductSelectionPolicy(),
              targetProductClass: 'generator',
              canonicalProductClass: 'generator',
              needAction: buyerTurnCount === 1 ? 'open' : 'continue'
            },
            mustNotAskQuestionIds: [],
            riskFlags: []
          };
        },
        async composeAnswer(input) {
          answerCall += 1;
          const buyerTurns = input.history.filter((item) => item.role === 'user').length;
          return {
            answerText: `Handled identical action ${answerCall} with ${buyerTurns} buyer turns in context.`,
            factsUsed: [],
            questionsAsked: [],
            toolResultIds: [],
            leadAction: 'none',
            riskFlags: []
          };
        }
      })
    );

    const first = await orchestrator.generateAnswer({ sessionId, turnId, userMessage: repeatedText });

    conversations.turn = {
      ...turn(),
      id: secondTurnId,
      userMessageId: null,
      assistantMessageId: null,
      status: 'received'
    };
    conversations.checkpoints = [];
    conversations.toolArtifacts = [];
    conversations.finalAnswerContract = null;

    const second = await orchestrator.generateAnswer({ sessionId, turnId: secondTurnId, userMessage: repeatedText });

    expect(conversations.messages.filter((item) => item.role === 'user').map((item) => item.content)).toEqual([
      repeatedText,
      repeatedText
    ]);
    expect(conversations.assistantSaves).toHaveLength(2);
    expect(first.answer).toContain('identical action 1 with 1 buyer turns');
    expect(second.answer).toContain('identical action 2 with 2 buyer turns');
    expect(plannedBuyerTurnCounts).toEqual([1, 2]);
    expect(conversations.ledgerRows.map((row) => row.turn_id)).toEqual([turnId, secondTurnId]);
  });

  it('uses ledger state for the turn and returns a ledger-derived needState snapshot', async () => {
    const conversations = new FakeConversations();
    const orchestrator = new AgentManagerOrchestrator(conversations as never, new FakeProducts() as never, new FakeLeads() as never, model());

    const payload = await orchestrator.generateAnswer({
      sessionId,
      turnId,
      userMessage: 'Coffee machine 3.2 kW, grinder 400 W, is 5 kW enough?'
    });

    expect(payload.metadata?.agentManager).toBe(true);
    expect(payload.metadata?.managerPolicy).toMatchObject({
      packVersion: expect.any(String),
      packHash: expect.any(String),
      selectedByPlanner: []
    });
    const managerPolicy = payload.metadata?.managerPolicy as { packHash?: string } | undefined;
    expect(managerPolicy?.packHash).toHaveLength(64);
    expect([...String(managerPolicy?.packHash ?? '')].every((char) => 'abcdef0123456789'.includes(char))).toBe(true);
    const turnBudget = payload.metadata?.turnBudget as { usage?: { modelCalls?: number } } | undefined;
    expect(turnBudget?.usage?.modelCalls).toBe(3);
    expect(conversations.ledgerEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({ eventType: 'question.answered' }),
      expect.objectContaining({ eventType: 'fact.confirmed' })
    ]));
    expect(conversations.assistantSaves).toHaveLength(1);
    expect(payload.needState.activeNeeds[0]).toMatchObject({ id: 'generator', productClass: 'generator' });
    expect(payload.needState.activeNeeds[0]?.openQuestions).not.toContain('What is the coffee machine power?');
    expect(conversations.answerContracts).toContainEqual(expect.objectContaining({
      status: 'final',
      responsePayload: expect.objectContaining({
        answer: payload.answer,
        productCards: payload.productCards,
        usedWebSearch: payload.usedWebSearch
      })
    }));
  });

  it('rewrites hallucinated model recommendations when a strict requirement has no verifier', async () => {
    const conversations = new FakeConversations();
    conversations.messages = [message('Need a generator no louder than 60 dB.')];
    const semanticReview = vi.fn(async () => ({ verdict: 'pass' as const, issues: [] }));
    const strictModel = model({
      async planTurn() {
        return {
          userMessageSummary: 'generator with a strict noise ceiling',
          dialogueUnderstanding: 'noise must not exceed 60 dB',
          nextStepRationale: 'search catalog, but recommend only if the strict noise fact is verifiable',
           requiresTools: true,
          toolRequests: [{
            id: 'catalog-noise-search',
            tool: 'catalog.search',
            args: {
              query: 'generator 60 dB',
              semanticQuery: 'generator with verified noise no more than 60 dB',
              productIntent: 'generator',
              canonicalProductIntent: 'generator',
              limit: 4
            },
            rationale: 'find catalog generators for the strict noise requirement',
            required: true
          }],
          grounding: {
            taskType: 'product_selection',
            sourcePolicy: 'catalog_required',
            webPurpose: 'none',
            requiredToolKinds: ['catalog.search'],
            technicalAttributes: ['noise_db'],
            rationale: 'a catalog product selection requires catalog evidence'
          },
          productMentions: [],
          selectionPolicy: {
            targetProductClass: 'generator',
            canonicalProductClass: 'generator',
            needAction: 'continue',
            alternativePolicy: 'same_class_only',
            reusePreviousCards: false,
            maxCards: 4,
            powerSource: 'any',
            phase: 'any',
            requirements: [{
              id: 'noise-ceiling',
              kind: 'noise_max_db',
              value: 60,
              unit: 'dB',
              role: 'hard_constraint',
              strictness: 'strict',
              evidence: '«no louder than 60 dB»'
            }],
            rationale: 'the buyer made noise a strict constraint'
          },
          policyRuleIds: [],
          mustNotAskQuestionIds: [],
          riskFlags: []
        };
      },
      async composeAnswer(input) {
        expect(input.products).toEqual([]);
        return {
          answerText: 'Generator 5 kW is a perfect recommendation and definitely meets 60 dB.',
          factsUsed: [],
          questionsAsked: [],
          toolResultIds: ['catalog-noise-search'],
          selectedProductIds: ['p1'],
          leadAction: 'none',
          riskFlags: [],
          selectionReadiness: {
            productClass: 'generator',
            status: 'ready_for_exact_cards',
            canShowProductCards: true,
            missingFacts: [],
            rationale: 'intentionally unsafe writer output for the regression'
          }
        };
      },
      reviewAnswer: semanticReview
    });
    const orchestrator = new AgentManagerOrchestrator(
      conversations as never,
      new FakeProducts() as never,
      new FakeLeads() as never,
      strictModel
    );

    const payload = await orchestrator.generateAnswer({
      sessionId,
      turnId,
      userMessage: 'Need a generator no louder than 60 dB.'
    });

    expect(payload.answer).toContain('Не буду рекомендовать конкретную модель наугад');
    expect(payload.answer).toContain('no louder than 60 dB');
    expect(payload.answer).not.toContain('««');
    expect(payload.answer).not.toContain('noise_max_db');
    expect(payload.answer).not.toContain('Generator 5 kW');
    expect(payload.productCards).toEqual([]);
    expect(semanticReview).not.toHaveBeenCalled();
    expect(payload.metadata?.preSendReview).toMatchObject({
      verdict: 'rewrite_required',
      issues: expect.arrayContaining([
        expect.objectContaining({ code: 'unverifiable_strict_hard_constraint' }),
        expect.objectContaining({ code: 'selected_product_without_evidence' })
      ])
    });
  });

  it('preserves a safe clarification when a strict typed requirement is intentionally pending', async () => {
    const conversations = new FakeConversations();
    conversations.messages = [message('Need a generator for a house with a refrigerator, pump, boiler and occasional power tools.')];
    const semanticReview = vi.fn(async () => ({ verdict: 'pass' as const, issues: [] }));
    const clarificationText = 'A precise model would be premature until the pump load is known. As an orientation, this class often starts around 5–7 kW. What type and power is the pump, and is it 220 or 380 V?';
    const clarificationModel = model({
      async planTurn() {
        return {
          userMessageSummary: 'orient the buyer and ask for the decisive pump fact',
          dialogueUnderstanding: 'the generator load scenario is real but cannot be calculated before clarification',
          nextStepRationale: 'give a bounded orientation without product cards and ask one useful question',
          requiresTools: false,
          toolRequests: [],
          productMentions: [],
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
              id: 'product-class',
              kind: 'product_type',
              value: 'generator',
              unit: null,
              role: 'hard_constraint',
              strictness: 'strict',
              evidence: 'Need a generator',
              verification: { mode: 'product_attribute' }
            }, {
              id: 'pending-load-scenario',
              kind: 'generator_load_scenario',
              value: true,
              unit: null,
              role: 'hard_constraint',
              strictness: 'strict',
              evidence: 'refrigerator, pump, boiler and occasional power tools',
              verification: {
                mode: 'typed_tool',
                toolRequestId: 'future-load-calculation',
                tool: 'calculator.generatorLoad',
                verifier: 'generator_load_profile',
                bindAs: 'nominal_power_min_kw'
              }
            }],
            rationale: 'product selection stays blocked until the pump fact is known'
          },
          policyRuleIds: [],
          mustNotAskQuestionIds: [],
          riskFlags: ['unresolved_strict_clarification']
        };
      },
      async composeAnswer() {
        return {
          answerText: clarificationText,
          factsUsed: [],
          questionsAsked: [{
            questionId: 'pump-specs',
            text: 'What type and power is the pump, and is it 220 or 380 V?',
            reason: 'The pump determines the starting load.'
          }],
          toolResultIds: [],
          selectedProductIds: [],
          leadAction: 'none',
          riskFlags: [],
          selectionReadiness: {
            productClass: 'generator',
            status: 'needs_more_info',
            canShowProductCards: false,
            missingFacts: ['pump_type', 'pump_power', 'pump_phase'],
            rationale: 'No concrete product should be selected before the pump load is known.'
          }
        };
      },
      reviewAnswer: semanticReview
    });
    const orchestrator = new AgentManagerOrchestrator(
      conversations as never,
      new FakeProducts() as never,
      new FakeLeads() as never,
      clarificationModel
    );

    const previousReviewMode = config.AI_MANAGER_REVIEW_MODE;
    config.AI_MANAGER_REVIEW_MODE = 'risk';
    try {
      const payload = await orchestrator.generateAnswer({
        sessionId,
        turnId,
        userMessage: 'Need a generator for a house with a refrigerator, pump, boiler and occasional power tools.'
      });

      expect(payload.answer).toBe(clarificationText);
      expect(payload.answer).not.toContain('could not reliably complete');
      expect(payload.productCards).toEqual([]);
      expect(semanticReview).toHaveBeenCalledTimes(1);
      expect(payload.metadata?.preSendReview).toMatchObject({ verdict: 'pass', issues: [] });
      expect(payload.metadata?.answerProductEvidence).toMatchObject({ products: [] });
    } finally {
      config.AI_MANAGER_REVIEW_MODE = previousReviewMode;
    }
  });

  it('keeps derived simultaneous-operation requirements eligible after covered generator calculation', async () => {
    class DerivedConstraintProducts extends FakeProducts {
      queries: string[] = [];

      async searchProducts(query = ''): Promise<Product[]> {
        this.queries.push(query);
        if (query.includes('generator nominal power at least')) {
          return [{
            ...generatorProductWithPower('strong-derived', 'TSS SGG 10000EH generator', 9),
            specs: { 'мощность номинальная при 220 в, квт': '9' }
          }];
        }
        return [
          generatorProductWithPower('weak-derived', 'TSS SGG 4000EH generator', 3),
          {
            ...generatorProductWithPower('maximum-only-derived', 'TSS SGG 6000EH gasoline generator maximum power 6 kW', 6),
            specs: { 'Максимальная мощность': '6 кВт' }
          },
          {
            ...generatorProductWithPower('apparent-only-derived', 'TSS SGG 6500EH gasoline generator', 6),
            specs: { 'Номинальная мощность': '6 кВА' }
          },
          {
            ...generatorProductWithPower('displayed-max-derived', 'TSS SGG 6000EH generator 6 kW', 6),
            specs: {
              'Номинальная мощность': '1 кВт',
              'Максимальная мощность': '6 кВт'
            }
          }
        ];
      }
    }

    const conversations = new FakeConversations();
    conversations.messages = [message('The 1.1 kW borehole pump and 1.5 kW angle grinder run simultaneously at 220 V.')];
    const semanticReview = vi.fn(async () => ({ verdict: 'pass' as const, issues: [] }));
    const derivedModel = model({
      async planTurn() {
        return {
          turnId,
          userMessageSummary: 'size a single-phase generator for two simultaneous loads',
          dialogueUnderstanding: 'simultaneous operation is consumed by the typed load calculator',
          nextStepRationale: 'calculate the minimum and search products above it',
          requiresTools: true,
          toolRequests: ([{
            id: 'load-calculation',
            tool: 'calculator.generatorLoad',
            args: {
              productIntent: 'generator',
              canonicalProductIntent: 'generator',
              phase: 'single_phase',
              loads: [{
                kind: 'pump',
                name: 'borehole pump',
                count: 1,
                runningKw: 1.1,
                startingKw: 3.3,
                source: 'explicit_user',
                evidence: '1.1 kW borehole pump',
                basisKind: 'exact_power',
                basisSignals: ['consumer_type_known', 'voltage_or_phase_known', 'simultaneous_operation_known', 'explicit_power']
              }, {
                kind: 'handheld_tool',
                name: 'angle grinder',
                count: 1,
                runningKw: 1.5,
                startingKw: 2,
                source: 'explicit_user',
                evidence: '1.5 kW angle grinder',
                basisKind: 'exact_power',
                basisSignals: ['voltage_or_phase_known', 'simultaneous_operation_known', 'explicit_power']
              }],
              simultaneousStarting: false,
              simultaneousStartingKinds: [],
              estimateBasis: 'exact_or_user_provided'
            },
            rationale: 'derive the minimum nominal generator power',
            required: true,
            coversRequirementIds: ['simultaneous-loads']
          }, {
            id: 'catalog-search',
            tool: 'catalog.search',
            args: {
              query: 'single-phase generator for 5 kW calculated load',
              semanticQuery: 'single-phase generator above the calculated minimum',
              productIntent: 'generator',
              canonicalProductIntent: 'generator',
              phase: 'single_phase',
              limit: 8
            },
            rationale: 'find generator products after the calculation',
            required: true,
            coversRequirementIds: []
          }] satisfies ToolRequest[]).reverse(),
          productMentions: [],
          selectionPolicy: {
            targetProductClass: 'generator',
            canonicalProductClass: 'generator',
            needAction: 'continue',
            alternativePolicy: 'same_class_only',
            reusePreviousCards: false,
            maxCards: 4,
            powerSource: 'any',
            phase: 'any',
            requirements: [{
              id: 'simultaneous-loads',
              kind: 'generator_load_scenario',
              value: true,
              unit: null,
              role: 'hard_constraint',
              strictness: 'strict',
              evidence: 'the borehole pump and angle grinder run simultaneously',
              verification: {
                mode: 'typed_tool',
                toolRequestId: 'load-calculation',
                tool: 'calculator.generatorLoad',
                verifier: 'generator_load_profile',
                bindAs: 'nominal_power_min_kw'
              }
            }],
            rationale: 'the operating condition is verified through the load result'
          },
          policyRuleIds: [],
          mustNotAskQuestionIds: [],
          riskFlags: []
        };
      },
      async composeAnswer(input) {
        expect(input.products.map((item) => item.id)).toEqual(['strong-derived']);
        const required = (input.toolResults[0]?.payload as { profile?: { requiredNominalKw?: number } }).profile?.requiredNominalKw;
        return {
          answerText: `The calculated minimum is ${required} kW. TSS SGG 10000EH generator clears that requirement.`,
          factsUsed: [],
          questionsAsked: [],
          toolResultIds: ['load-calculation', 'catalog-search'],
          selectedProductIds: ['strong-derived'],
          leadAction: 'none',
          riskFlags: [],
          selectionReadiness: {
            productClass: 'generator',
            status: 'ready_for_exact_cards',
            canShowProductCards: true,
            missingFacts: [],
            rationale: 'The exact input powers and successful calculation support selection.'
          }
        };
      },
      reviewAnswer: semanticReview
    });
    const products = new DerivedConstraintProducts();
    const orchestrator = new AgentManagerOrchestrator(
      conversations as never,
      products as never,
      new FakeLeads() as never,
      derivedModel
    );

    const payload = await orchestrator.generateAnswer({
      sessionId,
      turnId,
      userMessage: 'The 1.1 kW borehole pump and 1.5 kW angle grinder run simultaneously at 220 V.'
    });

    expect(payload.answer).toContain('TSS SGG 10000EH');
    expect(products.queries).toEqual(expect.arrayContaining([
      expect.stringContaining('generator nominal power at least')
    ]));
    expect(payload.productCards.map((card) => card.id)).toEqual(['strong-derived']);
    expect(payload.productCards.map((card) => card.id)).not.toContain('weak-derived');
    const metadata = payload.metadata as {
      toolResults?: Array<{ payload?: { profile?: { simultaneousStarting?: boolean } } }>;
      preSendReview?: unknown;
    };
    expect(metadata.toolResults?.[0]?.payload?.profile?.simultaneousStarting).toBe(false);
    expect((metadata.toolResults?.[1]?.payload as {
      generatorLoadFit?: { loadAwareRetry?: boolean };
    })?.generatorLoadFit?.loadAwareRetry).toBe(true);
    expect(payload.metadata?.preSendReview).toMatchObject({ verdict: 'pass' });
    expect(payload.metadata?.preSendReview).not.toMatchObject({
      issues: expect.arrayContaining([expect.objectContaining({ code: 'unverifiable_strict_hard_constraint' })])
    });
  });

  it('rehydrates a snapshot plus tail after more than 80 real dialogue messages without losing active manager state', async () => {
    const longTurnId = '55555555-5555-4555-8555-555555555555';
    const eventTurnId = (index: number) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
    const ledgerEvent = (
      index: number,
      input: Pick<DialogueLedgerEvent, 'eventType' | 'scope' | 'payload' | 'evidence' | 'source' | 'status'>
    ): DialogueLedgerEvent => ({
      sessionId,
      turnId: eventTurnId(index),
      eventId: `long-event-${index}`,
      createdAt: new Date(Date.UTC(2026, 6, 10, 0, index)).toISOString(),
      ...input
    });

    const events: DialogueLedgerEvent[] = [
      ledgerEvent(1, {
        eventType: 'need.opened',
        scope: 'need',
        payload: {
          needId: 'clinic-generator',
          productClass: 'generator',
          summary: 'Select a backup generator for a small clinic',
          constraints: ['critical medical loads must remain powered'],
          openQuestions: ['Confirm the X-ray unit starting current'],
          selectedProductIds: ['generator-selected'],
          rejectedProductIds: ['generator-rejected'],
          status: 'open',
          activate: true
        },
        evidence: 'We need backup power for a small clinic.',
        source: 'llm_state_delta',
        status: 'active'
      }),
      ledgerEvent(2, {
        eventType: 'fact.confirmed',
        scope: 'need',
        payload: {
          factKey: 'budget.max_rub',
          value: 650000,
          needId: 'clinic-generator',
          productClass: 'generator',
          role: 'hard_requirement'
        },
        evidence: 'Budget is strictly up to 650000 RUB.',
        source: 'llm_state_delta',
        status: 'active'
      }),
      ledgerEvent(3, {
        eventType: 'fact.confirmed',
        scope: 'lead',
        payload: {
          factKey: 'lead.contact_approved',
          value: true,
          needId: 'clinic-generator',
          role: 'commercial'
        },
        evidence: 'You may use my saved phone for the clinic quote.',
        source: 'llm_state_delta',
        status: 'active'
      }),
      ledgerEvent(4, {
        eventType: 'question.asked',
        scope: 'question',
        payload: {
          questionId: 'clinic.xray_start',
          needId: 'clinic-generator',
          text: 'Confirm the X-ray unit starting current'
        },
        evidence: 'The X-ray starting current is not known yet.',
        source: 'llm_state_delta',
        status: 'active'
      }),
      ledgerEvent(5, {
        eventType: 'fact.confirmed',
        scope: 'product',
        payload: {
          factKey: 'required.nominal_power_kw',
          value: 18,
          needId: 'clinic-generator',
          productClass: 'generator',
          role: 'hard_requirement'
        },
        evidence: 'https://evidence.example.test/clinic-load-audit',
        source: 'web',
        status: 'active'
      })
    ];
    for (let index = 6; index <= 89; index += 1) {
      events.push(ledgerEvent(index, {
        eventType: 'fact.confirmed',
        scope: 'dialogue',
        payload: {
          factKey: `history.note.${index}`,
          value: `confirmed dialogue fact ${index}`,
          needId: 'clinic-generator',
          productClass: 'generator',
          role: 'context'
        },
        evidence: `dialogue message ${index}`,
        source: 'llm_state_delta',
        status: 'active'
      }));
    }
    events.push(ledgerEvent(90, {
      eventType: 'need.updated',
      scope: 'need',
      payload: {
        needId: 'clinic-generator',
        productClass: 'generator',
        summary: 'Select a verified 18 kW backup generator for the small clinic',
        status: 'open',
        activate: true
      },
      evidence: 'Continue with the clinic generator after the long dialogue.',
      source: 'llm_state_delta',
      status: 'active'
    }));

    const snapshotState = reduceDialogueLedger(events.slice(0, 80));
    const tailRows = events.slice(80).map((item, index) => ({
      session_id: item.sessionId,
      turn_id: item.turnId,
      event_id: item.eventId,
      event_type: item.eventType,
      scope: item.scope,
      payload: item.payload,
      evidence: item.evidence,
      source: item.source,
      status: item.status,
      event_seq: 81 + index,
      created_at: item.createdAt
    }));

    class LongHistoryConversations extends FakeConversations {
      constructor() {
        super();
        this.messages = Array.from({ length: 90 }, (_, index) => ({
          id: index === 89 ? userMessageId : eventTurnId(index + 101),
          sessionId,
          role: index === 89 || index % 2 === 0 ? 'user' as const : 'assistant' as const,
          content: index === 89
            ? 'Continue with the clinic generator after the long dialogue.'
            : `Long dialogue message ${index + 1}`,
          metadata: {},
          createdAt: new Date(Date.UTC(2026, 6, 10, 2, index)).toISOString()
        }));
        this.turn = { ...turn(), id: longTurnId, userMessageId, status: 'received' };
      }

      async listMessages(_sessionId?: string, limit = 80) {
        return this.messages.slice(-limit);
      }

      async getDialogueLedgerSnapshot() {
        return {
          session_id: sessionId,
          through_event_seq: 80,
          state: JSON.parse(JSON.stringify(snapshotState)),
          recent_events: events.slice(0, 80)
        };
      }

      async listDialogueLedgerEventsAfter() {
        return tailRows;
      }
    }

    const conversations = new LongHistoryConversations();
    let plannerHistory: Message[] = [];
    let plannerLedgerEventCount = 0;
    const orchestrator = new AgentManagerOrchestrator(
      conversations as never,
      new FakeProducts() as never,
      new FakeLeads() as never,
      model({
        async proposeLedgerDelta() {
          return { rationale: 'No new durable fact in this continuation.', events: [] };
        },
        async planTurn(input) {
          plannerHistory = input.history;
          plannerLedgerEventCount = input.ledgerEvents.length;
          return {
            userMessageSummary: 'continue the clinic generator selection',
            dialogueUnderstanding: 'resume the preserved active objective',
            nextStepRationale: 'answer from compacted durable state',
            requiresTools: false,
            toolRequests: [],
            mustNotAskQuestionIds: [],
            riskFlags: []
          };
        },
        async composeAnswer() {
          return {
            answerText: 'The clinic generator objective and its verified constraints are preserved.',
            factsUsed: [],
            questionsAsked: [],
            toolResultIds: [],
            leadAction: 'none',
            riskFlags: []
          };
        }
      })
    );

    const payload = await orchestrator.generateAnswer({
      sessionId,
      turnId: longTurnId,
      userMessage: 'Continue with the clinic generator after the long dialogue.'
    });

    expect(plannerHistory).toHaveLength(80);
    expect(plannerHistory[0]?.content).toBe('Long dialogue message 11');
    expect(plannerLedgerEventCount).toBe(90);
    expect(payload.needState.activeNeeds).toContainEqual(expect.objectContaining({
      id: 'clinic-generator',
      summary: 'Select a verified 18 kW backup generator for the small clinic',
      selectedProductIds: ['generator-selected'],
      status: 'open'
    }));
    expect(payload.needState.selectionState.rejectedProducts).toContainEqual(
      expect.objectContaining({ productId: 'generator-rejected' })
    );
    expect(payload.needState.activeNeeds[0]?.openQuestions).toContain('Confirm the X-ray unit starting current');
    expect(budgetMaxFromNeedState(payload.needState)).toBe(650000);
    expect(payload.needState.confirmedFacts).toContainEqual(expect.objectContaining({
      value: 'lead.contact_approved: true',
      evidence: 'You may use my saved phone for the clinic quote.'
    }));
    expect(payload.needState.confirmedFacts).toContainEqual(expect.objectContaining({
      value: 'required.nominal_power_kw: 18',
      evidence: 'https://evidence.example.test/clinic-load-audit'
    }));
  });

  it('falls back to authoritative full replay when a snapshot has malformed nested state', async () => {
    const persistedNeed: DialogueLedgerEvent = {
      sessionId,
      turnId,
      eventId: 'persisted-generator-need',
      eventType: 'need.opened',
      scope: 'need',
      payload: {
        needId: 'generator',
        productClass: 'generator',
        summary: 'Persisted generator need',
        constraints: ['up to 80 kg'],
        openQuestions: ['Confirm the phase'],
        selectedProductIds: [],
        rejectedProductIds: ['too-heavy'],
        status: 'open',
        activate: true
      },
      evidence: 'The buyer requested a portable generator.',
      source: 'llm_state_delta',
      status: 'active',
      createdAt: '2026-08-09T10:00:00.000Z'
    };
    const persistedRow = {
      session_id: persistedNeed.sessionId,
      turn_id: persistedNeed.turnId,
      event_id: persistedNeed.eventId,
      event_type: persistedNeed.eventType,
      scope: persistedNeed.scope,
      payload: persistedNeed.payload,
      evidence: persistedNeed.evidence,
      source: persistedNeed.source,
      status: persistedNeed.status,
      event_seq: 1,
      created_at: persistedNeed.createdAt
    };

    class MalformedSnapshotConversations extends FakeConversations {
      replayCursors: number[] = [];

      async getDialogueLedgerSnapshot() {
        return {
          session_id: sessionId,
          through_event_seq: 1,
          state: {
            eventIds: ['bad-fact'],
            factsByKey: {
              bad: {
                factKey: 'budget.max_rub',
                eventId: 'bad-fact',
                status: 'active'
              }
            },
            questionsById: {},
            needsById: {},
            warnings: []
          },
          recent_events: []
        };
      }

      async listDialogueLedgerEventsAfter(_sessionId: string, afterEventSeq: number) {
        this.replayCursors.push(afterEventSeq);
        return afterEventSeq === 0 ? [persistedRow] : [];
      }
    }

    const conversations = new MalformedSnapshotConversations();
    const orchestrator = new AgentManagerOrchestrator(
      conversations as never,
      new FakeProducts() as never,
      new FakeLeads() as never,
      model({
        async proposeLedgerDelta() {
          return { rationale: 'No new durable facts.', events: [] };
        },
        async planTurn(input) {
          expect(input.ledgerState.needsById.generator).toMatchObject({
            summary: 'Persisted generator need',
            rejectedProductIds: ['too-heavy']
          });
          return {
            userMessageSummary: 'continue the persisted generator need',
            dialogueUnderstanding: 'the durable state was restored from authoritative events',
            nextStepRationale: 'continue without losing the need',
            requiresTools: false,
            toolRequests: [],
            mustNotAskQuestionIds: [],
            riskFlags: []
          };
        }
      })
    );

    const payload = await orchestrator.generateAnswer({
      sessionId,
      turnId,
      userMessage: 'Continue the generator selection.'
    });

    expect(conversations.replayCursors).toContain(0);
    expect(payload.needState.activeNeeds).toContainEqual(expect.objectContaining({
      id: 'generator',
      constraints: ['up to 80 kg'],
      openQuestions: ['Confirm the phase']
    }));
    expect(payload.needState.selectionState.rejectedProducts).toContainEqual(
      expect.objectContaining({ productId: 'too-heavy' })
    );
    expect(payload.metadata).toMatchObject({
      warnings: expect.arrayContaining(['invalid_snapshot_replayed_from_events'])
    });
  });

  it('repairs catalog-required product selection plans that omit catalog.search', async () => {
    const conversations = new FakeConversations();
    conversations.messages = [message('Need a vibroplate for paving slabs that I can load into a trunk.')];
    let composeInput: Parameters<AgentManagerModel['composeAnswer']>[0] | undefined;
    const catalogRequiredModel = model({
      async planTurn() {
        return {
          userMessageSummary: 'buyer needs a compact plate for paving slabs and trunk loading',
          dialogueUnderstanding: 'this is a product selection and catalog cards are needed',
          nextStepRationale: 'search the catalog for compact vibroplates',
          requiresTools: false,
          toolRequests: [],
          grounding: {
            taskType: 'product_selection',
            sourcePolicy: 'catalog_required',
            webPurpose: 'none',
            requiredToolKinds: ['catalog.search'],
            technicalAttributes: ['compact vibroplate', 'paving slabs', 'trunk loading'],
            rationale: 'A concrete product selection must use catalog products.'
          },
          productMentions: [{
            name: 'vibroplate',
            role: 'target_product',
            productClass: 'plate',
            evidence: 'Need a vibroplate'
          }],
          mustNotAskQuestionIds: [],
          riskFlags: []
        };
      },
      async composeAnswer(input) {
        composeInput = input;
        return {
          answerText: 'I found compact plate options from the catalog for paving slabs and trunk loading.',
          factsUsed: [],
          questionsAsked: [],
          toolResultIds: input.toolResults.map((result) => result.requestId),
          leadAction: 'none',
          riskFlags: [],
          selectionReadiness: {
            productClass: 'plate',
            status: 'ready_for_exact_cards',
            canShowProductCards: true,
            missingFacts: [],
            rationale: 'catalog products were retrieved for the concrete plate selection'
          }
        };
      }
    });
    const orchestrator = new AgentManagerOrchestrator(
      conversations as never,
      new PlateProducts() as never,
      new FakeLeads() as never,
      catalogRequiredModel
    );

    const payload = await orchestrator.generateAnswer({
      sessionId,
      turnId,
      userMessage: 'Need a vibroplate for paving slabs that I can load into a trunk.'
    });

    expect(composeInput?.intent.toolRequests.map((request) => request.tool)).toContain('catalog.search');
    expect(composeInput?.intent.riskFlags).toContain('planner_repaired_grounding_catalog_tool');
    expect(composeInput?.products.map((item) => item.id)).toEqual(expect.arrayContaining(['plate-light', 'plate-mid']));
    expect(payload.productCards.map((card: ProductCard) => card.id)).toEqual(expect.arrayContaining(['plate-light', 'plate-mid']));
  });

  it('uses product embeddings inside catalog tools when embedding coverage is usable', async () => {
    const conversations = new FakeConversations();
    const products = new HybridProducts();
    const catalogModel = model({
      async planTurn() {
        return {
          turnId,
          userMessageSummary: 'buyer asks for coffee point generator options',
          dialogueUnderstanding: 'catalog options are needed',
          nextStepRationale: 'search catalog using the buyer need',
          requiresTools: true,
          toolRequests: [{
            id: 'catalog-search',
            tool: 'catalog.search',
            args: {
              query: 'generator for coffee point 6 kW reserve',
              limit: 4,
              productIds: [],
              productNames: [],
              comparisonAttributes: [],
              loads: [],
              simultaneousStarting: null,
              simultaneousStartingKinds: [],
              contact: { name: null, phone: null, email: null, preferredContact: null, comment: null },
              reason: null,
              notes: null
            },
            rationale: 'buyer asked for options from the catalog',
             required: true
           }],
           mustNotAskQuestionIds: [],
          riskFlags: []
        };
      },
      async composeAnswer() {
        return {
          answerText: 'I found a minimal option and a reserve option.',
          factsUsed: [],
          questionsAsked: [],
          toolResultIds: ['catalog-search'],
          leadAction: 'none',
          riskFlags: []
        };
      }
    });
    const orchestrator = new AgentManagerOrchestrator(
      conversations as never,
      products as never,
      new FakeLeads() as never,
      catalogModel,
      async () => [0.1, 0.2, 0.3]
    );

    const payload = await orchestrator.generateAnswer({
      sessionId,
      turnId,
      userMessage: 'Show generator options for coffee point.'
    });

    expect(products.vectorCalls).toBe(1);
    const metadata = payload.metadata as { toolResults?: Array<{ payload?: unknown }> };
    expect(metadata.toolResults?.[0]?.payload).toMatchObject({
      productIds: expect.arrayContaining(['text-product', 'vector-product']),
      retrieval: {
        usedEmbeddings: true,
        textCount: 1,
        vectorCount: 1
      }
    });
    expect(payload.productCards.map((card) => card.id)).toEqual(expect.arrayContaining(['text-product', 'vector-product']));
  });

  it('applies the declared read-tool retry policy and records the attempt count', async () => {
    const candidate = product('retry-model', 'TSS SGG 5000E gasoline generator 5 kW');
    class FlakyProducts extends FakeProducts {
      calls = 0;
      async searchProducts() {
        this.calls += 1;
        if (this.calls === 1) throw new Error('temporary catalog failure');
        return [candidate];
      }
    }
    const conversations = new FakeConversations();
    const products = new FlakyProducts();
    const catalogModel = model({
      async planTurn() {
        return {
          userMessageSummary: 'buyer requests a catalog generator',
          dialogueUnderstanding: 'find a grounded generator candidate',
          nextStepRationale: 'retry a transient catalog read within policy',
          requiresTools: true,
          toolRequests: [{
            id: 'catalog-retry',
            tool: 'catalog.search',
            args: {
              query: 'бензиновый генератор 5 кВт',
              productIntent: 'generator',
              canonicalProductIntent: 'generator'
            },
            rationale: 'read current catalog data',
            required: true
          }],
          productMentions: [],
          selectionPolicy: {
            targetProductClass: 'generator',
            canonicalProductClass: 'generator',
            needAction: 'continue',
            alternativePolicy: 'same_class_only',
            reusePreviousCards: false,
            maxCards: 2,
            powerSource: 'fuel',
            phase: 'any',
            requirements: [],
            rationale: 'show the grounded selected generator'
          },
          policyRuleIds: [],
          mustNotAskQuestionIds: [],
          riskFlags: []
        };
      },
      async composeAnswer() {
        return {
          answerText: `${candidate.name} найден в каталоге.`,
          factsUsed: [],
          questionsAsked: [],
          toolResultIds: ['catalog-retry'],
          selectedProductIds: [candidate.id],
          leadAction: 'none',
          riskFlags: []
        };
      }
    });
    const orchestrator = new AgentManagerOrchestrator(
      conversations as never,
      products as never,
      new FakeLeads() as never,
      catalogModel
    );

    const payload = await orchestrator.generateAnswer({
      sessionId,
      turnId,
      userMessage: 'Покажите подходящий бензиновый генератор на 5 кВт.'
    });

    expect(products.calls).toBeGreaterThanOrEqual(2);
    expect(payload.productCards.map((card) => card.id)).toEqual([candidate.id]);
    expect(conversations.toolArtifacts).toContainEqual(expect.objectContaining({
      toolRequestId: 'catalog-retry',
      status: 'ok',
      warnings: expect.arrayContaining(['attempts:2'])
    }));
    expect((payload.metadata?.turnBudget as { usage?: { toolCalls?: number } })?.usage?.toolCalls).toBe(2);
  });

  it('does not leak partial catalog products when a multi-query tool ultimately fails', async () => {
    const partial = product('partial-model', 'TSS SGG 6000E gasoline generator 6 kW');
    class PartialFailureProducts extends FakeProducts {
      calls = 0;
      async searchProducts() {
        this.calls += 1;
        if (this.calls % 2 === 0) throw new Error('second lookup failed');
        return [partial];
      }
    }
    const conversations = new FakeConversations();
    const products = new PartialFailureProducts();
    const catalogModel = model({
      async planTurn() {
        return {
          userMessageSummary: 'buyer asks to compare two exact products',
          dialogueUnderstanding: 'both detail lookups are required before comparison',
          nextStepRationale: 'report the failed evidence lookup honestly',
          requiresTools: true,
          toolRequests: [{
            id: 'details-fail',
            tool: 'catalog.getProductDetails',
            args: {
              productNames: ['TSS SGG 6000E', 'TSS SGG 7000E'],
              productIntent: 'generator',
              canonicalProductIntent: 'generator'
            },
            rationale: 'compare both exact products',
            required: true
          }],
          productMentions: [],
          selectionPolicy: {
            targetProductClass: 'generator',
            canonicalProductClass: 'generator',
            needAction: 'continue',
            alternativePolicy: 'exact_only',
            reusePreviousCards: false,
            maxCards: 2,
            powerSource: 'fuel',
            phase: 'any',
            requirements: [],
            rationale: 'do not show a partial comparison as complete'
          },
          policyRuleIds: [],
          mustNotAskQuestionIds: [],
          riskFlags: []
        };
      },
      async composeAnswer() {
        return {
          answerText: 'Не удалось надёжно получить обе карточки, поэтому сравнение пока не делаю.',
          factsUsed: [],
          questionsAsked: [],
          toolResultIds: [],
          selectedProductIds: [],
          leadAction: 'none',
          riskFlags: []
        };
      }
    });
    const orchestrator = new AgentManagerOrchestrator(
      conversations as never,
      products as never,
      new FakeLeads() as never,
      catalogModel
    );

    const payload = await orchestrator.generateAnswer({
      sessionId,
      turnId,
      userMessage: 'Сравните TSS SGG 6000E и TSS SGG 7000E.'
    });

    expect(products.calls).toBe(4);
    expect(payload.productCards).toEqual([]);
    const metadata = payload.metadata as {
      toolResults?: Array<{ status?: string; payload?: { products?: unknown[] } }>;
      answerProductEvidence?: { originalProductIds?: string[] };
    };
    expect(metadata.toolResults?.[0]?.status).toBe('error');
    expect(metadata.toolResults?.[0]?.payload?.products).toBeUndefined();
    expect(metadata.answerProductEvidence?.originalProductIds).toEqual([]);
    expect(conversations.toolArtifacts).toContainEqual(expect.objectContaining({
      toolRequestId: 'details-fail',
      status: 'error',
      warnings: expect.arrayContaining(['attempts:2'])
    }));
  });

  it('honors catalog.getProductDetails productIds without replacing them with a text search', async () => {
    const exact = product('catalog-id-1', 'TSS SGG 5000A generator');
    class IdProducts extends FakeProducts {
      idsSeen: string[] = [];
      searchCalls = 0;
      async getProductsByIds(ids: string[]) {
        this.idsSeen = ids;
        return ids.includes(exact.id) ? [exact] : [];
      }
      override async searchProducts(): Promise<Product[]> {
        this.searchCalls += 1;
        throw new Error('text search must not replace exact product ids');
      }
    }
    const products = new IdProducts();
    const intent = structuredGeneratorCatalogIntent();
    intent.requiresTools = true;
    intent.toolRequests = [{
      id: 'details-by-id',
      tool: 'catalog.getProductDetails',
      args: {
        productIds: [exact.id],
        productIntent: 'generator',
        canonicalProductIntent: 'generator'
      },
      rationale: 'rehydrate the exact validated catalog product',
      required: true
    }];
    intent.selectionPolicy = {
      ...intent.selectionPolicy!,
      selectionGoal: 'browse_catalog',
      alternativePolicy: 'same_class_only',
      maxCards: 1
    };
    const orchestrator = new AgentManagerOrchestrator(
      new FakeConversations() as never,
      products as never,
      new FakeLeads() as never,
      model({
        async planTurn() { return intent; },
        async composeAnswer(input) {
          expect(input.products.map((product) => product.id)).toEqual([exact.id]);
          return {
            answerText: 'TSS SGG 5000A generator остаётся доступной карточкой для сравнения.',
            factsUsed: [],
            questionsAsked: [],
            toolResultIds: ['details-by-id'],
            selectedProductIds: [exact.id],
            leadAction: 'none',
            riskFlags: [],
            selectionReadiness: {
              productClass: 'generator',
              status: 'ready_for_preliminary_cards',
              canShowProductCards: true,
              missingFacts: [],
              rationale: 'Exact catalog id was rehydrated.'
            }
          };
        }
      })
    );

    const payload = await orchestrator.generateAnswer({
      sessionId,
      turnId,
      userMessage: 'Покажите снова выбранный TSS SGG 5000A.'
    });

    expect(products.idsSeen).toEqual([exact.id]);
    expect(products.searchCalls).toBe(0);
    expect(payload.productCards.map((card) => card.id)).toEqual([exact.id]);
  });

  it('keeps current catalog details when a same-id historical visible card is lossy', async () => {
    const exact: Product = {
      ...product('generator-current-details', 'TSS SGG 5000A generator', 'Generators'),
      description: 'Current catalog description confirms electric start with a key.',
      specs: { 'Nominal power': '5 kW' }
    };
    const historicalCard: ProductCard = {
      id: exact.id,
      name: exact.name,
      brand: exact.brand,
      category: exact.category,
      price: exact.price,
      currency: exact.currency,
      sourceUrl: exact.sourceUrl,
      specs: exact.specs,
      reasons: ['previous visible recommendation'],
      caveats: []
    };
    const previousAssistant = message('Earlier I showed TSS SGG 5000A.', 'assistant');
    previousAssistant.metadata = { productCards: [historicalCard] };

    class HistoricalCardConversations extends FakeConversations {
      currentSession: ConversationSession = {
        ...session(),
        needState: {
          ...emptyNeedState(),
          activeNeeds: [{
            id: 'generator',
            productClass: 'generator',
            summary: 'selected generator',
            constraints: [],
            openQuestions: [],
            selectedProductIds: [exact.id],
            status: 'selected' as const,
            updatedAt: new Date('2026-05-19T12:00:00.000Z').toISOString()
          }]
        }
      };
      override messages = [
        message('Show me a generator.'),
        previousAssistant,
        message('Confirm the start method again.')
      ];
      override async getSession() { return this.currentSession; }
    }

    class CurrentDetailsProducts extends FakeProducts {
      async getProductsByIds(ids: string[]) {
        return ids.includes(exact.id) ? [exact] : [];
      }
      override async searchProducts(): Promise<Product[]> {
        throw new Error('the exact current catalog product must be rehydrated by id');
      }
    }

    const intent = structuredGeneratorCatalogIntent();
    intent.toolRequests = [{
      id: 'current-product-details',
      tool: 'catalog.getProductDetails',
      args: {
        productIds: [exact.id],
        productIntent: 'generator',
        canonicalProductIntent: 'generator',
        comparisonAttributes: ['start method']
      },
      rationale: 'rehydrate the current full catalog description for the prior card',
      required: true
    }];
    intent.selectionPolicy = undefined;
    intent.grounding = {
      taskType: 'comparison',
      sourcePolicy: 'catalog_required',
      webPurpose: 'none',
      requiredToolKinds: ['catalog.getProductDetails'],
      technicalAttributes: ['start method'],
      rationale: 'the current catalog description is the decisive source'
    };

    const orchestrator = new AgentManagerOrchestrator(
      new HistoricalCardConversations() as never,
      new CurrentDetailsProducts() as never,
      new FakeLeads() as never,
      model({
        async planTurn() { return intent; },
        async composeAnswer(input) {
          expect(input.products).toHaveLength(1);
          expect(input.products[0]?.description).toBe(exact.description);
          return {
            answerText: `${exact.name}: the current catalog description confirms electric start with a key.`,
            factsUsed: [{
              factKey: 'start_method',
              value: true,
              sourceEventIds: ['current-product-details']
            }],
            questionsAsked: [],
            toolResultIds: ['current-product-details'],
            selectedProductIds: [exact.id],
            leadAction: 'none',
            riskFlags: [],
            selectionReadiness: {
              productClass: 'generator',
              status: 'ready_for_preliminary_cards',
              canShowProductCards: true,
              missingFacts: [],
              rationale: 'the current catalog description confirms the requested feature'
            }
          };
        }
      })
    );

    const payload = await orchestrator.generateAnswer({
      sessionId,
      turnId,
      userMessage: 'Confirm the start method again.'
    });

    const metadata = payload.metadata as {
      toolResults?: Array<{ requestId?: string; payload?: { products?: Product[] } }>;
      cardSelection?: { warnings?: string[] };
    };
    expect(metadata.toolResults?.find((result) => result.requestId === 'current-product-details')
      ?.payload?.products?.[0]?.description).toBe(exact.description);
    expect(metadata.cardSelection?.warnings).toContain('product_cards_reused_from_previous_turn');
    expect(payload.productCards.map((card) => card.id)).toEqual([exact.id]);
  });

  it('keeps a catalog-confirmed paving-mat plate through strict follow-up selection', async () => {
    const withPavingMat: Product = {
      ...product('masalta-mat', 'Виброплита бензиновая Masalta MSR90-4 (83 кг)', 'Виброплиты'),
      brand: 'Masalta',
      price: 82_500,
      specs: {
        'рабочая масса, кг': '83',
        'коврик для мощения брусчатки': 'Да',
        'транспортировочные колеса для легкого перемещения виброплиты': 'Да'
      }
    };
    const withoutPavingMat: Product = {
      ...product('zitrek-no-mat', 'Виброплита прямоходная Zitrek z3k60 (57 кг)', 'Виброплиты'),
      brand: 'Zitrek',
      price: 38_000,
      specs: {
        'рабочая масса, кг': '57',
        'коврик для мощения брусчатки': 'Нет'
      }
    };
    class PlateDetailsProducts extends FakeProducts {
      idsSeen: string[] = [];

      async getProductsByIds(ids: string[]) {
        this.idsSeen = ids;
        return [withPavingMat, withoutPavingMat].filter((item) => ids.includes(item.id));
      }

      override async searchProducts(): Promise<Product[]> {
        throw new Error('follow-up must use the exact previously selected catalog IDs');
      }
    }

    const products = new PlateDetailsProducts();
    const intent = structuredGeneratorCatalogIntent();
    intent.userMessageSummary = 'buyer asks which prior plate is gentler on paving and asks to repeat the catalog price';
    intent.dialogueUnderstanding = 'the buyer narrows the previous plate candidates to a model with a confirmed paving mat';
    intent.nextStepRationale = 'rehydrate the exact previous catalog cards and choose only a proven protective-mat model';
    intent.toolRequests = [{
      id: 'plate-details',
      tool: 'catalog.getProductDetails',
      args: {
        productIds: [withPavingMat.id, withoutPavingMat.id],
        productIntent: 'виброплита',
        canonicalProductIntent: 'plate',
        comparisonAttributes: ['price', 'weight', 'protective mat for paving']
      },
      rationale: 'confirm current catalog facts for the previously shown plate cards',
      required: true,
      coversRequirementIds: ['paving-mat']
    }];
    intent.selectionPolicy = {
      targetProductClass: 'виброплита',
      canonicalProductClass: 'plate',
      selectionGoal: 'final_fit',
      needAction: 'resume',
      alternativePolicy: 'same_class_only',
      reusePreviousCards: true,
      maxCards: 1,
      powerSource: 'any',
      phase: 'any',
      requirements: [{
        id: 'paving-mat',
        kind: 'protective_mat_for_paving',
        value: true,
        unit: null,
        relation: 'must_have',
        role: 'hard_constraint',
        strictness: 'strict',
        evidence: 'the buyer asks for gentle work on paving and a confirmed protective mat',
        verification: { mode: 'product_attribute' }
      }],
      rationale: 'only a catalog-confirmed paving mat is sufficient for this final follow-up recommendation'
    };
    intent.grounding = {
      taskType: 'product_selection',
      sourcePolicy: 'catalog_required',
      webPurpose: 'none',
      requiredToolKinds: ['catalog.getProductDetails'],
      technicalAttributes: ['price', 'weight', 'protective mat for paving'],
      rationale: 'the current catalog detail cards are sufficient to compare this exact accessory fact'
    };

    const orchestrator = new AgentManagerOrchestrator(
      new FakeConversations() as never,
      products as never,
      new FakeLeads() as never,
      model({
        async planTurn() { return intent; },
        async composeAnswer(input) {
          expect(input.products.map((item) => item.id)).toEqual([withPavingMat.id]);
          return {
            answerText: `${withPavingMat.name} беру как конкретный вариант: коврик для мощения подтверждён в карточке, цена ${withPavingMat.price} ₽.`,
            factsUsed: [{
              factKey: 'protective_mat_for_paving',
              value: true,
              sourceEventIds: ['plate-details']
            }],
            questionsAsked: [],
            toolResultIds: ['plate-details'],
            selectedProductIds: [withPavingMat.id],
            leadAction: 'none',
            riskFlags: [],
            selectionReadiness: {
              productClass: 'plate',
              status: 'ready_for_exact_cards',
              canShowProductCards: true,
              missingFacts: [],
              rationale: 'The catalog detail card confirms the protective mat for the selected plate.'
            }
          };
        }
      })
    );

    const payload = await orchestrator.generateAnswer({
      sessionId,
      turnId,
      userMessage: 'Из показанных вариантов мне важна бережная работа по плитке. Какую конкретную модель взять? Повтори цену.'
    });

    expect(products.idsSeen).toEqual([withPavingMat.id, withoutPavingMat.id]);
    expect(payload.answer).toContain(withPavingMat.name);
    expect(payload.productCards.map((card) => card.id)).toEqual([withPavingMat.id]);
    expect((payload.metadata?.answerProductEvidence as { droppedProductIds?: string[] })?.droppedProductIds)
      .toContain(withoutPavingMat.id);
  });

  it('replaces factual text that cites a failed tool instead of only dropping its citation', async () => {
    class FailedCatalogProducts extends FakeProducts {
      async searchProducts(): Promise<Product[]> {
        throw new Error('catalog unavailable');
      }
    }
    const conversations = new FakeConversations();
    const unsafeModel = model({
      async planTurn() {
        return {
          userMessageSummary: 'buyer asks for a catalog model',
          dialogueUnderstanding: 'catalog lookup is required',
          nextStepRationale: 'search before answering',
          requiresTools: true,
          toolRequests: [{
            id: 'catalog-failed',
            tool: 'catalog.search',
            args: { query: 'generator 5 kW' },
            rationale: 'required lookup',
            required: true
          }],
          mustNotAskQuestionIds: [],
          riskFlags: []
        };
      },
      async composeAnswer() {
        return {
          answerText: 'Generator Fiction 5000 is in the catalog and costs 100000 RUB.',
          factsUsed: [{
            factKey: 'fiction_price',
            sourceEventIds: ['catalog-failed'],
            value: 100000
          }],
          questionsAsked: [],
          toolResultIds: ['catalog-failed'],
          selectedProductIds: [],
          leadAction: 'none',
          riskFlags: []
        };
      }
    });
    const orchestrator = new AgentManagerOrchestrator(
      conversations as never,
      new FailedCatalogProducts() as never,
      new FakeLeads() as never,
      unsafeModel
    );

    const payload = await orchestrator.generateAnswer({
      sessionId,
      turnId,
      userMessage: 'Р•СЃС‚СЊ РіРµРЅРµСЂР°С‚РѕСЂ 5 РєР’С‚?'
    });

    expect(payload.answer).not.toContain('Generator Fiction 5000');
    expect(payload.answer).toContain('не удалось надёжно');
    expect((payload.metadata?.answerContract as { factsUsed?: unknown[] }).factsUsed).toEqual([]);
  });

  it('keeps web-only technical research products out of visible cards', async () => {
    class ResearchProducts extends FakeProducts {
      async searchProducts() {
        return [product('bison-inverter', 'Generator BISON BS2500IS inverter THD 20%', 'Generators')];
      }
    }

    const conversations = new FakeConversations();
    const technicalModel = model({
      async planTurn() {
        return {
          turnId,
          userMessageSummary: 'buyer asks for a technical THD explanation',
          dialogueUnderstanding: 'this is a technical answer with fact checking, not a product selection request',
          nextStepRationale: 'use web/catalog facts to explain THD without showing product cards',
          requiresTools: true,
          toolRequests: [{
            id: 'web-facts',
            tool: 'web.researchProductFacts',
            args: {
              query: 'THD inverter generator boiler electronics',
              semanticQuery: 'technical THD explanation for inverter generator boiler electronics',
              productIntent: 'generator',
              limit: 4,
              productIds: [],
              productNames: [],
              comparisonAttributes: ['THD'],
              loads: [],
              simultaneousStarting: null,
              simultaneousStartingKinds: [],
              contact: { name: null, phone: null, email: null, preferredContact: null, comment: null },
              reason: 'verify missing THD facts',
              notes: 'technical explanation only'
            },
            rationale: 'the buyer asked to verify technical facts',
            required: true
          }],
          mustNotAskQuestionIds: [],
          riskFlags: []
        };
      },
      async composeAnswer() {
        return {
          answerText: 'THD is harmonic distortion; for a boiler and electronics a lower THD is safer. BISON BS2500IS has a catalog/web THD note, but this is a technical explanation rather than a selection.',
          factsUsed: [],
          questionsAsked: [],
          toolResultIds: ['web-facts'],
          leadAction: 'none',
          riskFlags: []
        };
      }
    });
    const orchestrator = new AgentManagerOrchestrator(conversations as never, new ResearchProducts() as never, new FakeLeads() as never, technicalModel);

    const payload = await orchestrator.generateAnswer({
      sessionId,
      turnId,
      userMessage: 'Explain why THD matters for an inverter generator with a boiler. Check facts if catalog data is missing.'
    });

    const metadata = payload.metadata as {
      toolResults?: Array<{
        tool?: string;
        status?: string;
        payload?: { usedWebSearch?: boolean; searchDisposition?: string; sourcesExhausted?: boolean };
      }>;
    };
    expect(metadata.toolResults?.[0]).toMatchObject({
      tool: 'web.researchProductFacts',
      status: 'error',
      payload: {
        usedWebSearch: false,
        searchDisposition: 'failed',
        sourcesExhausted: false
      }
    });
    expect(payload.productCards).toEqual([]);
  });

  it('filters cross-class catalog noise out of visible product cards', async () => {
    class NoisyProducts extends FakeProducts {
      async searchProducts() {
        return [
          product('generator-fit', 'Generator Dinking DK9000iE 7 kW', 'Generators'),
          product('plate-noise', 'Vibroplita Wacker 90 kg', 'Vibroplita'),
          product('cutter-noise', 'Cutter Husqvarna 350 mm', 'Cutters')
        ];
      }
    }

    const conversations = new FakeConversations();
    const catalogModel = model({
      async planTurn() {
        return {
          turnId,
          userMessageSummary: 'buyer asks for generator options for a coffee point',
          dialogueUnderstanding: 'the buyer needs a generator, not compaction or cutting equipment',
          nextStepRationale: 'search catalog and answer with suitable generator options',
          requiresTools: true,
          toolRequests: [{
            id: 'catalog-search',
            tool: 'catalog.search',
            args: {
              query: 'generator for coffee point 6 kW reserve',
              limit: 8,
              productIds: [],
              productNames: [],
              comparisonAttributes: [],
              loads: [],
              simultaneousStarting: null,
              simultaneousStartingKinds: [],
              contact: { name: null, phone: null, email: null, preferredContact: null, comment: null },
              reason: null,
              notes: null
            },
            rationale: 'buyer asked for generator options from the catalog',
            required: true
          }],
          mustNotAskQuestionIds: [],
          riskFlags: []
        };
      },
      async composeAnswer() {
        return {
          answerText: 'From the found catalog options, Generator Dinking DK9000iE is the relevant reserve option for the coffee point.',
          factsUsed: [],
          questionsAsked: [],
          toolResultIds: ['catalog-search'],
          leadAction: 'none',
          riskFlags: []
        };
      }
    });
    const orchestrator = new AgentManagerOrchestrator(conversations as never, new NoisyProducts() as never, new FakeLeads() as never, catalogModel);

    const payload = await orchestrator.generateAnswer({
      sessionId,
      turnId,
      userMessage: 'Show generator options for coffee point.'
    });

    expect(payload.productCards.map((card) => card.id)).toEqual(['generator-fit']);
    expect(payload.productCards.map((card) => card.id)).not.toContain('plate-noise');
    expect(payload.productCards.map((card) => card.id)).not.toContain('cutter-noise');
    const metadata = payload.metadata as { toolResults?: Array<{ payload?: { productIds?: string[] }; warnings?: string[] }>; cardSelection?: { droppedProductIds?: string[] } };
    expect(metadata.toolResults?.[0]?.payload?.productIds).toEqual(['generator-fit']);
    expect(metadata.toolResults?.[0]?.warnings?.join('\n')).toContain('catalog_products_filtered_by_intent:generator:2');
    expect(metadata.cardSelection?.droppedProductIds).toEqual([]);
  });

  it('scopes embedding retrieval and visible cards to the LLM product intent when the dialogue switches product class', async () => {
    const plate = product('plate-90', 'Vibroplita TSS VP90 90 kg', 'Vibroplita');
    const generator = product('generator-stale', 'Generator previous match 5 kW', 'Generators');
    const embeddingQueries: string[] = [];
    class IntentScopedProducts extends FakeProducts {
      vectorCalls = 0;

      async searchProducts() {
        return [plate];
      }

      async getEmbeddingCoverage() {
        return { target: 'products', total: 10, embedded: 10, usable: 10, coverage: 1 };
      }

      async vectorSearch() {
        this.vectorCalls += 1;
        return [generator];
      }
    }

    const conversations = new FakeConversations();
    conversations.messages.push(message('Earlier we discussed generator cards.', 'assistant'));
    const products = new IntentScopedProducts();
    const catalogModel = model({
      async planTurn() {
        return {
          turnId,
          userMessageSummary: 'buyer switches from generator to plate compactor weight/catalog need',
          dialogueUnderstanding: 'current focus is a plate compactor for a small driveway, not the prior generator',
          nextStepRationale: 'search catalog only for plate compactors',
          requiresTools: true,
          toolRequests: [{
            id: 'catalog-search',
            tool: 'catalog.search',
            args: {
              query: 'vibroplita 80-100 kg for paving slabs',
              semanticQuery: 'plate compactor small driveway paving slabs sand crushed stone self loading 80-100 kg',
              productIntent: 'plate',
              limit: 8,
              productIds: [],
              productNames: [],
              comparisonAttributes: [],
              loads: [],
              simultaneousStarting: null,
              simultaneousStartingKinds: [],
              contact: { name: null, phone: null, email: null, preferredContact: null, comment: null },
              reason: 'current buyer focus switched to plate compactor',
              notes: 'do not reuse generator constraints'
            },
            rationale: 'buyer asked about plate compactor after prior generator discussion',
            required: true
          }],
          mustNotAskQuestionIds: [],
          riskFlags: []
        };
      },
      async composeAnswer() {
        return {
          answerText: 'For the small driveway, Vibroplita TSS VP90 90 kg is the matching catalog direction.',
          factsUsed: [],
          questionsAsked: [],
          toolResultIds: ['catalog-search'],
          leadAction: 'none',
          riskFlags: []
        };
      }
    });
    const orchestrator = new AgentManagerOrchestrator(
      conversations as never,
      products as never,
      new FakeLeads() as never,
      catalogModel,
      async (text) => {
        embeddingQueries.push(text);
        return [0.1, 0.2, 0.3];
      }
    );

    const payload = await orchestrator.generateAnswer({
      sessionId,
      turnId,
      userMessage: 'Еще нужна виброплита для въезда под плитку. Какой вес смотреть?'
    });

    expect(products.vectorCalls).toBe(1);
    expect(embeddingQueries).toEqual(['plate compactor small driveway paving slabs sand crushed stone self loading 80-100 kg']);
    expect(payload.productCards.map((card) => card.id)).toEqual(['plate-90']);
    expect(payload.productCards.map((card) => card.id)).not.toContain('generator-stale');
    const metadata = payload.metadata as {
      toolResults?: Array<{ payload?: { productIds?: string[]; retrieval?: { intent?: string; embeddingQuery?: string } }; warnings?: string[] }>;
      cardSelection?: { intent?: string };
    };
    expect(metadata.toolResults?.[0]?.payload?.productIds).toEqual(['plate-90']);
    expect(metadata.toolResults?.[0]?.payload?.retrieval).toMatchObject({
      intent: 'plate',
      embeddingQuery: 'plate compactor small driveway paving slabs sand crushed stone self loading 80-100 kg'
    });
    expect(metadata.toolResults?.[0]?.warnings?.join('\n')).toContain('catalog_products_filtered_by_intent:plate:1');
    expect(metadata.cardSelection?.intent).toBe('plate');
  });

  it('keeps self-loading plate constraints in semantic catalog ranking', async () => {
    class PlateProducts extends FakeProducts {
      async searchProducts() {
        return [
          { ...product('plate-100', 'Vibroplita Wacker VP100 100 kg', 'Vibroplita'), specs: { weight: '100 kg' } },
          { ...product('plate-55', 'Vibroplita TSS VP55 55 kg', 'Vibroplita'), specs: { weight: '55 kg' } },
          { ...product('plate-72', 'Vibroplita Champion PC72 72 kg', 'Vibroplita'), specs: { weight: '72 kg' } }
        ];
      }
    }

    const conversations = new FakeConversations();
    const catalogModel = model({
      async planTurn() {
        return {
          turnId,
          userMessageSummary: 'buyer needs a plate compactor for a small paving driveway and will load it alone',
          dialogueUnderstanding: 'the current product class is a plate compactor and transport weight matters',
          nextStepRationale: 'search plate compactors using the transport constraint',
          requiresTools: true,
          toolRequests: [{
            id: 'catalog-search',
            tool: 'catalog.search',
            args: {
              query: 'vibroplita 80-100 kg for paving slabs',
              semanticQuery: 'plate compactor small driveway paving slabs sand crushed stone self loading',
              productIntent: 'plate',
              limit: 3,
              productIds: [],
              productNames: [],
              comparisonAttributes: [],
              loads: [],
              simultaneousStarting: null,
              simultaneousStartingKinds: [],
              contact: { name: null, phone: null, email: null, preferredContact: null, comment: null },
              reason: 'buyer will load the machine alone',
              notes: null
            },
            rationale: 'buyer asked what plate weight to choose for a small driveway',
            required: true
          }],
          mustNotAskQuestionIds: [],
          riskFlags: []
        };
      },
      async composeAnswer() {
        return {
          answerText: 'For self-loading, start with the lighter 55-72 kg plate compactors before 100 kg machines.',
          factsUsed: [],
          questionsAsked: [],
          toolResultIds: ['catalog-search'],
          leadAction: 'none',
          riskFlags: []
        };
      }
    });
    const orchestrator = new AgentManagerOrchestrator(conversations as never, new PlateProducts() as never, new FakeLeads() as never, catalogModel);

    const payload = await orchestrator.generateAnswer({
      sessionId,
      turnId,
      userMessage: 'Need a plate compactor for a small paving driveway over sand and crushed stone. I will load it myself. What weight should I choose?'
    });

    const metadata = payload.metadata as { toolResults?: Array<{ payload?: { productIds?: string[] } }> };
    expect(metadata.toolResults?.[0]?.payload?.productIds?.slice(0, 2)).toEqual(['plate-55', 'plate-72']);
    expect(payload.productCards.map((card) => card.id).slice(0, 2)).toEqual(['plate-55', 'plate-72']);
  });

  it('uses structured AgentManager generator calculator loads without turning nulls into zero', async () => {
    const conversations = new FakeConversations();
    const calcModel = model({
      async planTurn() {
        return {
          turnId,
          userMessageSummary: 'buyer gave pump power and household generator loads',
          dialogueUnderstanding: 'generator sizing should use pump, fridge, boiler and light with pump/fridge simultaneous start',
          nextStepRationale: 'calculate the generator load profile',
          requiresTools: true,
          toolRequests: [{
            id: 'generator-load',
            tool: 'calculator.generatorLoad',
            args: {
              query: null,
              semanticQuery: null,
              productIntent: 'generator',
              limit: null,
              productIds: [],
              productNames: [],
              comparisonAttributes: [],
              loads: [
                { kind: 'unknown', name: '\u043d\u0430\u0441\u043e\u0441', count: 1, runningKw: 1.1, startingKw: null, source: 'explicit_user', evidence: 'pump nameplate 1.1 kW' },
                { kind: 'refrigerator', name: 'household refrigerator', count: 1, runningKw: 0.25, startingKw: 1.2, source: 'estimated_average', evidence: 'ordinary household refrigerator' },
                { kind: 'boiler', name: 'gas boiler controls', count: 1, runningKw: 0.15, startingKw: 0.15, source: 'estimated_average', evidence: 'small gas boiler controls' },
                { kind: 'lighting', name: 'small light', count: 1, runningKw: 0.2, startingKw: 0.2, source: 'estimated_average', evidence: 'small lighting' },
                { kind: 'unknown_load', name: 'not enough data', count: 1, runningKw: null, startingKw: null, source: 'estimated_average', evidence: 'null values must not become zero or fallback loads' }
              ],
              simultaneousStarting: true,
              simultaneousStartingKinds: ['pump', 'refrigerator'],
              contact: { name: null, phone: null, email: null, preferredContact: null, comment: null },
              reason: 'calculate from declared loads',
              notes: null
            },
            rationale: 'buyer asks what generator power is needed',
            required: true
          }],
          mustNotAskQuestionIds: [],
          riskFlags: []
        };
      },
      async composeAnswer(input) {
        const profile = (input.toolResults[0]?.payload as { profile?: { requiredNominalKw?: number } })?.profile;
        return {
          answerText: `Calculated minimum is ${profile?.requiredNominalKw} kW nominal.`,
          factsUsed: [],
          questionsAsked: [],
          toolResultIds: ['generator-load'],
          leadAction: 'none',
          riskFlags: []
        };
      }
    });
    const orchestrator = new AgentManagerOrchestrator(conversations as never, new FakeProducts() as never, new FakeLeads() as never, calcModel);

    const payload = await orchestrator.generateAnswer({
      sessionId,
      turnId,
      userMessage: 'Pump is 1.1 kW, ordinary refrigerator, gas boiler and small lights. Pump and refrigerator may start together.'
    });

    const metadata = payload.metadata as { toolResults?: Array<{ payload?: { loads?: Array<{ kind?: string; runningKw?: number }>; profile?: { requiredNominalKw?: number; requiredStartingKw?: number } }; warnings?: string[] }> };
    expect(metadata.toolResults?.[0]?.payload?.loads?.map((item) => [item.kind, item.runningKw])).toEqual([
      ['pump', 1.1],
      ['refrigerator', 0.25],
      ['boiler', 0.15],
      ['lighting', 0.2]
    ]);
    expect(metadata.toolResults?.[0]?.payload?.profile?.requiredStartingKw).toBeCloseTo(4.5, 5);
    expect(metadata.toolResults?.[0]?.payload?.profile?.requiredNominalKw).toBe(4.5);
    expect(metadata.toolResults?.[0]?.payload?.loads?.map((item) => item.kind)).not.toContain('unknown_load');
    expect(metadata.toolResults?.[0]?.warnings?.join('\n') ?? '').not.toContain('generator_load_estimate_used:refrigerator');
  });

  it('suppresses generator cards while pump/load profile is not ready', async () => {
    const conversations = new FakeConversations();
    const readinessModel = model({
      async proposeLedgerDelta() {
        return {
          rationale: 'buyer needs a generator but power is uncertain',
          events: [{
            eventType: 'fact.confirmed',
            scope: 'dialogue',
            payload: { factKey: 'product_category', value: 'generator' },
            evidence: 'buyer asked for a generator',
            source: 'llm_state_delta',
            status: 'active'
          }, {
            eventType: 'fact.confirmed',
            scope: 'dialogue',
            payload: { factKey: 'power_uncertainty', value: true },
            evidence: 'buyer has no exact pump/load numbers',
            source: 'llm_state_delta',
            status: 'active'
          }]
        };
      },
      async planTurn() {
        return {
          turnId,
          userMessageSummary: 'buyer asks for a dacha backup generator but does not know pump power',
          dialogueUnderstanding: 'generator category is clear, but pump/startup load is not ready for product selection',
          nextStepRationale: 'catalog search was planned even though power is uncertain',
          requiresTools: true,
          toolRequests: [{
            id: 'catalog-search',
            tool: 'catalog.search',
            args: {
              query: 'dacha backup generator',
              semanticQuery: 'generator for dacha with refrigerator, pump, light and occasional tool, exact pump power unknown',
              productIntent: 'generator',
              limit: 4,
              productIds: [],
              productNames: [],
              comparisonAttributes: [],
              loads: [],
              simultaneousStarting: null,
              simultaneousStartingKinds: [],
              contact: { name: null, phone: null, email: null, preferredContact: null, comment: null },
              reason: 'find generator products',
              notes: null
            },
            rationale: 'buyer wants generator options',
            required: true
          }],
          mustNotAskQuestionIds: [],
          riskFlags: ['power_requirements_uncertain']
        };
      },
      async composeAnswer() {
        return {
          answerText: 'I cannot honestly show generator cards yet: the pump type/model or nameplate power is missing, and startup load matters for sizing.',
          factsUsed: [],
          questionsAsked: [{
            questionId: 'q.generator.pump_identity_or_power',
            text: 'What pump type/model or nameplate power can you provide?',
            reason: 'Generator cards depend on pump startup load.'
          }],
          toolResultIds: ['catalog-search'],
          leadAction: 'none',
          riskFlags: ['power_requirements_uncertain'],
          selectionReadiness: {
            productClass: 'generator',
            status: 'needs_more_info',
            canShowProductCards: false,
            missingFacts: ['pump_type_or_power', 'starting_loads_or_load_profile'],
            rationale: 'The current dialogue does not have enough load facts for product cards.'
          }
        };
      }
    });
    const orchestrator = new AgentManagerOrchestrator(conversations as never, new FakeProducts() as never, new FakeLeads() as never, readinessModel);

    const payload = await orchestrator.generateAnswer({
      sessionId,
      turnId,
      userMessage: 'Нужен генератор для дачи. Точных цифр нет: холодильник, насос, свет и иногда инструмент.'
    });

    const metadata = payload.metadata as {
      selectionReadiness?: { status?: string; missingFacts?: string[] };
      cardSelection?: { selectedProductIds?: string[]; suppressedProductIds?: string[]; warnings?: string[] };
      warnings?: string[];
      answerContract?: { riskFlags?: string[] };
    };
    expect(payload.productCards).toEqual([]);
    expect(payload.answer).toContain('pump type/model');
    expect(payload.answer).not.toContain('Generator 5 kW');
    expect(payload.answer).not.toContain('Generator 6 kW');
    expect(metadata.selectionReadiness?.status).toBe('blocked_by_answer_contract');
    expect(metadata.selectionReadiness?.missingFacts).toEqual(expect.arrayContaining(['pump_type_or_power']));
    expect(metadata.cardSelection?.selectedProductIds).toEqual([]);
    expect(metadata.cardSelection?.suppressedProductIds).toEqual(['p1', 'p2']);
    expect(metadata.cardSelection?.warnings).toContain('product_cards_suppressed:selection_readiness_contract');
    expect(metadata.answerContract?.riskFlags).toContain('selection_readiness_blocked_cards');
  });

  it('does not invent generic pump loads and lets the answer contract block premature cards', async () => {
    const conversations = new FakeConversations();
    const unknownPumpModel = model({
      async planTurn() {
        return {
          turnId,
          userMessageSummary: 'buyer has 220 V house, generic unknown pump, fridge, LED light and 1.2 kW grinder',
          dialogueUnderstanding: 'calculate a conservative estimate but pump type/model/power is still missing',
          nextStepRationale: 'calculator.generatorLoad can calculate only the structured loads, then answer must ask for pump details',
          requiresTools: true,
          toolRequests: [{
            id: 'generator-load',
            tool: 'calculator.generatorLoad',
            args: {
              query: null,
              semanticQuery: null,
              productIntent: 'generator',
              limit: null,
              productIds: [],
              productNames: [],
              comparisonAttributes: [],
              loads: [
                { kind: 'power_tool', name: 'angle grinder', count: 1, runningKw: 1.2, startingKw: 1.2, source: 'explicit_user', evidence: 'grinder 1.2 kW' }
              ],
              simultaneousStarting: true,
              simultaneousStartingKinds: ['pump', 'refrigerator'],
              contact: { name: null, phone: null, email: null, preferredContact: null, comment: null },
              reason: 'estimate generator load',
              notes: null
            },
            rationale: 'estimate generator load while pump is unknown',
            required: true
          }],
          mustNotAskQuestionIds: [],
          riskFlags: ['unknown_pump_power', 'simultaneous_start_possible']
        };
      },
      async composeAnswer() {
        return {
          answerText: 'I can only calculate the structured 1.2 kW grinder load now; I still need pump type/model or nameplate power before showing generator cards.',
          factsUsed: [],
          questionsAsked: [{
            questionId: 'q.generator.pump_identity_or_power',
            text: 'What pump type/model or nameplate power can you provide?',
            reason: 'The pump cannot be added to the calculation without a structured load basis.'
          }],
          toolResultIds: ['generator-load'],
          leadAction: 'none',
          riskFlags: ['unknown_pump_power'],
          selectionReadiness: {
            productClass: 'generator',
            status: 'needs_more_info',
            canShowProductCards: false,
            missingFacts: ['pump_type_or_power'],
            rationale: 'The pump is mentioned but not represented as a usable structured load, so cards are not useful yet.'
          }
        };
      }
    });
    const orchestrator = new AgentManagerOrchestrator(conversations as never, new FakeProducts() as never, new FakeLeads() as never, unknownPumpModel);

    const payload = await orchestrator.generateAnswer({
      sessionId,
      turnId,
      userMessage: 'Дом 220 В. Насос не знаю какой, модель сейчас не скажу. Холодильник один, свет LED, иногда болгарка 1,2 кВт. Насос с холодильником могут включиться вместе.'
    });

    const metadata = payload.metadata as {
      toolResults?: Array<{ payload?: { loads?: Array<{ kind?: string }> }; warnings?: string[] }>;
      selectionReadiness?: { status?: string };
      answerContract?: { riskFlags?: string[] };
    };
    expect(metadata.toolResults?.[0]?.payload?.loads?.map((item) => item.kind)).not.toContain('pump');
    expect(metadata.toolResults?.[0]?.warnings).not.toContain('generator_load_estimate_used:pump');
    expect(metadata.selectionReadiness?.status).toBe('blocked_by_answer_contract');
    expect(payload.answer).toContain('pump type/model');
    expect(metadata.answerContract?.riskFlags).toContain('selection_readiness_blocked_cards');
  });

  it('blocks catalog cards when a generic pump is omitted from calculation because kW is unknown', async () => {
    const conversations = new FakeConversations();
    const genericPumpWithSearchModel = model({
      async planTurn() {
        return {
          turnId,
          userMessageSummary: 'buyer has 220 V house, fridge, LED light, 1.2 kW grinder and unknown pump',
          dialogueUnderstanding: 'the pump may start with the refrigerator but pump type and power are unknown',
          nextStepRationale: 'the model tries to calculate the known tool and search products anyway',
          requiresTools: true,
          toolRequests: [{
            id: 'generator-load',
            tool: 'calculator.generatorLoad',
            args: {
              query: null,
              semanticQuery: null,
              productIntent: 'generator',
              limit: null,
              productIds: [],
              productNames: [],
              comparisonAttributes: [],
              loads: [
                { kind: 'fridge', name: 'one refrigerator', count: 1, runningKw: null, startingKw: null, source: 'explicit_user', evidence: 'fridge named but no power', basisKind: 'specific_type_or_function', basisSignals: ['consumer_type_known', 'usage_scope_known'] },
                { kind: 'lighting', name: 'LED lighting', count: 1, runningKw: null, startingKw: null, source: 'explicit_user', evidence: 'LED lighting named but no count', basisKind: 'specific_type_or_function', basisSignals: ['consumer_type_known'] },
                { kind: 'tool', name: 'angle grinder', count: 1, runningKw: 1.2, startingKw: null, source: 'explicit_user', evidence: '1.2 kW grinder', basisKind: 'exact_power', basisSignals: ['explicit_power', 'usage_scope_known'] },
                { kind: 'pump', name: 'unknown household pump', count: 1, runningKw: null, startingKw: null, source: 'explicit_user', evidence: 'pump exists but type/model/power is unknown', basisKind: 'generic_load_name', basisSignals: ['consumer_type_known', 'simultaneous_operation_known'] }
              ],
              simultaneousStarting: true,
              simultaneousStartingKinds: ['pump', 'refrigerator'],
              estimateBasis: 'bounded_assumption',
              contact: { name: null, phone: null, email: null, preferredContact: null, comment: null },
              reason: 'calculate known loads and unknown pump context',
              notes: 'Pump is generic and must not be turned into cards.'
            },
            rationale: 'attempt partial generator load',
            required: true
          }, {
            id: 'catalog-search',
            tool: 'catalog.search',
            args: {
              query: 'generator 2-3 kW',
              semanticQuery: 'preliminary generator for fridge LED grinder and unknown pump',
              productIntent: 'generator',
              limit: 4,
              productIds: [],
              productNames: [],
              comparisonAttributes: [],
              loads: [],
              simultaneousStarting: null,
              simultaneousStartingKinds: [],
              estimateBasis: null,
              contact: { name: null, phone: null, email: null, preferredContact: null, comment: null },
              reason: 'find preliminary generators',
              notes: null
            },
            rationale: 'try products too early',
            required: true
          }],
          mustNotAskQuestionIds: [],
          riskFlags: ['unknown_pump_power']
        };
      },
      async composeAnswer(input) {
        expect(input.requiredResponseClauses?.map((clause) => clause.code)).toContain('generator_unconfirmed_load_stage_aware_selection');
        expect(input.requiredResponseClauses?.[0]?.sourceRequestId).toBe('generator-load');
        expect(input.requiredResponseClauses?.[0]?.instruction).toContain('rough or partial orientation');
        expect(input.requiredResponseClauses?.[0]?.instruction).toContain('Product cards and prices may still be shown');
        return {
          answerText: 'I should not show generator cards yet because the pump type/model or power is missing.',
          factsUsed: [],
          questionsAsked: [{
            questionId: 'q.generator.pump_identity_or_power',
            text: 'What pump type/model or nameplate power can you provide?',
            reason: 'Pump startup load controls generator selection.'
          }],
          toolResultIds: ['generator-load', 'catalog-search'],
          leadAction: 'none',
          riskFlags: ['unknown_pump_power'],
          selectionReadiness: {
            productClass: 'generator',
            status: 'ready_for_preliminary_cards',
            canShowProductCards: true,
            missingFacts: ['pump_type_or_power'],
            rationale: 'The model incorrectly thinks the partial calculation is enough for cards.'
          }
        };
      },
      async reviewAnswer(input) {
        expect(input.requiredResponseClauses?.map((clause) => clause.code)).toContain('generator_unconfirmed_load_no_numeric_selection');
        return { verdict: 'pass', issues: [] };
      }
    });
    const orchestrator = new AgentManagerOrchestrator(conversations as never, new FakeProducts() as never, new FakeLeads() as never, genericPumpWithSearchModel);

    const payload = await orchestrator.generateAnswer({
      sessionId,
      turnId,
      userMessage: 'House is 220 V. Pump unknown, fridge, LED lights, sometimes 1.2 kW grinder. Pump and fridge can start together.'
    });

    const metadata = payload.metadata as {
      toolResults?: Array<{ status?: string; warnings?: string[]; payload?: { loads?: Array<{ kind?: string }> } }>;
      selectionReadiness?: { status?: string };
      cardSelection?: { selectedProductIds?: string[]; warnings?: string[] };
    };
    expect(metadata.toolResults?.[0]?.payload?.loads?.map((item) => item.kind)).not.toContain('pump');
    expect(metadata.toolResults?.[0]?.warnings).toEqual(expect.arrayContaining([
      'generator_load_bounded_basis_incomplete',
      'generator_load_unbounded_guess'
    ]));
    expect(metadata.toolResults?.[1]?.status).toBe('ok');
    expect(metadata.selectionReadiness?.status).toBe('blocked_by_tool_safety');
    expect(metadata.cardSelection?.selectedProductIds).toEqual([]);
    expect(metadata.cardSelection?.warnings).toContain('product_cards_suppressed:generator_load_unconfirmed_basis');
    expect(payload.productCards).toEqual([]);
  });

  it('drops product-class generator pseudo-loads and suppresses premature cards', async () => {
    const conversations = new FakeConversations();
    const estimateOnlyModel = model({
      async planTurn() {
        return {
          turnId,
          userMessageSummary: 'buyer wants a generator but exact pump and tool loads are unknown',
          dialogueUnderstanding: 'the buyer has only vague household loads, so product cards are premature',
          nextStepRationale: 'the calculator request incorrectly uses product-class load kinds and estimates missing values',
          requiresTools: true,
          toolRequests: [{
            id: 'generator-load',
            tool: 'calculator.generatorLoad',
            args: {
              query: null,
              semanticQuery: null,
              productIntent: 'generator',
              limit: null,
              productIds: [],
              productNames: [],
              comparisonAttributes: [],
              loads: [
                { kind: 'generator', name: 'refrigerator', count: 1, runningKw: 0.15, startingKw: 0.9, source: 'estimated_average', evidence: 'typical refrigerator estimate' },
                { kind: 'generator', name: 'pump', count: 1, runningKw: 0.75, startingKw: 2.2, source: 'estimated_average', evidence: 'generic pump estimate' },
                { kind: 'generator', name: 'lighting', count: 1, runningKw: 0.12, startingKw: 0.12, source: 'estimated_average', evidence: 'small lighting estimate' },
                { kind: 'generator', name: 'handheld tool', count: 1, runningKw: 1.2, startingKw: 2.4, source: 'estimated_average', evidence: 'generic tool estimate' }
              ],
              simultaneousStarting: false,
              simultaneousStartingKinds: [],
              contact: { name: null, phone: null, email: null, preferredContact: null, comment: null },
              reason: 'estimate generator load',
              notes: null
            },
            rationale: 'estimate generator load from vague request',
            required: true
          }, {
            id: 'catalog-search',
            tool: 'catalog.search',
            args: {
              query: 'generator for dacha',
              semanticQuery: 'generator for dacha with refrigerator, pump, light and occasional tool, exact numbers unknown',
              productIntent: 'generator',
              limit: 4,
              productIds: [],
              productNames: [],
              comparisonAttributes: [],
              loads: [],
              simultaneousStarting: null,
              simultaneousStartingKinds: [],
              contact: { name: null, phone: null, email: null, preferredContact: null, comment: null },
              reason: 'find generator products',
              notes: null
            },
            rationale: 'find generator products',
            required: true
          }],
          mustNotAskQuestionIds: [],
          riskFlags: ['load_estimation_required']
        };
      },
      async composeAnswer() {
        return {
          answerText: 'I would show generator cards from the catalog.',
          factsUsed: [],
          questionsAsked: [],
          toolResultIds: ['generator-load', 'catalog-search'],
          leadAction: 'none',
          riskFlags: ['load_estimation_required'],
          selectionReadiness: {
            productClass: 'generator',
            status: 'ready_for_preliminary_cards',
            canShowProductCards: true,
            missingFacts: [],
            rationale: 'The model incorrectly thinks an estimated profile is enough.'
          }
        };
      }
    });
    const orchestrator = new AgentManagerOrchestrator(conversations as never, new FakeProducts() as never, new FakeLeads() as never, estimateOnlyModel);

    const payload = await orchestrator.generateAnswer({
      sessionId,
      turnId,
      userMessage: 'Need a dacha generator. I do not know exact numbers: refrigerator, pump, light and sometimes a tool.'
    });

    const metadata = payload.metadata as {
      toolResults?: Array<{ status?: string; payload?: { loads?: Array<unknown> }; warnings?: string[] }>;
      selectionReadiness?: { status?: string; warnings?: string[] };
      cardSelection?: { selectedProductIds?: string[]; suppressedProductIds?: string[]; warnings?: string[] };
      answerContract?: { riskFlags?: string[] };
    };
    expect(metadata.toolResults?.[0]?.payload?.loads).toEqual([]);
    expect(metadata.toolResults?.[0]?.warnings).toEqual(expect.arrayContaining([
      'generator_load_invalid_load_kind',
      'generator_load_structured_args_without_usable_kw'
    ]));
    expect(metadata.toolResults?.[1]?.status).toBe('ok');
    expect(payload.productCards).toEqual([]);
    expect(metadata.selectionReadiness?.status).toBe('blocked_by_tool_safety');
    expect(metadata.cardSelection?.selectedProductIds).toEqual([]);
    expect(metadata.cardSelection?.warnings).toEqual(expect.arrayContaining([
      'product_cards_suppressed:generator_load_unconfirmed_basis'
    ]));
    expect(metadata.answerContract?.riskFlags).toContain('selection_readiness_blocked_cards');
  });

  it('rejects bounded assumptions when estimated motor loads lack minimum basis signals', async () => {
    const conversations = new FakeConversations();
    const incompleteBasisModel = model({
      async planTurn() {
        return {
          turnId,
          userMessageSummary: 'buyer has vague dacha loads and no pump type or voltage',
          dialogueUnderstanding: 'the model tries to estimate from generic load names, but the pump is not bounded enough',
          nextStepRationale: 'catalog search should be denied because the estimate basis is incomplete',
          requiresTools: true,
          toolRequests: [{
            id: 'generator-load',
            tool: 'calculator.generatorLoad',
            args: {
              query: null,
              semanticQuery: null,
              productIntent: 'generator',
              limit: null,
              productIds: [],
              productNames: [],
              comparisonAttributes: [],
              loads: [
                { kind: 'pump', name: 'generic water pump', count: 1, runningKw: 0.75, startingKw: 2, source: 'estimated_average', evidence: 'typical small dacha pump', basisKind: 'generic_load_name', basisSignals: ['consumer_type_known', 'voltage_or_phase_known', 'buyer_requested_approximation'] },
                { kind: 'refrigerator', name: 'fridge', count: 1, runningKw: 0.15, startingKw: 0.9, source: 'estimated_average', evidence: 'typical household refrigerator', basisKind: 'specific_type_or_function', basisSignals: ['consumer_type_known'] },
                { kind: 'lighting', name: 'lights', count: 1, runningKw: 0.1, startingKw: 0.1, source: 'estimated_average', evidence: 'basic LED lighting', basisKind: 'specific_type_or_function', basisSignals: ['consumer_type_known'] }
              ],
              simultaneousStarting: true,
              simultaneousStartingKinds: ['pump', 'refrigerator'],
              estimateBasis: 'bounded_assumption',
              contact: { name: null, phone: null, email: null, preferredContact: null, comment: null },
              reason: 'estimate generator load',
              notes: 'Pump exact details are absent.'
            },
            rationale: 'attempt bounded estimate',
            required: true
          }, {
            id: 'catalog-search',
            tool: 'catalog.search',
            args: {
              query: 'generator 3-5 kW',
              semanticQuery: 'generator for dacha generic pump fridge light',
              productIntent: 'generator',
              limit: 4,
              productIds: [],
              productNames: [],
              comparisonAttributes: [],
              loads: [],
              simultaneousStarting: null,
              simultaneousStartingKinds: [],
              estimateBasis: null,
              contact: { name: null, phone: null, email: null, preferredContact: null, comment: null },
              reason: 'find generator products',
              notes: null
            },
            rationale: 'find products',
            required: true
          }],
          mustNotAskQuestionIds: [],
          riskFlags: ['load_estimation_required']
        };
      },
      async composeAnswer() {
        return {
          answerText: 'I should ask what the pump does, its type and whether it is 220 V or 380 V before showing generator cards.',
          factsUsed: [],
          questionsAsked: [{
            questionId: 'q.generator.bound_unknown_pump',
            text: 'What does the pump do and is it 220 V or 380 V?',
            reason: 'A motor load estimate needs type/function and voltage before preliminary cards.'
          }],
          toolResultIds: ['generator-load', 'catalog-search'],
          leadAction: 'none',
          riskFlags: ['load_estimation_required'],
          selectionReadiness: {
            productClass: 'generator',
            status: 'needs_more_info',
            canShowProductCards: false,
            missingFacts: ['pump_function_or_type', 'pump_voltage_or_phase'],
            rationale: 'The pump estimate basis is incomplete.'
          }
        };
      }
    });
    const orchestrator = new AgentManagerOrchestrator(conversations as never, new FakeProducts() as never, new FakeLeads() as never, incompleteBasisModel);

    const payload = await orchestrator.generateAnswer({
      sessionId,
      turnId,
      userMessage: 'Need a dacha generator. Exact numbers unknown: refrigerator, pump, lights.'
    });

    const metadata = payload.metadata as {
      toolResults?: Array<{ status?: string; warnings?: string[] }>;
      selectionReadiness?: { status?: string; warnings?: string[] };
      cardSelection?: { selectedProductIds?: string[]; warnings?: string[] };
    };
    expect(metadata.toolResults?.[0]?.warnings).toEqual(expect.arrayContaining([
      'generator_load_bounded_basis_incomplete',
      'generator_load_unbounded_guess'
    ]));
    expect(metadata.toolResults?.[1]?.status).toBe('ok');
    expect(metadata.selectionReadiness?.status).toBe('blocked_by_tool_safety');
    expect(metadata.cardSelection?.selectedProductIds).toEqual([]);
    expect(payload.productCards).toEqual([]);
  });

  it('allows preliminary generator cards when unknown loads are bounded enough for approximate selection', async () => {
    const conversations = new FakeConversations();
    const boundedEstimateModel = model({
      async planTurn() {
        return {
          turnId,
          userMessageSummary: 'buyer asks for approximate minimum and reserve generator options',
          dialogueUnderstanding: 'pump exact power is unknown, but the load is bounded as a 220 V borehole pump for a household scenario',
          nextStepRationale: 'calculate a bounded preliminary load profile, then search catalog for approximate generator options',
          requiresTools: true,
          toolRequests: [{
            id: 'generator-load',
            tool: 'calculator.generatorLoad',
            args: {
              query: null,
              semanticQuery: null,
              productIntent: 'generator',
              limit: null,
              productIds: [],
              productNames: [],
              comparisonAttributes: [],
              loads: [
                { kind: 'pump', name: '220 V borehole pump for a household well', count: 1, runningKw: 1.1, startingKw: 3.5, source: 'estimated_average', evidence: 'bounded assumption: borehole pump, 220 V, household water supply, exact nameplate unavailable', basisKind: 'specific_type_or_function', basisSignals: ['consumer_type_known', 'voltage_or_phase_known', 'usage_scope_known', 'buyer_requested_approximation'] },
                { kind: 'refrigerator', name: 'ordinary household refrigerator', count: 1, runningKw: 0.25, startingKw: 1.2, source: 'estimated_average', evidence: 'ordinary household refrigerator', basisKind: 'specific_type_or_function', basisSignals: ['consumer_type_known', 'usage_scope_known'] },
                { kind: 'lighting', name: 'LED lighting', count: 1, runningKw: 0.3, startingKw: 0.3, source: 'estimated_average', evidence: 'LED lighting for small house', basisKind: 'specific_type_or_function', basisSignals: ['consumer_type_known', 'usage_scope_known'] },
                { kind: 'handheld_tool', name: 'angle grinder used separately', count: 1, runningKw: 1.2, startingKw: 1.2, source: 'estimated_average', evidence: 'buyer said angle grinder is occasional, not a base simultaneous load', basisKind: 'specific_type_or_function', basisSignals: ['consumer_type_known', 'usage_scope_known', 'simultaneous_operation_known'] }
              ],
              simultaneousStarting: true,
              simultaneousStartingKinds: ['pump', 'refrigerator'],
              estimateBasis: 'bounded_assumption',
              contact: { name: null, phone: null, email: null, preferredContact: null, comment: null },
              reason: 'buyer asked to estimate approximate minimum and reserve generator options',
              notes: 'Exact pump nameplate is missing; this is preliminary.'
            },
            rationale: 'bounded estimate is useful enough for preliminary cards',
            required: true
          }, {
            id: 'catalog-search',
            tool: 'catalog.search',
            args: {
              query: 'generator 5-6 kW 220 V preliminary',
              semanticQuery: 'preliminary generator options 5-6 kW 220 V for household borehole pump refrigerator LED light',
              productIntent: 'generator',
              limit: 4,
              productIds: [],
              productNames: [],
              comparisonAttributes: [],
              loads: [],
              simultaneousStarting: null,
              simultaneousStartingKinds: [],
              estimateBasis: null,
              contact: { name: null, phone: null, email: null, preferredContact: null, comment: null },
              reason: 'show approximate minimum and reserve catalog options',
              notes: 'Preliminary cards only.'
            },
            rationale: 'buyer requested approximate options',
            required: true
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
            phase: 'any',
            requirements: [],
            rationale: 'The buyer explicitly requested approximate minimum and reserve variants.'
          },
          mustNotAskQuestionIds: [],
          riskFlags: ['bounded_load_assumption', 'exact_pump_power_missing']
        };
      },
      async composeAnswer(input) {
        expect(input.requiredResponseClauses?.map((clause) => clause.code)).toContain('generator_bounded_assumption_preliminary_orientation');
        expect(input.requiredResponseClauses?.map((clause) => clause.instruction).join('\n')).toContain('preliminary calculated orientation');
        const profile = (input.toolResults[0]?.payload as { profile?: { requiredNominalKw?: number } })?.profile;
        return {
          answerText: `Preliminary calculation is about ${profile?.requiredNominalKw} kW. TEST GX6000 is a preliminary reserve option. Exact pump nameplate is still needed before purchase.`,
          factsUsed: [],
          questionsAsked: [],
          toolResultIds: ['generator-load', 'catalog-search'],
          selectedProductIds: ['p2'],
          leadAction: 'none',
          riskFlags: ['bounded_load_assumption'],
          selectionReadiness: {
            productClass: 'generator',
            status: 'ready_for_preliminary_cards',
            canShowProductCards: true,
            missingFacts: ['exact_pump_power_or_model'],
            rationale: 'The buyer explicitly asked for approximate options and the pump is bounded by type, voltage and household use.'
          }
        };
      }
    });
    const orchestrator = new AgentManagerOrchestrator(conversations as never, new BrandedGeneratorProducts() as never, new FakeLeads() as never, boundedEstimateModel);

    const payload = await orchestrator.generateAnswer({
      sessionId,
      turnId,
      userMessage: 'Pump is a 220 V borehole pump, exact power is unknown. Refrigerator, LED light, sometimes a 1.2 kW grinder. Can you roughly show minimum and reserve generators?'
    });

    const metadata = payload.metadata as {
      toolResults?: Array<{ status?: string; payload?: { estimateBasis?: string | null }; warnings?: string[] }>;
      selectionReadiness?: { status?: string; decision?: { status?: string; missingFacts?: string[] } };
      cardSelection?: { selectedProductIds?: string[]; warnings?: string[] };
    };
    expect(metadata.toolResults?.[0]?.payload?.estimateBasis).toBe('bounded_assumption');
    expect(metadata.toolResults?.[0]?.warnings).toContain('generator_load_bounded_assumption');
    expect(metadata.toolResults?.[0]?.warnings).not.toContain('generator_load_estimate_only');
    expect(metadata.toolResults?.[1]?.status).toBe('ok');
    expect(metadata.selectionReadiness?.status).toBe('ready_for_cards');
    expect(metadata.selectionReadiness?.decision?.status).toBe('ready_for_preliminary_cards');
    expect(metadata.selectionReadiness?.decision?.missingFacts).toContain('exact_pump_power_or_model');
    expect(metadata.cardSelection?.warnings ?? []).not.toContain('product_cards_suppressed:generator_load_unconfirmed_basis');
    expect(payload.productCards.map((card) => card.id)).toEqual(['p2']);
  });

  it('allows generator cards after a generator load profile is available', async () => {
    const conversations = new FakeConversations();
    const readyModel = model({
      async planTurn() {
        return {
          turnId,
          userMessageSummary: 'buyer provided generator loads and wants options',
          dialogueUnderstanding: 'calculate load first, then show catalog options',
          nextStepRationale: 'calculator.generatorLoad makes product cards safe enough for preliminary selection',
          requiresTools: true,
          toolRequests: [{
            id: 'generator-load',
            tool: 'calculator.generatorLoad',
            args: {
              query: null,
              semanticQuery: null,
              productIntent: 'generator',
              limit: null,
              productIds: [],
              productNames: [],
              comparisonAttributes: [],
              loads: [
                { kind: 'pump', name: 'pump', count: 1, runningKw: 1, startingKw: 3, source: 'explicit_user', evidence: 'pump 1 kW' },
                { kind: 'refrigerator', name: 'refrigerator', count: 1, runningKw: 0.25, startingKw: 1.2, source: 'estimated_average', evidence: 'one refrigerator', basisKind: 'generic_load_name', basisSignals: ['consumer_type_known', 'simultaneous_operation_known'] }
              ],
              simultaneousStarting: true,
              simultaneousStartingKinds: ['pump', 'refrigerator'],
              contact: { name: null, phone: null, email: null, preferredContact: null, comment: null },
              reason: 'calculate generator load',
              notes: null
            },
            rationale: 'calculate generator load profile',
            required: true
          }, {
            id: 'catalog-search',
            tool: 'catalog.search',
            args: {
              query: 'generator 5-6 kW',
              semanticQuery: 'generator 5-6 kW after calculated load profile',
              productIntent: 'generator',
              limit: 4,
              productIds: [],
              productNames: [],
              comparisonAttributes: [],
              loads: [],
              simultaneousStarting: null,
              simultaneousStartingKinds: [],
              contact: { name: null, phone: null, email: null, preferredContact: null, comment: null },
              reason: 'show catalog options',
              notes: null
            },
            rationale: 'search matching generator products after load calculation',
            required: true
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
            phase: 'any',
            requirements: [],
            rationale: 'The answer is explicitly a preliminary generator shortlist.'
          },
          mustNotAskQuestionIds: [],
          riskFlags: ['power_requirements_uncertain']
        };
      },
      async composeAnswer() {
        return {
          answerText: 'After the load calculation, TEST GX5000 and TEST GX6000 are reasonable preliminary options.',
          factsUsed: [],
          questionsAsked: [],
          toolResultIds: ['generator-load', 'catalog-search'],
          selectedProductIds: ['p1', 'p2'],
          leadAction: 'none',
          riskFlags: ['power_requirements_uncertain'],
          selectionReadiness: {
            productClass: 'generator',
            status: 'ready_for_preliminary_cards',
            canShowProductCards: true,
            missingFacts: ['exact_pump_power'],
            rationale: 'The buyer asked for preliminary generator options and a calculated load profile is available.'
          }
        };
      }
    });
    const orchestrator = new AgentManagerOrchestrator(conversations as never, new BrandedGeneratorProducts() as never, new FakeLeads() as never, readyModel);

    const payload = await orchestrator.generateAnswer({
      sessionId,
      turnId,
      userMessage: 'Pump is 1 kW, refrigerator may start with it. Show 5-6 kW generator options.'
    });

    const metadata = payload.metadata as { selectionReadiness?: { status?: string; decision?: { status?: string } } };
    expect(metadata.selectionReadiness?.status).toBe('ready_for_cards');
    expect(metadata.selectionReadiness?.decision?.status).toBe('ready_for_preliminary_cards');
    expect(payload.productCards.length).toBeGreaterThan(0);
  });

  it('reuses previous visible cards for a ready follow-up without a new catalog search', async () => {
    const previousCards: ProductCard[] = [{
      id: 'plate-62',
      name: 'Виброплита FIRMAN FPC60H 62 кг',
      brand: 'FIRMAN',
      category: 'Виброплиты',
      price: 98800,
      currency: 'RUB',
      sourceUrl: 'https://example.test/plate-62',
      specs: { 'рабочая масса, кг': '62' },
      reasons: ['Найдено в каталоге под текущий запрос.'],
      caveats: []
    }];
    const previousAssistant = message('Подойдут FIRMAN FPC60H и Masalta MS50-2.', 'assistant');
    previousAssistant.metadata = { productCards: previousCards };

    const conversations = new FakeConversations();
    conversations.messages = [
      message('Нужна виброплита для дорожек, таскать буду сам.'),
      previousAssistant,
      message('Объясните, что важнее для моей задачи: вес, глубина или подошва, и покажите варианты.')
    ];
    const followUpModel = model({
      async planTurn() {
        return {
          turnId,
          userMessageSummary: 'buyer asks a follow-up about already selected plate options',
          dialogueUnderstanding: 'previous visible plate cards still match this follow-up',
          nextStepRationale: 'answer from context without repeating catalog search',
          requiresTools: false,
          toolRequests: [],
          mustNotAskQuestionIds: [],
          riskFlags: []
        };
      },
      async composeAnswer() {
        return {
          answerText: 'Для виброплиты под дорожки важнее вес и удобство переноски, затем размер подошвы и глубина уплотнения. Из уже подходивших вариантов оставляю FIRMAN FPC60H.',
          factsUsed: [],
          questionsAsked: [],
          toolResultIds: [],
          leadAction: 'none',
          riskFlags: [],
          selectionReadiness: {
            productClass: 'plate',
            status: 'ready_for_preliminary_cards',
            canShowProductCards: true,
            missingFacts: [],
            rationale: 'The previous plate cards still match the current follow-up.'
          }
        };
      }
    });
    const orchestrator = new AgentManagerOrchestrator(conversations as never, new FakeProducts() as never, new FakeLeads() as never, followUpModel);

    const payload = await orchestrator.generateAnswer({
      sessionId,
      turnId,
      userMessage: 'Объясните, что важнее для моей задачи: вес, глубина или подошва, и покажите варианты.'
    });

    const metadata = payload.metadata as { cardSelection?: { warnings?: string[]; selectedProductIds?: string[] } };
    expect(payload.productCards.map((card) => card.id)).toEqual(['plate-62']);
    expect(metadata.cardSelection?.selectedProductIds).toEqual(['plate-62']);
    expect(metadata.cardSelection?.warnings).toContain('product_cards_reused_from_previous_turn');
  });

  it('replaces previous over-budget cutter cards after the buyer narrows the budget without a planned tool', async () => {
    const previousCards: ProductCard[] = [{
      id: 'cutter-old-1',
      name: 'Cutter Pro 350 expensive',
      brand: 'TEST',
      category: 'Cutters',
      price: 155000,
      currency: 'RUB',
      sourceUrl: 'https://example.test/cutter-old-1',
      specs: { blade: '350 mm' },
      reasons: ['previous visible card'],
      caveats: []
    }, {
      id: 'cutter-old-2',
      name: 'Cutter Road 400 expensive',
      brand: 'TEST',
      category: 'Cutters',
      price: 185000,
      currency: 'RUB',
      sourceUrl: 'https://example.test/cutter-old-2',
      specs: { blade: '400 mm' },
      reasons: ['previous visible card'],
      caveats: []
    }];
    const previousAssistant = message('These cutter options fit serious concrete/asphalt work.', 'assistant');
    previousAssistant.metadata = { productCards: previousCards };

    class BudgetCutterProducts extends FakeProducts {
      async searchProducts() {
        return [
          { ...product('cutter-under-1', 'Cutter Compact 300 budget', 'Cutters'), price: 62000, specs: { blade: '300 mm' } },
          { ...product('cutter-under-2', 'Cutter Light 300 budget', 'Cutters'), price: 68000, specs: { blade: '300 mm' } },
          { ...product('cutter-over-noise', 'Cutter Premium 400 over budget', 'Cutters'), price: 190000, specs: { blade: '400 mm' } }
        ];
      }
    }

    const conversations = new FakeConversations();
    conversations.messages = [
      message('Need a cutter for small repair work, show variants.'),
      previousAssistant,
      message('Actually only up to 70000, which is better now?')
    ];
    const cutterModel = model({
      async proposeLedgerDelta() {
        return {
          rationale: 'buyer narrowed cutter budget',
          events: [{
            eventType: 'fact.confirmed',
            scope: 'dialogue',
            payload: { factKey: 'product.type', value: 'cutter' },
            evidence: 'Need a cutter',
            source: 'llm_state_delta',
            status: 'active'
          }, {
            eventType: 'fact.confirmed',
            scope: 'dialogue',
            payload: { factKey: 'budget.max', value: 70000 },
            evidence: 'only up to 70000',
            source: 'llm_state_delta',
            status: 'active'
          }]
        };
      },
      async planTurn() {
        return {
          turnId,
          userMessageSummary: 'buyer asks which previous cutter option is better after limiting budget to 70000',
          dialogueUnderstanding: 'previous visible cutter cards are above the new budget and should be replaced',
          nextStepRationale: 'explain the mismatch and use suitable in-budget cutter alternatives',
          requiresTools: false,
          toolRequests: [],
          productMentions: previousCards.map((card) => ({
            name: card.name,
            role: 'comparison_subject' as const,
            productClass: 'cutter',
            evidence: 'previous visible card'
          })),
          mustNotAskQuestionIds: [],
          riskFlags: []
        };
      },
      async composeAnswer(input) {
        expect(input.products.map((item) => item.id)).toEqual(['cutter-under-1', 'cutter-under-2']);
        expect(input.toolResults.map((result) => result.requestId)).toContain('catalog-search:narrowed-replacement');
        expect(input.requiredResponseClauses?.map((clause) => clause.code)).toContain('previous_cards_unsuitable_replaced_by_narrowed_search');
        return {
          answerText: 'The previous cutters are above the new budget, so I would not choose them for this narrowed request. From the in-budget replacements I would look at Cutter Compact 300 budget and Cutter Light 300 budget.',
          factsUsed: [],
          questionsAsked: [],
          toolResultIds: ['catalog-search:narrowed-replacement'],
          leadAction: 'none',
          riskFlags: [],
          selectionReadiness: {
            productClass: 'cutter',
            status: 'ready_for_exact_cards',
            canShowProductCards: true,
            missingFacts: [],
            rationale: 'Replacement cutter products match the narrowed budget.'
          }
        };
      }
    });
    const orchestrator = new AgentManagerOrchestrator(conversations as never, new BudgetCutterProducts() as never, new FakeLeads() as never, cutterModel);

    const payload = await orchestrator.generateAnswer({
      sessionId,
      turnId,
      userMessage: 'Actually only up to 70000, which is better now?'
    });

    const metadata = payload.metadata as {
      answerProductEvidence?: { droppedProductIds?: string[]; replacementProductIds?: string[]; warnings?: string[] };
      replacementProductEvidence?: { productIds?: string[]; droppedPreviousProductIds?: string[]; productIntent?: string; warnings?: string[] };
      toolResults?: Array<{ requestId?: string; payload?: { productIds?: string[] } }>;
      warnings?: string[];
    };
    expect(payload.productCards.map((card) => card.id)).toEqual(['cutter-under-1', 'cutter-under-2']);
    expect(payload.productCards.map((card) => card.id)).not.toContain('cutter-old-1');
    expect(metadata.answerProductEvidence?.droppedProductIds).toEqual(['cutter-old-1', 'cutter-old-2']);
    expect(metadata.answerProductEvidence?.replacementProductIds).toEqual(['cutter-under-1', 'cutter-under-2']);
    expect(metadata.replacementProductEvidence?.productIntent).toBe('cutter');
    expect(metadata.replacementProductEvidence?.droppedPreviousProductIds).toEqual(['cutter-old-1', 'cutter-old-2']);
    expect(metadata.replacementProductEvidence?.warnings).toContain('answer_products_replaced_by_narrowed_need_search');
    expect(metadata.toolResults?.map((result) => result.requestId)).toContain('catalog-search:narrowed-replacement');
    expect(metadata.toolResults?.find((result) => result.requestId === 'catalog-search:narrowed-replacement')?.payload?.productIds).toEqual(['cutter-under-1', 'cutter-under-2']);
    expect(metadata.warnings).toContain('answer_products_previous_cards_rejected_by_narrowed_need');
  });

  it('keeps over-budget products out of answer evidence when in-budget catalog candidates exist', async () => {
    class BudgetPlateProducts extends FakeProducts {
      async searchProducts() {
        return [
          {
            ...product('under-light', 'Виброплита бензиновая Masalta MS50-2 (54 кг)', 'Виброплиты'),
            price: 55000,
            specs: { 'рабочая масса, кг': '54' }
          },
          {
            ...product('over-budget', 'Виброплита прямоходная ТСС TSS-WP60TH (60 кг)', 'Виброплиты'),
            price: 79592,
            specs: { 'рабочая масса, кг': '60' }
          },
          {
            ...product('under-tss', 'Виброплита прямоходная ТСС TSS-WP60TL (72 кг)', 'Виброплиты'),
            price: 53360,
            specs: { 'рабочая масса, кг': '72' }
          }
        ];
      }
    }

    const productIdsSeenByAnswer: string[][] = [];
    const conversations = new FakeConversations();
    const budgetModel = model({
      async proposeLedgerDelta() {
        return {
          rationale: 'buyer constrained vibroplate budget',
          events: [{
            eventType: 'fact.confirmed',
            scope: 'dialogue',
            payload: { factKey: 'product.type', value: 'vibroplate' },
            evidence: 'needs a vibroplate',
            source: 'llm_state_delta',
            status: 'active'
          }, {
            eventType: 'fact.confirmed',
            scope: 'dialogue',
            payload: { factKey: 'budget.max', value: 70000 },
            evidence: 'budget up to 70 thousand',
            source: 'llm_state_delta',
            status: 'active'
          }]
        };
      },
      async planTurn() {
        return {
          turnId,
          userMessageSummary: 'buyer needs a light vibroplate under 70000',
          dialogueUnderstanding: 'catalog answer should be grounded only in products satisfying the budget when such products exist',
          nextStepRationale: 'search catalog and answer from in-budget plate candidates',
          requiresTools: true,
          selectionPolicy: {
            targetProductClass: 'vibroplate',
            canonicalProductClass: 'plate',
            needAction: 'continue',
            alternativePolicy: 'same_class_only',
            reusePreviousCards: false,
            maxCards: null,
            powerSource: null,
            phase: null,
            requirements: [{
              id: 'budget-current',
              kind: 'budget_max_rub',
              value: 70000,
              unit: 'RUB',
              role: 'hard_constraint',
              strictness: 'strict',
              evidence: 'Buyer stated a 70,000 RUB maximum.'
            }],
            rationale: 'Use the buyer budget as a strict catalog constraint.'
          },
          toolRequests: [{
            id: 'catalog-search',
            tool: 'catalog.search',
            args: {
              query: 'виброплита до 70000 легкая',
              semanticQuery: 'light plate compactor under 70000',
              productIntent: 'plate',
              limit: 6,
              productIds: [],
              productNames: [],
              comparisonAttributes: ['price', 'weight'],
              loads: [],
              simultaneousStarting: null,
              simultaneousStartingKinds: [],
              contact: { name: null, phone: null, email: null, preferredContact: null, comment: null },
              reason: 'select in-budget vibroplate candidates',
              notes: null
            },
            rationale: 'buyer needs catalog products within budget',
            required: true
          }],
          mustNotAskQuestionIds: [],
          riskFlags: []
        };
      },
      async composeAnswer(input) {
        productIdsSeenByAnswer.push(input.products.map((item) => item.id));
        const groundedNames = input.products.map((item) => item.name).join('; ');
        return {
          answerText: `${groundedNames}. Also mentions dropped product TSS-WP60TH.`,
          factsUsed: [],
          questionsAsked: [],
          toolResultIds: ['catalog-search'],
          leadAction: 'none',
          riskFlags: [],
          selectionReadiness: {
            productClass: 'plate',
            status: 'ready_for_exact_cards',
            canShowProductCards: true,
            missingFacts: [],
            rationale: 'Budget and product class are known.'
          }
        };
      }
    });
    const orchestrator = new AgentManagerOrchestrator(conversations as never, new BudgetPlateProducts() as never, new FakeLeads() as never, budgetModel);

    const payload = await orchestrator.generateAnswer({
      sessionId,
      turnId,
      userMessage: 'Бюджет до 70 тысяч, нужна не слишком тяжелая виброплита.'
    });

    const metadata = payload.metadata as {
      answerProductEvidence?: { droppedProductIds?: string[] };
      preSendReview?: { issues?: Array<{ code?: string }> };
      warnings?: string[];
    };
    expect(productIdsSeenByAnswer[0]).toEqual(['under-light', 'under-tss']);
    expect(productIdsSeenByAnswer[0]).not.toContain('over-budget');
    expect(payload.answer).not.toContain('TSS-WP60TH');
    expect(payload.productCards.map((card) => card.id)).toEqual(['under-light', 'under-tss']);
    expect(metadata.answerProductEvidence?.droppedProductIds).toEqual(['over-budget']);
    expect(metadata.preSendReview?.issues?.map((issue) => issue.code)).toContain('unsupported_catalog_product_mention');
    expect(metadata.warnings).toContain('answer_products_filtered_by_structured_hard_constraints:1');
  });

  it('uses the same strict autostart evidence boundary for answer text and visible cards', async () => {
    class AutoStartProducts extends FakeProducts {
      async searchProducts() {
        return [{
          ...generatorProductWithPower('generator-no-auto', 'TSS SGG 6000NA generator', 6),
          specs: { 'Nominal power': '6 kW', Autostart: 'no' }
        }, {
          ...generatorProductWithPower('generator-with-auto', 'TSS SGG 6000ATS generator', 6),
          specs: { 'Nominal power': '6 kW', Autostart: 'yes' }
        }, {
          ...generatorProductWithPower('generator-auto-unknown', 'TSS SGG 6000U generator', 6),
          specs: { 'Nominal power': '6 kW' }
        }, {
          ...generatorProductWithPower('generator-auto-conflict', 'TSS SGG 6000C generator', 6),
          specs: { 'Nominal power': '6 kW', 'Auto start': 'yes', Autostart: 'no' }
        }];
      }
    }

    const conversations = new FakeConversations();
    const autostartModel = model({
      async planTurn(): Promise<AgentIntentContract> {
        return {
          userMessageSummary: 'buyer requests a generator without automatic start',
          dialogueUnderstanding: 'autostart is a strict product attribute constraint',
          nextStepRationale: 'show only catalog products explicitly confirmed without autostart',
          requiresTools: true,
          toolRequests: [{
            id: 'catalog-search',
            tool: 'catalog.search',
            args: {
              query: 'generator 6 kW without autostart',
              semanticQuery: 'generator with explicit no-autostart product fact',
              productIntent: 'generator',
              canonicalProductIntent: 'generator',
              limit: 8
            },
            rationale: 'ground the recommendation in current catalog facts',
            required: true,
            coversRequirementIds: ['no-autostart']
          }],
          selectionPolicy: {
            targetProductClass: 'generator',
            canonicalProductClass: 'generator',
            needAction: 'continue',
            alternativePolicy: 'same_class_only',
            reusePreviousCards: false,
            maxCards: 4,
            powerSource: 'any',
            phase: 'any',
            requirements: [{
              id: 'no-autostart',
              kind: 'autostart_required',
              value: false,
              unit: null,
              relation: 'must_not_have',
              role: 'hard_constraint',
              strictness: 'strict',
              evidence: 'automatic start is not needed',
              verification: { mode: 'product_attribute' }
            }],
            rationale: 'the product attribute must be explicit before recommendation'
          },
          mustNotAskQuestionIds: [],
          riskFlags: []
        };
      },
      async composeAnswer(input) {
        expect(input.products.map((item) => item.id)).toEqual(['generator-no-auto']);
        return {
          answerText: 'TSS SGG 6000NA generator is the only currently validated no-autostart candidate in this result.',
          factsUsed: [],
          questionsAsked: [],
          toolResultIds: ['catalog-search'],
          selectedProductIds: ['generator-no-auto'],
          leadAction: 'none' as const,
          riskFlags: [],
          selectionReadiness: {
            productClass: 'generator',
            status: 'ready_for_exact_cards' as const,
            canShowProductCards: true,
            missingFacts: [],
            rationale: 'The returned product has an explicit no-autostart fact.'
          }
        };
      }
    });
    const orchestrator = new AgentManagerOrchestrator(
      conversations as never,
      new AutoStartProducts() as never,
      new FakeLeads() as never,
      autostartModel
    );

    const payload = await orchestrator.generateAnswer({
      sessionId,
      turnId,
      userMessage: 'Show a 6 kW generator without automatic start.'
    });

    expect(payload.answer).toContain('TSS SGG 6000NA');
    expect(payload.answer).not.toContain('TSS SGG 6000ATS');
    expect(payload.productCards.map((card) => card.id)).toEqual(['generator-no-auto']);
    const metadata = payload.metadata as {
      answerProductEvidence?: { droppedProductIds?: string[] };
      warnings?: string[];
    };
    expect(metadata.answerProductEvidence?.droppedProductIds).toEqual(expect.arrayContaining([
      'generator-with-auto',
      'generator-auto-unknown',
      'generator-auto-conflict'
    ]));
    expect(metadata.warnings).toContain('answer_products_filtered_by_structured_hard_constraints:3');
  });

  it('lets the reviewer pass a useful no-card answer when raw catalog ids have no validated products', async () => {
    class UnverifiedAutoStartProducts extends FakeProducts {
      async searchProducts() {
        return [{
          ...generatorProductWithPower('raw-auto-unknown', 'TSS SGG 6000U generator', 6),
          specs: { 'Nominal power': '6 kW' }
        }, {
          ...generatorProductWithPower('raw-auto-conflict', 'TSS SGG 6000C generator', 6),
          specs: { 'Nominal power': '6 kW', 'Auto start': 'yes', Autostart: 'no' }
        }];
      }
    }
    const intent = structuredGeneratorCatalogIntent();
    intent.toolRequests[0]!.coversRequirementIds = ['no-autostart'];
    intent.selectionPolicy!.requirements = [{
      id: 'no-autostart',
      kind: 'autostart_required',
      value: false,
      unit: null,
      relation: 'must_not_have',
      role: 'hard_constraint',
      strictness: 'strict',
      evidence: 'the requested candidate must be explicitly without autostart',
      verification: { mode: 'product_attribute' }
    }];
    const composeAnswer = vi.fn(async (input: Parameters<AgentManagerModel['composeAnswer']>[0]) => {
      expect(input.products).toEqual([]);
      expect(input.toolResults[0]).toMatchObject({
        requestId: 'catalog-search',
        status: 'ok',
        payload: {
          productIds: [],
          retrieval: {
            candidateTiers: expect.arrayContaining([
              expect.objectContaining({ productId: 'raw-auto-unknown', tier: 'rejected' }),
              expect.objectContaining({ productId: 'raw-auto-conflict', tier: 'rejected' })
            ])
          }
        }
      });
      return {
        answerText: 'I found catalog rows, but none has a reliable no-autostart fact, so I will not show misleading cards. The useful next step is to verify that exact specification for the current candidates.',
        factsUsed: [],
        questionsAsked: [],
        toolResultIds: ['catalog-search'],
        selectedProductIds: [],
        leadAction: 'none' as const,
        riskFlags: [],
        selectionReadiness: {
          productClass: 'generator',
          status: 'needs_more_info' as const,
          canShowProductCards: false,
          missingFacts: ['explicit installed autostart status'],
          rationale: 'Raw catalog rows did not pass the strict product-attribute verifier.'
        }
      };
    });
    const reviewAnswer = vi.fn(async (input: Parameters<AgentManagerModel['reviewAnswer']>[0]) => {
      expect(input.products).toEqual([]);
      expect(input.toolResults[0]).toMatchObject({
        requestId: 'catalog-search',
        status: 'ok',
        payload: { productIds: [] }
      });
      expect(input.answer.answerText).not.toContain('TSS SGG 6000U');
      expect(input.answer.answerText).not.toContain('TSS SGG 6000C');
      return { verdict: 'pass' as const, issues: [] };
    });
    const conversations = new FakeConversations();
    const orchestrator = new AgentManagerOrchestrator(
      conversations as never,
      new UnverifiedAutoStartProducts() as never,
      new FakeLeads() as never,
      model({
        async planTurn() {
          return intent;
        },
        composeAnswer,
        reviewAnswer
      })
    );
    const previousReviewMode = config.AI_MANAGER_REVIEW_MODE;
    config.AI_MANAGER_REVIEW_MODE = 'always';
    try {
      const payload = await orchestrator.generateAnswer({
        sessionId,
        turnId,
        userMessage: 'Show a 6 kW generator explicitly without automatic start.'
      });

      expect(payload.answer).toContain('none has a reliable no-autostart fact');
      expect(payload.productCards).toEqual([]);
      expect(composeAnswer).toHaveBeenCalledTimes(1);
      expect(reviewAnswer).toHaveBeenCalledTimes(1);
      const metadata = payload.metadata as {
        answerProductEvidence?: { droppedProductIds?: string[] };
      };
      expect(metadata.answerProductEvidence?.droppedProductIds).toEqual([
        'raw-auto-unknown',
        'raw-auto-conflict'
      ]);
    } finally {
      config.AI_MANAGER_REVIEW_MODE = previousReviewMode;
    }
  });

  it('blocks generator catalog cards below the calculated load profile requirement', async () => {
    class WeakGeneratorProducts extends FakeProducts {
      async searchProducts() {
        return [
          generatorProductWithPower('weak-2kw', 'Generator 2 kW', 2),
          generatorProductWithPower('weak-34kw', 'Generator 3.4 kW', 3.4)
        ];
      }
    }

    const conversations = new FakeConversations();
    const loadFitModel = model({
      async planTurn() {
        return {
          turnId,
          userMessageSummary: 'buyer provided several loads and wants generator cards under budget',
          dialogueUnderstanding: 'the calculated load requirement controls which generator cards can be shown',
          nextStepRationale: 'calculate load first, then search catalog products',
          requiresTools: true,
          toolRequests: [{
            id: 'generator-load',
            tool: 'calculator.generatorLoad',
            args: {
              query: null,
              semanticQuery: null,
              productIntent: 'generator',
              limit: null,
              productIds: [],
              productNames: [],
              comparisonAttributes: [],
              loads: [
                { kind: 'refrigerator', name: 'refrigerator', count: 1, runningKw: 0.2, startingKw: 0.8, source: 'explicit_user', evidence: 'refrigerator 0.2 kW run and 0.8 kW start' },
                { kind: 'lighting', name: 'LED lighting', count: 1, runningKw: 0.1, startingKw: 0.1, source: 'explicit_user', evidence: 'LED lighting 0.1 kW' },
                { kind: 'handheld_tool', name: 'angle grinder', count: 1, runningKw: 1.2, startingKw: 2, source: 'explicit_user', evidence: 'angle grinder 1.2 kW run and 2 kW start' },
                { kind: 'pump', name: 'pump', count: 1, runningKw: 1.5, startingKw: 4.5, source: 'explicit_user', evidence: 'pump 1.5 kW run and 4.5 kW start' }
              ],
              simultaneousStarting: true,
              simultaneousStartingKinds: ['pump', 'handheld_tool'],
              contact: { name: null, phone: null, email: null, preferredContact: null, comment: null },
              reason: 'calculate generator load before card selection',
              notes: null
            },
            rationale: 'calculate generator load profile',
            required: true
          }, {
            id: 'catalog-search',
            tool: 'catalog.search',
            args: {
              query: 'generator under 90000',
              semanticQuery: 'generator under 90000 after calculated 7 kW load requirement',
              productIntent: 'generator',
              limit: 4,
              productIds: [],
              productNames: [],
              comparisonAttributes: [],
              loads: [],
              simultaneousStarting: null,
              simultaneousStartingKinds: [],
              contact: { name: null, phone: null, email: null, preferredContact: null, comment: null },
              reason: 'find catalog generator options after the load calculation',
              notes: null
            },
            rationale: 'search generator products after load calculation',
            required: true
          }],
          mustNotAskQuestionIds: [],
          riskFlags: []
        };
      },
      async composeAnswer() {
        return {
          answerText: 'The calculated requirement is about 7 kW nominal, so weak catalog options should not be shown as viable cards.',
          factsUsed: [],
          questionsAsked: [],
          toolResultIds: ['generator-load', 'catalog-search'],
          leadAction: 'none',
          riskFlags: [],
          selectionReadiness: {
            productClass: 'generator',
            status: 'ready_for_preliminary_cards',
            canShowProductCards: true,
            missingFacts: [],
            rationale: 'The load profile is available.'
          }
        };
      }
    });
    const orchestrator = new AgentManagerOrchestrator(conversations as never, new WeakGeneratorProducts() as never, new FakeLeads() as never, loadFitModel);

    const payload = await orchestrator.generateAnswer({
      sessionId,
      turnId,
      userMessage: 'Need a generator for fridge, lights, 1.2 kW grinder and 1.5 kW pump. Pump and grinder can start together. Show options under 90k.'
    });

    const metadata = payload.metadata as {
      toolResults?: Array<{
        status?: string;
        payload?: {
          profile?: { requiredNominalKw?: number };
          productIds?: string[];
          generatorLoadFit?: { requiredNominalKw?: number; droppedProductIds?: string[] };
        };
        warnings?: string[];
      }>;
      cardSelection?: { selectedProductIds?: string[]; warnings?: string[] };
    };
    expect(metadata.toolResults?.[0]?.payload?.profile?.requiredNominalKw).toBe(7);
    expect(metadata.toolResults?.[1]?.status).toBe('ok');
    expect(metadata.toolResults?.[1]?.payload?.productIds).toEqual([]);
    expect(metadata.toolResults?.[1]?.payload?.generatorLoadFit?.requiredNominalKw).toBe(7);
    expect(metadata.toolResults?.[1]?.payload?.generatorLoadFit?.droppedProductIds).toEqual(
      expect.arrayContaining(['weak-2kw', 'weak-34kw'])
    );
    expect(metadata.toolResults?.[1]?.warnings).toEqual(expect.arrayContaining([
      'catalog_products_filtered_by_generator_load:2',
      'catalog_search_no_generator_load_fit'
    ]));
    expect(metadata.cardSelection?.selectedProductIds).toEqual([]);
    expect(payload.productCards).toEqual([]);
  });

  it('prefers exact answer-mentioned product models over broad same-brand card expansion', async () => {
    class SameBrandProducts extends FakeProducts {
      async searchProducts() {
        return [
          { ...product('evo-6200', 'Generator EVOline BQH 6200 E 5 kW', 'Generators'), brand: 'EVOline' },
          { ...product('evo-7500', 'Generator EVOline BQH 7500 E 6 kW', 'Generators'), brand: 'EVOline' },
          { ...product('zongshen-6200', 'Generator Zongshen BQH 6200 E 5 kW', 'Generators'), brand: 'Zongshen' }
        ];
      }
    }

    const conversations = new FakeConversations();
    const catalogModel = model({
      async planTurn() {
        return {
          turnId,
          userMessageSummary: 'buyer asks for generator catalog options',
          dialogueUnderstanding: 'the answer should show the exact selected generator model',
          nextStepRationale: 'search catalog and answer with the selected product',
          requiresTools: true,
          toolRequests: [{
            id: 'catalog-search',
            tool: 'catalog.search',
            args: {
              query: 'generator EVOline BQH 6200 E',
              limit: 8,
              productIds: [],
              productNames: [],
              comparisonAttributes: [],
              loads: [],
              simultaneousStarting: null,
              simultaneousStartingKinds: [],
              contact: { name: null, phone: null, email: null, preferredContact: null, comment: null },
              reason: null,
              notes: null
            },
            rationale: 'buyer needs a generator card',
            required: true
          }],
          mustNotAskQuestionIds: [],
          riskFlags: []
        };
      },
      async composeAnswer() {
        return {
          answerText: 'The best reserve option is EVOline BQH 6200 E.',
          factsUsed: [],
          questionsAsked: [],
          toolResultIds: ['catalog-search'],
          leadAction: 'none',
          riskFlags: []
        };
      }
    });
    const orchestrator = new AgentManagerOrchestrator(conversations as never, new SameBrandProducts() as never, new FakeLeads() as never, catalogModel);

    const payload = await orchestrator.generateAnswer({
      sessionId,
      turnId,
      userMessage: 'Show generator options for coffee point.'
    });

    expect(payload.productCards.map((card) => card.id)).toEqual(['evo-6200']);
  });

  it('matches TSS answer mentions to catalog cards whose brand is stored as Cyrillic TCC', async () => {
    class TssProducts extends FakeProducts {
      async searchProducts() {
        return [
          { ...product('tss-7000', 'Generator TSS SGG 7000EA 7 kW', 'Generators'), brand: 'ТСС' },
          { ...product('energo-7000', 'Generator Energo EB7.0/230-R 7 kW', 'Generators'), brand: 'Energo' }
        ];
      }
    }

    const conversations = new FakeConversations();
    const catalogModel = model({
      async planTurn() {
        return {
          turnId,
          userMessageSummary: 'buyer asks for 7 kW generator options',
          dialogueUnderstanding: 'the answer names an exact TSS model',
          nextStepRationale: 'show the exact mentioned card',
          requiresTools: true,
          toolRequests: [{
            id: 'catalog-search',
            tool: 'catalog.search',
            args: {
              query: 'генератор 7 кВт TSS SGG 7000EA',
              limit: 4,
              productIds: [],
              productNames: [],
              comparisonAttributes: [],
              loads: [],
              simultaneousStarting: null,
              simultaneousStartingKinds: [],
              contact: { name: null, phone: null, email: null, preferredContact: null, comment: null },
              reason: null,
              notes: null
            },
            rationale: 'buyer asked for TSS generator',
            required: true
          }],
          mustNotAskQuestionIds: [],
          riskFlags: []
        };
      },
      async composeAnswer() {
        return {
          answerText: 'As a reserve option, TSS SGG 7000EA is suitable.',
          factsUsed: [],
          questionsAsked: [],
          toolResultIds: ['catalog-search'],
          leadAction: 'none',
          riskFlags: []
        };
      }
    });
    const orchestrator = new AgentManagerOrchestrator(conversations as never, new TssProducts() as never, new FakeLeads() as never, catalogModel);

    const payload = await orchestrator.generateAnswer({
      sessionId,
      turnId,
      userMessage: 'Show 7 kW generator option.'
    });

    expect(payload.productCards.map((card) => card.id)).toEqual(['tss-7000']);
  });

  it('ranks generator catalog matches by requested kW range before oversized same-class results', async () => {
    class PowerRangeProducts extends FakeProducts {
      async searchProducts() {
        return [
          { ...product('huge', 'Generator ENERGY WE900WPS 700 kW', 'Generators'), specs: { power: '700 kW' } },
          { ...product('six', 'Generator EVOline BQH 7500 E 6 kW', 'Generators'), specs: { power: '6 kW' } },
          { ...product('five', 'Generator EVOline BQH 6200 E 5 kW', 'Generators'), specs: { power: '5 kW' } }
        ];
      }
    }

    const conversations = new FakeConversations();
    const catalogModel = model({
      async planTurn() {
        return {
          turnId,
          userMessageSummary: 'buyer asks for 6-7 kW generator options',
          dialogueUnderstanding: 'generator options around the requested power range are needed',
          nextStepRationale: 'search catalog with the kW range and avoid oversized industrial units',
          requiresTools: true,
          toolRequests: [{
            id: 'catalog-search',
            tool: 'catalog.search',
            args: {
              query: 'генератор 6-7 кВт для кофейной точки',
              limit: 2,
              productIds: [],
              productNames: [],
              comparisonAttributes: [],
              loads: [],
              simultaneousStarting: null,
              simultaneousStartingKinds: [],
              contact: { name: null, phone: null, email: null, preferredContact: null, comment: null },
              reason: null,
              notes: null
            },
            rationale: 'buyer asked for generators around 6-7 kW',
            required: true
          }],
          mustNotAskQuestionIds: [],
          riskFlags: []
        };
      },
      async composeAnswer() {
        return {
          answerText: 'The closest catalog option is EVOline BQH 7500 E 6 kW.',
          factsUsed: [],
          questionsAsked: [],
          toolResultIds: ['catalog-search'],
          leadAction: 'none',
          riskFlags: []
        };
      }
    });
    const orchestrator = new AgentManagerOrchestrator(conversations as never, new PowerRangeProducts() as never, new FakeLeads() as never, catalogModel);

    const payload = await orchestrator.generateAnswer({
      sessionId,
      turnId,
      userMessage: 'Show generator options around 6-7 kW.'
    });

    const metadata = payload.metadata as { toolResults?: Array<{ payload?: { productIds?: string[] } }> };
    expect(metadata.toolResults?.[0]?.payload?.productIds).toEqual(['six', 'five']);
    expect(metadata.toolResults?.[0]?.payload?.productIds).not.toContain('huge');
  });

  it('persists a phone-only handoff with the original buyer question instead of losing it', async () => {
    const conversations = new FakeConversations();
    const leads = new FakeLeads();
    const originalQuestion = 'Please verify whether Firman RD3910E has electric start.';
    const phoneReply = '+7 900 000-00-11, please message me';
    const previousIntent: AgentIntentContract = {
      userMessageSummary: 'research exhausted for the original technical question',
      dialogueUnderstanding: 'the exact technical fact remains unconfirmed after the available source tiers',
      nextStepRationale: 'offer to return the concrete specialist result',
      requiresTools: true,
      toolRequests: [{
        id: 'prior-web-research',
        tool: 'web.researchProductFacts',
        args: {
          query: originalQuestion,
          productNames: ['Firman RD3910E'],
          comparisonAttributes: ['electric start']
        },
        rationale: 'verify the exact technical fact before offering a specialist',
        required: true,
        coversRequirementIds: []
      }],
      grounding: {
        taskType: 'technical_answer',
        sourcePolicy: 'web_required',
        webPurpose: 'technical_specs',
        webRequirement: 'independent_required',
        requiredToolKinds: ['web.researchProductFacts'],
        technicalAttributes: ['electric start'],
        buyerQuestion: originalQuestion,
        rationale: 'research the exact model before handoff'
      },
      productMentions: [],
      selectionPolicy: currentNoProductSelectionPolicy(),
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
    const priorAssistant = {
      ...message('Оставьте номер телефона и скажите, как удобнее получить результат: сообщением или звонком.', 'assistant'),
      id: '55555555-5555-4555-8555-555555555555',
      metadata: {
        intentContract: previousIntent,
        answerContract: {
          answerText: 'Оставьте номер телефона и скажите, как удобнее получить результат: сообщением или звонком.',
          factsUsed: [],
          questionsAsked: [],
          toolResultIds: ['prior-web-research'],
          selectedProductIds: [],
          leadAction: 'offer_form',
          riskFlags: []
        },
        toolResults: [{
          requestId: 'prior-web-research',
          tool: 'web.researchProductFacts',
          status: 'ok',
          payload: {
            usedWebSearch: true,
            searchDisposition: 'completed',
            sourcesExhausted: true,
            researchOutcome: 'exhausted',
            sourceAttempts: [
              { tier: 'catalog', outcome: 'not_found' },
              { tier: 'official_page', outcome: 'not_found', query: 'Firman RD3910E official product page electric start' },
              { tier: 'official_manual', outcome: 'not_found', query: 'Firman RD3910E official manual electric start PDF' },
              { tier: 'reliable_secondary', outcome: 'not_found', query: 'Firman RD3910E reliable distributor electric start' }
            ]
          },
          warnings: []
        }]
      }
    };
    conversations.messages = [
      { ...message(originalQuestion), id: '44444444-4444-4444-8444-444444444444' },
      priorAssistant,
      message(phoneReply)
    ];
    const leadModel = model({
      async planTurn(input) {
        expect(input.pendingLeadCaptureDraft).toBeNull();
        return {
          userMessageSummary: 'buyer supplied a phone and chose a message',
          dialogueUnderstanding: 'this continues the specialist verification handoff',
          nextStepRationale: 'store the partial contact and ask only for the missing name',
          requiresTools: true,
          toolRequests: [{
            id: 'lead.capture:partial',
            tool: 'lead.capture',
            args: { contact: { preferredContact: 'message' } },
            rationale: 'preserve the phone until the buyer supplies a name',
            required: true
          }],
          grounding: {
            taskType: 'lead_handoff',
            sourcePolicy: 'specialist_required',
            webPurpose: 'none',
            webRequirement: 'none',
            requiredToolKinds: ['lead.capture'],
            technicalAttributes: [],
            rationale: 'continue the already exhausted technical handoff'
          },
          productMentions: [],
          selectionPolicy: currentNoProductSelectionPolicy(),
          leadCaptureAuthorization: {
            authorized: true,
            contactSource: 'current_message',
            handoffKind: 'technical_followup',
            handoffOfferMessageId: '55555555-5555-4555-8555-555555555555',
            purpose: 'verify generator start method',
            buyerQuestion: originalQuestion,
            evidence: phoneReply,
            pendingDraftId: null
          },
          policyRuleIds: [],
          mustNotAskQuestionIds: [],
          riskFlags: ['lead']
        };
      },
      async composeAnswer() {
        return {
          answerText: 'I have the phone number. Please write your name; I will return the result by message.',
          factsUsed: [],
          questionsAsked: [],
          toolResultIds: ['lead.capture:partial'],
          leadAction: 'offer_form',
          riskFlags: []
        };
      }
    });
    const orchestrator = new AgentManagerOrchestrator(
      conversations as never,
      new FakeProducts() as never,
      leads as never,
      leadModel
    );

    const payload = await orchestrator.generateAnswer({ sessionId, turnId, userMessage: phoneReply });

    expect(payload.leadCreated).toBe(false);
    expect(payload.leadRequested).toBe(true);
    expect(leads.created).toHaveLength(0);
    expect(leads.draftInputs).toHaveLength(1);
    expect(leads.pendingDraft).toMatchObject({
      buyerQuestion: originalQuestion,
      purpose: 'verify generator start method',
      phone: '+7 900 000-00-11',
      preferredContact: 'message',
      status: 'pending'
    });
    const toolPayload = (payload.metadata as {
      toolResults?: Array<{ payload?: Record<string, unknown> }>;
    }).toolResults?.[0]?.payload;
    expect(toolPayload).toMatchObject({
      draftSaved: true,
      contactStored: true,
      originalQuestionPreserved: true
    });
    expect(toolPayload).not.toHaveProperty('contact');
  });

  it('combines a verbatim name with the same-session draft and confirms only after atomic outbox creation', async () => {
    const conversations = new FakeConversations();
    const leads = new FakeLeads();
    const originalQuestion = 'Please verify whether Firman RD3910E has electric start.';
    const nameReply = 'Алексей, лучше напишите';
    await leads.upsertLeadCaptureDraft({
      sessionId,
      originTurnId: '66666666-6666-4666-8666-666666666666',
      originToolRequestId: 'lead.capture:partial',
      purpose: 'verify generator start method',
      buyerQuestion: originalQuestion,
      phone: '+7 900 000-00-11',
      consentEvidenceHash: 'a'.repeat(64),
      scopeHash: technicalHandoffScopeHash('verify generator start method', originalQuestion)
    });
    const draftId = leads.pendingDraft!.id;
    conversations.messages = [
      ...exhaustedTechnicalHandoffHistory(originalQuestion),
      { ...message('+7 900 000-00-11, please message me'), id: '66666666-6666-4666-8666-666666666661' },
      { ...message('I have the phone number. Please write your name.', 'assistant'), id: '55555555-5555-4555-8555-555555555555' },
      message(nameReply)
    ];
    const leadModel = model({
      async planTurn(input) {
        expect(input.pendingLeadCaptureDraft).toMatchObject({
          id: draftId,
          buyerQuestion: originalQuestion,
          hasPhone: true,
          missingFields: ['name']
        });
        expect(input.pendingLeadCaptureDraft).not.toHaveProperty('phone');
        expect(input.pendingExhaustedTechnicalHandoffs).toEqual([
          expect.objectContaining({
            handoffOfferMessageId: '55555555-5555-4555-8555-555555555555',
            buyerQuestion: originalQuestion,
            technicalAttributes: ['technical fact'],
            sourceAttemptTiers: ['catalog', 'official_page', 'official_manual', 'reliable_secondary']
          })
        ]);
        return {
          userMessageSummary: 'buyer supplied the missing name and chose a message',
          dialogueUnderstanding: 'this completes the same pending specialist handoff',
          nextStepRationale: 'atomically create the lead and outbox from the draft',
          requiresTools: true,
          toolRequests: [{
            id: 'lead.capture:complete',
            tool: 'lead.capture',
            args: { contact: { name: 'Алексей', preferredContact: 'message' } },
            rationale: 'complete the same pending contact',
            required: true
          }],
          grounding: {
            taskType: 'lead_handoff',
            sourcePolicy: 'specialist_required',
            webPurpose: 'none',
            webRequirement: 'none',
            requiredToolKinds: ['lead.capture'],
            technicalAttributes: [],
            buyerQuestion: originalQuestion,
            rationale: 'continue the already exhausted technical handoff'
          },
          productMentions: [],
          selectionPolicy: currentNoProductSelectionPolicy(),
          leadCaptureAuthorization: {
            authorized: true,
            contactSource: 'pending_draft',
            handoffKind: 'technical_followup',
            handoffOfferMessageId: '55555555-5555-4555-8555-555555555555',
            purpose: 'verify generator start method',
            buyerQuestion: originalQuestion,
            evidence: nameReply,
            pendingDraftId: draftId
          },
          policyRuleIds: [],
          mustNotAskQuestionIds: [],
          riskFlags: ['lead']
        };
      },
      async composeAnswer() {
        return {
          answerText: 'Спасибо, Алексей. Запрос передан; результат пришлём сообщением.',
          factsUsed: [],
          questionsAsked: [],
          toolResultIds: ['lead.capture:complete'],
          leadAction: 'confirm_contact_received',
          riskFlags: []
        };
      }
    });
    const orchestrator = new AgentManagerOrchestrator(
      conversations as never,
      new FakeProducts() as never,
      leads as never,
      leadModel
    );

    const payload = await orchestrator.generateAnswer({ sessionId, turnId, userMessage: nameReply });

    expect(payload.leadCreated).toBe(true);
    expect(payload.answer).toContain('Запрос передан');
    expect(leads.completionInputs).toEqual([expect.objectContaining({
      draftId,
      name: 'Алексей',
      preferredContact: 'message'
    })]);
    expect(leads.created).toContainEqual(expect.objectContaining({
      name: 'Алексей',
      phone: '+7 900 000-00-11',
      question: originalQuestion
    }));
    expect((payload.metadata as {
      toolResults?: Array<{ payload?: Record<string, unknown> }>;
    }).toolResults?.[0]?.payload).toMatchObject({
      outbox: true,
      outboxId: 'outbox-draft',
      status: 'queued',
      dispatchStatus: 'pending',
      preferredContact: 'message',
      originalQuestionPreserved: true
    });
  });

  it('does not trust a planner-supplied name that is absent from current authorization evidence', async () => {
    const conversations = new FakeConversations();
    const leads = new FakeLeads();
    const originalQuestion = 'Please verify whether Firman RD3910E has electric start.';
    const preferenceOnlyReply = 'Лучше напишите';
    await leads.upsertLeadCaptureDraft({
      sessionId,
      originTurnId: '66666666-6666-4666-8666-666666666666',
      originToolRequestId: 'lead.capture:partial',
      purpose: 'verify generator start method',
      buyerQuestion: originalQuestion,
      phone: '+7 900 000-00-11',
      consentEvidenceHash: 'a'.repeat(64),
      scopeHash: technicalHandoffScopeHash('verify generator start method', originalQuestion)
    });
    const draftId = leads.pendingDraft!.id;
    conversations.messages = [
      ...exhaustedTechnicalHandoffHistory(originalQuestion),
      { ...message('+7 900 000-00-11'), id: '66666666-6666-4666-8666-666666666662' },
      { ...message('I have the phone number. Please write your name.', 'assistant'), id: '55555555-5555-4555-8555-555555555556' },
      message(preferenceOnlyReply)
    ];
    const unsafeNameModel = model({
      async planTurn() {
        return {
          userMessageSummary: 'buyer chose message but did not provide a name',
          dialogueUnderstanding: 'the pending handoff still lacks a name',
          nextStepRationale: 'do not invent identity',
          requiresTools: true,
          toolRequests: [{
            id: 'lead.capture:forged-name',
            tool: 'lead.capture',
            args: { contact: { name: 'Алексей', preferredContact: 'message' } },
            rationale: 'unsafe planner output under test',
            required: true
          }],
          grounding: {
            taskType: 'lead_handoff',
            sourcePolicy: 'specialist_required',
            webPurpose: 'none',
            webRequirement: 'none',
            requiredToolKinds: ['lead.capture'],
            technicalAttributes: [],
            buyerQuestion: originalQuestion,
            rationale: 'continue the already exhausted technical handoff without inventing identity'
          },
          productMentions: [],
          selectionPolicy: currentNoProductSelectionPolicy(),
          leadCaptureAuthorization: {
            authorized: true,
            contactSource: 'pending_draft',
            handoffKind: 'technical_followup',
            handoffOfferMessageId: '55555555-5555-4555-8555-555555555555',
            purpose: 'verify generator start method',
            buyerQuestion: originalQuestion,
            evidence: preferenceOnlyReply,
            pendingDraftId: draftId
          },
          policyRuleIds: [],
          mustNotAskQuestionIds: [],
          riskFlags: ['lead']
        };
      },
      async composeAnswer() {
        return {
          answerText: 'Контакт получен, запрос передан.',
          factsUsed: [],
          questionsAsked: [],
          toolResultIds: ['lead.capture:forged-name'],
          leadAction: 'confirm_contact_received',
          riskFlags: []
        };
      }
    });
    const orchestrator = new AgentManagerOrchestrator(
      conversations as never,
      new FakeProducts() as never,
      leads as never,
      unsafeNameModel
    );

    const payload = await orchestrator.generateAnswer({
      sessionId,
      turnId,
      userMessage: preferenceOnlyReply
    });

    expect(payload.leadCreated).toBe(false);
    expect(payload.answer).not.toContain('запрос передан');
    expect(leads.completionInputs).toHaveLength(0);
    expect(leads.pendingDraft).not.toBeNull();
  });

  it('captures a provided contact through lead outbox before confirming receipt', async () => {
    const conversations = new FakeConversations();
    const leads = new FakeLeads();
    const leadModel = model({
      async planTurn() {
        return {
          userMessageSummary: 'buyer left contact',
          dialogueUnderstanding: 'buyer wants delivery and availability checked',
          nextStepRationale: 'capture contact',
          requiresTools: true,
          toolRequests: [{
            id: 'lead.capture:test',
            tool: 'lead.capture',
            args: {},
            rationale: 'buyer provided name and phone',
            required: true
          }],
          grounding: {
            taskType: 'lead_handoff',
            sourcePolicy: 'conversation_only',
            webPurpose: 'none',
            webRequirement: 'none',
            requiredToolKinds: ['lead.capture'],
            technicalAttributes: [],
            buyerQuestion: 'Please check delivery and availability.',
            rationale: 'capture contact for the explicit commercial availability and delivery follow-up'
          },
          productMentions: [],
          selectionPolicy: {
            targetProductClass: null,
            canonicalProductClass: null,
            needAction: 'continue',
            alternativePolicy: 'unknown',
            reusePreviousCards: false,
            maxCards: 0,
            powerSource: null,
            phase: null,
            requirements: [],
            rationale: 'commercial handoff, no product selection'
          },
          leadCaptureAuthorization: {
            authorized: true,
            contactSource: 'current_message',
            handoffKind: 'commercial_followup',
            purpose: 'check delivery and availability',
            buyerQuestion: 'Please check delivery and availability.',
            evidence: 'Alexey, +7 900 000-00-11',
            pendingDraftId: null
          },
          policyRuleIds: [],
          mustNotAskQuestionIds: [],
          riskFlags: ['lead']
        };
      },
      async composeAnswer() {
        return {
          answerText: 'Contact received. We will check availability and delivery on the selected items and return with a precise answer.',
          factsUsed: [],
          questionsAsked: [],
          toolResultIds: ['lead.capture:test'],
          leadAction: 'confirm_contact_received',
          riskFlags: []
        };
      }
    });
    conversations.messages = [
      message('Please check delivery and availability.'),
      message('Please leave your contact so we can return the exact result.', 'assistant'),
      message('Alexey, +7 900 000-00-11')
    ];
    const orchestrator = new AgentManagerOrchestrator(conversations as never, new FakeProducts() as never, leads as never, leadModel);

    const payload = await orchestrator.generateAnswer({
      sessionId,
      turnId,
      userMessage: 'Alexey, +7 900 000-00-11'
    });

    expect(payload.answer).toContain('Contact received');
    expect(leads.created).toHaveLength(1);
    expect(conversations.outbox).toHaveLength(1);
    expect(payload.leadCreated).toBe(true);
  });

  it('denies lead capture when buyerQuestion itself contains contact PII', async () => {
    const conversations = new FakeConversations();
    const leads = new FakeLeads();
    const unsafeBuyerQuestion = 'Alexey, +7 900 000-00-11';
    conversations.messages = [message(unsafeBuyerQuestion)];
    const leadModel = model({
      async planTurn() {
        return {
          userMessageSummary: 'buyer supplied contact without a separate business question',
          dialogueUnderstanding: 'unsafe authorization under test',
          nextStepRationale: 'runtime must reject contact PII as the lead subject',
          requiresTools: true,
          toolRequests: [{
            id: 'lead.capture:pii-question',
            tool: 'lead.capture',
            args: {},
            rationale: 'unsafe lead subject',
            required: true
          }],
          grounding: {
            taskType: 'lead_handoff',
            sourcePolicy: 'conversation_only',
            webPurpose: 'none',
            webRequirement: 'none',
            requiredToolKinds: ['lead.capture'],
            technicalAttributes: [],
            buyerQuestion: unsafeBuyerQuestion,
            rationale: 'exercise commercial lead validation without treating contact PII as the business question'
          },
          productMentions: [],
          selectionPolicy: currentNoProductSelectionPolicy(),
          leadCaptureAuthorization: {
            authorized: true,
            contactSource: 'current_message',
            handoffKind: 'commercial_followup',
            purpose: 'unspecified commercial follow-up',
            buyerQuestion: unsafeBuyerQuestion,
            evidence: unsafeBuyerQuestion,
            pendingDraftId: null
          },
          policyRuleIds: [],
          mustNotAskQuestionIds: [],
          riskFlags: ['lead']
        };
      },
      async composeAnswer() {
        return {
          answerText: 'Уточните, пожалуйста, какой именно вопрос нужно проверить.',
          factsUsed: [],
          questionsAsked: [],
          toolResultIds: ['lead.capture:pii-question'],
          leadAction: 'none',
          riskFlags: []
        };
      }
    });
    const orchestrator = new AgentManagerOrchestrator(
      conversations as never,
      new FakeProducts() as never,
      leads as never,
      leadModel
    );

    const payload = await orchestrator.generateAnswer({
      sessionId,
      turnId,
      userMessage: unsafeBuyerQuestion
    });

    expect(leads.created).toHaveLength(0);
    expect((payload.metadata as { toolResults?: Array<{ status?: string }> }).toolResults?.[0]?.status).toBe('denied');
    expect(payload.leadCreated).toBe(false);
  });

  it('denies structured lead capture when current intent does not authorize a handoff', async () => {
    const conversations = new FakeConversations();
    const leads = new FakeLeads();
    const leadModel = model({
      async planTurn() {
        return {
          userMessageSummary: 'buyer mentioned a phone while asking a technical question',
          dialogueUnderstanding: 'the phone mention is not consent to create a lead',
          nextStepRationale: 'answer without a side effect',
          requiresTools: true,
          toolRequests: [{
            id: 'lead.capture:not-authorized',
            tool: 'lead.capture',
            args: { contact: { name: 'Invented', phone: '+70000000000' } },
            rationale: 'planner output is intentionally unsafe for the regression test',
            required: true
          }],
          grounding: {
            taskType: 'lead_handoff',
            sourcePolicy: 'conversation_only',
            webPurpose: 'none',
            webRequirement: 'none',
            requiredToolKinds: ['lead.capture'],
            technicalAttributes: [],
            buyerQuestion: 'А почему генератор глохнет?',
            rationale: 'exercise the lead authorization boundary for an explicitly unauthorized side effect'
          },
          productMentions: [],
          selectionPolicy: {
            targetProductClass: null,
            canonicalProductClass: null,
            needAction: 'continue',
            alternativePolicy: 'unknown',
            reusePreviousCards: false,
            maxCards: 0,
            powerSource: null,
            phase: null,
            requirements: [],
            rationale: 'technical conversation only'
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
      },
      async composeAnswer() {
        return {
          answerText: 'Продолжу консультацию здесь; заявку без вашего запроса не создаю.',
          factsUsed: [],
          questionsAsked: [],
          toolResultIds: [],
          selectedProductIds: [],
          leadAction: 'none',
          riskFlags: []
        };
      }
    });
    const orchestrator = new AgentManagerOrchestrator(
      conversations as never,
      new FakeProducts() as never,
      leads as never,
      leadModel
    );

    const payload = await orchestrator.generateAnswer({
      sessionId,
      turnId,
      userMessage: 'Телефон на объекте +7 900 000-00-11. А почему генератор глохнет?'
    });

    expect(leads.created).toHaveLength(0);
    expect(conversations.outbox).toHaveLength(0);
    expect((payload.metadata as { toolResults?: Array<{ status?: string }> }).toolResults?.[0]?.status).toBe('denied');
    expect(payload.leadCreated).toBe(false);
  });

  it('denies legacy lead tool arguments when structured current-intent authorization is absent', async () => {
    const conversations = new FakeConversations();
    const leads = new FakeLeads();
    const unsafeLegacyModel = model({
      async planTurn() {
        return {
          userMessageSummary: 'buyer asks about a product code',
          dialogueUnderstanding: 'digits are a product identifier, not permission to create a lead',
          nextStepRationale: 'answer without side effects',
          requiresTools: true,
          toolRequests: [{
            id: 'lead.capture:legacy',
            tool: 'lead.capture',
            args: { contact: { name: 'Invented', phone: '1234567890' } },
            rationale: 'unsafe legacy payload',
            required: true
          }],
          grounding: {
            taskType: 'lead_handoff',
            sourcePolicy: 'conversation_only',
            webPurpose: 'none',
            webRequirement: 'none',
            requiredToolKinds: ['lead.capture'],
            technicalAttributes: [],
            buyerQuestion: 'Нужен насос 1234567890',
            rationale: 'exercise legacy lead-payload rejection without treating a product code as consent'
          },
          mustNotAskQuestionIds: [],
          riskFlags: []
        };
      },
      async composeAnswer() {
        return {
          answerText: 'РџСЂРѕРІРµСЂСЋ Р°СЂС‚РёРєСѓР» РєР°Рє РѕР±РѕР·РЅР°С‡РµРЅРёРµ С‚РѕРІР°СЂР°; Р·Р°СЏРІРєСѓ РЅРµ СЃРѕР·РґР°СЋ.',
          factsUsed: [],
          questionsAsked: [],
          toolResultIds: [],
          selectedProductIds: [],
          leadAction: 'none',
          riskFlags: []
        };
      }
    });
    const orchestrator = new AgentManagerOrchestrator(
      conversations as never,
      new FakeProducts() as never,
      leads as never,
      unsafeLegacyModel
    );

    const payload = await orchestrator.generateAnswer({
      sessionId,
      turnId,
      userMessage: 'РќСѓР¶РµРЅ РЅР°СЃРѕСЃ 1234567890'
    });

    expect(leads.created).toHaveLength(0);
    expect(conversations.outbox).toHaveLength(0);
    expect((payload.metadata as { toolResults?: Array<{ status?: string }> }).toolResults?.[0]?.status).toBe('denied');
  });

  it('rejects duplicate model tool request ids before any tool side effect executes', async () => {
    const conversations = new FakeConversations();
    const duplicateModel = model({
      async planTurn() {
        const request = {
          id: 'duplicate-id',
          tool: 'catalog.search' as const,
          args: { query: 'generator' },
          rationale: 'search',
          required: true
        };
        return {
          userMessageSummary: 'find a generator',
          dialogueUnderstanding: 'catalog lookup',
          nextStepRationale: 'search once',
          requiresTools: true,
          toolRequests: [request, { ...request }],
          mustNotAskQuestionIds: [],
          riskFlags: []
        };
      }
    });
    const orchestrator = new AgentManagerOrchestrator(
      conversations as never,
      new FakeProducts() as never,
      new FakeLeads() as never,
      duplicateModel
    );

    await expect(orchestrator.generateAnswer({
      sessionId,
      turnId,
      userMessage: 'РџРѕРґР±РµСЂРёС‚Рµ РіРµРЅРµСЂР°С‚РѕСЂ'
    })).rejects.toThrow('duplicate_tool_request_id:duplicate-id');
    expect(conversations.outbox).toHaveLength(0);
  });

  it('upgrades a legacy saved intent and recomputes its stale saved answer and review', async () => {
    const conversations = new FakeConversations();
    conversations.checkpoints = [
      {
        checkpoint: 'ledger_delta_proposed',
        status: 'succeeded',
        payload: { rationale: 'saved legacy recovery delta', events: [] }
      },
      {
        checkpoint: 'intent_contract_created',
        status: 'succeeded',
        payload: {
          userMessageSummary: 'legacy summary',
          dialogueUnderstanding: 'legacy contract without structured selection policy',
          nextStepRationale: 'legacy next step',
          requiresTools: false,
          toolRequests: [],
          mustNotAskQuestionIds: [],
          riskFlags: []
        }
      },
      {
        checkpoint: 'answer_contract_created',
        status: 'succeeded',
        payload: {
          answerText: 'Stale legacy answer must never be reused.',
          factsUsed: [],
          questionsAsked: [],
          toolResultIds: [],
          leadAction: 'none',
          riskFlags: []
        }
      },
      {
        checkpoint: 'review_completed',
        status: 'succeeded',
        payload: {
          verdict: 'block',
          issues: [{
            code: 'legacy_saved_block',
            severity: 'high',
            message: 'This stale review must be ignored after intent upgrade.'
          }]
        }
      }
    ];
    const planTurn = vi.fn(async (): Promise<AgentIntentContract> => ({
      userMessageSummary: 'current recovered summary',
      dialogueUnderstanding: 'the recovery path now uses the structured planner contract',
      nextStepRationale: 'compose a fresh safe answer',
      requiresTools: false,
      toolRequests: [],
      selectionPolicy: currentNoProductSelectionPolicy(),
      mustNotAskQuestionIds: [],
      riskFlags: []
    }));
    const composeAnswer = vi.fn(async () => ({
      answerText: 'Fresh answer from the upgraded intent contract.',
      factsUsed: [],
      questionsAsked: [],
      toolResultIds: [],
      selectedProductIds: [],
      leadAction: 'none' as const,
      riskFlags: []
    }));
    const orchestrator = new AgentManagerOrchestrator(
      conversations as never,
      new FakeProducts() as never,
      new FakeLeads() as never,
      model({ planTurn, composeAnswer })
    );

    const payload = await orchestrator.recoverTurn({ sessionId, turnId });

    expect(payload.answer).toBe('Fresh answer from the upgraded intent contract.');
    expect(payload.answer).not.toContain('Stale legacy answer');
    expect(planTurn).toHaveBeenCalledTimes(1);
    expect(composeAnswer).toHaveBeenCalledTimes(1);
    expect(conversations.checkpoints).toContainEqual(expect.objectContaining({
      checkpoint: 'intent_contract_created',
      payload: expect.objectContaining({ selectionPolicy: currentNoProductSelectionPolicy() })
    }));
    expect(conversations.traces).toContainEqual(expect.objectContaining({
      phase: 'recovery',
      eventType: 'legacy_intent_contract_upgraded'
    }));
  });

  it('replans recovery when a saved universal tool-args contract fails the current strict schema', async () => {
    const conversations = new FakeConversations();
    conversations.checkpoints = [{
      checkpoint: 'ledger_delta_proposed',
      status: 'succeeded',
      payload: { rationale: 'saved recovery delta', events: [] }
    }, {
      checkpoint: 'intent_contract_created',
      status: 'succeeded',
      payload: {
        userMessageSummary: 'old catalog request',
        dialogueUnderstanding: 'persisted before discriminated tool args',
        nextStepRationale: 'old catalog lookup',
        requiresTools: true,
        toolRequests: [{
          id: 'legacy-catalog-search',
          tool: 'catalog.search',
          args: {
            query: 'generator',
            limit: 4,
            productNames: [],
            loads: [],
            contact: null
          },
          rationale: 'old universal args fixture',
          required: true
        }],
        selectionPolicy: currentNoProductSelectionPolicy(),
        mustNotAskQuestionIds: [],
        riskFlags: []
      }
    }];
    const planTurn = vi.fn(async () => ({
      userMessageSummary: 'strict recovery plan',
      dialogueUnderstanding: 'the current buyer turn needs no tool',
      nextStepRationale: 'answer safely after replacing the stale contract',
      requiresTools: false,
      toolRequests: [],
      selectionPolicy: currentNoProductSelectionPolicy(),
      mustNotAskQuestionIds: [],
      riskFlags: []
    }));
    const composeAnswer = vi.fn(async () => ({
      answerText: 'Recovered with a current strict intent contract.',
      factsUsed: [],
      questionsAsked: [],
      toolResultIds: [],
      selectedProductIds: [],
      leadAction: 'none' as const,
      riskFlags: []
    }));
    const orchestrator = new AgentManagerOrchestrator(
      conversations as never,
      new FakeProducts() as never,
      new FakeLeads() as never,
      model({ planTurn, composeAnswer })
    );

    const payload = await orchestrator.recoverTurn({ sessionId, turnId });

    expect(payload.answer).toBe('Recovered with a current strict intent contract.');
    expect(planTurn).toHaveBeenCalledTimes(1);
    expect(conversations.traces).toContainEqual(expect.objectContaining({
      eventType: 'legacy_intent_contract_upgraded',
      payload: expect.objectContaining({ reason: 'saved_intent_failed_current_strict_schema' })
    }));
  });

  it('does not reuse a stale tool artifact with the same id after recovery replans the intent', async () => {
    const conversations = new FakeConversations();
    conversations.checkpoints = [{
      checkpoint: 'ledger_delta_proposed',
      status: 'succeeded',
      payload: { rationale: 'saved recovery delta', events: [] }
    }, {
      checkpoint: 'intent_contract_created',
      status: 'succeeded',
      payload: {
        userMessageSummary: 'legacy generator calculation',
        dialogueUnderstanding: 'legacy contract without a selection policy',
        nextStepRationale: 'calculate an old load',
        requiresTools: true,
        toolRequests: [],
        mustNotAskQuestionIds: [],
        riskFlags: []
      }
    }];
    conversations.toolArtifacts = [{
      tool_name: 'calculator.generatorLoad',
      tool_request_id: 'load-calculation',
      status: 'ok',
      payload: {
        loads: [{ name: 'old 0.5 kW load', runningKw: 0.5, startingKw: 0.5 }],
        profile: { requiredNominalKw: 1 }
      },
      warnings: []
    }];
    const planTurn = vi.fn(async (): Promise<AgentIntentContract> => ({
      userMessageSummary: 'calculate the current 4 kW load',
      dialogueUnderstanding: 'the current turn supersedes the stale calculator request',
      nextStepRationale: 'run a fresh typed calculation',
      requiresTools: true,
      toolRequests: [{
        id: 'load-calculation',
        tool: 'calculator.generatorLoad' as const,
        args: {
          loads: [{
            kind: 'coffee_machine',
            name: 'current 4 kW load',
            count: 1,
            runningKw: 4,
            startingKw: 4,
            source: 'explicit_user',
            evidence: 'current load is 4 kW',
            basisKind: 'exact_power',
            basisSignals: ['explicit_power']
          }],
          simultaneousStarting: false,
          simultaneousStartingKinds: [],
          estimateBasis: 'exact_or_user_provided'
        },
        rationale: 'calculate the current load rather than reuse the old profile',
        required: true,
        coversRequirementIds: []
      }],
      selectionPolicy: currentNoProductSelectionPolicy(),
      mustNotAskQuestionIds: [],
      riskFlags: []
    }));
    const composeAnswer = vi.fn(async (input: Parameters<AgentManagerModel['composeAnswer']>[0]) => {
      const payload = input.toolResults[0]?.payload as {
        loads?: Array<{ name?: string; runningKw?: number }>;
        profile?: { requiredNominalKw?: number };
      };
      expect(payload.loads?.[0]).toMatchObject({ name: 'current 4 kW load', runningKw: 4 });
      expect(payload.profile?.requiredNominalKw).toBeGreaterThan(1);
      return {
        answerText: `Fresh calculated minimum: ${payload.profile?.requiredNominalKw} kW.`,
        factsUsed: [],
        questionsAsked: [],
        toolResultIds: ['load-calculation'],
        leadAction: 'none' as const,
        riskFlags: []
      };
    });
    const orchestrator = new AgentManagerOrchestrator(
      conversations as never,
      new FakeProducts() as never,
      new FakeLeads() as never,
      model({ planTurn, composeAnswer })
    );

    const payload = await orchestrator.recoverTurn({ sessionId, turnId });

    expect(payload.answer).toContain('Fresh calculated minimum');
    expect(planTurn).toHaveBeenCalledTimes(1);
    expect(composeAnswer).toHaveBeenCalledTimes(1);
    expect(conversations.traces).toContainEqual(expect.objectContaining({
      phase: 'recovery',
      eventType: 'stale_tool_artifacts_ignored_after_replan',
      payload: expect.objectContaining({ requestIds: ['load-calculation'] })
    }));
    expect(conversations.traces).not.toContainEqual(expect.objectContaining({
      phase: 'recovery',
      eventType: 'tool_artifact_reused',
      payload: expect.objectContaining({ requestId: 'load-calculation' })
    }));
  });

  it('uses an existing session lead instead of asking for contact again after a form submission', async () => {
    const conversations = new FakeConversations();
    const leads = new class extends FakeLeads {
      async latestLeadForSession() {
        return {
          id: 'existing-lead-id',
          sessionId,
          name: 'Nikolay',
          phone: '+7 900 000-00-22',
          status: 'sent_email',
          createdAt: new Date().toISOString()
        };
      }
    }();
    const leadModel = model({
      async planTurn() {
        return {
          userMessageSummary: 'buyer asks to check delivery after submitting the form',
          dialogueUnderstanding: 'contact is already captured in this session',
          nextStepRationale: 'reuse the saved lead and continue the handoff',
          requiresTools: true,
          toolRequests: [{
            id: 'lead.capture:existing',
            tool: 'lead.capture',
            args: {},
            rationale: 'delivery check needs a saved contact',
            required: true
          }],
          grounding: {
            taskType: 'lead_handoff',
            sourcePolicy: 'conversation_only',
            webPurpose: 'none',
            webRequirement: 'none',
            requiredToolKinds: ['lead.capture'],
            technicalAttributes: [],
            buyerQuestion: 'Can you check delivery to Crimea?',
            rationale: 'continue an explicit commercial delivery follow-up with the existing session contact'
          },
          productMentions: [],
          selectionPolicy: {
            targetProductClass: null,
            canonicalProductClass: null,
            needAction: 'continue',
            alternativePolicy: 'unknown',
            reusePreviousCards: false,
            maxCards: 0,
            powerSource: null,
            phase: null,
            requirements: [],
            rationale: 'commercial handoff, no product selection'
          },
          leadCaptureAuthorization: {
            authorized: true,
            contactSource: 'existing_session',
            handoffKind: 'commercial_followup',
            purpose: 'check delivery to Crimea',
            buyerQuestion: 'Can you check delivery to Crimea?',
            evidence: 'Can you check delivery to Crimea?',
            pendingDraftId: null
          },
          policyRuleIds: [],
          mustNotAskQuestionIds: [],
          riskFlags: ['lead']
        };
      },
      async composeAnswer() {
        return {
          answerText: 'Contact is already saved for this chat. I will pass the delivery question to the manager.',
          factsUsed: [],
          questionsAsked: [],
          toolResultIds: ['lead.capture:existing'],
          leadAction: 'confirm_contact_received',
          riskFlags: []
        };
      }
    });
    conversations.messages = [message('Can you check delivery to Crimea?')];
    const orchestrator = new AgentManagerOrchestrator(conversations as never, new FakeProducts() as never, leads as never, leadModel);

    const payload = await orchestrator.generateAnswer({
      sessionId,
      turnId,
      userMessage: 'Can you check delivery to Crimea?'
    });

    expect(payload.answer).toContain('already saved');
    expect(leads.created).toHaveLength(1);
    expect(conversations.outbox).toHaveLength(1);
    expect(payload.leadCreated).toBe(true);
    expect((payload.metadata as { toolResults?: Array<{ payload?: Record<string, unknown> }> }).toolResults?.[0]?.payload).toMatchObject({
      leadId: 'lead-id',
      outbox: true,
      status: 'queued'
    });
  });

  it('recovers from the saved user message without adding a duplicate user message', async () => {
    const conversations = new FakeConversations();
    const orchestrator = new AgentManagerOrchestrator(conversations as never, new FakeProducts() as never, new FakeLeads() as never, model());

    const payload = await orchestrator.recoverTurn({ sessionId, turnId });

    expect(payload.metadata?.recovered).toBe(true);
    expect(conversations.addMessage).not.toHaveBeenCalled();
    expect(conversations.assistantSaves[0]).toMatchObject({ recovered: true });
  });

  it('allows only one semantic recovery execution for an unfinished turn', async () => {
    const conversations = new FakeConversations();
    const proposeLedgerDelta = vi.fn(async () => {
      throw new Error('forced recovery failure');
    });
    const orchestrator = new AgentManagerOrchestrator(
      conversations as never,
      new FakeProducts() as never,
      new FakeLeads() as never,
      model({ proposeLedgerDelta })
    );

    await expect(orchestrator.recoverTurn({ sessionId, turnId })).rejects.toThrow('forced recovery failure');
    await expect(orchestrator.recoverTurn({ sessionId, turnId })).rejects.toThrow('recovery_attempt_unavailable');

    expect(proposeLedgerDelta).toHaveBeenCalledTimes(1);
    expect(conversations.turn.recoveryAttempts).toBe(1);
  });

  it('reuses persisted model checkpoints instead of repeating completed model work', async () => {
    const conversations = new FakeConversations();
    conversations.checkpoints = [
      {
        checkpoint: 'ledger_delta_proposed',
        status: 'succeeded',
        payload: {
          rationale: 'saved state extraction',
          events: [{
            eventType: 'fact.confirmed',
            scope: 'dialogue',
            payload: { factKey: 'load.coffee_machine_kw', value: 3.2 },
            evidence: 'Coffee machine 3.2 kW',
            source: 'llm_state_delta',
            status: 'active'
          }]
        }
      },
      {
        checkpoint: 'intent_contract_created',
        status: 'succeeded',
        payload: {
          userMessageSummary: 'saved summary',
          dialogueUnderstanding: 'saved understanding',
          nextStepRationale: 'answer from the saved state',
          requiresTools: false,
          toolRequests: [],
          selectionPolicy: currentNoProductSelectionPolicy(),
          mustNotAskQuestionIds: [],
          riskFlags: []
        }
      },
      {
        checkpoint: 'answer_contract_created',
        status: 'succeeded',
        payload: {
          answerText: 'Ответ собран из сохранённых checkpoint.',
          factsUsed: [],
          questionsAsked: [],
          toolResultIds: [],
          leadAction: 'none',
          riskFlags: []
        }
      },
      {
        checkpoint: 'review_completed',
        status: 'succeeded',
        payload: { verdict: 'pass', issues: [] }
      }
    ];
    const proposeLedgerDelta = vi.fn(async () => { throw new Error('must reuse saved delta'); });
    const planTurn = vi.fn(async () => { throw new Error('must reuse saved intent'); });
    const composeAnswer = vi.fn(async () => { throw new Error('must reuse saved answer'); });
    const reviewAnswer = vi.fn(async () => { throw new Error('must reuse saved review'); });
    const orchestrator = new AgentManagerOrchestrator(
      conversations as never,
      new FakeProducts() as never,
      new FakeLeads() as never,
      model({ proposeLedgerDelta, planTurn, composeAnswer, reviewAnswer })
    );

    const payload = await orchestrator.recoverTurn({ sessionId, turnId });

    expect(payload.answer).toBe('Ответ собран из сохранённых checkpoint.');
    expect(proposeLedgerDelta).not.toHaveBeenCalled();
    expect(planTurn).not.toHaveBeenCalled();
    expect(composeAnswer).not.toHaveBeenCalled();
    expect(reviewAnswer).not.toHaveBeenCalled();
  });

  it('invalidates a blocked answer checkpoint and recomposes once with structured review feedback', async () => {
    const conversations = new FakeConversations();
    const proposeLedgerDelta = vi.fn(async (): Promise<LedgerStateDelta> => ({
      rationale: 'the current request is already explicit',
      events: []
    }));
    const planTurn = vi.fn(async (): Promise<AgentIntentContract> => ({
      userMessageSummary: 'calculate the generator load and give a useful result',
      dialogueUnderstanding: 'the buyer expects an answer, not another unnecessary retry request',
      nextStepRationale: 'reuse the verified calculation when repairing a rejected draft',
      requiresTools: true,
      toolRequests: [{
        id: 'load-calculation',
        tool: 'calculator.generatorLoad',
        args: {
          loads: [{
            name: 'borehole pump and angle grinder',
            count: 1,
            runningKw: 2.6,
            startingKw: 5.2,
            source: 'explicit_user',
            evidence: '1.1 kW pump and 1.5 kW grinder can run simultaneously',
            basisKind: 'exact_power',
            basisSignals: ['explicit_power', 'simultaneous_operation_known']
          }],
          simultaneousStarting: false,
          simultaneousStartingKinds: [],
          estimateBasis: 'exact_or_user_provided'
        },
        rationale: 'calculate the minimum once and persist the typed result',
        required: true,
        coversRequirementIds: []
      }],
      selectionPolicy: currentNoProductSelectionPolicy(),
      mustNotAskQuestionIds: [],
      riskFlags: []
    }));
    let composeAttempt = 0;
    const composeAnswer = vi.fn(async (input: Parameters<AgentManagerModel['composeAnswer']>[0]) => {
      composeAttempt += 1;
      if (composeAttempt === 1) {
        expect(input.repairContext).toBeUndefined();
        return {
          answerText: 'Please repeat the same request later.',
          factsUsed: [],
          questionsAsked: [],
          toolResultIds: ['load-calculation'],
          selectedProductIds: [],
          leadAction: 'none' as const,
          riskFlags: []
        };
      }
      expect(input.repairContext).toEqual({
        priorReviewIssues: [{
          code: 'question_only_instead_of_result',
          severity: 'high',
          message: 'Use the completed calculation and give a useful result.',
          evidence: 'The draft only asks the buyer to repeat the request.'
        }]
      });
      expect(input.toolResults).toHaveLength(1);
      expect(input.toolResults[0]).toMatchObject({
        requestId: 'load-calculation',
        tool: 'calculator.generatorLoad',
        status: 'ok'
      });
      return {
        answerText: 'The completed load calculation is preserved; here is the useful preliminary result.',
        factsUsed: [],
        questionsAsked: [],
        toolResultIds: ['load-calculation'],
        selectedProductIds: [],
        leadAction: 'none' as const,
        riskFlags: []
      };
    });
    let reviewAttempt = 0;
    const reviewAnswer = vi.fn(async () => {
      reviewAttempt += 1;
      return reviewAttempt === 1
        ? {
            verdict: 'block' as const,
            issues: [{
              code: 'question_only_instead_of_result',
              severity: 'high' as const,
              message: 'Use the completed calculation and give a useful result.',
              evidence: 'The draft only asks the buyer to repeat the request.'
            }]
          }
        : { verdict: 'pass' as const, issues: [] };
    });
    const orchestrator = new AgentManagerOrchestrator(
      conversations as never,
      new FakeProducts() as never,
      new FakeLeads() as never,
      model({ proposeLedgerDelta, planTurn, composeAnswer, reviewAnswer })
    );
    const previousReviewMode = config.AI_MANAGER_REVIEW_MODE;
    config.AI_MANAGER_REVIEW_MODE = 'always';
    try {
      await expect(orchestrator.generateAnswer({
        sessionId,
        turnId,
        userMessage: conversations.messages[0]!.content
      })).rejects.toThrow('Agent manager answer blocked: question_only_instead_of_result');

      expect(conversations.checkpoints).toContainEqual(expect.objectContaining({
        checkpoint: 'answer_contract_created',
        status: 'failed',
        errorCode: 'answer_contract_blocked_by_review'
      }));
      expect(conversations.checkpoints).toContainEqual(expect.objectContaining({
        checkpoint: 'review_completed',
        status: 'failed',
        payload: expect.objectContaining({ verdict: 'block' })
      }));
      expect(conversations.answerContracts).toContainEqual(expect.objectContaining({ status: 'rejected' }));
      const persistedToolArtifactCount = conversations.toolArtifacts.length;

      const payload = await orchestrator.recoverTurn({ sessionId, turnId });

      expect(payload.answer).toBe('The completed load calculation is preserved; here is the useful preliminary result.');
      expect(proposeLedgerDelta).toHaveBeenCalledTimes(1);
      expect(planTurn).toHaveBeenCalledTimes(1);
      expect(composeAnswer).toHaveBeenCalledTimes(2);
      expect(reviewAnswer).toHaveBeenCalledTimes(2);
      expect(conversations.toolArtifacts).toHaveLength(persistedToolArtifactCount);
      expect(conversations.traces).toContainEqual(expect.objectContaining({
        phase: 'recovery',
        eventType: 'blocked_answer_checkpoint_invalidated'
      }));
      expect(conversations.traces).toContainEqual(expect.objectContaining({
        phase: 'recovery',
        eventType: 'tool_artifact_reused',
        payload: expect.objectContaining({ requestId: 'load-calculation' })
      }));
    } finally {
      config.AI_MANAGER_REVIEW_MODE = previousReviewMode;
    }
  });

  it('commits one fenced degraded answer when the recovered draft is blocked again', async () => {
    const conversations = new FakeConversations();
    const leads = new FakeLeads();
    const intent = structuredGeneratorCatalogIntent();
    const composeAnswer = vi.fn(async () => ({
      answerText: 'This draft is deliberately rejected by semantic review.',
      factsUsed: [],
      questionsAsked: [],
      toolResultIds: ['catalog-search'],
      selectedProductIds: ['p1'],
      leadAction: 'none' as const,
      riskFlags: [],
      selectionReadiness: {
        productClass: 'generator',
        status: 'ready_for_preliminary_cards' as const,
        canShowProductCards: true,
        missingFacts: [],
        rationale: 'The catalog result is available, but the generated wording did not pass review.'
      }
    }));
    const reviewAnswer = vi.fn(async () => ({
      verdict: 'block' as const,
      issues: [{
        code: 'semantic_answer_rejected',
        severity: 'high' as const,
        message: 'The semantic answer is not safe to send.',
        evidence: 'forced double-review regression'
      }]
    }));
    const orchestrator = new AgentManagerOrchestrator(
      conversations as never,
      new FakeProducts() as never,
      leads as never,
      model({
        async proposeLedgerDelta() {
          return { rationale: 'the request is already represented by the typed catalog intent', events: [] };
        },
        async planTurn() { return intent; },
        composeAnswer,
        reviewAnswer
      })
    );
    const previousReviewMode = config.AI_MANAGER_REVIEW_MODE;
    config.AI_MANAGER_REVIEW_MODE = 'always';
    try {
      await expect(orchestrator.generateAnswer({
        sessionId,
        turnId,
        userMessage: 'Show me a grounded generator option.'
      })).rejects.toThrow('Agent manager answer blocked: semantic_answer_rejected');
      const persistedToolArtifactCount = conversations.toolArtifacts.length;

      const payload = await orchestrator.recoverTurn({ sessionId, turnId });

      expect(payload.answer.length).toBeGreaterThan(40);
      expect(payload.productCards.length).toBeGreaterThan(0);
      expect(payload.metadata).toMatchObject({
        terminal: true,
        degraded: true,
        terminalReason: 'answer_blocked_after_semantic_recovery'
      });
      expect(conversations.turn.status).toBe('recovered');
      expect(conversations.assistantSaves).toHaveLength(1);
      expect(conversations.toolArtifacts).toHaveLength(persistedToolArtifactCount);
      expect(composeAnswer).toHaveBeenCalledTimes(2);
      expect(reviewAnswer).toHaveBeenCalledTimes(2);
      expect(leads.created).toHaveLength(0);
    } finally {
      config.AI_MANAGER_REVIEW_MODE = previousReviewMode;
    }
  });

  it('does not confirm or recreate a legacy saved lead artifact without authorization fingerprint', async () => {
    const conversations = new FakeConversations();
    conversations.checkpoints = [
      {
        checkpoint: 'ledger_delta_proposed',
        status: 'succeeded',
        payload: { rationale: 'saved contact state', events: [] }
      },
      {
        checkpoint: 'intent_contract_created',
        status: 'succeeded',
        payload: {
          userMessageSummary: 'buyer supplied contact',
          dialogueUnderstanding: 'lead was already captured',
          nextStepRationale: 'confirm saved contact',
          requiresTools: true,
          toolRequests: [{
            id: 'lead-request',
            tool: 'lead.capture',
            args: {},
            rationale: 'persist buyer contact once',
            required: true
          }],
          selectionPolicy: currentNoProductSelectionPolicy(),
          mustNotAskQuestionIds: [],
          riskFlags: []
        }
      },
      {
        checkpoint: 'answer_contract_created',
        status: 'succeeded',
        payload: {
          answerText: 'Контакт уже сохранён, повторно отправлять его не нужно.',
          factsUsed: [],
          questionsAsked: [],
          toolResultIds: ['lead-request'],
          leadAction: 'confirm_contact_received',
          riskFlags: []
        }
      },
      {
        checkpoint: 'review_completed',
        status: 'succeeded',
        payload: { verdict: 'pass', issues: [] }
      }
    ];
    conversations.toolArtifacts = [{
      tool_name: 'lead.capture',
      tool_request_id: 'lead-request',
      status: 'ok',
      payload: { leadId: 'lead-existing', outbox: true, outboxId: 'outbox-existing', status: 'queued' },
      warnings: []
    }];
    const leads = new FakeLeads();
    const silentModel = model({
      proposeLedgerDelta: vi.fn(async () => { throw new Error('model must not run'); }),
      planTurn: vi.fn(async () => { throw new Error('model must not run'); }),
      composeAnswer: vi.fn(async () => { throw new Error('model must not run'); }),
      reviewAnswer: vi.fn(async () => { throw new Error('model must not run'); })
    });
    const orchestrator = new AgentManagerOrchestrator(
      conversations as never,
      new FakeProducts() as never,
      leads as never,
      silentModel
    );

    const payload = await orchestrator.recoverTurn({ sessionId, turnId });

    expect(payload.leadCreated).toBe(false);
    expect(leads.created).toHaveLength(0);
    expect(conversations.outbox).toHaveLength(0);
  });

  it('rebinds a durable lead after replan only when the semantic action fingerprint matches', async () => {
    const conversations = new FakeConversations();
    const buyerQuestion = 'Please arrange delivery for generator A.';
    const currentMessage = 'Alexey, +7 900 000-00-11, please call.';
    const purpose = 'arrange delivery for generator A';
    const oldRequestId = 'lead-request-before-replan';
    const newRequestId = 'lead-request-after-replan';
    conversations.messages = [
      { ...message(buyerQuestion), id: '41111111-1111-4111-8111-111111111111' },
      { ...message('Please leave your phone number and say whether a call or message is more convenient.', 'assistant'), id: '42222222-2222-4222-8222-222222222222' },
      message(currentMessage)
    ];
    conversations.checkpoints = [{
      checkpoint: 'ledger_delta_proposed',
      status: 'succeeded',
      payload: { rationale: 'saved contact state', events: [] }
    }, {
      checkpoint: 'intent_contract_created',
      status: 'succeeded',
      payload: {
        userMessageSummary: 'legacy lead intent',
        dialogueUnderstanding: 'legacy schema must be replanned',
        nextStepRationale: 'legacy side effect already happened',
        requiresTools: true,
        toolRequests: [],
        mustNotAskQuestionIds: [],
        riskFlags: []
      }
    }];
    conversations.toolArtifacts = [{
      tool_name: 'lead.capture',
      tool_request_id: oldRequestId,
      status: 'ok',
      payload: {
        leadId: 'lead-existing',
        outbox: true,
        outboxId: 'outbox-existing',
        status: 'queued',
        actionFingerprint: leadActionFingerprintFixture({
          turnId,
          userMessage: currentMessage,
          contactSource: 'current_message',
          handoffKind: 'commercial_followup',
          purpose,
          buyerQuestion,
          evidence: currentMessage,
          evidencedName: 'Alexey',
          preferredContact: 'call'
        })
      },
      warnings: []
    }];
    const currentIntent: AgentIntentContract = {
      userMessageSummary: 'buyer supplied contact for delivery follow-up',
      dialogueUnderstanding: 'this is the same commercial handoff already persisted before recovery',
      nextStepRationale: 'reuse only the exact durable side effect',
      requiresTools: true,
      toolRequests: [{
        id: newRequestId,
        tool: 'lead.capture',
        args: { contact: { name: 'Alexey', preferredContact: 'call' } },
        rationale: 'complete the exact commercial handoff',
        required: true
      }],
      grounding: {
        taskType: 'lead_handoff',
        sourcePolicy: 'conversation_only',
        webPurpose: 'none',
        webRequirement: 'none',
        requiredToolKinds: ['lead.capture'],
        technicalAttributes: [],
        buyerQuestion,
        rationale: 'commercial delivery follow-up'
      },
      productMentions: [],
      selectionPolicy: currentNoProductSelectionPolicy(),
      leadCaptureAuthorization: {
        authorized: true,
        contactSource: 'current_message',
        handoffKind: 'commercial_followup',
        purpose,
        buyerQuestion,
        evidence: currentMessage,
        pendingDraftId: null
      },
      policyRuleIds: [],
      mustNotAskQuestionIds: [],
      riskFlags: ['lead']
    };
    const composeAnswer = vi.fn(async (input: Parameters<AgentManagerModel['composeAnswer']>[0]) => {
      expect(input.toolResults).toContainEqual(expect.objectContaining({
        requestId: newRequestId,
        tool: 'lead.capture',
        status: 'ok',
        payload: expect.objectContaining({ leadId: 'lead-existing', outboxId: 'outbox-existing' })
      }));
      return {
        answerText: 'Thank you. The delivery request was recorded and queued for a call.',
        factsUsed: [],
        questionsAsked: [],
        toolResultIds: [newRequestId],
        selectedProductIds: [],
        leadAction: 'confirm_contact_received' as const,
        riskFlags: []
      };
    });
    const leads = new FakeLeads();
    const orchestrator = new AgentManagerOrchestrator(
      conversations as never,
      new FakeProducts() as never,
      leads as never,
      model({ planTurn: vi.fn(async () => currentIntent), composeAnswer })
    );

    const payload = await orchestrator.recoverTurn({ sessionId, turnId });

    expect(payload.leadCreated).toBe(true);
    expect(leads.created).toHaveLength(0);
    expect(conversations.outbox).toHaveLength(0);
    expect(conversations.toolArtifacts).toContainEqual(expect.objectContaining({
      toolRequestId: newRequestId,
      warnings: expect.arrayContaining(['rebound_after_intent_replan'])
    }));
  });

  it('blocks a mismatched durable lead after replan without creating a second lead', async () => {
    const conversations = new FakeConversations();
    const currentQuestion = 'Please arrange delivery for generator B.';
    const priorQuestion = 'Please arrange delivery for generator A.';
    const currentMessage = 'Alexey, +7 900 000-00-11, please call.';
    const purpose = 'arrange delivery for generator B';
    const requestId = 'lead-request-same-id';
    conversations.messages = [
      { ...message(currentQuestion), id: '43333333-3333-4333-8333-333333333333' },
      { ...message('Please leave your phone number and preferred contact method.', 'assistant'), id: '44444444-4444-4444-8444-444444444449' },
      message(currentMessage)
    ];
    conversations.checkpoints = [{
      checkpoint: 'ledger_delta_proposed',
      status: 'succeeded',
      payload: { rationale: 'saved contact state', events: [] }
    }, {
      checkpoint: 'intent_contract_created',
      status: 'succeeded',
      payload: {
        userMessageSummary: 'legacy lead intent',
        dialogueUnderstanding: 'legacy schema must be replanned',
        nextStepRationale: 'legacy side effect already happened for another subject',
        requiresTools: true,
        toolRequests: [],
        mustNotAskQuestionIds: [],
        riskFlags: []
      }
    }];
    conversations.toolArtifacts = [{
      tool_name: 'lead.capture',
      tool_request_id: requestId,
      status: 'ok',
      payload: {
        leadId: 'lead-for-question-a',
        outbox: true,
        outboxId: 'outbox-for-question-a',
        status: 'queued',
        actionFingerprint: leadActionFingerprintFixture({
          turnId,
          userMessage: currentMessage,
          contactSource: 'current_message',
          handoffKind: 'commercial_followup',
          purpose: 'arrange delivery for generator A',
          buyerQuestion: priorQuestion,
          evidence: currentMessage,
          evidencedName: 'Alexey',
          preferredContact: 'call'
        })
      },
      warnings: []
    }];
    const currentIntent: AgentIntentContract = {
      userMessageSummary: 'buyer supplied contact for generator B delivery',
      dialogueUnderstanding: 'the current action has a different subject from the persisted side effect',
      nextStepRationale: 'fail closed instead of rebinding or duplicating the lead',
      requiresTools: true,
      toolRequests: [{
        id: requestId,
        tool: 'lead.capture',
        args: { contact: { name: 'Alexey', preferredContact: 'call' } },
        rationale: 'attempt the current commercial handoff',
        required: true
      }],
      grounding: {
        taskType: 'lead_handoff',
        sourcePolicy: 'conversation_only',
        webPurpose: 'none',
        webRequirement: 'none',
        requiredToolKinds: ['lead.capture'],
        technicalAttributes: [],
        buyerQuestion: currentQuestion,
        rationale: 'commercial delivery follow-up'
      },
      productMentions: [],
      selectionPolicy: currentNoProductSelectionPolicy(),
      leadCaptureAuthorization: {
        authorized: true,
        contactSource: 'current_message',
        handoffKind: 'commercial_followup',
        purpose,
        buyerQuestion: currentQuestion,
        evidence: currentMessage,
        pendingDraftId: null
      },
      policyRuleIds: [],
      mustNotAskQuestionIds: [],
      riskFlags: ['lead']
    };
    const composeAnswer = vi.fn(async (input: Parameters<AgentManagerModel['composeAnswer']>[0]) => {
      expect(input.toolResults).toContainEqual(expect.objectContaining({
        requestId,
        tool: 'lead.capture',
        status: 'denied',
        warnings: expect.arrayContaining(['lead_capture_reexecution_blocked_unverifiable_side_effect'])
      }));
      return {
        answerText: 'I could not safely match this contact to the current request, so I did not create or confirm another request.',
        factsUsed: [],
        questionsAsked: [],
        toolResultIds: [requestId],
        selectedProductIds: [],
        leadAction: 'none' as const,
        riskFlags: []
      };
    });
    const leads = new FakeLeads();
    const orchestrator = new AgentManagerOrchestrator(
      conversations as never,
      new FakeProducts() as never,
      leads as never,
      model({ planTurn: vi.fn(async () => currentIntent), composeAnswer })
    );

    const payload = await orchestrator.recoverTurn({ sessionId, turnId });

    expect(payload.leadCreated).toBe(false);
    expect(leads.created).toHaveLength(0);
    expect(conversations.outbox).toHaveLength(0);
    expect(payload.answer).not.toContain('recorded and queued');
  });

  it('fails closed when a persisted tool artifact cannot be validated', async () => {
    const conversations = new FakeConversations();
    conversations.toolArtifacts = [{
      tool_name: 'lead.capture',
      tool_request_id: 'lead-request',
      status: 'invented_status',
      payload: {},
      warnings: []
    }];
    const proposeLedgerDelta = vi.fn(async () => ({ rationale: 'must not run', events: [] }));
    const orchestrator = new AgentManagerOrchestrator(
      conversations as never,
      new FakeProducts() as never,
      new FakeLeads() as never,
      model({ proposeLedgerDelta })
    );

    await expect(orchestrator.recoverTurn({ sessionId, turnId })).rejects.toThrow();
    expect(proposeLedgerDelta).not.toHaveBeenCalled();
  });

  it('does not start a second runner while another execution lease is active', async () => {
    const conversations = new FakeConversations() as FakeConversations & {
      claimTurnExecution: () => Promise<null>;
    };
    conversations.claimTurnExecution = vi.fn(async () => null);
    const proposeLedgerDelta = vi.fn(async () => ({ rationale: 'must not run', events: [] }));
    const orchestrator = new AgentManagerOrchestrator(
      conversations as never,
      new FakeProducts() as never,
      new FakeLeads() as never,
      model({ proposeLedgerDelta })
    );

    await expect(orchestrator.generateAnswer({
      sessionId,
      turnId,
      userMessage: 'Повторный запуск'
    })).rejects.toThrow('turn_execution_in_progress');
    expect(proposeLedgerDelta).not.toHaveBeenCalled();
  });

  it('passes the claimed execution owner through the atomic final commit', async () => {
    class OwnedConversations extends FakeConversations {
      claimedOwner: string | null = null;
      releasedOwner: string | null = null;

      async claimTurnExecution(input: { ownerId: string }) {
        this.claimedOwner = input.ownerId;
        this.turn = { ...this.turn, executionOwner: input.ownerId };
        return this.turn;
      }

      async releaseTurnExecution(input: { ownerId: string }) {
        this.releasedOwner = input.ownerId;
        return this.turn;
      }
    }
    const conversations = new OwnedConversations();
    const orchestrator = new AgentManagerOrchestrator(
      conversations as never,
      new FakeProducts() as never,
      new FakeLeads() as never,
      model()
    );

    await orchestrator.generateAnswer({
      sessionId,
      turnId,
      userMessage: 'Coffee machine 3.2 kW, grinder 400 W, is 5 kW enough?'
    });

    expect(conversations.claimedOwner).toEqual(expect.any(String));
    expect(conversations.assistantSaves).toContainEqual(expect.objectContaining({
      executionOwner: conversations.claimedOwner,
      answerContract: expect.objectContaining({ answerText: expect.stringContaining('5 kW') }),
      responsePayload: expect.objectContaining({ answer: expect.stringContaining('5 kW') })
    }));
    expect(conversations.releasedOwner).toBe(conversations.claimedOwner);
  });

  it('does not emit a delta when the fenced final commit loses ownership', async () => {
    class LostOwnerConversations extends FakeConversations {
      override async addAssistantMessageForTurn() {
        return null;
      }
    }
    const conversations = new LostOwnerConversations();
    const onDelta = vi.fn();
    const orchestrator = new AgentManagerOrchestrator(
      conversations as never,
      new FakeProducts() as never,
      new FakeLeads() as never,
      model()
    );

    await expect(orchestrator.generateAnswer({
      sessionId,
      turnId,
      userMessage: 'Coffee machine 3.2 kW, grinder 400 W, is 5 kW enough?',
      onDelta
    })).rejects.toThrow('turn_execution_in_progress');

    expect(onDelta).not.toHaveBeenCalled();
  });

  it('waits for the original runner and returns its saved answer when transport recovery collides with the lease', async () => {
    vi.useFakeTimers();
    try {
      const conversations = new FakeConversations() as FakeConversations & {
        claimTurnExecution: () => Promise<null>;
      };
      conversations.claimTurnExecution = vi.fn(async () => null);
      const proposeLedgerDelta = vi.fn(async () => ({ rationale: 'must not run', events: [] }));
      const orchestrator = new AgentManagerOrchestrator(
        conversations as never,
        new FakeProducts() as never,
        new FakeLeads() as never,
        model({ proposeLedgerDelta })
      );

      const recovery = orchestrator.recoverTurn({ sessionId, turnId });
      await vi.advanceTimersByTimeAsync(100);

      const saved = message('Saved answer from the original runner.', 'assistant');
      saved.metadata = {
        productCards: [{ id: 'generator-5kw', name: 'Generator 5 kW', url: '/generator-5kw' }],
        usedWebSearch: false,
        needStateSnapshot: session().needState
      };
      conversations.messages.push(saved);
      conversations.turn = {
        ...conversations.turn,
        assistantMessageId: saved.id,
        status: 'completed'
      };
      await vi.advanceTimersByTimeAsync(500);

      await expect(recovery).resolves.toMatchObject({
        answer: 'Saved answer from the original runner.',
        assistantMessageId: saved.id,
        productCards: [{ id: 'generator-5kw' }],
        metadata: { recoveredFromExistingTurn: true }
      });
      expect(proposeLedgerDelta).not.toHaveBeenCalled();
      expect(conversations.claimTurnExecution).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('resumes from a final answer contract instead of calling the model again', async () => {
    const conversations = new FakeConversations();
    conversations.finalAnswerContract = {
      answer_text: 'Saved answer from answer_contract.',
      contract: { answerText: 'Saved answer from answer_contract.' },
      review: { verdict: 'pass', issues: [] }
    };
    const silentModel = model({
      proposeLedgerDelta: vi.fn(async () => {
        throw new Error('model must not be called');
      })
    });
    const orchestrator = new AgentManagerOrchestrator(conversations as never, new FakeProducts() as never, new FakeLeads() as never, silentModel);

    const payload = await orchestrator.recoverTurn({ sessionId, turnId });

    expect(payload.answer).toBe('Saved answer from answer_contract.');
    expect(payload.metadata?.recoveredFromAnswerContract).toBe(true);
    expect(conversations.assistantSaves).toHaveLength(1);
  });

  it('blocks an answer that cites a fact source absent from ledger and tool artifacts', async () => {
    const conversations = new FakeConversations();
    const unsafeModel = model({
      async composeAnswer() {
        return {
          answerText: 'Noise is exactly 65 dB.',
          factsUsed: [{
            factKey: 'noise_db',
            sourceEventIds: ['missing-source'],
            value: '65 dB'
          }],
          questionsAsked: [],
          toolResultIds: [],
          leadAction: 'none',
          riskFlags: []
        };
      }
    });
    const orchestrator = new AgentManagerOrchestrator(conversations as never, new FakeProducts() as never, new FakeLeads() as never, unsafeModel);

    await expect(orchestrator.generateAnswer({
      sessionId,
      turnId,
      userMessage: 'Compare noise levels.'
    })).rejects.toThrow(/unsupported_fact_source/);
    expect(conversations.assistantSaves).toHaveLength(0);
  });

  it('blocks answer fact aliases instead of laundering them onto an unrelated successful tool result', async () => {
    const conversations = new FakeConversations();
    const sourceAliasModel = model({
      async planTurn() {
        return {
          userMessageSummary: 'buyer asks for catalog options',
          dialogueUnderstanding: 'catalog search is needed before answering',
          nextStepRationale: 'search catalog and answer from returned products',
          requiresTools: true,
          toolRequests: [{
            id: 'catalog-search',
            tool: 'catalog.search',
            args: {
              query: 'generator 5 kW',
              semanticQuery: 'generator 5 kW',
              productIntent: 'generator',
              limit: 4,
              productIds: [],
              productNames: [],
              comparisonAttributes: [],
              loads: [],
              simultaneousStarting: null,
              simultaneousStartingKinds: [],
              contact: { name: null, phone: null, email: null, preferredContact: null, comment: null },
              reason: null,
              notes: null
            },
            rationale: 'find matching products',
            required: true
          }],
          mustNotAskQuestionIds: [],
          riskFlags: []
        };
      },
      async composeAnswer() {
        return {
          answerText: 'I found Generator 5 kW and Generator 6 kW in the catalog.',
          factsUsed: [{
            factKey: 'catalog_found_generators',
            sourceEventIds: ['catalog_found_generators'],
            value: true
          }],
          questionsAsked: [],
          toolResultIds: [],
          leadAction: 'none',
          riskFlags: []
        };
      }
    });
    const orchestrator = new AgentManagerOrchestrator(conversations as never, new FakeProducts() as never, new FakeLeads() as never, sourceAliasModel);

    await expect(orchestrator.generateAnswer({
      sessionId,
      turnId,
      userMessage: 'Show me catalog generators around 5 kW.'
    })).rejects.toThrow('unsupported_fact_source');
    expect(conversations.assistantSaves).toHaveLength(0);
  });

  it('blocks contact confirmation when local lead and outbox capture did not succeed', async () => {
    const conversations = new FakeConversations();
    const unsafeModel = model({
      async composeAnswer() {
        return {
          answerText: 'Contact received, we will check delivery.',
          factsUsed: [],
          questionsAsked: [],
          toolResultIds: [],
          leadAction: 'confirm_contact_received',
          riskFlags: []
        };
      }
    });
    const orchestrator = new AgentManagerOrchestrator(conversations as never, new FakeProducts() as never, new FakeLeads() as never, unsafeModel);

    await expect(orchestrator.generateAnswer({
      sessionId,
      turnId,
      userMessage: 'Alexey, +7 900 000-00-11'
    })).rejects.toThrow(/lead_confirmation_without_local_capture/);
    expect(conversations.assistantSaves).toHaveLength(0);
  });

  it('rewrites a premature lead confirmation to a form offer when no contact was provided', async () => {
    const conversations = new FakeConversations();
    const leads = new FakeLeads();
    const unsafeModel = model({
      async planTurn() {
        return {
          userMessageSummary: 'buyer asks delivery availability without contact',
          grounding: {
            taskType: 'lead_handoff',
            sourcePolicy: 'conversation_only',
            webPurpose: 'none',
            webRequirement: 'none',
            requiredToolKinds: ['lead.capture'],
            technicalAttributes: [],
            buyerQuestion: 'Можно проверить наличие и доставку?',
            rationale: 'offer contact capture for an explicit commercial availability and delivery follow-up'
          },
          dialogueUnderstanding: 'delivery and stock require specialist verification, but no contact is present',
          nextStepRationale: 'offer contact form',
          requiresTools: true,
          toolRequests: [{
            id: 'lead.capture:missing',
            tool: 'lead.capture',
            args: {},
            rationale: 'buyer has not provided contact yet',
            required: true
          }],
          mustNotAskQuestionIds: [],
          riskFlags: ['lead']
        };
      },
      async composeAnswer() {
        return {
          answerText: 'Contact received, I will check delivery and stock.',
          factsUsed: [],
          questionsAsked: [],
          toolResultIds: ['lead.capture:missing'],
          leadAction: 'confirm_contact_received',
          riskFlags: []
        };
      }
    });
    const orchestrator = new AgentManagerOrchestrator(conversations as never, new FakeProducts() as never, leads as never, unsafeModel);

    const payload = await orchestrator.generateAnswer({
      sessionId,
      turnId,
      userMessage: 'Можно проверить наличие и доставку?'
    });

    expect(payload.answer).toContain('Оставьте, пожалуйста, имя и номер телефона');
    expect(payload.answer).not.toContain('Contact received');
    expect(payload.leadRequested).toBe(true);
    expect(payload.leadCreated).toBe(false);
    expect(leads.created).toHaveLength(0);
    expect(conversations.assistantSaves).toHaveLength(1);
  });

  it('restores the exact saved user-visible payload from a final answer contract', async () => {
    const conversations = new FakeConversations();
    const savedCard = {
      id: 'p1',
      name: 'Generator 6 kW',
      sourceUrl: 'https://example.test/p1'
    } as ProductCard;
    conversations.finalAnswerContract = {
      answer_text: 'Точный сохранённый ответ.',
      contract: { answerText: 'Точный сохранённый ответ.' },
      review: { verdict: 'pass', issues: [] },
      response_payload: {
        turnId,
        answer: 'Точный сохранённый ответ.',
        needState: emptyNeedState(),
        productCards: [savedCard],
        cardDisplay: { initialVisibleCount: 1 },
        usedWebSearch: true,
        leadRequested: true,
        leadCreated: false,
        metadata: { savedMarker: 'exact-payload' }
      }
    };
    const silentModel = model({
      proposeLedgerDelta: vi.fn(async () => {
        throw new Error('model must not be called');
      })
    });
    const orchestrator = new AgentManagerOrchestrator(
      conversations as never,
      new FakeProducts() as never,
      new FakeLeads() as never,
      silentModel
    );

    const payload = await orchestrator.recoverTurn({ sessionId, turnId });

    expect(payload).toMatchObject({
      answer: 'Точный сохранённый ответ.',
      productCards: [savedCard],
      cardDisplay: { initialVisibleCount: 1 },
      usedWebSearch: true,
      leadRequested: true,
      leadCreated: false,
      metadata: { savedMarker: 'exact-payload' }
    });
    expect(payload.metadata).toEqual({ savedMarker: 'exact-payload' });
  });

  it('keeps leadRequested true when the answer offers the form after missing contact', async () => {
    const conversations = new FakeConversations();
    const leads = new FakeLeads();
    const formOfferModel = model({
      async planTurn() {
        return {
          userMessageSummary: 'buyer asks for commercial terms without contact',
          dialogueUnderstanding: 'delivery, discount, and pickup terms require specialist verification',
          nextStepRationale: 'offer contact form because no contact is present',
          requiresTools: true,
          toolRequests: [{
            id: 'lead.capture:missing',
            tool: 'lead.capture',
            args: {},
            rationale: 'buyer has not provided contact yet',
            required: true
          }],
          grounding: {
            taskType: 'lead_handoff',
            sourcePolicy: 'conversation_only',
            webPurpose: 'none',
            webRequirement: 'none',
            requiredToolKinds: ['lead.capture'],
            technicalAttributes: [],
            buyerQuestion: 'Доставка есть? И можно ли получить скидку, если сразу забрать генератор?',
            rationale: 'offer contact capture for explicit delivery, pickup, and discount terms'
          },
          mustNotAskQuestionIds: [],
          riskFlags: ['lead']
        };
      },
      async composeAnswer() {
        return {
          answerText: 'Доставка есть, но стоимость, условия и скидку нужно уточнить у логистики и менеджера. Оставьте имя и телефон в форме, и мы проверим это предметно.',
          factsUsed: [],
          questionsAsked: [],
          toolResultIds: ['lead.capture:missing'],
          leadAction: 'offer_form',
          riskFlags: []
        };
      }
    });
    const orchestrator = new AgentManagerOrchestrator(conversations as never, new FakeProducts() as never, leads as never, formOfferModel);

    const payload = await orchestrator.generateAnswer({
      sessionId,
      turnId,
      userMessage: 'Доставка есть? И можно ли получить скидку, если сразу забрать генератор?'
    });

    const metadata = payload.metadata as { answerContract?: { leadAction?: string } };
    expect(payload.answer).toContain('Оставьте, пожалуйста, имя и номер телефона');
    expect(payload.leadRequested).toBe(true);
    expect(payload.leadCreated).toBe(false);
    expect(metadata.answerContract?.leadAction).toBe('offer_form');
    expect(leads.created).toHaveLength(0);
  });

  it('rewrites missing-contact commercial handoff without delivery or discount promises', async () => {
    const conversations = new FakeConversations();
    const leads = new FakeLeads();
    const unsafeOfferModel = model({
      async planTurn() {
        return {
          userMessageSummary: 'buyer asks for delivery and discount terms without contact',
          grounding: {
            taskType: 'lead_handoff',
            sourcePolicy: 'conversation_only',
            webPurpose: 'none',
            webRequirement: 'none',
            requiredToolKinds: ['lead.capture'],
            technicalAttributes: [],
            buyerQuestion: 'Доставка есть? И можно ли получить скидку, если сразу забрать генератор?',
            rationale: 'offer contact capture for explicit delivery, pickup, and discount terms'
          },
          dialogueUnderstanding: 'commercial terms require specialist verification and contact handoff',
          nextStepRationale: 'offer contact form because no contact is present',
          requiresTools: true,
          toolRequests: [{
            id: 'lead.capture:missing',
            tool: 'lead.capture',
            args: {},
            rationale: 'buyer has not provided contact yet',
            required: true
          }],
          mustNotAskQuestionIds: [],
          riskFlags: ['lead']
        };
      },
      async composeAnswer() {
        return {
          answerText: 'Delivery and discount are available. Leave your phone and we will check details.',
          factsUsed: [],
          questionsAsked: [],
          toolResultIds: ['lead.capture:missing'],
          leadAction: 'offer_form',
          riskFlags: []
        };
      }
    });
    const orchestrator = new AgentManagerOrchestrator(conversations as never, new FakeProducts() as never, leads as never, unsafeOfferModel);

    const payload = await orchestrator.generateAnswer({
      sessionId,
      turnId,
      userMessage: 'Р”РѕСЃС‚Р°РІРєР° РµСЃС‚СЊ? Р РјРѕР¶РЅРѕ Р»Рё РїРѕР»СѓС‡РёС‚СЊ СЃРєРёРґРєСѓ, РµСЃР»Рё СЃСЂР°Р·Сѓ Р·Р°Р±СЂР°С‚СЊ РіРµРЅРµСЂР°С‚РѕСЂ?'
    });

    const metadata = payload.metadata as {
      preSendReview?: { issues?: Array<{ code?: string }> };
      answerContract?: { leadAction?: string };
    };
    expect(payload.answer).not.toContain('Delivery and discount are available');
    expect(payload.leadRequested).toBe(true);
    expect(payload.leadCreated).toBe(false);
    expect(metadata.answerContract?.leadAction).toBe('offer_form');
    expect(metadata.preSendReview?.issues?.map((issue) => issue.code)).toContain('lead_capture_missing_contact_offer_form');
    expect(leads.created).toHaveLength(0);
  });

  it('replaces first-turn 400 kg vibroplate request when the same message says home paving tile', async () => {
    class FirstTurnPlateReplacementProducts extends FakeProducts {
      async searchProducts(query = '') {
        if (query.includes('60 90') || query.includes('тротуарной плитки')) {
          return [
            {
              ...product('plate-80', 'Vibroplita TSS VP80 80 kg', 'Vibroplita'),
              specs: { weight: '80 kg' }
            },
            {
              ...product('plate-95', 'Vibroplita Champion PC95 95 kg', 'Vibroplita'),
              specs: { weight: '95 kg' }
            },
            {
              ...product('plate-160', 'Vibroplita Heavy 160 kg', 'Vibroplita'),
              specs: { weight: '160 kg' }
            }
          ];
        }
        return [
          {
            ...product('grost-vh-400d', 'GROST VH 400D 400 kg vibroplita', 'Vibroplita'),
            specs: { weight: '400 kg' }
          },
          {
            ...product('masterpac-pcr7060h2', 'MASTERPAC PCR7060H.2 400 kg vibroplita', 'Vibroplita'),
            specs: { weight: '400 kg' }
          },
          {
            ...product('husqvarna-lg-400', 'Husqvarna LG 400 398 kg vibroplita', 'Vibroplita'),
            specs: { weight: '398 kg' }
          }
        ];
      }
    }

    const conversations = new FakeConversations();
    conversations.messages = [
      message('Есть у вас плита 400 кг? Мне для тротуарной плитки во дворе.')
    ];
    const firstTurnModel = model({
      async proposeLedgerDelta() {
        return {
          rationale: 'buyer asks for 400 kg plate but states home paving tile use',
          events: [{
            eventType: 'fact.confirmed',
            scope: 'dialogue',
            payload: { factKey: 'product_request', value: 'vibroplita 400 kg' },
            evidence: 'Есть у вас плита 400 кг',
            source: 'llm_state_delta',
            status: 'active'
          }, {
            eventType: 'fact.confirmed',
            scope: 'dialogue',
            payload: { factKey: 'application', value: 'home paving tile in yard' },
            evidence: 'для тротуарной плитки во дворе',
            source: 'llm_state_delta',
            status: 'active'
          }]
        };
      },
      async planTurn() {
        return {
          turnId,
          userMessageSummary: 'buyer asks whether 400 kg vibroplates are available for yard paving tile',
          dialogueUnderstanding: '400 kg conflicts with the stated home paving tile task',
          nextStepRationale: 'search catalog, reject heavy task mismatch, and show lighter suitable plate alternatives',
          requiresTools: true,
          toolRequests: [{
            id: 'catalog-search-heavy',
            tool: 'catalog.search',
            args: {
              query: 'виброплита 400 кг',
              semanticQuery: '400 kg vibroplate for paving tile in yard',
              productIntent: 'plate',
              limit: 6,
              productIds: [],
              productNames: [],
              comparisonAttributes: ['weight', 'application'],
              loads: [],
              simultaneousStarting: null,
              simultaneousStartingKinds: [],
              contact: { name: null, phone: null, email: null, preferredContact: null, comment: null },
              reason: 'buyer asks about 400 kg vibroplate availability and suitability',
              notes: null
            },
            rationale: 'check catalog products mentioned by buyer before correcting suitability',
            required: true
          }],
          productMentions: [{
            name: 'виброплита 400 кг',
            role: 'target_product' as const,
            productClass: 'plate',
            evidence: 'Есть у вас плита 400 кг'
          }],
          mustNotAskQuestionIds: [],
          riskFlags: []
        };
      },
      async composeAnswer(input) {
        expect(input.products.map((item) => item.id)).toEqual(['plate-80', 'plate-95']);
        expect(input.toolResults.map((result) => result.requestId)).toEqual(expect.arrayContaining([
          'catalog-search-heavy',
          'catalog-search:plate-replacement'
        ]));
        expect(input.requiredResponseClauses?.map((clause) => clause.code)).toContain('plate_previous_cards_unsuitable_replaced_by_task_search');
        const mismatchClause = input.requiredResponseClauses?.find((clause) => clause.code === 'plate_previous_cards_unsuitable_replaced_by_task_search');
        expect(mismatchClause?.instruction).toContain('60-120 kg');
        expect(mismatchClause?.instruction).toContain('do not make the buyer ask again for options');
        return {
          answerText: '400 кг для тротуарной плитки во дворе я бы не рекомендовал как основной вариант. Это тяжелый класс под основание и большие работы. Для вашей задачи лучше смотреть Vibroplita TSS VP80 80 kg и Vibroplita Champion PC95 95 kg, а по плитке использовать коврик.',
          factsUsed: [],
          questionsAsked: [],
          toolResultIds: ['catalog-search:plate-replacement'],
          leadAction: 'none',
          riskFlags: [],
          selectionReadiness: {
            productClass: 'plate',
            status: 'ready_for_exact_cards',
            canShowProductCards: true,
            missingFacts: [],
            rationale: 'Replacement products match the stated paving tile task better than 400 kg plates.'
          }
        };
      }
    });
    const orchestrator = new AgentManagerOrchestrator(conversations as never, new FirstTurnPlateReplacementProducts() as never, new FakeLeads() as never, firstTurnModel);

    const payload = await orchestrator.generateAnswer({
      sessionId,
      turnId,
      userMessage: 'Есть у вас плита 400 кг? Мне для тротуарной плитки во дворе.'
    });

    const metadata = payload.metadata as {
      answerProductEvidence?: { droppedProductIds?: string[]; replacementProductIds?: string[]; plateTaskPolicy?: { maxPracticalWeightKg?: number } };
      replacementProductEvidence?: { productIds?: string[]; droppedPreviousProductIds?: string[]; warnings?: string[] };
      toolResults?: Array<{ requestId?: string; payload?: { productIds?: string[] } }>;
    };
    expect(payload.productCards.map((card) => card.id)).toEqual(['plate-80', 'plate-95']);
    expect(payload.productCards.map((card) => card.id)).not.toContain('grost-vh-400d');
    expect(metadata.answerProductEvidence?.droppedProductIds).toEqual(expect.arrayContaining([
      'grost-vh-400d',
      'masterpac-pcr7060h2',
      'husqvarna-lg-400'
    ]));
    expect(metadata.answerProductEvidence?.replacementProductIds).toEqual(['plate-80', 'plate-95']);
    expect(metadata.answerProductEvidence?.plateTaskPolicy?.maxPracticalWeightKg).toBe(120);
    expect(metadata.replacementProductEvidence?.productIds).toEqual(['plate-80', 'plate-95']);
    expect(metadata.replacementProductEvidence?.droppedPreviousProductIds).toEqual(expect.arrayContaining([
      'grost-vh-400d',
      'masterpac-pcr7060h2',
      'husqvarna-lg-400'
    ]));
    expect(metadata.replacementProductEvidence?.warnings).toContain('answer_products_replaced_by_plate_task_search');
    expect(metadata.toolResults?.map((result) => result.requestId)).toContain('catalog-search:plate-replacement');
  });

  it('rejects explicit 400 kg plate first-turn even when search already returns light paving options', async () => {
    class LightPlateProducts extends FakeProducts {
      async searchProducts() {
        return [
          {
            ...product('masalta-msr60', 'Masalta MSR60-4 62 kg vibroplate', 'Vibroplita'),
            specs: { weight: '62 kg' }
          },
          {
            ...product('firman-fpc90', 'FIRMAN FPC90BF 84 kg vibroplate', 'Vibroplita'),
            specs: { weight: '84 kg' }
          },
          {
            ...product('wacker-aps1135', 'Wacker Neuson APS1135we 73 kg vibroplate', 'Vibroplita'),
            specs: { weight: '73 kg' }
          }
        ];
      }
    }

    const conversations = new FakeConversations();
    conversations.messages = [
      message('Do you have a 400 kg plate? I need it for paving tile in my yard.')
    ];
    const firstTurnModel = model({
      async proposeLedgerDelta() {
        return {
          rationale: 'buyer asks for 400 kg plate but states yard paving tile use',
          events: [{
            eventType: 'fact.confirmed',
            scope: 'dialogue',
            payload: { factKey: 'product_request', value: 'vibroplate 400 kg' },
            evidence: '400 kg plate',
            source: 'llm_state_delta',
            status: 'active'
          }, {
            eventType: 'fact.confirmed',
            scope: 'dialogue',
            payload: { factKey: 'application', value: 'paving tile in yard' },
            evidence: 'paving tile in my yard',
            source: 'llm_state_delta',
            status: 'active'
          }]
        };
      },
      async planTurn() {
        return {
          turnId,
          userMessageSummary: 'buyer asks whether a 400 kg vibroplate is available for yard paving tile',
          dialogueUnderstanding: '400 kg conflicts with the stated private yard paving tile task',
          nextStepRationale: 'search catalog and show suitable lighter plate alternatives',
          requiresTools: true,
          toolRequests: [{
            id: 'search-plates-400kg',
            tool: 'catalog.search',
            args: {
              query: '400 kg vibroplate for paving tile in yard',
              semanticQuery: '400 kg vibroplate for paving tile in yard',
              productIntent: 'plate',
              limit: 6,
              productIds: [],
              productNames: [],
              comparisonAttributes: ['weight', 'application'],
              loads: [],
              simultaneousStarting: null,
              simultaneousStartingKinds: [],
              contact: { name: null, phone: null, email: null, preferredContact: null, comment: null },
              reason: 'buyer asks about 400 kg vibroplate availability and suitability',
              notes: null
            },
            rationale: 'check catalog and correct the suitability mismatch',
            required: true
          }],
          productMentions: [{
            name: '400 kg vibroplate',
            role: 'target_product' as const,
            productClass: 'plate',
            evidence: '400 kg plate'
          }],
          mustNotAskQuestionIds: [],
          riskFlags: []
        };
      },
      async composeAnswer(input) {
        expect(input.products.map((item) => item.id)).toEqual(['wacker-aps1135', 'masalta-msr60', 'firman-fpc90']);
        const clause = input.requiredResponseClauses?.find((item) =>
          item.code === 'plate_explicit_heavy_request_conflicts_with_small_site_task'
        );
        expect(clause?.instruction).toContain('60-120 kg');
        expect(clause?.instruction).toContain('do not make the buyer ask again for options');
        return {
          answerText: 'I do not see a 400 kg plate by this search. For yard paving tile people usually take 60-100 kg. Here are Masalta MSR60-4, Wacker APS1135we, and FIRMAN FPC90BF. Use a mat on installed tile.',
          factsUsed: [],
          questionsAsked: [],
          toolResultIds: ['search-plates-400kg'],
          leadAction: 'none',
          riskFlags: [],
          selectionReadiness: {
            productClass: 'plate',
            status: 'ready_for_exact_cards',
            canShowProductCards: true,
            missingFacts: [],
            rationale: 'Light plate options match the stated yard paving tile task.'
          }
        };
      }
    });
    const orchestrator = new AgentManagerOrchestrator(conversations as never, new LightPlateProducts() as never, new FakeLeads() as never, firstTurnModel);

    const payload = await orchestrator.generateAnswer({
      sessionId,
      turnId,
      userMessage: 'Do you have a 400 kg plate? I need it for paving tile in my yard.'
    });

    const metadata = payload.metadata as {
      answerProductEvidence?: { droppedProductIds?: string[]; plateTaskPolicy?: { maxPracticalWeightKg?: number } };
      preSendReview?: { issues?: Array<{ code?: string }> };
    };
    expect(payload.answer).toContain('300-400');
    expect(payload.answer).toContain('60-120');
    expect(payload.answer).toContain('не рекомендовал');
    expect(payload.productCards.map((card) => card.id)).toEqual(['wacker-aps1135', 'masalta-msr60', 'firman-fpc90']);
    expect(metadata.answerProductEvidence?.droppedProductIds).toEqual([]);
    expect(metadata.answerProductEvidence?.plateTaskPolicy?.maxPracticalWeightKg).toBe(120);
    expect(metadata.preSendReview?.issues?.map((issue) => issue.code)).toContain('plate_explicit_heavy_request_conflicts_with_small_site_task');
  });

  it('replaces previous 400 kg vibroplate cards with suitable home paving tile options in the same turn', async () => {
    const conversations = new FakeConversations();
    const heavyCards: ProductCard[] = [{
      id: 'grost-vh-400d',
      name: 'GROST VH 400D 400 kg vibroplita',
      brand: 'GROST',
      category: 'vibroplity',
      price: 310000,
      currency: 'RUB',
      sourceUrl: 'https://example.test/grost-vh-400d',
      specs: { weight: '400 kg' },
      reasons: [],
      caveats: []
    }, {
      id: 'masterpac-pcr7060h2',
      name: 'MASTERPAC PCR7060H.2 400 kg vibroplita',
      brand: 'MASTERPAC',
      category: 'vibroplity',
      price: 320000,
      currency: 'RUB',
      sourceUrl: 'https://example.test/masterpac-pcr7060h2',
      specs: { weight: '400 kg' },
      reasons: [],
      caveats: []
    }, {
      id: 'husqvarna-lg-400',
      name: 'Husqvarna LG 400 398 kg vibroplita',
      brand: 'Husqvarna',
      category: 'vibroplity',
      price: 330000,
      currency: 'RUB',
      sourceUrl: 'https://example.test/husqvarna-lg-400',
      specs: { weight: '398 kg' },
      reasons: [],
      caveats: []
    }];
    conversations.messages = [
      message('Need vibroplita about 400 kg', 'user'),
      {
        ...message('Here are 400 kg options: GROST VH 400D, MASTERPAC PCR7060H.2, Husqvarna LG 400.', 'assistant'),
        metadata: {
          productCards: heavyCards
        }
      }
    ];
    class PlateReplacementProducts extends FakeProducts {
      async searchProducts() {
        return [
          {
            ...product('plate-80', 'Vibroplita TSS VP80 80 kg', 'Vibroplita'),
            specs: { weight: '80 kg' }
          },
          {
            ...product('plate-95', 'Vibroplita Champion PC95 95 kg', 'Vibroplita'),
            specs: { weight: '95 kg' }
          },
          {
            ...product('plate-160', 'Vibroplita Heavy 160 kg', 'Vibroplita'),
            specs: { weight: '160 kg' }
          }
        ];
      }
    }
    const unsafeModel = model({
      async proposeLedgerDelta() {
        return {
          rationale: 'buyer clarified home paving tile use',
          events: [{
            eventType: 'fact.confirmed',
            scope: 'dialogue',
            payload: { factKey: 'product_request', value: 'vibroplita' },
            evidence: 'Need vibroplita about 400 kg',
            source: 'llm_state_delta',
            status: 'active'
          }, {
            eventType: 'fact.confirmed',
            scope: 'dialogue',
            payload: { factKey: 'application', value: 'home paving tile' },
            evidence: 'For home paving tile in the yard',
            source: 'llm_state_delta',
            status: 'active'
          }]
        };
      },
      async planTurn() {
        return {
          userMessageSummary: 'buyer asks which previous 400 kg vibroplate is better for home paving tile',
          dialogueUnderstanding: 'current application is home paving tile in the yard, so heavy 400 kg plates conflict with the task',
          nextStepRationale: 'do not recommend previous heavy plates; explain mismatch and offer lighter suitable plate selection',
          requiresTools: false,
          toolRequests: [],
          productMentions: heavyCards.map((card) => ({
            name: card.name,
            role: 'comparison_subject' as const,
            productClass: 'plate',
            evidence: 'previous visible card'
          })),
          mustNotAskQuestionIds: [],
          riskFlags: []
        };
      },
      async composeAnswer(input) {
        expect(input.products.map((item) => item.id)).toEqual(['plate-95', 'plate-80']);
        expect(input.requiredResponseClauses?.map((clause) => clause.code)).toContain('plate_previous_cards_unsuitable_replaced_by_task_search');
        const mismatchClause = input.requiredResponseClauses?.find((clause) => clause.code === 'plate_previous_cards_unsuitable_replaced_by_task_search');
        expect(mismatchClause?.instruction).toContain('60-120 kg');
        expect(mismatchClause?.instruction).toContain('do not make the buyer ask again for options');
        expect(input.toolResults.map((result) => result.requestId)).toContain('catalog-search:plate-replacement');
        return {
          answerText: 'Из этих 400 кг ни одну не выбирал бы для домашней плитки. Вместо них смотрите Vibroplita TSS VP80 80 kg и Vibroplita Champion PC95 95 kg: это более нормальный класс под двор и плитку, а по уже уложенной плитке нужен коврик.',
          factsUsed: [],
          questionsAsked: [],
          toolResultIds: ['catalog-search:plate-replacement'],
          leadAction: 'none',
          riskFlags: [],
          selectionReadiness: {
            status: 'ready_for_exact_cards',
            rationale: 'Replacement products match the corrected home paving tile task.',
            missingFacts: [],
            productClass: 'plate',
            canShowProductCards: true
          }
        };
      }
    });
    const orchestrator = new AgentManagerOrchestrator(conversations as never, new PlateReplacementProducts() as never, new FakeLeads() as never, unsafeModel);

    const payload = await orchestrator.generateAnswer({
      sessionId,
      turnId,
      userMessage: 'For home paving tile in the yard, which of these is better?'
    });

    const metadata = payload.metadata as {
      productCards?: ProductCard[];
      cardSelection?: { selectedProductIds?: string[]; warnings?: string[] };
      answerProductEvidence?: { droppedProductIds?: string[]; warnings?: string[]; plateTaskPolicy?: { maxPracticalWeightKg?: number }; replacementProductIds?: string[] };
      replacementProductEvidence?: { productIds?: string[]; warnings?: string[] };
      preSendReview?: { issues?: Array<{ code?: string }> };
      toolResults?: Array<{ requestId?: string; payload?: { productIds?: string[] } }>;
      warnings?: string[];
    };
    expect(payload.answer).not.toContain('I would choose Husqvarna LG 400');
    expect(payload.answer).toContain('ни одну');
    expect(payload.answer).toContain('400 кг');
    expect(payload.productCards.map((card) => card.id)).toEqual(['plate-95', 'plate-80']);
    expect(metadata.productCards?.map((card) => card.id)).toEqual(['plate-95', 'plate-80']);
    expect(metadata.cardSelection?.selectedProductIds).toEqual(['plate-95', 'plate-80']);
    expect(metadata.answerProductEvidence?.droppedProductIds).toEqual([
      'grost-vh-400d',
      'masterpac-pcr7060h2',
      'husqvarna-lg-400'
    ]);
    expect(metadata.answerProductEvidence?.warnings).toEqual(expect.arrayContaining([
      expect.stringContaining('plate_task_weight_mismatch')
    ]));
    expect(metadata.warnings).toEqual(expect.arrayContaining([
      expect.stringContaining('plate_task_weight_mismatch')
    ]));
    expect(metadata.answerProductEvidence?.plateTaskPolicy?.maxPracticalWeightKg).toBe(120);
    expect(metadata.answerProductEvidence?.replacementProductIds).toEqual(['plate-95', 'plate-80']);
    expect(metadata.replacementProductEvidence?.productIds).toEqual(['plate-95', 'plate-80']);
    expect(metadata.replacementProductEvidence?.warnings).toContain('answer_products_replaced_by_plate_task_search');
    expect(metadata.toolResults?.map((result) => result.requestId)).toContain('catalog-search:plate-replacement');
    expect(metadata.toolResults?.find((result) => result.requestId === 'catalog-search:plate-replacement')?.payload?.productIds).toEqual(['plate-95', 'plate-80']);
    expect(metadata.preSendReview?.issues?.map((issue) => issue.code)).not.toContain('plate_previous_cards_unsuitable_for_current_task');
  });

  it('routes high-risk source disagreements to adjudication instead of sending a final answer', async () => {
    const conversations = new FakeConversations();
    const conflictModel = model({
      async composeAnswer() {
        return {
          answerText: 'I will choose one conflicting value as final.',
          factsUsed: [],
          questionsAsked: [],
          toolResultIds: [],
          leadAction: 'none',
          riskFlags: ['high_risk_disagreement']
        };
      }
    });
    const orchestrator = new AgentManagerOrchestrator(conversations as never, new FakeProducts() as never, new FakeLeads() as never, conflictModel);

    await expect(orchestrator.generateAnswer({
      sessionId,
      turnId,
      userMessage: 'Compare two models with conflicting specs.'
    })).rejects.toThrow(/requires_adjudication/);
    expect(conversations.assistantSaves).toHaveLength(0);
  });

  it('forces one catalog fact review that corrects a false price and specification even with factsUsed empty', async () => {
    const previousMode = config.AI_MANAGER_REVIEW_MODE;
    config.AI_MANAGER_REVIEW_MODE = 'risk';
    class ExactFactProducts extends FakeProducts {
      override async searchProducts() {
        return [product('p1', 'TSS SGG 5000A generator'), product('p2', 'TSS SGG 6000B generator')];
      }
    }
    const conversations = new FakeConversations();
    let reviewCall = 0;
    const reviewAnswer = vi.fn(async (input: Parameters<AgentManagerModel['reviewAnswer']>[0]) => {
      reviewCall += 1;
      if (reviewCall === 1) {
        expect(input.answer.answerText).toContain('99 999');
        expect(input.answer.answerText).toContain('девять киловатт');
        expect(input.answer.factsUsed).toEqual([]);
        expect(input.products.find((item) => item.id === 'p1')).toMatchObject({
          price: 1000,
          specs: { power: '5 kW' }
        });
        return {
          verdict: 'rewrite_required' as const,
          issues: [{
            code: 'catalog_fact_mismatch',
            severity: 'high' as const,
            message: 'The generated price and power do not match the product evidence.',
            evidence: 'p1'
          }],
          revisedAnswerText: 'TSS SGG 5000A стоит 1 000 ₽; его мощность — 5 кВт.'
        };
      }
      expect(input.answer.answerText).toBe('TSS SGG 5000A стоит 1 000 ₽; его мощность — 5 кВт.');
      return { verdict: 'pass' as const, issues: [] };
    });
    const factModel = model({
      async planTurn() {
        return structuredGeneratorCatalogIntent();
      },
      async composeAnswer(input) {
        expect(input.products.map((item) => item.id)).toEqual(['p1', 'p2']);
        return {
          answerText: 'TSS SGG 5000A стоит 99 999 ₽; его мощность — девять киловатт.',
          factsUsed: [],
          questionsAsked: [],
          toolResultIds: ['catalog-search'],
          selectedProductIds: ['p1'],
          leadAction: 'none',
          riskFlags: [],
          selectionReadiness: {
            status: 'ready_for_exact_cards',
            rationale: 'p1 was selected from catalog evidence',
            missingFacts: [],
            productClass: 'generator',
            canShowProductCards: true
          }
        };
      },
      reviewAnswer
    });
    const orchestrator = new AgentManagerOrchestrator(
      conversations as never,
      new ExactFactProducts() as never,
      new FakeLeads() as never,
      factModel
    );

    try {
      const payload = await orchestrator.generateAnswer({
        sessionId,
        turnId,
        userMessage: 'Посоветуйте TSS SGG 5000A и назовите точную цену и мощность.'
      });

      expect(reviewAnswer).toHaveBeenCalledTimes(1);
      expect(payload.answer).toBe('TSS SGG 5000A стоит 1 000 ₽; его мощность — 5 кВт.');
      expect(payload.answer).not.toContain('99 999');
      expect(payload.answer).not.toContain('девять киловатт');
      expect(
        payload.productCards.map((card) => card.id),
        JSON.stringify({
          cardSelection: payload.metadata?.cardSelection,
          selectionReadiness: payload.metadata?.selectionReadiness,
          answerProductEvidence: payload.metadata?.answerProductEvidence
        })
      ).toEqual(['p1']);
      expect((payload.metadata?.managerPolicy as { reviewReason?: string })?.reviewReason)
        .toContain('catalog_product_evidence');
    } finally {
      config.AI_MANAGER_REVIEW_MODE = previousMode;
    }
  });

  it('blocks an unsafe reviewer rewrite deterministically without another reviewer call', async () => {
    const previousMode = config.AI_MANAGER_REVIEW_MODE;
    config.AI_MANAGER_REVIEW_MODE = 'risk';
    class ExactFactProducts extends FakeProducts {
      override async searchProducts() {
        return [product('p1', 'TSS SGG 5000A generator')];
      }
    }
    const conversations = new FakeConversations();
    const reviewAnswer = vi.fn(async () => ({
      verdict: 'rewrite_required' as const,
      issues: [{
        code: 'style_rewrite',
        severity: 'low' as const,
        message: 'Reviewer chose to rephrase the supported answer.',
        evidence: 'answer'
      }],
      revisedAnswerText: 'TSS SGG 7000B costs 99 999 RUB and has 9 kW.'
    }));
    const unsafeReviewerModel = model({
      async planTurn() {
        return structuredGeneratorCatalogIntent();
      },
      async composeAnswer() {
        return {
          answerText: 'TSS SGG 5000A costs 1 000 RUB and has 5 kW.',
          factsUsed: [],
          questionsAsked: [],
          toolResultIds: ['catalog-search'],
          selectedProductIds: ['p1'],
          leadAction: 'none',
          riskFlags: [],
          selectionReadiness: {
            status: 'ready_for_exact_cards' as const,
            rationale: 'p1 was selected from catalog evidence',
            missingFacts: [],
            productClass: 'generator',
            canShowProductCards: true
          }
        };
      },
      reviewAnswer
    });
    const orchestrator = new AgentManagerOrchestrator(
      conversations as never,
      new ExactFactProducts() as never,
      new FakeLeads() as never,
      unsafeReviewerModel
    );

    try {
      await expect(orchestrator.generateAnswer({
        sessionId,
        turnId,
        userMessage: 'Give me the exact catalog price and power for TSS SGG 5000A.'
      })).rejects.toThrow('review_rewrite_unsupported');
      expect(reviewAnswer).toHaveBeenCalledTimes(1);
      expect(conversations.assistantSaves).toHaveLength(0);
    } finally {
      config.AI_MANAGER_REVIEW_MODE = previousMode;
    }
  });

  it('semantically reviews a partial mechanical rewrite so a false catalog claim cannot survive contact cleanup', async () => {
    const previousMode = config.AI_MANAGER_REVIEW_MODE;
    config.AI_MANAGER_REVIEW_MODE = 'risk';
    class ExactFactProducts extends FakeProducts {
      override async searchProducts() {
        return [product('p1', 'TSS SGG 5000A generator')];
      }
    }
    const conversations = new FakeConversations();
    let reviewCall = 0;
    const reviewAnswer = vi.fn(async (input: Parameters<AgentManagerModel['reviewAnswer']>[0]) => {
      reviewCall += 1;
      if (reviewCall === 1) {
        expect(input.answer.answerText).toContain('99 999');
        expect(input.answer.answerText).not.toContain('Оставьте номер телефона');
        return {
          verdict: 'rewrite_required' as const,
          issues: [{
            code: 'catalog_price_mismatch',
            severity: 'high' as const,
            message: 'The price differs from current catalog evidence.',
            evidence: 'p1'
          }],
          revisedAnswerText: 'TSS SGG 5000A стоит 1 000 ₽.'
        };
      }
      expect(input.answer.answerText).toBe('TSS SGG 5000A стоит 1 000 ₽.');
      return { verdict: 'pass' as const, issues: [] };
    });
    const unsafeModel = model({
      async planTurn() {
        return structuredGeneratorCatalogIntent();
      },
      async composeAnswer() {
        return {
          answerText: 'TSS SGG 5000A стоит 99 999 ₽. Оставьте номер телефона.',
          factsUsed: [],
          questionsAsked: [],
          toolResultIds: ['catalog-search'],
          selectedProductIds: ['p1'],
          leadAction: 'none',
          riskFlags: [],
          selectionReadiness: {
            status: 'ready_for_exact_cards',
            rationale: 'catalog product selected',
            missingFacts: [],
            productClass: 'generator',
            canShowProductCards: true
          }
        };
      },
      reviewAnswer
    });
    const orchestrator = new AgentManagerOrchestrator(
      conversations as never,
      new ExactFactProducts() as never,
      new FakeLeads() as never,
      unsafeModel
    );

    try {
      const payload = await orchestrator.generateAnswer({
        sessionId,
        turnId,
        userMessage: 'Мой номер +7 900 000-00-11. Сколько стоит TSS SGG 5000A?'
      });

      expect(reviewAnswer).toHaveBeenCalledTimes(1);
      expect(payload.answer).toBe('TSS SGG 5000A стоит 1 000 ₽.');
      expect(payload.answer).not.toContain('99 999');
      expect(payload.answer).not.toContain('Оставьте номер');
    } finally {
      config.AI_MANAGER_REVIEW_MODE = previousMode;
    }
  });

  it('blocks a selected product id that was never present in writer evidence', async () => {
    const conversations = new FakeConversations();
    const unsafeModel = model({
      async composeAnswer() {
        return {
          answerText: 'I recommend Ghost Generator.',
          factsUsed: [],
          questionsAsked: [],
          toolResultIds: [],
          selectedProductIds: ['ghost-product'],
          leadAction: 'none',
          riskFlags: []
        };
      }
    });
    const orchestrator = new AgentManagerOrchestrator(
      conversations as never,
      new FakeProducts() as never,
      new FakeLeads() as never,
      unsafeModel
    );

    await expect(orchestrator.generateAnswer({
      sessionId,
      turnId,
      userMessage: 'Recommend a model.'
    })).rejects.toThrow('selected_product_without_evidence');
    expect(conversations.assistantSaves).toHaveLength(0);
  });

  it('semantically rewrites and rechecks a question already answered in the dialogue ledger', async () => {
    const conversations = new FakeConversations();
    const closedQuestionDelta = {
      rationale: 'the buyer has already supplied the requested power',
      events: [{
        eventType: 'question.asked' as const,
        scope: 'question' as const,
        payload: { questionId: 'q.coffee_power', text: 'Какая мощность кофемашины?', needId: 'generator' },
        evidence: 'earlier manager question',
        source: 'llm_state_delta' as const,
        status: 'active' as const
      }, {
        eventType: 'question.answered' as const,
        scope: 'question' as const,
        payload: { questionId: 'q.coffee_power', answer: '3.2 kW', needId: 'generator' },
        evidence: 'Кофемашина 3,2 кВт',
        source: 'llm_state_delta' as const,
        status: 'closed' as const
      }]
    };
    let reviewCall = 0;
    const reviewAnswer = vi.fn(async (input: Parameters<AgentManagerModel['reviewAnswer']>[0]) => {
      reviewCall += 1;
      if (reviewCall === 1) {
        expect(input.answer.questionsAsked.map((question) => question.questionId)).toContain('q.coffee_power');
        return {
          verdict: 'rewrite_required' as const,
          issues: [{
            code: 'repeat_answered_question',
            severity: 'high' as const,
            message: 'Use the already supplied load and move the selection forward.',
            evidence: 'q.coffee_power'
          }],
          revisedAnswerText: 'Мощность 3,2 кВт уже учёл. Теперь рассчитаю пусковой запас и предложу подходящий генератор.'
        };
      }
      expect(input.answer.questionsAsked).toEqual([]);
      expect(input.answer.answerText).toContain('уже учёл');
      return { verdict: 'pass' as const, issues: [] };
    });
    const closedQuestionModel = model({
      async proposeLedgerDelta() {
        return closedQuestionDelta;
      },
      async composeAnswer() {
        return {
          answerText: 'Какая мощность кофемашины?',
          factsUsed: [],
          questionsAsked: [{
            questionId: 'q.coffee_power',
            text: 'Какая мощность кофемашины?',
            reason: 'unsafe repeated question'
          }],
          toolResultIds: [],
          leadAction: 'none',
          riskFlags: []
        };
      },
      reviewAnswer
    });
    const orchestrator = new AgentManagerOrchestrator(
      conversations as never,
      new FakeProducts() as never,
      new FakeLeads() as never,
      closedQuestionModel
    );

    const payload = await orchestrator.generateAnswer({
      sessionId,
      turnId,
      userMessage: 'Кофемашина 3,2 кВт.'
    });

    expect(reviewAnswer).toHaveBeenCalledTimes(2);
    expect(payload.answer).toContain('уже учёл');
    expect(payload.answer).not.toBe('Какая мощность кофемашины?');
    expect((payload.metadata?.answerContract as { questionsAsked?: unknown[] })?.questionsAsked).toEqual([]);
  });

  it('filters strict ceramic blade evidence before the answer writer sees catalog products', async () => {
    class BladeProducts extends FakeProducts {
      override async searchProducts() {
        return [{
          ...product('ceramic-blade', 'TSS CERAMIC 350 diamond blade', 'Diamond blades'),
          specs: { application: 'porcelain tile ceramic' }
        }, {
          ...product('concrete-blade', 'TSS CONCRETE 350 diamond blade', 'Diamond blades'),
          specs: { application: 'concrete reinforced concrete' }
        }];
      }
    }
    const conversations = new FakeConversations();
    const bladeModel = model({
      async planTurn() {
        return {
          userMessageSummary: 'buyer needs a diamond blade for ceramic tile',
          dialogueUnderstanding: 'ceramic compatibility is a strict requirement',
          nextStepRationale: 'search catalog and expose only products with deterministic ceramic evidence',
          requiresTools: true,
          toolRequests: [{
            id: 'blade-search',
            tool: 'catalog.search',
            args: {
              query: 'diamond blade 350 ceramic tile',
              semanticQuery: 'diamond blade for porcelain ceramic tile',
              productIntent: 'diamondBlade',
              canonicalProductIntent: 'diamondBlade',
              limit: 4
            },
            rationale: 'find exact ceramic-compatible blades',
            required: true
          }],
          productMentions: [],
          selectionPolicy: {
            targetProductClass: 'diamond blade',
            canonicalProductClass: 'diamondBlade',
            needAction: 'continue' as const,
            alternativePolicy: 'same_class_only' as const,
            reusePreviousCards: false,
            maxCards: 4,
            powerSource: 'any' as const,
            phase: 'any' as const,
            requirements: [{
              id: 'ceramic-material',
              kind: 'material',
              value: 'ceramic',
              unit: null,
              role: 'hard_constraint' as const,
              strictness: 'strict' as const,
              evidence: 'для керамической плитки'
            }],
            rationale: 'concrete-only products are not admissible alternatives'
          },
          policyRuleIds: [],
          grounding: {
            taskType: 'product_selection' as const,
            sourcePolicy: 'catalog_required' as const,
            webPurpose: 'none' as const,
            requiredToolKinds: ['catalog.search' as const],
            technicalAttributes: ['application material'],
            rationale: 'catalog evidence must prove ceramic compatibility'
          },
          mustNotAskQuestionIds: [],
          riskFlags: []
        };
      },
      async composeAnswer(input) {
        expect(input.products.map((item) => item.id)).toEqual(['ceramic-blade']);
        return {
          answerText: 'TSS CERAMIC 350 подходит для керамической плитки.',
          factsUsed: [],
          questionsAsked: [],
          toolResultIds: ['blade-search'],
          selectedProductIds: ['ceramic-blade'],
          leadAction: 'none',
          riskFlags: [],
          selectionReadiness: {
            status: 'ready_for_exact_cards' as const,
            rationale: 'ceramic use is supported by exact catalog text',
            missingFacts: [],
            productClass: 'diamondBlade',
            canShowProductCards: true
          }
        };
      }
    });
    const orchestrator = new AgentManagerOrchestrator(
      conversations as never,
      new BladeProducts() as never,
      new FakeLeads() as never,
      bladeModel
    );

    const payload = await orchestrator.generateAnswer({
      sessionId,
      turnId,
      userMessage: 'Нужен алмазный диск 350 мм строго для керамической плитки.'
    });

    expect(payload.productCards.map((card) => card.id)).toEqual(['ceramic-blade']);
    expect(payload.productCards.map((card) => card.id)).not.toContain('concrete-blade');
  });

  it('rejects a fact from a paused need when a different need is active', async () => {
    const scopedDelta = {
      rationale: 'switch from generator selection to a current plate need',
      events: [{
        eventType: 'need.opened',
        scope: 'need',
        payload: {
          needId: 'generator',
          productClass: 'generator',
          summary: 'old generator need',
          constraints: [],
          openQuestions: [],
          selectedProductIds: [],
          rejectedProductIds: [],
          status: 'open',
          activate: true
        },
        evidence: 'old generator request',
        source: 'llm_state_delta',
        status: 'active'
      }, {
        eventType: 'fact.confirmed',
        scope: 'dialogue',
        payload: {
          factKey: 'generator.budget',
          value: 70_000,
          needId: 'generator',
          productClass: 'generator',
          role: 'hard_requirement'
        },
        evidence: 'generator budget 70000',
        source: 'llm_state_delta',
        status: 'active'
      }, {
        eventType: 'need.opened',
        scope: 'need',
        payload: {
          needId: 'plate',
          productClass: 'plate',
          summary: 'current plate need',
          constraints: [],
          openQuestions: [],
          selectedProductIds: [],
          rejectedProductIds: [],
          status: 'open',
          activate: true
        },
        evidence: 'now need a plate compactor',
        source: 'llm_state_delta',
        status: 'active'
      }]
    } satisfies LedgerStateDelta;
    const oldFactEventId = normalizeLedgerStateDeltaEvents({
      sessionId,
      turnId,
      delta: scopedDelta
    })[1]!.eventId;
    const conversations = new FakeConversations();
    const unsafeModel = model({
      async proposeLedgerDelta() {
        return scopedDelta;
      },
      async planTurn() {
        return {
          userMessageSummary: 'current plate request',
          dialogueUnderstanding: 'the active need is a plate compactor, not the paused generator',
          nextStepRationale: 'answer only from current-need evidence',
          requiresTools: false,
          toolRequests: [],
          productMentions: [],
          selectionPolicy: {
            ...currentNoProductSelectionPolicy(),
            targetProductClass: 'plate',
            canonicalProductClass: 'plate',
            rationale: 'current plate need has no product cards yet'
          },
          policyRuleIds: [],
          mustNotAskQuestionIds: [],
          riskFlags: []
        };
      },
      async composeAnswer() {
        return {
          answerText: 'Для виброплиты действует старый бюджет генератора 70 000 рублей.',
          factsUsed: [{
            factKey: 'generator.budget',
            sourceEventIds: [oldFactEventId],
            value: 70_000
          }],
          questionsAsked: [],
          toolResultIds: [],
          selectedProductIds: [],
          leadAction: 'none',
          riskFlags: []
        };
      }
    });
    const orchestrator = new AgentManagerOrchestrator(
      conversations as never,
      new FakeProducts() as never,
      new FakeLeads() as never,
      unsafeModel
    );

    await expect(orchestrator.generateAnswer({
      sessionId,
      turnId,
      userMessage: 'Теперь нужна виброплита.'
    })).rejects.toThrow('unsupported_fact_source');
    expect(conversations.assistantSaves).toHaveLength(0);
  });

  it('persists an artifact for every planned tool when the ninth call exceeds the turn tool budget', async () => {
    const conversations = new FakeConversations();
    const toolRequests: ToolRequest[] = Array.from({ length: 9 }, (_, index) => ({
      id: `calculator-${index + 1}`,
      tool: 'calculator.generatorLoad' as const,
      args: {
        query: 'generator for explicit 1 kW load',
        productIntent: 'generator',
        canonicalProductIntent: 'generator',
        loads: [{
          kind: 'resistive',
          name: 'explicit load',
          count: 1,
          runningKw: 1,
          startingKw: 1,
          source: 'explicit_user',
          evidence: '1 kW',
          basisKind: 'exact_power',
          basisSignals: ['explicit_power']
        }],
        simultaneousStarting: false,
        simultaneousStartingKinds: [],
        estimateBasis: 'exact_or_user_provided'
      },
      rationale: `budget artifact regression ${index + 1}`,
      required: true
    }));
    const budgetModel = model({
      async planTurn() {
        return {
          userMessageSummary: 'exercise bounded tool execution',
          dialogueUnderstanding: 'each planned tool must leave a durable result, including budget-stopped calls',
          nextStepRationale: 'run the typed calculations until the tool budget stops execution',
          requiresTools: true,
          toolRequests,
          productMentions: [],
          selectionPolicy: currentNoProductSelectionPolicy(),
          policyRuleIds: [],
          mustNotAskQuestionIds: [],
          riskFlags: []
        };
      },
      composeAnswer: vi.fn(async () => {
        throw new Error('writer must not run after the tool budget stop');
      })
    });
    const orchestrator = new AgentManagerOrchestrator(
      conversations as never,
      new FakeProducts() as never,
      new FakeLeads() as never,
      budgetModel
    );

    const payload = await orchestrator.generateAnswer({
      sessionId,
      turnId,
      userMessage: 'Run the bounded calculations.'
    });

    expect(payload.answer).toContain('Расчёт нагрузки завершён');
    expect(payload.answer).toContain('не менее 1 кВт');
    expect(payload.answer).not.toContain('продолжите разговор новым сообщением');
    expect(payload.metadata).toMatchObject({
      terminal: true,
      degraded: true,
      completionStatus: 'degraded_terminal',
      terminalReason: 'turn_budget_tool_call_budget_exceeded',
      answerContract: {
        factsUsed: [expect.objectContaining({
          factKey: 'calculator.generator_load_profile',
          sourceEventIds: ['calculator-8']
        })]
      }
    });
    expect(conversations.turn.status).toBe('completed');

    expect(conversations.toolArtifacts).toHaveLength(9);
    expect(new Set(conversations.toolArtifacts.map((artifact) =>
      (artifact as { toolRequestId?: string }).toolRequestId
    )).size).toBe(9);
    expect(conversations.toolArtifacts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        toolRequestId: 'calculator-9',
        status: 'error',
        errorCode: 'tool_call_budget_exceeded'
      })
    ]));
    expect(conversations.turn).toMatchObject({
      status: 'completed'
    });
  });

  it('replays five turns without losing a validated product after noisy searches or an intervening technical answer', async () => {
    const secondTurnId = '77777777-7777-4777-8777-777777777777';
    const thirdTurnId = '88888888-8888-4888-8888-888888888888';
    const fourthTurnId = '99999999-9999-4999-8999-999999999999';
    const fifthTurnId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    class TwoTurnConversations extends FakeConversations {
      currentSession = session();
      ledgerRows: Array<Record<string, unknown>> = [];
      checkpointRows: Array<Record<string, unknown>> = [];
      toolRows: Array<Record<string, unknown>> = [];

      override async getSession() {
        return this.currentSession;
      }

      async updateNeedState(_sessionId: string, needState: ConversationSession['needState']) {
        this.currentSession = { ...this.currentSession, needState };
        return this.currentSession;
      }

      override async listDialogueLedgerEvents() {
        return this.ledgerRows;
      }

      override async upsertDialogueLedgerEvent(input: Record<string, unknown>) {
        this.ledgerEvents.push(input);
        const row = {
          session_id: input.sessionId,
          turn_id: input.turnId,
          event_id: input.eventId,
          event_type: input.eventType,
          scope: input.scope,
          payload: input.payload,
          evidence: input.evidence,
          source: input.source,
          status: input.status,
          event_seq: this.ledgerRows.length + 1
        };
        const existing = this.ledgerRows.findIndex((item) => item.event_id === input.eventId);
        if (existing >= 0) this.ledgerRows[existing] = row;
        else this.ledgerRows.push(row);
        return input;
      }

      override async upsertTurnCheckpoint(input: Record<string, unknown>) {
        this.checkpoints.push(input);
        this.checkpointRows.push(input);
        return input;
      }

      override async listTurnCheckpoints(_sessionId?: string, requestedTurnId?: string) {
        return this.checkpointRows.filter((item) => item.turnId === requestedTurnId);
      }

      override async saveToolArtifact(input: Record<string, unknown>) {
        this.toolArtifacts.push(input);
        this.toolRows.push(input);
        return input;
      }

      override async listToolArtifacts(_sessionId?: string, requestedTurnId?: string) {
        return this.toolRows.filter((item) => item.turnId === requestedTurnId);
      }
    }
    class ReusableProducts extends FakeProducts {
      searchCalls = 0;
      override async searchProducts() {
        this.searchCalls += 1;
        if (this.searchCalls > 1) {
          return [product('new-but-unusable', 'Vibroplita unrelated search noise', 'vibroplity')];
        }
        return [
          product('p1', 'TSS SGG 5000A generator'),
          product('p2', 'TSS SGG 6000B generator')
        ];
      }
    }
    const conversations = new TwoTurnConversations();
    conversations.messages = [message('Подберите генератор из каталога.')];
    let turnNumber = 0;
    const managerModel = model({
      async proposeLedgerDelta() {
        turnNumber += 1;
        return {
          rationale: turnNumber === 1 ? 'open generator need' : 'resume the same generator need',
          events: [{
            eventType: turnNumber === 1 ? 'need.opened' as const : 'need.updated' as const,
            scope: 'need' as const,
            payload: {
              needId: 'generator',
              productClass: 'generator',
              summary: 'подбор генератора',
              constraints: [],
              openQuestions: [],
              ...(turnNumber === 1 ? {} : { selectedProductIds: [] }),
              status: turnNumber === 1 ? 'open' : 'selected',
              activate: true
            },
            evidence: turnNumber === 1 ? 'Подберите генератор' : 'Вернёмся к выбранному генератору',
            source: 'llm_state_delta' as const,
            status: 'active' as const
          }]
        };
      },
      async planTurn() {
        const intent = structuredGeneratorCatalogIntent();
        if (turnNumber === 1) return intent;
        if (turnNumber === 3) {
          return {
            ...intent,
            requiresTools: false,
            toolRequests: [],
            grounding: {
              taskType: 'technical_answer' as const,
              sourcePolicy: 'conversation_only' as const,
              webPurpose: 'none' as const,
              requiredToolKinds: [],
              technicalAttributes: [],
              rationale: 'answer a general maintenance follow-up without changing the saved selection'
            },
            selectionPolicy: {
              ...intent.selectionPolicy!,
              needAction: 'continue' as const,
              reusePreviousCards: false,
              maxCards: 0,
              rationale: 'this maintenance follow-up does not need visible cards'
            }
          };
        }
        return {
          ...intent,
          requiresTools: true,
          grounding: {
            taskType: 'product_selection' as const,
            sourcePolicy: 'catalog_required' as const,
            webPurpose: 'none' as const,
            requiredToolKinds: ['catalog.search' as const],
            technicalAttributes: ['price', 'power'],
            rationale: 'recheck the current catalog while preserving the validated active-need selection'
          },
          selectionPolicy: {
            ...intent.selectionPolicy!,
            needAction: 'resume' as const,
            selectionGoal: 'preliminary_fit' as const,
            reusePreviousCards: false,
            maxCards: 1,
            rationale: 'the new search must not erase a still-valid previous selection even if it returns noise'
          }
        };
      },
      async composeAnswer(input) {
        if (turnNumber === 1) {
          expect(input.products.map((item) => item.id)).toEqual(['p1', 'p2']);
        } else if (turnNumber === 2) {
          expect(
            input.products.map((item) => item.id),
            JSON.stringify({
              toolRequests: input.intent.toolRequests,
              toolResults: input.toolResults,
              activeNeeds: input.ledgerState.needsById
            })
          ).toEqual(['p1']);
        } else if (turnNumber === 3) {
          expect(input.products).toEqual([]);
          return {
            answerText: 'По обслуживанию ориентируйтесь на регламент производителя; выбранный ранее вариант я сохраняю в контексте.',
            factsUsed: [],
            questionsAsked: [],
            toolResultIds: [],
            selectedProductIds: [],
            leadAction: 'none',
            riskFlags: [],
            selectionReadiness: {
              status: 'needs_more_info' as const,
              rationale: 'no product cards are needed for this maintenance follow-up',
              missingFacts: [],
              productClass: 'generator',
              canShowProductCards: false
            }
          };
        }
        return {
          answerText: 'Возвращаемся к TSS SGG 5000A — это выбранный вариант.',
          factsUsed: [],
          questionsAsked: [],
          toolResultIds: turnNumber === 3 ? [] : ['catalog-search'],
          selectedProductIds: ['p1'],
          leadAction: 'none',
          riskFlags: [],
          selectionReadiness: {
            status: 'ready_for_exact_cards' as const,
            rationale: 'the exact saved card remains relevant',
            missingFacts: [],
            productClass: 'generator',
            canShowProductCards: true
          }
        };
      }
    });
    const orchestrator = new AgentManagerOrchestrator(
      conversations as never,
      new ReusableProducts() as never,
      new FakeLeads() as never,
      managerModel
    );

    const first = await orchestrator.generateAnswer({
      sessionId,
      turnId,
      userMessage: 'Подберите генератор из каталога.'
    });
    expect(first.productCards.map((card) => card.id)).toEqual(['p1']);
    expect((first.metadata?.answerContract as { selectedProductIds?: string[] })?.selectedProductIds).toEqual(['p1']);
    const persistedSelection = conversations.ledgerRows.find((row) =>
      row.source === 'system_reducer' &&
      (row.payload as { selectedProductIds?: string[] })?.selectedProductIds?.includes('p1')
    );
    expect(persistedSelection).toBeTruthy();

    const secondUser = { ...message('Вернёмся к выбранному генератору.'), id: 'second-user-message' };
    conversations.messages.push(secondUser);
    conversations.turn = {
      ...turn(),
      id: secondTurnId,
      userMessageId: secondUser.id,
      assistantMessageId: null,
      status: 'received'
    };
    const second = await orchestrator.generateAnswer({
      sessionId,
      turnId: secondTurnId,
      userMessage: secondUser.content
    });

    expect(second.productCards.map((card) => card.id), JSON.stringify({
      cardSelection: second.metadata?.cardSelection,
      selectionReadiness: second.metadata?.selectionReadiness,
      answerProductEvidence: second.metadata?.answerProductEvidence,
      toolResults: second.metadata?.toolResults
    })).toEqual(['p1']);
    expect(second.productCards.map((card) => card.id)).not.toContain('p2');
    expect((second.metadata?.answerContract as { selectedProductIds?: string[] })?.selectedProductIds).toEqual(['p1']);
    expect((second.metadata?.cardSelection as { warnings?: string[] })?.warnings)
      .toContain('product_cards_reused_from_previous_turn');

    const thirdUser = { ...message('А по обслуживанию что важно?'), id: 'third-user-message' };
    conversations.messages.push(thirdUser);
    conversations.turn = {
      ...turn(),
      id: thirdTurnId,
      userMessageId: thirdUser.id,
      assistantMessageId: null,
      status: 'received'
    };
    const third = await orchestrator.generateAnswer({
      sessionId,
      turnId: thirdTurnId,
      userMessage: thirdUser.content
    });

    expect(third.productCards).toEqual([]);
    expect(conversations.currentSession.needState.activeNeeds.find((need) => need.id === 'generator')?.selectedProductIds)
      .toEqual(['p1']);

    const fourthUser = { ...message('Покажите ближайший вариант ещё раз.'), id: 'fourth-user-message' };
    conversations.messages.push(fourthUser);
    conversations.turn = {
      ...turn(),
      id: fourthTurnId,
      userMessageId: fourthUser.id,
      assistantMessageId: null,
      status: 'received'
    };
    const fourth = await orchestrator.generateAnswer({
      sessionId,
      turnId: fourthTurnId,
      userMessage: fourthUser.content
    });
    expect(fourth.productCards.map((card) => card.id)).toEqual(['p1']);

    const fifthUser = { ...message('Подтвердите: ранее показанный TSS SGG 5000A всё ещё считается кандидатом?'), id: 'fifth-user-message' };
    conversations.messages.push(fifthUser);
    conversations.turn = {
      ...turn(),
      id: fifthTurnId,
      userMessageId: fifthUser.id,
      assistantMessageId: null,
      status: 'received'
    };
    const fifth = await orchestrator.generateAnswer({
      sessionId,
      turnId: fifthTurnId,
      userMessage: fifthUser.content
    });
    expect(fifth.answer).toContain('TSS SGG 5000A');
    expect(fifth.productCards.map((card) => card.id)).toEqual(['p1']);
    expect(conversations.currentSession.needState.activeNeeds.find((need) => need.id === 'generator')?.selectedProductIds)
      .toEqual(['p1']);
  });

  it('does not downgrade a completed turn when the wall deadline crosses during durable finalization', async () => {
    let now = 10_000;
    const dateNow = vi.spyOn(Date, 'now').mockImplementation(() => now);
    class DeadlineCrossingConversations extends FakeConversations {
      override async addAssistantMessageForTurn(input: Parameters<FakeConversations['addAssistantMessageForTurn']>[0]) {
        const saved = await super.addAssistantMessageForTurn(input);
        if (saved) now += 110_001;
        return saved;
      }
    }
    const conversations = new DeadlineCrossingConversations();
    const orchestrator = new AgentManagerOrchestrator(
      conversations as never,
      new FakeProducts() as never,
      new FakeLeads() as never,
      model()
    );

    try {
      const payload = await orchestrator.generateAnswer({
        sessionId,
        turnId,
        userMessage: 'Coffee machine 3.2 kW, grinder 400 W, is 5 kW enough?'
      });

      expect(payload.answer).toContain('5 kW');
      expect(conversations.assistantSaves).toHaveLength(1);
      expect(conversations.turn.status).toBe('completed');
      expect(conversations.answerContracts).toEqual(expect.arrayContaining([
        expect.objectContaining({ status: 'final' })
      ]));
    } finally {
      dateNow.mockRestore();
    }
  });

  it('does not persist unseen selected card ids when the finalization deadline gate fails', async () => {
    let now = 20_000;
    const dateNow = vi.spyOn(Date, 'now').mockImplementation(() => now);
    class DeadlineBeforeCommitConversations extends FakeConversations {
      override async saveAnswerContract(input: { status?: string }) {
        const saved = await super.saveAnswerContract(input);
        if (input.status === 'draft') now += 110_001;
        return saved;
      }
    }
    class ExactProducts extends FakeProducts {
      override async searchProducts() {
        return [product('p1', 'TSS SGG 5000A generator')];
      }
    }
    const conversations = new DeadlineBeforeCommitConversations();
    const deadlineModel = model({
      async planTurn() {
        return structuredGeneratorCatalogIntent();
      },
      async composeAnswer() {
        return {
          answerText: 'TSS SGG 5000A — выбранный вариант.',
          factsUsed: [],
          questionsAsked: [],
          toolResultIds: ['catalog-search'],
          selectedProductIds: ['p1'],
          leadAction: 'none',
          riskFlags: [],
          selectionReadiness: {
            status: 'ready_for_exact_cards' as const,
            rationale: 'catalog product selected',
            missingFacts: [],
            productClass: 'generator',
            canShowProductCards: true
          }
        };
      }
    });
    const orchestrator = new AgentManagerOrchestrator(
      conversations as never,
      new ExactProducts() as never,
      new FakeLeads() as never,
      deadlineModel
    );

    try {
      await expect(orchestrator.generateAnswer({
        sessionId,
        turnId,
        userMessage: 'Покажите TSS SGG 5000A.'
      })).rejects.toThrow('wall_time_budget_exceeded');

      expect(conversations.ledgerEvents).not.toEqual(expect.arrayContaining([
        expect.objectContaining({
          source: 'system_reducer',
          payload: expect.objectContaining({ selectedProductIds: ['p1'] })
        })
      ]));
      expect(conversations.assistantSaves).toHaveLength(0);
      expect(conversations.turn.stage).toBe('budget_stopped');
    } finally {
      dateNow.mockRestore();
    }
  });

  it('recovers exact 5.5-6.0 kW single-phase catalog matches beyond the noisy first retrieval window', async () => {
    class RangeRecoveryProducts extends FakeProducts {
      calls: Array<{ query: string; limit: number }> = [];

      override async searchProducts(query = '', limit = 8) {
        this.calls.push({ query, limit });
        if (this.calls.length === 1) {
          return [
            {
              ...generatorProductWithPower('oversized-noise', 'Generator Noise 8.0 kW', 8),
              specs: { 'Nominal power': '8 kW', voltage: '220 V single phase' }
            },
            product('plate-noise', 'Vibroplita noise', 'vibroplity')
          ];
        }
        return [{
          ...generatorProductWithPower('range-55', 'A-iPower AP6000 5.5 kW generator', 5.5),
          price: 49990,
          specs: { 'Nominal power': '5.5 kW', voltage: '230 V single phase', Autostart: 'yes' }
        }, {
          ...generatorProductWithPower('range-60', 'ENERGO ED6500KL 6.0 kW generator', 6),
          price: 69990,
          specs: { 'Nominal power': '6 kW', voltage: '220 V single phase', Autostart: 'no' }
        }, {
          ...generatorProductWithPower('range-60-three-phase', 'Three phase 6.0 kW generator', 6),
          specs: { 'Nominal power': '6 kW', voltage: '380 V three phase' }
        }];
      }
    }

    const products = new RangeRecoveryProducts();
    const conversations = new FakeConversations();
    const intent = structuredGeneratorCatalogIntent();
    intent.selectionPolicy = {
      ...intent.selectionPolicy!,
      selectionGoal: 'browse_catalog',
      alternativePolicy: 'same_class_only',
      phase: 'single_phase',
      maxCards: 3,
      requirements: [{
        id: 'range-min',
        kind: 'nominal_power_min_kw',
        value: 5.5,
        unit: 'kW',
        relation: 'must_have',
        role: 'hard_constraint',
        strictness: 'strict',
        evidence: 'buyer requested from 5.5 kW',
        verification: { mode: 'product_attribute' }
      }, {
        id: 'range-max',
        kind: 'nominal_power_max_kw',
        value: 6,
        unit: 'kW',
        relation: 'must_have',
        role: 'hard_constraint',
        strictness: 'strict',
        evidence: 'buyer requested up to 6.0 kW',
        verification: { mode: 'product_attribute' }
      }, {
        id: 'autostart-optional',
        kind: 'autostart_required',
        value: false,
        unit: null,
        relation: 'not_required',
        role: 'preference',
        strictness: 'informational',
        evidence: 'automatic start is not needed',
        verification: { mode: 'product_attribute' }
      }]
    };
    intent.toolRequests[0] = {
      ...intent.toolRequests[0]!,
      args: {
        ...intent.toolRequests[0]!.args,
        query: 'home generator around six kilowatts',
        semanticQuery: 'single-phase generator 5.5 to 6.0 kW with prices',
        phase: 'single_phase',
        limit: 3
      },
      coversRequirementIds: ['range-min', 'range-max']
    };

    const orchestrator = new AgentManagerOrchestrator(
      conversations as never,
      products as never,
      new FakeLeads() as never,
      model({
        async planTurn() { return intent; },
        async composeAnswer(input) {
          expect(input.products.map((product) => product.id)).toEqual(['range-55', 'range-60']);
          return {
            answerText: 'Предварительно есть A-iPower AP6000 5.5 kW generator за 49 990 ₽ и ENERGO ED6500KL 6.0 kW generator за 69 990 ₽.',
            factsUsed: [],
            questionsAsked: [],
            toolResultIds: ['catalog-search'],
            selectedProductIds: ['range-55', 'range-60'],
            leadAction: 'none',
            riskFlags: [],
            selectionReadiness: {
              productClass: 'generator',
              status: 'ready_for_preliminary_cards',
              canShowProductCards: true,
              missingFacts: ['final load compatibility is not confirmed in browse mode'],
              rationale: 'The buyer asked to browse a confirmed power and phase range.'
            }
          };
        }
      })
    );

    const payload = await orchestrator.generateAnswer({
      sessionId,
      turnId,
      userMessage: 'Show single-phase options from 5.5 to 6.0 kW; autostart is not needed.'
    });
    const metadata = payload.metadata as {
      toolResults?: Array<{ payload?: { retrieval?: { structuredRecovery?: { attempted?: boolean; matchedCount?: number } } } }>;
    };

    expect(products.calls).toHaveLength(2);
    expect(products.calls[0]?.limit).toBeGreaterThanOrEqual(200);
    expect(products.calls[1]?.limit).toBe(1000);
    expect(payload.productCards.map((card) => card.id), JSON.stringify({
      cardSelection: payload.metadata?.cardSelection,
      selectionReadiness: payload.metadata?.selectionReadiness
    })).toEqual(['range-55', 'range-60']);
    expect(metadata.toolResults?.[0]?.payload?.retrieval?.structuredRecovery).toMatchObject({
      attempted: true,
      matchedCount: 2
    });
  });

  it('broadens and ranks same-class candidates when a typed preference objective is unmet by a full initial pool', async () => {
    class PreferenceRecoveryProducts extends FakeProducts {
      calls: Array<{ query: string; limit: number }> = [];

      override async searchProducts(query = '', limit = 8) {
        this.calls.push({ query, limit });
        if (this.calls.length === 1) {
          return [84, 95, 161, 250, 380, 518].map((weight) => ({
            ...product(`heavy-${weight}`, `Виброплита TEST Heavy-H${weight} (${weight} кг)`, 'Виброплиты'),
            specs: { weight: `${weight} kg` }
          }));
        }
        return [56, 67, 72, 84, 95].map((weight) => ({
          ...product(`plate-${weight}`, `Виброплита TEST Light-L${weight} (${weight} кг)`, 'Виброплиты'),
          specs: { weight: `${weight} kg` }
        }));
      }
    }

    const intent = structuredGeneratorCatalogIntent();
    intent.selectionPolicy = {
      targetProductClass: 'вибрационная плита',
      canonicalProductClass: 'plate',
      selectionGoal: 'preliminary_fit',
      needAction: 'open',
      alternativePolicy: 'same_class_only',
      reusePreviousCards: false,
      maxCards: 3,
      powerSource: 'any',
      phase: 'any',
      requirements: [{
        id: 'prefer-low-weight',
        kind: 'lightweight_design',
        value: true,
        unit: null,
        relation: 'preferred',
        role: 'preference',
        strictness: 'preferred',
        evidence: 'buyer wants a light machine for solo transport',
        verification: { mode: 'product_attribute' }
      }],
      rankingObjectives: [{
        requirementId: 'prefer-low-weight',
        attribute: 'weight_kg',
        direction: 'minimize'
      }],
      rationale: 'Rank plate compactors by the buyer-declared weight preference.'
    };
    intent.toolRequests[0] = {
      ...intent.toolRequests[0]!,
      args: {
        ...intent.toolRequests[0]!.args,
        query: 'лёгкая вибрационная плита для перевозки одним человеком',
        semanticQuery: 'минимальная масса виброплиты для самостоятельной перевозки',
        productIntent: 'вибрационная плита',
        canonicalProductIntent: 'plate',
        powerSource: 'any',
        phase: 'any',
        limit: 3
      },
      coversRequirementIds: ['prefer-low-weight']
    };
    intent.grounding = {
      taskType: 'product_selection',
      sourcePolicy: 'catalog_required',
      webPurpose: 'none',
      webRequirement: 'none',
      requiredToolKinds: ['catalog.search'],
      technicalAttributes: ['weight'],
      buyerQuestion: 'Нужна лёгкая вибрационная плита для перевозки одним человеком',
      rationale: 'Catalog must contain the candidates and their weights.'
    };

    const products = new PreferenceRecoveryProducts();
    const conversations = new FakeConversations();
    const orchestrator = new AgentManagerOrchestrator(
      conversations as never,
      products as never,
      new FakeLeads() as never,
      model({
        async planTurn() { return intent; },
        async composeAnswer(input) {
          expect(input.products.map((candidate) => candidate.id)).toEqual(['plate-56', 'plate-67', 'plate-72']);
          return {
            answerText: 'Самые лёгкие варианты: TEST Light-L56, TEST Light-L67 и TEST Light-L72.',
            factsUsed: [],
            questionsAsked: [],
            toolResultIds: ['catalog-search'],
            selectedProductIds: ['plate-56', 'plate-67', 'plate-72'],
            leadAction: 'none',
            riskFlags: [],
            selectionReadiness: {
              productClass: 'plate',
              status: 'ready_for_preliminary_cards',
              canShowProductCards: true,
              missingFacts: [],
              rationale: 'The lightest same-class catalog candidates satisfy the preference.'
            }
          };
        }
      })
    );

    const payload = await orchestrator.generateAnswer({
      sessionId,
      turnId,
      userMessage: 'Нужна лёгкая вибрационная плита, буду перевозить один.'
    });
    const metadata = payload.metadata as {
      toolResults?: Array<{ payload?: { retrieval?: { structuredRecovery?: { attempted?: boolean; matchedCount?: number } } } }>;
    };

    expect(products.calls).toHaveLength(2);
    expect(products.calls[0]?.limit).toBeGreaterThanOrEqual(200);
    expect(products.calls[1]?.limit).toBe(1000);
    expect(payload.productCards.map((card) => card.id), JSON.stringify({
      cardSelection: payload.metadata?.cardSelection,
      selectionReadiness: payload.metadata?.selectionReadiness,
      warnings: payload.metadata?.warnings
    })).toEqual(['plate-56', 'plate-67', 'plate-72']);
    expect(metadata.toolResults?.[0]?.payload?.retrieval?.structuredRecovery).toMatchObject({
      attempted: true,
      scannedCount: 5,
      matchedCount: 11
    });
  });

  it('does not broaden or reorder catalog candidates for an unbound preference objective', async () => {
    class UnboundPreferenceProducts extends FakeProducts {
      calls = 0;

      override async searchProducts() {
        this.calls += 1;
        return [95, 56].map((weight) => ({
          ...product(`plate-${weight}`, `Виброплита TEST Stable-S${weight} (${weight} кг)`, 'Виброплиты'),
          specs: { weight: `${weight} kg` }
        }));
      }
    }

    const intent = structuredGeneratorCatalogIntent();
    intent.selectionPolicy = {
      targetProductClass: 'виброплита',
      canonicalProductClass: 'plate',
      selectionGoal: 'preliminary_fit',
      needAction: 'open',
      alternativePolicy: 'same_class_only',
      reusePreviousCards: false,
      maxCards: 2,
      powerSource: 'any',
      phase: 'any',
      requirements: [],
      rankingObjectives: [{
        requirementId: 'missing-preference',
        attribute: 'weight_kg',
        direction: 'minimize'
      }],
      rationale: 'The objective is intentionally unbound for fail-safe coverage.'
    };
    intent.toolRequests[0] = {
      ...intent.toolRequests[0]!,
      args: {
        ...intent.toolRequests[0]!.args,
        query: 'виброплита',
        semanticQuery: 'виброплита',
        productIntent: 'виброплита',
        canonicalProductIntent: 'plate',
        limit: 2
      }
    };

    const products = new UnboundPreferenceProducts();
    const orchestrator = new AgentManagerOrchestrator(
      new FakeConversations() as never,
      products as never,
      new FakeLeads() as never,
      model({
        async planTurn() { return intent; },
        async composeAnswer(input) {
          expect(input.products.map((candidate) => candidate.id)).toEqual(['plate-95', 'plate-56']);
          return {
            answerText: 'В каталоге есть TEST Stable-S95 и TEST Stable-S56.',
            factsUsed: [],
            questionsAsked: [],
            toolResultIds: ['catalog-search'],
            selectedProductIds: ['plate-95', 'plate-56'],
            leadAction: 'none',
            riskFlags: [],
            selectionReadiness: {
              productClass: 'plate',
              status: 'ready_for_preliminary_cards',
              canShowProductCards: true,
              missingFacts: [],
              rationale: 'No executable preference objective changed the catalog order.'
            }
          };
        }
      })
    );

    const payload = await orchestrator.generateAnswer({
      sessionId,
      turnId,
      userMessage: 'Покажите виброплиты.'
    });

    expect(products.calls).toBe(1);
    expect(payload.productCards.map((card) => card.id)).toEqual(['plate-95', 'plate-56']);
  });

  it('keeps strict hard constraints after preference-driven broad recovery', async () => {
    class HardConstraintPreferenceProducts extends FakeProducts {
      calls = 0;

      override async searchProducts() {
        this.calls += 1;
        const weights = this.calls === 1 ? [72, 84] : [56, 67, 95];
        return weights.map((weight) => ({
          ...product(`plate-${weight}`, `Виброплита TEST Guard-G${weight} (${weight} кг)`, 'Виброплиты'),
          specs: { weight: `${weight} kg` }
        }));
      }
    }

    const intent = structuredGeneratorCatalogIntent();
    intent.selectionPolicy = {
      targetProductClass: 'виброплита',
      canonicalProductClass: 'plate',
      selectionGoal: 'preliminary_fit',
      needAction: 'open',
      alternativePolicy: 'same_class_only',
      reusePreviousCards: false,
      maxCards: 2,
      powerSource: 'any',
      phase: 'any',
      requirements: [{
        id: 'weight-limit',
        kind: 'weight_max_kg',
        value: 80,
        unit: 'kg',
        relation: 'must_have',
        role: 'hard_constraint',
        strictness: 'strict',
        evidence: 'buyer cannot handle more than 80 kg',
        verification: { mode: 'product_attribute' }
      }, {
        id: 'prefer-low-weight',
        kind: 'lightweight_design',
        value: true,
        unit: null,
        relation: 'preferred',
        role: 'preference',
        strictness: 'preferred',
        evidence: 'buyer prefers the lightest compliant option',
        verification: { mode: 'product_attribute' }
      }],
      rankingObjectives: [{
        requirementId: 'prefer-low-weight',
        attribute: 'weight_kg',
        direction: 'minimize'
      }],
      rationale: 'Respect the strict maximum, then rank compliant products by weight.'
    };
    intent.toolRequests[0] = {
      ...intent.toolRequests[0]!,
      args: {
        ...intent.toolRequests[0]!.args,
        query: 'виброплита до 80 кг',
        semanticQuery: 'самые лёгкие виброплиты массой не более 80 кг',
        productIntent: 'виброплита',
        canonicalProductIntent: 'plate',
        limit: 2
      },
      coversRequirementIds: ['weight-limit', 'prefer-low-weight']
    };

    const products = new HardConstraintPreferenceProducts();
    const orchestrator = new AgentManagerOrchestrator(
      new FakeConversations() as never,
      products as never,
      new FakeLeads() as never,
      model({
        async planTurn() { return intent; },
        async composeAnswer(input) {
          expect(input.products.map((candidate) => candidate.id)).toEqual(['plate-56', 'plate-67']);
          expect(input.products.map((candidate) => candidate.id)).not.toEqual(expect.arrayContaining(['plate-84', 'plate-95']));
          return {
            answerText: 'Под ограничение подходят TEST Guard-G56 и TEST Guard-G67.',
            factsUsed: [],
            questionsAsked: [],
            toolResultIds: ['catalog-search'],
            selectedProductIds: ['plate-56', 'plate-67'],
            leadAction: 'none',
            riskFlags: [],
            selectionReadiness: {
              productClass: 'plate',
              status: 'ready_for_preliminary_cards',
              canShowProductCards: true,
              missingFacts: [],
              rationale: 'Both products satisfy the hard maximum and optimize the preference.'
            }
          };
        }
      })
    );

    const payload = await orchestrator.generateAnswer({
      sessionId,
      turnId,
      userMessage: 'Нужна самая лёгкая виброплита, максимум 80 кг.'
    });

    expect(products.calls).toBe(2);
    expect(payload.productCards.map((card) => card.id)).toEqual(['plate-56', 'plate-67']);
    expect(payload.productCards.map((card) => card.id)).not.toEqual(expect.arrayContaining(['plate-84', 'plate-95']));
  });

  it('returns one labelled nearest compromise after one bounded recovery when exact range is empty', async () => {
    class CompromiseRecoveryProducts extends FakeProducts {
      calls = 0;
      override async searchProducts() {
        this.calls += 1;
        if (this.calls === 1) return [product('plate-noise', 'Unrelated plate', 'vibroplity')];
        return [{
          ...generatorProductWithPower('nearest-72', 'EVOline BPB9000E 7.2 kW generator', 7.2),
          price: 149990,
          specs: { 'Nominal power': '7.2 kW', voltage: '220 V single phase', Autostart: 'no' }
        }];
      }
    }
    const products = new CompromiseRecoveryProducts();
    const intent = structuredGeneratorCatalogIntent();
    intent.selectionPolicy = {
      ...intent.selectionPolicy!,
      selectionGoal: 'browse_catalog',
      alternativePolicy: 'allow_adjacent_with_explanation',
      phase: 'single_phase',
      maxCards: 2,
      requirements: [{
        id: 'range-min',
        kind: 'nominal_power_min_kw',
        value: 5.5,
        unit: 'kW',
        relation: 'must_have',
        role: 'hard_constraint',
        strictness: 'strict',
        evidence: 'requested minimum',
        verification: { mode: 'product_attribute' }
      }, {
        id: 'range-max',
        kind: 'nominal_power_max_kw',
        value: 6,
        unit: 'kW',
        relation: 'must_have',
        role: 'hard_constraint',
        strictness: 'strict',
        evidence: 'requested maximum',
        verification: { mode: 'product_attribute' }
      }]
    };
    intent.toolRequests[0] = {
      ...intent.toolRequests[0]!,
      args: {
        ...intent.toolRequests[0]!.args,
        query: 'generator requested narrow range',
        phase: 'single_phase',
        limit: 2
      },
      coversRequirementIds: ['range-min', 'range-max']
    };
    const conversations = new FakeConversations();
    const orchestrator = new AgentManagerOrchestrator(
      conversations as never,
      products as never,
      new FakeLeads() as never,
      model({
        async planTurn() { return intent; },
        async composeAnswer(input) {
          expect(input.products.map((product) => product.id)).toEqual(['nearest-72']);
          expect(input.requiredResponseClauses).toEqual(expect.arrayContaining([
            expect.objectContaining({ code: 'catalog_compromise_candidates_must_be_labeled' })
          ]));
          return {
            answerText: 'Точного варианта в диапазоне не подтвердил. Ближайший компромисс — EVOline BPB9000E 7.2 kW generator за 149 990 ₽: номинальная мощность выше верхней границы 6 кВт.',
            factsUsed: [],
            questionsAsked: [],
            toolResultIds: ['catalog-search'],
            selectedProductIds: ['nearest-72'],
            leadAction: 'none',
            riskFlags: [],
            selectionReadiness: {
              productClass: 'generator',
              status: 'ready_for_preliminary_cards',
              canShowProductCards: true,
              missingFacts: [],
              rationale: 'The buyer allowed an adjacent option and the tradeoff is explicit.'
            }
          };
        }
      })
    );

    const payload = await orchestrator.generateAnswer({
      sessionId,
      turnId,
      userMessage: 'If there is no exact 5.5-6.0 kW model, show the nearest single-phase option.'
    });
    const metadata = payload.metadata as {
      answerProductEvidence?: { candidateTiers?: Array<{ productId?: string; tier?: string; tradeoffs?: string[] }> };
      cardSelection?: { warnings?: string[] };
    };

    expect(products.calls).toBe(2);
    expect(payload.productCards.map((card) => card.id)).toEqual(['nearest-72']);
    expect(metadata.answerProductEvidence?.candidateTiers).toEqual(expect.arrayContaining([
      expect.objectContaining({
        productId: 'nearest-72',
        tier: 'compromise',
        tradeoffs: ['nominal_power_above_max:6:actual:7.2']
      })
    ]));
    expect(metadata.cardSelection?.warnings).toContain('product_cards_compromise:1');
  });

  it('does not stop at one oversized expensive generator when canonical recovery has closer adequate options', async () => {
    class CommercialRecoveryProducts extends FakeProducts {
      calls = 0;

      override async searchProducts() {
        this.calls += 1;
        if (this.calls === 1) {
          return [{
            ...generatorProductWithPower('oversized-85', 'Dinking 8.5 kW generator', 8.5),
            price: 170000,
            specs: { 'Nominal power': '8.5 kW', voltage: '220 V single phase' }
          }, {
            ...generatorProductWithPower('weak-30', 'Weak 3.0 kW generator', 3),
            price: 40000,
            specs: { 'Nominal power': '3 kW', voltage: '220 V single phase' }
          }];
        }
        return [{
          ...generatorProductWithPower('close-55', 'A-iPower AP6000 5.5 kW generator', 5.5),
          price: 99990,
          specs: { 'Nominal power': '5.5 kW', voltage: '220 V single phase' }
        }, {
          ...generatorProductWithPower('close-60', 'EVOline PB7000 6.0 kW generator', 6),
          price: 69990,
          specs: { 'Nominal power': '6 kW', voltage: '220 V single phase' }
        }, {
          ...generatorProductWithPower('oversized-85', 'Dinking 8.5 kW generator', 8.5),
          price: 170000,
          specs: { 'Nominal power': '8.5 kW', voltage: '220 V single phase' }
        }];
      }
    }

    const intent = typedGeneratorProofIntent();
    intent.selectionPolicy = {
      ...intent.selectionPolicy!,
      selectionGoal: 'preliminary_fit',
      maxCards: 2,
      phase: 'single_phase',
      reusePreviousCards: false
    };
    intent.toolRequests[1] = {
      ...intent.toolRequests[1]!,
      args: {
        ...intent.toolRequests[1]!.args,
        query: 'single phase home backup generator',
        semanticQuery: 'closest adequate generator after calculated load',
        phase: 'single_phase',
        limit: 2
      }
    };
    const products = new CommercialRecoveryProducts();
    const conversations = new FakeConversations();
    const orchestrator = new AgentManagerOrchestrator(
      conversations as never,
      products as never,
      new FakeLeads() as never,
      model({
        async planTurn() { return intent; },
        async composeAnswer(input) {
          expect(input.products.map((product) => product.id)).toEqual(['close-55', 'close-60']);
          expect(input.products.map((product) => product.price)).toEqual([99990, 69990]);
          return {
            answerText: 'Preliminary closest options are A-iPower AP6000 5.5 kW generator for 99,990 RUB and EVOline PB7000 6.0 kW generator for 69,990 RUB.',
            factsUsed: [],
            questionsAsked: [],
            toolResultIds: ['load-calculation', 'catalog-search'],
            selectedProductIds: ['close-55', 'close-60'],
            leadAction: 'none',
            riskFlags: [],
            selectionReadiness: {
              productClass: 'generator',
              status: 'ready_for_preliminary_cards',
              canShowProductCards: true,
              missingFacts: ['final pump starting current'],
              rationale: 'The calculated minimum supports a useful preliminary selection.'
            }
          };
        }
      })
    );

    const payload = await orchestrator.generateAnswer({
      sessionId,
      turnId,
      userMessage: 'Pump and grinder can work together; show a preliminary single-phase generator without overpaying.'
    });
    const metadata = payload.metadata as {
      toolResults?: Array<{ tool?: string; payload?: { retrieval?: { structuredRecovery?: { attempted?: boolean; matchedCount?: number } } } }>;
      answerProductEvidence?: { droppedProductIds?: string[] };
    };
    const catalogResult = metadata.toolResults?.find((result) => result.tool === 'catalog.search');

    expect(products.calls).toBe(2);
    expect(catalogResult?.payload?.retrieval?.structuredRecovery).toMatchObject({
      attempted: true,
      matchedCount: 2
    });
    expect(payload.productCards.map((card) => card.id), JSON.stringify({
      cardSelection: payload.metadata?.cardSelection,
      selectionReadiness: payload.metadata?.selectionReadiness,
      answerProductEvidence: payload.metadata?.answerProductEvidence
    })).toEqual(['close-55', 'close-60']);
    expect(metadata.answerProductEvidence?.droppedProductIds).toContain('oversized-85');
  });

  it('keeps gasoline generator candidates when the planner makes fuel type a strict product attribute', async () => {
    class MixedFuelProducts extends FakeProducts {
      override async searchProducts() {
        return [{
          ...generatorProductWithPower('tss-5', 'TSS SGG 5000N gasoline generator 5.0 kW', 5),
          price: 49281,
          specs: { 'Nominal power': '5 kW', 'вид топлива': 'бензиновые', 'число фаз': 'однофазные' }
        }, {
          ...generatorProductWithPower('sumec-6', 'SUMEC SU8800 gasoline generator 6.0 kW', 6),
          price: 47990,
          specs: { 'Nominal power': '6 kW', 'вид топлива': 'бензиновые', 'число фаз': 'однофазные' }
        }, {
          ...generatorProductWithPower('firman-diesel', 'FIRMAN SDG5500CLE diesel generator 4.8 kW', 4.8),
          price: 98900,
          specs: { 'Nominal power': '4.8 kW', 'вид топлива': 'дизельные', 'число фаз': 'однофазные' }
        }];
      }
    }

    const intent = structuredGeneratorCatalogIntent();
    intent.selectionPolicy = {
      ...intent.selectionPolicy!,
      selectionGoal: 'preliminary_fit',
      powerSource: 'fuel',
      phase: 'single_phase',
      maxCards: 2,
      requirements: [{
        id: 'single-phase',
        kind: 'phase',
        value: 'single_phase',
        unit: null,
        role: 'hard_constraint',
        strictness: 'strict',
        relation: 'must_have',
        evidence: 'The house is single-phase 220 V.',
        verification: { mode: 'product_attribute' }
      }, {
        id: 'voltage-220',
        kind: 'voltage_v',
        value: 220,
        unit: 'V',
        role: 'hard_constraint',
        strictness: 'strict',
        relation: 'must_have',
        evidence: 'The house supply is 220 V.',
        verification: { mode: 'product_attribute' }
      }, {
        id: 'gasoline-only',
        kind: 'fuel_type',
        value: 'gasoline',
        unit: null,
        role: 'hard_constraint',
        strictness: 'strict',
        relation: 'must_have',
        evidence: 'The buyer chose gasoline.',
        verification: { mode: 'product_attribute' }
      }, {
        id: 'preferred-minimum',
        kind: 'nominal_power_min_kw',
        value: 5,
        unit: 'kW',
        role: 'preference',
        strictness: 'preferred',
        relation: 'preferred',
        evidence: 'The buyer asked for approximately 5-6 kW.',
        verification: { mode: 'product_attribute' }
      }, {
        id: 'preferred-maximum',
        kind: 'nominal_power_max_kw',
        value: 6,
        unit: 'kW',
        role: 'preference',
        strictness: 'preferred',
        relation: 'preferred',
        evidence: 'The buyer asked for approximately 5-6 kW.',
        verification: { mode: 'product_attribute' }
      }]
    };
    intent.toolRequests[0] = {
      ...intent.toolRequests[0]!,
      args: {
        ...intent.toolRequests[0]!.args,
        query: 'gasoline single-phase generator 5-6 kW',
        semanticQuery: 'gasoline single-phase generator 5-6 kW',
        powerSource: 'fuel',
        phase: 'single_phase',
        limit: 2
      }
    };

    const conversations = new FakeConversations();
    const orchestrator = new AgentManagerOrchestrator(
      conversations as never,
      new MixedFuelProducts() as never,
      new FakeLeads() as never,
      model({
        async planTurn() { return intent; },
        async composeAnswer(input) {
          expect(input.products.map((product) => product.id)).toEqual(['sumec-6', 'tss-5']);
          return {
            answerText: 'Gasoline options are SUMEC SU8800 6.0 kW for 47,990 RUB and TSS SGG 5000N 5.0 kW for 49,281 RUB.',
            factsUsed: [],
            questionsAsked: [],
            toolResultIds: ['catalog-search'],
            selectedProductIds: ['sumec-6', 'tss-5'],
            leadAction: 'none',
            riskFlags: [],
            selectionReadiness: {
              productClass: 'generator',
              status: 'ready_for_preliminary_cards',
              canShowProductCards: true,
              missingFacts: ['final pump starting current'],
              rationale: 'Both catalog products satisfy the typed gasoline and phase requirements.'
            }
          };
        }
      })
    );

    const payload = await orchestrator.generateAnswer({
      sessionId,
      turnId,
      userMessage: 'Gasoline. Show 2-3 single-phase options around 5-6 kW with prices.'
    });

    expect(payload.productCards.map((card) => card.id)).toEqual(['sumec-6', 'tss-5']);
    expect(payload.productCards.map((card) => card.id)).not.toContain('firman-diesel');
  });

  it('rehydrates exact prior-card ids and preserves their prices when current detail lookup and web research do not complete', async () => {
    const priorProducts: Product[] = [{
      ...generatorProductWithPower('prior-generator-a', 'A-iPower AP6000 5.5 kW generator', 5.5),
      brand: 'A-iPower',
      price: 99_990
    }, {
      ...generatorProductWithPower('prior-generator-b', 'EVOline PB7000 6.0 kW generator', 6),
      brand: 'EVOline',
      price: 69_990
    }];
    const priorCards: ProductCard[] = priorProducts.map((item) => ({
      id: item.id,
      name: item.name,
      brand: item.brand,
      category: item.category,
      price: item.price,
      currency: item.currency,
      sourceUrl: item.sourceUrl,
      specs: item.specs,
      reasons: ['previous visible recommendation'],
      caveats: []
    }));
    const previousAssistant = {
      ...message('Показал два подходящих генератора с актуальными ценами.', 'assistant'),
      id: 'previous-two-card-answer',
      metadata: { productCards: priorCards }
    };

    class PriorReferentConversations extends FakeConversations {
      currentSession: ConversationSession = {
        ...session(),
        needState: {
          ...emptyNeedState(),
          activeNeeds: [{
            id: 'generator',
            productClass: 'generator',
            summary: 'compare the two previously shown generators',
            constraints: [],
            openQuestions: [],
            selectedProductIds: [],
            status: 'open',
            updatedAt: new Date('2026-05-19T12:00:00.000Z').toISOString()
          }]
        }
      };
      override messages = [
        message('Покажите два однофазных генератора с ценами.'),
        previousAssistant,
        { ...message('Сравните эти две модели по цене и запуску.'), id: 'prior-referent-current-user' }
      ];
      override toolArtifacts = [{
        tool_request_id: 'prior-card-web-check',
        tool_name: 'web.researchProductFacts',
        status: 'timeout',
        payload: {
          usedWebSearch: false,
          searchDisposition: 'timed_out',
          facts: [],
          conflicts: [],
          unconfirmedFacts: [{
            requirementIds: [],
            attribute: 'тип запуска',
            status: 'not_confirmed',
            reason: 'web research timed out'
          }]
        },
        warnings: ['web research timed out'],
        error_code: 'web_research_timeout'
      }];
      override async getSession() { return this.currentSession; }
    }

    class MissingCurrentDetailsProducts extends FakeProducts {
      idsSeen: string[] = [];
      searchCalls = 0;

      async getProductsByIds(ids: string[]) {
        this.idsSeen = ids;
        return [];
      }

      override async searchProducts(): Promise<Product[]> {
        this.searchCalls += 1;
        return [];
      }
    }

    const intent = structuredGeneratorCatalogIntent();
    intent.userMessageSummary = 'buyer asks to compare the two previously shown generators by price and start method';
    intent.dialogueUnderstanding = 'these two models refer to the exact cards in the immediately preceding assistant answer';
    intent.nextStepRationale = 'rehydrate the exact prior ids and preserve visible catalog facts while checking only the missing start method';
    intent.toolRequests = [{
      id: 'prior-card-details',
      tool: 'catalog.getProductDetails',
      args: {
        productNames: priorProducts.map((item) => item.name),
        productIntent: 'generator',
        canonicalProductIntent: 'generator',
        comparisonAttributes: ['price', 'тип запуска']
      },
      rationale: 'read the exact prior catalog products again',
      required: true
    }, {
      id: 'prior-card-web-check',
      tool: 'web.researchProductFacts',
      args: {
        query: 'проверить тип запуска двух ранее показанных генераторов',
        productIntent: 'generator',
        canonicalProductIntent: 'generator',
        productNames: priorProducts.map((item) => item.name),
        comparisonAttributes: ['тип запуска'],
        comparisonAttributeBindings: []
      },
      rationale: 'check only the decisive start-method gap',
      required: true
    }];
    intent.productMentions = priorProducts.map((item) => ({
      name: item.name,
      role: 'comparison_subject' as const,
      productClass: 'generator',
      evidence: 'previous visible card'
    }));
    intent.selectionPolicy = {
      ...intent.selectionPolicy!,
      selectionGoal: 'preliminary_fit',
      needAction: 'resume',
      reusePreviousCards: true,
      maxCards: 2,
      requirements: [{
        id: 'visible-price',
        kind: 'price_visibility',
        value: true,
        unit: null,
        relation: 'must_have',
        role: 'hard_constraint',
        strictness: 'strict',
        evidence: 'the buyer asks to compare the visible prices',
        verification: { mode: 'product_attribute' }
      }]
    };
    intent.grounding = {
      taskType: 'comparison',
      sourcePolicy: 'web_required',
      webPurpose: 'technical_specs',
      webRequirement: 'independent_required',
      requiredToolKinds: ['catalog.getProductDetails', 'web.researchProductFacts'],
      technicalAttributes: ['тип запуска'],
      rationale: 'prior card price is durable catalog evidence; only the start method still needs checking'
    };

    const conversations = new PriorReferentConversations();
    const products = new MissingCurrentDetailsProducts();
    const orchestrator = new AgentManagerOrchestrator(
      conversations as never,
      products as never,
      new FakeLeads() as never,
      model({
        async planTurn() { return intent; },
        async composeAnswer(input) {
          expect(input.intent.toolRequests.find((request) => request.id === 'prior-card-details')?.args.productIds)
            .toEqual(priorProducts.map((item) => item.id));
          expect(input.products.map((item) => ({ id: item.id, price: item.price }))).toEqual([
            { id: 'prior-generator-a', price: 99_990 },
            { id: 'prior-generator-b', price: 69_990 }
          ]);
          expect(input.requiredResponseClauses?.map((clause) => clause.code)).toContain(
            'revalidated_historical_products_are_current_evidence'
          );
          return {
            answerText: 'Из этих двух EVOline PB7000 дешевле: 69 990 ₽ против 99 990 ₽ у A-iPower AP6000. Тип запуска внешне подтвердить в этом ходе не удалось, но это не отменяет ранее показанные карточки и цены.',
            factsUsed: [],
            questionsAsked: [],
            toolResultIds: [],
            selectedProductIds: priorProducts.map((item) => item.id),
            leadAction: 'none',
            riskFlags: [],
            selectionReadiness: {
              productClass: 'generator',
              status: 'ready_for_preliminary_cards',
              canShowProductCards: true,
              missingFacts: ['тип запуска'],
              rationale: 'The exact prior cards and prices remain visible evidence while the current checks are incomplete.'
            }
          };
        }
      })
    );

    const payload = await orchestrator.generateAnswer({
      sessionId,
      turnId,
      userMessage: 'Сравните эти две модели по цене и запуску.'
    });

    expect(products.idsSeen).toEqual(priorProducts.map((item) => item.id));
    expect(payload.productCards.map((card) => ({ id: card.id, price: card.price }))).toEqual([
      { id: 'prior-generator-a', price: 99_990 },
      { id: 'prior-generator-b', price: 69_990 }
    ]);
    const normalizedAnswer = payload.answer.toLocaleLowerCase('ru-RU');
    expect(normalizedAnswer).not.toContain('нет карточ');
    expect(normalizedAnswer).not.toContain('нет цен');
    expect(normalizedAnswer).not.toContain('не удалось надёжно получить нужные данные из каталога');
  });

  it('keeps an over-budget explicit comparison subject as reference evidence but never as a card', async () => {
    const comparisonProducts: Product[] = [{
      id: 'masalta-ms125-4',
      name: 'Виброплита Masalta MS125-4',
      brand: 'Masalta',
      category: 'Виброплиты',
      price: 109_000,
      currency: 'RUB',
      sourceUrl: 'https://example.test/masalta-ms125-4',
      specs: { 'Рабочая масса': '126 kg', 'Центробежная сила': '25 kN' }
    }, {
      id: 'champion-pc1150ft',
      name: 'Виброплита CHAMPION PC1150FT',
      brand: 'CHAMPION',
      category: 'Виброплиты',
      price: 76_690,
      currency: 'RUB',
      sourceUrl: 'https://example.test/champion-pc1150ft',
      specs: { 'Рабочая масса': '97 kg', 'Центробежная сила': '17 kN' }
    }];
    const nonComparisonNeighbor: Product = {
      id: 'wacker-bps1550a',
      name: 'Виброплита Wacker Neuson BPS1550A',
      brand: 'Wacker Neuson',
      category: 'Виброплиты',
      price: 84_000,
      currency: 'RUB',
      sourceUrl: 'https://example.test/wacker-bps1550a',
      specs: { 'Рабочая масса': '90 kg', 'Центробежная сила': '15 kN' }
    };
    const priorCards: ProductCard[] = comparisonProducts.map((item) => ({
      id: item.id,
      name: item.name,
      brand: item.brand,
      category: item.category,
      price: item.price,
      currency: item.currency,
      sourceUrl: item.sourceUrl,
      specs: item.specs,
      reasons: ['previous visible comparison candidate'],
      caveats: []
    }));
    const previousAssistant: Message = {
      ...message('Показал Masalta и CHAMPION с актуальными ценами.', 'assistant'),
      id: 'previous-masalta-champion-answer',
      metadata: { productCards: priorCards }
    };

    class ChangedBudgetComparisonConversations extends FakeConversations {
      currentSession: ConversationSession = {
        ...session(),
        needState: {
          ...emptyNeedState(),
          activeNeeds: [{
            id: 'plate-comparison',
            productClass: 'plate',
            summary: 'compare the exact previously shown plate compactors',
            constraints: [],
            openQuestions: [],
            selectedProductIds: comparisonProducts.map((item) => item.id),
            status: 'selected',
            updatedAt: new Date('2026-05-19T12:00:00.000Z').toISOString()
          }]
        }
      };
      override messages = [
        message('Покажите две виброплиты.'),
        previousAssistant,
        { ...message('Сравните обе, бюджет теперь до 90 000 ₽.'), id: 'changed-budget-current-user' }
      ];
      override toolArtifacts = [{
        tool_request_id: 'comparison-web-check',
        tool_name: 'web.researchProductFacts',
        status: 'error',
        payload: {
          usedWebSearch: false,
          searchDisposition: 'failed',
          facts: [],
          conflicts: [],
          unconfirmedFacts: [{
            requirementIds: [],
            attribute: 'дополнительные технические данные',
            status: 'not_confirmed',
            reason: 'web provider error'
          }]
        },
        warnings: ['web provider error'],
        error_code: 'web_provider_error'
      }];
      override async getSession() { return this.currentSession; }
    }

    class ExactComparisonDetailsProducts extends FakeProducts {
      idsSeen: string[] = [];

      async getProductsByIds(ids: string[]) {
        this.idsSeen = ids;
        return [
          ...comparisonProducts.filter((item) => ids.includes(item.id)),
          nonComparisonNeighbor
        ];
      }

      override async searchProducts(): Promise<Product[]> {
        throw new Error('exact previous-card details must not become a fuzzy neighboring search');
      }
    }

    const intent = structuredGeneratorCatalogIntent();
    intent.userMessageSummary = 'buyer explicitly compares the exact prior Masalta and CHAMPION cards with a new 90000 RUB ceiling';
    intent.dialogueUnderstanding = 'Masalta remains a factual comparison subject but violates the current strict budget; CHAMPION remains eligible';
    intent.nextStepRationale = 'compare exact grounded facts, reject the over-budget subject, and recommend only the eligible subject';
    intent.toolRequests = [{
      id: 'comparison-details',
      tool: 'catalog.getProductDetails',
      args: {
        productNames: comparisonProducts.map((item) => item.name),
        productIntent: 'plate',
        canonicalProductIntent: 'plate',
        comparisonAttributes: ['price', 'weight', 'compaction force'],
        limit: 2
      },
      rationale: 'rehydrate the exact visible card ids and current product details',
      required: true
    }, {
      id: 'comparison-web-check',
      tool: 'web.researchProductFacts',
      args: {
        query: 'compare exact Masalta and CHAMPION technical facts',
        productIntent: 'plate',
        canonicalProductIntent: 'plate',
        productNames: comparisonProducts.map((item) => item.name),
        comparisonAttributes: ['weight', 'compaction force'],
        comparisonAttributeBindings: [],
        limit: 2
      },
      rationale: 'check only unresolved comparison facts after exact catalog details',
      required: true
    }];
    intent.productMentions = comparisonProducts.map((item) => ({
      name: item.name,
      role: 'comparison_subject' as const,
      productClass: 'plate',
      evidence: 'exact previous visible card'
    }));
    intent.selectionPolicy = {
      targetProductClass: 'plate',
      canonicalProductClass: 'plate',
      selectionGoal: 'preliminary_fit',
      needAction: 'resume',
      alternativePolicy: 'exact_only',
      reusePreviousCards: true,
      maxCards: 2,
      powerSource: 'any',
      phase: 'any',
      requirements: [{
        id: 'budget-max-90000',
        kind: 'budget_max_rub',
        value: 90_000,
        unit: 'RUB',
        relation: 'must_have',
        role: 'hard_constraint',
        strictness: 'strict',
        evidence: 'бюджет теперь до 90 000 ₽',
        verification: { mode: 'product_attribute' }
      }],
      rationale: 'the changed budget is a strict current recommendation constraint'
    };
    intent.grounding = {
      taskType: 'comparison',
      sourcePolicy: 'web_required',
      webPurpose: 'technical_specs',
      webRequirement: 'independent_required',
      requiredToolKinds: ['catalog.getProductDetails', 'web.researchProductFacts'],
      technicalAttributes: ['weight', 'compaction force'],
      rationale: 'use exact catalog facts first and preserve web failure as missing evidence'
    };

    const conversations = new ChangedBudgetComparisonConversations();
    const products = new ExactComparisonDetailsProducts();
    const reviewAnswer = vi.fn(async (input: Parameters<AgentManagerModel['reviewAnswer']>[0]) => {
      expect(input.products.map((item) => item.id)).toEqual([
        'champion-pc1150ft',
        'masalta-ms125-4'
      ]);
      expect(input.productEvidenceRoles).toEqual(expect.arrayContaining([
        expect.objectContaining({
          productId: 'champion-pc1150ft',
          role: 'recommendation_candidate',
          eligibleForRecommendation: true
        }),
        expect.objectContaining({
          productId: 'masalta-ms125-4',
          role: 'comparison_reference_only',
          eligibleForRecommendation: false,
          rejectionReasons: [expect.objectContaining({
            requirementId: 'budget-max-90000',
            kind: 'budget_max_rub',
            requiredValue: 90_000,
            actualValue: 109_000
          })]
        })
      ]));
      expect(input.products.map((item) => item.id)).not.toContain(nonComparisonNeighbor.id);
      expect(input.productEvidenceRoles?.map((role) => role.productId)).not.toContain(nonComparisonNeighbor.id);
      return { verdict: 'pass' as const, issues: [] };
    });
    const orchestrator = new AgentManagerOrchestrator(
      conversations as never,
      products as never,
      new FakeLeads() as never,
      model({
        async planTurn() { return intent; },
        async composeAnswer(input) {
          expect(input.products.map((item) => ({ id: item.id, price: item.price }))).toEqual([
            { id: 'champion-pc1150ft', price: 76_690 },
            { id: 'masalta-ms125-4', price: 109_000 }
          ]);
          expect(input.productEvidenceRoles).toEqual(expect.arrayContaining([
            expect.objectContaining({
              productId: 'masalta-ms125-4',
              role: 'comparison_reference_only',
              eligibleForRecommendation: false
            })
          ]));
          expect(input.requiredResponseClauses?.map((clause) => clause.code))
            .toContain('comparison_reference_rejected_by_hard_constraint');
          return {
            answerText: 'Masalta MS125-4 стоит 109 000 ₽ и превышает новый лимит 90 000 ₽, поэтому как подходящий вариант её не рекомендую. CHAMPION PC1150FT стоит 76 690 ₽ и укладывается в бюджет; из этих двух рекомендую её. Дополнительный web-поиск завершился ошибкой, поэтому сравнение ограничиваю подтверждёнными карточками.',
            factsUsed: [],
            questionsAsked: [],
            toolResultIds: ['comparison-details'],
            selectedProductIds: ['champion-pc1150ft'],
            leadAction: 'none',
            riskFlags: [],
            selectionReadiness: {
              productClass: 'plate',
              status: 'ready_for_preliminary_cards',
              canShowProductCards: true,
              missingFacts: ['additional web comparison facts'],
              rationale: 'CHAMPION passes the strict budget; Masalta remains reference-only evidence.'
            }
          };
        },
        reviewAnswer
      })
    );
    const previousReviewMode = config.AI_MANAGER_REVIEW_MODE;
    config.AI_MANAGER_REVIEW_MODE = 'always';
    try {
      const payload = await orchestrator.generateAnswer({
        sessionId,
        turnId,
        userMessage: 'Сравните обе, бюджет теперь до 90 000 ₽.'
      });

      expect([...products.idsSeen].sort()).toEqual(
        comparisonProducts.map((item) => item.id).sort(),
      );
      expect(reviewAnswer).toHaveBeenCalledTimes(1);
      expect(payload.productCards.map((card) => card.id)).toEqual(['champion-pc1150ft']);
      expect(payload.productCards.map((card) => card.id)).not.toContain(nonComparisonNeighbor.id);
      expect(payload.answer).toContain('Masalta MS125-4');
      expect(payload.answer).toContain('превышает');
      expect(payload.answer).toContain('CHAMPION PC1150FT');
      expect((payload.metadata?.answerContract as { selectedProductIds?: string[] }).selectedProductIds)
        .toEqual(['champion-pc1150ft']);
    } finally {
      config.AI_MANAGER_REVIEW_MODE = previousReviewMode;
    }
  });

  it('keeps an explicitly compared over-weight product as reference evidence while showing only the eligible card', async () => {
    const heavy: Product = {
      ...product('plate-heavy-126', 'Виброплита Masalta MS125-4', 'Виброплиты'),
      specs: { 'Operating weight': '126 kg', 'Compaction force': '25 kN' },
      price: 126_000
    };
    const light: Product = {
      ...product('plate-light-97', 'Виброплита CHAMPION PC1150FT', 'Виброплиты'),
      specs: { 'Operating weight': '97 kg', 'Compaction force': '17 kN' },
      price: 97_000
    };
    const unrelated: Product = {
      ...product('plate-unrelated-80', 'Виброплита Wacker BPS1550A', 'Виброплиты'),
      specs: { 'Operating weight': '80 kg', 'Compaction force': '15 kN' },
      price: 80_000
    };
    const intent = structuredGeneratorCatalogIntent();
    intent.requiresTools = true;
    intent.toolRequests = [{
      id: 'plate-details',
      tool: 'catalog.getProductDetails',
      args: {
        productIds: [heavy.id, light.id],
        productNames: [heavy.name, light.name],
        productIntent: 'plate',
        canonicalProductIntent: 'plate',
        comparisonAttributes: ['weight', 'compaction force'],
        limit: 2
      },
      rationale: 'read exact comparison subjects',
      required: true
    }];
    intent.productMentions = [heavy, light].map((item) => ({
      name: item.name,
      role: 'comparison_subject' as const,
      productClass: 'plate',
      evidence: 'explicit comparison subject'
    }));
    intent.selectionPolicy = {
      ...intent.selectionPolicy!,
      targetProductClass: 'plate',
      canonicalProductClass: 'plate',
      selectionGoal: 'preliminary_fit',
      alternativePolicy: 'exact_only',
      reusePreviousCards: false,
      maxCards: 1,
      requirements: [{
        id: 'weight-max-100',
        kind: 'weight_max_kg',
        value: 100,
        unit: 'kg',
        relation: 'must_have',
        role: 'hard_constraint',
        strictness: 'strict',
        evidence: 'buyer requires a plate no heavier than 100 kg',
        verification: { mode: 'product_attribute' }
      }]
    };
    intent.grounding = {
      taskType: 'comparison',
      sourcePolicy: 'catalog_required',
      webPurpose: 'none',
      requiredToolKinds: ['catalog.getProductDetails'],
      technicalAttributes: ['weight', 'compaction force'],
      rationale: 'compare exact catalog subjects and apply the strict weight limit'
    };

    class ExactPlateProducts extends FakeProducts {
      async getProductsByIds(ids: string[]) {
        return [heavy, light, unrelated].filter((item) => ids.includes(item.id));
      }
    }

    const conversations = new FakeConversations();
    const composeAnswer = vi.fn(async (
      input: Parameters<AgentManagerModel['composeAnswer']>[0]
    ): Promise<Awaited<ReturnType<AgentManagerModel['composeAnswer']>>> => {
      expect(input.products.map((item) => item.id)).toEqual([light.id, heavy.id]);
      expect(input.productEvidenceRoles).toEqual(expect.arrayContaining([
        expect.objectContaining({
          productId: light.id,
          role: 'recommendation_candidate',
          eligibleForRecommendation: true
        }),
        expect.objectContaining({
          productId: heavy.id,
          role: 'comparison_reference_only',
          eligibleForRecommendation: false,
          rejectionReasons: [expect.objectContaining({
            requirementId: 'weight-max-100',
            kind: 'weight_max_kg',
            requiredValue: 100,
            actualValue: 126,
            unit: 'kg',
            sourceResultIds: ['plate-details']
          })]
        })
      ]));
      expect(input.products.map((item) => item.id)).not.toContain(unrelated.id);
      return {
        answerText: 'Masalta MS125-4 weighs 126 kg and exceeds the 100 kg limit. CHAMPION PC1150FT weighs 97 kg and fits the stated limit as the preliminary choice.',
        factsUsed: [],
        questionsAsked: [],
        toolResultIds: ['plate-details'],
        selectedProductIds: [light.id],
        leadAction: 'none',
        riskFlags: [],
        selectionReadiness: {
          productClass: 'plate',
          status: 'ready_for_preliminary_cards',
          canShowProductCards: true,
          missingFacts: [],
          rationale: 'the light subject satisfies the strict weight requirement'
        }
      };
    });
    const orchestrator = new AgentManagerOrchestrator(
      conversations as never,
      new ExactPlateProducts() as never,
      new FakeLeads() as never,
      model({
        async planTurn() { return intent; },
        composeAnswer,
        async reviewAnswer() { return { verdict: 'pass', issues: [] }; }
      })
    );

    const payload = await orchestrator.generateAnswer({
      sessionId,
      turnId,
      userMessage: 'Compare Masalta MS125-4 and CHAMPION PC1150FT; I need a plate no heavier than 100 kg.'
    });

    expect(composeAnswer).toHaveBeenCalledTimes(1);
    expect(payload.productCards.map((card) => card.id)).toEqual([light.id]);
    expect(payload.productCards.map((card) => card.id)).not.toContain(heavy.id);
    expect(payload.productCards.map((card) => card.id)).not.toContain(unrelated.id);
    expect(payload.answer).toContain('Masalta MS125-4');
    expect(payload.answer).toContain('CHAMPION PC1150FT');
  });

  it('keeps the validated load calculation and close generator options when the buyer asks what to buy without overpaying', async () => {
    const secondTurnId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const thirdTurnId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    class TurnAwareCommercialConversations extends FakeConversations {
      currentSession = session();
      ledgerRows: Array<Record<string, unknown>> = [];
      checkpointRows: Array<Record<string, unknown>> = [];
      toolRows: Array<Record<string, unknown>> = [];

      override async getSession() {
        return this.currentSession;
      }

      async updateNeedState(_sessionId: string, needState: ConversationSession['needState']) {
        this.currentSession = { ...this.currentSession, needState };
        return this.currentSession;
      }

      override async listDialogueLedgerEvents() {
        return this.ledgerRows;
      }

      override async upsertDialogueLedgerEvent(input: Record<string, unknown>) {
        this.ledgerEvents.push(input);
        const row = {
          session_id: input.sessionId,
          turn_id: input.turnId,
          event_id: input.eventId,
          event_type: input.eventType,
          scope: input.scope,
          payload: input.payload,
          evidence: input.evidence,
          source: input.source,
          status: input.status,
          event_seq: this.ledgerRows.length + 1
        };
        const existing = this.ledgerRows.findIndex((item) => item.event_id === input.eventId);
        if (existing >= 0) this.ledgerRows[existing] = row;
        else this.ledgerRows.push(row);
        return input;
      }

      override async upsertTurnCheckpoint(input: Record<string, unknown>) {
        this.checkpoints.push(input);
        this.checkpointRows.push(input);
        return input;
      }

      override async listTurnCheckpoints(_sessionId?: string, requestedTurnId?: string) {
        return this.checkpointRows.filter((item) => item.turnId === requestedTurnId);
      }

      override async saveToolArtifact(input: Record<string, unknown>) {
        this.toolArtifacts.push(input);
        this.toolRows.push(input);
        return input;
      }

      override async listToolArtifacts(_sessionId?: string, requestedTurnId?: string) {
        return this.toolRows.filter((item) => item.turnId === requestedTurnId);
      }
    }

    class CloseGeneratorProducts extends FakeProducts {
      override async searchProducts() {
        return [{
          ...generatorProductWithPower('close-55', 'A-iPower AP6000 5.5 kW generator', 5.5),
          price: 99990,
          specs: { 'Nominal power': '5.5 kW', voltage: '220 V single phase' }
        }, {
          ...generatorProductWithPower('close-60', 'EVOline PB7000 6.0 kW generator', 6),
          price: 69990,
          specs: { 'Nominal power': '6 kW', voltage: '220 V single phase' }
        }];
      }
    }

    const firstIntent = typedGeneratorProofIntent();
    firstIntent.selectionPolicy = {
      ...firstIntent.selectionPolicy!,
      selectionGoal: 'preliminary_fit',
      maxCards: 2,
      phase: 'single_phase',
      reusePreviousCards: false
    };
    const secondIntent = structuredClone(firstIntent);
    secondIntent.requiresTools = false;
    secondIntent.toolRequests = [];
    secondIntent.userMessageSummary = 'buyer asks which validated generator to buy without overpaying';
    secondIntent.dialogueUnderstanding = 'compare the previously validated close options against the saved load calculation';
    secondIntent.nextStepRationale = 'give a concrete preliminary commercial orientation from current conversation evidence';
    secondIntent.grounding = {
      taskType: 'comparison',
      sourcePolicy: 'conversation_only',
      webPurpose: 'none',
      requiredToolKinds: [],
      technicalAttributes: ['price', 'power'],
      rationale: 'the previous turn already validated the same products and load calculation'
    };
    secondIntent.productMentions = [{
      name: 'A-iPower AP6000 5.5 kW generator',
      role: 'comparison_subject',
      productClass: 'generator',
      evidence: 'previous visible card'
    }, {
      name: 'EVOline PB7000 6.0 kW generator',
      role: 'comparison_subject',
      productClass: 'generator',
      evidence: 'previous visible card'
    }];
    secondIntent.selectionPolicy = {
      ...secondIntent.selectionPolicy!,
      selectionGoal: 'preliminary_fit',
      reusePreviousCards: true,
      maxCards: 2,
      requirements: [
        ...secondIntent.selectionPolicy!.requirements,
        {
          id: 'price-required',
          kind: 'price_visibility',
          value: true,
          unit: null,
          role: 'hard_constraint',
          strictness: 'strict',
          relation: 'must_have',
          evidence: 'Buyer wants the comparison with prices.',
          verification: { mode: 'product_attribute' }
        }
      ]
    };
    secondIntent.selectionPolicy!.requirements = secondIntent.selectionPolicy!.requirements.map((requirement) => ({
      ...requirement,
      verification: requirement.verification?.mode === 'typed_tool'
        ? { ...requirement.verification, toolRequestId: 'carried-load-context' }
        : requirement.verification
    }));
    const changedLoadIntent = structuredClone(secondIntent);
    changedLoadIntent.userMessageSummary = 'buyer changes the generator load facts';
    changedLoadIntent.dialogueUnderstanding = 'the previous generator calculation is stale after the changed pump power';
    changedLoadIntent.nextStepRationale = 'do not reuse the old load proof or show cards as validated';
    changedLoadIntent.selectionPolicy!.requirements = changedLoadIntent.selectionPolicy!.requirements.map((requirement) => ({
      ...requirement,
      evidence: 'the pump is now 3 kW and the grinder is 1.5 kW'
    }));

    const conversations = new TurnAwareCommercialConversations();
    conversations.messages = [message('Pump 1.1 kW and grinder 1.5 kW may run together; show close single-phase generators.')];
    let turnNumber = 0;
    const orchestrator = new AgentManagerOrchestrator(
      conversations as never,
      new CloseGeneratorProducts() as never,
      new FakeLeads() as never,
      model({
        async planTurn(input) {
          if (!input.ledgerIncludesCurrentTurnDelta) turnNumber += 1;
          if (turnNumber === 1) return firstIntent;
          if (turnNumber === 2) return secondIntent;
          return changedLoadIntent;
        },
        async composeAnswer(input) {
          if (turnNumber === 3) {
            expect(input.products).toEqual([]);
            expect(input.toolResults.map((result) => result.tool)).not.toContain('calculator.generatorLoad');
            return {
              answerText: 'The load has changed, so I need to recalculate before treating either previous generator as a validated fit.',
              factsUsed: [],
              questionsAsked: [],
              toolResultIds: [],
              selectedProductIds: [],
              leadAction: 'none',
              riskFlags: [],
              selectionReadiness: {
                productClass: 'generator',
                status: 'needs_more_info',
                canShowProductCards: false,
                missingFacts: ['updated generator load calculation'],
                rationale: 'The previous calculation does not prove the changed load.'
              }
            };
          }
          expect(input.products.map((product) => product.id), JSON.stringify({
            turnNumber,
            intent: input.intent,
            toolResults: input.toolResults.map((result) => ({ requestId: result.requestId, tool: result.tool, status: result.status }))
          })).toEqual(['close-55', 'close-60']);
          if (turnNumber === 2) {
            expect(input.toolResults.map((result) => result.requestId)).toEqual(expect.arrayContaining([
              'load-calculation',
              'catalog-search'
            ]));
            expect(input.requiredResponseClauses?.map((clause) => clause.code))
              .toContain('revalidated_historical_products_are_current_evidence');
          }
          return {
            answerText: turnNumber === 1
              ? 'Closest preliminary options are A-iPower AP6000 5.5 kW generator and EVOline PB7000 6.0 kW generator.'
              : 'Compared with A-iPower AP6000 5.5 kW generator, I would start with EVOline PB7000 6.0 kW generator without overpaying: it is cheaper and keeps the required reserve.',
            factsUsed: [],
            questionsAsked: [],
            toolResultIds: ['load-calculation', 'catalog-search'],
            selectedProductIds: ['close-55', 'close-60'],
            leadAction: 'none',
            riskFlags: [],
            selectionReadiness: {
              productClass: 'generator',
              status: 'ready_for_preliminary_cards',
              canShowProductCards: true,
              missingFacts: ['final pump starting current'],
              rationale: 'Previously validated products and calculation support a preliminary comparison.'
            }
          };
        }
      })
    );

    const first = await orchestrator.generateAnswer({
      sessionId,
      turnId,
      userMessage: conversations.messages[0]!.content
    });
    expect(first.productCards.map((card) => card.id)).toEqual(['close-55', 'close-60']);
    expect(assessStrictSelectionRequirements(
      secondIntent,
      'generator',
      (first.metadata as { toolResults?: Parameters<typeof assessStrictSelectionRequirements>[2] }).toolResults ?? []
    )).toEqual({ blockers: [], generatorNominalPowerMinKw: 5.5 });

    const secondUser = {
      ...message('Which one should I buy without overpaying?'),
      id: 'commercial-second-user-message'
    };
    conversations.messages.push(secondUser);
    conversations.turn = {
      ...turn(),
      id: secondTurnId,
      userMessageId: secondUser.id,
      assistantMessageId: null,
      status: 'received'
    };
    expect((conversations.messages.find((item) => item.role === 'assistant')?.metadata as { productCards?: ProductCard[] })?.productCards
      ?.map((card) => card.id)).toEqual(['close-55', 'close-60']);
    expect(conversations.currentSession.needState.activeNeeds.find((need) => need.id === 'generator')?.selectedProductIds)
      .toEqual(['close-55', 'close-60']);
    const second = await orchestrator.generateAnswer({
      sessionId,
      turnId: secondTurnId,
      userMessage: secondUser.content
    });
    const secondMetadata = second.metadata as {
      historicalSelectionEvidence?: { reused?: boolean; toolResultIds?: string[] };
      warnings?: string[];
    };

    expect(second.answer).toContain('EVOline PB7000');
    expect(second.productCards.map((card) => card.id)).toEqual(['close-55', 'close-60']);
    expect(secondMetadata.historicalSelectionEvidence).toMatchObject({
      reused: true,
      toolResultIds: expect.arrayContaining(['load-calculation', 'catalog-search'])
    });
    expect(secondMetadata.warnings).toContain('historical_selection_evidence_reused');
    expect(conversations.turn.status).toBe('completed');

    const thirdUser = {
      ...message('The pump is actually 3 kW; keep the grinder at 1.5 kW.'),
      id: 'commercial-third-user-message'
    };
    conversations.messages.push(thirdUser);
    conversations.turn = {
      ...turn(),
      id: thirdTurnId,
      userMessageId: thirdUser.id,
      assistantMessageId: null,
      status: 'received'
    };
    const changedLoad = await orchestrator.generateAnswer({
      sessionId,
      turnId: thirdTurnId,
      userMessage: thirdUser.content
    });
    const changedLoadMetadata = changedLoad.metadata as {
      historicalSelectionEvidence?: { toolResultIds?: string[]; tools?: string[] };
    };

    expect(changedLoad.productCards).toEqual([]);
    expect(changedLoadMetadata.historicalSelectionEvidence?.tools).not.toContain('calculator.generatorLoad');
    expect(changedLoadMetadata.historicalSelectionEvidence?.toolResultIds).toEqual(['catalog-search']);
  });

  it('recovers a committed final contract when wall abort interrupts post-commit delivery', async () => {
    const deadline = new AbortController();
    const timeoutSignal = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal);
    class PostCommitAbortConversations extends FakeConversations {
      override async addAssistantMessageForTurn(input: Parameters<FakeConversations['addAssistantMessageForTurn']>[0]) {
        const saved = await super.addAssistantMessageForTurn(input);
        if (saved) {
          this.finalAnswerContract = {
            answer_text: input.content,
            contract: input.answerContract,
            review: input.review,
            response_payload: input.responsePayload
          };
          deadline.abort();
        }
        return saved;
      }
    }
    const conversations = new PostCommitAbortConversations();
    const onDelta = vi.fn(async () => {
      throw new Error('stream disconnected after final commit');
    });
    const orchestrator = new AgentManagerOrchestrator(
      conversations as never,
      new FakeProducts() as never,
      new FakeLeads() as never,
      model()
    );

    try {
      const payload = await orchestrator.generateAnswer({
        sessionId,
        turnId,
        userMessage: 'Coffee machine 3.2 kW, grinder 400 W, is 5 kW enough?',
        onDelta
      });

      expect(payload.answer).toContain('5 kW');
      expect(onDelta).toHaveBeenCalledTimes(1);
      expect(conversations.assistantSaves).toHaveLength(1);
      expect(conversations.turn.status).toBe('completed');
      expect(conversations.turn.stage).not.toBe('budget_stopped');
    } finally {
      timeoutSignal.mockRestore();
    }
  });

  it('preserves eligible catalog cards when a preliminary web check reaches the turn deadline', async () => {
    const conversations = new FakeConversations();
    const candidate: Product = {
      ...product('plate-80', 'Виброплита TEST 80 кг', 'Виброплиты'),
      specs: { 'Рабочий вес': '80 кг' }
    };
    const intent = structuredGeneratorCatalogIntent();
    const webRequest: ToolRequest = {
      id: 'web-paving-check',
      tool: 'web.researchProductFacts',
      args: {
        query: 'проверить совместимость виброплиты с тротуарной плиткой',
        productIntent: 'виброплита',
        canonicalProductIntent: 'plate',
        productNames: [],
        comparisonAttributes: ['совместимость с тротуарной плиткой'],
        comparisonAttributeBindings: []
      },
      rationale: 'проверить неподтверждённый технический факт после каталога',
      required: true,
      coversRequirementIds: ['paving-compatibility']
    };
    intent.userMessageSummary = 'покупатель просит лёгкую виброплиту до 90 кг для тротуарной плитки';
    intent.dialogueUnderstanding = 'вес ограничен каталогом, совместимость с покрытием пока не подтверждена';
    intent.nextStepRationale = 'показать предварительные варианты из каталога и не выдавать совместимость за подтверждённую';
    intent.toolRequests = [{
      id: 'catalog-search',
      tool: 'catalog.search',
      args: {
        query: 'лёгкая виброплита до 90 кг',
        productIntent: 'виброплита',
        canonicalProductIntent: 'plate',
        limit: 4
      },
      rationale: 'найти актуальные карточки виброплит',
      required: true,
      coversRequirementIds: ['weight-max']
    }, webRequest];
    intent.selectionPolicy = {
      targetProductClass: 'виброплита',
      canonicalProductClass: 'plate',
      selectionGoal: 'preliminary_fit',
      needAction: 'open',
      alternativePolicy: 'same_class_only',
      reusePreviousCards: false,
      maxCards: 4,
      powerSource: 'any',
      phase: 'any',
      requirements: [{
        id: 'weight-max',
        kind: 'weight_max_kg',
        value: 90,
        unit: 'kg',
        relation: 'must_have',
        role: 'hard_constraint',
        strictness: 'strict',
        evidence: 'не тяжелее 90 кг',
        verification: { mode: 'product_attribute' }
      }, {
        id: 'paving-compatibility',
        kind: 'paving_compatibility',
        value: true,
        unit: null,
        relation: 'must_have',
        role: 'hard_constraint',
        strictness: 'strict',
        evidence: 'нужна для тротуарной плитки',
        verification: {
          mode: 'typed_tool',
          toolRequestId: webRequest.id,
          tool: 'web.researchProductFacts',
          verifier: 'technical_source_review',
          bindAs: 'paving_compatibility'
        }
      }],
      rationale: 'подбор по подтверждённому весу с честной оговоркой о незавершённой web-проверке'
    };
    intent.grounding = {
      taskType: 'product_selection',
      sourcePolicy: 'web_required',
      webPurpose: 'technical_specs',
      webRequirement: 'independent_required',
      requiredToolKinds: ['catalog.search', 'web.researchProductFacts'],
      technicalAttributes: ['совместимость с тротуарной плиткой'],
      rationale: 'внешний источник не успел завершиться, но каталоговый вес подтверждён'
    };
    conversations.turn = {
      ...conversations.turn,
      deadlineAt: new Date(Date.now() + 4_000).toISOString(),
      plannerContract: intent
    };
    conversations.toolArtifacts = [{
      tool_request_id: 'catalog-search',
      tool_name: 'catalog.search',
      status: 'ok',
      payload: { products: [candidate] },
      warnings: []
    }, {
      tool_request_id: webRequest.id,
      tool_name: 'web.researchProductFacts',
      status: 'timeout',
      payload: {
        usedWebSearch: false,
        searchDisposition: 'timed_out',
        facts: [],
        conflicts: [],
        warnings: ['web research timed out before a source could be confirmed']
      },
      warnings: ['web research timed out before a source could be confirmed'],
      error_code: 'web_research_timeout'
    }];
    const orchestrator = new AgentManagerOrchestrator(
      conversations as never,
      new FakeProducts() as never,
      new FakeLeads() as never,
      model()
    );

    const payload = await orchestrator.generateAnswer({
      sessionId,
      turnId,
      userMessage: 'Нужна лёгкая виброплита для тротуарной плитки, не тяжелее 90 кг.'
    });
    const metadata = payload.metadata as {
      answerContract?: { selectedProductIds?: string[]; selectionReadiness?: { status?: string; missingFacts?: string[] } };
      terminalCatalogRecovery?: { selectedProductIds?: string[]; unfinishedVerification?: string[] };
      webSearchAttempted?: boolean;
      webSearchCompleted?: boolean;
    };

    expect(payload.productCards.map((card) => card.id)).toEqual(['plate-80']);
    expect(payload.usedWebSearch).toBe(false);
    expect(metadata.webSearchAttempted).toBe(true);
    expect(metadata.webSearchCompleted).toBe(false);
    expect(payload.leadRequested).toBe(false);
    expect(payload.answer).toContain('предварительно');
    expect(payload.answer).toContain('Не успела завершиться');
    expect(payload.answer).not.toContain('техническому специалисту');
    expect(metadata.answerContract?.selectedProductIds).toEqual(['plate-80']);
    expect(metadata.answerContract?.selectionReadiness).toMatchObject({
      status: 'ready_for_preliminary_cards',
      missingFacts: ['совместимость с тротуарной плиткой']
    });
    expect(metadata.terminalCatalogRecovery?.selectedProductIds).toEqual(['plate-80']);
    expect(conversations.assistantSaves).toContainEqual(expect.objectContaining({
      executionOwner: expect.any(String),
      answerContract: expect.objectContaining({ selectedProductIds: ['plate-80'] })
    }));
  });

  it('terminalizes final-fit catalog details plus an exhausted unresolved web check as a named specialist handoff', async () => {
    const conversations = new FakeConversations();
    const candidate: Product = {
      ...generatorProductWithPower('terminal-detail-generator', 'TSS SGG 6000E 5.5 kW generator', 5.5),
      brand: 'TSS',
      price: 74_990,
      specs: { 'Nominal power': '5.5 kW', voltage: '220 V' }
    };
    const intent = structuredGeneratorCatalogIntent();
    const webRequest: ToolRequest = {
      id: 'terminal-detail-web-check',
      tool: 'web.researchProductFacts',
      args: {
        query: 'проверить ток запуска для TSS SGG 6000E',
        productIntent: 'generator',
        canonicalProductIntent: 'generator',
        productNames: [candidate.name],
        comparisonAttributes: ['пусковой ток подключаемого насоса'],
        comparisonAttributeBindings: []
      },
      rationale: 'confirm the one decisive fact absent from the catalog card',
      required: true
    };
    intent.userMessageSummary = 'buyer asks whether the exact generator will start the pump';
    intent.dialogueUnderstanding = 'the exact catalog generator is useful preliminary orientation, but pump starting current is still unknown';
    intent.nextStepRationale = 'preserve the exact catalog evidence if the external check times out';
    intent.toolRequests = [{
      id: 'terminal-product-details',
      tool: 'catalog.getProductDetails',
      args: {
        productIds: [candidate.id],
        productNames: [candidate.name],
        productIntent: 'generator',
        canonicalProductIntent: 'generator',
        comparisonAttributes: ['price', 'nominal power']
      },
      rationale: 'read the exact current catalog product',
      required: true
    }, webRequest];
    intent.productMentions = [{
      name: candidate.name,
      role: 'target_product',
      productClass: 'generator',
      evidence: 'exact catalog product requested by the buyer'
    }];
    intent.selectionPolicy = {
      ...intent.selectionPolicy!,
      selectionGoal: 'final_fit',
      maxCards: 1,
      requirements: []
    };
    intent.grounding = {
      taskType: 'comparison',
      sourcePolicy: 'web_required',
      webPurpose: 'technical_specs',
      webRequirement: 'independent_required',
      requiredToolKinds: ['catalog.getProductDetails', 'web.researchProductFacts'],
      technicalAttributes: ['пусковой ток подключаемого насоса'],
      rationale: 'catalog details support a preliminary answer while the decisive load fact needs external confirmation'
    };
    conversations.turn = {
      ...conversations.turn,
      deadlineAt: new Date(Date.now() + 4_000).toISOString(),
      plannerContract: intent
    };
    conversations.toolArtifacts = [{
      tool_request_id: 'terminal-product-details',
      tool_name: 'catalog.getProductDetails',
      status: 'ok',
      payload: { productIds: [candidate.id], products: [candidate] },
      warnings: []
    }, {
      tool_request_id: webRequest.id,
      tool_name: 'web.researchProductFacts',
      status: 'ok',
      payload: {
        usedWebSearch: true,
        searchDisposition: 'completed',
        researchOutcome: 'exhausted',
        sourcesExhausted: true,
        sourceAttempts: [
          { tier: 'catalog', outcome: 'not_found' },
          { tier: 'official_page', outcome: 'not_found', query: 'TSS SGG 6000E official page pump starting current' },
          { tier: 'official_manual', outcome: 'not_found', query: 'TSS SGG 6000E official manual pump starting current PDF' },
          { tier: 'reliable_secondary', outcome: 'not_found', query: 'TSS SGG 6000E reliable distributor pump starting current' }
        ],
        facts: [],
        conflicts: [],
        answerGuidance: {
          directAnswer: '',
          completeness: 'not_answered',
          coverage: [{
            attribute: 'пусковой ток подключаемого насоса',
            status: 'not_confirmed',
            value: '',
            evidence: 'the decisive fact was not confirmed after source review'
          }]
        },
        warnings: []
      },
      warnings: []
    }];
    const orchestrator = new AgentManagerOrchestrator(
      conversations as never,
      new FakeProducts() as never,
      new FakeLeads() as never,
      model()
    );

    const payload = await orchestrator.generateAnswer({
      sessionId,
      turnId,
      userMessage: 'Подойдёт ли этот TSS SGG 6000E для насоса?'
    });
    const metadata = payload.metadata as {
      answerContract?: { selectedProductIds?: string[]; leadAction?: string; selectionReadiness?: { missingFacts?: string[] } };
      terminalCatalogRecovery?: { selectedProductIds?: string[]; catalogRequestIds?: string[]; technicalHandoffEligible?: boolean };
    };

    expect(metadata.terminalCatalogRecovery?.selectedProductIds).toEqual([candidate.id]);
    expect(payload.usedWebSearch).toBe(true);
    expect(payload.answer).toContain(candidate.name);
    expect(payload.answer).toContain('74 990');
    expect(payload.answer).toContain('пусковой ток подключаемого насоса');
    expect(payload.answer).toContain('техническому специалисту');
    expect(payload.answer).toContain('написать или позвонить');
    expect(payload.answer).not.toContain('уже передан');
    expect(payload.productCards.map((card) => card.id)).toEqual([candidate.id]);
    expect(payload.leadRequested).toBe(true);
    expect(metadata.answerContract?.selectedProductIds).toEqual([candidate.id]);
    expect(metadata.answerContract?.leadAction).toBe('offer_form');
    expect(metadata.answerContract?.selectionReadiness?.missingFacts).toEqual(['пусковой ток подключаемого насоса']);
    expect(metadata.terminalCatalogRecovery).toMatchObject({
      selectedProductIds: [candidate.id],
      catalogRequestIds: ['terminal-product-details'],
      technicalHandoffEligible: true
    });
    expect(conversations.assistantSaves).toContainEqual(expect.objectContaining({
      content: expect.stringContaining(candidate.name)
    }));
  });
});

describe('parallel semantic turn contracts', () => {
  function noToolIntent(summary: string): AgentIntentContract {
    return {
      userMessageSummary: summary,
      dialogueUnderstanding: 'the current buyer turn is understood from the updated ledger state',
      nextStepRationale: 'answer directly without a tool',
      requiresTools: false,
      toolRequests: [],
      productMentions: [],
      selectionPolicy: {
        ...currentNoProductSelectionPolicy(),
        selectionGoal: 'browse_catalog'
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
        taskType: 'technical_answer',
        sourcePolicy: 'conversation_only',
        webPurpose: 'none',
        requiredToolKinds: [],
        technicalAttributes: [],
        rationale: 'the answer is already grounded in the current conversation'
      },
      mustNotAskQuestionIds: [],
      riskFlags: []
    };
  }

  it('uses one authoritative semantic decision in the production-capable model path', async () => {
    const conversations = new FakeConversations();
    const decideTurn = vi.fn(async (): Promise<import('../src/ai/agentManagerContracts.js').AgentSemanticDecision> => ({
      ledgerDelta: {
        rationale: 'one interpretation owns state and execution',
        events: []
      },
      intent: noToolIntent('one semantic decision summary') as import('../src/ai/agentManagerContracts.js').AgentSemanticDecision['intent']
    }));
    const proposeLedgerDelta = vi.fn(async () => ({ rationale: 'must not run', events: [] }));
    const planTurn = vi.fn(async () => noToolIntent('must not run'));
    const orchestrator = new AgentManagerOrchestrator(
      conversations as never,
      new FakeProducts() as never,
      new FakeLeads() as never,
      model({ decideTurn, proposeLedgerDelta, planTurn })
    );

    const payload = await orchestrator.generateAnswer({
      sessionId,
      turnId,
      userMessage: conversations.messages[0]!.content
    });

    expect(payload.answer).toContain('5 kW');
    expect(decideTurn).toHaveBeenCalledTimes(1);
    expect(proposeLedgerDelta).not.toHaveBeenCalled();
    expect(planTurn).not.toHaveBeenCalled();
    expect(conversations.checkpoints).toContainEqual(expect.objectContaining({
      checkpoint: 'semantic_decision_proposed',
      payload: expect.objectContaining({
        ledgerDelta: expect.objectContaining({ rationale: 'one interpretation owns state and execution' }),
        intent: expect.objectContaining({ userMessageSummary: 'one semantic decision summary' })
      })
    }));
    expect(conversations.traces).toContainEqual(expect.objectContaining({
      eventType: 'semantic_decision_completed'
    }));
  });

  it('allows exactly one semantic correction attempt before execution', async () => {
    const conversations = new FakeConversations();
    const coherentIntent = noToolIntent('corrected semantic decision');
    const decideTurn = vi.fn(async (
      _input: import('../src/ai/agentManagerOrchestrator.js').AgentManagerModelInput
    ): Promise<import('../src/ai/agentManagerContracts.js').AgentSemanticDecision> => {
      if (decideTurn.mock.calls.length === 1) {
        return {
          ledgerDelta: {
            rationale: 'incorrectly mixes two active product classes',
            events: [{
              eventType: 'need.opened',
              scope: 'need',
              payload: {
                needId: 'generator-need',
                productClass: 'generator',
                summary: 'generator need',
                constraints: [],
                constraintsUpdateMode: 'replace',
                openQuestions: [],
                openQuestionsUpdateMode: 'clear',
                selectedProductIds: [],
                rejectedProductIds: [],
                rejectedProductIdsUpdateMode: 'clear',
                selectionUpdateMode: 'clear',
                invalidatedProductIds: [],
                status: 'open',
                activate: true
              },
              evidence: 'buyer needs a generator',
              source: 'llm_state_delta',
              status: 'active'
            }, {
              eventType: 'fact.confirmed',
              scope: 'need',
              payload: {
                factKey: 'budget_max_rub',
                value: 180000,
                needId: 'generator-need',
                productClass: 'generator',
                role: 'hard_requirement',
                confidence: 1
              },
              evidence: 'budget is 180000 RUB',
              source: 'llm_state_delta',
              status: 'active'
            }]
          },
          intent: {
            ...coherentIntent,
            selectionPolicy: {
              ...coherentIntent.selectionPolicy!,
              targetProductClass: 'plate',
              canonicalProductClass: 'plate'
            }
          } as import('../src/ai/agentManagerContracts.js').AgentSemanticDecision['intent']
        };
      }
      return {
        ledgerDelta: { rationale: 'corrected coherent interpretation', events: [] },
        intent: coherentIntent as import('../src/ai/agentManagerContracts.js').AgentSemanticDecision['intent']
      };
    });
    const orchestrator = new AgentManagerOrchestrator(
      conversations as never,
      new FakeProducts() as never,
      new FakeLeads() as never,
      model({ decideTurn })
    );

    await orchestrator.generateAnswer({
      sessionId,
      turnId,
      userMessage: conversations.messages[0]!.content
    });

    expect(decideTurn).toHaveBeenCalledTimes(2);
    expect(decideTurn.mock.calls[1]?.[0].semanticValidationIssues).toContain(
      'active_requirement_mismatch:budget_max_rub'
    );
    expect(conversations.traces).toContainEqual(expect.objectContaining({
      eventType: 'semantic_decision_validated',
      payload: expect.objectContaining({ attempt: 1, valid: false })
    }));
    expect(conversations.checkpoints.filter((checkpoint) =>
      (checkpoint as { checkpoint?: string }).checkpoint === 'semantic_decision_proposed'
    )).toHaveLength(1);
  });

  it('terminalizes a second incoherent semantic decision with typed evidence', async () => {
    const conversations = new FakeConversations();
    const badIntent = noToolIntent('incoherent semantic decision');
    const decideTurn = vi.fn(async (
      _input: import('../src/ai/agentManagerOrchestrator.js').AgentManagerModelInput
    ): Promise<import('../src/ai/agentManagerContracts.js').AgentSemanticDecision> => ({
      ledgerDelta: {
        rationale: 'creates a hard budget that execution ignores',
        events: [{
          eventType: 'fact.confirmed',
          scope: 'need',
          payload: {
            factKey: 'budget_max_rub',
            value: 180000,
            productClass: 'generator',
            role: 'hard_requirement',
            confidence: 1
          },
          evidence: 'budget is 180000 RUB',
          source: 'llm_state_delta',
          status: 'active'
        }]
      },
      intent: badIntent as import('../src/ai/agentManagerContracts.js').AgentSemanticDecision['intent']
    }));
    const composeAnswer = vi.fn();
    const orchestrator = new AgentManagerOrchestrator(
      conversations as never,
      new FakeProducts() as never,
      new FakeLeads() as never,
      model({ decideTurn, composeAnswer })
    );

    const payload = await orchestrator.generateAnswer({
      sessionId,
      turnId,
      userMessage: conversations.messages[0]!.content
    });

    expect(decideTurn).toHaveBeenCalledTimes(2);
    expect(composeAnswer).not.toHaveBeenCalled();
    expect(payload.metadata).toMatchObject({
      terminal: true,
      terminalReason: 'semantic_decision_incoherent_after_bounded_retry'
    });
    expect(conversations.checkpoints).toContainEqual(expect.objectContaining({
      checkpoint: 'semantic_decision_proposed',
      status: 'failed',
      errorCode: 'semantic_decision_incoherent',
      payload: { issues: expect.arrayContaining(['active_requirement_mismatch:budget_max_rub']) }
    }));
  });

  it('keeps the legacy fake-model reducer and planner concurrent for compatibility', async () => {
    const conversations = new FakeConversations();
    const leads = new FakeLeads();
    leads.pendingDraft = {
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      sessionId,
      originTurnId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      originToolRequestId: 'lead.capture:origin',
      purpose: 'confirm delivery details',
      buyerQuestion: 'Can you confirm delivery details?',
      preferredContact: 'message',
      name: null,
      phone: '+7 900 000-00-11',
      email: null,
      consentEvidenceHash: 'consent-hash',
      scopeHash: 'scope-hash',
      status: 'pending',
      expiresAt: new Date('2026-05-19T12:30:00.000Z').toISOString(),
      consumedByTurnId: null,
      consumedLeadId: null,
      createdAt: new Date('2026-05-19T12:00:00.000Z').toISOString(),
      updatedAt: new Date('2026-05-19T12:00:00.000Z').toISOString()
    };
    let startedCalls = 0;
    let releaseBoth!: () => void;
    const bothStarted = new Promise<void>((resolve) => { releaseBoth = resolve; });
    const markStarted = () => {
      startedCalls += 1;
      if (startedCalls === 2) releaseBoth();
      return bothStarted;
    };
    const assertPendingDraftContext = (input: Parameters<AgentManagerModel['proposeLedgerDelta']>[0]) => {
      expect(input.pendingLeadCaptureDraft).toMatchObject({
        id: leads.pendingDraft?.id,
        purpose: 'confirm delivery details',
        buyerQuestion: 'Can you confirm delivery details?',
        preferredContact: 'message',
        hasName: false,
        hasPhone: true,
        hasEmail: false,
        missingFields: ['name']
      });
      expect(input.pendingLeadCaptureDraft).not.toHaveProperty('phone');
    };
    const proposeLedgerDelta = vi.fn(async (input: Parameters<AgentManagerModel['proposeLedgerDelta']>[0]) => {
      assertPendingDraftContext(input);
      await markStarted();
      return {
        rationale: 'the current turn does not add a new durable fact',
        events: []
      };
    });
    const planTurn = vi.fn(async (input: Parameters<AgentManagerModel['planTurn']>[0]) => {
      assertPendingDraftContext(input);
      await markStarted();
      return noToolIntent('parallel planner summary');
    });
    const orchestrator = new AgentManagerOrchestrator(
      conversations as never,
      new FakeProducts() as never,
      leads as never,
      model({ proposeLedgerDelta, planTurn })
    );

    const payload = await orchestrator.generateAnswer({
      sessionId,
      turnId,
      userMessage: conversations.messages[0]!.content
    });

    expect(payload.answer).toContain('5 kW');
    expect(proposeLedgerDelta).toHaveBeenCalledTimes(1);
    expect(planTurn).toHaveBeenCalledTimes(1);
    expect(startedCalls).toBe(2);
    const checkpointNames = conversations.checkpoints.map((checkpoint) =>
      (checkpoint as { checkpoint?: string }).checkpoint
    );
    expect(checkpointNames.indexOf('ledger_delta_proposed')).toBeLessThan(checkpointNames.indexOf('ledger_delta_applied'));
    expect(checkpointNames.indexOf('ledger_delta_applied')).toBeLessThan(checkpointNames.indexOf('intent_contract_created'));
    expect(conversations.checkpoints).toContainEqual(expect.objectContaining({
      checkpoint: 'ledger_delta_proposed',
      payload: expect.objectContaining({ rationale: 'the current turn does not add a new durable fact' })
    }));
    expect(conversations.checkpoints).toContainEqual(expect.objectContaining({
      checkpoint: 'intent_contract_proposed',
      payload: expect.objectContaining({ userMessageSummary: 'parallel planner summary' })
    }));
    expect(conversations.checkpoints).toContainEqual(expect.objectContaining({
      checkpoint: 'intent_contract_created',
      payload: expect.objectContaining({ userMessageSummary: 'parallel planner summary' })
    }));
  });

  it('still checkpoints the valid intent when persistence of the sibling delta fails', async () => {
    class DeltaCheckpointFailureConversations extends FakeConversations {
      override async upsertTurnCheckpoint(input: unknown) {
        if ((input as { checkpoint?: string }).checkpoint === 'ledger_delta_proposed') {
          throw new Error('delta checkpoint storage failed');
        }
        return super.upsertTurnCheckpoint(input);
      }
    }
    const conversations = new DeltaCheckpointFailureConversations();
    const proposeLedgerDelta = vi.fn(async () => ({
      rationale: 'valid delta whose checkpoint storage fails',
      events: []
    }));
    const planTurn = vi.fn(async () => noToolIntent('intent persisted independently of the delta checkpoint'));
    const orchestrator = new AgentManagerOrchestrator(
      conversations as never,
      new FakeProducts() as never,
      new FakeLeads() as never,
      model({ proposeLedgerDelta, planTurn })
    );

    await expect(orchestrator.generateAnswer({
      sessionId,
      turnId,
      userMessage: conversations.messages[0]!.content
    })).rejects.toThrow('delta checkpoint storage failed');

    expect(proposeLedgerDelta).toHaveBeenCalledTimes(1);
    expect(planTurn).toHaveBeenCalledTimes(1);
    expect(conversations.checkpoints).toContainEqual(expect.objectContaining({
      checkpoint: 'intent_contract_proposed',
      status: 'succeeded',
      payload: expect.objectContaining({
        userMessageSummary: 'intent persisted independently of the delta checkpoint'
      })
    }));
  });

  it('uses the separate planner during recovery when only the delta checkpoint exists', async () => {
    const conversations = new FakeConversations();
    conversations.checkpoints = [{
      checkpoint: 'ledger_delta_proposed',
      status: 'succeeded',
      payload: { rationale: 'saved delta from the interrupted first attempt', events: [] }
    }];
    const proposeLedgerDelta = vi.fn(async () => {
      throw new Error('saved delta must be reused');
    });
    const planTurn = vi.fn(async () => noToolIntent('recovered separate planner summary'));
    const orchestrator = new AgentManagerOrchestrator(
      conversations as never,
      new FakeProducts() as never,
      new FakeLeads() as never,
      model({ proposeLedgerDelta, planTurn })
    );

    const payload = await orchestrator.recoverTurn({ sessionId, turnId });

    expect(payload.answer).toContain('5 kW');
    expect(proposeLedgerDelta).not.toHaveBeenCalled();
    expect(planTurn).toHaveBeenCalledTimes(1);
    expect(conversations.checkpoints).toContainEqual(expect.objectContaining({
      checkpoint: 'intent_contract_created',
      payload: expect.objectContaining({ userMessageSummary: 'recovered separate planner summary' })
    }));
  });

  it('records an exhausted semantic output cap and recovery retries only that stage with a larger bounded cap', async () => {
    const conversations = new FakeConversations();
    const attemptedCaps: Array<number | undefined> = [];
    const exhausted = Object.assign(new Error('Structured JSON retry skipped: output_limit_exhausted'), {
      code: 'structured_json_retry_skipped',
      retryReason: 'output_limit_exhausted'
    });
    const proposeLedgerDelta = vi.fn(async (input: Parameters<AgentManagerModel['proposeLedgerDelta']>[0]) => {
      attemptedCaps.push(input.structuredOutputTokenCap);
      if (attemptedCaps.length === 1) throw exhausted;
      return { rationale: 'expanded recovery cap completed the reducer', events: [] };
    });
    const planTurn = vi.fn(async () => noToolIntent('planner survives reducer output exhaustion'));
    const orchestrator = new AgentManagerOrchestrator(
      conversations as never,
      new FakeProducts() as never,
      new FakeLeads() as never,
      model({ proposeLedgerDelta, planTurn })
    );

    await expect(orchestrator.generateAnswer({
      sessionId,
      turnId,
      userMessage: conversations.messages[0]!.content
    })).rejects.toThrow('output_limit_exhausted');

    expect(conversations.checkpoints).toContainEqual(expect.objectContaining({
      checkpoint: 'ledger_delta_proposed',
      status: 'failed',
      errorCode: 'structured_json_output_limit_exhausted',
      payload: expect.objectContaining({
        retryReason: 'output_limit_exhausted',
        attemptedOutputTokenCap: config.OPENAI_PLANNER_MAX_OUTPUT_TOKENS
      })
    }));
    expect(conversations.traces).toContainEqual(expect.objectContaining({
      eventType: 'parallel_semantic_calls_partially_failed',
      payload: expect.objectContaining({
        failures: expect.arrayContaining([
          expect.objectContaining({ retryReason: 'output_limit_exhausted' })
        ])
      })
    }));

    const payload = await orchestrator.recoverTurn({ sessionId, turnId });

    expect(payload.answer).toContain('5 kW');
    expect(attemptedCaps).toEqual([
      undefined,
      Math.ceil(config.OPENAI_PLANNER_MAX_OUTPUT_TOKENS * 1.5)
    ]);
    expect(proposeLedgerDelta).toHaveBeenCalledTimes(2);
    expect(planTurn).toHaveBeenCalledTimes(1);
  });

  it('keeps a valid parallel delta when the planner fails and recovery runs only the missing planner stage', async () => {
    const conversations = new FakeConversations();
    const proposeLedgerDelta = vi.fn(async () => ({
      rationale: 'valid parallel delta survives the sibling planner failure',
      events: []
    }));
    const planTurn = vi.fn()
      .mockRejectedValueOnce(new Error('parallel planner failed'))
      .mockResolvedValueOnce(noToolIntent('recovered planner summary'));
    const orchestrator = new AgentManagerOrchestrator(
      conversations as never,
      new FakeProducts() as never,
      new FakeLeads() as never,
      model({ proposeLedgerDelta, planTurn })
    );

    await expect(orchestrator.generateAnswer({
      sessionId,
      turnId,
      userMessage: conversations.messages[0]!.content
    })).rejects.toThrow('parallel planner failed');

    expect(proposeLedgerDelta).toHaveBeenCalledTimes(1);
    expect(planTurn).toHaveBeenCalledTimes(1);
    expect(conversations.checkpoints).toContainEqual(expect.objectContaining({
      checkpoint: 'ledger_delta_proposed',
      payload: expect.objectContaining({
        rationale: 'valid parallel delta survives the sibling planner failure'
      })
    }));
    expect(conversations.checkpoints).not.toContainEqual(expect.objectContaining({
      checkpoint: 'intent_contract_proposed',
      status: 'succeeded'
    }));

    const payload = await orchestrator.recoverTurn({ sessionId, turnId });

    expect(payload.answer).toContain('5 kW');
    expect(proposeLedgerDelta).toHaveBeenCalledTimes(1);
    expect(planTurn).toHaveBeenCalledTimes(2);
    expect(conversations.checkpoints).toContainEqual(expect.objectContaining({
      checkpoint: 'ledger_delta_applied',
      status: 'succeeded'
    }));
    expect(conversations.checkpoints).toContainEqual(expect.objectContaining({
      checkpoint: 'intent_contract_created',
      payload: expect.objectContaining({ userMessageSummary: 'recovered planner summary' })
    }));
  });

  it('reconciles an unknown active need after recovery plans the missing intent stage', async () => {
    const conversations = new FakeConversations();
    const proposeLedgerDelta = vi.fn(async (): Promise<LedgerStateDelta> => ({
      rationale: 'open a need before the sibling planner fails',
      events: [{
        eventType: 'need.opened',
        scope: 'need',
        payload: {
          needId: 'recovered-generator-need',
          productClass: 'unknown',
          summary: 'diesel generator selection',
          constraints: ['three phase'],
          openQuestions: [],
          selectedProductIds: [],
          rejectedProductIds: [],
          selectionUpdateMode: 'clear',
          invalidatedProductIds: [],
          status: 'open',
          activate: true
        },
        evidence: 'buyer needs a diesel generator',
        source: 'llm_state_delta',
        status: 'active'
      }]
    }));
    const recoveredIntent: AgentIntentContract = {
      ...noToolIntent('recovered generator planner intent'),
      selectionPolicy: {
        ...currentNoProductSelectionPolicy(),
        targetProductClass: 'generator',
        canonicalProductClass: 'generator',
        selectionGoal: 'browse_catalog',
        needAction: 'open'
      }
    };
    const planTurn = vi.fn()
      .mockRejectedValueOnce(new Error('parallel planner failed before intent checkpoint'))
      .mockResolvedValueOnce(recoveredIntent);
    const orchestrator = new AgentManagerOrchestrator(
      conversations as never,
      new FakeProducts() as never,
      new FakeLeads() as never,
      model({ proposeLedgerDelta, planTurn })
    );

    await expect(orchestrator.generateAnswer({
      sessionId,
      turnId,
      userMessage: 'I need a three-phase diesel generator.'
    })).rejects.toThrow('parallel planner failed before intent checkpoint');

    await orchestrator.recoverTurn({ sessionId, turnId });

    expect(proposeLedgerDelta).toHaveBeenCalledTimes(1);
    expect(planTurn).toHaveBeenCalledTimes(2);
    expect(conversations.ledgerEvents).toContainEqual(expect.objectContaining({
      eventType: 'need.updated',
      source: 'system_reducer',
      payload: expect.objectContaining({
        needId: 'recovered-generator-need',
        productClass: 'generator'
      })
    }));
    expect(conversations.traces).toContainEqual(expect.objectContaining({
      eventType: 'post_plan_active_need_product_class_reconciled',
      payload: expect.objectContaining({
        needId: 'recovered-generator-need',
        canonicalProductClass: 'generator'
      })
    }));
  });

  it('keeps a valid parallel intent when the reducer fails and recovery runs only the missing reducer stage', async () => {
    const conversations = new FakeConversations();
    const proposeLedgerDelta = vi.fn()
      .mockRejectedValueOnce(new Error('parallel reducer failed'))
      .mockResolvedValueOnce({
        rationale: 'recovered reducer delta',
        events: []
      });
    const planTurn = vi.fn(async () => noToolIntent('valid parallel intent survives the sibling reducer failure'));
    const orchestrator = new AgentManagerOrchestrator(
      conversations as never,
      new FakeProducts() as never,
      new FakeLeads() as never,
      model({ proposeLedgerDelta, planTurn })
    );

    await expect(orchestrator.generateAnswer({
      sessionId,
      turnId,
      userMessage: conversations.messages[0]!.content
    })).rejects.toThrow('parallel reducer failed');

    expect(proposeLedgerDelta).toHaveBeenCalledTimes(1);
    expect(planTurn).toHaveBeenCalledTimes(1);
    expect(conversations.checkpoints).toContainEqual(expect.objectContaining({
      checkpoint: 'intent_contract_proposed',
      payload: expect.objectContaining({
        userMessageSummary: 'valid parallel intent survives the sibling reducer failure'
      })
    }));
    expect(conversations.checkpoints).not.toContainEqual(expect.objectContaining({
      checkpoint: 'ledger_delta_proposed',
      status: 'succeeded'
    }));

    const payload = await orchestrator.recoverTurn({ sessionId, turnId });

    expect(payload.answer).toContain('5 kW');
    expect(proposeLedgerDelta).toHaveBeenCalledTimes(2);
    expect(planTurn).toHaveBeenCalledTimes(1);
    expect(conversations.checkpoints).toContainEqual(expect.objectContaining({
      checkpoint: 'ledger_delta_proposed',
      payload: expect.objectContaining({ rationale: 'recovered reducer delta' })
    }));
    expect(conversations.checkpoints).toContainEqual(expect.objectContaining({
      checkpoint: 'intent_contract_created',
      payload: expect.objectContaining({
        userMessageSummary: 'valid parallel intent survives the sibling reducer failure'
      })
    }));
  });

  it('replans once after the parallel reducer opens a product class that conflicts with the pre-delta intent', async () => {
    const conversations = new FakeConversations();
    const proposeLedgerDelta = vi.fn(async (): Promise<LedgerStateDelta> => ({
      rationale: 'the buyer switched to a plate compactor need',
      events: [{
        eventType: 'need.opened',
        scope: 'need',
        payload: {
          needId: 'plate',
          productClass: 'plate',
          summary: 'current plate compactor need',
          constraints: [],
          openQuestions: [],
          selectedProductIds: [],
          rejectedProductIds: [],
          selectionUpdateMode: 'clear',
          invalidatedProductIds: [],
          status: 'open',
          activate: true
        },
        evidence: 'I now need a plate compactor.',
        source: 'llm_state_delta',
        status: 'active'
      }]
    }));
    const staleGeneratorIntent: AgentIntentContract = {
      ...noToolIntent('stale pre-delta generator intent'),
      selectionPolicy: {
        ...currentNoProductSelectionPolicy(),
        targetProductClass: 'generator',
        canonicalProductClass: 'generator',
        selectionGoal: 'browse_catalog',
        needAction: 'continue'
      }
    };
    const correctedPlateIntent: AgentIntentContract = {
      ...noToolIntent('corrected post-delta plate intent'),
      selectionPolicy: {
        ...currentNoProductSelectionPolicy(),
        targetProductClass: 'plate',
        canonicalProductClass: 'plate',
        selectionGoal: 'browse_catalog',
        needAction: 'open'
      }
    };
    const planTurn = vi.fn()
      .mockResolvedValueOnce(staleGeneratorIntent)
      .mockImplementationOnce(async (input: Parameters<AgentManagerModel['planTurn']>[0]) => {
        expect(Object.values(input.ledgerState.needsById)).toContainEqual(expect.objectContaining({
          needId: 'plate',
          productClass: 'plate',
          status: 'open'
        }));
        return correctedPlateIntent;
      });
    const orchestrator = new AgentManagerOrchestrator(
      conversations as never,
      new FakeProducts() as never,
      new FakeLeads() as never,
      model({ proposeLedgerDelta, planTurn })
    );

    const payload = await orchestrator.generateAnswer({
      sessionId,
      turnId,
      userMessage: 'I now need a plate compactor.'
    });

    expect(payload.answer).toContain('5 kW');
    expect(proposeLedgerDelta).toHaveBeenCalledTimes(1);
    expect(planTurn).toHaveBeenCalledTimes(2);
    expect(conversations.turn.plannerContract).toMatchObject({
      userMessageSummary: 'corrected post-delta plate intent',
      selectionPolicy: expect.objectContaining({ canonicalProductClass: 'plate', needAction: 'open' })
    });
    expect(conversations.traces).toContainEqual(expect.objectContaining({
      phase: 'intent',
      eventType: 'parallel_intent_replan_required',
      payload: expect.objectContaining({
        conflicts: expect.arrayContaining([
          'active_product_class_mismatch:plate:generator',
          'opened_need_action_mismatch:continue'
        ])
      })
    }));
  });

  it('reconciles one same-class parallel opened need without a second planner call', async () => {
    const conversations = new FakeConversations();
    const proposeLedgerDelta = vi.fn(async (): Promise<LedgerStateDelta> => ({
      rationale: 'open the first equipment need',
      events: [{
        eventType: 'need.opened',
        scope: 'need',
        payload: {
          needId: 'generator',
          productClass: 'unknown',
          summary: 'current generator need',
          constraints: [],
          openQuestions: [],
          selectedProductIds: [],
          rejectedProductIds: [],
          selectionUpdateMode: 'clear',
          invalidatedProductIds: [],
          status: 'open',
          activate: true
        },
        evidence: 'I need a generator.',
        source: 'llm_state_delta',
        status: 'active'
      }]
    }));
    const parallelIntent: AgentIntentContract = {
      ...noToolIntent('parallel planner understood the same generator need'),
      selectionPolicy: {
        ...currentNoProductSelectionPolicy(),
        targetProductClass: 'generator',
        canonicalProductClass: 'generator',
        selectionGoal: 'browse_catalog',
        needAction: 'continue'
      }
    };
    const planTurn = vi.fn(async () => parallelIntent);
    const orchestrator = new AgentManagerOrchestrator(
      conversations as never,
      new FakeProducts() as never,
      new FakeLeads() as never,
      model({ proposeLedgerDelta, planTurn })
    );

    await orchestrator.generateAnswer({
      sessionId,
      turnId,
      userMessage: 'I need a generator.'
    });

    expect(planTurn).toHaveBeenCalledTimes(1);
    expect(conversations.turn.plannerContract).toMatchObject({
      selectionPolicy: expect.objectContaining({
        canonicalProductClass: 'generator',
        needAction: 'open'
      })
    });
    expect(conversations.traces).toContainEqual(expect.objectContaining({
      phase: 'ledger',
      eventType: 'active_need_product_class_reconciled'
    }));
    expect(conversations.traces).toContainEqual(expect.objectContaining({
      phase: 'intent',
      eventType: 'parallel_intent_need_action_reconciled'
    }));
    expect(conversations.traces).not.toContainEqual(expect.objectContaining({
      eventType: 'parallel_intent_replan_required'
    }));
  });

  it('replans once when the parallel reducer changes typed hard requirements after the planner read the old ledger', async () => {
    const conversations = new FakeConversations();
    const proposeLedgerDelta = vi.fn(async (): Promise<LedgerStateDelta> => ({
      rationale: 'replace the generator budget and phase requirements',
      events: [{
        eventType: 'need.opened',
        scope: 'need',
        payload: {
          needId: 'generator',
          productClass: 'generator',
          summary: 'current generator need',
          constraints: [],
          openQuestions: [],
          selectedProductIds: [],
          rejectedProductIds: [],
          selectionUpdateMode: 'clear',
          invalidatedProductIds: [],
          status: 'open',
          activate: true
        },
        evidence: 'The current request is for a generator.',
        source: 'llm_state_delta',
        status: 'active'
      }, {
        eventType: 'fact.confirmed',
        scope: 'need',
        payload: {
          factKey: 'budget_max_rub',
          value: 50_000,
          needId: 'generator',
          productClass: 'generator',
          role: 'hard_requirement',
          confidence: 1
        },
        evidence: 'The updated budget is 50,000 RUB.',
        source: 'llm_state_delta',
        status: 'active'
      }, {
        eventType: 'fact.confirmed',
        scope: 'need',
        payload: {
          factKey: 'phase',
          value: 'single_phase',
          needId: 'generator',
          productClass: 'generator',
          role: 'hard_requirement',
          confidence: 1
        },
        evidence: 'The updated phase is single-phase.',
        source: 'llm_state_delta',
        status: 'active'
      }]
    }));
    const intentWithRequirements = (
      summary: string,
      budget: number,
      phase: 'single_phase' | 'three_phase'
    ): AgentIntentContract => ({
      ...noToolIntent(summary),
      selectionPolicy: {
        ...currentNoProductSelectionPolicy(),
        targetProductClass: 'generator',
        canonicalProductClass: 'generator',
        selectionGoal: 'preliminary_fit',
        needAction: 'open',
        phase,
        requirements: [{
          id: 'budget-limit',
          kind: 'budget_max_rub',
          value: budget,
          unit: 'RUB',
          relation: 'must_have',
          role: 'hard_constraint',
          strictness: 'strict',
          evidence: 'typed budget limit'
        }, {
          id: 'phase-limit',
          kind: 'phase',
          value: phase,
          unit: null,
          relation: 'must_have',
          role: 'hard_constraint',
          strictness: 'strict',
          evidence: 'typed phase requirement'
        }]
      }
    });
    const staleIntent = intentWithRequirements('stale pre-delta requirements', 70_000, 'three_phase');
    const correctedIntent = intentWithRequirements('coherent post-delta requirements', 50_000, 'single_phase');
    const planTurn = vi.fn()
      .mockResolvedValueOnce(staleIntent)
      .mockImplementationOnce(async (input: Parameters<AgentManagerModel['planTurn']>[0]) => {
        expect(input.ledgerIncludesCurrentTurnDelta).toBe(true);
        expect(Object.values(input.ledgerState.factsByKey)).toEqual(expect.arrayContaining([
          expect.objectContaining({ factKey: 'budget_max_rub', value: 50_000, role: 'hard_requirement' }),
          expect.objectContaining({ factKey: 'phase', value: 'single_phase', role: 'hard_requirement' })
        ]));
        return correctedIntent;
      });
    const orchestrator = new AgentManagerOrchestrator(
      conversations as never,
      new FakeProducts() as never,
      new FakeLeads() as never,
      model({ proposeLedgerDelta, planTurn })
    );

    await orchestrator.generateAnswer({
      sessionId,
      turnId,
      userMessage: 'Change the budget to 50,000 RUB and use single phase.'
    });

    expect(planTurn).toHaveBeenCalledTimes(2);
    expect(planTurn.mock.calls[0]?.[0].ledgerIncludesCurrentTurnDelta).not.toBe(true);
    expect(conversations.turn.plannerContract).toMatchObject({
      userMessageSummary: 'coherent post-delta requirements',
      selectionPolicy: expect.objectContaining({ phase: 'single_phase' })
    });
    expect(conversations.traces).toContainEqual(expect.objectContaining({
      phase: 'intent',
      eventType: 'parallel_intent_replan_required',
      payload: expect.objectContaining({
        conflicts: expect.arrayContaining([
          'active_requirement_mismatch:budget_max_rub',
          'active_requirement_mismatch:phase'
        ])
      })
    }));
  });

  it('replans once when the reducer adds a new typed hard requirement omitted by the parallel planner', async () => {
    const conversations = new FakeConversations();
    const proposeLedgerDelta = vi.fn(async (): Promise<LedgerStateDelta> => ({
      rationale: 'add the newly stated generator weight limit',
      events: [{
        eventType: 'need.opened',
        scope: 'need',
        payload: {
          needId: 'generator',
          productClass: 'generator',
          summary: 'current generator need',
          constraints: [],
          openQuestions: [],
          selectedProductIds: [],
          rejectedProductIds: [],
          selectionUpdateMode: 'clear',
          invalidatedProductIds: [],
          status: 'open',
          activate: true
        },
        evidence: 'The current request is for a generator.',
        source: 'llm_state_delta',
        status: 'active'
      }, {
        eventType: 'fact.confirmed',
        scope: 'need',
        payload: {
          factKey: 'weight_max_kg',
          value: 90,
          needId: 'generator',
          productClass: 'generator',
          role: 'hard_requirement',
          confidence: 1
        },
        evidence: 'The generator must weigh no more than 90 kg.',
        source: 'llm_state_delta',
        status: 'active'
      }]
    }));
    const omittedIntent: AgentIntentContract = {
      ...noToolIntent('parallel planner omitted the new weight limit'),
      selectionPolicy: {
        ...currentNoProductSelectionPolicy(),
        targetProductClass: 'generator',
        canonicalProductClass: 'generator',
        selectionGoal: 'preliminary_fit',
        needAction: 'open',
        requirements: []
      }
    };
    const correctedIntent: AgentIntentContract = {
      ...omittedIntent,
      userMessageSummary: 'post-delta planner includes the new weight limit',
      selectionPolicy: {
        ...omittedIntent.selectionPolicy!,
        requirements: [{
          id: 'weight-limit',
          kind: 'weight_max_kg',
          value: 90,
          unit: 'kg',
          relation: 'must_have',
          role: 'hard_constraint',
          strictness: 'strict',
          evidence: 'typed weight limit'
        }]
      }
    };
    const planTurn = vi.fn()
      .mockResolvedValueOnce(omittedIntent)
      .mockResolvedValueOnce(correctedIntent);
    const orchestrator = new AgentManagerOrchestrator(
      conversations as never,
      new FakeProducts() as never,
      new FakeLeads() as never,
      model({ proposeLedgerDelta, planTurn })
    );

    await orchestrator.generateAnswer({
      sessionId,
      turnId,
      userMessage: 'Keep the generator under 90 kg.'
    });

    expect(planTurn).toHaveBeenCalledTimes(2);
    expect(conversations.turn.plannerContract).toMatchObject({
      userMessageSummary: 'post-delta planner includes the new weight limit'
    });
    expect(conversations.traces).toContainEqual(expect.objectContaining({
      phase: 'intent',
      eventType: 'parallel_intent_replan_required',
      payload: expect.objectContaining({
        conflicts: expect.arrayContaining(['active_requirement_mismatch:weight_max_kg'])
      })
    }));
  });

  it('keeps the parallel planner fast path when its typed hard requirements match the applied delta', async () => {
    const conversations = new FakeConversations();
    const proposeLedgerDelta = vi.fn(async (): Promise<LedgerStateDelta> => ({
      rationale: 'confirm the current generator budget',
      events: [{
        eventType: 'need.opened',
        scope: 'need',
        payload: {
          needId: 'generator',
          productClass: 'generator',
          summary: 'current generator need',
          constraints: [],
          openQuestions: [],
          selectedProductIds: [],
          rejectedProductIds: [],
          selectionUpdateMode: 'clear',
          invalidatedProductIds: [],
          status: 'open',
          activate: true
        },
        evidence: 'The current request is for a generator.',
        source: 'llm_state_delta',
        status: 'active'
      }, {
        eventType: 'fact.confirmed',
        scope: 'need',
        payload: {
          factKey: 'budget_max_rub',
          value: 50_000,
          needId: 'generator',
          productClass: 'generator',
          role: 'hard_requirement',
          confidence: 1
        },
        evidence: 'The budget is 50,000 RUB.',
        source: 'llm_state_delta',
        status: 'active'
      }, {
        eventType: 'fact.confirmed',
        scope: 'need',
        payload: {
          factKey: 'phase',
          value: 'single_phase',
          needId: 'generator',
          productClass: 'generator',
          role: 'hard_requirement',
          confidence: 1
        },
        evidence: 'Single phase is required.',
        source: 'llm_state_delta',
        status: 'active'
      }, {
        eventType: 'fact.confirmed',
        scope: 'need',
        payload: {
          factKey: 'power_source',
          value: 'fuel',
          needId: 'generator',
          productClass: 'generator',
          role: 'hard_requirement',
          confidence: 1
        },
        evidence: 'A fuel generator is required.',
        source: 'llm_state_delta',
        status: 'active'
      }]
    }));
    const coherentIntent: AgentIntentContract = {
      ...noToolIntent('coherent parallel requirements'),
      selectionPolicy: {
        ...currentNoProductSelectionPolicy(),
        targetProductClass: 'generator',
        canonicalProductClass: 'generator',
        selectionGoal: 'preliminary_fit',
        needAction: 'open',
        phase: 'single_phase',
        powerSource: 'fuel',
        requirements: [{
          id: 'budget-limit',
          kind: 'budget_max_rub',
          value: 50_000,
          unit: 'RUB',
          relation: 'must_have',
          role: 'hard_constraint',
          strictness: 'strict',
          evidence: 'typed budget limit'
        }]
      }
    };
    const planTurn = vi.fn(async (_input: Parameters<AgentManagerModel['planTurn']>[0]) => coherentIntent);
    const orchestrator = new AgentManagerOrchestrator(
      conversations as never,
      new FakeProducts() as never,
      new FakeLeads() as never,
      model({ proposeLedgerDelta, planTurn })
    );

    await orchestrator.generateAnswer({
      sessionId,
      turnId,
      userMessage: 'Keep the generator budget at 50,000 RUB.'
    });

    expect(planTurn).toHaveBeenCalledTimes(1);
    expect(planTurn.mock.calls[0]?.[0].ledgerIncludesCurrentTurnDelta).not.toBe(true);
    expect(conversations.traces).not.toContainEqual(expect.objectContaining({
      eventType: 'parallel_intent_replan_required'
    }));
  });

  it('does not replan the active need when a paused sibling need resets its own selection', async () => {
    const conversations = new FakeConversations();
    const priorTurnId = '77777777-7777-4777-8777-777777777777';
    const priorEvent = (eventId: string, eventType: 'need.opened', payload: Record<string, unknown>) => ({
      session_id: sessionId,
      turn_id: priorTurnId,
      event_id: eventId,
      event_type: eventType,
      scope: 'need',
      payload,
      evidence: String(payload.summary),
      source: 'llm_state_delta',
      status: 'active',
      created_at: new Date('2026-05-19T11:00:00.000Z').toISOString()
    });
    conversations.ledgerEvents = [
      priorEvent('prior-generator-need', 'need.opened', {
        needId: 'generator',
        productClass: 'generator',
        summary: 'paused generator need',
        constraints: [],
        openQuestions: [],
        selectedProductIds: [],
        rejectedProductIds: [],
        selectionUpdateMode: 'preserve',
        invalidatedProductIds: [],
        status: 'open',
        activate: true
      }),
      priorEvent('current-plate-need', 'need.opened', {
        needId: 'plate',
        productClass: 'plate',
        summary: 'active plate need',
        constraints: [],
        openQuestions: [],
        selectedProductIds: [],
        rejectedProductIds: [],
        selectionUpdateMode: 'preserve',
        invalidatedProductIds: [],
        status: 'open',
        activate: true
      })
    ];
    const proposeLedgerDelta = vi.fn(async (): Promise<LedgerStateDelta> => ({
      rationale: 'clear only the paused generator selection without activating it',
      events: [{
        eventType: 'need.updated',
        scope: 'need',
        payload: {
          needId: 'generator',
          productClass: 'generator',
          summary: 'paused generator need reset',
          constraints: [],
          openQuestions: [],
          selectedProductIds: [],
          rejectedProductIds: [],
          selectionUpdateMode: 'clear',
          invalidatedProductIds: [],
          status: 'paused',
          activate: false
        },
        evidence: 'Reset the generator variants, but continue with the plate.',
        source: 'llm_state_delta',
        status: 'active'
      }]
    }));
    const activePlateIntent: AgentIntentContract = {
      ...noToolIntent('continue the active plate need'),
      selectionPolicy: {
        ...currentNoProductSelectionPolicy(),
        targetProductClass: 'plate',
        canonicalProductClass: 'plate',
        selectionGoal: 'browse_catalog',
        needAction: 'continue',
        reusePreviousCards: true
      }
    };
    const planTurn = vi.fn(async () => activePlateIntent);
    const orchestrator = new AgentManagerOrchestrator(
      conversations as never,
      new FakeProducts() as never,
      new FakeLeads() as never,
      model({ proposeLedgerDelta, planTurn })
    );

    const payload = await orchestrator.generateAnswer({
      sessionId,
      turnId,
      userMessage: 'Reset the generator variants, but continue with the plate.'
    });

    expect(payload.answer).toContain('5 kW');
    expect(planTurn).toHaveBeenCalledTimes(1);
    expect(conversations.traces).not.toContainEqual(expect.objectContaining({
      eventType: 'parallel_intent_replan_required'
    }));
  });

  it('replans when the reducer removes an active hard requirement seen by the parallel planner', async () => {
    const conversations = new FakeConversations();
    const priorTurnId = '77777777-7777-4777-8777-777777777770';
    const priorRow = (
      eventId: string,
      eventType: 'need.opened' | 'fact.confirmed',
      scope: 'need',
      payload: Record<string, unknown>
    ) => ({
      session_id: sessionId,
      turn_id: priorTurnId,
      event_id: eventId,
      event_type: eventType,
      scope,
      payload,
      evidence: 'prior confirmed generator budget',
      source: 'llm_state_delta',
      status: 'active',
      created_at: new Date('2026-05-19T11:00:00.000Z').toISOString()
    });
    conversations.ledgerEvents = [
      priorRow('prior-generator-need', 'need.opened', 'need', {
        needId: 'generator',
        productClass: 'generator',
        summary: 'active generator need',
        constraints: ['budget_max_rub: 50000'],
        openQuestions: [],
        selectedProductIds: [],
        rejectedProductIds: [],
        selectionUpdateMode: 'preserve',
        invalidatedProductIds: [],
        status: 'open',
        activate: true
      }),
      priorRow('prior-budget', 'fact.confirmed', 'need', {
        factKey: 'budget_max_rub',
        value: 50_000,
        needId: 'generator',
        productClass: 'generator',
        role: 'hard_requirement',
        confidence: 1
      })
    ];
    const proposeLedgerDelta = vi.fn(async (): Promise<LedgerStateDelta> => ({
      rationale: 'the buyer explicitly removed the old budget limit',
      events: [{
        eventType: 'fact.negated',
        scope: 'need',
        payload: {
          needId: 'generator',
          targetEventIds: ['prior-budget']
        },
        evidence: 'There is no budget limit now.',
        source: 'llm_state_delta',
        status: 'active'
      }]
    }));
    const staleIntent: AgentIntentContract = {
      ...noToolIntent('parallel planner retained the removed budget'),
      selectionPolicy: {
        ...currentNoProductSelectionPolicy(),
        targetProductClass: 'generator',
        canonicalProductClass: 'generator',
        selectionGoal: 'preliminary_fit',
        needAction: 'continue',
        requirements: [{
          id: 'stale-budget',
          kind: 'budget_max_rub',
          value: 50_000,
          unit: 'RUB',
          relation: 'must_have',
          role: 'hard_constraint',
          strictness: 'strict',
          evidence: 'stale budget limit'
        }]
      }
    };
    const correctedIntent: AgentIntentContract = {
      ...staleIntent,
      userMessageSummary: 'post-delta planner removed the old budget',
      selectionPolicy: {
        ...staleIntent.selectionPolicy!,
        requirements: []
      }
    };
    const planTurn = vi.fn()
      .mockResolvedValueOnce(staleIntent)
      .mockResolvedValueOnce(correctedIntent);
    const orchestrator = new AgentManagerOrchestrator(
      conversations as never,
      new FakeProducts() as never,
      new FakeLeads() as never,
      model({ proposeLedgerDelta, planTurn })
    );

    await orchestrator.generateAnswer({
      sessionId,
      turnId,
      userMessage: 'Уберите ограничение по бюджету.'
    });

    expect(planTurn).toHaveBeenCalledTimes(2);
    expect(conversations.turn.plannerContract).toMatchObject({
      userMessageSummary: 'post-delta planner removed the old budget',
      selectionPolicy: expect.objectContaining({ requirements: [] })
    });
    expect(conversations.traces).toContainEqual(expect.objectContaining({
      eventType: 'parallel_intent_replan_required',
      payload: expect.objectContaining({
        conflicts: expect.arrayContaining(['active_requirement_removed:budget_max_rub'])
      })
    }));
  });

  it('preserves a valid typed catalog plan instead of replacing planner semantics from message fragments', () => {
    const intent: AgentIntentContract = {
      turnId: null,
      userMessageSummary: 'buyer asks what cutters are available',
      dialogueUnderstanding: 'ambiguous cutter browse request',
      nextStepRationale: 'the planner chose a safe catalog browse for the current context',
      requiresTools: true,
      toolRequests: [{
        id: 'catalog-cutters',
        tool: 'catalog.search',
        rationale: 'browse cutters',
        required: true,
        coversRequirementIds: [],
        args: {
          query: 'мне нужен резчик че у вас есть?',
          productIntent: 'резчик',
          canonicalProductIntent: 'cutter',
          powerSource: null,
          phase: null,
          limit: 8,
          reason: 'browse cutters',
          notes: null
        }
      }],
      productMentions: [{ name: 'резчик', role: 'target_product', productClass: 'cutter', evidence: 'мне нужен резчик' }],
      selectionPolicy: {
        targetProductClass: 'резчик',
        canonicalProductClass: 'cutter',
        selectionGoal: 'browse_catalog',
        needAction: 'open',
        alternativePolicy: 'same_class_only',
        reusePreviousCards: false,
        maxCards: 8,
        powerSource: null,
        phase: null,
        requirements: [],
        rationale: 'browse cutters'
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
        taskType: 'product_selection',
        sourcePolicy: 'conversation_only',
        webPurpose: 'none',
        webRequirement: 'none',
        requiredToolKinds: ['catalog.search'],
        technicalAttributes: [],
        buyerQuestion: 'мне нужен резчик че у вас есть?',
        rationale: 'browse catalog'
      },
      mustNotAskQuestionIds: [],
      riskFlags: []
    };

    const repaired = repairIntentForCatalogClarificationBeforeTools(intent, 'мне нужен резчик че у вас есть?');

    expect(repaired).toBe(intent);
    expect(repaired.requiresTools).toBe(true);
    expect(repaired.toolRequests.map((request) => request.tool)).toEqual(['catalog.search']);
    expect(repaired.grounding!.requiredToolKinds).toEqual(['catalog.search']);
    expect(repaired.selectionPolicy!.maxCards).toBe(8);
    expect(repaired.selectionPolicy!.selectionGoal).toBe('browse_catalog');
  });


  it('keeps a schema-valid broad catalog plan planner-owned', () => {
    const intent: AgentIntentContract = {
      ...noToolIntent('buyer asks for broad catalog'),
      requiresTools: true,
      toolRequests: [{
        id: 'catalog-all',
        tool: 'catalog.search',
        rationale: 'browse all catalog',
        required: true,
        coversRequirementIds: [],
        args: {
          query: 'что у вас вообще есть?',
          productIntent: 'оборудование',
          canonicalProductIntent: 'unknown',
          powerSource: null,
          phase: null,
          limit: 8,
          reason: 'browse all catalog',
          notes: null
        }
      }],
      selectionPolicy: {
        ...currentNoProductSelectionPolicy(),
        targetProductClass: 'оборудование',
        canonicalProductClass: 'unknown',
        selectionGoal: 'browse_catalog',
        maxCards: 8
      },
      grounding: {
        taskType: 'product_selection',
        sourcePolicy: 'conversation_only',
        webPurpose: 'none',
        webRequirement: 'none',
        requiredToolKinds: ['catalog.search'],
        technicalAttributes: [],
        buyerQuestion: 'что у вас вообще есть?',
        rationale: 'too broad catalog browse'
      }
    };

    const repaired = repairIntentForCatalogClarificationBeforeTools(intent, 'что у вас вообще есть?');

    expect(repaired).toBe(intent);
    expect(repaired.requiresTools).toBe(true);
    expect(repaired.toolRequests.map((request) => request.tool)).toEqual(['catalog.search']);
    expect(repaired.grounding!.requiredToolKinds).toEqual(['catalog.search']);
    expect(repaired.grounding!.sourcePolicy).toBe('conversation_only');
    expect(repaired.selectionPolicy!.maxCards).toBe(8);
    expect(repaired.selectionPolicy!.selectionGoal).toBe('browse_catalog');
    expect(repaired.selectionPolicy!.targetProductClass).toBe('оборудование');
    expect(repaired.selectionPolicy!.canonicalProductClass).toBe('unknown');
  });

});
