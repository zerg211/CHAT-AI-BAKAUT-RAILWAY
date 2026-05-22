import { describe, expect, it, vi } from 'vitest';
import { emptyNeedState } from '../src/ai/needState.js';
import type { AgentManagerModel } from '../src/ai/agentManagerOrchestrator.js';
import type { ConversationSession, ConversationTurn, Message, Product, VerifiedProductFact, VerifiedProductFactInput } from '../src/shared/types.js';

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

function product(id: string, name: string, specs: Record<string, unknown>, description?: string): Product {
  return {
    id,
    name,
    brand: name.split(' ')[0],
    category: 'Generators',
    price: 1000,
    currency: 'RUB',
    sourceUrl: `https://example.test/${id}`,
    description,
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
  verifiedFacts: VerifiedProductFact[] = [];
  savedVerifiedFacts: VerifiedProductFactInput[] = [];
  mirroredWebFacts: unknown[] = [];
  usedVerifiedFactIds: string[] = [];
  async searchProducts() {
    return [
      product('sumec', 'SUMEC FIRMAN 6 kW', { noiseDb: '74 dB', nominalPowerKw: 5.5 }),
      product('bison', 'BISON 6 kW', { nominalPowerKw: 5.5 })
    ];
  }
  async searchVerifiedProductFacts() {
    return this.verifiedFacts;
  }
  async markVerifiedProductFactsUsed(ids: string[]) {
    this.usedVerifiedFactIds.push(...ids);
    return ids.length;
  }
  async upsertVerifiedProductFact(input: VerifiedProductFactInput) {
    this.savedVerifiedFacts.push(input);
    const now = new Date('2026-05-19T12:00:00.000Z').toISOString();
    const saved: VerifiedProductFact = {
      id: `verified-${this.savedVerifiedFacts.length}`,
      productId: input.productId ?? null,
      productKey: input.productName.toLocaleLowerCase('ru-RU'),
      productName: input.productName,
      attribute: input.attribute,
      value: input.value,
      sourceType: input.sourceType,
      sourceUrl: input.sourceUrl ?? null,
      sourceTitle: input.sourceTitle ?? null,
      evidence: input.evidence ?? null,
      confidence: input.confidence,
      status: 'active',
      firstSeenAt: now,
      lastVerifiedAt: now,
      hitCount: 0,
      createdAt: now,
      updatedAt: now
    };
    this.verifiedFacts.push(saved);
    return saved;
  }
  async upsertVerifiedWebFact(input: unknown) {
    this.mirroredWebFacts.push(input);
    return input;
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
  it('requires explicit grounding when web research fails before the answer is composed', async () => {
    researchProductComparisonFacts.mockRejectedValueOnce(
      new Error('product_comparison_research did not return a JSON object')
    );

    const clausesSeen: Array<{ code?: string; sourceRequestId?: string; instruction?: string }> = [];
    const groundingModel: AgentManagerModel = {
      ...model(),
      async planTurn() {
        return {
          userMessageSummary: 'buyer asks why THD matters for boiler electronics',
          dialogueUnderstanding: 'technical fact explanation needs web verification when exact catalog data is missing',
          nextStepRationale: 'try web research, then answer only at the grounded level if the research fails',
          requiresTools: true,
          toolRequests: [{
            id: 'web:thd',
            tool: 'web.researchProductFacts',
            args: {
              query: 'THD inverter generator boiler electronics',
              semanticQuery: 'practical THD importance for boiler and sensitive electronics',
              productIntent: 'generator',
              limit: 4,
              productIds: [],
              productNames: [],
              comparisonAttributes: ['THD'],
              loads: [],
              simultaneousStarting: null,
              simultaneousStartingKinds: [],
              contact: { name: null, phone: null, email: null, preferredContact: null, comment: null },
              reason: 'verify technical facts',
              notes: 'technical explanation only'
            },
            rationale: 'the buyer explicitly asked to check facts',
            required: true
          }],
          mustNotAskQuestionIds: [],
          riskFlags: ['web_required']
        };
      },
      async composeAnswer(input) {
        clausesSeen.push(...(input.requiredResponseClauses ?? []));
        return {
          answerText: 'THD matters because lower distortion is generally safer for boiler controls and sensitive electronics. Exact verification did not complete in this turn, so I would check the passport for the chosen model before treating a THD number as confirmed.',
          factsUsed: [],
          questionsAsked: [],
          toolResultIds: [],
          leadAction: 'none',
          riskFlags: ['web_research_unavailable']
        };
      }
    };

    const conversations = new FakeConversations();
    conversations.messages = [message('Explain why THD matters for an inverter generator and check facts if catalog data is missing.')];
    const orchestrator = new AgentManagerOrchestrator(
      conversations as never,
      new FakeProducts() as never,
      { async createLead() { return null; } } as never,
      groundingModel
    );

    const payload = await orchestrator.generateAnswer({
      sessionId,
      turnId,
      userMessage: 'Explain why THD matters for an inverter generator and check facts if catalog data is missing.'
    });

    expect(clausesSeen).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'web_research_unavailable_grounding',
        sourceRequestId: 'web:thd'
      })
    ]));
    expect(clausesSeen[0]?.instruction).toContain('did not complete successfully');
    const metadata = payload.metadata as { toolResults?: Array<{ status?: string; warnings?: string[] }> };
    expect(metadata.toolResults?.[0]).toMatchObject({
      status: 'error',
      warnings: ['tool_execution_error']
    });
  });

  it('repairs web-required grounding into an executable web research tool', async () => {
    researchProductComparisonFacts.mockResolvedValueOnce({
      usedWebSearch: true,
      facts: [{
        productName: 'general inverter generator',
        attribute: 'THD',
        value: 'lower THD means a cleaner waveform for sensitive electronics',
        sourceType: 'web',
        confidence: 'medium',
        evidence: 'engineering reference for harmonic distortion'
      }],
      conflicts: [],
      answerGuidance: {
        directAnswer: 'Lower THD reduces waveform distortion for boiler boards and sensitive electronics.',
        completeness: 'answered',
        coverage: [{
          attribute: 'THD practical effect',
          status: 'confirmed',
          value: 'lower distortion is better for sensitive electronics',
          evidence: 'web grounding'
        }]
      },
      summaryForAnswer: 'THD is a waveform distortion metric; lower values are preferable for sensitive electronics.',
      warnings: []
    });

    const toolResultIdsSeen: string[] = [];
    const groundingRepairModel: AgentManagerModel = {
      ...model(),
      async planTurn() {
        return {
          userMessageSummary: 'buyer asks why THD matters and asks to check facts if catalog data is missing',
          dialogueUnderstanding: 'technical answer needs external grounding, but the planner omitted the tool request',
          nextStepRationale: 'answer after web grounding',
          requiresTools: false,
          toolRequests: [],
          grounding: {
            taskType: 'technical_answer',
            sourcePolicy: 'web_required',
            webPurpose: 'technical_specs',
            requiredToolKinds: ['web.researchProductFacts'],
            technicalAttributes: ['THD', 'waveform distortion', 'boiler electronics'],
            rationale: 'buyer requested technical fact verification'
          },
          productMentions: [{
            name: 'inverter generator',
            role: 'target_product',
            productClass: 'generator',
            evidence: 'buyer asks about THD of an inverter generator'
          }],
          mustNotAskQuestionIds: [],
          riskFlags: []
        };
      },
      async composeAnswer(input) {
        toolResultIdsSeen.push(...input.toolResults.map((result) => result.requestId));
        return {
          answerText: 'THD показывает, насколько форма напряжения отличается от чистой синусоиды. Для котла и электроники ниже THD обычно лучше: меньше риск сбоев платы, перегрева блоков питания и помех.',
          factsUsed: [{
            factKey: 'thd.practical_effect',
            sourceEventIds: [input.toolResults[0]?.requestId ?? 'auto:web-grounding'],
            value: 'lower THD is safer for sensitive electronics'
          }],
          questionsAsked: [],
          toolResultIds: input.toolResults.map((result) => result.requestId),
          leadAction: 'none',
          riskFlags: []
        };
      }
    };

    const conversations = new FakeConversations();
    conversations.messages = [message('Explain why THD matters for an inverter generator and check facts if catalog data is missing.')];
    const orchestrator = new AgentManagerOrchestrator(
      conversations as never,
      new FakeProducts() as never,
      { async createLead() { return null; } } as never,
      groundingRepairModel
    );

    const payload = await orchestrator.generateAnswer({
      sessionId,
      turnId,
      userMessage: 'Explain why THD matters for an inverter generator and check facts if catalog data is missing.'
    });

    const metadata = payload.metadata as {
      intentContract?: { toolRequests?: Array<{ id?: string; tool?: string }>; riskFlags?: string[] };
      sourcePolicy?: { required?: string[] };
      turnContract?: { taskType?: string };
      toolResults?: Array<{ requestId?: string; tool?: string; status?: string }>;
    };
    expect(metadata.intentContract?.toolRequests).toContainEqual(expect.objectContaining({
      id: 'auto:web-grounding',
      tool: 'web.researchProductFacts'
    }));
    expect(metadata.intentContract?.riskFlags).toContain('planner_repaired_grounding_web_tool');
    expect(metadata.sourcePolicy?.required).toContain('web');
    expect(metadata.turnContract?.taskType).toBe('technical_answer');
    expect(metadata.toolResults?.[0]).toMatchObject({
      requestId: 'auto:web-grounding',
      tool: 'web.researchProductFacts',
      status: 'ok'
    });
    expect(toolResultIdsSeen).toEqual(['auto:web-grounding']);
  });

  it('rewrites exact-model claims that cite failed web research as fact evidence', async () => {
    researchProductComparisonFacts.mockRejectedValueOnce(
      new Error('product_comparison_research did not return a JSON object')
    );

    class ExactCatalogProducts extends FakeProducts {
      async searchProducts() {
        return [
          product('g7000is', 'SUNREKA G7000iS generator 6 kW', { starter: 'с ручным стартером' })
        ];
      }
    }

    const badGroundingModel: AgentManagerModel = {
      ...model(),
      async planTurn() {
        return {
          userMessageSummary: 'buyer asks whether SUNREKA G7000iS starts by cord or button',
          dialogueUnderstanding: 'exact named-model technical fact needs web verification',
          nextStepRationale: 'verify exact start control',
          requiresTools: true,
          toolRequests: [{
            id: 'web:g7000is',
            tool: 'web.researchProductFacts',
            args: {
              query: 'SUNREKA G7000iS starting method button recoil electric start',
              semanticQuery: 'Verify whether SUNREKA G7000iS starts by recoil cord or by button/electric starter.',
              productIntent: 'generator',
              limit: 4,
              productIds: [],
              productNames: ['SUNREKA G7000iS'],
              comparisonAttributes: ['starting method', 'button start', 'electric start', 'recoil start'],
              loads: [],
              simultaneousStarting: null,
              simultaneousStartingKinds: [],
              contact: { name: null, phone: null, email: null, preferredContact: null, comment: null },
              reason: 'exact model start method',
              notes: 'answer only the direct technical question'
            },
            rationale: 'exact start-control fact must be grounded',
            required: true
          }],
          mustNotAskQuestionIds: [],
          riskFlags: []
        };
      },
      async composeAnswer() {
        return {
          answerText: 'По данным из карточки, SUNREKA G7000iS запускается ручным стартером, то есть шнурком. Кнопочного запуска для этой модели в данных не вижу.',
          factsUsed: [{
            factKey: 'g7000is.start_method',
            sourceEventIds: ['web:g7000is'],
            value: 'manual starter only'
          }],
          questionsAsked: [],
          toolResultIds: ['web:g7000is'],
          leadAction: 'none',
          riskFlags: ['web_research_failed_for_named_model']
        };
      },
      async reviewAnswer() {
        throw new Error('mechanical review should catch failed tool fact evidence before LLM review');
      }
    };

    const conversations = new FakeConversations();
    conversations.messages = [message('SUNREKA G7000iS нужно заводить шнурком или он запускается кнопкой?')];
    const orchestrator = new AgentManagerOrchestrator(
      conversations as never,
      new ExactCatalogProducts() as never,
      { async createLead() { return null; } } as never,
      badGroundingModel
    );

    const payload = await orchestrator.generateAnswer({
      sessionId,
      turnId,
      userMessage: 'SUNREKA G7000iS нужно заводить шнурком или он запускается кнопкой?'
    });

    expect(payload.answer).toContain('точный факт по SUNREKA G7000iS');
    expect(payload.answer).toContain('внешняя проверка не завершилась');
    expect(payload.answer).not.toContain('запускается ручным стартером');
    expect(payload.answer).not.toContain('Кнопочного запуска для этой модели в данных не вижу');
    expect(payload.answer).not.toContain('есть в каталоге');
    const metadata = payload.metadata as {
      answerContract?: { factsUsed?: unknown[] };
      preSendReview?: { verdict?: string; issues?: Array<{ code?: string }> };
      toolResults?: Array<{ status?: string; warnings?: string[] }>;
    };
    expect(metadata.toolResults?.[0]).toMatchObject({
      status: 'error',
      warnings: ['tool_execution_error']
    });
    expect(metadata.preSendReview).toMatchObject({
      verdict: 'rewrite_required',
      issues: expect.arrayContaining([
        expect.objectContaining({ code: 'failed_tool_result_used_as_fact_source' })
      ])
    });
    expect(metadata.answerContract?.factsUsed).toEqual([]);
  });

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

  it('does not auto-promote context load devices into exact catalog targets', async () => {
    researchProductComparisonFacts.mockClear();

    const baxiContextModel: AgentManagerModel = {
      ...model(),
      async proposeLedgerDelta() {
        return {
          rationale: 'generator load request with context device',
          events: [{
            eventType: 'fact.observed',
            scope: 'dialogue',
            payload: { factKey: 'load.boiler_model', value: 'Baxi 24' },
            evidence: 'котел Baxi 24 is a load device for generator sizing',
            source: 'llm_state_delta',
            status: 'active'
          }]
        };
      },
      async planTurn() {
        return {
          userMessageSummary: 'buyer sizes a generator for Baxi 24 boiler and pump',
          dialogueUnderstanding: 'Baxi 24 is a powered load, not the product being bought',
          nextStepRationale: 'calculate generator load and do not check Baxi catalog presence',
          requiresTools: true,
          toolRequests: [{
            id: 'calc:baxi-load',
            tool: 'calculator.generatorLoad',
            args: {
              query: 'generator for Baxi 24 boiler and 1.1 kW pump',
              semanticQuery: 'size generator for boiler, deep well pump, refrigerator and lights',
              productIntent: 'generator',
              limit: null,
              productIds: [],
              productNames: [],
              comparisonAttributes: [],
              loads: [{
                kind: 'boiler',
                name: 'Baxi 24 boiler',
                count: 1,
                runningKw: 0.15,
                startingKw: 0.2,
                source: 'estimated_average',
                evidence: 'газовый котел Baxi 24',
                basisKind: 'specific_type_or_function',
                basisSignals: ['consumer_type_known', 'consumer_function_known', 'voltage_or_phase_known']
              }, {
                kind: 'pump',
                name: 'deep well pump',
                count: 1,
                runningKw: 1.1,
                startingKw: 3.3,
                source: 'explicit_user',
                evidence: 'насос 1,1 кВт',
                basisKind: 'exact_power',
                basisSignals: ['explicit_power', 'voltage_or_phase_known']
              }],
              simultaneousStarting: true,
              simultaneousStartingKinds: ['pump'],
              estimateBasis: 'bounded_assumption',
              contact: { name: null, phone: null, email: null, preferredContact: null, comment: null },
              reason: 'calculate generator size',
              notes: 'Baxi 24 is only a load device'
            },
            rationale: 'load sizing for generator',
            required: true
          }],
          productMentions: [{
            name: 'Baxi 24',
            role: 'context_load_device',
            productClass: 'boiler',
            evidence: 'котел Baxi 24 is one of the loads connected to the generator'
          }],
          mustNotAskQuestionIds: [],
          riskFlags: []
        };
      },
      async composeAnswer(input) {
        expect(input.intent.toolRequests.map((request) => request.tool)).toEqual(['calculator.generatorLoad']);
        expect(input.toolResults.map((result) => result.tool)).toEqual(['calculator.generatorLoad']);
        return {
          answerText: 'Для такой нагрузки я бы смотрел генератор примерно от 5 кВт. Baxi 24 тут просто нагрузка, по каталогу котел проверять не нужно.',
          factsUsed: [{
            factKey: 'calc.requiredNominalKw',
            sourceEventIds: ['calc:baxi-load'],
            value: 4
          }],
          questionsAsked: [],
          toolResultIds: ['calc:baxi-load'],
          leadAction: 'none',
          riskFlags: []
        };
      }
    };

    const conversations = new FakeConversations();
    conversations.messages = [message('Нужен генератор для котла Baxi 24, насоса 1,1 кВт, холодильника и света.')];
    const orchestrator = new AgentManagerOrchestrator(conversations as never, new FakeProducts() as never, {} as never, baxiContextModel);

    const payload = await orchestrator.generateAnswer({
      sessionId,
      turnId,
      userMessage: 'Нужен генератор для котла Baxi 24, насоса 1,1 кВт, холодильника и света.'
    });

    expect(researchProductComparisonFacts).not.toHaveBeenCalled();
    const metadata = payload.metadata as { toolResults?: Array<{ warnings?: string[] }> };
    expect(metadata.toolResults?.flatMap((result) => result.warnings ?? [])).not.toContain('exact_catalog_product_absent:Baxi 24');
  });

  it('suppresses context load devices accidentally placed into exact web target names', async () => {
    researchProductComparisonFacts.mockResolvedValueOnce({
      usedWebSearch: false,
      facts: [],
      conflicts: [],
      summaryForAnswer: 'No exact target research was needed for the context boiler.',
      warnings: []
    });

    const baxiSanitizingModel: AgentManagerModel = {
      ...model(),
      async planTurn() {
        return {
          userMessageSummary: 'buyer asks generator sizing for Baxi 24',
          dialogueUnderstanding: 'Baxi 24 is a context load device, but a bad tool request included it as productNames',
          nextStepRationale: 'runtime should suppress Baxi 24 as an exact target',
          requiresTools: true,
          toolRequests: [{
            id: 'web:baxi-context',
            tool: 'web.researchProductFacts',
            args: {
              query: 'Baxi 24 electrical consumption for generator sizing',
              semanticQuery: 'boiler consumption context for generator sizing, not catalog availability',
              productIntent: 'generator',
              limit: 4,
              productIds: [],
              productNames: ['Baxi 24'],
              comparisonAttributes: ['electrical consumption'],
              loads: [],
              simultaneousStarting: null,
              simultaneousStartingKinds: [],
              contact: { name: null, phone: null, email: null, preferredContact: null, comment: null },
              reason: 'verify load context',
              notes: 'Baxi 24 is not the product target'
            },
            rationale: 'badly scoped context research request',
            required: true
          }],
          productMentions: [{
            name: 'Baxi 24',
            role: 'context_load_device',
            productClass: 'boiler',
            evidence: 'Baxi 24 is the boiler powered by the generator'
          }],
          mustNotAskQuestionIds: [],
          riskFlags: []
        };
      },
      async composeAnswer(input) {
        const result = input.toolResults[0]?.payload as {
          targetProductNames?: string[];
          catalogPresence?: unknown[];
          suppressedTargetProductNames?: string[];
        };
        expect(result.targetProductNames).toEqual([]);
        expect(result.catalogPresence).toEqual([]);
        expect(result.suppressedTargetProductNames).toEqual(['Baxi 24']);
        return {
          answerText: 'Baxi 24 учитываю как нагрузку для генератора, а не как товар для проверки в каталоге.',
          factsUsed: [],
          questionsAsked: [],
          toolResultIds: ['web:baxi-context'],
          leadAction: 'none',
          riskFlags: []
        };
      }
    };

    const conversations = new FakeConversations();
    conversations.messages = [message('Подберите генератор для Baxi 24 и насоса 1,1 кВт.')];
    const orchestrator = new AgentManagerOrchestrator(conversations as never, new FakeProducts() as never, {} as never, baxiSanitizingModel);

    const payload = await orchestrator.generateAnswer({
      sessionId,
      turnId,
      userMessage: 'Подберите генератор для Baxi 24 и насоса 1,1 кВт.'
    });

    expect(researchProductComparisonFacts).toHaveBeenCalledWith(expect.objectContaining({
      targetProductNames: [],
      comparisonAttributes: ['electrical consumption']
    }));
    const metadata = payload.metadata as { toolResults?: Array<{ warnings?: string[] }> };
    const warnings = metadata.toolResults?.flatMap((result) => result.warnings ?? []) ?? [];
    expect(warnings).toContain('exact_target_suppressed_by_product_role:Baxi 24');
    expect(warnings).not.toContain('exact_catalog_product_absent:Baxi 24');
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
    expect(payload.answer).toContain('У нас точной модели FIRMAN RD2910E в каталоге нет');
    expect(payload.answer).toContain('Рядом по каталогу есть');
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
          riskFlags: ['answer_policy_catalog_presence_relevant']
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
    expect(payload.answer).toContain('У нас эта модель есть в каталоге.');
    expect(payload.answer).not.toContain('В каталоге БАКАУТ');
    expect(payload.answer).not.toContain('По деталям запуска');
    expect(payload.answer).not.toContain('Из близких вариантов');
    expect(payload.metadata?.preSendReview).toMatchObject({
      verdict: 'rewrite_required',
      issues: expect.arrayContaining([
        expect.objectContaining({ code: 'research_guidance_uncertainty_safe_rewrite' })
      ])
    });
  });

  it('rewrites exact-model answers to checked catalog description guidance when the answer omits it', async () => {
    researchProductComparisonFacts.mockResolvedValueOnce({
      usedWebSearch: false,
      facts: [{
        productName: 'FIRMAN RD3910E',
        attribute: 'start control',
        value: 'запуск поворотом ключа электростартера',
        sourceType: 'catalog',
        confidence: 'high',
        evidence: 'catalog.description: запуск двигателя осуществляется поворотом ключа электростартера',
        sourceUrl: 'https://example.test/rd3910e',
        sourceTitle: 'FIRMAN RD3910E catalog card'
      }],
      conflicts: [],
      answerGuidance: {
        directAnswer: 'RD3910E запускается с ключа электростартера, плюс есть ручной запуск. Кнопочный запуск не подтвержден.',
        completeness: 'answered',
        coverage: [{
          attribute: 'key start',
          status: 'confirmed',
          value: 'поворот ключа электростартера',
          evidence: 'catalog.description',
          sourceUrl: 'https://example.test/rd3910e',
          sourceTitle: 'FIRMAN RD3910E catalog card'
        }]
      },
      summaryForAnswer: 'Catalog description confirms key electric start and manual start.',
      warnings: ['catalog_fact_extraction_used', 'exact_catalog_description_extracted']
    });

    class PresentCatalogProducts extends FakeProducts {
      async searchProducts() {
        return [
          product(
            'rd3910e',
            'FIRMAN RD3910E generator 2.5 kW',
            { starter: 'manual / electric' },
            'Запуск двигателя осуществляется поворотом ключа электростартера. Также предусмотрен ручной стартер.'
          )
        ];
      }
    }

    const omittingModel: AgentManagerModel = {
      ...model(),
      async planTurn() {
        return {
          userMessageSummary: 'buyer asks whether FIRMAN RD3910E is key or button start',
          dialogueUnderstanding: 'single exact technical fact for a named catalog model',
          nextStepRationale: 'verify exact model start-control mechanism',
          requiresTools: true,
          toolRequests: [{
            id: 'web:rd3910e-catalog',
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
            rationale: 'exact model fact must be grounded in catalog description when present',
            required: true
          }],
          mustNotAskQuestionIds: [],
          riskFlags: []
        };
      },
      async composeAnswer(input) {
        expect(input.requiredResponseClauses?.map((clause) => clause.code)).toContain('answer_checked_research_guidance');
        return {
          answerText: 'RD3910E есть в каталоге, стартер ручной/электро. По ключу или кнопке точной строки нет.',
          factsUsed: [({
            factKey: 'firman_rd3910e.start_control',
            sourceEventIds: ['web:rd3910e-catalog'],
            value: 'manual / electric'
          })],
          questionsAsked: [],
          toolResultIds: ['web:rd3910e-catalog'],
          leadAction: 'none',
          riskFlags: []
        };
      }
    };
    const conversations = new FakeConversations();
    conversations.messages = [message('Firman RD3910E - заводится с ключа или с кнопки?')];
    const orchestrator = new AgentManagerOrchestrator(conversations as never, new PresentCatalogProducts() as never, {} as never, omittingModel);

    const payload = await orchestrator.generateAnswer({
      sessionId,
      turnId,
      userMessage: 'Firman RD3910E - заводится с ключа или с кнопки?'
    });

    expect(payload.answer).toContain('ключа электростартера');
    expect(payload.answer).not.toContain('По ключу или кнопке точной строки нет');
    expect(payload.answer).not.toContain('У нас эта модель есть в каталоге.');
    expect(payload.answer).not.toContain('В каталоге БАКАУТ');
    expect(payload.answer).not.toContain('По деталям запуска');
    expect(payload.metadata?.preSendReview).toMatchObject({
      verdict: 'rewrite_required',
      issues: expect.arrayContaining([
        expect.objectContaining({ code: 'research_guidance_uncertainty_safe_rewrite' })
      ])
    });
  });

  it('keeps confirmed manual starter facts and avoids duplicate start-control uncertainty', async () => {
    researchProductComparisonFacts.mockResolvedValueOnce({
      usedWebSearch: false,
      facts: [{
        productName: 'FIRMAN RD3910E',
        attribute: 'start method',
        value: 'электростартер, запуск поворотом ключа',
        sourceType: 'catalog',
        confidence: 'high',
        evidence: 'Запуск генератора осуществляется простым поворотом ключа электростартера.',
        sourceUrl: 'https://example.test/rd3910e',
        sourceTitle: 'FIRMAN RD3910E catalog card'
      }],
      conflicts: [],
      answerGuidance: {
        directAnswer: 'RD3910E заводится с ключа, через электростартер. Кнопочного запуска тут не вижу.',
        completeness: 'answered',
        coverage: [
          {
            attribute: 'start method',
            status: 'confirmed',
            value: 'электростартер, запуск поворотом ключа',
            evidence: 'Запуск генератора осуществляется простым поворотом ключа электростартера.',
            sourceUrl: 'https://example.test/rd3910e',
            sourceTitle: 'FIRMAN RD3910E catalog card'
          },
          {
            attribute: 'electric start',
            status: 'confirmed',
            value: 'есть',
            evidence: 'стартер: ручной стартер / электростартер',
            sourceUrl: 'https://example.test/rd3910e',
            sourceTitle: 'FIRMAN RD3910E catalog card'
          },
          {
            attribute: 'starter button',
            status: 'not_found',
            value: '',
            evidence: 'В specs и description нет упоминания кнопки запуска.'
          }
        ]
      },
      summaryForAnswer: 'Catalog card confirms key electric start and manual starter; button start is not found.',
      warnings: ['catalog_fact_extraction_used', 'exact_catalog_description_extracted']
    });

    class PresentCatalogProducts extends FakeProducts {
      async searchProducts() {
        return [
          product(
            'rd3910e',
            'FIRMAN RD3910E generator 2.5 kW',
            { starter: 'manual / electric' },
            'Запуск двигателя осуществляется поворотом ключа электростартера. Также предусмотрен ручной стартер.'
          )
        ];
      }
    }

    const modelThatDropsCoverageFacts: AgentManagerModel = {
      ...model(),
      async planTurn() {
        return {
          userMessageSummary: 'buyer asks whether FIRMAN RD3910E is key or button start',
          dialogueUnderstanding: 'single exact technical fact for a named catalog model',
          nextStepRationale: 'verify exact model start-control mechanism',
          requiresTools: true,
          toolRequests: [{
            id: 'web:rd3910e-catalog',
            tool: 'web.researchProductFacts',
            args: {
              query: 'FIRMAN RD3910E key or button start',
              semanticQuery: 'FIRMAN RD3910E ignition key or push-button start control',
              productIntent: 'generator',
              limit: 4,
              productIds: [],
              productNames: ['FIRMAN RD3910E'],
              comparisonAttributes: ['start method', 'electric start', 'key start', 'starter button'],
              loads: [],
              simultaneousStarting: null,
              simultaneousStartingKinds: [],
              contact: { name: null, phone: null, email: null, preferredContact: null, comment: null },
              reason: 'exact model start-control fact',
              notes: 'answer key/button mechanism directly'
            },
            rationale: 'exact model fact must be grounded in catalog description when present',
            required: true
          }],
          mustNotAskQuestionIds: [],
          riskFlags: []
        };
      },
      async composeAnswer() {
        return {
          answerText: 'RD3910E есть в каталоге, стартер ручной/электро. По ключу или кнопке точной строки нет.',
          factsUsed: [{
            factKey: 'firman_rd3910e.start_control',
            sourceEventIds: ['web:rd3910e-catalog'],
            value: 'manual / electric'
          }],
          questionsAsked: [],
          toolResultIds: ['web:rd3910e-catalog'],
          leadAction: 'none',
          riskFlags: []
        };
      }
    };
    const conversations = new FakeConversations();
    conversations.messages = [message('Firman RD3910E - заводится с ключа или с кнопки?')];
    const orchestrator = new AgentManagerOrchestrator(conversations as never, new PresentCatalogProducts() as never, {} as never, modelThatDropsCoverageFacts);

    const payload = await orchestrator.generateAnswer({
      sessionId,
      turnId,
      userMessage: 'Firman RD3910E - заводится с ключа или с кнопки?'
    });

    expect(payload.answer).toContain('RD3910E заводится с ключа, через электростартер');
    expect(payload.answer).toContain('Ручной стартер тоже есть');
    expect(payload.answer).toContain('Кнопочного запуска тут не вижу');
    expect(payload.answer).not.toContain('Кнопочный запуск в данных не вижу');
    expect(payload.answer.split('Кнопоч').length - 1).toBe(1);
    expect(payload.answer).not.toContain('У нас эта модель есть в каталоге.');
    expect(payload.answer).not.toContain('У нас Firman RD3910E есть в каталоге');
  });

  it('does not duplicate start-control uncertainty when checked guidance already says it', async () => {
    researchProductComparisonFacts.mockResolvedValueOnce({
      usedWebSearch: true,
      facts: [{
        productName: 'FIRMAN RD4910E',
        attribute: 'starting method',
        value: 'manual starter / electric starter',
        sourceType: 'web',
        confidence: 'high',
        evidence: 'exact source confirms manual and electric starter',
        sourceUrl: 'https://example.test/firman-rd4910e',
        sourceTitle: 'FIRMAN RD4910E specification'
      }],
      conflicts: [],
      answerGuidance: {
        directAnswer: 'Электростартер есть, ручной запуск тоже есть. А вот чем включается электростартер — ключом, кнопкой или переключателем — источники не подтвердили.',
        completeness: 'partially_answered',
        coverage: [
          {
            attribute: 'electric start',
            status: 'confirmed',
            value: 'electric starter',
            evidence: 'exact source confirms electric starter',
            sourceUrl: 'https://example.test/firman-rd4910e',
            sourceTitle: 'FIRMAN RD4910E specification'
          },
          {
            attribute: 'manual starter',
            status: 'confirmed',
            value: 'manual starter',
            evidence: 'exact source confirms manual starter',
            sourceUrl: 'https://example.test/firman-rd4910e',
            sourceTitle: 'FIRMAN RD4910E specification'
          },
          {
            attribute: 'key start',
            status: 'not_confirmed',
            value: '',
            evidence: 'exact sources do not prove key control',
            sourceUrl: 'https://example.test/firman-rd4910e',
            sourceTitle: 'FIRMAN RD4910E specification'
          },
          {
            attribute: 'button start',
            status: 'not_confirmed',
            value: '',
            evidence: 'exact sources do not prove button control',
            sourceUrl: 'https://example.test/firman-rd4910e',
            sourceTitle: 'FIRMAN RD4910E specification'
          }
        ]
      },
      summaryForAnswer: 'Starter type is confirmed; control is not confirmed.',
      warnings: ['source_evidence_validation_failed:key_start']
    });

    const badModel: AgentManagerModel = {
      ...model(),
      async planTurn() {
        return {
          userMessageSummary: 'buyer asks if FIRMAN RD4910E starts with a key or button',
          dialogueUnderstanding: 'single exact technical fact for a named model',
          nextStepRationale: 'look up exact model start control',
          requiresTools: true,
          toolRequests: [{
            id: 'web:rd4910e',
            tool: 'web.researchProductFacts',
            args: {
              query: 'FIRMAN RD4910E key or button start',
              semanticQuery: 'FIRMAN RD4910E key button electric starter',
              productIntent: 'generator',
              limit: 4,
              productIds: [],
              productNames: ['FIRMAN RD4910E'],
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
          answerText: 'RD4910E запускается с ключа.',
          factsUsed: [],
          questionsAsked: [],
          toolResultIds: ['web:rd4910e'],
          leadAction: 'none',
          riskFlags: []
        };
      }
    };
    const conversations = new FakeConversations();
    conversations.messages = [message('Firman RD4910E заводится с ключа или с кнопки?')];
    const orchestrator = new AgentManagerOrchestrator(conversations as never, new FakeProducts() as never, {} as never, badModel);

    const payload = await orchestrator.generateAnswer({
      sessionId,
      turnId,
      userMessage: 'Firman RD4910E заводится с ключа или с кнопки?'
    });

    expect(payload.answer).toContain('Электростартер есть, ручной запуск тоже есть');
    expect(payload.answer).toContain('источники не подтвердили');
    expect(payload.answer).not.toContain('Чем именно включается электростартер');
    expect(payload.answer).not.toContain('Кнопочный запуск в данных не вижу');
  });

  it('does not append uncertainty for a start-control label that later coverage confirms', async () => {
    researchProductComparisonFacts.mockResolvedValueOnce({
      usedWebSearch: true,
      facts: [{
        productName: 'SUNREKA G7000iS',
        attribute: 'button start',
        value: 'есть',
        sourceType: 'web',
        confidence: 'high',
        evidence: 'exact source says start by START button',
        sourceUrl: 'https://example.test/sunreka-g7000is',
        sourceTitle: 'SUNREKA G7000iS specification'
      }],
      conflicts: [{
        productName: 'SUNREKA G7000iS',
        attribute: 'starting method',
        catalogValue: 'ручной стартер',
        webValues: ['ручной стартер + электростартер, кнопка START'],
        resolution: 'catalog is incomplete; exact external source confirms button start and manual start'
      }],
      answerGuidance: {
        directAnswer: 'Кнопочный запуск подтвержден. Ручной запуск тоже есть.',
        completeness: 'answered',
        coverage: [
          {
            attribute: 'button start',
            status: 'not_found',
            value: '',
            evidence: 'catalog specs do not mention a button',
            sourceUrl: 'https://example.test/catalog-g7000is',
            sourceTitle: 'Catalog card'
          },
          {
            attribute: 'button start',
            status: 'confirmed',
            value: 'есть',
            evidence: 'exact external source confirms START button',
            sourceUrl: 'https://example.test/sunreka-g7000is',
            sourceTitle: 'SUNREKA G7000iS specification'
          },
          {
            attribute: 'recoil start',
            status: 'confirmed',
            value: 'есть',
            evidence: 'exact external source confirms manual starter',
            sourceUrl: 'https://example.test/sunreka-g7000is',
            sourceTitle: 'SUNREKA G7000iS specification'
          }
        ]
      },
      summaryForAnswer: 'Button start and manual start are confirmed; catalog had only manual starter.',
      warnings: ['source_conflict_adjudicated']
    });

    class PresentCatalogProducts extends FakeProducts {
      async searchProducts() {
        return [
          product('g7000is', 'SUNREKA G7000iS generator 6 kW', { starter: 'с ручным стартером' })
        ];
      }
    }

    const badModel: AgentManagerModel = {
      ...model(),
      async planTurn() {
        return {
          userMessageSummary: 'buyer asks whether SUNREKA G7000iS starts by cord or button',
          dialogueUnderstanding: 'single exact technical fact for a named catalog model',
          nextStepRationale: 'verify exact start-control mechanism',
          requiresTools: true,
          toolRequests: [{
            id: 'web:g7000is',
            tool: 'web.researchProductFacts',
            args: {
              query: 'SUNREKA G7000iS button start recoil start',
              semanticQuery: 'SUNREKA G7000iS START button and manual starter',
              productIntent: 'generator',
              limit: 4,
              productIds: [],
              productNames: ['SUNREKA G7000iS'],
              comparisonAttributes: ['button start', 'recoil start', 'starting method'],
              loads: [],
              simultaneousStarting: null,
              simultaneousStartingKinds: [],
              contact: { name: null, phone: null, email: null, preferredContact: null, comment: null },
              reason: 'exact model start-control fact',
              notes: 'answer button vs cord directly'
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
          answerText: 'По карточке вижу только ручной стартер.',
          factsUsed: [],
          questionsAsked: [],
          toolResultIds: ['web:g7000is'],
          leadAction: 'none',
          riskFlags: []
        };
      }
    };
    const conversations = new FakeConversations();
    conversations.messages = [message('SUNREKA G7000iS нужно заводить шнурком или он запускается кнопкой?')];
    const orchestrator = new AgentManagerOrchestrator(conversations as never, new PresentCatalogProducts() as never, {} as never, badModel);

    const payload = await orchestrator.generateAnswer({
      sessionId,
      turnId,
      userMessage: 'SUNREKA G7000iS нужно заводить шнурком или он запускается кнопкой?'
    });

    expect(payload.answer).toContain('Кнопочный запуск подтвержден. Ручной запуск тоже есть.');
    expect(payload.answer).not.toContain('Кнопочный запуск в данных не вижу');
    expect(payload.answer).not.toContain('есть в каталоге');
    expect(payload.metadata?.preSendReview).toMatchObject({
      verdict: 'rewrite_required',
      issues: expect.arrayContaining([
        expect.objectContaining({ code: 'research_guidance_uncertainty_safe_rewrite' })
      ])
    });
  });

  it('saves high-confidence exact web facts into reusable product memory', async () => {
    researchProductComparisonFacts.mockResolvedValueOnce({
      usedWebSearch: true,
      facts: [
        {
          productName: 'SUNREKA G7000iS',
          attribute: 'button start',
          value: 'has START button start',
          sourceType: 'web',
          confidence: 'high',
          evidence: 'official source says the model starts by START button',
          sourceUrl: 'https://sunreka.example/g7000is',
          sourceTitle: 'SUNREKA G7000iS specification'
        },
        {
          productName: 'SUNREKA G7000iS',
          attribute: 'recoil start',
          value: 'manual recoil starter is also available',
          sourceType: 'web',
          confidence: 'high',
          evidence: 'official source lists manual starter',
          sourceUrl: 'https://sunreka.example/g7000is',
          sourceTitle: 'SUNREKA G7000iS specification'
        }
      ],
      conflicts: [],
      answerGuidance: {
        directAnswer: 'Starts by START button; manual recoil start is also available.',
        completeness: 'answered',
        coverage: []
      },
      summaryForAnswer: 'Button and recoil start are confirmed.',
      warnings: []
    });

    class PresentCatalogProducts extends FakeProducts {
      async searchProducts() {
        return [
          product('g7000is', 'SUNREKA G7000iS generator 6 kW', { starter: 'manual starter' })
        ];
      }
    }

    const fakeProducts = new PresentCatalogProducts();
    const savingModel: AgentManagerModel = {
      ...model(),
      async planTurn() {
        return {
          userMessageSummary: 'buyer asks if G7000iS starts by button or cord',
          dialogueUnderstanding: 'exact technical fact for a named model',
          nextStepRationale: 'verify exact model start controls',
          requiresTools: true,
          toolRequests: [{
            id: 'web:g7000is',
            tool: 'web.researchProductFacts',
            args: {
              query: 'SUNREKA G7000iS button start recoil start',
              semanticQuery: 'SUNREKA G7000iS START button and recoil starter',
              productNames: ['SUNREKA G7000iS'],
              comparisonAttributes: ['button start', 'recoil start']
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
          answerText: 'Starts by START button; manual recoil start is also available.',
          factsUsed: [],
          questionsAsked: [],
          toolResultIds: ['web:g7000is'],
          leadAction: 'none',
          riskFlags: []
        };
      }
    };

    const conversations = new FakeConversations();
    conversations.messages = [message('SUNREKA G7000iS starts by cord or button?')];
    const orchestrator = new AgentManagerOrchestrator(conversations as never, fakeProducts as never, {} as never, savingModel);

    await orchestrator.generateAnswer({
      sessionId,
      turnId,
      userMessage: 'SUNREKA G7000iS starts by cord or button?'
    });

    expect(fakeProducts.savedVerifiedFacts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        productId: 'g7000is',
        productName: 'SUNREKA G7000iS',
        attribute: 'button start',
        value: 'has START button start',
        sourceType: 'web',
        sourceUrl: 'https://sunreka.example/g7000is',
        sourceTitle: 'SUNREKA G7000iS specification',
        evidence: 'official source says the model starts by START button',
        confidence: 'high'
      }),
      expect.objectContaining({
        productId: 'g7000is',
        productName: 'SUNREKA G7000iS',
        attribute: 'recoil start',
        value: 'manual recoil starter is also available'
      })
    ]));
    expect(fakeProducts.mirroredWebFacts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        productId: 'g7000is',
        attribute: 'button start',
        value: 'has START button start',
        sourceUrl: 'https://sunreka.example/g7000is',
        confidence: 0.9
      })
    ]));
  });

  it('uses reusable exact web facts before spending another web research call', async () => {
    researchProductComparisonFacts.mockClear();
    const now = new Date('2026-05-19T12:00:00.000Z').toISOString();
    class MemoryProducts extends FakeProducts {
      constructor() {
        super();
        this.verifiedFacts = [
          {
            id: 'fact-button',
            productId: 'g7000is',
            productKey: 'sunreka g7000is',
            productName: 'SUNREKA G7000iS',
            attribute: 'button start',
            value: 'has START button start',
            sourceType: 'web',
            sourceUrl: 'https://sunreka.example/g7000is',
            sourceTitle: 'SUNREKA G7000iS specification',
            evidence: 'official source says the model starts by START button',
            confidence: 'high',
            status: 'active',
            firstSeenAt: now,
            lastVerifiedAt: now,
            hitCount: 0,
            createdAt: now,
            updatedAt: now
          },
          {
            id: 'fact-recoil',
            productId: 'g7000is',
            productKey: 'sunreka g7000is',
            productName: 'SUNREKA G7000iS',
            attribute: 'recoil start',
            value: 'manual recoil starter is also available',
            sourceType: 'web',
            sourceUrl: 'https://sunreka.example/g7000is',
            sourceTitle: 'SUNREKA G7000iS specification',
            evidence: 'official source lists manual starter',
            confidence: 'high',
            status: 'active',
            firstSeenAt: now,
            lastVerifiedAt: now,
            hitCount: 0,
            createdAt: now,
            updatedAt: now
          }
        ];
      }
      async searchProducts() {
        return [
          product('g7000is', 'SUNREKA G7000iS generator 6 kW', { starter: 'manual starter' })
        ];
      }
    }

    const fakeProducts = new MemoryProducts();
    const memoryModel: AgentManagerModel = {
      ...model(),
      async planTurn() {
        return {
          userMessageSummary: 'buyer asks if G7000iS starts by button or cord',
          dialogueUnderstanding: 'exact technical fact for a named model',
          nextStepRationale: 'use verified fact memory before external search',
          requiresTools: true,
          toolRequests: [{
            id: 'web:g7000is',
            tool: 'web.researchProductFacts',
            args: {
              query: 'SUNREKA G7000iS button start recoil start',
              semanticQuery: 'SUNREKA G7000iS START button and recoil starter',
              productNames: ['SUNREKA G7000iS'],
              comparisonAttributes: ['button start', 'recoil start']
            },
            rationale: 'exact model fact must be grounded',
            required: true
          }],
          mustNotAskQuestionIds: [],
          riskFlags: []
        };
      },
      async composeAnswer(input) {
        const memoryResult = input.toolResults.find((result) => result.requestId === 'web:g7000is');
        expect((memoryResult?.payload as { answerGuidance?: { directAnswer?: string } }).answerGuidance?.directAnswer)
          .toBe('');
        expect(input.requiredResponseClauses?.map((clause) => clause.code))
          .toContain('answer_verified_fact_memory_naturally');
        expect(input.toolResults).toEqual(expect.arrayContaining([
          expect.objectContaining({
            requestId: 'web:g7000is',
            status: 'ok',
            warnings: expect.arrayContaining(['verified_product_fact_memory_used'])
          })
        ]));
        return {
          answerText: 'Starts by START button; manual recoil start is also available.',
          factsUsed: [],
          questionsAsked: [],
          toolResultIds: ['web:g7000is'],
          leadAction: 'none',
          riskFlags: []
        };
      }
    };

    const conversations = new FakeConversations();
    conversations.messages = [message('SUNREKA G7000iS starts by cord or button?')];
    const orchestrator = new AgentManagerOrchestrator(conversations as never, fakeProducts as never, {} as never, memoryModel);

    await orchestrator.generateAnswer({
      sessionId,
      turnId,
      userMessage: 'SUNREKA G7000iS starts by cord or button?'
    });

    expect(researchProductComparisonFacts).not.toHaveBeenCalled();
    expect(fakeProducts.usedVerifiedFactIds).toEqual(expect.arrayContaining(['fact-button', 'fact-recoil']));
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
          productMentions: [{
            name: 'FIRMAN RD3910E',
            role: 'target_product',
            productClass: 'generator',
            evidence: 'buyer asks about this exact current model'
          }],
          mustNotAskQuestionIds: [],
          riskFlags: ['answer_policy_catalog_presence_relevant']
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
      targetProductNames: ['FIRMAN RD3910E']
    }));
    expect(payload.answer).toContain('Запуск с ключа/через выключатель точно подтвердить не могу');
    expect(payload.answer).toContain('кнопка по точным источникам не подтверждена');
    expect(payload.answer).not.toContain('Кнопочный запуск в данных не вижу');
    expect(payload.answer).not.toContain('тоже запускается с ключа');
    expect(payload.answer).toContain('У нас эта модель есть в каталоге.');
    expect(payload.answer).not.toContain('В каталоге БАКАУТ');
    expect(payload.answer).not.toContain('По деталям запуска');
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
