import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  AgentManagerOrchestrator,
  RECOVERY_LEASE_WAIT_LIMIT_MS,
  enforceSearchBeforeTechnicalSpecialist,
  orderToolRequestsForSelectionDependencies,
  repairIntentForCatalogClarificationBeforeTools,
  pendingLeadCaptureDraftMatchesAuthorizationScope,
  repairIntentForOpenEndedRequirementWebCoverage,
  repairIntentForElectricStartRequirementKinds,
  repairIntentForNewNeedFinalFit,
  repairIntentForRequestedTechnicalAttributeWebCoverage,
  repairIntentForTypedToolRequirementCoverage,
  productMatchesExactTargetIdentity,
  trustedPendingExhaustedTechnicalHandoffs,
  webResearchResultProvesSourceExhaustion,
  type AgentManagerModel
} from '../src/ai/agentManagerOrchestrator.js';
import { DEFAULT_AGENT_MANAGER_TURN_LIMITS } from '../src/ai/agentManagerTurnBudget.js';
import { inferProductIntent } from '../src/ai/productClassifier.js';
import {
  AgentIntentContractSchema,
  normalizeLedgerStateDeltaEvents,
  type AgentSemanticDecision,
  type AgentIntentContract,
  type DialogueLedgerEvent,
  type LedgerStateDelta,
  type ToolRequest,
  type ToolResult
} from '../src/ai/agentManagerContracts.js';
import { reduceDialogueLedger } from '../src/ai/dialogueLedgerReducer.js';
import { assessStrictSelectionRequirements, budgetMaxFromNeedState, gateStrictSelectionRequirements } from '../src/ai/agentManagerCardSelection.js';
import { emptyNeedState } from '../src/ai/needState.js';
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
          payload: { factKey: 'load.coffee_machine_kw', value: 3.2, needId: 'generator', productClass: 'generator', role: 'context' },
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
    ...overrides
  };
  const planTurn = implementation.planTurn;
  const composeAnswer = implementation.composeAnswer;
  const normalizedPlanTurn = async (input: Parameters<AgentManagerModel['planTurn']>[0]) => {
    const intent = await planTurn(input);
    return modernizeLegacySelectionPolicyFixture({
      ...intent,
      toolRequests: intent.toolRequests.map(modernizeLegacyUniversalToolFixture)
    });
  };
  return {
    ...implementation,
    planTurn: normalizedPlanTurn,
    async decideTurn(input): Promise<AgentSemanticDecision> {
      if (implementation.decideTurn) return implementation.decideTurn(input);
      const intent = await normalizedPlanTurn({
        ...input,
        ledgerState: input.ledgerState!
      });
      const calculatorRequest = intent.toolRequests.find((request) => request.tool === 'calculator.generatorLoad');
      let ledgerDelta = overrides.planTurn && !overrides.proposeLedgerDelta
        ? { rationale: 'test fixture has no state change for this custom intent', events: [] } satisfies LedgerStateDelta
        : await implementation.proposeLedgerDelta(input);
      if (calculatorRequest && !ledgerDelta.events.some((event) =>
        event.payload.factKey === 'generator_load_scenario'
      )) {
        const scenarioRequirement = intent.selectionPolicy?.requirements.find((requirement) =>
          requirement.kind === 'generator_load_scenario'
        );
        if (!scenarioRequirement && intent.selectionPolicy) {
          intent.selectionPolicy.requirements.push({
            id: 'test-generator-load-scenario',
            kind: 'generator_load_scenario',
            value: true,
            unit: null,
            role: 'hard_constraint',
            strictness: 'strict',
            evidence: 'legacy test fixture calculator loads',
            verification: {
              mode: 'typed_tool',
              toolRequestId: calculatorRequest.id,
              tool: 'calculator.generatorLoad',
              verifier: 'generator_load_profile',
              bindAs: 'nominal_power_min_kw'
            }
          });
        }
        ledgerDelta = {
          ...ledgerDelta,
          events: [...ledgerDelta.events, {
            eventType: 'fact.confirmed',
            scope: 'dialogue',
            payload: {
              factKey: 'generator_load_scenario',
              value: {
                loads: calculatorRequest.args.loads ?? [],
                simultaneousRunning: calculatorRequest.args.simultaneousRunning ?? null,
                simultaneousStarting: calculatorRequest.args.simultaneousStarting ?? null
              },
              needId: 'generator',
              productClass: 'generator',
              role: 'hard_requirement'
            },
            evidence: 'legacy test fixture calculator loads',
            source: 'llm_state_delta',
            status: 'active'
          }]
        };
      }
      return { ledgerDelta, intent } as AgentSemanticDecision;
    },
    async composeAnswer(input) {
      const answer = await composeAnswer(input);
      return {
        ...answer,
        selectedProductIds: answer.selectedProductIds ?? (
          answer.selectionReadiness?.canShowProductCards === false
            ? []
            : input.products.map((product) => product.id)
        )
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

function modernizeLegacySelectionPolicyFixture(intent: AgentIntentContract): AgentIntentContract {
  if (intent.selectionPolicy) return intent;
  const hasCatalogTool = intent.toolRequests.some((request) =>
    request.tool === 'catalog.search' || request.tool === 'catalog.getProductDetails'
  );
  const inferredClass = inferProductIntent([
    intent.userMessageSummary,
    intent.dialogueUnderstanding,
    intent.nextStepRationale,
    ...intent.toolRequests.map((request) => String(request.args.query ?? request.args.semanticQuery ?? ''))
  ].join(' '));
  const continuityText = [
    intent.userMessageSummary,
    intent.dialogueUnderstanding,
    intent.nextStepRationale
  ].join(' ').toLocaleLowerCase('en-US');
  const reusePreviousCards = ['previous', 'already selected', 'earlier visible']
    .some((signal) => continuityText.includes(signal));
  const requestedClass = (intent.productMentions?.find((mention) => mention.productClass)?.productClass ??
    intent.toolRequests.map((request) => request.args.canonicalProductIntent ?? request.args.productIntent)
      .find((value): value is string => typeof value === 'string' && value.length > 0) ??
    (inferredClass === 'unknown' ? null : inferredClass) ??
    null) as NonNullable<AgentIntentContract['selectionPolicy']>['canonicalProductClass'];
  return {
    ...intent,
    selectionPolicy: requestedClass
      ? {
          targetProductClass: requestedClass,
          canonicalProductClass: requestedClass,
          needAction: 'continue',
          alternativePolicy: 'same_class_only',
          reusePreviousCards,
          maxCards: 8,
          powerSource: 'any',
          phase: 'any',
          requirements: [],
          rationale: 'Structured selection authority for a legacy test fixture.',
          selectionGoal: intent.grounding?.taskType === 'product_selection' ? 'preliminary_fit' : 'browse_catalog'
        }
      : {
          ...currentNoProductSelectionPolicy(),
          alternativePolicy: hasCatalogTool ? 'open_to_alternatives' : 'unknown',
          maxCards: hasCatalogTool ? 8 : 0,
          selectionGoal: 'browse_catalog'
        }
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
    expect(RECOVERY_LEASE_WAIT_LIMIT_MS).toBe(58_000);
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
    expect(repaired.repairs[0]?.attributes).toEqual(web?.args.comparisonAttributes);
  });

  it('separates electric starter from automatic start in legacy planner contracts', () => {
    const intent = structuredGeneratorCatalogIntent();
    intent.selectionPolicy = {
      ...intent.selectionPolicy!,
      requirements: [{
        id: 'start', kind: 'auto_start_required', value: true, unit: null,
        relation: 'must_have', role: 'hard_constraint', strictness: 'strict', evidence: 'с электростартом',
        verification: { mode: 'product_attribute' }
      }]
    };
    intent.toolRequests = [{
      id: 'catalog', tool: 'catalog.search', required: true, rationale: 'find electric-start models',
      coversRequirementIds: ['start'], args: { comparisonAttributes: ['auto_start_required'] }
    }];
    intent.grounding = { ...intent.grounding!, technicalAttributes: ['auto_start_required'] };

    const repaired = repairIntentForElectricStartRequirementKinds(intent);

    expect(repaired.requirementIds).toEqual(['start']);
    expect(repaired.intent.selectionPolicy?.requirements[0]?.kind).toBe('electric_start_required');
    expect(repaired.intent.toolRequests[0]?.args.comparisonAttributes).toEqual(['electric_start_required']);
    expect(repaired.intent.grounding?.technicalAttributes).toEqual(['electric_start_required']);

    const actualAutostart = structuredGeneratorCatalogIntent();
    actualAutostart.selectionPolicy = {
      ...actualAutostart.selectionPolicy!,
      requirements: [{
        id: 'ats', kind: 'auto_start_required', value: true, unit: null,
        relation: 'must_have', role: 'hard_constraint', strictness: 'strict', evidence: 'нужен автозапуск через АВР',
        verification: { mode: 'product_attribute' }
      }]
    };
    expect(repairIntentForElectricStartRequirementKinds(actualAutostart).requirementIds).toEqual([]);
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

    // 'material' has no mechanical verifier and still routes to web verification;
    // 'two_person_loading_suitability' is an unsupported kind that now stays
    // unconfirmed-preliminary (no blocker): it neither moves to the web request nor
    // blocks catalog evidence, so it remains covered by the catalog request.
    expect(repaired.repairs).toEqual([{
      requestId: webRequest.id,
      requirementIds: ['material-fit']
    }]);
    expect(repaired.intent.toolRequests[0]?.coversRequirementIds).toEqual(['loading-fit', 'weight-limit']);
    expect(repaired.intent.toolRequests[1]?.coversRequirementIds).toEqual(['material-fit']);
    expect(repaired.intent.selectionPolicy?.requirements[0]?.verification).toEqual({
      mode: 'typed_tool',
      toolRequestId: webRequest.id,
      tool: 'web.researchProductFacts',
      verifier: 'technical_source_review',
      bindAs: 'material'
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
    expect(turnBudget?.usage?.modelCalls).toBe(2);
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


  it('preserves a safe clarification when a strict typed requirement is intentionally pending', async () => {
    const conversations = new FakeConversations();
    conversations.messages = [message('Need a generator for a house with a refrigerator, pump, boiler and occasional power tools.')];
    const clarificationText = 'A precise model would be premature until the pump load is known. As an orientation, this class often starts around 5–7 kW. What type and power is the pump, and is it 220 or 380 V?';
    const clarificationModel = model({
      async proposeLedgerDelta() {
        return {
          rationale: 'open the decisive clarification in the same semantic decision',
          events: [{
            eventType: 'question.asked',
            scope: 'question',
            payload: {
              questionId: 'pump-specs',
              text: 'What type and power is the pump, and is it 220 or 380 V?'
            },
            evidence: 'The pump type, power and phase are required for the load calculation.',
            source: 'llm_state_delta',
            status: 'active'
          }]
        };
      },
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
      }
    });
    const orchestrator = new AgentManagerOrchestrator(
      conversations as never,
      new FakeProducts() as never,
      new FakeLeads() as never,
      clarificationModel
    );

    const payload = await orchestrator.generateAnswer({
      sessionId,
      turnId,
      userMessage: 'Need a generator for a house with a refrigerator, pump, boiler and occasional power tools.'
    });

    expect(payload.answer).toBe(clarificationText);
    expect(payload.answer).not.toContain('could not reliably complete');
    expect(payload.productCards).toEqual([]);
    expect(payload.metadata?.preSendValidation).toMatchObject({ verdict: 'pass', issues: [] });
    expect(payload.metadata?.answerProductEvidence).toMatchObject({ products: [] });
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
      }
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
      preSendValidation?: unknown;
    };
    expect(metadata.toolResults?.[0]?.payload?.profile?.simultaneousStarting).toBe(false);
    expect((metadata.toolResults?.[1]?.payload as {
      generatorLoadFit?: { loadAwareRetry?: boolean };
    })?.generatorLoadFit?.loadAwareRetry).toBe(true);
    expect(payload.metadata?.preSendValidation).toMatchObject({ verdict: 'pass' });
    expect(payload.metadata?.preSendValidation).not.toMatchObject({
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
          selectedProductIds: ['text-product', 'vector-product'],
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
          selectedProductIds: ['generator-fit'],
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
          }, {
            eventType: 'question.asked',
            scope: 'question',
            payload: {
              questionId: 'q.generator.pump_identity_or_power',
              text: 'What pump type/model or nameplate power can you provide?'
            },
            evidence: 'The missing pump identity or power blocks sizing.',
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
    expect(metadata.cardSelection?.suppressedProductIds).toEqual([]);
    expect(metadata.cardSelection?.warnings).toContain('product_cards_suppressed:selection_readiness_contract');
    expect(metadata.answerContract?.riskFlags).toContain('selection_readiness_blocked_cards');
  });

  it('does not invent generic pump loads and lets the answer contract block premature cards', async () => {
    const conversations = new FakeConversations();
    const unknownPumpModel = model({
      async proposeLedgerDelta() {
        return {
          rationale: 'keep the missing pump fact explicit',
          events: [{
            eventType: 'question.asked',
            scope: 'question',
            payload: {
              questionId: 'q.generator.pump_identity_or_power',
              text: 'What pump type/model or nameplate power can you provide?'
            },
            evidence: 'Pump power is missing.',
            source: 'llm_state_delta',
            status: 'active'
          }]
        };
      },
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



  it('rejects bounded assumptions when estimated motor loads lack minimum basis signals', async () => {
    const conversations = new FakeConversations();
    const incompleteBasisModel = model({
      async proposeLedgerDelta() {
        return {
          rationale: 'keep the missing motor basis explicit',
          events: [{
            eventType: 'question.asked',
            scope: 'question',
            payload: {
              questionId: 'q.generator.bound_unknown_pump',
              text: 'What does the pump do and is it 220 V or 380 V?'
            },
            evidence: 'Pump function and phase are missing.',
            source: 'llm_state_delta',
            status: 'active'
          }]
        };
      },
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
    expect(metadata.selectionReadiness?.status).toBe('blocked_by_answer_contract');
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
          grounding: {
            taskType: 'product_selection',
            sourcePolicy: 'conversation_only',
            webPurpose: 'none',
            requiredToolKinds: [],
            technicalAttributes: ['weight', 'compaction depth', 'plate size'],
            rationale: 'the buyer explicitly asks to keep and explain the previous visible selection'
          },
          selectionPolicy: {
            targetProductClass: 'plate',
            canonicalProductClass: 'plate',
            selectionGoal: 'preliminary_fit',
            needAction: 'continue',
            alternativePolicy: 'same_class_only',
            reusePreviousCards: true,
            maxCards: 4,
            powerSource: 'any',
            phase: 'any',
            requirements: [],
            rationale: 'reuse the previous visible plate cards requested by the buyer'
          },
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
          selectedProductIds: ['plate-62'],
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
        expect(input.products.map((item) => item.id)).toEqual([
          'generator-no-auto',
          'generator-auto-unknown'
        ]);
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
      'generator-auto-conflict'
    ]));
    expect(metadata.warnings).toContain('answer_products_filtered_by_structured_hard_constraints:2');
    expect(metadata.warnings).toContain('answer_products_preliminary:unknown_evidence_kept:1');
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
    expect(metadata.toolResults?.[1]?.payload?.generatorLoadFit?.droppedProductIds ?? []).toEqual([]);
    expect(metadata.toolResults?.[1]?.warnings).toEqual(expect.arrayContaining([
      'answer_products_filtered_by_structured_hard_constraints:2',
      'catalog_primary_expansion_attempted:2:0'
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
          selectedProductIds: ['evo-6200'],
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
          selectedProductIds: ['tss-7000'],
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

    await expect(orchestrator.generateAnswer({
      sessionId,
      turnId,
      userMessage: preferenceOnlyReply
    })).rejects.toThrow('lead_capture_missing_contact_offer_form');

    expect(conversations.assistantSaves).toHaveLength(0);
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

  it('fails the turn without a buyer answer when planned tools exceed the bounded tool budget', async () => {
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

    await expect(orchestrator.generateAnswer({
      sessionId,
      turnId,
      userMessage: 'Run the bounded calculations.'
    })).rejects.toThrow('tool_call_budget_exceeded');

    expect(conversations.assistantSaves).toHaveLength(0);
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
    expect(conversations.turn.status).toBe('failed');
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
      async getProductsByIds(ids: string[]) {
        const known = [
          product('p1', 'TSS SGG 5000A generator'),
          product('p2', 'TSS SGG 6000B generator')
        ];
        const requested = new Set(ids);
        return known.filter((item) => requested.has(item.id));
      }

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
        if (turnNumber === 2) {
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
          toolRequests: turnNumber >= 3
            ? [{
                id: 'selected-product-details',
                tool: 'catalog.getProductDetails' as const,
                args: {
                  productIds: ['p1'],
                  productNames: ['TSS SGG 5000A generator'],
                  productIntent: 'generator',
                  canonicalProductIntent: 'generator',
                  reason: 'refresh the exact selected product before showing it again'
                },
                rationale: 'the buyer explicitly returned to the previously selected product',
                required: true
              }]
            : intent.toolRequests,
          grounding: {
            taskType: 'product_selection' as const,
            sourcePolicy: 'catalog_required' as const,
            webPurpose: 'none' as const,
            requiredToolKinds: turnNumber >= 3
              ? ['catalog.getProductDetails' as const]
              : ['catalog.search' as const],
            technicalAttributes: ['price', 'power'],
            rationale: 'recheck the current catalog while preserving the validated active-need selection'
          },
          selectionPolicy: {
            ...intent.selectionPolicy!,
            needAction: 'resume' as const,
            selectionGoal: 'preliminary_fit' as const,
            reusePreviousCards: true,
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
          toolResultIds: input.toolResults
            .filter((result) => result.status === 'ok')
            .map((result) => result.requestId),
          selectedProductIds: input.products
            .filter((item) => item.id === 'p1')
            .map((item) => item.id),
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
    expect(
      fourth.productCards.map((card) => card.id),
      JSON.stringify({
        selectionReadiness: fourth.metadata?.selectionReadiness,
        cardSelection: fourth.metadata?.cardSelection,
        answerContract: fourth.metadata?.answerContract,
        toolResults: fourth.metadata?.toolResults
      })
    ).toEqual(['p1']);

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
      toolResults?: Array<{ payload?: { retrieval?: { primaryExpansion?: { attempted?: boolean; matchedCount?: number } } } }>;
    };

    expect(products.calls).toHaveLength(2);
    expect(products.calls[0]?.limit).toBeGreaterThanOrEqual(200);
    expect(products.calls[1]?.limit).toBe(1000);
    expect(payload.productCards.map((card) => card.id), JSON.stringify({
      cardSelection: payload.metadata?.cardSelection,
      selectionReadiness: payload.metadata?.selectionReadiness
    })).toEqual(['range-55', 'range-60']);
    expect(metadata.toolResults?.[0]?.payload?.retrieval?.primaryExpansion).toMatchObject({
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
      toolResults?: Array<{ payload?: { retrieval?: { primaryExpansion?: { attempted?: boolean; matchedCount?: number } } } }>;
    };

    expect(products.calls).toHaveLength(2);
    expect(products.calls[0]?.limit).toBeGreaterThanOrEqual(200);
    expect(products.calls[1]?.limit).toBe(1000);
    expect(payload.productCards.map((card) => card.id), JSON.stringify({
      cardSelection: payload.metadata?.cardSelection,
      selectionReadiness: payload.metadata?.selectionReadiness,
      warnings: payload.metadata?.warnings
    })).toEqual(['plate-56', 'plate-67', 'plate-72']);
    expect(metadata.toolResults?.[0]?.payload?.retrieval?.primaryExpansion).toMatchObject({
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
      toolResults?: Array<{ tool?: string; payload?: { retrieval?: { primaryExpansion?: { attempted?: boolean; matchedCount?: number } } } }>;
      answerProductEvidence?: { droppedProductIds?: string[] };
    };
    const catalogResult = metadata.toolResults?.find((result) => result.tool === 'catalog.search');

    expect(products.calls).toBe(2);
    expect(catalogResult?.payload?.retrieval?.primaryExpansion).toMatchObject({
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
        }
      })
    );
    const payload = await orchestrator.generateAnswer({
      sessionId,
      turnId,
      userMessage: 'Сравните обе, бюджет теперь до 90 000 ₽.'
    });

    expect([...products.idsSeen].sort()).toEqual(
      comparisonProducts.map((item) => item.id).sort(),
    );
    expect(payload.productCards.map((card) => card.id)).toEqual(['champion-pc1150ft']);
    expect(payload.productCards.map((card) => card.id)).not.toContain(nonComparisonNeighbor.id);
    expect(payload.answer).toContain('Masalta MS125-4');
    expect(payload.answer).toContain('превышает');
    expect(payload.answer).toContain('CHAMPION PC1150FT');
    expect((payload.metadata?.answerContract as { selectedProductIds?: string[] }).selectedProductIds)
      .toEqual(['champion-pc1150ft']);
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
        composeAnswer
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

  it('rejects a second incoherent semantic decision without a buyer answer', async () => {
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

    await expect(orchestrator.generateAnswer({
      sessionId,
      turnId,
      userMessage: conversations.messages[0]!.content
    })).rejects.toThrow('semantic_decision_incoherent:active_requirement_mismatch:budget_max_rub');

    expect(decideTurn).toHaveBeenCalledTimes(2);
    expect(composeAnswer).not.toHaveBeenCalled();
    expect(conversations.assistantSaves).toHaveLength(0);
    expect(conversations.checkpoints).toContainEqual(expect.objectContaining({
      checkpoint: 'semantic_decision_proposed',
      status: 'failed',
      errorCode: 'semantic_decision_incoherent',
      payload: { issues: expect.arrayContaining(['active_requirement_mismatch:budget_max_rub']) }
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
