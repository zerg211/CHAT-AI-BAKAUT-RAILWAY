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

function product(id: string, name: string): Product {
  return {
    id,
    name,
    brand: 'TEST',
    category: 'Generators',
    price: 1000,
    currency: 'RUB',
    sourceUrl: `https://example.test/${id}`,
    specs: { power: '5 kW' }
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
