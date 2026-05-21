import { describe, expect, it, vi } from 'vitest';
import { emptyNeedState } from '../src/ai/needState.js';
import type { AgentManagerModel } from '../src/ai/agentManagerOrchestrator.js';
import type { ConversationSession, ConversationTurn, Message, Product } from '../src/shared/types.js';

const researchProductComparisonFacts = vi.hoisted(() => vi.fn());

vi.mock('../src/ai/productComparisonResearch.js', () => ({
  researchProductComparisonFacts
}));

const { AgentManagerOrchestrator } = await import('../src/ai/agentManagerOrchestrator.js');

const sessionId = '11111111-1111-4111-8111-111111111111';
const turnId = '22222222-2222-4222-8222-222222222222';
const userMessageId = '33333333-3333-4333-8333-333333333333';

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

function session(): ConversationSession {
  const now = new Date('2026-05-19T12:00:00.000Z').toISOString();
  return {
    id: sessionId,
    status: 'active',
    conversationNumber: 1,
    title: 'Dialog #1',
    needState: emptyNeedState(),
    createdAt: now,
    updatedAt: now,
    lastHeartbeatAt: now
  };
}

function turn(): ConversationTurn {
  const now = new Date('2026-05-19T12:00:00.000Z').toISOString();
  return {
    id: turnId,
    sessionId,
    userMessageId,
    assistantMessageId: null,
    status: 'received',
    requestHash: 'hash',
    createdAt: now,
    updatedAt: now
  };
}

function product(id: string, name: string, specs: Record<string, unknown>): Product {
  return {
    id,
    name,
    brand: name.split(' ')[0],
    category: 'Generators',
    price: 1000,
    currency: 'RUB',
    sourceUrl: `https://example.test/${id}`,
    specs
  };
}

class FakeConversations {
  messages: Message[] = [message('Compare SUMEC and BISON generators by power and noise.')];
  turn: ConversationTurn = turn();
  ledgerEvents: unknown[] = [];
  toolArtifacts: unknown[] = [];
  answerContracts: unknown[] = [];
  traces: unknown[] = [];
  assistantSaves: unknown[] = [];
  async getSession() { return session(); }
  async listMessages() { return this.messages; }
  async getTurn() { return this.turn; }
  async updateTurn(input: Partial<ConversationTurn>) {
    this.turn = { ...this.turn, ...input } as ConversationTurn;
    return this.turn;
  }
  async upsertTurnCheckpoint(input: unknown) { return input; }
  async listDialogueLedgerEvents() { return this.ledgerEvents; }
  async upsertDialogueLedgerEvent(input: unknown) { this.ledgerEvents.push(input); return input; }
  async saveToolArtifact(input: unknown) { this.toolArtifacts.push(input); return input; }
  async saveAnswerContract(input: unknown) { this.answerContracts.push(input); return input; }
  async getFinalAnswerContract() { return null; }
  async addAgentTrace(input: unknown) { this.traces.push(input); return input; }
  async addAssistantMessageForTurn(input: { content: string; metadata?: Record<string, unknown> }) {
    this.assistantSaves.push(input);
    const saved = message(input.content, 'assistant');
    this.messages.push(saved);
    return saved;
  }
}

class FakeProducts {
  recordedIssues: unknown[] = [];
  async searchProducts() {
    return [
      product('sumec', 'SUMEC FIRMAN 6 kW', { noiseDb: '74 dB', nominalPowerKw: 5.5 }),
      product('bison', 'BISON 6 kW', { nominalPowerKw: 5.5 })
    ];
  }
  async recordDataQualityIssue(input: unknown) {
    this.recordedIssues.push(input);
    return input;
  }
}

