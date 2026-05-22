import { describe, expect, it, vi } from 'vitest';
import { AgentManagerOrchestrator, type AgentManagerModel } from '../src/ai/agentManagerOrchestrator.js';
import { emptyNeedState } from '../src/ai/needState.js';
import type { ConversationSession, ConversationTurn, Message, Product } from '../src/shared/types.js';

const sessionId = '11111111-1111-4111-8111-111111111111';
const turnId = '22222222-2222-4222-8222-222222222222';
const userMessageId = '33333333-3333-4333-8333-333333333333';

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
  async getSession() { return session(); }
  async listMessages() { return this.messages; }
  async getTurn() { return this.turn; }
  async updateTurn(input: Partial<ConversationTurn> & { userMessageId?: string | null; assistantMessageId?: string | null }) {
    this.turn = { ...this.turn, ...input, id: this.turn.id, sessionId: this.turn.sessionId } as ConversationTurn;
    return this.turn;
  }
  async upsertTurnCheckpoint(input: unknown) { this.checkpoints.push(input); return input; }
  async listDialogueLedgerEvents() { return this.ledgerEvents; }
  async upsertDialogueLedgerEvent(input: unknown) { this.ledgerEvents.push(input); return input; }
  async saveToolArtifact(input: unknown) { this.toolArtifacts.push(input); return input; }
  async saveAnswerContract(input: unknown) { this.answerContracts.push(input); return input; }
  async getFinalAnswerContract() { return this.finalAnswerContract; }
  async enqueueLeadOutbox(input: unknown) { this.outbox.push(input); return input; }
  async addAgentTrace(input: unknown) { this.traces.push(input); return input; }
  async addAssistantMessageForTurn(input: { content: string; metadata?: Record<string, unknown>; recovered?: boolean }) {
    this.assistantSaves.push(input);
    const saved = message(input.content, 'assistant');
    saved.metadata = input.metadata ?? {};
    this.messages.push(saved);
    this.turn = { ...this.turn, assistantMessageId: saved.id, status: input.recovered ? 'recovered' : 'completed' };
    return saved;
  }
}

