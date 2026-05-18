import { beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyNeedState, mergeProductSelectionState } from '../src/ai/needState.js';
import type { AgentTurnContract, ConversationSession, ConversationTurn, Lead, Message, MessageRole, Product } from '../src/shared/types.js';

const openAiCreate = vi.hoisted(() => vi.fn(async () => {
  throw new Error('unsupported_country_region_territory');
}));

vi.mock('../src/ai/openaiClient.js', () => ({
  createOpenAIClient: () => ({ responses: { create: openAiCreate } }),
  createEmbedding: async () => null,
  withRetry: async <T>(fn: () => Promise<T>) => fn()
}));

vi.mock('../src/email/httpEmail.js', () => ({
  sendLeadEmail: vi.fn(async () => ({ ok: true }))
}));

const { AssistantService, assistantTestHooks } = await import('../src/ai/assistant.js');

const ru = (value: string) => JSON.parse(`"${value}"`) as string;

function testProduct(id: string, name: string, price: number, specs: Record<string, unknown> = {}): Product {
  return {
    id,
    name,
    category: ru('\\u0413\\u0435\\u043d\\u0435\\u0440\\u0430\\u0442\\u043e\\u0440\\u044b'),
    price,
    currency: 'RUB',
    sourceUrl: `https://example.test/${id}`,
    specs
  };
}

class FakeConversations {
  readonly messages: Message[] = [];
  turn: ConversationTurn | null = null;
  session: ConversationSession = {
    id: '11111111-1111-4111-8111-111111111111',
    status: 'active',
    conversationNumber: 1,
    title: '',
    needState: emptyNeedState(),
    historySummary: '',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lastHeartbeatAt: new Date().toISOString()
  };

  async getSession() {
    return this.session;
  }

  async addMessage(input: { sessionId: string; role: MessageRole; content: string; metadata?: Record<string, unknown> }) {
    const message: Message = {
      id: `msg-${this.messages.length + 1}`,
      sessionId: input.sessionId,
      role: input.role,
      content: input.content,
      metadata: input.metadata ?? {},
      createdAt: new Date(Date.now() + this.messages.length).toISOString()
    };
    this.messages.push(message);
    return message;
  }

  async listMessages() {
    return this.messages;
  }

  async getTurn() {
    return this.turn;
  }

  async updateTurn(input: Partial<ConversationTurn> & { turnId?: string }) {
    if (!this.turn) return null;
    this.turn = {
      ...this.turn,
      ...input,
      id: this.turn.id,
      sessionId: this.turn.sessionId,
      updatedAt: new Date().toISOString()
    } as ConversationTurn;
    return this.turn;
  }

  async updateNeedState(_sessionId: string, needState: ConversationSession['needState']) {
    this.session = { ...this.session, needState };
    return this.session;
  }

  async updateSessionTopic() {
    return this.session;
  }
}

class FakeProducts {
  constructor(private readonly products: Product[]) {}

  async searchProducts() {
    return this.products;
  }

  async searchProductsByModelTokens() {
    return [];
  }

  async vectorSearch() {
    return [];
  }

  async listProducts() {
    return this.products;
  }

  async searchCatalogPages() {
    return [];
  }

  async getOpenConflictsForProducts() {
    return [];
  }
}

class FakeLeads {
  readonly leads: Lead[] = [];

  async createLead(input: { sessionId?: string | null; name: string; phone?: string | null; email?: string | null; question?: string | null }) {
    const lead: Lead = {
      id: `lead-${this.leads.length + 1}`,
      sessionId: input.sessionId,
      name: input.name,
      phone: input.phone ?? null,
      email: input.email ?? null,
      question: input.question ?? null,
      status: 'pending_email',
      createdAt: new Date().toISOString()
    };
    this.leads.push(lead);
    return lead;
  }

  async markEmailResult(id: string, status: Lead['status']) {
    const lead = this.leads.find((item) => item.id === id);
    if (!lead) throw new Error('lead not found');
    lead.status = status;
    return lead;
  }
}