function model(): AgentManagerModel {
  return {
    async proposeLedgerDelta() {
      return {
        rationale: 'comparison request',
        events: [{
          eventType: 'fact.confirmed',
          scope: 'dialogue',
          payload: { factKey: 'comparison.targets', value: ['SUMEC', 'BISON'] },
          evidence: 'Compare SUMEC and BISON',
          source: 'llm_state_delta',
          status: 'active'
        }]
      };
    },
    async planTurn() {
      return {
        userMessageSummary: 'buyer compares SUMEC and BISON',
        dialogueUnderstanding: 'needs model comparison with missing facts',
        nextStepRationale: 'get catalog products and research missing facts',
        requiresTools: true,
        toolRequests: [{
          id: 'catalog:test',
          tool: 'catalog.search',
          args: { query: 'SUMEC BISON generators', limit: 4 },
          rationale: 'bind comparison targets to catalog products',
          required: true
        }, {
          id: 'web:test',
          tool: 'web.researchProductFacts',
          args: { productNames: ['SUMEC FIRMAN 6 kW', 'BISON 6 kW'] },
          rationale: 'fill missing comparison facts and adjudicate conflicts',
          required: true
        }],
        mustNotAskQuestionIds: [],
        riskFlags: ['comparison']
      };
    },
    async composeAnswer() {
      return {
        answerText: 'SUMEC has checked noise in catalog; BISON noise must be treated as uncertain.',
        factsUsed: [],
        questionsAsked: [],
        toolResultIds: ['catalog:test', 'web:test'],
        leadAction: 'none',
        riskFlags: []
      };
    },
    async reviewAnswer() {
      return { verdict: 'pass', issues: [] };
    }
  };
}

