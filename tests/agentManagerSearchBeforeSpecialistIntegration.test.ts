import { describe, expect, it, vi } from 'vitest';

const researchProductComparisonFactsMock = vi.hoisted(() => vi.fn());

vi.mock('../src/ai/productComparisonResearch.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/ai/productComparisonResearch.js')>(),
  researchProductComparisonFacts: researchProductComparisonFactsMock
}));

import {
  AgentManagerOrchestrator,
  type AgentManagerAnswerInput,
  type AgentManagerModel
} from '../src/ai/agentManagerOrchestrator.js';
import type {
  AgentIntentContract,
  LedgerStateDelta
} from '../src/ai/agentManagerContracts.js';
import { emptyNeedState } from '../src/ai/needState.js';
import type {
  ConversationSession,
  ConversationTurn,
  LeadCaptureDraft,
  Message,
  Product
} from '../src/shared/types.js';

const sessionId = '71111111-1111-4111-8111-111111111111';
const turnId = '72222222-2222-4222-8222-222222222222';
const userMessageId = '73333333-3333-4333-8333-333333333333';

function session(): ConversationSession {
  const now = '2026-07-16T08:00:00.000Z';
  return {
    id: sessionId,
    status: 'active',
    conversationNumber: 1,
    title: 'V14 integration test',
    needState: emptyNeedState(),
    createdAt: now,
    updatedAt: now,
    lastHeartbeatAt: now
  };
}

function turn(): ConversationTurn {
  const now = '2026-07-16T08:00:00.000Z';
  return {
    id: turnId,
    sessionId,
    userMessageId,
    assistantMessageId: null,
    status: 'received',
    requestHash: 'v14-test-hash',
    createdAt: now,
    updatedAt: now
  };
}

function message(content: string, role: Message['role']): Message {
  return {
    id: role === 'user' ? userMessageId : 'assistant-message-id',
    sessionId,
    role,
    content,
    metadata: {},
    createdAt: '2026-07-16T08:00:00.000Z'
  };
}

function quietGenerator(): Product {
  return {
    id: 'quiet-generator',
    name: 'TEST DG Quiet 6000',
    brand: 'TEST',
    category: 'Generators',
    price: 100_000,
    currency: 'RUB',
    sourceUrl: 'https://bakautprof.ru/catalog/quiet-generator',
    specs: { 'Noise level': '58 dB', Autostart: 'yes' }
  };
}

class HarnessConversations {
  messages: Message[];
  currentTurn = turn();
  ledgerEvents: unknown[] = [];
  checkpoints: unknown[] = [];
  toolArtifacts: unknown[] = [];
  answerContracts: unknown[] = [];
  traces: unknown[] = [];
  assistantSaves: unknown[] = [];

  constructor(userMessage: string) {
    this.messages = [message(userMessage, 'user')];
  }

  async getSession() { return session(); }
  async listMessages() { return this.messages; }
  async getTurn() { return this.currentTurn; }
  async updateTurn(input: Partial<ConversationTurn>) {
    this.currentTurn = { ...this.currentTurn, ...input };
    return this.currentTurn;
  }
  async upsertTurnCheckpoint(input: unknown) { this.checkpoints.push(input); return input; }
  async listTurnCheckpoints() { return this.checkpoints; }
  async listDialogueLedgerEvents() { return this.ledgerEvents; }
  async upsertDialogueLedgerEvent(input: unknown) { this.ledgerEvents.push(input); return input; }
  async saveToolArtifact(input: unknown) { this.toolArtifacts.push(input); return input; }
  async listToolArtifacts() { return this.toolArtifacts; }
  async saveAnswerContract(input: unknown) { this.answerContracts.push(input); return input; }
  async getFinalAnswerContract() { return null; }
  async addAgentTrace(input: unknown) { this.traces.push(input); return input; }
  async addAssistantMessageForTurn(input: {
    content: string;
    metadata?: Record<string, unknown>;
    recovered?: boolean;
  }) {
    this.assistantSaves.push(input);
    const saved = message(input.content, 'assistant');
    saved.metadata = input.metadata ?? {};
    this.messages.push(saved);
    this.currentTurn = {
      ...this.currentTurn,
      assistantMessageId: saved.id,
      status: input.recovered ? 'recovered' : 'completed'
    };
    return saved;
  }
}

