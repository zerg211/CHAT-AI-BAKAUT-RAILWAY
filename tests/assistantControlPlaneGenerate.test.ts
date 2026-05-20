import { beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyNeedState, emptyProductSelectionState } from '../src/ai/needState.js';
import type { ConversationSession, Lead, Message, MessageRole, Product } from '../src/shared/types.js';

const openAiCreate = vi.hoisted(() => vi.fn<(...args: any[]) => Promise<any>>(async () => ({ output_text: 'TSS SGG 8000EH подходит по текущим критериям. Карточку показываю ниже.' })));

vi.mock('../src/ai/openaiClient.js', () => ({
  createOpenAIClient: () => ({ responses: { create: openAiCreate } }),
  createEmbedding: async () => null,
  withRetry: async <T>(fn: () => Promise<T>) => fn()
}));

vi.mock('../src/email/httpEmail.js', () => ({
  sendLeadEmail: vi.fn(async () => ({ ok: true }))
}));

const { AssistantService, assistantTestHooks } = await import('../src/ai/assistant.js');

const sessionId = '11111111-1111-4111-8111-111111111111';

function llmFastRouteResponse(overrides: Record<string, unknown> = {}) {
  const route = typeof overrides.route === 'string' ? overrides.route : 'none';
  const defaults = route === 'commercial_handoff'
    ? {
        confidence: 0.9,
        answerTask: 'lead_handoff',
        taskType: 'pure_delivery',
        catalogAction: 'none',
        commercialAction: 'explain_manager_required',
        productCardsPolicy: 'none',
        cardsRole: 'none',
        leadAllowed: true,
        leadAllowedReason: 'specialist verification requires a captured contact',
        currentFocus: 'commercial verification',
        mustAnswerNow: ['confirm received contact and explain specialist verification'],
        answerGuidance: 'confirm the contact once and do not ask for it again',
        pricePolicy: 'visible_cards_only',
        usePriorShownCards: true,
        needsCatalogSelection: false,
        createLeadIfContactPresent: true
      }
    : {
        confidence: 0.3,
        answerTask: 'technical_explanation',
        taskType: 'technical_answer',
        catalogAction: 'none',
        commercialAction: 'none',
        productCardsPolicy: 'none',
        cardsRole: 'none',
        leadAllowed: false,
        leadAllowedReason: 'no commercial handoff needed',
        currentFocus: 'none',
        mustAnswerNow: [],
        answerGuidance: '',
        pricePolicy: 'none',
        usePriorShownCards: false,
        needsCatalogSelection: false,
        createLeadIfContactPresent: false
      };
  return {
    output_text: JSON.stringify({
      route,
      rationale: 'test route',
      warnings: [],
      ...defaults,
      ...overrides
    })
  };
}

function llmFastAnswerResponse(answer: string, overrides: Record<string, unknown> = {}) {
  return {
    output_text: JSON.stringify({
      answer,
      leadRequested: false,
      namedProductIds: [],
      factsUsed: [],
      safetyNotes: [],
      rationale: 'test answer',
      ...overrides
    })
  };
}

function generator(): Product {
  return {
    id: 'tss-8',
    name: 'TSS SGG 8000EH',
    brand: 'TSS',
    category: 'Generators',
    price: 120000,
    currency: 'RUB',
    sourceUrl: 'https://example.test/tss-8',
    specs: {
      fuel: 'gasoline',
      voltage: '220 V',
      nominalPower: '8 kW'
    }
  };
}

function rejectedGenerator(): Product {
  return {
    id: 'bad-2kw',
    name: 'Catalog Bad 2 kW generator',
    brand: 'Other',
    category: 'Generators',
    price: 30000,
    currency: 'RUB',
    sourceUrl: 'https://example.test/bad-2kw',
    specs: {
      fuel: 'gasoline',
      voltage: '220 V',
      nominalPower: '2 kW'
    }
  };
}