describe('AgentManager comparison research flow', () => {
  it('answers exact external facts for a named model absent from catalog and exposes nearby catalog models', async () => {
    researchProductComparisonFacts.mockResolvedValueOnce({
      usedWebSearch: true,
      facts: [{
        productName: 'FIRMAN RD8910E',
        attribute: 'start method',
        value: 'electric start with ignition key; manual recoil starter also available',
        sourceType: 'web',
        confidence: 'high',
        evidence: 'external specification lists electric starter, ignition keys, and recoil starter',
        sourceUrl: 'https://example.test/firman-rd8910e',
        sourceTitle: 'FIRMAN RD8910E specification'
      }],
      conflicts: [],
      summaryForAnswer: 'RD8910E starts with a key and also has manual recoil start.',
      warnings: []
    });

    class MissingCatalogProducts extends FakeProducts {
      async searchProducts() {
        return [
          product('rd7910e', 'FIRMAN RD7910E generator 5 kW', { starter: 'manual / electric' }),
          product('rd10910e', 'FIRMAN RD10910E generator 7.2 kW', { starter: 'manual / electric' }),
          product('other', 'BISON BS7500 generator 6 kW', { starter: 'electric' })
        ];
      }
    }

    const exactFactModel: AgentManagerModel = {
      ...model(),
      async planTurn() {
        return {
          userMessageSummary: 'buyer asks how FIRMAN RD8910E starts',
          dialogueUnderstanding: 'single exact technical fact for a named model',
          nextStepRationale: 'look up the exact model fact and do not infer from nearby catalog models',
          requiresTools: true,
          toolRequests: [{
            id: 'web:exact-model',
            tool: 'web.researchProductFacts',
            args: {
              query: 'FIRMAN RD8910E start method',
              semanticQuery: 'FIRMAN RD8910E key start or push button start',
              productIntent: 'generator',
              limit: 4,
              productIds: [],
              productNames: ['FIRMAN RD8910E'],
              comparisonAttributes: ['start method'],
              loads: [],
              simultaneousStarting: null,
              simultaneousStartingKinds: [],
              contact: { name: null, phone: null, email: null, preferredContact: null, comment: null },
              reason: 'exact model technical fact',
              notes: 'answer direct question first'
            },
            rationale: 'exact model fact is missing from catalog context',
            required: true
          }],
          mustNotAskQuestionIds: [],
          riskFlags: []
        };
      },
      async composeAnswer(input) {
        const result = input.toolResults[0]?.payload as {
          catalogPresence?: Array<{ status?: string }>;
          nearbyCatalogProducts?: Array<{ name?: string }>;
        };
        expect(result.catalogPresence?.[0]?.status).toBe('absent');
        expect(result.nearbyCatalogProducts?.map((item) => item.name)).toEqual([
          'FIRMAN RD7910E generator 5 kW',
          'FIRMAN RD10910E generator 7.2 kW'
        ]);
        return {
          answerText: 'RD8910E starts with a key, not a push button. It also has manual recoil start. This exact model is not in our catalog; nearby FIRMAN catalog models include RD7910E and RD10910E.',
          factsUsed: [{
            factKey: 'firman_rd8910e.start_method',
            sourceEventIds: ['web:exact-model'],
            value: 'key electric start plus manual recoil'
          }],
          questionsAsked: [],
          toolResultIds: ['web:exact-model'],
          leadAction: 'none',
          riskFlags: []
        };
      }
    };
    const conversations = new FakeConversations();
    conversations.messages = [message('Firman RD8910E - заводится с ключа или с кнопки?')];
    const orchestrator = new AgentManagerOrchestrator(conversations as never, new MissingCatalogProducts() as never, {} as never, exactFactModel);

    const payload = await orchestrator.generateAnswer({
      sessionId,
      turnId,
      userMessage: 'Firman RD8910E - заводится с ключа или с кнопки?'
    });

    expect(researchProductComparisonFacts).toHaveBeenCalledWith(expect.objectContaining({
      targetProductNames: ['FIRMAN RD8910E'],
      comparisonAttributes: ['start method'],
      products: expect.arrayContaining([
        expect.objectContaining({ name: 'FIRMAN RD7910E generator 5 kW' }),
        expect.objectContaining({ name: 'FIRMAN RD10910E generator 7.2 kW' })
      ])
    }));
    const metadata = payload.metadata as { toolResults?: Array<{ payload?: { catalogPresence?: unknown[]; nearbyCatalogProducts?: unknown[] }; warnings?: string[] }> };
    expect(metadata.toolResults?.[0]?.payload?.catalogPresence).toEqual([{
      productName: 'FIRMAN RD8910E',
      status: 'absent',
      exactProductIds: []
    }]);
    expect(metadata.toolResults?.[0]?.warnings).toContain('exact_catalog_product_absent:FIRMAN RD8910E');
    expect(payload.answer).toContain('starts with a key');
    expect(payload.answer).toContain('not in our catalog');
    expect(payload.answer).toContain('RD7910E');
    const lowerAnswer = payload.answer.toLocaleLowerCase('en-US');
    for (const forbidden of ['availability', 'delivery', 'discount', 'callback', 'lead', 'price']) {
      expect(lowerAnswer).not.toContain(forbidden);
    }
    expect(payload.productCards).toEqual([]);
  });

  it('does not mark a suffix model as exact and passes practical start-control guidance to the answer', async () => {
    researchProductComparisonFacts.mockResolvedValueOnce({
      usedWebSearch: true,
      facts: [{
        productName: 'FIRMAN RD2910E',
        attribute: 'start control',
        value: 'electric starter operated by the engine/ignition switch in START; push-button start is not confirmed',
        sourceType: 'web',
        confidence: 'high',
        evidence: 'exact-target manual says to move the engine switch to START and hold it briefly',
        sourceUrl: 'https://example.test/firman-rd2910e-manual',
        sourceTitle: 'FIRMAN RD2910E manual'
      }],
      conflicts: [],
      answerGuidance: {
        directAnswer: 'RD2910E starts by electric starter through the engine/ignition switch turned to START; it is not evidenced as a push-button start.',
        completeness: 'answered',
        coverage: [{
          attribute: 'start control',
          status: 'confirmed',
          value: 'engine/ignition switch to START',
          evidence: 'exact-target manual start procedure',
          sourceUrl: 'https://example.test/firman-rd2910e-manual',
          sourceTitle: 'FIRMAN RD2910E manual'
        }]
      },
      summaryForAnswer: 'RD2910E uses an electric starter through a START switch; push-button start is not confirmed.',
      warnings: []
    });

    class SuffixCatalogProducts extends FakeProducts {
      async searchProducts() {
        return [
          product('rd2910e1', 'FIRMAN RD2910E1 generator 2 kW', { starter: 'manual / electric' }),
          product('rd3910e', 'FIRMAN RD3910E generator 2.5 kW', { starter: 'manual / electric' }),
          product('rd10910e', 'FIRMAN RD10910E generator 7.2 kW', { starter: 'manual / electric' })
        ];
      }
    }

    const exactFactModel: AgentManagerModel = {
      ...model(),
      async planTurn() {
        return {
          userMessageSummary: 'buyer asks how FIRMAN RD2910E starts',
          dialogueUnderstanding: 'single exact technical fact for a named model',
          nextStepRationale: 'look up exact model start-control mechanism',
          requiresTools: true,
          toolRequests: [{
            id: 'web:start-control',
            tool: 'web.researchProductFacts',
            args: {
              query: 'FIRMAN RD2910E key or button start',
              semanticQuery: 'FIRMAN RD2910E ignition key or push-button start control',
              productIntent: 'generator',
              limit: 4,
              productIds: [],
              productNames: ['FIRMAN RD2910E'],
              comparisonAttributes: ['key start', 'push-button start', 'start control'],
              loads: [],
              simultaneousStarting: null,
              simultaneousStartingKinds: [],
              contact: { name: null, phone: null, email: null, preferredContact: null, comment: null },
              reason: 'exact model start-control fact',
              notes: 'answer key/button mechanism directly'
            },
            rationale: 'exact model fact must not be inferred from suffix model RD2910E1',
            required: true
          }],
          mustNotAskQuestionIds: [],
          riskFlags: []
        };
      },
      async composeAnswer(input) {
        const result = input.toolResults[0]?.payload as {
          catalogPresence?: Array<{ status?: string; exactProductIds?: string[] }>;
          nearbyCatalogProducts?: Array<{ name?: string }>;
          answerGuidance?: { directAnswer?: string };
        };
        expect(result.catalogPresence?.[0]).toEqual({
          productName: 'FIRMAN RD2910E',
          status: 'absent',
          exactProductIds: []
        });
        expect(result.nearbyCatalogProducts?.map((item) => item.name)).toEqual(expect.arrayContaining([
          'FIRMAN RD2910E1 generator 2 kW',
          'FIRMAN RD3910E generator 2.5 kW'
        ]));
        expect(input.requiredResponseClauses?.map((clause) => clause.code)).toEqual(expect.arrayContaining([
          'answer_checked_research_guidance',
          'state_exact_catalog_absence',
          'mention_nearby_catalog_models'
        ]));
        expect(input.requiredResponseClauses?.map((clause) => clause.instruction).join('\n')).toContain('engine/ignition switch turned to START');
        return {
          answerText: 'RD2910E запускается электростартером через поворот выключателя/замка в START; кнопочный запуск по источнику не подтвержден. В нашем каталоге точной RD2910E нет, рядом есть RD2910E1 и RD3910E.',
          factsUsed: [{
            factKey: 'firman_rd2910e.start_control',
            sourceEventIds: ['web:start-control'],
            value: 'engine/ignition switch to START'
          }],
          questionsAsked: [],
          toolResultIds: ['web:start-control'],
          leadAction: 'none',
          riskFlags: []
        };
      }
    };
    const conversations = new FakeConversations();
    conversations.messages = [message('Firman RD2910E - заводится с ключа или с кнопки?')];
    const orchestrator = new AgentManagerOrchestrator(conversations as never, new SuffixCatalogProducts() as never, {} as never, exactFactModel);

    const payload = await orchestrator.generateAnswer({
      sessionId,
      turnId,
      userMessage: 'Firman RD2910E - заводится с ключа или с кнопки?'
    });

    expect(researchProductComparisonFacts).toHaveBeenCalledWith(expect.objectContaining({
      targetProductNames: ['FIRMAN RD2910E'],
      comparisonAttributes: ['key start', 'push-button start', 'start control'],
      products: expect.arrayContaining([
        expect.objectContaining({ name: 'FIRMAN RD2910E1 generator 2 kW' })
      ])
    }));
    const metadata = payload.metadata as { toolResults?: Array<{ payload?: { catalogPresence?: unknown[] }; warnings?: string[] }> };
    expect(metadata.toolResults?.[0]?.payload?.catalogPresence).toEqual([{
      productName: 'FIRMAN RD2910E',
      status: 'absent',
      exactProductIds: []
    }]);
    expect(metadata.toolResults?.[0]?.warnings).toContain('exact_catalog_product_absent:FIRMAN RD2910E');
    expect(payload.answer).toContain('START');
    expect(payload.answer).toContain('точной RD2910E нет');
    expect(payload.productCards).toEqual([]);
  });

  it('rewrites exact-model answers to checked guidance when start-control coverage is ambiguous', async () => {
    researchProductComparisonFacts.mockResolvedValueOnce({
      usedWebSearch: true,
      facts: [{
        productName: 'FIRMAN RD3910E',
        attribute: 'starting method',
        value: 'electrostarter; key/button control not confirmed',
        sourceType: 'web',
        confidence: 'high',
        evidence: 'exact-target specification confirms electrostarter only',
        sourceUrl: 'https://example.test/firman-rd3910e',
        sourceTitle: 'FIRMAN RD3910E specification'
      }],
      conflicts: [],
      answerGuidance: {
        directAnswer: 'По точной спецификации у FIRMAN RD3910E электростартер; ключ/замок и кнопка в источниках не подтверждены.',
        completeness: 'partially_answered',
        coverage: [{
          attribute: 'ignition control',
          status: 'ambiguous',
          value: 'key/button control not confirmed',
          evidence: 'exact-target sources only say electrostarter',
          sourceUrl: 'https://example.test/firman-rd3910e',
          sourceTitle: 'FIRMAN RD3910E specification'
        }]
      },
      summaryForAnswer: 'RD3910E has electrostarter; key/button control is not confirmed.',
      warnings: []
    });

    class PresentCatalogProducts extends FakeProducts {
      async searchProducts() {
        return [
          product('rd3910e', 'FIRMAN RD3910E generator 2.5 kW', { starter: 'manual / electric' })
        ];
      }
    }

    const overconfidentModel: AgentManagerModel = {
      ...model(),
      async planTurn() {
        return {
          userMessageSummary: 'buyer asks whether FIRMAN RD3910E is key or button start',
          dialogueUnderstanding: 'single exact technical fact for a named model',
          nextStepRationale: 'look up exact model start-control mechanism',
          requiresTools: true,
          toolRequests: [{
            id: 'web:rd3910e',
            tool: 'web.researchProductFacts',
            args: {
              query: 'FIRMAN RD3910E key or button start',
              semanticQuery: 'FIRMAN RD3910E ignition key or push-button start control',
              productIntent: 'generator',
              limit: 4,
              productIds: [],
              productNames: ['FIRMAN RD3910E'],
              comparisonAttributes: ['key start', 'push-button start', 'start control'],
              loads: [],
              simultaneousStarting: null,
              simultaneousStartingKinds: [],
              contact: { name: null, phone: null, email: null, preferredContact: null, comment: null },
              reason: 'exact model start-control fact',
              notes: 'answer key/button mechanism directly'
            },
            rationale: 'exact model fact must be grounded',
            required: true
          }],
          mustNotAskQuestionIds: [],
          riskFlags: []
        };
      },
      async composeAnswer() {
        return {
          answerText: 'RD3910E есть и запускается ключом/замком зажигания, а не кнопкой.',
          factsUsed: [{
            factKey: 'firman_rd3910e.start_control',
            sourceEventIds: ['web:rd3910e'],
            value: 'key start'
          }],
          questionsAsked: [],
          toolResultIds: ['web:rd3910e'],
          leadAction: 'none',
          riskFlags: []
        };
      }
    };
    const conversations = new FakeConversations();
    conversations.messages = [message('Firman RD3910E есть? Он с ключа или с кнопки?')];
    const orchestrator = new AgentManagerOrchestrator(conversations as never, new PresentCatalogProducts() as never, {} as never, overconfidentModel);

    const payload = await orchestrator.generateAnswer({
      sessionId,
      turnId,
      userMessage: 'Firman RD3910E есть? Он с ключа или с кнопки?'
    });

    expect(payload.answer).toContain('ключ/замок и кнопка в источниках не подтверждены');
    expect(payload.answer).not.toContain('запускается ключом/замком');
    expect(payload.answer).toContain('В каталоге БАКАУТ FIRMAN RD3910E есть.');
    expect(payload.answer).not.toContain('Из близких вариантов');
    expect(payload.metadata?.preSendReview).toMatchObject({
      verdict: 'rewrite_required',
      issues: expect.arrayContaining([
        expect.objectContaining({ code: 'research_guidance_uncertainty_safe_rewrite' })
      ])
    });
  });

  it('repairs follow-up plans that reuse facts from a different exact model', async () => {
    researchProductComparisonFacts.mockResolvedValueOnce({
      usedWebSearch: true,
      facts: [{
        productName: 'RD3910E',
        attribute: 'starting method',
        value: 'manual starter / electric starter; key/button control not confirmed',
        sourceType: 'web',
        confidence: 'high',
        evidence: 'exact current-target catalog/research context confirms starter type only',
        sourceUrl: 'https://example.test/firman-rd3910e',
        sourceTitle: 'FIRMAN RD3910E specification'
      }],
      conflicts: [],
      answerGuidance: {
        directAnswer: 'У RD3910E подтвержден ручной стартер / электростартер; кнопка по точным источникам не подтверждена.',
        completeness: 'partially_answered',
        coverage: [
          {
            attribute: 'key start',
            status: 'ambiguous',
            value: 'key/switch control not fully confirmed',
            evidence: 'current exact target sources confirm electric starter but do not fully prove key/switch control',
            sourceUrl: 'https://example.test/firman-rd3910e',
            sourceTitle: 'FIRMAN RD3910E specification'
          },
          {
            attribute: 'button start',
            status: 'not_confirmed',
            value: 'push-button control not confirmed',
            evidence: 'current exact target sources do not name push-button control',
            sourceUrl: 'https://example.test/firman-rd3910e',
            sourceTitle: 'FIRMAN RD3910E specification'
          }
        ]
      },
      summaryForAnswer: 'RD3910E starter type is confirmed; key/button control is not confirmed.',
      warnings: []
    });

    class PresentCatalogProducts extends FakeProducts {
      async searchProducts() {
        return [
          product('rd3910e', 'FIRMAN RD3910E generator 2.5 kW', { starter: 'manual / electric' })
        ];
      }
    }

    const badFollowUpPlanner: AgentManagerModel = {
      ...model(),
      async proposeLedgerDelta() {
        return {
          rationale: 'follow-up model question',
          events: []
        };
      },
      async planTurn() {
        return {
          turnId: 'q2',
          userMessageSummary: 'buyer asks if RD3910E starts the same way as the previous model',
          dialogueUnderstanding: 'incorrectly assumes previous model fact applies',
          nextStepRationale: 'answer from context',
          requiresTools: false,
          toolRequests: [],
          mustNotAskQuestionIds: [],
          riskFlags: []
        };
      },
      async composeAnswer(input) {
        expect(input.toolResults).toEqual(expect.arrayContaining([
          expect.objectContaining({ tool: 'web.researchProductFacts' })
        ]));
        expect(input.requiredResponseClauses?.map((clause) => clause.code)).toContain('answer_checked_research_guidance');
        return {
          answerText: 'Да, RD3910E тоже запускается с ключа/выключателя, не кнопкой.',
          factsUsed: [{
            factKey: 'rd3910e.start_control',
            sourceEventIds: ['auto:exact-model:rd3910e'],
            value: 'key start'
          }],
          questionsAsked: [],
          toolResultIds: ['auto:exact-model:rd3910e'],
          leadAction: 'none',
          riskFlags: []
        };
      }
    };
    const conversations = new FakeConversations();
    conversations.messages = [
      message('RD2910E с ключа или кнопки?'),
      message('RD2910E с ключа, в каталоге нет. Из близких есть RD3910E.', 'assistant'),
      message('А Firman RD3910E у вас есть? Там запуск так же через ключ/выключатель, а не кнопкой?')
    ];
    const orchestrator = new AgentManagerOrchestrator(conversations as never, new PresentCatalogProducts() as never, {} as never, badFollowUpPlanner);

    const payload = await orchestrator.generateAnswer({
      sessionId,
      turnId,
      userMessage: 'А Firman RD3910E у вас есть? Там запуск так же через ключ/выключатель, а не кнопкой?'
    });

    expect(researchProductComparisonFacts).toHaveBeenCalledWith(expect.objectContaining({
      targetProductNames: ['RD3910E']
    }));
    expect(payload.answer).toContain('по ключу/выключателю точного подтверждения нет');
    expect(payload.answer).toContain('по кнопке не подтверждено');
    expect(payload.answer).not.toContain('тоже запускается с ключа');
    expect(payload.answer).toContain('В каталоге БАКАУТ RD3910E есть.');
    expect(payload.metadata?.intentContract).toMatchObject({
      requiresTools: true,
      riskFlags: expect.arrayContaining(['planner_repaired_exact_model_evidence'])
    });
  });

  it('binds visible comparison targets to products, runs web research, and records conflicts', async () => {
    researchProductComparisonFacts.mockResolvedValue({
      usedWebSearch: true,
      facts: [{
        productName: 'SUMEC FIRMAN 6 kW',
        attribute: 'noiseDb',
        value: '74 dB',
        sourceType: 'catalog',
        confidence: 'high',
        evidence: 'catalog'
      }],
      conflicts: [{
        productName: 'SUMEC FIRMAN 6 kW',
        attribute: 'noiseDb',
        catalogValue: '74 dB',
        webValues: ['76 dB'],
        resolution: 'catalog conflicts with one web source; disclose uncertainty'
      }],
      summaryForAnswer: 'Use catalog value and disclose conflict.',
      warnings: []
    });
    const conversations = new FakeConversations();
    const products = new FakeProducts();
    const orchestrator = new AgentManagerOrchestrator(conversations as never, products as never, {} as never, model());

    const payload = await orchestrator.generateAnswer({
      sessionId,
      turnId,
      userMessage: 'Compare SUMEC and BISON generators by power and noise.'
    });

    expect(payload.usedWebSearch).toBe(true);
    expect(researchProductComparisonFacts).toHaveBeenCalledWith(expect.objectContaining({
      products: expect.arrayContaining([
        expect.objectContaining({ name: 'SUMEC FIRMAN 6 kW' }),
        expect.objectContaining({ name: 'BISON 6 kW' })
      ])
    }));
    expect(products.recordedIssues).toEqual([expect.objectContaining({
      issueType: 'web_catalog_conflict',
      fieldName: 'noiseDb'
    })]);
  });
});