class HarnessProducts {
  searchProducts = vi.fn(async () => [quietGenerator()]);
  recordDataQualityIssue = vi.fn(async () => null);
}

class HarnessLeads {
  async getPendingLeadCaptureDraft(): Promise<LeadCaptureDraft | null> { return null; }
}

class StaleTechnicalDraftLeads extends HarnessLeads {
  readonly draft: LeadCaptureDraft;

  constructor(buyerQuestion: string) {
    super();
    const now = '2026-07-16T08:00:00.000Z';
    this.draft = {
      id: '74444444-4444-4444-8444-444444444444',
      sessionId,
      originTurnId: '75555555-5555-4555-8555-555555555555',
      originToolRequestId: 'legacy-unsafe-lead',
      purpose: 'return the technical result',
      buyerQuestion,
      preferredContact: 'message',
      phone: '+7 900 000-00-11',
      consentEvidenceHash: 'a'.repeat(64),
      scopeHash: 'b'.repeat(64),
      status: 'pending',
      expiresAt: '2026-07-16T08:30:00.000Z',
      createdAt: now,
      updatedAt: now
    };
  }

  override async getPendingLeadCaptureDraft() { return this.draft; }
}

function generatorNeedDelta(): LedgerStateDelta {
  return {
    rationale: 'open the current quiet-generator need',
    events: [{
      eventType: 'need.opened',
      scope: 'need',
      payload: {
        needId: 'quiet-generator-need',
        productClass: 'generator',
        summary: 'quiet generator selection',
        constraints: ['noise no higher than 60 dB'],
        openQuestions: [],
        selectedProductIds: [],
        rejectedProductIds: [],
        status: 'open',
        activate: true
      },
      evidence: 'buyer needs a quiet generator',
      source: 'llm_state_delta',
      status: 'active'
    }]
  };
}