class FakeConversations {
  readonly messages: Message[] = [];
  turn: Record<string, unknown> | null = null;
  session: ConversationSession = {
    id: sessionId,
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

  async updateTurn(input: Record<string, unknown>) {
    this.turn = {
      ...(this.turn ?? {
        id: String(input.turnId ?? 'turn-1'),
        sessionId: input.sessionId ?? sessionId,
        status: 'failed',
        requestHash: 'test',
        createdAt: new Date().toISOString()
      }),
      ...input,
      updatedAt: new Date().toISOString()
    };
    return this.turn;
  }

  async updateNeedState(_sessionId: string, needState: ConversationSession['needState']) {
    this.session = { ...this.session, needState };
    return this.session;
  }

  async updateSessionTopic() {
    return this.session;
  }

  async updateHistorySummary() {
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

  async vectorSearchCatalogPages() {
    return [];
  }

  async getOpenConflictsForProducts() {
    return [];
  }

  async searchTroubleshootingCases() {
    return [];
  }

  async markTroubleshootingCasesUsed() {
    return undefined;
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

type ControlPlaneScenario = 'selection' | 'lead' | 'no_contact' | 'availability' | 'changed_requirements' | 'rejected_name';

class ControlPlaneAssistant extends AssistantService {
  constructor(
    conversations: never,
    products: never,
    private readonly requireWeb = false,
    private readonly scenario: ControlPlaneScenario = 'selection',
    leads?: never
  ) {
    super(conversations, products, leads);
  }

  async updateNeedState(current: ConversationSession['needState']) {
    return current;
  }

  async selectProductsForTurn(
    userMessage: string,
    needStateArg: ConversationSession['needState'],
    plan: unknown,
    allCandidates: Product[],
    turnContract?: unknown,
    visibleLimit?: number,
    recentUserText?: string,
    options?: unknown
  ) {
    if (this.scenario !== 'rejected_name') {
      return super.selectProductsForTurn(
        userMessage,
        needStateArg,
        plan as never,
        allCandidates,
        turnContract as never,
        visibleLimit,
        recentUserText,
        options as never
      );
    }
    const selected = allCandidates.find((product) => product.id === 'tss-8') ?? generator();
    const selectionState = {
      ...emptyProductSelectionState(),
      currentProductClass: 'generator' as const,
      targetProductClass: 'generator' as const,
      hardConstraints: {
        ...emptyProductSelectionState().hardConstraints,
        productIntent: 'generator' as const,
        productRole: 'coreProduct' as const,
        nominalPowerKwMin: 8,
        nominalPowerKwMax: 9,
        singlePhase220: true
      },
      selectedProductIds: ['tss-8'],
      matchedProductIds: ['tss-8'],
      confidence: 0.9
    };
    return {
      state: selectionState,
      matchedProducts: [selected],
      visibleProducts: [selected],
      hiddenProducts: [],
      comparisonProducts: [],
      rejectedProducts: [{
        productId: 'bad-2kw',
        reason: 'power below hard constraint'
      }],
      missingQuestions: [],
      confidence: 0.9,
      trace: { source: 'test_rejected_product_selection' }
    };
  }

  async planAssistantTurn(input: { userMessage: string; baseQuery: string }) {
    const leadScenario = this.scenario === 'lead';
    const noContactScenario = this.scenario === 'no_contact';
    const availabilityScenario = this.scenario === 'availability';
    const changedRequirementsScenario = this.scenario === 'changed_requirements';
    const sourcePolicy = this.requireWeb
      ? { allowed: ['catalog', 'visible_cards', 'web'], required: ['web'], forbidden: ['specialist'], webPurpose: 'technical_specs' }
      : leadScenario || availabilityScenario
        ? { allowed: ['catalog', 'visible_cards', 'specialist'], required: ['specialist'], forbidden: ['web'], webPurpose: 'none' }
        : { allowed: ['catalog', 'visible_cards'], required: [], forbidden: ['specialist'], webPurpose: 'none' };
    const toolPlan = [
      ...(noContactScenario
        ? []
        : [
            { tool: 'searchCatalog', reason: availabilityScenario ? 'Check exact catalog model presence.' : 'Find catalog products.', required: true, inputHint: {} },
            { tool: 'selectProducts', reason: availabilityScenario ? 'Select exact or supporting catalog card.' : 'Select visible cards.', required: true, inputHint: {} },
            { tool: 'getProductDetails', reason: 'Ground answer in selected card.', required: false, inputHint: {} }
          ]),
      ...(this.requireWeb
        ? [{ tool: 'webFactSearch', reason: 'Verify missing technical facts.', required: true, inputHint: {} }]
        : []),
      ...(leadScenario
        ? [
            { tool: 'createLeadDraft', reason: 'Draft logistics handoff.', required: true, inputHint: {} },
            { tool: 'createLead', reason: 'Commit lead after contact validation.', required: true, inputHint: {} }
          ]
        : availabilityScenario
          ? [{ tool: 'createLeadDraft', reason: 'Draft stock verification handoff.', required: false, inputHint: {} }]
        : [])
    ];
    return assistantTestHooks.coerceTurnPlan({
      action: leadScenario ? 'collect_lead' : noContactScenario ? 'answer_question' : 'recommend_products',
      answerMode: leadScenario ? 'leadCollection' : noContactScenario ? 'short' : 'productRecommendation',
      cardPolicy: noContactScenario ? 'textOnly' : 'showProducts',
      followUpPolicy: leadScenario ? 'collectLead' : noContactScenario ? 'answerNowNoDeferredOffer' : 'auto',
      contextScope: 'activeNeed',
      searchScope: 'focusedNeed',
      catalogSearchQuery: 'TSS SGG 8000EH 8 kW gasoline 220 V',
      selectedProductIds: noContactScenario ? [] : ['tss-8'],
      requiredProductTraits: {
        productIntent: 'generator',
        productRole: 'coreProduct',
        fuel: 'gasoline',
        startType: 'any',
        enclosure: 'any',
        conventionalGenerator: null,
        singlePhase220: true,
        budgetMax: null,
        weightKgMin: null,
        weightKgMax: null,
        diameterMmMin: null,
        diameterMmMax: null,
        nominalPowerKwMin: 8,
        nominalPowerKwMax: 9,
        maxPowerKwMin: null,
        maxPowerKwMax: null,
        powerReasoning: 'buyer asked for 8 kW'
      },
      selectionState: {
        currentProductClass: 'generator',
        targetProductClass: 'generator',
        compatibilityTargetProduct: '',
        mustHaveTraits: ['gasoline', '220 V'],
        niceToHaveTraits: [],
        excludedClasses: [],
        brandConstraint: 'TSS',
        exactModelConstraint: '',
        isAccessoryFollowUp: false,
        selectionConfidence: 0.9,
        shouldShowCards: !noContactScenario,
        cardDisplayMode: 'auto'
      },
      agentContractV2: {
        version: 2,
        intent: availabilityScenario ? 'availability_check' : leadScenario ? 'lead_handoff' : noContactScenario ? 'technical_answer' : 'product_selection',
        answerTask: leadScenario || availabilityScenario ? 'lead_handoff' : noContactScenario ? 'technical_explanation' : 'product_selection',
        taskType: availabilityScenario ? 'pure_availability' : leadScenario ? 'product_selection_with_delivery' : noContactScenario ? 'contact_refusal_continue_selection' : 'product_selection',
        catalogAction: noContactScenario ? 'none' : availabilityScenario ? 'exact_model_lookup' : 'find_matching_products',
        commercialAction: leadScenario ? 'offer_contact_after_answer' : availabilityScenario ? 'explain_manager_required' : 'none',
        productCardsPolicy: noContactScenario ? 'none' : availabilityScenario ? 'show_exact_matches' : 'show_matching_products',
        cardsRole: noContactScenario ? 'none' : 'primary',
        leadPolicy: leadScenario ? 'required_now' : noContactScenario ? 'forbidden' : availabilityScenario ? 'optional_after_answer' : 'none',
        sourcePolicy,
        needDelta: {
          newRequirements: changedRequirementsScenario ? ['diesel generator'] : [],
          confirmedRequirements: [],
          changedRequirements: changedRequirementsScenario ? ['380 V instead of 220 V'] : [],
          supersededRequirementIds: changedRequirementsScenario ? ['old-voltage'] : [],
          rejectedProductIds: []
        },
        missingFacts: leadScenario ? ['delivery terms'] : availabilityScenario ? ['live stock'] : [],
        toolPlan,
        selectedProductIds: noContactScenario ? [] : ['tss-8'],
        rejectedProductIds: [],
        mustAnswerNow: leadScenario
          ? ['Create handoff only after contact validation and explain logistics verification.']
          : availabilityScenario
            ? ['Separate catalog presence from live stock.']
          : noContactScenario
            ? ['Answer without asking for contact.']
            : ['Recommend the selected catalog generator.'],
        currentFocus: leadScenario ? 'delivery handoff' : availabilityScenario ? 'exact stock check' : noContactScenario ? 'no-contact answer' : 'TSS gasoline generator',
        errorRecoveryPriority: leadScenario ? 'respect lead policy and contact validation' : availabilityScenario ? 'do not promise live stock' : noContactScenario ? 'do not ask for contact' : 'answer from catalog evidence',
        confidence: 0.92,
        warnings: []
      },
      needsWebSearch: false,
      missingInformation: [],
      answerGuidance: leadScenario
        ? 'Confirm that the request was handed to logistics/specialist verification.'
        : noContactScenario
          ? 'Answer without contact pressure.'
          : 'Answer shortly and show product card.'
    }, input.baseQuery, input.userMessage);
  }
}

describe('assistant generateAnswer control-plane metadata', () => {
  beforeEach(() => {
    openAiCreate.mockClear();
    openAiCreate.mockResolvedValue({ output_text: 'TSS SGG 8000EH подходит по текущим критериям. Карточку показываю ниже.' });
  });

  it('emits V2 contract, tool trace, product evidence, policy gate, and post-answer verification through the real generateAnswer path', async () => {
    const conversations = new FakeConversations();
    const assistant = new ControlPlaneAssistant(conversations as never, new FakeProducts([generator()]) as never);

    const result = await assistant.generateAnswer({
      sessionId,
      userMessage: 'Нужен бензиновый генератор TSS около 8 кВт на 220 В'
    });

    expect(result.productCards.map((card) => card.id)).toContain('tss-8');
    expect(result.metadata?.agentContractV2?.version).toBe(2);
    expect(result.metadata?.sourcePolicy?.allowed).toEqual(expect.arrayContaining(['catalog', 'visible_cards']));
    expect(result.metadata?.toolTrace?.map((item) => item.tool)).toEqual(expect.arrayContaining([
      'searchCatalog',
      'selectProducts',
      'getProductDetails'
    ]));
    expect(result.metadata?.toolTrace?.find((item) => item.tool === 'searchCatalog')?.summary).toContain('runtime_catalog_refined_search_execution');
    expect(result.metadata?.toolTrace?.find((item) => item.tool === 'selectProducts')?.summary).toContain('runtime_product_selection_execution');
    expect(result.metadata?.productEvidenceRegistry?.visibleProductIds).toContain('tss-8');
    expect(result.metadata?.policyGate?.ok).toBe(true);
    expect(result.metadata?.policyGateEnforcement?.mode).toBe('pass');
    expect(result.metadata?.leadDraft).toBeUndefined();
    expect(result.metadata?.postAnswerVerification?.status).toBe('pass');
  });

  it('lets V2 source policy require web search even when the answer also shows product cards', async () => {
    const conversations = new FakeConversations();
    const assistant = new ControlPlaneAssistant(conversations as never, new FakeProducts([generator()]) as never, true);

    const result = await assistant.generateAnswer({
      sessionId,
      userMessage: 'Нужен TSS 8 кВт, но проверьте недостающие технические данные'
    });
    const answerRequest = (openAiCreate.mock.calls as unknown[][]).at(-1)?.[0] as { tools?: Array<{ type: string }>; tool_choice?: { type: string } } | undefined;

    expect(result.productCards.map((card) => card.id)).toContain('tss-8');
    expect(result.metadata?.agentContractV2?.sourcePolicy.required).toContain('web');
    expect(result.metadata?.toolTrace?.find((item) => item.tool === 'webFactSearch')).toMatchObject({ ok: true, required: true });
    expect(result.metadata?.policyGate?.ok).toBe(true);
    expect(result.metadata?.policyGateEnforcement?.mode).toBe('pass');
    expect(answerRequest?.tools).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'web_search_preview' })]));
    expect(answerRequest?.tool_choice).toEqual({ type: 'web_search_preview' });
  });

