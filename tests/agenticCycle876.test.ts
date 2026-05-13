import { describe, expect, it } from 'vitest';
import { AssistantService, assistantTestHooks } from '../src/ai/assistant.js';
import { deriveAgentTurnContract, applyAgentTurnContractToPlan } from '../src/ai/agentTurnContract.js';
import { emptyNeedState, mergeProductSelectionState } from '../src/ai/needState.js';
import type { CustomerNeedState, Product } from '../src/shared/types.js';

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
});