function conditionalSelectionIntent(): AgentIntentContract {
  return {
    userMessageSummary: 'buyer needs a generator with automatic start',
    dialogueUnderstanding: 'select a generator whose catalog card confirms automatic start',
    nextStepRationale: 'search catalog first and use web only for an evidence gap',
    requiresTools: true,
    toolRequests: [{
      id: 'catalog-search',
      tool: 'catalog.search',
      args: {
        query: 'quiet generator',
        productIntent: 'generator',
        canonicalProductIntent: 'generator'
      },
      rationale: 'find catalog candidates',
      required: true
    }, {
      id: 'web-autostart-check',
      tool: 'web.researchProductFacts',
      args: {
        query: 'verify generator automatic start',
        productIntent: 'generator',
        canonicalProductIntent: 'generator',
        productNames: [],
        comparisonAttributes: ['automatic start'],
        comparisonAttributeBindings: [{
          attribute: 'automatic start',
          requirementId: 'autostart-required'
        }]
      },
      rationale: 'verify automatic start only if catalog proof is incomplete',
      required: true,
      coversRequirementIds: ['autostart-required']
    }],
    grounding: {
      taskType: 'product_selection',
      sourcePolicy: 'web_required',
      webPurpose: 'technical_specs',
      webRequirement: 'conditional_on_catalog_gap',
      requiredToolKinds: ['catalog.search', 'web.researchProductFacts'],
      technicalAttributes: ['automatic start'],
      rationale: 'web is conditional on a catalog evidence gap'
    },
    productMentions: [],
    selectionPolicy: {
      targetProductClass: 'generator',
      canonicalProductClass: 'generator',
      selectionGoal: 'preliminary_fit',
      needAction: 'open',
      alternativePolicy: 'same_class_only',
      reusePreviousCards: false,
      maxCards: 4,
      powerSource: 'any',
      phase: 'any',
      requirements: [{
        id: 'autostart-required',
        kind: 'autostart_required',
        value: true,
        unit: null,
        relation: 'must_have',
        role: 'hard_constraint',
        strictness: 'strict',
        evidence: 'automatic start is required',
        verification: { mode: 'product_attribute' }
      }],
      rationale: 'typed preliminary selection'
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
}

function prematureTechnicalSpecialistIntent(): AgentIntentContract {
  return {
    userMessageSummary: 'buyer asks a technical question',
    dialogueUnderstanding: 'planner tried to hand off before searching',
    nextStepRationale: 'ask a specialist instead of checking available sources',
    requiresTools: true,
    toolRequests: [{
      id: 'premature-lead',
      tool: 'lead.capture',
      args: { reason: 'premature technical escalation' },
      rationale: 'premature specialist handoff',
      required: true
    }],
    grounding: {
      taskType: 'technical_answer',
      sourcePolicy: 'specialist_required',
      webPurpose: 'none',
      webRequirement: 'none',
      requiredToolKinds: ['lead.capture'],
      technicalAttributes: ['noise level'],
      rationale: 'planner requested a specialist'
    },
    productMentions: [],
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
}

function firstTurnTechnicalWebAndLeadIntent(): AgentIntentContract {
  const base = prematureTechnicalSpecialistIntent();
  const buyerQuestion = 'Please verify the generator noise level. My phone is +7 900 000-00-11.';
  return {
    ...base,
    toolRequests: [{
      id: 'technical-web',
      tool: 'web.researchProductFacts',
      args: {
        query: 'verify exact generator noise level',
        productNames: [],
        comparisonAttributes: ['noise level'],
        comparisonAttributeBindings: []
      },
      rationale: 'verify the technical fact before any handoff',
      required: true
    }, ...base.toolRequests],
    grounding: {
      ...base.grounding!,
      sourcePolicy: 'web_required',
      webPurpose: 'technical_specs',
      webRequirement: 'independent_required',
      requiredToolKinds: ['web.researchProductFacts', 'lead.capture']
    },
    leadCaptureAuthorization: {
      authorized: true,
      contactSource: 'current_message',
      handoffKind: 'technical_followup',
      purpose: 'answer the technical question',
      buyerQuestion,
      evidence: '+7 900 000-00-11',
      pendingDraftId: null
    }
  };
}

function staleDraftTechnicalHandoffIntent(
  draftId: string,
  buyerQuestion: string,
  handoffOfferMessageId?: string
): AgentIntentContract {
  const base = prematureTechnicalSpecialistIntent();
  return {
    ...base,
    grounding: {
      ...base.grounding!,
      taskType: 'lead_handoff',
      technicalAttributes: ['noise level'],
      rationale: 'legacy draft claims a technical handoff without persisted exhaustion proof'
    },
    leadCaptureAuthorization: {
      authorized: true,
      contactSource: 'pending_draft',
      handoffKind: 'technical_followup',
      handoffOfferMessageId,
      purpose: 'return the technical result',
      buyerQuestion,
      evidence: 'Алексей',
      pendingDraftId: draftId
    }
  };
}

function harnessModel(input: {
  intent: AgentIntentContract;
  delta?: LedgerStateDelta;
  compose: (answerInput: AgentManagerAnswerInput) => ReturnType<AgentManagerModel['composeAnswer']>;
}): AgentManagerModel {
  return {
    async proposeLedgerDelta() { return input.delta ?? { rationale: 'no state change', events: [] }; },
    async planTurn() { return input.intent; },
    composeAnswer: input.compose,
    async reviewAnswer() { return { verdict: 'pass', issues: [] }; }
  };
}

function successfulTechnicalResearch() {
  return {
    usedWebSearch: true,
    searchDisposition: 'completed' as const,
    sourcesExhausted: false,
    facts: [{
      productName: quietGenerator().name,
      attribute: 'noise level',
      value: '58 dB',
      sourceType: 'web' as const,
      confidence: 'high' as const,
      evidence: 'manufacturer specification',
      sourceUrl: 'https://manufacturer.example/quiet-generator',
      sourceTitle: 'TEST DG Quiet 6000 specification'
    }],
    conflicts: [],
    answerGuidance: {
      directAnswer: 'The checked specification states 58 dB.',
      completeness: 'answered' as const,
      coverage: []
    },
    summaryForAnswer: 'The checked specification states 58 dB.',
    warnings: []
  };
}

function exhaustedTechnicalOfferHistory(buyerQuestion: string) {
  const handoffOfferMessageId = '76666666-6666-4666-8666-666666666666';
  const priorIntent = prematureTechnicalSpecialistIntent();
  priorIntent.toolRequests = [{
    id: 'prior-exhausted-web',
    tool: 'web.researchProductFacts',
    args: {
      query: buyerQuestion,
      productNames: [],
      comparisonAttributes: ['noise level'],
      comparisonAttributeBindings: []
    },
    rationale: 'exhaust all source tiers before technical handoff',
    required: true
  }];
  priorIntent.grounding = {
    ...priorIntent.grounding!,
    sourcePolicy: 'web_required',
    webPurpose: 'technical_specs',
    webRequirement: 'independent_required',
    requiredToolKinds: ['web.researchProductFacts'],
    buyerQuestion
  };
  const assistant = message(
    'Оставьте номер телефона и скажите, как удобнее получить результат: сообщением или звонком.',
    'assistant'
  );
  assistant.id = handoffOfferMessageId;
  assistant.metadata = {
    effectiveIntentContract: priorIntent,
    answerContract: {
      answerText: assistant.content,
      factsUsed: [],
      questionsAsked: [],
      toolResultIds: ['prior-exhausted-web'],
      selectedProductIds: [],
      leadAction: 'offer_form',
      riskFlags: []
    },
    toolResults: [{
      requestId: 'prior-exhausted-web',
      tool: 'web.researchProductFacts',
      status: 'ok',
      payload: {
        usedWebSearch: true,
        searchDisposition: 'completed',
        sourcesExhausted: true,
        researchOutcome: 'exhausted',
        sourceAttempts: [
          { tier: 'catalog', outcome: 'not_found' },
          { tier: 'official_page', outcome: 'not_found', query: 'official product page noise level' },
          { tier: 'official_manual', outcome: 'not_found', query: 'official manual noise level PDF' },
          { tier: 'reliable_secondary', outcome: 'not_found', query: 'reliable distributor noise level' }
        ]
      },
      warnings: []
    }]
  };
  return {
    handoffOfferMessageId,
    messages: [message(buyerQuestion, 'user'), assistant]
  };
}

describe('search-before-specialist orchestration', () => {
  it('adds independent web research after repairing a premature technical specialist plan', async () => {
    researchProductComparisonFactsMock.mockReset();
    researchProductComparisonFactsMock.mockResolvedValue(successfulTechnicalResearch());
    const conversations = new HarnessConversations('Please verify the generator noise level.');
    const compose = vi.fn(async (input: AgentManagerAnswerInput) => {
      const webRequest = input.intent.toolRequests.find((request) => request.tool === 'web.researchProductFacts');
      expect(input.intent.grounding).toMatchObject({
        sourcePolicy: 'web_required',
        webRequirement: 'independent_required'
      });
      expect(input.intent.toolRequests.some((request) => request.tool === 'lead.capture')).toBe(false);
      expect(webRequest).toBeDefined();
      return {
        answerText: 'Проверил данные: для TEST DG Quiet 6000 указано 58 дБ.',
        factsUsed: [{
          factKey: 'generator.noise_level',
          sourceEventIds: [webRequest!.id],
          value: '58 dB'
        }],
        questionsAsked: [],
        toolResultIds: [webRequest!.id],
        selectedProductIds: [],
        leadAction: 'none' as const,
        riskFlags: [],
        selectionReadiness: {
          productClass: 'generator',
          status: 'not_applicable' as const,
          canShowProductCards: false,
          missingFacts: [],
          rationale: 'This is a technical answer, not catalog selection.'
        }
      };
    });
    const orchestrator = new AgentManagerOrchestrator(
      conversations as never,
      new HarnessProducts() as never,
      new HarnessLeads() as never,
      harnessModel({ intent: prematureTechnicalSpecialistIntent(), compose })
    );

    await orchestrator.generateAnswer({
      sessionId,
      turnId,
      userMessage: 'Please verify the generator noise level.'
    });

    expect(compose).toHaveBeenCalledTimes(1);
    expect(researchProductComparisonFactsMock).toHaveBeenCalledTimes(1);
  });

  it('does not execute or persist a lead from the first technical turn before research is exhausted', async () => {
    researchProductComparisonFactsMock.mockReset();
    researchProductComparisonFactsMock.mockResolvedValue(successfulTechnicalResearch());
    const userMessage = 'Please verify the generator noise level. My phone is +7 900 000-00-11.';
    const conversations = new HarnessConversations(userMessage);
    const compose = vi.fn(async (input: AgentManagerAnswerInput) => {
      expect(input.intent.toolRequests.map((request) => request.tool)).toEqual(['web.researchProductFacts']);
      expect(input.toolResults.some((result) => result.tool === 'lead.capture')).toBe(false);
      return {
        answerText: 'Проверил данные: для TEST DG Quiet 6000 указано 58 дБ.',
        factsUsed: [],
        questionsAsked: [],
        toolResultIds: ['technical-web'],
        selectedProductIds: [],
        leadAction: 'none' as const,
        riskFlags: [],
        selectionReadiness: {
          productClass: 'generator',
          status: 'not_applicable' as const,
          canShowProductCards: false,
          missingFacts: [],
          rationale: 'The researched question was answered without a handoff.'
        }
      };
    });
    const orchestrator = new AgentManagerOrchestrator(
      conversations as never,
      new HarnessProducts() as never,
      new HarnessLeads() as never,
      harnessModel({ intent: firstTurnTechnicalWebAndLeadIntent(), compose })
    );

    await orchestrator.generateAnswer({ sessionId, turnId, userMessage });

    expect(researchProductComparisonFactsMock).toHaveBeenCalledTimes(1);
    expect(conversations.toolArtifacts).not.toContainEqual(expect.objectContaining({ toolName: 'lead.capture' }));
  });

  it('does not let a commercial handoff label bypass search for technical grounding', async () => {
    researchProductComparisonFactsMock.mockReset();
    researchProductComparisonFactsMock.mockResolvedValue(successfulTechnicalResearch());
    const userMessage = 'Please verify the generator noise level. My phone is +7 900 000-00-11.';
    const mislabeledIntent = prematureTechnicalSpecialistIntent();
    mislabeledIntent.grounding = {
      ...mislabeledIntent.grounding!,
      sourcePolicy: 'conversation_only',
      requiredToolKinds: ['lead.capture']
    };
    mislabeledIntent.leadCaptureAuthorization = {
      authorized: true,
      contactSource: 'current_message',
      handoffKind: 'commercial_followup',
      purpose: 'return the technical result',
      buyerQuestion: 'Please verify the generator noise level.',
      evidence: '+7 900 000-00-11',
      pendingDraftId: null
    };
    const conversations = new HarnessConversations(userMessage);
    const compose = vi.fn(async (input: AgentManagerAnswerInput) => {
      expect(input.intent.toolRequests.map((request) => request.tool)).toEqual(['web.researchProductFacts']);
      expect(input.toolResults.some((result) => result.tool === 'lead.capture')).toBe(false);
      return {
        answerText: 'Проверил доступные данные: для TEST DG Quiet 6000 указан уровень 58 дБ.',
        factsUsed: [],
        questionsAsked: [],
        toolResultIds: [input.intent.toolRequests[0]!.id],
        selectedProductIds: [],
        leadAction: 'none' as const,
        riskFlags: [],
        selectionReadiness: {
          productClass: 'generator',
          status: 'not_applicable' as const,
          canShowProductCards: false,
          missingFacts: [],
          rationale: 'The technical question was answered without a handoff.'
        }
      };
    });
    const orchestrator = new AgentManagerOrchestrator(
      conversations as never,
      new HarnessProducts() as never,
      new HarnessLeads() as never,
      harnessModel({ intent: mislabeledIntent, compose })
    );

    await orchestrator.generateAnswer({ sessionId, turnId, userMessage });

    expect(researchProductComparisonFactsMock).toHaveBeenCalledTimes(1);
    expect(conversations.toolArtifacts).not.toContainEqual(expect.objectContaining({ toolName: 'lead.capture' }));
  });

  it('does not trust a pending technical draft as exhaustion proof by itself', async () => {
    researchProductComparisonFactsMock.mockReset();
    researchProductComparisonFactsMock.mockResolvedValue(successfulTechnicalResearch());
    const originalQuestion = 'Please verify the generator noise level.';
    const currentMessage = 'Алексей';
    const leads = new StaleTechnicalDraftLeads(originalQuestion);
    const conversations = new HarnessConversations(currentMessage);
    const compose = vi.fn(async (input: AgentManagerAnswerInput) => {
      expect(input.intent.toolRequests.map((request) => request.tool)).toEqual(['web.researchProductFacts']);
      expect(input.toolResults.some((result) => result.tool === 'lead.capture')).toBe(false);
      return {
        answerText: 'Сначала самостоятельно проверил данные: подтверждён уровень 58 дБ.',
        factsUsed: [],
        questionsAsked: [],
        toolResultIds: [input.intent.toolRequests[0]!.id],
        selectedProductIds: [],
        leadAction: 'none' as const,
        riskFlags: [],
        selectionReadiness: {
          productClass: 'generator',
          status: 'not_applicable' as const,
          canShowProductCards: false,
          missingFacts: [],
          rationale: 'The research answered the question without a handoff.'
        }
      };
    });
    const orchestrator = new AgentManagerOrchestrator(
      conversations as never,
      new HarnessProducts() as never,
      leads as never,
      harnessModel({
        intent: staleDraftTechnicalHandoffIntent(leads.draft.id, originalQuestion),
        compose
      })
    );

    await orchestrator.generateAnswer({ sessionId, turnId, userMessage: currentMessage });

    expect(researchProductComparisonFactsMock).toHaveBeenCalledTimes(1);
    expect(conversations.toolArtifacts).not.toContainEqual(expect.objectContaining({ toolName: 'lead.capture' }));
  });

  it('does not complete draft A with exhausted handoff proof from question B', async () => {
    researchProductComparisonFactsMock.mockReset();
    researchProductComparisonFactsMock.mockResolvedValue(successfulTechnicalResearch());
    const draftQuestion = 'Please verify whether the generator has electric start.';
    const exhaustedQuestion = 'Please verify the generator noise level.';
    const currentMessage = 'Алексей';
    const leads = new StaleTechnicalDraftLeads(draftQuestion);
    const exhausted = exhaustedTechnicalOfferHistory(exhaustedQuestion);
    const conversations = new HarnessConversations(currentMessage);
    conversations.messages = [...exhausted.messages, message(currentMessage, 'user')];
    const compose = vi.fn(async (input: AgentManagerAnswerInput) => {
      expect(input.intent.toolRequests.map((request) => request.tool)).toEqual(['web.researchProductFacts']);
      expect(input.toolResults.some((result) => result.tool === 'lead.capture')).toBe(false);
      return {
        answerText: 'Сначала самостоятельно перепроверил данные: подтверждён уровень 58 дБ.',
        factsUsed: [],
        questionsAsked: [],
        toolResultIds: [input.intent.toolRequests[0]!.id],
        selectedProductIds: [],
        leadAction: 'none' as const,
        riskFlags: [],
        selectionReadiness: {
          productClass: 'generator',
          status: 'not_applicable' as const,
          canShowProductCards: false,
          missingFacts: [],
          rationale: 'A different exhausted question cannot authorize this draft.'
        }
      };
    });
    const orchestrator = new AgentManagerOrchestrator(
      conversations as never,
      new HarnessProducts() as never,
      leads as never,
      harnessModel({
        intent: staleDraftTechnicalHandoffIntent(
          leads.draft.id,
          exhaustedQuestion,
          exhausted.handoffOfferMessageId
        ),
        compose
      })
    );

    await orchestrator.generateAnswer({ sessionId, turnId, userMessage: currentMessage });

    expect(researchProductComparisonFactsMock).toHaveBeenCalledTimes(1);
    expect(conversations.toolArtifacts).not.toContainEqual(expect.objectContaining({ toolName: 'lead.capture' }));
  });

  it('does not complete an older draft from a newer exhausted offer for the same question', async () => {
    researchProductComparisonFactsMock.mockReset();
    researchProductComparisonFactsMock.mockResolvedValue(successfulTechnicalResearch());
    const originalQuestion = 'Please verify the generator noise level.';
    const currentMessage = 'РђР»РµРєСЃРµР№';
    const leads = new StaleTechnicalDraftLeads(originalQuestion);
    const exhausted = exhaustedTechnicalOfferHistory(originalQuestion);
    const conversations = new HarnessConversations(currentMessage);
    conversations.messages = [...exhausted.messages, message(currentMessage, 'user')];
    const compose = vi.fn(async (input: AgentManagerAnswerInput) => {
      expect(input.intent.toolRequests.map((request) => request.tool)).toEqual(['web.researchProductFacts']);
      expect(input.toolResults.some((result) => result.tool === 'lead.capture')).toBe(false);
      return {
        answerText: 'The stale draft was not completed; the technical fact was checked again.',
        factsUsed: [],
        questionsAsked: [],
        toolResultIds: [input.intent.toolRequests[0]!.id],
        selectedProductIds: [],
        leadAction: 'none' as const,
        riskFlags: [],
        selectionReadiness: {
          productClass: 'generator',
          status: 'not_applicable' as const,
          canShowProductCards: false,
          missingFacts: [],
          rationale: 'A draft not bound to this exact offer cannot be completed.'
        }
      };
    });
    const orchestrator = new AgentManagerOrchestrator(
      conversations as never,
      new HarnessProducts() as never,
      leads as never,
      harnessModel({
        intent: staleDraftTechnicalHandoffIntent(
          leads.draft.id,
          originalQuestion,
          exhausted.handoffOfferMessageId
        ),
        compose
      })
    );

    await orchestrator.generateAnswer({ sessionId, turnId, userMessage: currentMessage });

    expect(researchProductComparisonFactsMock).toHaveBeenCalledTimes(1);
    expect(conversations.toolArtifacts).not.toContainEqual(expect.objectContaining({ toolName: 'lead.capture' }));
  });
});

describe('catalog-evidence synthetic web artifact', () => {
  it('persists not_needed with zero attempts and never invokes product research', async () => {
    researchProductComparisonFactsMock.mockReset();
    researchProductComparisonFactsMock.mockRejectedValue(new Error('web research must not run'));
    const conversations = new HarnessConversations('Нужен генератор с автозапуском.');
    const compose = vi.fn(async (input: AgentManagerAnswerInput) => {
      const webResult = input.toolResults.find((result) => result.requestId === 'web-autostart-check');
      expect(webResult).toMatchObject({
        status: 'ok',
        payload: {
          usedWebSearch: false,
          searchDisposition: 'not_needed',
          sourcesExhausted: false
        }
      });
      return {
        answerText: 'TEST DG Quiet 6000 — предварительно подходящий вариант: в карточке указан автозапуск.',
        factsUsed: [],
        questionsAsked: [],
        toolResultIds: ['catalog-search'],
        selectedProductIds: ['quiet-generator'],
        leadAction: 'none' as const,
        riskFlags: [],
        selectionReadiness: {
          productClass: 'generator',
          status: 'ready_for_preliminary_cards' as const,
          canShowProductCards: true,
          missingFacts: [],
          rationale: 'The catalog fully proves the covered requirement.'
        }
      };
    });
    const orchestrator = new AgentManagerOrchestrator(
      conversations as never,
      new HarnessProducts() as never,
      new HarnessLeads() as never,
      harnessModel({
        intent: conditionalSelectionIntent(),
        delta: generatorNeedDelta(),
        compose
      })
    );

    const payload = await orchestrator.generateAnswer({
      sessionId,
      turnId,
      userMessage: 'Нужен генератор с автозапуском.'
    });

    const webArtifact = conversations.toolArtifacts.find((raw) =>
      (raw as { toolRequestId?: string }).toolRequestId === 'web-autostart-check'
    ) as {
      status?: string;
      payload?: Record<string, unknown>;
      warnings?: string[];
    } | undefined;
    expect(webArtifact).toMatchObject({
      status: 'ok',
      payload: {
        usedWebSearch: false,
        searchDisposition: 'not_needed',
        sourcesExhausted: false
      },
      warnings: expect.arrayContaining(['attempts:0'])
    });
    expect(conversations.traces).toContainEqual(expect.objectContaining({
      phase: 'tools',
      eventType: 'tool_short_circuited_by_catalog_evidence',
      payload: expect.objectContaining({
        requestId: 'web-autostart-check',
        attemptCount: 0,
        usedWebSearch: false,
        searchDisposition: 'not_needed'
      })
    }));
    expect(researchProductComparisonFactsMock).not.toHaveBeenCalled();
    expect(compose).toHaveBeenCalledTimes(1);
    expect((payload.metadata?.answerContract as {
      factsUsed?: Array<{ sourceEventIds?: string[] }>;
    }).factsUsed?.flatMap((fact) => fact.sourceEventIds ?? [])).not.toContain('web-autostart-check');
  });

  it('rejects the not_needed artifact when an answer tries to use it as a factual source', async () => {
    researchProductComparisonFactsMock.mockReset();
    researchProductComparisonFactsMock.mockRejectedValue(new Error('web research must not run'));
    const conversations = new HarnessConversations('Нужен генератор с автозапуском.');
    const orchestrator = new AgentManagerOrchestrator(
      conversations as never,
      new HarnessProducts() as never,
      new HarnessLeads() as never,
      harnessModel({
        intent: conditionalSelectionIntent(),
        delta: generatorNeedDelta(),
        compose: async () => ({
          answerText: 'TEST DG Quiet 6000 — предварительно подходящий вариант: в карточке указан автозапуск.',
          factsUsed: [{
            factKey: 'web.autostart_confirmation',
            sourceEventIds: ['web-autostart-check'],
            value: true
          }],
          questionsAsked: [],
          toolResultIds: ['catalog-search', 'web-autostart-check'],
          selectedProductIds: ['quiet-generator'],
          leadAction: 'none',
          riskFlags: [],
          selectionReadiness: {
            productClass: 'generator',
            status: 'ready_for_preliminary_cards',
            canShowProductCards: true,
            missingFacts: [],
            rationale: 'The catalog, not synthetic web evidence, proves automatic start.'
          }
        })
      })
    );

    const payload = await orchestrator.generateAnswer({
      sessionId,
      turnId,
      userMessage: 'Нужен генератор с автозапуском.'
    });

    expect(researchProductComparisonFactsMock).not.toHaveBeenCalled();
    expect(payload.metadata?.preSendReview).toMatchObject({
      verdict: 'rewrite_required',
      issues: expect.arrayContaining([
        expect.objectContaining({ code: 'failed_tool_result_used_as_fact_source' })
      ])
    });
    const finalContract = payload.metadata?.answerContract as {
      factsUsed?: Array<{ sourceEventIds?: string[] }>;
      toolResultIds?: string[];
    };
    expect(finalContract.factsUsed?.flatMap((fact) => fact.sourceEventIds ?? [])).not.toContain(
      'web-autostart-check'
    );
    expect(finalContract.toolResultIds).not.toContain('web-autostart-check');
  });
});