describe('assistant OpenAI failure fallback', () => {
  beforeEach(() => {
    openAiCreate.mockReset();
    openAiCreate.mockImplementation(async () => {
      throw new Error('unsupported_country_region_territory');
    });
  });

  it('uses a fast policy handoff for operational delivery and stock questions', async () => {
    openAiCreate.mockClear();
    const products = [
      testProduct('plate-1', ru('\\u0412\\u0438\\u0431\\u0440\\u043e\\u043f\\u043b\\u0438\\u0442\\u0430 \\u043f\\u0440\\u044f\\u043c\\u043e\\u0445\\u043e\\u0434\\u043d\\u0430\\u044f 60 \\u043a\\u0433'), 72_000)
    ];
    const conversations = new FakeConversations();
    conversations.messages.push({
      id: 'previous-assistant',
      sessionId: conversations.session.id,
      role: 'assistant',
      content: ru('\\u041f\\u043e\\u043a\\u0430\\u0437\\u0430\\u043b \\u043f\\u043e\\u0434\\u0445\\u043e\\u0434\\u044f\\u0449\\u0443\\u044e \\u0432\\u0438\\u0431\\u0440\\u043e\\u043f\\u043b\\u0438\\u0442\\u0443.'),
      metadata: {
        productCards: [{
          id: 'plate-1',
          name: products[0].name,
          category: products[0].category,
          price: products[0].price,
          currency: 'RUB',
          sourceUrl: products[0].sourceUrl,
          specs: {},
          reasons: [ru('\\u041f\\u043e\\u0434\\u0445\\u043e\\u0434\\u0438\\u0442 \\u043f\\u043e \\u0442\\u0435\\u043a\\u0443\\u0449\\u0435\\u0439 \\u0437\\u0430\\u0434\\u0430\\u0447\\u0435')],
          caveats: []
        }]
      },
      createdAt: new Date().toISOString()
    });
    const assistant = new AssistantService(conversations as never, new FakeProducts(products) as never);

    const result = await assistant.generateAnswer({
      sessionId: conversations.session.id,
      userMessage: ru('\\u0410 \\u0441\\u043a\\u043e\\u043b\\u044c\\u043a\\u043e \\u0434\\u043e\\u0441\\u0442\\u0430\\u0432\\u043a\\u0430 \\u0438 \\u0435\\u0441\\u0442\\u044c \\u043b\\u0438 \\u0442\\u043e\\u0447\\u043d\\u043e \\u0432 \\u043d\\u0430\\u043b\\u0438\\u0447\\u0438\\u0438? \\u041c\\u043e\\u0433\\u0443 \\u043e\\u0441\\u0442\\u0430\\u0432\\u0438\\u0442\\u044c \\u0442\\u0435\\u043b\\u0435\\u0444\\u043e\\u043d.'),
      onDelta: vi.fn()
    });

    expect(openAiCreate).not.toHaveBeenCalled();
    expect(result.answer.toLowerCase()).toContain(ru('\\u0434\\u043e\\u0441\\u0442\\u0430\\u0432'));
    expect(result.answer.toLowerCase()).toContain(ru('\\u043d\\u0430\\u043b\\u0438\\u0447'));
    expect(result.leadRequested).toBe(true);
    expect(result.metadata?.answerMode).toBe('fast_commercial_handoff');
    expect(result.metadata?.leadStateMachine).toMatchObject({
      state: 'required_contact_missing',
      nextAction: 'ask_for_missing_contact'
    });
    expect(result.metadata?.policyGate?.answerConstraints).toEqual(expect.arrayContaining([
      'do_not_promise_live_stock_delivery_discount_or_exact_terms'
    ]));
    expect(conversations.messages.filter((message) => message.role === 'assistant')).toHaveLength(2);
  });

  it('does not ask for contact again when the fast commercial handoff already created a lead from chat text', async () => {
    openAiCreate.mockClear();
    const products = [
      testProduct('plate-1', ru('\\u0412\\u0438\\u0431\\u0440\\u043e\\u043f\\u043b\\u0438\\u0442\\u0430 \\u043f\\u0440\\u044f\\u043c\\u043e\\u0445\\u043e\\u0434\\u043d\\u0430\\u044f 70 \\u043a\\u0433'), 38_766)
    ];
    const conversations = new FakeConversations();
    conversations.messages.push({
      id: 'previous-assistant',
      sessionId: conversations.session.id,
      role: 'assistant',
      content: ru('\\u041f\\u043e\\u043a\\u0430\\u0437\\u0430\\u043b \\u0432\\u0438\\u0431\\u0440\\u043e\\u043f\\u043b\\u0438\\u0442\\u0443 \\u043f\\u043e\\u0434 \\u0432\\u044a\\u0435\\u0437\\u0434.'),
      metadata: {
        productCards: [{
          id: 'plate-1',
          name: products[0].name,
          category: products[0].category,
          price: products[0].price,
          currency: 'RUB',
          sourceUrl: products[0].sourceUrl,
          specs: {},
          reasons: [ru('\\u041f\\u043e\\u0434\\u0445\\u043e\\u0434\\u0438\\u0442 \\u043f\\u043e \\u0442\\u0435\\u043a\\u0443\\u0449\\u0435\\u0439 \\u0437\\u0430\\u0434\\u0430\\u0447\\u0435')],
          caveats: []
        }]
      },
      createdAt: new Date().toISOString()
    });
    const leads = new FakeLeads();
    const assistant = new AssistantService(conversations as never, new FakeProducts(products) as never, leads as never);

    const result = await assistant.generateAnswer({
      sessionId: conversations.session.id,
      userMessage: ru('\\u0414\\u0430, \\u0434\\u0430\\u0432\\u0430\\u0439\\u0442\\u0435 \\u043f\\u0440\\u043e\\u0432\\u0435\\u0440\\u0438\\u043c \\u043d\\u0430\\u043b\\u0438\\u0447\\u0438\\u0435 \\u0438 \\u0434\\u043e\\u0441\\u0442\\u0430\\u0432\\u043a\\u0443. \\u041c\\u0435\\u043d\\u044f \\u0437\\u043e\\u0432\\u0443\\u0442 \\u0410\\u043b\\u0435\\u043a\\u0441\\u0435\\u0439, \\u0442\\u0435\\u043b\\u0435\\u0444\\u043e\\u043d +7 900 000-00-11.'),
      onDelta: vi.fn()
    });

    expect(openAiCreate).not.toHaveBeenCalled();
    expect(leads.leads).toHaveLength(1);
    expect(result.leadCreated).toBe(true);
    expect(result.leadRequested).toBe(false);
    expect(result.answer).toContain(ru('\\u041a\\u043e\\u043d\\u0442\\u0430\\u043a\\u0442 \\u043f\\u0440\\u0438\\u043d\\u044f\\u043b'));
    expect(result.answer).not.toContain(ru('\\u043e\\u0441\\u0442\\u0430\\u0432\\u044c\\u0442\\u0435 \\u0438\\u043c\\u044f \\u0438 \\u0442\\u0435\\u043b\\u0435\\u0444\\u043e\\u043d'));
    expect(result.metadata?.leadStateMachine).toMatchObject({
      state: 'created',
      nextAction: 'confirm_created_lead',
      hasContactInTurn: true
    });
  });

  it('does not mask OpenAI failures as a normal catalog recommendation', async () => {
    openAiCreate.mockClear();
    const products = [
      testProduct('fit-1', ru('\\u0413\\u0435\\u043d\\u0435\\u0440\\u0430\\u0442\\u043e\\u0440 \\u0431\\u0435\\u043d\\u0437\\u0438\\u043d\\u043e\\u0432\\u044b\\u0439 3.0 kW \\u044d\\u043b\\u0435\\u043a\\u0442\\u0440\\u043e\\u0441\\u0442\\u0430\\u0440\\u0442'), 54_000, {
        [ru('\\u041d\\u043e\\u043c\\u0438\\u043d\\u0430\\u043b\\u044c\\u043d\\u0430\\u044f \\u043c\\u043e\\u0449\\u043d\\u043e\\u0441\\u0442\\u044c')]: '3.0 kW',
        [ru('\\u041c\\u0430\\u043a\\u0441\\u0438\\u043c\\u0430\\u043b\\u044c\\u043d\\u0430\\u044f \\u043c\\u043e\\u0449\\u043d\\u043e\\u0441\\u0442\\u044c')]: '3.3 kW',
        start: 'electric starter'
      }),
      testProduct('fit-2', ru('\\u0413\\u0435\\u043d\\u0435\\u0440\\u0430\\u0442\\u043e\\u0440 \\u0431\\u0435\\u043d\\u0437\\u0438\\u043d\\u043e\\u0432\\u044b\\u0439 3.2 kW \\u044d\\u043b\\u0435\\u043a\\u0442\\u0440\\u043e\\u0441\\u0442\\u0430\\u0440\\u0442'), 61_000, {
        [ru('\\u041d\\u043e\\u043c\\u0438\\u043d\\u0430\\u043b\\u044c\\u043d\\u0430\\u044f \\u043c\\u043e\\u0449\\u043d\\u043e\\u0441\\u0442\\u044c')]: '3.2 kW',
        [ru('\\u041c\\u0430\\u043a\\u0441\\u0438\\u043c\\u0430\\u043b\\u044c\\u043d\\u0430\\u044f \\u043c\\u043e\\u0449\\u043d\\u043e\\u0441\\u0442\\u044c')]: '3.6 kW',
        start: 'electric starter'
      })
    ];
    const conversations = new FakeConversations();
    const assistant = new AssistantService(conversations as never, new FakeProducts(products) as never);

    await expect(assistant.generateAnswer({
      sessionId: conversations.session.id,
      userMessage: ru('\\u041d\\u0443\\u0436\\u0435\\u043d \\u0431\\u0435\\u043d\\u0437\\u0438\\u043d\\u043e\\u0432\\u044b\\u0439 \\u0433\\u0435\\u043d\\u0435\\u0440\\u0430\\u0442\\u043e\\u0440 \\u0434\\u043b\\u044f \\u0434\\u043e\\u043c\\u0430 220 \\u0412. \\u041a\\u043e\\u0442\\u0435\\u043b 150 \\u0412\\u0442, \\u0445\\u043e\\u043b\\u043e\\u0434\\u0438\\u043b\\u044c\\u043d\\u0438\\u043a \\u0438 \\u0441\\u0432\\u0435\\u0442 300 \\u0412\\u0442. \\u041d\\u0443\\u0436\\u0435\\u043d \\u0437\\u0430\\u043f\\u0443\\u0441\\u043a \\u043a\\u043d\\u043e\\u043f\\u043a\\u043e\\u0439, \\u0447\\u0442\\u043e\\u0431\\u044b \\u0436\\u0435\\u043d\\u0430 \\u0441\\u0430\\u043c\\u0430 \\u0437\\u0430\\u043f\\u0443\\u0441\\u043a\\u0430\\u043b\\u0430, \\u0438 \\u043d\\u0435 \\u0448\\u0443\\u043c\\u043d\\u044b\\u0439.'),
      onDelta: vi.fn()
    })).rejects.toThrow(/AI need extraction failed/);

    expect(conversations.messages.filter((message) => message.role === 'assistant')).toHaveLength(0);
  });

  it('repairs recovered answers before saving when they violate post-answer lead policy', async () => {
    const conversations = new FakeConversations();
    const userMessage: Message = {
      id: 'user-1',
      sessionId: conversations.session.id,
      role: 'user',
      content: ru('\\u041d\\u0435\\u0442, \\u0437\\u0432\\u043e\\u043d\\u0438\\u0442\\u044c \\u043d\\u0435 \\u043d\\u0430\\u0434\\u043e, \\u043f\\u0440\\u043e\\u0441\\u0442\\u043e \\u043f\\u043e\\u043a\\u0430\\u0436\\u0438\\u0442\\u0435 \\u0432\\u0430\\u0440\\u0438\\u0430\\u043d\\u0442\\u044b.'),
      metadata: {},
      createdAt: new Date().toISOString()
    };
    conversations.messages.push(userMessage);
    const contract: AgentTurnContract = {
      answerTask: 'product_selection',
      taskType: 'product_selection',
      catalogAction: 'find_matching_products',
      commercialAction: 'none',
      productCardsPolicy: 'show_matching_products',
      mustAnswerNow: ['continue product selection without contact collection'],
      activeNeeds: [],
      currentFocus: 'generator',
      cardsRole: 'primary',
      leadAllowed: false,
      leadAllowedReason: 'buyer refused a call',
      errorRecoveryPriority: 'Continue selection and do not ask for contact.',
      validatorWarnings: []
    };
    conversations.turn = {
      id: '22222222-2222-4222-8222-222222222222',
      sessionId: conversations.session.id,
      userMessageId: userMessage.id,
      assistantMessageId: null,
      status: 'failed',
      requestHash: 'hash',
      stage: 'failed',
      errorCode: 'answer_generation_failed',
      errorMessage: 'empty answer',
      plannerContract: contract,
      activeNeedsBefore: null,
      activeNeedsAfter: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    (openAiCreate as unknown as { mockResolvedValueOnce: (value: unknown) => void }).mockResolvedValueOnce({
      output_text: [
        ru('\\u041f\\u0440\\u043e\\u0434\\u043e\\u043b\\u0436\\u0443 \\u043f\\u043e\\u0434\\u0431\\u043e\\u0440 \\u043f\\u043e \\u043a\\u0430\\u0440\\u0442\\u043e\\u0447\\u043a\\u0430\\u043c.'),
        ru('\\u041e\\u0441\\u0442\\u0430\\u0432\\u044c\\u0442\\u0435 \\u0442\\u0435\\u043b\\u0435\\u0444\\u043e\\u043d \\u0438 \\u0438\\u043c\\u044f, \\u044f \\u043f\\u0435\\u0440\\u0435\\u0434\\u0430\\u043c \\u0437\\u0430\\u044f\\u0432\\u043a\\u0443.')
      ].join(' ')
    });
    const deltas: string[] = [];
    const assistant = new AssistantService(conversations as never, new FakeProducts([]) as never);

    const result = await assistant.recoverTurn({
      sessionId: conversations.session.id,
      turnId: conversations.turn.id,
      onDelta: (delta) => {
        deltas.push(delta);
      }
    });

    expect(result.answer).toContain(ru('\\u041f\\u0440\\u043e\\u0434\\u043e\\u043b\\u0436\\u0443 \\u043f\\u043e\\u0434\\u0431\\u043e\\u0440'));
    expect(result.answer).not.toContain(ru('\\u0442\\u0435\\u043b\\u0435\\u0444\\u043e\\u043d'));
    expect(deltas).toEqual([result.answer]);
    expect(conversations.messages.filter((message) => message.role === 'assistant')).toHaveLength(1);
    expect(result.metadata?.postAnswerVerification?.status).not.toBe('error');
    expect(result.metadata?.postAnswerVerification?.issues ?? []).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'lead_contact_ask_forbidden' })
    ]));
    expect(result.metadata?.postAnswerVerificationRecovery).toMatchObject({
      attempted: false,
      method: 'none'
    });
  });

  it('uses deterministic commercial recovery even when a stored commercial contract exists', async () => {
    const conversations = new FakeConversations();
    const plate = testProduct('plate-1', ru('\\u0412\\u0438\\u0431\\u0440\\u043e\\u043f\\u043b\\u0438\\u0442\\u0430 REDVERG RD-29155'), 54_000);
    conversations.messages.push({
      id: 'assistant-cards',
      sessionId: conversations.session.id,
      role: 'assistant',
      content: ru('\\u041f\\u043e\\u043a\\u0430\\u0437\\u0430\\u043b \\u0432\\u0438\\u0431\\u0440\\u043e\\u043f\\u043b\\u0438\\u0442\\u044b.'),
      metadata: {
        productCards: [{
          id: plate.id,
          name: plate.name,
          category: plate.category,
          price: plate.price,
          currency: 'RUB',
          sourceUrl: plate.sourceUrl,
          specs: {},
          reasons: [ru('\\u041f\\u043e\\u0434\\u0445\\u043e\\u0434\\u0438\\u0442 \\u043f\\u043e \\u0432\\u0435\\u0441\\u0443')],
          caveats: []
        }]
      },
      createdAt: new Date().toISOString()
    });
    const userMessage: Message = {
      id: 'user-commercial',
      sessionId: conversations.session.id,
      role: 'user',
      content: ru('\\u041f\\u043e \\u0434\\u043e\\u0441\\u0442\\u0430\\u0432\\u043a\\u0435 \\u0438 \\u0441\\u043a\\u0438\\u0434\\u043a\\u0435 \\u043f\\u043e\\u043a\\u0430 \\u0431\\u0435\\u0437 \\u0437\\u0432\\u043e\\u043d\\u043a\\u0430: \\u0447\\u0442\\u043e \\u043c\\u043e\\u0436\\u043d\\u043e \\u043f\\u043e\\u043d\\u044f\\u0442\\u044c \\u0441\\u0435\\u0439\\u0447\\u0430\\u0441?'),
      metadata: {},
      createdAt: new Date().toISOString()
    };
    conversations.messages.push(userMessage);
    const contract: AgentTurnContract = {
      answerTask: 'lead_handoff',
      taskType: 'pure_delivery',
      catalogAction: 'none',
      commercialAction: 'explain_manager_required',
      productCardsPolicy: 'none',
      mustAnswerNow: ['answer delivery and discount boundaries without contact pressure'],
      activeNeeds: [],
      currentFocus: 'commercial',
      cardsRole: 'none',
      leadAllowed: false,
      leadAllowedReason: 'buyer asked without a call',
      errorRecoveryPriority: 'Answer safely without exact delivery, discount, stock, or contact request.',
      validatorWarnings: []
    };
    conversations.turn = {
      id: '33333333-3333-4333-8333-333333333333',
      sessionId: conversations.session.id,
      userMessageId: userMessage.id,
      assistantMessageId: null,
      status: 'failed',
      requestHash: 'hash',
      stage: 'recovery_failed',
      errorCode: 'recovery_failed',
      errorMessage: 'delivery claim without verification',
      plannerContract: contract,
      activeNeedsBefore: null,
      activeNeedsAfter: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    openAiCreate.mockClear();
    const assistant = new AssistantService(conversations as never, new FakeProducts([plate]) as never);

    const result = await assistant.recoverTurn({
      sessionId: conversations.session.id,
      turnId: conversations.turn.id
    });

    expect(openAiCreate).not.toHaveBeenCalled();
    expect(result.answer.toLowerCase()).toContain(ru('\\u0434\\u043e\\u0441\\u0442\\u0430\\u0432'));
    expect(result.answer).toMatch(new RegExp(`${ru('\\u0441\\u043a\\u0438\\u0434')}|${ru('\\u043a\\u043e\\u043c\\u043c\\u0435\\u0440\\u0447')}`, 'iu'));
    expect(result.answer).not.toMatch(new RegExp(`${ru('\\u0442\\u0435\\u043b\\u0435\\u0444\\u043e\\u043d')}|${ru('\\u043d\\u043e\\u043c\\u0435\\u0440')}`, 'iu'));
    expect(result.metadata?.postAnswerVerification?.status).not.toBe('error');
    expect(conversations.turn?.status).toBe('recovered');
  });

  it('keeps commercial recovery lead-capable when the buyer asks for stock or delivery verification', async () => {
    const conversations = new FakeConversations();
    const plate = testProduct('plate-1', ru('\\u0412\\u0438\\u0431\\u0440\\u043e\\u043f\\u043b\\u0438\\u0442\\u0430 REDVERG RD-29155'), 54_000);
    conversations.messages.push({
      id: 'assistant-cards',
      sessionId: conversations.session.id,
      role: 'assistant',
      content: ru('\\u041f\\u043e\\u043a\\u0430\\u0437\\u0430\\u043b \\u043f\\u043e\\u0434\\u0445\\u043e\\u0434\\u044f\\u0449\\u0443\\u044e \\u0432\\u0438\\u0431\\u0440\\u043e\\u043f\\u043b\\u0438\\u0442\\u0443.'),
      metadata: {
        productCards: [{
          id: plate.id,
          name: plate.name,
          category: plate.category,
          price: plate.price,
          currency: 'RUB',
          sourceUrl: plate.sourceUrl,
          specs: {},
          reasons: [ru('\\u041f\\u043e\\u0434\\u0445\\u043e\\u0434\\u0438\\u0442 \\u043f\\u043e \\u0432\\u0435\\u0441\\u0443')],
          caveats: []
        }]
      },
      createdAt: new Date().toISOString()
    });
    const userMessage: Message = {
      id: 'user-commercial',
      sessionId: conversations.session.id,
      role: 'user',
      content: ru('\\u0414\\u043e\\u0441\\u0442\\u0430\\u0432\\u043a\\u0443 \\u0434\\u043e \\u0410\\u0437\\u043e\\u0432\\u0430 \\u0438 \\u043d\\u0430\\u043b\\u0438\\u0447\\u0438\\u0435 \\u043f\\u043e \\u044d\\u0442\\u043e\\u0439 \\u043f\\u043e\\u0437\\u0438\\u0446\\u0438\\u0438 \\u043c\\u043e\\u0436\\u043d\\u043e \\u0443\\u0442\\u043e\\u0447\\u043d\\u0438\\u0442\\u044c?'),
      metadata: {},
      createdAt: new Date().toISOString()
    };
    conversations.messages.push(userMessage);
    const contract: AgentTurnContract = {
      answerTask: 'lead_handoff',
      taskType: 'pure_delivery',
      catalogAction: 'none',
      commercialAction: 'explain_manager_required',
      productCardsPolicy: 'none',
      mustAnswerNow: ['answer stock and delivery verification boundaries'],
      activeNeeds: [],
      currentFocus: 'commercial',
      cardsRole: 'none',
      leadAllowed: true,
      leadAllowedReason: 'buyer asks for stock and delivery verification',
      errorRecoveryPriority: 'Answer safely and ask for contact if verification is needed.',
      validatorWarnings: []
    };
    conversations.turn = {
      id: '55555555-5555-4555-8555-555555555555',
      sessionId: conversations.session.id,
      userMessageId: userMessage.id,
      assistantMessageId: null,
      status: 'failed',
      requestHash: 'hash',
      stage: 'recovery_failed',
      errorCode: 'recovery_failed',
      errorMessage: 'interrupted commercial answer',
      plannerContract: contract,
      activeNeedsBefore: null,
      activeNeedsAfter: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    openAiCreate.mockClear();
    const assistant = new AssistantService(conversations as never, new FakeProducts([plate]) as never);

    const result = await assistant.recoverTurn({
      sessionId: conversations.session.id,
      turnId: conversations.turn.id
    });

    expect(openAiCreate).not.toHaveBeenCalled();
    expect(result.leadRequested).toBe(true);
    expect(result.metadata?.leadDraft).toMatchObject({ reason: 'delivery' });
    expect(result.metadata?.leadStateMachine).toMatchObject({
      state: 'required_contact_missing',
      nextAction: 'ask_for_missing_contact'
    });
    expect(result.answer).toMatch(new RegExp(`${ru('\\u0438\\u043c\\u044f')}|${ru('\\u0442\\u0435\\u043b\\u0435\\u0444\\u043e\\u043d')}`, 'iu'));
    expect(conversations.turn?.status).toBe('recovered');
  });

  it('recovers product-selection turns with card-backed text instead of a second LLM answer', async () => {
    const conversations = new FakeConversations();
    const dpu130: Product = {
      id: 'dpu130',
      name: 'Vibroplita reversivnaya dizelnaya Wacker Neuson DPU 130 (1185 kg)',
      category: ru('\\u0412\\u0438\\u0431\\u0440\\u043e\\u043f\\u043b\\u0438\\u0442\\u044b'),
      price: 3_500_000,
      currency: 'RUB',
      sourceUrl: 'https://example.test/catalog/vibroplity/dpu-130/',
      specs: { 'rabochaya massa, kg': '1185' }
    };
    const dpu110: Product = {
      id: 'dpu110',
      name: 'Vibroplita reversivnaya dizelnaya Wacker Neuson DPU 110 Lem 970 (830 kg)',
      category: ru('\\u0412\\u0438\\u0431\\u0440\\u043e\\u043f\\u043b\\u0438\\u0442\\u044b'),
      price: 2_800_000,
      currency: 'RUB',
      sourceUrl: 'https://example.test/catalog/vibroplity/dpu-110/',
      specs: { 'rabochaya massa, kg': '830' }
    };
    const light: Product = {
      id: 'light',
      name: 'Vibroplita pryamokhodnaya benzinovaya 95 kg',
      category: ru('\\u0412\\u0438\\u0431\\u0440\\u043e\\u043f\\u043b\\u0438\\u0442\\u044b'),
      price: 90_000,
      currency: 'RUB',
      sourceUrl: 'https://example.test/catalog/vibroplity/light/',
      specs: { 'rabochaya massa, kg': '95' }
    };
    conversations.session = {
      ...conversations.session,
      needState: {
        ...emptyNeedState(),
        activeNeeds: [{
          id: 'need_plate',
          productClass: 'plate',
          summary: 'Need vibroplate about 1000 kg',
          constraints: ['about 1000 kg'],
          openQuestions: [],
          selectedProductIds: [],
          status: 'open',
          updatedAt: new Date().toISOString()
        }],
        selectionState: mergeProductSelectionState(emptyNeedState().selectionState, {
          currentProductClass: 'plate',
          targetProductClass: 'plate',
          matchedProductIds: ['dpu130', 'dpu110'],
          selectedProductIds: [],
          confidence: 0.85,
          hardConstraints: {
            ...emptyNeedState().selectionState.hardConstraints,
            productIntent: 'plate',
            productRole: 'coreProduct',
            weightKgMin: 800,
            weightKgMax: 1200,
            exactModelTokens: [],
            excludedClasses: [],
            provenance: {
              weightKgMin: 'explicit_user',
              weightKgMax: 'explicit_user'
            }
          }
        })
      }
    };
    const userMessage: Message = {
      id: 'user-heavy-plate',
      sessionId: conversations.session.id,
      role: 'user',
      content: 'Need vibroplita about 1000 kg. Any close models?',
      metadata: {},
      createdAt: new Date().toISOString()
    };
    conversations.messages.push(userMessage);
    const contract: AgentTurnContract = {
      answerTask: 'product_selection',
      taskType: 'product_selection_with_availability',
      catalogAction: 'find_matching_products',
      commercialAction: 'explain_manager_required',
      productCardsPolicy: 'show_matching_products',
      mustAnswerNow: ['show nearest heavy vibroplate alternatives'],
      activeNeeds: [{ id: 'need_plate', productClass: 'plate', summary: 'Need vibroplate about 1000 kg' }],
      currentFocus: 'heavy vibroplate',
      cardsRole: 'primary',
      leadAllowed: false,
      leadAllowedReason: 'buyer asked to see options first',
      errorRecoveryPriority: 'Show nearest heavy vibroplate cards without unsupported current-lineup claims.',
      validatorWarnings: []
    };
    conversations.turn = {
      id: '44444444-4444-4444-8444-444444444444',
      sessionId: conversations.session.id,
      userMessageId: userMessage.id,
      assistantMessageId: null,
      status: 'failed',
      requestHash: 'hash',
      stage: 'recovery_failed',
      errorCode: 'recovery_failed',
      errorMessage: 'current_lineup_claim_without_web_policy',
      plannerContract: contract,
      activeNeedsBefore: null,
      activeNeedsAfter: conversations.session.needState.activeNeeds,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    openAiCreate.mockClear();
    const assistant = new AssistantService(conversations as never, new FakeProducts([light, dpu130, dpu110]) as never);

    const result = await assistant.recoverTurn({
      sessionId: conversations.session.id,
      turnId: conversations.turn.id
    });

    expect(openAiCreate).not.toHaveBeenCalled();
    expect(result.answer).toContain('DPU 130');
    expect(result.productCards.map((card) => card.id)).toEqual(expect.arrayContaining(['dpu130', 'dpu110']));
    expect(result.productCards.map((card) => card.id)).not.toContain('light');
    expect(result.answer).not.toContain(ru('\\u0421\\u0435\\u0439\\u0447\\u0430\\u0441 \\u043d\\u0435 \\u0441\\u043c\\u043e\\u0433'));
    expect(result.answer).not.toMatch(new RegExp(`${ru('\\u043b\\u0438\\u043d\\u0435\\u0439\\u043a')}|${ru('\\u043f\\u0440\\u043e\\u0438\\u0437\\u0432\\u043e\\u0434')}`, 'iu'));
    expect(result.metadata?.postAnswerVerification?.status).not.toBe('error');
    expect(conversations.turn?.status).toBe('recovered');
  });

  it('uses the recovery post-answer policy to repair unsafe restored text before streaming', () => {
    const checked = assistantTestHooks.applyPostAnswerVerificationPolicy({
      answer: [
        ru('\\u041f\\u0440\\u043e\\u0434\\u043e\\u043b\\u0436\\u0443 \\u043f\\u043e\\u0434\\u0431\\u043e\\u0440 \\u043f\\u043e \\u043a\\u0430\\u0440\\u0442\\u043e\\u0447\\u043a\\u0430\\u043c.'),
        ru('\\u041e\\u0441\\u0442\\u0430\\u0432\\u044c\\u0442\\u0435 \\u0442\\u0435\\u043b\\u0435\\u0444\\u043e\\u043d \\u0438 \\u0438\\u043c\\u044f, \\u044f \\u043f\\u0435\\u0440\\u0435\\u0434\\u0430\\u043c \\u0437\\u0430\\u044f\\u0432\\u043a\\u0443.')
      ].join(' '),
      factClaimPlanner: {
        version: 1,
        factPolicy: 'catalog_only',
        allowedSources: ['catalog', 'visible_cards', 'conversation_memory'],
        requiredDisclaimers: [],
        forbiddenClaims: ['do_not_invent_product_names_prices_specs'],
        risk: 'low',
        warnings: []
      },
      leadStateMachine: {
        version: 1,
        state: 'not_allowed',
        nextAction: 'do_not_ask_contact',
        leadPolicy: 'forbidden',
        hasContactInTurn: false,
        leadRequested: false,
        leadCreated: false,
        warnings: []
      },
      cardManifest: {
        version: 1,
        source: 'execution_contract',
        cardsPolicy: 'none',
        visibleProductIds: [],
        hiddenProductIds: [],
        items: [],
        warnings: []
      }
    });

    expect(checked.answer).toContain(ru('\\u041f\\u0440\\u043e\\u0434\\u043e\\u043b\\u0436\\u0443 \\u043f\\u043e\\u0434\\u0431\\u043e\\u0440'));
    expect(checked.answer).not.toContain(ru('\\u0442\\u0435\\u043b\\u0435\\u0444\\u043e\\u043d'));
    expect(checked.postAnswerVerification.status).toBe('pass');
    expect(checked.postAnswerVerificationRecovery).toMatchObject({
      attempted: true,
      recovered: true,
      method: 'deterministic_text_repair',
      repairableIssues: ['lead_contact_ask_forbidden']
    });
  });

  it('uses the same post-answer policy to classify unrecoverable groundedness failures', () => {
    const checked = assistantTestHooks.applyPostAnswerVerificationPolicy({
      answer: ru('\\u042d\\u0442\\u0430 \\u043c\\u043e\\u0434\\u0435\\u043b\\u044c \\u0442\\u043e\\u0447\\u043d\\u043e \\u0430\\u043a\\u0442\\u0443\\u0430\\u043b\\u044c\\u043d\\u0430 \\u0432 \\u0442\\u0435\\u043a\\u0443\\u0449\\u0435\\u0439 \\u043b\\u0438\\u043d\\u0435\\u0439\\u043a\\u0435 \\u043f\\u0440\\u043e\\u0438\\u0437\\u0432\\u043e\\u0434\\u0438\\u0442\\u0435\\u043b\\u044f.'),
      factClaimPlanner: {
        version: 1,
        factPolicy: 'web_required',
        allowedSources: ['catalog', 'visible_cards', 'conversation_memory'],
        requiredDisclaimers: [],
        forbiddenClaims: ['do_not_claim_current_lineup_without_web'],
        risk: 'high',
        warnings: []
      },
      leadStateMachine: {
        version: 1,
        state: 'not_needed',
        nextAction: 'answer_without_lead',
        leadPolicy: 'none',
        hasContactInTurn: false,
        leadRequested: false,
        leadCreated: false,
        warnings: []
      },
      cardManifest: {
        version: 1,
        source: 'execution_contract',
        cardsPolicy: 'none',
        visibleProductIds: [],
        hiddenProductIds: [],
        items: [],
        warnings: []
      }
    });

    expect(checked.postAnswerVerification.status).toBe('error');
    expect(checked.postAnswerVerificationRecovery).toMatchObject({
      attempted: false,
      recovered: false,
      unrecoverableIssues: ['fact_claim_audit:current_lineup_claim_without_web_policy']
    });
  });
});