  it('commits a lead and replaces the current turn with a short contact confirmation', async () => {
    openAiCreate.mockResolvedValue({
      output_text: 'Алексей, контакт получил. Проверю доставку и наличие по выбранным позициям и перезвоню с точным ответом.'
    });
    const conversations = new FakeConversations();
    const leads = new FakeLeads();
    const assistant = new ControlPlaneAssistant(conversations as never, new FakeProducts([generator()]) as never, false, 'lead', leads as never);

    const result = await assistant.generateAnswer({
      sessionId,
      userMessage: 'Да, давайте проверим наличие и доставку по этим двум позициям. Меня зовут Алексей, телефон +7 900 000-00-11.'
    });

    expect(leads.leads).toHaveLength(1);
    expect(result.leadCreated).toBe(true);
    expect(result.leadRequested).toBe(false);
    expect(result.productCards).toHaveLength(0);
    expect(conversations.messages.at(-1)?.metadata?.productCards).toEqual([]);
    expect(result.answer).toMatch(/Алексей, контакт получил\./iu);
    expect(result.answer).toMatch(/Проверю.*доставку.*наличие.*по выбранным позициям/iu);
    expect(result.answer).toMatch(/перезвоню с точным ответом/iu);
    expect(result.answer).not.toMatch(/нижний ориентир|TSS SGG 8000EH|оставьте|форма|телефон/iu);
    expect(result.metadata?.leadDraft).toMatchObject({
      reason: 'delivery',
      productIds: expect.arrayContaining(['tss-8'])
    });
    expect(result.metadata?.leadStateMachine).toMatchObject({
      state: 'created',
      nextAction: 'confirm_created_lead'
    });
    expect(result.metadata?.policyGate?.answerConstraints).toEqual(expect.arrayContaining([
      'confirm_contact_received_only',
      'do_not_repeat_product_selection_or_commercial_handoff',
      'do_not_ask_for_name_phone_contact_or_form_again'
    ]));
    expect(result.metadata?.toolTrace?.find((item) => item.tool === 'createLeadDraft')).toMatchObject({ ok: true, risk: 'safe' });
    expect(result.metadata?.toolTrace?.find((item) => item.tool === 'createLead')).toMatchObject({ ok: true, risk: 'sensitive' });
  });