class FakeProducts {
  async searchProducts() {
    return [product('p1', 'Generator 5 kW'), product('p2', 'Generator 6 kW')];
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

class FakeLeads {
  created: unknown[] = [];
  async createLead(input: unknown) {
    this.created.push(input);
    return { id: 'lead-id', sessionId, name: 'Alexey', phone: '+7 900 000-00-11', status: 'pending_email', createdAt: new Date().toISOString() };
  }
}

function model(overrides: Partial<AgentManagerModel> = {}): AgentManagerModel {
  return {
    async proposeLedgerDelta() {
      return {
        rationale: 'buyer provided a coffee machine load',
        events: [{
          eventType: 'question.answered',
          scope: 'question',
          payload: { questionId: 'q.coffee_power', answer: '3.2 kW' },
          evidence: 'Coffee machine 3.2 kW',
          source: 'llm_state_delta',
          status: 'closed'
        }, {
          eventType: 'fact.confirmed',
          scope: 'dialogue',
          payload: { factKey: 'load.coffee_machine_kw', value: 3.2 },
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
}

describe('AgentManagerOrchestrator', () => {
  it('uses ledger state for the turn and returns a ledger-derived needState snapshot', async () => {
    const conversations = new FakeConversations();
    const orchestrator = new AgentManagerOrchestrator(conversations as never, new FakeProducts() as never, new FakeLeads() as never, model());

    const payload = await orchestrator.generateAnswer({
      sessionId,
      turnId,
      userMessage: 'Coffee machine 3.2 kW, grinder 400 W, is 5 kW enough?'
    });

    expect(payload.metadata?.agentManager).toBe(true);
    expect(conversations.ledgerEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({ eventType: 'question.answered' }),
      expect.objectContaining({ eventType: 'fact.confirmed' })
    ]));
    expect(conversations.assistantSaves).toHaveLength(1);
    expect(payload.needState.activeNeeds[0]).toMatchObject({ id: 'ledger-current', productClass: 'generator' });
    expect(payload.needState.activeNeeds[0]?.openQuestions).not.toContain('What is the coffee machine power?');
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
      toolResults?: Array<{ tool?: string; payload?: { summaryForAnswer?: string } }>;
      cardSelection?: { warnings?: string[]; droppedProductIds?: string[] };
    };
    expect(metadata.toolResults?.[0]).toMatchObject({
      tool: 'web.researchProductFacts',
      payload: { summaryForAnswer: 'Недостаточно товаров для сравнения.' }
    });
    expect(payload.productCards).toEqual([]);
    expect(metadata.cardSelection?.droppedProductIds).toEqual(['bison-inverter']);
    expect(metadata.cardSelection?.warnings).toContain('product_cards_suppressed:no_explicit_catalog_card_tool');
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
      async composeAnswer() {
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
    expect(metadata.toolResults?.[1]?.status).toBe('denied');
    expect(metadata.toolResults?.[1]?.warnings).toContain('catalog_search_skipped:generator_load_unconfirmed_basis');
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
    expect(metadata.toolResults?.[1]?.status).toBe('denied');
    expect(metadata.toolResults?.[1]?.warnings).toContain('catalog_search_skipped:generator_load_unconfirmed_basis');
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
    expect(metadata.toolResults?.[1]?.status).toBe('denied');
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
          mustNotAskQuestionIds: [],
          riskFlags: ['bounded_load_assumption', 'exact_pump_power_missing']
        };
      },
      async composeAnswer(input) {
        const profile = (input.toolResults[0]?.payload as { profile?: { requiredNominalKw?: number } })?.profile;
        return {
          answerText: `Preliminary calculation is about ${profile?.requiredNominalKw} kW. Generator 5 kW is the minimum orientation, Generator 6 kW is the safer reserve option. Exact pump nameplate is still needed before purchase.`,
          factsUsed: [],
          questionsAsked: [],
          toolResultIds: ['generator-load', 'catalog-search'],
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
    const orchestrator = new AgentManagerOrchestrator(conversations as never, new FakeProducts() as never, new FakeLeads() as never, boundedEstimateModel);

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
                { kind: 'refrigerator', name: 'refrigerator', count: 1, runningKw: 0.25, startingKw: 1.2, source: 'estimated_average', evidence: 'one refrigerator' }
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
          mustNotAskQuestionIds: [],
          riskFlags: ['power_requirements_uncertain']
        };
      },
      async composeAnswer() {
        return {
          answerText: 'After the load calculation, Generator 5 kW and Generator 6 kW are reasonable preliminary options.',
          factsUsed: [],
          questionsAsked: [],
          toolResultIds: ['generator-load', 'catalog-search'],
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
    const orchestrator = new AgentManagerOrchestrator(conversations as never, new FakeProducts() as never, new FakeLeads() as never, readyModel);

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
    expect(metadata.toolResults?.[1]?.status).toBe('not_found');
    expect(metadata.toolResults?.[1]?.payload?.productIds).toEqual([]);
    expect(metadata.toolResults?.[1]?.payload?.generatorLoadFit?.requiredNominalKw).toBe(7);
    expect(metadata.toolResults?.[1]?.payload?.generatorLoadFit?.droppedProductIds).toEqual(
      expect.arrayContaining(['weak-2kw', 'weak-34kw'])
    );
    expect(metadata.toolResults?.[1]?.warnings).toEqual(expect.arrayContaining([
      'catalog_products_filtered_by_generator_load:2',
      'catalog_search_no_generator_load_fit',
      'catalog_search_no_matches'
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
    conversations.messages = [message('Alexey, +7 900 000-00-11')];
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

  it('recovers from the saved user message without adding a duplicate user message', async () => {
    const conversations = new FakeConversations();
    const orchestrator = new AgentManagerOrchestrator(conversations as never, new FakeProducts() as never, new FakeLeads() as never, model());

    const payload = await orchestrator.recoverTurn({ sessionId, turnId });

    expect(payload.metadata?.recovered).toBe(true);
    expect(conversations.addMessage).not.toHaveBeenCalled();
    expect(conversations.assistantSaves[0]).toMatchObject({ recovered: true });
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

  it('normalizes answer fact source aliases to the single executed tool result id', async () => {
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

    const payload = await orchestrator.generateAnswer({
      sessionId,
      turnId,
      userMessage: 'Show me catalog generators around 5 kW.'
    });

    expect(payload.metadata?.answerContract).toMatchObject({
      factsUsed: [{
        factKey: 'catalog_found_generators',
        sourceEventIds: ['catalog-search'],
        value: true
      }]
    });
    expect(conversations.assistantSaves).toHaveLength(1);
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

    expect(payload.answer).toContain('Оставьте имя и телефон');
    expect(payload.answer).not.toContain('Contact received');
    expect(payload.leadRequested).toBe(true);
    expect(payload.leadCreated).toBe(false);
    expect(leads.created).toHaveLength(0);
    expect(conversations.assistantSaves).toHaveLength(1);
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
});
