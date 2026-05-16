import { describe, expect, it } from 'vitest';
import { AssistantService, assistantTestHooks } from '../src/ai/assistant.js';
import { deriveAgentTurnContract, applyAgentTurnContractToPlan } from '../src/ai/agentTurnContract.js';
import { emptyNeedState, mergeProductSelectionState } from '../src/ai/needState.js';
import type { AgentTurnContract, CustomerNeedState, Product } from '../src/shared/types.js';

const ru = (value: string) => JSON.parse(`"${value}"`) as string;

function product(id: string, name: string, specs: Record<string, unknown>, brand = 'TSS'): Product {
  return {
    id,
    name,
    brand,
    category: 'Gasoline generators',
    price: 213_941,
    currency: 'RUB',
    sourceUrl: `https://example.test/${id}`,
    specs
  };
}

class FakeProducts {
  constructor(private readonly products: Product[]) {}

  async searchProducts() {
    return this.products;
  }

  async searchProductsByModelTokens() {
    return this.products;
  }

  async vectorSearch() {
    return [];
  }

  async listProducts() {
    return this.products;
  }
}

function rawPlan(overrides: Record<string, unknown>) {
  return assistantTestHooks.coerceTurnPlan({
    action: 'answer_question',
    answerMode: 'short',
    cardPolicy: 'textOnly',
    followUpPolicy: 'auto',
    contextScope: 'activeNeed',
    searchScope: 'focusedNeed',
    catalogSearchQuery: '',
    selectedProductIds: [],
    requiredProductTraits: {
      productIntent: 'unknown',
      productRole: 'unknown',
      fuel: 'unknown',
      startType: 'unknown',
      enclosure: 'unknown',
      conventionalGenerator: null,
      singlePhase220: null,
      budgetMax: null,
      weightKgMin: null,
      weightKgMax: null,
      diameterMmMin: null,
      diameterMmMax: null,
      nominalPowerKwMin: null,
      nominalPowerKwMax: null,
      maxPowerKwMin: null,
      maxPowerKwMax: null,
      powerReasoning: ''
    },
    selectionState: {
      currentProductClass: 'unknown',
      targetProductClass: 'unknown',
      compatibilityTargetProduct: '',
      mustHaveTraits: [],
      niceToHaveTraits: [],
      excludedClasses: [],
      brandConstraint: '',
      exactModelConstraint: '',
      isAccessoryFollowUp: false,
      selectionConfidence: 0,
      shouldShowCards: false,
      cardDisplayMode: 'none'
    },
    agentDecision: {
      answerTask: 'technical_explanation',
      taskType: 'technical_answer',
      catalogAction: 'none',
      commercialAction: 'none',
      productCardsPolicy: 'none',
      mustAnswerNow: [],
      currentFocus: 'latest_message',
      cardsRole: 'none',
      leadAllowed: true,
      leadAllowedReason: 'test',
      errorRecoveryPriority: 'answer latest message',
      confidence: 0.9
    },
    needsWebSearch: false,
    missingInformation: [],
    answerGuidance: '',
    ...overrides
  }, String(overrides.catalogSearchQuery ?? 'test message'));
}