  it('fast-confirms contact from prior cards and records autoLead metadata', async () => {
    openAiCreate.mockClear();
    openAiCreate
      .mockResolvedValueOnce(llmFastRouteResponse({ route: 'commercial_handoff' }))
      .mockResolvedValueOnce(llmFastAnswerResponse(
        'Алексей, контакт получил. Проверим наличие и доставку по выбранным позициям и вернемся с точным ответом.',
        { namedProductIds: ['tss-8'], factsUsed: ['visible catalog card'], leadRequested: false }
      ));
    const conversations = new FakeConversations();
    const leads = new FakeLeads();
    const product = generator();
    const hiddenDiesel = {
      ...rejectedGenerator(),
      id: 'hidden-diesel',
      name: 'Hidden diesel generator 12 kW'
    };
    conversations.messages.push({
      id: 'previous-assistant-cards',
      sessionId,
      role: 'assistant',
      content: 'Показываю подходящие генераторы.',
      metadata: {
        cardDisplay: { initialVisibleCount: 1 },
        productCards: [
          {
            id: product.id,
            name: product.name,
            brand: product.brand,
            category: product.category,
            price: product.price,
            currency: product.currency,
            sourceUrl: product.sourceUrl,
            specs: product.specs,
            reasons: ['Подходит по мощности'],
            caveats: []
          },
          {
            id: hiddenDiesel.id,
            name: hiddenDiesel.name,
            brand: hiddenDiesel.brand,
            category: hiddenDiesel.category,
            price: hiddenDiesel.price,
            currency: hiddenDiesel.currency,
            sourceUrl: hiddenDiesel.sourceUrl,
            specs: { fuel: 'diesel', voltage: '380 V', nominalPower: '12 kW' },
            reasons: ['Hidden by cardDisplay'],
            caveats: []
          }
        ]
      },
      createdAt: new Date().toISOString()
    });
    class FastLeadAssistant extends AssistantService {
      async updateNeedState(current: ConversationSession['needState']) {
        return current;
      }

      async planAssistantTurn(): Promise<never> {
        throw new Error('planner should not run for fast commercial contact confirmation');
      }
    }
    const assistant = new FastLeadAssistant(conversations as never, new FakeProducts([product]) as never, leads as never);

    const result = await assistant.generateAnswer({
      sessionId,
      userMessage: 'Давайте проверим наличие и доставку по этим позициям. Меня зовут Алексей, телефон +7 900 000-00-11.'
    });

    expect(openAiCreate).toHaveBeenCalledTimes(2);
    expect(leads.leads).toHaveLength(1);
    expect(result.metadata?.answerMode).toBe('llm_fast_commercial_handoff');
    expect(result.metadata?.llmFastTurnRoute).toMatchObject({ route: 'commercial_handoff' });
    expect(result.metadata?.autoLead).toMatchObject({
      created: true,
      emailStatus: 'sent_email'
    });
    expect(result.metadata?.leadStateMachine).toMatchObject({
      state: 'created',
      nextAction: 'confirm_created_lead'
    });
    expect(result.metadata?.leadDraft).toMatchObject({
      reason: 'delivery',
      productIds: expect.arrayContaining(['tss-8'])
    });
    expect(result.metadata?.leadDraft?.productIds).not.toContain('hidden-diesel');
    expect(result.answer).toMatch(/Алексей, контакт получил/iu);
    expect(result.answer).not.toMatch(/оставьте|напишите|телефон/iu);
  });

  it('preserves no-contact policy through generateAnswer metadata and verifier', async () => {
    openAiCreate.mockResolvedValue({ output_text: 'Отвечу без звонка: сначала уточним задачу и ограничения, затем можно продолжить подбор по каталогу.' });
    const conversations = new FakeConversations();
    const leads = new FakeLeads();
    const assistant = new ControlPlaneAssistant(conversations as never, new FakeProducts([generator()]) as never, false, 'no_contact', leads as never);

    const result = await assistant.generateAnswer({
      sessionId,
      userMessage: 'Пока без звонка, просто ответьте по подбору'
    });

    expect(leads.leads).toHaveLength(0);
    expect(result.leadCreated).toBe(false);
    expect(result.metadata?.leadDraft).toBeUndefined();
    expect(result.metadata?.leadStateMachine).toMatchObject({
      state: 'not_allowed',
      nextAction: 'do_not_ask_contact'
    });
    expect(result.metadata?.policyGate?.answerConstraints).toContain('do_not_ask_for_name_phone_contact_or_callback');
    expect(result.metadata?.toolTrace?.some((item) => item.tool === 'createLead')).toBe(false);
    expect(result.metadata?.postAnswerVerification?.status).toBe('pass');
  });

  it('treats exact availability as catalog presence plus specialist stock verification', async () => {
    openAiCreate.mockResolvedValue({ output_text: 'TSS SGG 8000EH is present in the catalog card, but live stock must be checked by a manager.' });
    const conversations = new FakeConversations();
    const leads = new FakeLeads();
    const assistant = new ControlPlaneAssistant(conversations as never, new FakeProducts([generator()]) as never, false, 'availability', leads as never);

    const result = await assistant.generateAnswer({
      sessionId,
      userMessage: 'Is TSS SGG 8000EH 8 kW in stock?'
    });

    expect(leads.leads).toHaveLength(0);
    expect(result.usedWebSearch).toBe(false);
    expect(result.productCards.map((card) => card.id)).toContain('tss-8');
    expect(result.metadata?.agentContractV2).toMatchObject({
      intent: 'availability_check',
      catalogAction: 'exact_model_lookup',
      commercialAction: 'explain_manager_required'
    });
    expect(result.metadata?.sourcePolicy?.required).toContain('specialist');
    expect(result.metadata?.sourcePolicy?.forbidden).toContain('web');
    expect(result.metadata?.leadDraft).toMatchObject({
      reason: 'availability',
      productIds: expect.arrayContaining(['tss-8'])
    });
    expect(result.metadata?.policyGate?.answerConstraints).toEqual(expect.arrayContaining([
      'do_not_promise_live_stock_delivery_discount_or_exact_terms',
      'separate_catalog_presence_from_live_stock'
    ]));
    expect(result.metadata?.toolTrace?.find((item) => item.tool === 'createLeadDraft')).toMatchObject({ ok: true, risk: 'safe' });
  });