describe('agentic #876 internal cycle', () => {
  it('does not suppress chat auto lead after an availability handoff when the buyer already provided contact', () => {
    const plan = rawPlan({
      action: 'collect_lead',
      answerMode: 'leadCollection',
      followUpPolicy: 'collectLead',
      agentDecision: {
        answerTask: 'lead_handoff',
        taskType: 'product_selection_with_availability',
        catalogAction: 'none',
        commercialAction: 'explain_manager_required',
        productCardsPolicy: 'none',
        mustAnswerNow: ['accept city and contact for availability verification'],
        currentFocus: 'Ammann plate availability and delivery timing',
        cardsRole: 'none',
        leadAllowed: true,
        leadAllowedReason: 'buyer provided contact for stock and delivery timing verification',
        errorRecoveryPriority: 'create the lead and confirm commercial verification',
        confidence: 0.94
      }
    });
    const contract = deriveAgentTurnContract({
      userMessage: 'Город Москва, Александр 89934460088',
      plan,
      needState: emptyNeedState()
    });

    expect(contract.answerTask).toBe('lead_handoff');
    expect(contract.taskType).toBe('product_selection_with_availability');
    expect(assistantTestHooks.shouldSuppressLeadRequestFromContract(contract)).toBe(true);
    expect(assistantTestHooks.shouldSuppressLeadRequestFromContract(contract, 'Город Москва')).toBe(true);
    expect(assistantTestHooks.shouldSuppressLeadRequestFromContract(contract, 'Город Москва, Александр 89934460088')).toBe(false);
  });

  it('preserves the LLM semantic contract across comparison, availability, selection, delivery, and contact-refusal turns', async () => {
    const comparisonPlan = rawPlan({
      action: 'recommend_products',
      answerMode: 'productRecommendation',
      cardPolicy: 'showProducts',
      agentDecision: {
        answerTask: 'comparison',
        taskType: 'comparison',
        catalogAction: 'none',
        commercialAction: 'none',
        productCardsPolicy: 'none',
        mustAnswerNow: ['compare Baudouin and Doosan at a general engine-family level, then ask for exact model indices'],
        currentFocus: 'engine comparison',
        cardsRole: 'none',
        leadAllowed: false,
        leadAllowedReason: 'buyer asked for technical comparison, not a call',
        errorRecoveryPriority: 'give the general comparison first, then ask for concrete engine models without cards',
        confidence: 0.94
      }
    });
    const comparisonContract = deriveAgentTurnContract({
      userMessage: 'Compare Baudouin and Doosan engines',
      plan: comparisonPlan,
      needState: emptyNeedState()
    });
    const comparisonApplied = applyAgentTurnContractToPlan(comparisonPlan, comparisonContract);

    expect(comparisonContract.taskType).toBe('comparison');
    expect(comparisonContract.catalogAction).toBe('none');
    expect(comparisonContract.productCardsPolicy).toBe('none');
    expect(comparisonApplied.action).toBe('answer_question');
    expect(comparisonApplied.cardPolicy).toBe('textOnly');
    expect(assistantTestHooks.technicalCurrentLevelAnswerGuidance(comparisonContract)).toContain('do not answer only by asking for exact model');

    const availabilityPlan = rawPlan({
      action: 'handoff_specialist',
      answerMode: 'leadCollection',
      followUpPolicy: 'collectLead',
      agentDecision: {
        answerTask: 'lead_handoff',
        taskType: 'pure_availability',
        catalogAction: 'exact_model_lookup',
        commercialAction: 'explain_manager_required',
        productCardsPolicy: 'show_exact_matches',
        mustAnswerNow: ['verify whether the exact TSS 10 kW gasoline model exists in catalog'],
        currentFocus: 'TSS 10 kW gasoline generator',
        cardsRole: 'supporting',
        leadAllowed: true,
        leadAllowedReason: 'availability needs manager verification after catalog lookup',
        errorRecoveryPriority: 'separate catalog presence from live stock',
        confidence: 0.9
      }
    });
    const availabilityContract = deriveAgentTurnContract({
      userMessage: 'Do you have TSS 10 kW gasoline in stock?',
      plan: availabilityPlan,
      needState: emptyNeedState()
    });
    const availabilityApplied = applyAgentTurnContractToPlan(availabilityPlan, availabilityContract);

    expect(availabilityContract.taskType).toBe('pure_availability');
    expect(availabilityContract.catalogAction).toBe('exact_model_lookup');
    expect(availabilityContract.productCardsPolicy).toBe('show_exact_matches');
    expect(availabilityApplied.cardPolicy).toBe('showProducts');

    const selectionPlan = rawPlan({
      action: 'collect_lead',
      answerMode: 'leadCollection',
      cardPolicy: 'textOnly',
      followUpPolicy: 'collectLead',
      catalogSearchQuery: 'TSS gasoline generator 8-10 kW 220 V single phase',
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
        nominalPowerKwMax: 10,
        maxPowerKwMin: null,
        maxPowerKwMax: null,
        powerReasoning: 'buyer asked for 8-10 kW 220 V single phase'
      },
      selectionState: {
        currentProductClass: 'generator',
        targetProductClass: 'generator',
        compatibilityTargetProduct: '',
        mustHaveTraits: ['TSS', 'single phase 220 V'],
        niceToHaveTraits: [],
        excludedClasses: ['generator', 'weldingGenerator'],
        brandConstraint: 'TSS',
        exactModelConstraint: '',
        isAccessoryFollowUp: false,
        selectionConfidence: 0.95,
        shouldShowCards: false,
        cardDisplayMode: 'none'
      },
      agentDecision: {
        answerTask: 'mixed',
        taskType: 'product_selection_with_delivery',
        catalogAction: 'find_matching_products',
        commercialAction: 'explain_manager_required',
        productCardsPolicy: 'show_matching_products',
        mustAnswerNow: ['select matching generator cards', 'explain delivery needs logistics verification'],
        currentFocus: 'generator',
        cardsRole: 'primary',
        leadAllowed: true,
        leadAllowedReason: 'delivery needs specialist verification but the current task is still selection',
        errorRecoveryPriority: 'continue selection and do not turn this into contact collection',
        confidence: 0.96
      }
    });
    const selectionContract = deriveAgentTurnContract({
      userMessage: 'Select TSS 8-10 kW 220 V and calculate delivery to Yeisk',
      plan: selectionPlan,
      needState: emptyNeedState()
    });
    const selectionApplied = applyAgentTurnContractToPlan(selectionPlan, selectionContract);
    const products = [
      product('single-220', 'TSS SGG 10000EHA gasoline generator 10.0 kW 230 V single phase', { voltage: '230 V', nominalPower: '10.0 kW' }),
      product('mixed-220-380', 'TSS SGG 10000EH3 gasoline generator 10.0 kW 220/380 V', { voltage: '220/380 V', nominalPower: '10.0 kW' }),
      product('three-phase', 'TSS SGG 9000EH3 gasoline generator 9.0 kW 380 V three phase', { voltage: '380 V', phase: 'three phase', nominalPower: '9.0 kW' })
    ];
    const selectionState = mergeProductSelectionState(emptyNeedState().selectionState, {
      currentProductClass: 'generator',
      targetProductClass: 'generator',
      hardConstraints: {
        ...emptyNeedState().selectionState.hardConstraints,
        productIntent: 'generator',
        productRole: 'coreProduct',
        fuel: 'gasoline',
        singlePhase220: true,
        nominalPowerKwMin: 8,
        nominalPowerKwMax: 10,
        excludedClasses: ['generator', 'weldingGenerator'],
        provenance: {
          fuel: 'explicit_user',
          singlePhase220: 'explicit_user',
          nominalPowerKwMin: 'explicit_user',
          nominalPowerKwMax: 'explicit_user'
        }
      },
      confidence: 0.96
    });
    const assistant = new AssistantService(undefined as never, new FakeProducts(products) as never);
    const selection = await assistant.selectProductsForTurn(
      'Select a TSS gasoline generator and calculate delivery to Yeisk',
      { ...emptyNeedState(), selectionState },
      selectionApplied,
      products,
      assistantTestHooks.resolveTurnContractForPlan(selectionApplied),
      undefined,
      '',
      { forceCatalogVerification: selectionContract.catalogAction !== 'none' }
    );

    expect(selectionContract.taskType).toBe('product_selection_with_delivery');
    expect(selectionContract.catalogAction).toBe('find_matching_products');
    expect(selectionContract.productCardsPolicy).toBe('show_matching_products');
    expect(selectionApplied.action).toBe('recommend_products');
    expect(selectionApplied.cardPolicy).toBe('showProducts');
    expect(selection.visibleProducts.map((item) => item.id)).toContain('single-220');
    expect(selection.visibleProducts.map((item) => item.id)).not.toContain('mixed-220-380');
    expect(selection.visibleProducts.map((item) => item.id)).not.toContain('three-phase');
    const selectionTrace = selection.trace as {
      hardConstraints: { excludedClasses?: string[] };
      diagnosticRejectedProducts: Array<{ productId: string; reason?: string | null }>;
    };
    expect(selectionTrace.hardConstraints.excludedClasses ?? []).not.toContain('generator');
    expect(selectionTrace.diagnosticRejectedProducts.find((item) => item.productId === 'single-220')?.reason ?? '').not.toMatch(/excluded class generator/i);
    expect(assistantTestHooks.shouldSuppressLeadRequestFromContract(selectionContract)).toBe(true);
    expect(assistantTestHooks.commercialManagerVerificationGuidance(selectionContract)).toContain('first person');

    const leadPressure = ru('\\u041f\\u043e\\u0434 \\u0432\\u0430\\u0448 \\u0437\\u0430\\u043f\\u0440\\u043e\\u0441 \\u043f\\u043e\\u0434\\u0445\\u043e\\u0434\\u0438\\u0442 TSS SGG 10000EHA. \\u0414\\u043e\\u0441\\u0442\\u0430\\u0432\\u043a\\u0443 \\u0434\\u043e \\u0415\\u0439\\u0441\\u043a\\u0430 \\u043d\\u0443\\u0436\\u043d\\u043e \\u0443\\u0442\\u043e\\u0447\\u043d\\u044f\\u0442\\u044c \\u0443 \\u043b\\u043e\\u0433\\u0438\\u0441\\u0442\\u0438\\u043a\\u0438. \\u041d\\u0430\\u043f\\u0438\\u0448\\u0438\\u0442\\u0435 \\u0438\\u043c\\u044f \\u0438 \\u0442\\u0435\\u043b\\u0435\\u0444\\u043e\\u043d, \\u043c\\u0435\\u043d\\u0435\\u0434\\u0436\\u0435\\u0440 \\u0443\\u0442\\u043e\\u0447\\u043d\\u0438\\u0442 \\u043d\\u0430\\u043b\\u0438\\u0447\\u0438\\u0435 \\u0438 \\u0434\\u043e\\u0441\\u0442\\u0430\\u0432\\u043a\\u0443.');
    const stripped = assistantTestHooks.stripLeadPressureTail(leadPressure);

    expect(stripped).toContain('TSS SGG 10000EHA');
    expect(stripped).toContain(ru('\\u0414\\u043e\\u0441\\u0442\\u0430\\u0432\\u043a'));
    expect(stripped).not.toMatch(/\u0438\u043c\u044f|\u0442\u0435\u043b\u0435\u0444\u043e\u043d|\u043a\u043e\u043d\u0442\u0430\u043a\u0442/iu);
    const strippedInfinitive = assistantTestHooks.stripLeadPressureTail(
      'Под ваш запрос подходит TSS SGG 10000EHA. Если решите брать, можно оставить контакт, я сверю наличие и доставку.'
    );
    expect(strippedInfinitive).toContain('TSS SGG 10000EHA');
    expect(strippedInfinitive).not.toMatch(/оставить\s+контакт|контакт/iu);
    const deliveryWithoutManager = ru('\\u041f\\u043e\\u0434\\u0445\\u043e\\u0434\\u0438\\u0442 TSS SGG 10000EHA. \\u0427\\u0442\\u043e\\u0431\\u044b \\u043f\\u043e\\u0441\\u0447\\u0438\\u0442\\u0430\\u0442\\u044c \\u0434\\u043e\\u0441\\u0442\\u0430\\u0432\\u043a\\u0443 \\u0434\\u043e \\u0415\\u0439\\u0441\\u043a\\u0430, \\u043f\\u0440\\u0438\\u0448\\u043b\\u0438\\u0442\\u0435 \\u0430\\u0434\\u0440\\u0435\\u0441.');
    const commerciallySafe = assistantTestHooks.ensureCommercialManagerVerification(deliveryWithoutManager, selectionContract);
    expect(commerciallySafe).toMatch(/\u0441\u0432\u0435\u0440|\u0443\u0442\u043e\u0447\u043d|\u043f\u043e\u0441\u0447\u0438\u0442|\u043b\u043e\u0433\u0438\u0441\u0442/iu);
    expect(commerciallySafe).not.toMatch(/\u0434\u043e\u043b\u0436\u0435\u043d\s+\u043f\u043e\u0434\u0442\u0432\u0435\u0440\u0434\u0438\u0442\u044c\s+\u043c\u0435\u043d\u0435\u0434\u0436\u0435\u0440/iu);
    expect(commerciallySafe).not.toMatch(/\u0442\u0435\u043b\u0435\u0444\u043e\u043d|\u043d\u043e\u043c\u0435\u0440/iu);

    const refusalPlan = rawPlan({
      action: 'collect_lead',
      answerMode: 'leadCollection',
      cardPolicy: 'textOnly',
      followUpPolicy: 'collectLead',
      agentDecision: {
        answerTask: 'mixed',
        taskType: 'contact_refusal_continue_selection',
        catalogAction: 'find_matching_products',
        commercialAction: 'none',
        productCardsPolicy: 'show_matching_products',
        mustAnswerNow: ['show variants without contact handoff'],
        currentFocus: 'generator',
        cardsRole: 'primary',
        leadAllowed: false,
        leadAllowedReason: 'buyer refused contact and still wants variants',
        errorRecoveryPriority: 'continue selection without asking for phone',
        confidence: 0.95
      }
    });
    const refusalContract = deriveAgentTurnContract({
      userMessage: 'No, just show variants',
      plan: refusalPlan,
      needState: emptyNeedState()
    });
    const refusalApplied = applyAgentTurnContractToPlan(refusalPlan, refusalContract);

    expect(refusalContract.taskType).toBe('contact_refusal_continue_selection');
    expect(refusalContract.leadAllowed).toBe(false);
    expect(refusalApplied.action).toBe('recommend_products');
    expect(refusalApplied.cardPolicy).toBe('showProducts');
    expect(refusalApplied.followUpPolicy).toBe('answerNowNoDeferredOffer');
  });

  it('does not persist comparison-only requirements as product selection constraints', () => {
    const previousSelection = mergeProductSelectionState(emptyNeedState().selectionState, {
      currentProductClass: 'generator',
      targetProductClass: 'generator',
      hardConstraints: {
        ...emptyNeedState().selectionState.hardConstraints,
        productIntent: 'generator',
        productRole: 'coreProduct',
        fuel: 'gasoline',
        brandConstraint: 'TSS',
        nominalPowerKwMin: 8,
        nominalPowerKwMax: 10,
        provenance: {
          fuel: 'explicit_user',
          brandConstraint: 'explicit_user',
          nominalPowerKwMin: 'explicit_user',
          nominalPowerKwMax: 'explicit_user'
        }
      },
      confidence: 0.9
    });
    const contaminatedSelection = mergeProductSelectionState(emptyNeedState().selectionState, {
      currentProductClass: 'generator',
      targetProductClass: 'generator',
      hardConstraints: {
        ...emptyNeedState().selectionState.hardConstraints,
        productIntent: 'generator',
        productRole: 'coreProduct',
        fuel: 'diesel',
        brandConstraint: 'Doosan',
        provenance: {
          fuel: 'planner',
          brandConstraint: 'planner'
        }
      },
      confidence: 0.72
    });
    const contaminatedMemory: CustomerNeedState['semanticMemory'] = {
      ...emptyNeedState().semanticMemory,
      activeRequirementIds: ['brand-doosan', 'fuel-diesel'],
      requirements: [
        {
          id: 'brand-doosan',
          kind: 'brand',
          value: { text: 'Doosan' },
          status: 'active',
          strictness: 'strictOnly',
          evidence: 'engine-family comparison mentioned Doosan',
          source: 'llm_inference',
          replacesRequirementIds: [],
          updatedAt: '2026-05-13T00:00:00.000Z'
        },
        {
          id: 'fuel-diesel',
          kind: 'fuel',
          value: { text: 'diesel' },
          status: 'active',
          strictness: 'strictOnly',
          evidence: 'engine-family comparison mentioned diesel',
          source: 'llm_inference',
          replacesRequirementIds: [],
          updatedAt: '2026-05-13T00:00:00.000Z'
        }
      ]
    };
    const previousState = { ...emptyNeedState(), selectionState: previousSelection };
    const currentState = {
      ...emptyNeedState(),
      explicitNeeds: [
        {
          value: 'compare Baudouin and Doosan engines',
          evidence: 'latest technical question',
          confidence: 0.9,
          updatedAt: '2026-05-13T00:00:00.000Z'
        }
      ],
      selectionState: contaminatedSelection,
      semanticMemory: contaminatedMemory
    };
    const plan = rawPlan({
      agentDecision: {
        answerTask: 'comparison',
        taskType: 'comparison',
        catalogAction: 'none',
        commercialAction: 'none',
        productCardsPolicy: 'none',
        mustAnswerNow: ['compare engine families directly'],
        currentFocus: 'engine comparison',
        cardsRole: 'none',
        leadAllowed: false,
        leadAllowedReason: 'technical comparison only',
        errorRecoveryPriority: 'answer comparison without product cards',
        confidence: 0.94
      }
    });
    const contract = deriveAgentTurnContract({
      userMessage: 'Compare Baudouin and Doosan engines',
      plan,
      needState: currentState
    });
    const frozen = assistantTestHooks.freezeSelectionContextForNonCatalogTurn(currentState, previousState, contract);

    expect(assistantTestHooks.shouldFreezeSelectionContextForNonCatalogTurn(contract)).toBe(true);
    expect(frozen.selectionState.hardConstraints.brandConstraint).toBe('TSS');
    expect(frozen.selectionState.hardConstraints.fuel).toBe('gasoline');
    expect(frozen.semanticMemory).toBe(previousState.semanticMemory);
    expect(frozen.explicitNeeds).toBe(currentState.explicitNeeds);
  });

  it('preserves LLM-extracted brand and fuel constraints when a later planner omits them', async () => {
    const products = [
      product('tss-8', 'TSS SGG 9000ELA gasoline generator 8.0 kW 230 V single phase', { voltage: '230 V', nominalPower: '8.0 kW' }, 'TSS'),
      product('tss-10', 'TSS SGG 10000EHA gasoline generator 10.0 kW 230 V single phase', { voltage: '230 V', nominalPower: '10.0 kW' }, 'TSS'),
      product('other-8', 'Energo gasoline generator 8.0 kW 230 V single phase', { voltage: '230 V', nominalPower: '8.0 kW' }, 'Energo'),
      product('tss-diesel', 'TSS diesel generator 9.0 kW 230 V single phase', { voltage: '230 V', nominalPower: '9.0 kW', fuel: 'diesel' }, 'TSS')
    ];
    const currentSelection = mergeProductSelectionState(emptyNeedState().selectionState, {
      semanticSource: 'llm_need_extraction',
      currentProductClass: 'generator',
      targetProductClass: 'generator',
      hardConstraints: {
        ...emptyNeedState().selectionState.hardConstraints,
        productIntent: 'generator',
        productRole: 'coreProduct',
        fuel: 'gasoline',
        singlePhase220: true,
        brandConstraint: 'TSS',
        nominalPowerKwMin: 8,
        nominalPowerKwMax: 10,
        provenance: {
          fuel: 'explicit_user',
          singlePhase220: 'explicit_user',
          brandConstraint: 'explicit_user',
          nominalPowerKwMin: 'explicit_user',
          nominalPowerKwMax: 'explicit_user'
        }
      },
      confidence: 0.95
    });
    const plan = rawPlan({
      action: 'answer_question',
      answerMode: 'short',
      cardPolicy: 'textOnly',
      catalogSearchQuery: 'generators 8-10 kW',
      requiredProductTraits: {
        productIntent: 'generator',
        productRole: 'coreProduct',
        fuel: 'unknown',
        startType: 'unknown',
        enclosure: 'unknown',
        conventionalGenerator: null,
        singlePhase220: null,
        budgetMax: null,
        weightKgMin: null,
        weightKgMax: null,
        diameterMmMin: null,
        diameterMmMax: null,
        nominalPowerKwMin: 8,
        nominalPowerKwMax: 10,
        maxPowerKwMin: null,
        maxPowerKwMax: null,
        powerReasoning: 'range preserved from semantic memory'
      },
      selectionState: {
        currentProductClass: 'generator',
        targetProductClass: 'generator',
        compatibilityTargetProduct: '',
        mustHaveTraits: [],
        niceToHaveTraits: [],
        excludedClasses: [],
        brandConstraint: '',
        exactModelConstraint: '',
        isAccessoryFollowUp: false,
        selectionConfidence: 0.82,
        shouldShowCards: false,
        cardDisplayMode: 'none'
      },
      agentDecision: {
        answerTask: 'mixed',
        taskType: 'pure_availability',
        catalogAction: 'verify_catalog_absence',
        commercialAction: 'explain_manager_required',
        productCardsPolicy: 'none',
        mustAnswerNow: ['answer from catalog matches if any exist'],
        currentFocus: 'generator',
        cardsRole: 'none',
        leadAllowed: true,
        leadAllowedReason: 'availability needs manager verification',
        errorRecoveryPriority: 'do not claim absence before catalog validation',
        confidence: 0.88
      }
    });
    const assistant = new AssistantService(undefined as never, new FakeProducts(products) as never);
    const contract = deriveAgentTurnContract({
      userMessage: 'What is available from 8 to 10 kW?',
      plan,
      needState: { ...emptyNeedState(), selectionState: currentSelection }
    });
    const selection = await assistant.selectProductsForTurn(
      'What is available from 8 to 10 kW?',
      { ...emptyNeedState(), selectionState: currentSelection },
      plan,
      products,
      assistantTestHooks.resolveTurnContractForPlan(plan),
      undefined,
      '',
      { forceCatalogVerification: contract.catalogAction !== 'none' }
    );

    expect(selection.visibleProducts.map((item) => item.id)).toEqual(expect.arrayContaining(['tss-8', 'tss-10']));
    expect(selection.visibleProducts.map((item) => item.id)).not.toContain('other-8');
    expect(selection.visibleProducts.map((item) => item.id)).not.toContain('tss-diesel');
    const hardTrace = selection.trace.hardConstraints as { brandConstraint?: string; fuel?: string };
    expect(hardTrace.brandConstraint).toBe('TSS');
    expect(hardTrace.fuel).toBe('gasoline');
    expect(assistantTestHooks.shouldPromoteCatalogFactCheckedCards(contract, plan, selection, false)).toBe(false);
  });

  it('does not add out-of-range alternatives when the LLM selection policy is strict catalog matches only', async () => {
    const products = [
      product('tss-7', 'TSS SGG 7000Ei gasoline generator 7.0 kW 230 V single phase', { voltage: '230 V', nominalPower: '7.0 kW' }, 'TSS'),
      product('tss-7-8', 'TSS SGG 8000EHNA gasoline generator 7.8 kW 230 V single phase', { voltage: '230 V', nominalPower: '7.8 kW' }, 'TSS'),
      product('tss-8', 'TSS SGG 9000ELA gasoline generator 8.0 kW 230 V single phase', { voltage: '230 V', nominalPower: '8.0 kW' }, 'TSS'),
      product('tss-9', 'TSS SGG 10000EI gasoline generator 9.0 kW 230 V single phase', { voltage: '230 V', nominalPower: '9.0 kW' }, 'TSS'),
      product('tss-10', 'TSS SGG 10000EHA gasoline generator 10.0 kW 230 V single phase', { voltage: '230 V', nominalPower: '10.0 kW' }, 'TSS'),
      product('tss-12', 'TSS SGG 12000EHLA gasoline generator 12.0 kW 230 V single phase', { voltage: '230 V', nominalPower: '12.0 kW' }, 'TSS')
    ];
    const selectionState = mergeProductSelectionState(emptyNeedState().selectionState, {
      semanticSource: 'llm_need_extraction',
      currentProductClass: 'generator',
      targetProductClass: 'generator',
      hardConstraints: {
        ...emptyNeedState().selectionState.hardConstraints,
        productIntent: 'generator',
        productRole: 'coreProduct',
        fuel: 'gasoline',
        singlePhase220: true,
        brandConstraint: 'TSS',
        nominalPowerKwMin: 8,
        nominalPowerKwMax: 10,
        provenance: {
          fuel: 'explicit_user',
          singlePhase220: 'explicit_user',
          brandConstraint: 'explicit_user',
          nominalPowerKwMin: 'explicit_user',
          nominalPowerKwMax: 'explicit_user'
        }
      },
      confidence: 0.95
    });
    const semanticMemory: CustomerNeedState['semanticMemory'] = {
      ...emptyNeedState().semanticMemory,
      activeRequirementIds: ['power-8-10'],
      requirements: [
        {
          id: 'power-8-10',
          kind: 'powerKw',
          value: { min: 8, max: 10, unit: 'kW', text: '8-10 kW', productClass: 'generator' },
          status: 'active',
          strictness: 'targetRange',
          evidence: 'buyer asked what exists in catalog from 8 to 10 kW',
          source: 'explicit_user',
          replacesRequirementIds: [],
          updatedAt: '2026-05-13T00:00:00.000Z'
        }
      ],
      selectionPolicy: {
        primaryRequirementIds: ['power-8-10'],
        alternativeMode: 'none',
        explanationRequired: false
      }
    };
    const plan = rawPlan({
      action: 'recommend_products',
      answerMode: 'productRecommendation',
      cardPolicy: 'showProducts',
      catalogSearchQuery: 'TSS gasoline generator 8-10 kW 220 V',
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
        nominalPowerKwMax: 10,
        maxPowerKwMin: null,
        maxPowerKwMax: null,
        powerReasoning: 'buyer asked for catalog matches in a strict range'
      },
      selectionState: {
        currentProductClass: 'generator',
        targetProductClass: 'generator',
        compatibilityTargetProduct: '',
        mustHaveTraits: [],
        niceToHaveTraits: [],
        excludedClasses: [],
        brandConstraint: 'TSS',
        exactModelConstraint: '',
        isAccessoryFollowUp: false,
        selectionConfidence: 0.95,
        shouldShowCards: true,
        cardDisplayMode: 'structured_selection'
      },
      agentDecision: {
        answerTask: 'product_selection',
        taskType: 'product_selection',
        catalogAction: 'find_matching_products',
        commercialAction: 'none',
        productCardsPolicy: 'show_matching_products',
        mustAnswerNow: ['show catalog matches inside the requested range only'],
        currentFocus: 'generator',
        cardsRole: 'primary',
        leadAllowed: false,
        leadAllowedReason: 'buyer asked to show catalog variants only',
        errorRecoveryPriority: 'do not add neighboring powers as matching cards',
        confidence: 0.95
      }
    });
    const contract = deriveAgentTurnContract({
      userMessage: 'What TSS gasoline generators from 8 to 10 kW 220 V are in catalog?',
      plan,
      needState: { ...emptyNeedState(), selectionState, semanticMemory }
    });
    const assistant = new AssistantService(undefined as never, new FakeProducts(products) as never);
    const selection = await assistant.selectProductsForTurn(
      'What TSS gasoline generators from 8 to 10 kW 220 V are in catalog?',
      { ...emptyNeedState(), selectionState, semanticMemory },
      applyAgentTurnContractToPlan(plan, contract),
      products,
      assistantTestHooks.resolveTurnContractForPlan(plan),
      undefined,
      '',
      { forceCatalogVerification: true }
    );

    const trace = selection.trace as {
      catalogShortlistAlternativeIds: string[];
      semanticMemory: { alternativeMode: string; strictOnly: boolean };
    };

    expect(selection.visibleProducts.map((item) => item.id)).toEqual(['tss-8', 'tss-9', 'tss-10']);
    expect(trace.catalogShortlistAlternativeIds).toEqual([]);
    expect(selection.visibleProducts.map((item) => item.id)).not.toContain('tss-7-8');
    expect(trace.semanticMemory.alternativeMode).toBe('none');
    expect(trace.semanticMemory.strictOnly).toBe(true);
  });

  it('revalidates recovered cards against the current range before rendering', async () => {
    const products = [
      product('tss-8', 'TSS SGG 9000ELA gasoline generator 8.0 kW 230 V single phase', { voltage: '230 V', nominalPower: '8.0 kW' }),
      product('tss-10', 'TSS SGG 10000EHA gasoline generator 10.0 kW 230 V single phase', { voltage: '230 V', nominalPower: '10.0 kW' }),
      product('tss-12', 'TSS SGG 12000EHLA gasoline generator 12.0 kW 230 V single phase', { voltage: '230 V', nominalPower: '12.0 kW' })
    ];
    const selectionState = mergeProductSelectionState(emptyNeedState().selectionState, {
      currentProductClass: 'generator',
      targetProductClass: 'generator',
      hardConstraints: {
        ...emptyNeedState().selectionState.hardConstraints,
        productIntent: 'generator',
        productRole: 'coreProduct',
        fuel: 'gasoline',
        singlePhase220: true,
        brandConstraint: 'TSS',
        nominalPowerKwMin: 8,
        nominalPowerKwMax: 10,
        provenance: {
          fuel: 'explicit_user',
          singlePhase220: 'explicit_user',
          brandConstraint: 'explicit_user',
          nominalPowerKwMin: 'explicit_user',
          nominalPowerKwMax: 'explicit_user'
        }
      },
      selectedProductIds: ['tss-10', 'tss-12'],
      matchedProductIds: ['tss-10', 'tss-12'],
      confidence: 0.95
    });
    const assistant = new AssistantService(undefined as never, new FakeProducts(products) as never);
    const recovered = await (assistant as unknown as {
      productCardsFromRecoveredSelection: (state: ReturnType<typeof emptyNeedState>, userMessage: string) => Promise<{ cards: Array<{ id: string }> }>;
    }).productCardsFromRecoveredSelection(
      { ...emptyNeedState(), selectionState },
      'What is available from 8 to 10 kW?'
    );

    expect(recovered.cards.map((card) => card.id)).toEqual(expect.arrayContaining(['tss-8', 'tss-10']));
    expect(recovered.cards.map((card) => card.id)).not.toContain('tss-12');
  });

  it('lets the latest user 220 V phrase override planner text that mentions 220/380 alternatives', async () => {
    const products = [
      product('tss-e3ui', 'TSS SGG 11000E3Ui gasoline generator 10.0 kW', { voltage: '220/380 V', nominalPower: '10.0 kW' }),
      product('tss-eh3a', 'TSS SGG 10000EH3A gasoline generator 10.0 kW', { voltage: '220/380 V', nominalPower: '10.0 kW' }),
      product('tss-eha', 'TSS SGG 10000EHA gasoline generator 10.0 kW 230 V single phase', { voltage: '230 V', nominalPower: '10.0 kW' })
    ];
    const previousSelection = mergeProductSelectionState(emptyNeedState().selectionState, {
      currentProductClass: 'generator',
      targetProductClass: 'generator',
      hardConstraints: {
        ...emptyNeedState().selectionState.hardConstraints,
        productIntent: 'generator',
        productRole: 'coreProduct',
        fuel: 'gasoline',
        brandConstraint: 'TSS',
        nominalPowerKwMin: 10,
        provenance: {
          fuel: 'planner',
          brandConstraint: 'planner',
          nominalPowerKwMin: 'planner'
        }
      }
    });
    const plan = rawPlan({
      action: 'recommend_products',
      answerMode: 'productRecommendation',
      cardPolicy: 'showProducts',
      catalogSearchQuery: ru('\u0422\u0421\u0421 \u0431\u0435\u043d\u0437\u0438\u043d\u043e\u0432\u044b\u0439 \u0433\u0435\u043d\u0435\u0440\u0430\u0442\u043e\u0440 \u043e\u043a\u043e\u043b\u043e 10 \u043a\u0412\u0442, \u043e\u0434\u043d\u043e\u0444\u0430\u0437\u043d\u044b\u0439 220 \u0412; \u0435\u0441\u043b\u0438 \u0441\u0442\u0440\u043e\u0433\u043e\u0433\u043e \u043e\u0434\u043d\u043e\u0444\u0430\u0437\u043d\u043e\u0433\u043e \u043d\u0435\u0442 - \u0443\u043d\u0438\u0432\u0435\u0440\u0441\u0430\u043b\u044c\u043d\u044b\u0435 220/380 \u043c\u043e\u0434\u0435\u043b\u0438'),
      requiredProductTraits: {
        ...rawPlan({}).requiredProductTraits,
        productIntent: 'generator',
        productRole: 'coreProduct',
        fuel: 'gasoline',
        singlePhase220: false,
        nominalPowerKwMin: 10
      },
      selectionState: {
        ...rawPlan({}).selectionState,
        currentProductClass: 'generator',
        targetProductClass: 'generator',
        brandConstraint: 'TSS',
        mustHaveTraits: [ru('\u043e\u0434\u043d\u043e\u0444\u0430\u0437\u043d\u044b\u0439 220 \u0412')]
      },
      agentDecision: {
        answerTask: 'product_selection',
        taskType: 'product_selection',
        catalogAction: 'find_matching_products',
        productCardsPolicy: 'show_matching_products',
        mustAnswerNow: [ru('\u0443\u0442\u043e\u0447\u043d\u0438\u0442\u044c, \u043f\u043e\u0434\u043e\u0439\u0434\u0443\u0442 \u043b\u0438 220/380 \u043c\u043e\u0434\u0435\u043b\u0438')],
        currentFocus: 'generator',
        cardsRole: 'supporting',
        leadAllowed: false,
        leadAllowedReason: 'selection turn',
        errorRecoveryPriority: 'respect latest explicit user phase',
        confidence: 0.6
      }
    });
    const assistant = new AssistantService(undefined as never, new FakeProducts(products) as never);
    const result = await assistant.selectProductsForTurn(
      ru('\u041d\u0443\u0436\u0435\u043d 220 \u0412, \u043e\u0434\u043d\u043e\u0444\u0430\u0437\u043d\u044b\u0439.'),
      { ...emptyNeedState(), selectionState: previousSelection },
      plan,
      products,
      assistantTestHooks.resolveTurnContractForPlan(plan)
    );

    expect(result.state.hardConstraints.singlePhase220).toBe(true);
    expect(result.state.hardConstraints.provenance?.singlePhase220).toBe('explicit_user');
    expect(result.visibleProducts.map((item) => item.id)).toContain('tss-eha');
    expect(result.visibleProducts.map((item) => item.id)).not.toContain('tss-e3ui');
    expect(result.visibleProducts.map((item) => item.id)).not.toContain('tss-eh3a');
  });

  it('does not inherit a "two models" comparison as a later product card limit', () => {
    expect(assistantTestHooks.requestedVisibleCardLimitFromText(
      ru('\u0421\u0440\u0430\u0432\u043d\u0438\u0442\u0435 \u0434\u0432\u0435 \u043c\u043e\u0434\u0435\u043b\u0438 \u0434\u0432\u0438\u0433\u0430\u0442\u0435\u043b\u044c \u0431\u0430\u0434\u0443\u0438\u043d \u0438 \u0434\u0443\u0441\u0430\u043d')
    )).toBeUndefined();
    expect(assistantTestHooks.requestedVisibleCardLimitFromText(
      ru('\u041f\u043e\u043a\u0430\u0436\u0438\u0442\u0435 2 \u0432\u0430\u0440\u0438\u0430\u043d\u0442\u0430, \u0431\u0435\u0437 \u0434\u043b\u0438\u043d\u043d\u043e\u0433\u043e \u0441\u043f\u0438\u0441\u043a\u0430')
    )).toBe(2);
  });

  it('does not use proactive commercial fallback for catalog availability selection', () => {
    const contract: AgentTurnContract = {
      answerTask: 'product_selection',
      taskType: 'product_selection_with_availability',
      catalogAction: 'find_matching_products',
      commercialAction: 'explain_manager_required',
      productCardsPolicy: 'show_matching_products',
      mustAnswerNow: [],
      activeNeeds: [],
      currentFocus: 'generator',
      cardsRole: 'supporting',
      leadAllowed: false,
      leadAllowedReason: 'selection first',
      errorRecoveryPriority: 'answer catalog availability',
      validatorWarnings: []
    };

    expect(assistantTestHooks.shouldUseProactiveCommercialDeterministicAnswer(
      contract,
      ru('\u0410 \u0447\u0442\u043e \u0435\u0441\u0442\u044c \u0432 \u043d\u0430\u043b\u0438\u0447\u0438\u0438 \u043e\u0442 8 \u0434\u043e 10 \u043a\u0412\u0442?')
    )).toBe(false);
    expect(assistantTestHooks.shouldUseProactiveCommercialDeterministicAnswer(
      { ...contract, taskType: 'product_selection_with_delivery' },
      ru('\u0410 \u0434\u043e\u0441\u0442\u0430\u0432\u043a\u0430 \u0438 \u0441\u043a\u0438\u0434\u043a\u0430 \u0435\u0441\u0442\u044c? \u0418 \u043f\u0440\u0438\u043c\u0435\u0440\u043d\u043e \u0441\u0443\u043c\u043c\u0430?')
    )).toBe(true);
  });

  it('adds concrete model names to availability answers when the LLM only says it sees positions', () => {
    const products = [
      product('e3ui', 'TSS SGG 11000E3Ui gasoline generator 10.0 kW', { nominalPower: '10.0 kW' }),
      product('eha', 'TSS SGG 10000EHA gasoline generator 10.0 kW', { nominalPower: '10.0 kW' }),
      product('eh3a', 'TSS SGG 10000EH3A gasoline generator 10.0 kW', { nominalPower: '10.0 kW' })
    ];
    const contract: AgentTurnContract = {
      answerTask: 'product_selection',
      taskType: 'pure_availability',
      catalogAction: 'find_matching_products',
      commercialAction: 'explain_manager_required',
      productCardsPolicy: 'none',
      mustAnswerNow: [],
      activeNeeds: [],
      currentFocus: 'generator',
      cardsRole: 'none',
      leadAllowed: false,
      leadAllowedReason: 'availability check',
      errorRecoveryPriority: 'name available catalog models',
      validatorWarnings: []
    };
    const repaired = assistantTestHooks.repairAvailabilityAnswerWithCatalogModels(
      ru('\u0414\u0430, \u0432 \u043a\u0430\u0442\u0430\u043b\u043e\u0433\u0435 \u0432\u0438\u0436\u0443 3 \u043f\u043e\u0434\u0445\u043e\u0434\u044f\u0449\u0438\u0435 \u043f\u043e\u0437\u0438\u0446\u0438\u0438.'),
      contract,
      {
        state: emptyNeedState().selectionState,
        matchedProducts: products,
        visibleProducts: products,
        hiddenProducts: [],
        comparisonProducts: [],
        rejectedProducts: [],
        missingQuestions: [],
        confidence: 0.9,
        trace: {}
      }
    );

    expect(repaired).toContain('SGG 11000E3Ui');
    expect(repaired).toContain('SGG 10000EHA');
    expect(repaired).toContain('SGG 10000EH3A');
  });

  it('does not add catalog model names when estimated pump blocks generator cards', () => {
    const products = [
      product('sumec', 'SUMEC SU4500i gasoline generator 4.0 kW', { nominalPower: '4.0 kW' })
    ];
    const blockedState = mergeProductSelectionState(emptyNeedState().selectionState, {
      currentProductClass: 'generator',
      targetProductClass: 'generator',
      hardConstraints: {
        ...emptyNeedState().selectionState.hardConstraints,
        productIntent: 'generator'
      },
      loadProfile: {
        items: [{
          kind: 'pump',
          name: 'pump',
          count: 1,
          runningKw: 0.75,
          startingKw: 2,
          source: 'estimated_average',
          evidence: 'pump type and power unknown'
        }],
        confidence: 0.7,
        calculation: 'generic pump',
        totalRunningKw: 0.75,
        requiredNominalKw: 4,
        requiredStartingKw: 2,
        simultaneousStarting: false
      }
    });
    const contract: AgentTurnContract = {
      answerTask: 'product_selection',
      taskType: 'product_selection_with_availability',
      catalogAction: 'find_matching_products',
      commercialAction: 'none',
      productCardsPolicy: 'none',
      mustAnswerNow: [],
      activeNeeds: [],
      currentFocus: 'generator',
      cardsRole: 'none',
      leadAllowed: false,
      leadAllowedReason: 'pump must be clarified first',
      errorRecoveryPriority: 'do not show generator models yet',
      validatorWarnings: []
    };
    const answer = ru('\u041a\u0430\u0440\u0442\u043e\u0447\u043a\u0438 \u0433\u0435\u043d\u0435\u0440\u0430\u0442\u043e\u0440\u043e\u0432 \u043f\u043e\u043a\u0430 \u043d\u0435 \u043f\u043e\u043a\u0430\u0437\u044b\u0432\u0430\u044e: \u043d\u0430\u0441\u043e\u0441 \u0435\u0441\u0442\u044c, \u043d\u043e \u0435\u0433\u043e \u0442\u0438\u043f/\u043c\u043e\u0449\u043d\u043e\u0441\u0442\u044c \u043d\u0435\u0438\u0437\u0432\u0435\u0441\u0442\u043d\u044b.');

    expect(assistantTestHooks.repairAvailabilityAnswerWithCatalogModels(answer, contract, {
      state: blockedState,
      matchedProducts: products,
      visibleProducts: products,
      hiddenProducts: [],
      comparisonProducts: [],
      rejectedProducts: [],
      missingQuestions: [],
      confidence: 0.7,
      trace: {}
    })).toBe(answer);
  });

  it('keeps exact 10 kW availability visible slice compact', () => {
    const cards = [
      { id: 'e3ui', name: 'TSS SGG 11000E3Ui gasoline generator 10.0 kW', category: 'Generators', specs: {}, reasons: [], caveats: [], sourceUrl: 'https://example.test/e3ui' },
      { id: 'eha', name: 'TSS SGG 10000EHA gasoline generator 10.0 kW', category: 'Generators', specs: {}, reasons: [], caveats: [], sourceUrl: 'https://example.test/eha' },
      { id: 'eh3a', name: 'TSS SGG 10000EH3A gasoline generator 10.0 kW', category: 'Generators', specs: {}, reasons: [], caveats: [], sourceUrl: 'https://example.test/eh3a' },
      { id: 'tss-12', name: 'TSS SGG 12000EHLA gasoline generator 12.0 kW', category: 'Generators', specs: {}, reasons: [], caveats: [], sourceUrl: 'https://example.test/tss-12' }
    ];
    const selectionState = mergeProductSelectionState(emptyNeedState().selectionState, {
      currentProductClass: 'generator',
      targetProductClass: 'generator',
      hardConstraints: {
        ...emptyNeedState().selectionState.hardConstraints,
        productIntent: 'generator',
        nominalPowerKwMin: 10
      }
    });
    const contract: AgentTurnContract = {
      answerTask: 'product_selection',
      taskType: 'pure_availability',
      catalogAction: 'find_matching_products',
      commercialAction: 'explain_manager_required',
      productCardsPolicy: 'show_matching_products',
      mustAnswerNow: [],
      activeNeeds: [],
      currentFocus: 'generator',
      cardsRole: 'supporting',
      leadAllowed: false,
      leadAllowedReason: 'availability check',
      errorRecoveryPriority: 'show exact power first',
      validatorWarnings: []
    };

    expect(assistantTestHooks.exactAvailabilityInitialVisibleCount(7, cards, {
      state: selectionState,
      matchedProducts: cards.map((card) => ({ ...card, specs: {} })) as any,
      visibleProducts: cards.map((card) => ({ ...card, specs: {} })) as any,
      hiddenProducts: [],
      comparisonProducts: [],
      rejectedProducts: [],
      missingQuestions: [],
      confidence: 0.9,
      trace: {}
    }, contract)).toBe(3);
  });

  it('does not compact broad availability without an exact power prefix', () => {
    const cards = [
      { id: 'tss-8', name: 'TSS SGG 8000E gasoline generator 8.0 kW', category: 'Generators', specs: {}, reasons: [], caveats: [], sourceUrl: 'https://example.test/tss-8' },
      { id: 'tss-10', name: 'TSS SGG 10000EHA gasoline generator 10.0 kW', category: 'Generators', specs: {}, reasons: [], caveats: [], sourceUrl: 'https://example.test/tss-10' },
      { id: 'tss-12', name: 'TSS SGG 12000EHLA gasoline generator 12.0 kW', category: 'Generators', specs: {}, reasons: [], caveats: [], sourceUrl: 'https://example.test/tss-12' },
      { id: 'tss-15', name: 'TSS SGG 15000EH3A gasoline generator 15.0 kW', category: 'Generators', specs: {}, reasons: [], caveats: [], sourceUrl: 'https://example.test/tss-15' }
    ];
    const selectionState = mergeProductSelectionState(emptyNeedState().selectionState, {
      currentProductClass: 'generator',
      targetProductClass: 'generator',
      hardConstraints: {
        ...emptyNeedState().selectionState.hardConstraints,
        productIntent: 'generator'
      }
    });
    const contract: AgentTurnContract = {
      answerTask: 'product_selection',
      taskType: 'pure_availability',
      catalogAction: 'find_matching_products',
      commercialAction: 'explain_manager_required',
      productCardsPolicy: 'show_matching_products',
      mustAnswerNow: [],
      activeNeeds: [],
      currentFocus: 'generator',
      cardsRole: 'supporting',
      leadAllowed: false,
      leadAllowedReason: 'availability check',
      errorRecoveryPriority: 'show matching products',
      validatorWarnings: []
    };

    expect(assistantTestHooks.exactAvailabilityInitialVisibleCount(4, cards, {
      state: selectionState,
      matchedProducts: cards.map((card) => ({ ...card, specs: {} })) as any,
      visibleProducts: cards.map((card) => ({ ...card, specs: {} })) as any,
      hiddenProducts: [],
      comparisonProducts: [],
      rejectedProducts: [],
      missingQuestions: [],
      confidence: 0.9,
      trace: {}
    }, contract)).toBe(4);
  });

  it('repairs phase reconfirmation when single-phase 220 V is already explicit', () => {
    const selectionState = mergeProductSelectionState(emptyNeedState().selectionState, {
      currentProductClass: 'generator',
      targetProductClass: 'generator',
      hardConstraints: {
        ...emptyNeedState().selectionState.hardConstraints,
        productIntent: 'generator',
        singlePhase220: true,
        provenance: {
          singlePhase220: 'explicit_user'
        }
      }
    });
    const answer = [
      ru('\u0423\u0442\u043e\u0447\u043d\u044e: \u043d\u0443\u0436\u0435\u043d \u0441\u0442\u0440\u043e\u0433\u043e \u043e\u0434\u043d\u043e\u0444\u0430\u0437\u043d\u044b\u0439 220 \u0412, \u0438\u043b\u0438 \u043f\u043e\u0434\u043e\u0439\u0434\u0435\u0442 \u0443\u043d\u0438\u0432\u0435\u0440\u0441\u0430\u043b\u044c\u043d\u044b\u0439 220/380?'),
      'TSS SGG 9000ELA and TSS SGG 10000EHA match the 8-10 kW range.'
    ].join('\n\n');

    const repaired = assistantTestHooks.repairExplicitPhaseReconfirmation(answer, selectionState);

    expect(repaired).toContain(ru('\u0424\u0430\u0437\u043d\u043e\u0441\u0442\u044c \u0443\u0436\u0435 \u0437\u0430\u0444\u0438\u043a\u0441\u0438\u0440\u043e\u0432\u0430\u043b'));
    expect(repaired).toContain(ru('\u043e\u0434\u043d\u043e\u0444\u0430\u0437\u043d\u044b\u0435 220 \u0412'));
    expect(repaired).toContain('TSS SGG 9000ELA');
    expect(repaired).not.toContain(ru('\u043f\u043e\u0434\u043e\u0439\u0434\u0435\u0442 \u0443\u043d\u0438\u0432\u0435\u0440\u0441\u0430\u043b\u044c\u043d\u044b\u0439 220/380'));
  });

  it('removes three-phase explanatory detours after strict 220 V was explicit', () => {
    const selectionState = mergeProductSelectionState(emptyNeedState().selectionState, {
      currentProductClass: 'generator',
      targetProductClass: 'generator',
      hardConstraints: {
        ...emptyNeedState().selectionState.hardConstraints,
        productIntent: 'generator',
        singlePhase220: true,
        provenance: {
          singlePhase220: 'explicit_user'
        }
      }
    });
    const answer = [
      ru('\u041f\u043e\u043a\u0430\u0437\u044b\u0432\u0430\u044e \u043e\u0434\u043d\u043e\u0444\u0430\u0437\u043d\u044b\u0435 \u0422\u0421\u0421 8-10 \u043a\u0412\u0442.'),
      ru('\u0414\u043b\u044f \u0441\u0442\u0440\u043e\u0433\u043e 220 \u0412 \u043d\u0443\u0436\u0435\u043d \u0438\u043c\u0435\u043d\u043d\u043e \u043e\u0434\u043d\u043e\u0444\u0430\u0437\u043d\u044b\u0439 \u0433\u0435\u043d\u0435\u0440\u0430\u0442\u043e\u0440 - \u0442\u0440\u0435\u0445\u0444\u0430\u0437\u043d\u044b\u0439 \u0438\u043c\u0435\u0435\u0442 \u0441\u043c\u044b\u0441\u043b \u0442\u043e\u043b\u044c\u043a\u043e \u0435\u0441\u043b\u0438 \u0435\u0441\u0442\u044c 380 \u0412.'),
      'TSS SGG 9000ELA, TSS SGG 10000EI, TSS SGG 10000EHA.'
    ].join(' ');

    const repaired = assistantTestHooks.repairExplicitPhaseReconfirmation(answer, selectionState);

    expect(repaired).toContain('TSS SGG 10000EHA');
    expect(repaired).not.toContain(ru('\u0442\u0440\u0435\u0445\u0444\u0430\u0437\u043d'));
    expect(repaired).not.toContain('380');
  });

  it('keeps phase clarification when 220 V was only inferred from load context', () => {
    const selectionState = mergeProductSelectionState(emptyNeedState().selectionState, {
      currentProductClass: 'generator',
      targetProductClass: 'generator',
      hardConstraints: {
        ...emptyNeedState().selectionState.hardConstraints,
        productIntent: 'generator',
        singlePhase220: true,
        provenance: {
          singlePhase220: 'inferred_from_load'
        }
      }
    });
    const answer = ru('\u0423\u0442\u043e\u0447\u043d\u044e: \u043d\u0443\u0436\u0435\u043d \u0441\u0442\u0440\u043e\u0433\u043e \u043e\u0434\u043d\u043e\u0444\u0430\u0437\u043d\u044b\u0439 220 \u0412, \u0438\u043b\u0438 \u043f\u043e\u0434\u043e\u0439\u0434\u0435\u0442 \u0443\u043d\u0438\u0432\u0435\u0440\u0441\u0430\u043b\u044c\u043d\u044b\u0439 220/380?');

    expect(assistantTestHooks.repairExplicitPhaseReconfirmation(answer, selectionState)).toBe(answer);
  });
});