  it('applies V2 requirement deltas before product selection and metadata persistence', async () => {
    const conversations = new FakeConversations();
    const oldRequirement = {
      id: 'old-voltage',
      kind: 'phase' as const,
      value: { text: '220 V' },
      status: 'active' as const,
      strictness: 'strictOnly' as const,
      evidence: 'prior user message',
      source: 'explicit_user' as const,
      replacesRequirementIds: [],
      updatedAt: new Date().toISOString()
    };
    conversations.session.needState = {
      ...emptyNeedState(),
      semanticMemory: {
        ...emptyNeedState().semanticMemory,
        activeRequirementIds: ['old-voltage'],
        requirements: [oldRequirement]
      }
    };
    const assistant = new ControlPlaneAssistant(conversations as never, new FakeProducts([generator()]) as never, false, 'changed_requirements');

    const result = await assistant.generateAnswer({
      sessionId,
      userMessage: 'Now switch to diesel and 380 V.'
    });

    const oldAfter = result.needState.semanticMemory.requirements.find((item) => item.id === 'old-voltage');
    expect(oldAfter?.status).toBe('superseded');
    expect(result.needState.semanticMemory.activeRequirementIds).not.toContain('old-voltage');
    expect(result.needState.semanticMemory.requirements.some((item) => String(item.value.text ?? '').includes('380 V'))).toBe(true);
    expect(result.metadata?.agentContractV2?.needDelta.supersededRequirementIds).toContain('old-voltage');
    const metadataMemoryAfter = result.metadata?.semanticMemoryAfter as { activeRequirementIds?: string[] } | undefined;
    expect(metadataMemoryAfter?.activeRequirementIds).not.toContain('old-voltage');
  });

  it('blocks a generated answer that names a rejected catalog product by model name', async () => {
    openAiCreate.mockResolvedValue({ output_text: 'Catalog Bad 2 kW generator is the best option.' });
    const conversations = new FakeConversations();
    const assistant = new ControlPlaneAssistant(
      conversations as never,
      new FakeProducts([generator(), rejectedGenerator()]) as never,
      true,
      'rejected_name'
    );

    await expect(assistant.generateAnswer({
      sessionId,
      userMessage: 'Need an 8 kW generator, verify technical details too.'
    })).rejects.toThrow(/disallowed_product_named_in_answer/);
  });

  it('includes V2 contract, product evidence, tool trace, and policy gate in recovered turn metadata', async () => {
    openAiCreate.mockResolvedValue({ output_text: 'Recovered: TSS SGG 8000EH remains the visible catalog option.' });
    const conversations = new FakeConversations();
    const baseSelection = emptyProductSelectionState();
    conversations.session.needState = {
      ...emptyNeedState(),
      selectionState: {
        ...baseSelection,
        currentProductClass: 'generator',
        targetProductClass: 'generator',
        hardConstraints: {
          ...baseSelection.hardConstraints,
          productIntent: 'generator',
          productRole: 'coreProduct',
          singlePhase220: true,
          nominalPowerKwMin: 8,
          nominalPowerKwMax: 9
        },
        selectedProductIds: ['tss-8'],
        matchedProductIds: ['tss-8'],
        confidence: 0.9
      }
    };
    conversations.messages.push({
      id: 'user-recovery',
      sessionId,
      role: 'user',
      content: 'Recover the 8 kW generator recommendation.',
      metadata: {},
      createdAt: new Date().toISOString()
    });
    conversations.turn = {
      id: 'turn-recovery',
      sessionId,
      userMessageId: 'user-recovery',
      status: 'failed',
      requestHash: 'test',
      plannerContract: {
        answerTask: 'product_selection',
        taskType: 'product_selection',
        catalogAction: 'find_matching_products',
        commercialAction: 'none',
        productCardsPolicy: 'show_matching_products',
        mustAnswerNow: ['recover the visible generator recommendation'],
        activeNeeds: [],
        currentFocus: 'generator',
        cardsRole: 'primary',
        leadAllowed: false,
        leadAllowedReason: 'test forbids contact',
        errorRecoveryPriority: 'recover from saved selection',
        validatorWarnings: []
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    const assistant = new ControlPlaneAssistant(conversations as never, new FakeProducts([generator()]) as never);

    const result = await assistant.recoverTurn({
      sessionId,
      turnId: 'turn-recovery'
    });

    expect(result.productCards.map((card) => card.id)).toContain('tss-8');
    expect(result.metadata?.agentContractV2?.version).toBe(2);
    expect(result.metadata?.sourcePolicy).toBeDefined();
    expect(result.metadata?.productEvidenceRegistry?.visibleProductIds).toContain('tss-8');
    expect(result.metadata?.toolTrace?.find((item) => item.tool === 'selectProducts')).toMatchObject({ ok: true });
    expect(result.metadata?.policyGate?.ok).toBe(true);
    expect(result.metadata?.policyGateEnforcement?.mode).toBe('pass');
    expect(result.metadata?.postAnswerVerification?.status).toBe('pass');
  });
});
