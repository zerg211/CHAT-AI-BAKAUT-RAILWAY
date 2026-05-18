import { describe, expect, it } from 'vitest';
import { AssistantService, assistantTestHooks } from '../src/ai/assistant.js';
import { emptyNeedState, emptyProductSelectionState, heuristicNeedUpdate, mergeNeedState, mergeProductSelectionState } from '../src/ai/needState.js';
import { classifyProduct, fallbackDetectGeneratorEnclosureSignal, isCoreEquipment, parseBudgetMax, productMatchesRequestedBrand, requestedBrandKeysFromProducts } from '../src/ai/productClassifier.js';
import type { CustomerNeedState, ProductSelectionCriteria, SemanticMemory, SemanticRequirement } from '../src/shared/types.js';

const ru = (value: string) => JSON.parse(`"${value}"`) as string;

function product(id: string, name: string, price: number, sourceUrl: string) {
  return {
    id,
    name,
    category: name,
    sourceUrl,
    price,
    specs: {}
  };
}

function productWithSpecs(id: string, name: string, price: number, sourceUrl: string, specs: Record<string, unknown>) {
  return {
    id,
    name,
    category: name,
    sourceUrl,
    price,
    specs
  };
}

function brandedProduct(id: string, name: string, brand: string, category: string, price: number, sourceUrl: string) {
  return {
    id,
    name,
    brand,
    category,
    sourceUrl,
    price,
    specs: {}
  };
}

class FakeProducts {
  constructor(private readonly products: ReturnType<typeof product>[]) {}

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

function baseTurnPlan(overrides: Record<string, unknown> = {}) {
  return {
    action: 'recommend_products',
    answerMode: 'productRecommendation',
    cardPolicy: 'showProducts',
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
      shouldShowCards: true,
      cardDisplayMode: 'preliminary'
    },
    needsWebSearch: false,
    missingInformation: [],
    answerGuidance: '',
    ...overrides
  } as any;
}

function productSelectionAgentDecision(overrides: Record<string, unknown> = {}) {
  return {
    answerTask: 'product_selection',
    taskType: 'product_selection',
    catalogAction: 'find_matching_products',
    commercialAction: 'none',
    productCardsPolicy: 'show_matching_products',
    mustAnswerNow: ['show matching catalog products'],
    currentFocus: 'catalog_selection',
    cardsRole: 'primary',
    leadAllowed: true,
    leadAllowedReason: 'selection turn',
    errorRecoveryPriority: 'show matching catalog products',
    confidence: 0.9,
    ...overrides
  };
}

function semanticRequirement(overrides: Partial<SemanticRequirement> & Pick<SemanticRequirement, 'id' | 'kind'>): SemanticRequirement {
  return {
    value: {},
    status: 'active',
    strictness: 'targetRange',
    evidence: overrides.id,
    source: 'explicit_user',
    replacesRequirementIds: [],
    updatedAt: '2026-05-09T00:00:00.000Z',
    ...overrides
  };
}

function withSemanticMemory(state: CustomerNeedState, memory: Partial<SemanticMemory>): CustomerNeedState {
  return {
    ...state,
    semanticMemory: {
      ...emptyNeedState().semanticMemory,
      ...memory,
      selectionPolicy: {
        ...emptyNeedState().semanticMemory.selectionPolicy,
        ...(memory.selectionPolicy ?? {})
      }
    }
  };
}

async function rank(message: string, products: ReturnType<typeof product>[]) {
  const assistant = new AssistantService(undefined as never, new FakeProducts(products) as never);
  const state = mergeNeedState(emptyNeedState(), heuristicNeedUpdate(message));
  return {
    state,
    ranked: await assistant.findProducts(message, state)
  };
}

function reliableGeneratorSelectionResult(overrides: Record<string, unknown> = {}) {
  const fit = productWithSpecs('fit-generator', 'Generator gasoline inverter 2.8 kW electric start enclosed', 72_000, 'https://example.test/generators/fit/', {
    nominalPower: '2.8 kW',
    maxPower: '3.2 kW',
    start: 'electric starter'
  });
  const state = mergeProductSelectionState(emptyNeedState().selectionState, {
    currentProductClass: 'generator',
    targetProductClass: 'generator',
    hardConstraints: {
      productIntent: 'generator',
      productRole: 'coreProduct',
      exactModelTokens: [],
      mustHaveTraits: [],
      excludedClasses: [],
      nominalPowerKwMin: 2,
      nominalPowerKwMax: 3.5,
      maxPowerKwMin: 1.9,
      singlePhase220: true,
      provenance: {
        nominalPowerKwMin: 'inferred_from_load',
        nominalPowerKwMax: 'inferred_from_load',
        maxPowerKwMin: 'inferred_from_load',
        singlePhase220: 'explicit_user'
      }
    },
    loadProfile: {
      items: [{
        kind: 'boiler',
        name: 'boiler',
        count: 1,
        runningKw: 0.15,
        startingKw: 0.15,
        source: 'explicit_user',
        evidence: 'boiler 150 W'
      }],
      confidence: 0.82,
      calculation: 'boiler 150 W, refrigerator and lighting',
      totalRunningKw: 1.1,
      requiredNominalKw: 2,
      requiredStartingKw: 1.9,
      simultaneousStarting: false
    } as any,
    confidence: 0.78
  });

  return {
    state,
    matchedProducts: [fit],
    visibleProducts: [fit],
    hiddenProducts: [],
    comparisonProducts: [],
    rejectedProducts: [],
    missingQuestions: [],
    confidence: 0.78,
    trace: {
      canRecommendFromSelection: true
    },
    ...overrides
  } as any;
}

describe('recommendation ranking', () => {
  it('does not treat short brand names as substrings inside generic words', () => {
    const tor = brandedProduct('tor', 'Generator gasoline TOR KM2000is 2.0 kW', 'TOR', 'Generators', 26_540, 'https://example.test/tor/');
    const bison = brandedProduct('bison', 'Generator gasoline BISON BS2000IS 1.8 kW', 'BISON', 'Generators', 33_200, 'https://example.test/bison/');

    expect([...requestedBrandKeysFromProducts([tor, bison] as any, 'Need generator 2 kW under 30000')]).toEqual([]);
    expect([...requestedBrandKeysFromProducts([tor, bison] as any, 'Need TOR generator 2 kW')]).toEqual(['tor']);
    expect(productMatchesRequestedBrand(bison as any, new Set(['tor']))).toBe(false);
    expect(productMatchesRequestedBrand(tor as any, new Set(['tor']))).toBe(true);
  });

  it('detects enclosed generator wording when the enclosure adjective follows the product', () => {
    expect(fallbackDetectGeneratorEnclosureSignal(
      ru('\\u0427\\u0442\\u043e \\u043d\\u0435\\u0442\\u0443 \\u0437\\u0430 30 000 \\u0433\\u0435\\u043d\\u0435\\u0440\\u0430\\u0442\\u043e\\u0440\\u043e\\u0432 2 \\u043a\\u0432\\u0442 \\u0437\\u0430\\u043a\\u0440\\u044b\\u0442\\u044b\\u0445?')
    )).toBe(true);
  });

  it('classifies core machines with ambiguous kit words by product evidence, not flat blacklist terms', () => {
    const corePlate = brandedProduct(
      'plate-kit',
      ru('Виброплита бензиновая ТСС VP80 комплект'),
      ru('ТСС'),
      ru('Виброплиты'),
      100000,
      'https://example.test/plate-kit'
    );
    const coreGenerator = brandedProduct(
      'generator-kit',
      ru('Генератор бензиновый ТСС комплект'),
      ru('ТСС'),
      ru('Генераторы'),
      100000,
      'https://example.test/generator-kit'
    );
    const plateFilter = brandedProduct(
      'plate-filter',
      ru('Фильтр воздушный для виброплиты'),
      ru('ТСС'),
      ru('Запчасти для виброплит'),
      900,
      'https://example.test/plate-filter'
    );
    const plateBelt = brandedProduct(
      'plate-belt',
      ru('Ремень привода виброплиты'),
      ru('ТСС'),
      ru('Расходники и запчасти для виброплит'),
      1400,
      'https://example.test/plate-belt'
    );
    const serviceKit = brandedProduct(
      'service-kit',
      ru('Комплект сервиса K 770'),
      'Husqvarna',
      ru('Расходники'),
      7722,
      'https://example.test/service-kit'
    );

    expect(classifyProduct(corePlate)).toMatchObject({ isPlate: true, isPlateAccessory: false });
    expect(isCoreEquipment(corePlate)).toBe(true);
    expect(classifyProduct(coreGenerator)).toMatchObject({ isGenerator: true, isGeneratorAccessory: false });
    expect(isCoreEquipment(coreGenerator)).toBe(true);
    expect(classifyProduct(plateFilter)).toMatchObject({ isPlate: false, isPlateAccessory: true });
    expect(isCoreEquipment(plateFilter)).toBe(false);
    expect(classifyProduct(plateBelt)).toMatchObject({ isPlate: false, isPlateAccessory: true });
    expect(isCoreEquipment(plateBelt)).toBe(false);
    expect(isCoreEquipment(serviceKit)).toBe(false);
  });

  it('keeps planner context broad when buyer words mention both whole equipment and related spares', async () => {
    const corePlate = brandedProduct(
      'plate-core',
      ru('Виброплита бензиновая ТСС VP80'),
      ru('ТСС'),
      ru('Виброплиты'),
      68000,
      'https://example.test/plate-core'
    );
    const plateBelt = brandedProduct(
      'plate-belt',
      ru('Ремень привода виброплиты ТСС VP80'),
      ru('ТСС'),
      ru('Расходники и запчасти для виброплит'),
      1400,
      'https://example.test/plate-belt'
    );
    const assistant = new AssistantService(undefined as never, new FakeProducts([plateBelt, corePlate] as any) as never);

    const context = await assistant.findPlannerContextProducts(
      ru('Нужна виброплита VP80, и сразу ремень к ней тоже посмотрите'),
      emptyNeedState()
    );

    expect(context.map((item) => item.id)).toEqual(expect.arrayContaining(['plate-core', 'plate-belt']));
  });

  it('does not render vibroplate spares as core vibroplates when LLM asks for whole equipment', async () => {
    const corePlate = brandedProduct(
      'vibro-core',
      ru('Виброплита бензиновая TSS VP80'),
      'TSS',
      ru('Виброплиты'),
      68000,
      'https://example.test/vibro-core/'
    );
    const airFilter = brandedProduct(
      'plate-filter',
      ru('Фильтр воздушный для виброплиты TSS VP80'),
      'TSS',
      ru('Запчасти для виброплит'),
      900,
      'https://example.test/plate-filter/'
    );
    const driveBelt = brandedProduct(
      'plate-belt',
      ru('Ремень привода виброплиты TSS VP80'),
      'TSS',
      ru('Расходники и запчасти для виброплит'),
      1400,
      'https://example.test/plate-belt/'
    );
    const assistant = new AssistantService(undefined as never, new FakeProducts([airFilter, driveBelt, corePlate] as any) as never);
    const state = emptyNeedState();
    const plan = baseTurnPlan({
      catalogSearchQuery: ru('подбор целой виброплиты под задачу покупателя'),
      requiredProductTraits: {
        ...baseTurnPlan().requiredProductTraits,
        productIntent: 'plate',
        productRole: 'coreProduct'
      },
      selectionState: {
        ...baseTurnPlan().selectionState,
        currentProductClass: 'plate',
        targetProductClass: 'plate',
        selectionConfidence: 0.92,
        shouldShowCards: true,
        cardDisplayMode: 'exact_matches'
      },
      answerGuidance: ru('Покупатель просит целую виброплиту, не запчасти и не расходники.')
    });

    const result = await assistant.selectProductsForTurn(
      ru('Нужна виброплита для дорожек на участке, что взять?'),
      state,
      plan,
      [airFilter, driveBelt, corePlate] as any
    );

    expect(result.visibleProducts.map((item) => item.id)).toEqual(['vibro-core']);
    expect(result.matchedProducts.map((item) => item.id)).toEqual(['vibro-core']);
    expect((result.trace.diagnosticRejectedProducts as Array<{ productId: string }>).map((item) => item.productId)).toEqual(expect.arrayContaining(['plate-filter', 'plate-belt']));
    expect(result.state.rejectedProducts?.map((item) => item.productId) ?? []).toEqual([]);
  });

  it('keeps invalid-planner fallback text-only instead of doing keyword product routing', () => {
    const plan = assistantTestHooks.fallbackTurnPlan({
      userMessage: ru('Нужна виброплита для дорожек'),
      needState: emptyNeedState(),
      baseQuery: ru('Нужна виброплита для дорожек')
    });

    expect(plan.action).toBe('answer_question');
    expect(plan.answerMode).toBe('short');
    expect(plan.cardPolicy).toBe('textOnly');
    expect(plan.selectionState.shouldShowCards).toBe(false);
    expect(plan.selectedProductIds).toEqual([]);
    expect(plan.answerGuidance).toContain('Не делай keyword-подбор');
  });

  it('does not force fallback product cards from voltage-only evidence', async () => {
    const generator = productWithSpecs('generator-220', 'Generator gasoline 3.0 kW 220 V', 54000, 'https://example.test/generator-220/', {
      voltage: '220 V'
    });
    const assistant = new AssistantService(undefined as never, new FakeProducts([generator] as any) as never);
    const message = '220 V';
    const plan = assistantTestHooks.fallbackTurnPlan({
      userMessage: message,
      needState: emptyNeedState(),
      baseQuery: message
    });

    const result = await assistant.selectProductsForTurn(message, emptyNeedState(), plan, [generator] as any);

    expect(result.state.targetProductClass).toBe('unknown');
    expect(result.state.hardConstraints.singlePhase220).toBeUndefined();
    expect(assistantTestHooks.shouldForceStructuredSelectionCards(message, plan, result)).toBe(false);
  });

  it('rejects mixed 220/380 generators when the buyer explicitly requested strict 220 V', () => {
    const mixedVoltage = productWithSpecs('mixed-voltage', 'TSS gasoline generator 8.0 kW 220/380 V', 120000, 'https://example.test/mixed-voltage', {
      voltage: '220/380 V'
    });
    const singlePhase = productWithSpecs('single-phase', 'TSS gasoline generator 8.0 kW 220 V', 118000, 'https://example.test/single-phase', {
      voltage: '220 V'
    });
    const tssThreePhaseByModel = productWithSpecs('tss-e3', 'Генератор бензиновый ТСС SGG 10000EH3A (10,0 кВт)', 218000, 'https://example.test/tss-e3', {});
    const tssNonE3Model = productWithSpecs('tss-en', 'Генератор бензиновый ТСС SGG 3200EN Duplex (3,2 кВт)', 37217, 'https://example.test/tss-en', {});
    const selectionState = mergeProductSelectionState(emptyNeedState().selectionState, {
      currentProductClass: 'generator',
      targetProductClass: 'generator',
      hardConstraints: {
        ...emptyNeedState().selectionState.hardConstraints,
        productIntent: 'generator',
        productRole: 'coreProduct',
        fuel: 'gasoline',
        singlePhase220: true,
        provenance: {
          fuel: 'explicit_user',
          singlePhase220: 'explicit_user'
        }
      }
    });
    const profile = assistantTestHooks.buildProductFitProfile(
      { ...emptyNeedState(), selectionState },
      'Need TSS gasoline generator 8-10 kW 220 V',
      '',
      baseTurnPlan().requiredProductTraits
    );

    expect(assistantTestHooks.productSelectionHardViolation(mixedVoltage as any, selectionState, profile)).toContain('220/380');
    expect(assistantTestHooks.productSelectionHardViolation(tssThreePhaseByModel as any, selectionState, profile)).toContain('three-phase');
    expect(assistantTestHooks.productSelectionHardViolation(tssNonE3Model as any, selectionState, profile)).toBeNull();
    expect(assistantTestHooks.productSelectionHardViolation(singlePhase as any, selectionState, profile)).toBeNull();
  });

  it('does not leave concrete model names in product-recommendation text when no cards are shown', () => {
    const candidate = productWithSpecs('candidate', 'TSS SGG 8000EH3NUA gasoline generator 220/380 V', 120000, 'https://example.test/candidate', {});
    const answer = 'Подойдет TSS SGG 8000EH3NUA, это хороший вариант под ваш запрос.';
    const repaired = assistantTestHooks.repairAnswerForFinalCards(
      answer,
      [],
      [candidate] as any,
      emptyNeedState(),
      'Подберите генератор ТСС 8-10 кВт 220',
      baseTurnPlan({
        action: 'recommend_products',
        answerMode: 'productRecommendation',
        cardPolicy: 'showProducts',
        requiredProductTraits: {
          ...baseTurnPlan().requiredProductTraits,
          productIntent: 'generator',
          productRole: 'coreProduct',
          singlePhase220: true
        }
      })
    );

    expect(repaired).not.toContain('SGG 8000EH3NUA');
    expect(repaired.trim().length).toBeGreaterThan(0);
  });

  it('repairs final answer phase text when it contradicts the visible single-phase generator card', () => {
    const product = productWithSpecs(
      'tss-9000ela',
      'ТСС SGG 9000ELA бензиновый генератор 8 кВт',
      116328,
      'https://example.test/tss-sgg-9000ela/',
      {
        'напряжение': '230 В',
        'число фаз': 'однофазные',
        'мощность номинальная при 220 в': '8 кВт'
      }
    );
    const cards = [{
      id: product.id,
      name: product.name,
      category: product.category,
      price: product.price,
      currency: 'RUB',
      sourceUrl: product.sourceUrl,
      specs: product.specs,
      reasons: [],
      caveats: []
    }];
    const badAnswer = 'Ближайший вариант — ТСС SGG 9000ELA, 8 кВт. Но он трехфазный 230/400 В, не строго однофазный 220 В. Доставку до Ейска посчитаю через логистику.';

    const repaired = assistantTestHooks.repairAnswerForFinalCards(
      badAnswer,
      cards,
      [product] as any,
      emptyNeedState(),
      'Подберите ТСС 8-10 кВт 220 и посчитайте доставку до Ейска',
      baseTurnPlan({
        action: 'recommend_products',
        answerMode: 'productRecommendation',
        cardPolicy: 'showProducts',
        requiredProductTraits: {
          ...baseTurnPlan().requiredProductTraits,
          productIntent: 'generator',
          productRole: 'coreProduct',
          singlePhase220: true
        }
      })
    );

    expect(repaired).toContain('ТСС SGG 9000ELA');
    expect(repaired).toContain('однофазный 230 В');
    expect(repaired).not.toMatch(/тр[её]хфаз|230\s*\/\s*400|не\s+строго\s+однофаз/iu);
  });

  it('promotes a reliable first-turn house generator selection to product cards', async () => {
    const products = [
      productWithSpecs('fit-1', 'Generator gasoline inverter 2.8 kW electric start enclosed', 72_000, 'https://example.test/generators/fit-1/', {
        nominalPower: '2.8 kW',
        maxPower: '3.2 kW',
        start: 'electric starter'
      }),
      productWithSpecs('fit-2', 'Generator gasoline inverter 3.5 kW electric start enclosed', 92_000, 'https://example.test/generators/fit-2/', {
        nominalPower: '3.5 kW',
        maxPower: '4.0 kW',
        start: 'electric starter'
      }),
      productWithSpecs('oversized', 'Generator gasoline 8.0 kW electric start', 140_000, 'https://example.test/generators/oversized/', {
        nominalPower: '8.0 kW'
      })
    ];
    const assistant = new AssistantService(undefined as never, new FakeProducts(products) as never);
    const message = ru('\\u041d\\u0443\\u0436\\u0435\\u043d \\u0431\\u0435\\u043d\\u0437\\u0438\\u043d\\u043e\\u0432\\u044b\\u0439 \\u0433\\u0435\\u043d\\u0435\\u0440\\u0430\\u0442\\u043e\\u0440 \\u0434\\u043b\\u044f \\u0434\\u043e\\u043c\\u0430 220 \\u0412: \\u043a\\u043e\\u0442\\u0435\\u043b 150 \\u0412\\u0442, \\u0445\\u043e\\u043b\\u043e\\u0434\\u0438\\u043b\\u044c\\u043d\\u0438\\u043a \\u0438 \\u0441\\u0432\\u0435\\u0442. \\u0412\\u0430\\u0436\\u043d\\u043e, \\u0447\\u0442\\u043e\\u0431\\u044b \\u0436\\u0435\\u043d\\u0430 \\u0437\\u0430\\u043f\\u0443\\u0441\\u043a\\u0430\\u043b\\u0430 \\u043a\\u043d\\u043e\\u043f\\u043a\\u043e\\u0439 \\u0438 \\u0431\\u044b\\u043b\\u043e \\u043d\\u0435 \\u043e\\u0447\\u0435\\u043d\\u044c \\u0448\\u0443\\u043c\\u043d\\u043e.');
    const plan = baseTurnPlan({
      action: 'answer_question',
      answerMode: 'short',
      cardPolicy: 'auto',
      agentDecision: productSelectionAgentDecision(),
      requiredProductTraits: {
        ...baseTurnPlan().requiredProductTraits,
        productIntent: 'generator',
        productRole: 'coreProduct',
        fuel: 'gasoline',
        singlePhase220: true,
        nominalPowerKwMin: 2.5,
        nominalPowerKwMax: 4
      },
      selectionState: {
        ...baseTurnPlan().selectionState,
        shouldShowCards: false,
        cardDisplayMode: 'none'
      }
    });

    const result = await assistant.selectProductsForTurn(message, emptyNeedState(), plan, products as any);

    expect(result.trace.canRecommendFromSelection).toBe(true);
    expect(result.visibleProducts.map((item) => item.id)).toEqual(['fit-1', 'fit-2']);
    expect(assistantTestHooks.selectionResultCanDriveCards(plan, result, message)).toBe(true);
    expect(assistantTestHooks.shouldForceStructuredSelectionCards(message, plan, result)).toBe(true);
  });

  it('promotes reliable selection cards when a non-blocking clarification plan says text-only', () => {
    const result = reliableGeneratorSelectionResult();
    const basePlan = baseTurnPlan();
    const message = ru('\\u041d\\u0443\\u0436\\u0435\\u043d \\u0431\\u0435\\u043d\\u0437\\u0438\\u043d\\u043e\\u0432\\u044b\\u0439 \\u0433\\u0435\\u043d\\u0435\\u0440\\u0430\\u0442\\u043e\\u0440 \\u0434\\u043b\\u044f \\u0434\\u043e\\u043c\\u0430 220 \\u0412: \\u043a\\u043e\\u0442\\u0435\\u043b, \\u0445\\u043e\\u043b\\u043e\\u0434\\u0438\\u043b\\u044c\\u043d\\u0438\\u043a, \\u0441\\u0432\\u0435\\u0442, \\u0437\\u0430\\u043f\\u0443\\u0441\\u043a \\u043a\\u043d\\u043e\\u043f\\u043a\\u043e\\u0439 \\u0438 \\u043f\\u043e\\u0442\\u0438\\u0448\\u0435.');
    const plan = baseTurnPlan({
      action: 'ask_clarifying_question',
      answerMode: 'short',
      cardPolicy: 'showProducts',
      agentDecision: productSelectionAgentDecision(),
      followUpPolicy: 'askClarifyingQuestion',
      missingInformation: [ru('\\u041a\\u043d\\u043e\\u043f\\u043a\\u0430 \\u0441\\u0442\\u0440\\u043e\\u0433\\u043e \\u043e\\u0431\\u044f\\u0437\\u0430\\u0442\\u0435\\u043b\\u044c\\u043d\\u0430?')],
      requiredProductTraits: {
        ...basePlan.requiredProductTraits,
        productIntent: 'generator',
        startType: 'electric',
        singlePhase220: true
      },
      selectionState: {
        ...basePlan.selectionState,
        shouldShowCards: false,
        cardDisplayMode: 'none'
      }
    });

    expect(assistantTestHooks.selectionResultCanDriveCards(plan, result, message)).toBe(true);
    expect(assistantTestHooks.shouldForceStructuredSelectionCards(message, plan, result)).toBe(true);
  });

  it('does not turn refrigerator startup context into an electric-start generator constraint', async () => {
    const enclosureKey = ru('\\u0442\\u0438\\u043f \\u043a\\u043e\\u0436\\u0443\\u0445\\u0430');
    const enclosed = ru('\\u0417\\u0430\\u043a\\u0440\\u044b\\u0442\\u044b\\u0439');
    const tor = productWithSpecs('tor-km2000is', 'Generator gasoline TOR KM2000is 2.0 kW inverter', 26_540, 'https://example.test/tor-km2000is/', {
      [enclosureKey]: enclosed
    });
    const assistant = new AssistantService(undefined as never, new FakeProducts([tor] as any) as never);
    const state = mergeNeedState(emptyNeedState(), {
      selectionState: mergeProductSelectionState(emptyNeedState().selectionState, {
        currentProductClass: 'generator',
        targetProductClass: 'generator',
        rankingPreference: 'cheapest',
        hardConstraints: {
          productIntent: 'generator',
          productRole: 'coreProduct',
          exactModelTokens: [],
          exactModelTokenRoles: [],
          mustHaveTraits: [],
          excludedClasses: [],
          fuel: 'gasoline',
          enclosure: 'enclosed',
          singlePhase220: true,
          budgetMax: 30000,
          nominalPowerKwMin: 2,
          nominalPowerKwMax: 2.5,
          provenance: {
            fuel: 'planner',
            enclosure: 'explicit_user',
            singlePhase220: 'explicit_user',
            budgetMax: 'explicit_user',
            nominalPowerKwMin: 'explicit_user',
            nominalPowerKwMax: 'explicit_user'
          }
        } as any
      })
    });
    const plan = baseTurnPlan({
      action: 'answer_question',
      answerMode: 'short',
      cardPolicy: 'auto',
      requiredProductTraits: {
        ...baseTurnPlan().requiredProductTraits,
        productIntent: 'generator',
        productRole: 'coreProduct',
        fuel: 'gasoline',
        startType: 'electric',
        enclosure: 'enclosed',
        singlePhase220: true,
        budgetMax: 30000,
        nominalPowerKwMin: 2,
        nominalPowerKwMax: 2.5
      },
      selectionState: {
        ...baseTurnPlan().selectionState,
        currentProductClass: 'generator',
        targetProductClass: 'generator'
      }
    });
    const message = ru('\\u041d\\u0435\\u0442, \\u0431\\u044e\\u0434\\u0436\\u0435\\u0442 \\u0434\\u043e 30 \\u0442\\u043e\\u0447\\u043d\\u043e, \\u0445\\u043e\\u043b\\u043e\\u0434\\u0438\\u043b\\u044c\\u043d\\u0438\\u043a \\u0443 \\u043c\\u0435\\u043d\\u044f LG GA-B509MLSL, \\u0445\\u043e\\u0447\\u0443 \\u0447\\u0442\\u043e\\u0431\\u044b \\u0441\\u0442\\u0430\\u0440\\u0442\\u043e\\u0432\\u0430\\u043b \\u043d\\u043e\\u0440\\u043c\\u0430\\u043b\\u044c\\u043d\\u043e.');

    const result = await assistant.selectProductsForTurn(message, state, plan, [tor] as any);

    expect(assistantTestHooks.hasExplicitGeneratorElectricStartNeed(message)).toBe(false);
    expect(result.state.hardConstraints.startType).toBeUndefined();
    expect(result.visibleProducts.map((item) => item.id)).toEqual(['tor-km2000is']);
  });

  it('clears stale electric-start constraints when user evidence only talks about load startup', async () => {
    const enclosureKey = ru('\\u0442\\u0438\\u043f \\u043a\\u043e\\u0436\\u0443\\u0445\\u0430');
    const enclosed = ru('\\u0417\\u0430\\u043a\\u0440\\u044b\\u0442\\u044b\\u0439');
    const products = [
      productWithSpecs('tor-km2000is', 'Generator gasoline TOR KM2000is 2.0 kW inverter enclosed manual', 26_540, 'https://example.test/tor-km2000is/', { [enclosureKey]: enclosed }),
      productWithSpecs('firman-open-electric', 'Generator gasoline FIRMAN RD2910E1 2.0 kW electric start open frame', 26_990, 'https://example.test/firman-rd2910e1/', {}),
      productWithSpecs('tor-km2000ie-electric', 'Generator gasoline TOR KM2000ie electric starter 2.0 kW inverter', 34_500, 'https://example.test/tor-km2000ie/', { [enclosureKey]: enclosed })
    ];
    const assistant = new AssistantService(undefined as never, new FakeProducts(products) as never);
    const state = mergeNeedState(emptyNeedState(), {
      selectionState: mergeProductSelectionState(emptyNeedState().selectionState, {
        currentProductClass: 'generator',
        targetProductClass: 'generator',
        hardConstraints: {
          productIntent: 'generator',
          productRole: 'coreProduct',
          exactModelTokens: [],
          exactModelTokenRoles: [
            { role: 'compatibilityTarget', value: 'GA-B509MLSL', evidence: ru('\\u041d\\u0435\\u0442 \\u0431\\u044e\\u0434\\u0436\\u0435\\u0442 \\u0434\\u043e 30 \\u0442\\u043e\\u0447\\u043d\\u043e, \\u0445\\u043e\\u043b\\u043e\\u0434\\u0438\\u043b\\u044c\\u043d\\u0438\\u043a LG GA-B509MLSL') }
          ],
          mustHaveTraits: [],
          excludedClasses: [],
          budgetMax: 30000,
          startType: 'electric',
          nominalPowerKwMin: 1.8,
          nominalPowerKwMax: 2.2,
          singlePhase220: true,
          provenance: {
            budgetMax: 'planner',
            startType: 'explicit_user',
            nominalPowerKwMin: 'planner',
            nominalPowerKwMax: 'planner',
            singlePhase220: 'planner'
          }
        } as any
      })
    });
    const plan = baseTurnPlan({
      action: 'recommend_products',
      answerMode: 'productRecommendation',
      cardPolicy: 'showProducts',
      selectedProductIds: ['firman-open-electric'],
      requiredProductTraits: {
        ...baseTurnPlan().requiredProductTraits,
        productIntent: 'generator',
        productRole: 'coreProduct',
        fuel: 'gasoline',
        startType: 'electric',
        enclosure: 'unknown',
        singlePhase220: true,
        budgetMax: 30000,
        nominalPowerKwMin: 1.8,
        nominalPowerKwMax: 2.2,
        maxPowerKwMin: 2,
        maxPowerKwMax: 2.5,
        provenance: {
          startType: 'explicit_user'
        }
      },
      selectionState: {
        ...baseTurnPlan().selectionState,
        currentProductClass: 'generator',
        targetProductClass: 'generator',
        shouldShowCards: true,
        cardDisplayMode: 'structured_selection'
      }
    });
    const message = ru('\\u0427\\u0442\\u043e \\u043d\\u0435\\u0442\\u0443 \\u0437\\u0430 30 000 \\u0433\\u0435\\u043d\\u0435\\u0440\\u0430\\u0442\\u043e\\u0440\\u043e\\u0432 2 \\u043a\\u0432\\u0442 \\u0437\\u0430\\u043a\\u0440\\u044b\\u0442\\u044b\\u0445?');
    const conversationUserText = [
      ru('\\u043d\\u0443\\u0436\\u0435\\u043d \\u0433\\u0435\\u043d\\u0435\\u0440\\u0430\\u0442\\u043e\\u0440'),
      ru('\\u0431\\u0443\\u0434\\u0443 \\u043f\\u043e\\u0434\\u043a\\u043b\\u044e\\u0447\\u0430\\u0442\\u044c \\u0445\\u043e\\u043b\\u043e\\u0434\\u0438\\u043b\\u044c\\u043d\\u0438\\u043a \\u0438 \\u0441\\u0432\\u0435\\u0442, \\u043d\\u0443\\u0436\\u0435\\u043d \\u0442\\u0438\\u0445\\u0438\\u0439 \\u043d\\u0435\\u0431\\u043e\\u043b\\u044c\\u0448\\u043e\\u0439 \\u0438 \\u043d\\u0435\\u0434\\u043e\\u0440\\u043e\\u0433\\u043e\\u0439 \\u0442\\u044b\\u0441\\u044f\\u0447 \\u0434\\u043e 30, 220'),
      ru('\\u041d\\u0435\\u0442 \\u0431\\u044e\\u0434\\u0436\\u0435\\u0442 \\u0434\\u043e 30 \\u0442\\u043e\\u0447\\u043d\\u043e,\\u0445\\u043e\\u043b\\u043e\\u0434\\u0438\\u043b\\u044c\\u043d\\u0438\\u043a \\u0443 \\u043c\\u0435\\u043d\\u044f LG GA-B509MLSL')
    ].join(' ');

    const result = await assistant.selectProductsForTurn(message, state, plan, products as any, undefined, undefined, conversationUserText);

    expect(result.state.hardConstraints.startType).toBeUndefined();
    expect(result.state.hardConstraints.enclosure).toBe('enclosed');
    expect(result.visibleProducts.map((item) => item.id)[0]).toBe('tor-km2000is');
    expect(result.visibleProducts.map((item) => item.id)).not.toContain('firman-open-electric');
  });

  it('uses catalog availability turns to show exact matches and nearest alternatives despite text-only currentLineup plans', async () => {
    const enclosureKey = ru('\\u0442\\u0438\\u043f \\u043a\\u043e\\u0436\\u0443\\u0445\\u0430');
    const enclosed = ru('\\u0417\\u0430\\u043a\\u0440\\u044b\\u0442\\u044b\\u0439');
    const products = [
      productWithSpecs('tor-km2000is', 'Generator gasoline TOR KM2000is 2.0 kW inverter', 26_540, 'https://example.test/tor-km2000is/', { [enclosureKey]: enclosed }),
      productWithSpecs('sunreka-g1800is', 'Generator gasoline SUNREKA G1800iS 1.6 kW inverter', 32_060, 'https://example.test/sunreka-g1800is/', { [enclosureKey]: enclosed }),
      productWithSpecs('bison-bs2000is', 'Generator gasoline BISON BS2000IS 1.8 kW inverter', 33_200, 'https://example.test/bison-bs2000is/', { [enclosureKey]: enclosed }),
      productWithSpecs('bison-bs2500is', 'Generator gasoline BISON BS2500IS 2.3 kW inverter', 35_200, 'https://example.test/bison-bs2500is/', { [enclosureKey]: enclosed }),
      productWithSpecs('tss-sgg-2400si', 'Generator gasoline TSS SGG 2400SI 2.0 kW inverter', 39_728, 'https://example.test/tss-sgg-2400si/', { [enclosureKey]: enclosed }),
      productWithSpecs('hnd-ge2200ji', 'Generator gasoline HND GE2200Ji 2.0 kW inverter', 52_900, 'https://example.test/hnd-ge2200ji/', { [enclosureKey]: enclosed }),
      productWithSpecs('open-aipower', 'Generator gasoline A-iPower LITE AP2200 2.0 kW open frame', 25_490, 'https://example.test/open-aipower/', {})
    ];
    const assistant = new AssistantService(undefined as never, new FakeProducts(products) as never);
    const state = mergeNeedState(emptyNeedState(), {
      selectionState: mergeProductSelectionState(emptyNeedState().selectionState, {
        currentProductClass: 'generator',
        targetProductClass: 'generator',
        rankingPreference: 'cheapest',
        hardConstraints: {
          productIntent: 'generator',
          productRole: 'coreProduct',
          exactModelTokens: [],
          exactModelTokenRoles: [],
          mustHaveTraits: [],
          excludedClasses: [],
          fuel: 'gasoline',
          enclosure: 'enclosed',
          singlePhase220: true,
          budgetMax: 30000,
          nominalPowerKwMin: 2,
          nominalPowerKwMax: 2.5,
          provenance: {
            fuel: 'planner',
            enclosure: 'explicit_user',
            singlePhase220: 'explicit_user',
            budgetMax: 'explicit_user',
            nominalPowerKwMin: 'explicit_user',
            nominalPowerKwMax: 'explicit_user'
          }
        } as any
      })
    });
    const plan = baseTurnPlan({
      action: 'answer_question',
      answerMode: 'currentLineup',
      cardPolicy: 'textOnly',
      followUpPolicy: 'answerNowNoDeferredOffer',
      agentDecision: productSelectionAgentDecision(),
      requiredProductTraits: {
        ...baseTurnPlan().requiredProductTraits,
        productIntent: 'generator',
        productRole: 'coreProduct',
        fuel: 'gasoline',
        enclosure: 'enclosed',
        singlePhase220: true,
        budgetMax: 30000,
        nominalPowerKwMin: 2,
        nominalPowerKwMax: 2.5,
        provenance: {
          singlePhase220: 'inferred_from_load'
        }
      },
      selectionState: {
        ...baseTurnPlan().selectionState,
        currentProductClass: 'generator',
        targetProductClass: 'generator',
        shouldShowCards: false,
        cardDisplayMode: 'none'
      }
    });
    const message = ru('\\u0427\\u0442\\u043e \\u043d\\u0435\\u0442\\u0443 \\u0437\\u0430 30 000 \\u0433\\u0435\\u043d\\u0435\\u0440\\u0430\\u0442\\u043e\\u0440\\u043e\\u0432 2 \\u043a\\u0432\\u0442 \\u0437\\u0430\\u043a\\u0440\\u044b\\u0442\\u044b\\u0445?');
    const contract = assistantTestHooks.resolveTurnContractForPlan(plan);

    const result = await assistant.selectProductsForTurn(message, state, plan, products as any, contract);

    const ids = result.visibleProducts.map((item) => item.id);
    expect(assistantTestHooks.isCatalogAvailabilityQuestion(message)).toBe(true);
    expect(assistantTestHooks.isCatalogShortlistTurn(message, plan)).toBe(true);
    expect(result.trace.canRecommendFromSelection).toBe(true);
    expect(ids[0]).toBe('tor-km2000is');
    expect(result.state.hardConstraints.provenance?.singlePhase220).toBe('planner');
    expect(ids).toEqual(['tor-km2000is']);
    expect(ids).not.toContain('hnd-ge2200ji');
    expect(ids).not.toContain('open-aipower');
    expect(assistantTestHooks.selectionResultCanDriveCards(plan, result, message)).toBe(true);
    expect(assistantTestHooks.shouldForceStructuredSelectionCards(message, plan, result)).toBe(true);
  });

  it('keeps reliable selection card promotion behind text-only and factual-answer guards', () => {
    const result = reliableGeneratorSelectionResult();
    const baseAutoPlan = baseTurnPlan({
      action: 'answer_question',
      answerMode: 'short',
      cardPolicy: 'auto'
    });
    const clarifyingTextOnlyPlan = baseTurnPlan({
      action: 'ask_clarifying_question',
      answerMode: 'short',
      cardPolicy: 'textOnly',
      followUpPolicy: 'askClarifyingQuestion'
    });
    const serviceAndSparesMessage = ru('\\u0410 \\u0447\\u0442\\u043e \\u043f\\u043e \\u0441\\u0435\\u0440\\u0432\\u0438\\u0441\\u0443, \\u0437\\u0430\\u043f\\u0447\\u0430\\u0441\\u0442\\u044f\\u043c \\u0438 \\u0440\\u0430\\u0441\\u0445\\u043e\\u0434\\u043d\\u0438\\u043a\\u0430\\u043c \\u0434\\u043b\\u044f \\u044d\\u0442\\u043e\\u0433\\u043e \\u0433\\u0435\\u043d\\u0435\\u0440\\u0430\\u0442\\u043e\\u0440\\u0430?');
    const currentLineupMessage = ru('\\u0410 TOR KM2000ie \\u0435\\u0449\\u0435 \\u0432\\u044b\\u043f\\u0443\\u0441\\u043a\\u0430\\u0435\\u0442\\u0441\\u044f \\u0438\\u043b\\u0438 \\u044d\\u0442\\u043e \\u0441\\u0442\\u0430\\u0440\\u0430\\u044f \\u043c\\u043e\\u0434\\u0435\\u043b\\u044c?');

    expect(assistantTestHooks.shouldForceStructuredSelectionCards(
      serviceAndSparesMessage,
      baseAutoPlan,
      result
    )).toBe(false);
    expect(assistantTestHooks.shouldForceStructuredSelectionCards(
      currentLineupMessage,
      baseAutoPlan,
      result
    )).toBe(false);
    expect(assistantTestHooks.shouldForceStructuredSelectionCards(
      serviceAndSparesMessage,
      clarifyingTextOnlyPlan,
      result
    )).toBe(false);
    expect(assistantTestHooks.shouldForceStructuredSelectionCards(
      currentLineupMessage,
      clarifyingTextOnlyPlan,
      result
    )).toBe(false);
    expect(assistantTestHooks.shouldForceStructuredSelectionCards(
      'Need generator for home 220 V with boiler and fridge',
      { ...baseAutoPlan, cardPolicy: 'textOnly' },
      result
    )).toBe(false);
  });

  it('does not promote estimated-pump generator selection to product cards', () => {
    const pumpState = mergeProductSelectionState(emptyNeedState().selectionState, {
      currentProductClass: 'generator',
      targetProductClass: 'generator',
      hardConstraints: {
        productIntent: 'generator',
        productRole: 'coreProduct',
        exactModelTokens: [],
        mustHaveTraits: [],
        excludedClasses: [],
        nominalPowerKwMin: 4,
        nominalPowerKwMax: 5,
        maxPowerKwMin: 3.2,
        singlePhase220: true,
        provenance: {
          nominalPowerKwMin: 'inferred_from_load',
          nominalPowerKwMax: 'inferred_from_load',
          maxPowerKwMin: 'inferred_from_load',
          singlePhase220: 'explicit_user'
        }
      },
      loadProfile: {
        items: [{
          kind: 'pump',
          name: 'pump',
          count: 1,
          runningKw: 0.8,
          startingKw: 3.2,
          source: 'estimated_average',
          evidence: 'pump without exact power'
        }],
        confidence: 0.52,
        calculation: 'estimated pump',
        totalRunningKw: 0.8,
        requiredNominalKw: 4,
        requiredStartingKw: 3.2,
        simultaneousStarting: false
      } as any,
      confidence: 0.78
    });
    const result = reliableGeneratorSelectionResult({ state: pumpState });
    const plan = baseTurnPlan({
      action: 'answer_question',
      answerMode: 'short',
      cardPolicy: 'auto',
      agentDecision: productSelectionAgentDecision()
    });

    expect(assistantTestHooks.selectionResultCanDriveCards(plan, result, 'Need generator for a pump')).toBe(false);
    expect(assistantTestHooks.shouldForceStructuredSelectionCards('Need generator for a pump', plan, result)).toBe(false);
  });

  it('does not promote generator cards when the pump type is unknown even with other home loads', () => {
    const fit = productWithSpecs('fit-5kw', 'Generator gasoline 5.5 kW 220 V', 64_000, 'https://example.test/generators/fit-5kw/', {
      nominalPower: '5.5 kW',
      maxPower: '6.0 kW'
    });
    const pumpState = mergeProductSelectionState(reliableGeneratorSelectionResult().state, {
      hardConstraints: {
        ...reliableGeneratorSelectionResult().state.hardConstraints,
        nominalPowerKwMin: 5,
        nominalPowerKwMax: 6.5,
        maxPowerKwMin: 6
      },
      loadProfile: {
        items: [
          {
            kind: 'pump',
            name: 'pump',
            count: 1,
            runningKw: 0.8,
            startingKw: 3.2,
            source: 'estimated_average',
            evidence: 'pump, type and power unknown'
          },
          {
            kind: 'refrigerator',
            name: 'refrigerator',
            count: 1,
            runningKw: 0.25,
            startingKw: 0.9,
            source: 'explicit_user',
            evidence: 'one refrigerator'
          },
          {
            kind: 'tool',
            name: 'angle grinder',
            count: 1,
            runningKw: 1.2,
            startingKw: 1.2,
            source: 'explicit_user',
            evidence: '1.2 kW angle grinder'
          }
        ],
        confidence: 0.68,
        calculation: 'generic pump, refrigerator, LED light, angle grinder',
        totalRunningKw: 2.25,
        requiredNominalKw: 5,
        requiredStartingKw: 6,
        simultaneousStarting: false
      } as any,
      confidence: 0.72
    });
    const result = reliableGeneratorSelectionResult({
      state: pumpState,
      matchedProducts: [fit],
      visibleProducts: [fit],
      confidence: 0.72
    });
    const plan = baseTurnPlan({
      action: 'answer_question',
      answerMode: 'short',
      cardPolicy: 'auto'
    });

    expect(assistantTestHooks.selectionResultCanDriveCards(
      plan,
      result,
      '220 V, pump type unknown, refrigerator, LED light, sometimes a 1.2 kW angle grinder'
    )).toBe(false);
    expect(assistantTestHooks.shouldForceStructuredSelectionCards(
      '220 V, pump type unknown, refrigerator, LED light, sometimes a 1.2 kW angle grinder',
      plan,
      result
    )).toBe(false);
  });

  it('allows preliminary generator cards for an explicit catalog request while pump power is still unknown', () => {
    const fit = productWithSpecs('fit-5kw', 'Generator gasoline 5.5 kW 220 V', 64_000, 'https://example.test/generators/fit-5kw/', {
      nominalPower: '5.5 kW',
      maxPower: '6.0 kW'
    });
    const pumpState = mergeProductSelectionState(reliableGeneratorSelectionResult().state, {
      hardConstraints: {
        ...reliableGeneratorSelectionResult().state.hardConstraints,
        nominalPowerKwMin: 5,
        nominalPowerKwMax: 6.5,
        maxPowerKwMin: 6
      },
      loadProfile: {
        items: [
          {
            kind: 'pump',
            name: 'pump',
            count: 1,
            runningKw: 0.8,
            startingKw: 3.2,
            source: 'estimated_average',
            evidence: 'pump, type and power unknown'
          },
          {
            kind: 'refrigerator',
            name: 'refrigerator',
            count: 1,
            runningKw: 0.25,
            startingKw: 0.9,
            source: 'explicit_user',
            evidence: 'one refrigerator'
          }
        ],
        confidence: 0.68,
        calculation: 'generic pump and refrigerator',
        totalRunningKw: 1.05,
        requiredNominalKw: 5,
        requiredStartingKw: 6,
        simultaneousStarting: false
      } as any,
      confidence: 0.72
    });
    const result = reliableGeneratorSelectionResult({
      state: pumpState,
      matchedProducts: [fit],
      visibleProducts: [fit],
      confidence: 0.72
    });
    const contract = {
      ...productSelectionAgentDecision(),
      activeNeeds: [],
      validatorWarnings: []
    } as any;

    expect(assistantTestHooks.shouldAllowPreliminaryCatalogCardsForEstimatedPump(contract, result)).toBe(true);
    expect(assistantTestHooks.shouldPromotePrimarySelectionCards(
      contract,
      baseTurnPlan({ action: 'answer_question', answerMode: 'short', cardPolicy: 'auto' }),
      result,
      false
    )).toBe(true);
  });

  it('allows preliminary generator cards when the pump type is known but exact power is missing', () => {
    const fit = productWithSpecs('fit-5kw', 'Generator gasoline 5.5 kW 220 V', 64_000, 'https://example.test/generators/fit-5kw/', {
      nominalPower: '5.5 kW',
      maxPower: '6.0 kW'
    });
    const pumpState = mergeProductSelectionState(reliableGeneratorSelectionResult().state, {
      hardConstraints: {
        ...reliableGeneratorSelectionResult().state.hardConstraints,
        nominalPowerKwMin: 5,
        nominalPowerKwMax: 6.5,
        maxPowerKwMin: 6
      },
      loadProfile: {
        items: [
          {
            kind: 'pump',
            name: 'borehole pump',
            count: 1,
            runningKw: 0.8,
            startingKw: 3.2,
            source: 'estimated_average',
            evidence: 'borehole pump without exact power'
          },
          {
            kind: 'refrigerator',
            name: 'refrigerator',
            count: 1,
            runningKw: 0.25,
            startingKw: 0.9,
            source: 'explicit_user',
            evidence: 'one refrigerator'
          },
          {
            kind: 'tool',
            name: 'angle grinder',
            count: 1,
            runningKw: 1.2,
            startingKw: 1.2,
            source: 'explicit_user',
            evidence: '1.2 kW angle grinder'
          }
        ],
        confidence: 0.68,
        calculation: 'borehole pump, refrigerator, LED light, angle grinder',
        totalRunningKw: 2.25,
        requiredNominalKw: 5,
        requiredStartingKw: 6,
        simultaneousStarting: false
      } as any,
      confidence: 0.72
    });
    const result = reliableGeneratorSelectionResult({
      state: pumpState,
      matchedProducts: [fit],
      visibleProducts: [fit],
      confidence: 0.72
    });
    const plan = baseTurnPlan({
      action: 'answer_question',
      answerMode: 'short',
      cardPolicy: 'auto'
    });

    expect(assistantTestHooks.selectionResultCanDriveCards(
      plan,
      result,
      '220 V, borehole pump power unknown, refrigerator, LED light, sometimes a 1.2 kW angle grinder'
    )).toBe(false);
    expect(assistantTestHooks.shouldForceStructuredSelectionCards(
      '220 V, borehole pump power unknown, refrigerator, LED light, sometimes a 1.2 kW angle grinder',
      plan,
      result
    )).toBe(false);
  });

  it('promotes generator sizing turns to preliminary cards when load context is enough', () => {
    const fit = productWithSpecs('fit-5kw', 'Generator gasoline 5.0 kW 220 V', 64_000, 'https://example.test/generators/fit-5kw/', {
      nominalPower: '5.0 kW',
      maxPower: '5.5 kW'
    });
    const pumpState = mergeProductSelectionState(reliableGeneratorSelectionResult().state, {
      hardConstraints: {
        ...reliableGeneratorSelectionResult().state.hardConstraints,
        productIntent: 'generator',
        nominalPowerKwMin: 4.5,
        nominalPowerKwMax: 5.3,
        maxPowerKwMin: 4.1
      },
      loadProfile: {
        items: [
          {
            kind: 'pump',
            name: 'borehole pump',
            count: 1,
            runningKw: 1.1,
            startingKw: 2.9,
            source: 'estimated_average',
            evidence: 'borehole pump without exact power'
          },
          {
            kind: 'refrigerator',
            name: 'refrigerator',
            count: 1,
            runningKw: 0.15,
            startingKw: 1,
            source: 'estimated_average',
            evidence: 'one refrigerator'
          },
          {
            kind: 'lighting',
            name: 'LED light',
            count: 1,
            runningKw: 0.2,
            startingKw: 0.2,
            source: 'estimated_average',
            evidence: 'LED light'
          }
        ],
        confidence: 0.68,
        calculation: 'borehole pump, refrigerator, LED light',
        totalRunningKw: 1.45,
        requiredNominalKw: 4.5,
        requiredStartingKw: 4.1,
        simultaneousStarting: true
      } as any,
      confidence: 0.72
    });
    const result = reliableGeneratorSelectionResult({
      state: pumpState,
      matchedProducts: [fit],
      visibleProducts: [fit],
      confidence: 0.72
    });

    expect(assistantTestHooks.shouldPromoteGeneratorSizingCardsForContract(
      {
        ...productSelectionAgentDecision(),
        activeNeeds: [],
        validatorWarnings: []
      } as any,
      result,
      false
    )).toBe(true);
    expect(assistantTestHooks.shouldPromoteGeneratorSizingCards(
      ru('\\u0415\\u0441\\u043b\\u0438 \\u0432\\u0437\\u044f\\u0442\\u044c \\u0433\\u0435\\u043d\\u0435\\u0440\\u0430\\u0442\\u043e\\u0440 5,5 \\u043a\\u0412\\u0442, \\u0441\\u043a\\u043e\\u043b\\u044c\\u043a\\u043e \\u043e\\u0441\\u0442\\u0430\\u043d\\u0435\\u0442\\u0441\\u044f \\u043f\\u043e\\u0441\\u043b\\u0435 \\u0437\\u0430\\u043f\\u0443\\u0441\\u043a\\u0430?'),
      result,
      false
    )).toBe(false);
  });

  it('sizes household generator loads as minimally sufficient before reserve', () => {
    const profile = assistantTestHooks.generatorLoadProfileFromText(ru('\\u0414\\u043e\\u043c 220 \\u0412. \\u0425\\u043e\\u043b\\u043e\\u0434\\u0438\\u043b\\u044c\\u043d\\u0438\\u043a \\u043e\\u0434\\u0438\\u043d, LED \\u0441\\u0432\\u0435\\u0442, \\u0438\\u043d\\u043e\\u0433\\u0434\\u0430 \\u0431\\u043e\\u043b\\u0433\\u0430\\u0440\\u043a\\u0430 1,2 \\u043a\\u0412\\u0442. \\u041d\\u0430\\u0441\\u043e\\u0441 \\u0441\\u043a\\u0432\\u0430\\u0436\\u0438\\u043d\\u043d\\u044b\\u0439, 220 \\u0412, \\u043d\\u0430\\u0441\\u043e\\u0441 \\u0441 \\u0445\\u043e\\u043b\\u043e\\u0434\\u0438\\u043b\\u044c\\u043d\\u0438\\u043a\\u043e\\u043c \\u043c\\u043e\\u0433\\u0443\\u0442 \\u0432\\u043a\\u043b\\u044e\\u0447\\u0438\\u0442\\u044c\\u0441\\u044f \\u0432\\u043c\\u0435\\u0441\\u0442\\u0435.'));

    expect(profile?.totalRunningKw).toBe(1.5);
    expect(profile?.requiredStartingKw).toBeCloseTo(4.1, 5);
    expect(profile?.requiredNominalKw).toBe(4.5);
    expect(profile?.simultaneousStarting).toBe(true);
    const pump = profile?.items.find((item) => item.kind === 'pump');
    const refrigerator = profile?.items.find((item) => item.kind === 'refrigerator');
    const lighting = profile?.items.find((item) => item.kind === 'lighting');
    expect(pump?.runningKw).toBe(1.1);
    expect(pump?.startingKw).toBeCloseTo(2.9, 5);
    expect(refrigerator).toEqual(expect.objectContaining({ runningKw: 0.15, startingKw: 1 }));
    expect(lighting).toEqual(expect.objectContaining({ runningKw: 0.2, startingKw: 0.2 }));
    expect(profile?.items.some((item) => item.kind === 'handheld_tool')).toBe(false);
  });

  it('does not treat missing exact numbers as an absent pump', () => {
    const profile = assistantTestHooks.generatorLoadProfileFromText(ru('\\u041d\\u0443\\u0436\\u0435\\u043d \\u0433\\u0435\\u043d\\u0435\\u0440\\u0430\\u0442\\u043e\\u0440. \\u0422\\u043e\\u0447\\u043d\\u044b\\u0445 \\u0446\\u0438\\u0444\\u0440 \\u043d\\u0435\\u0442: \\u0445\\u043e\\u043b\\u043e\\u0434\\u0438\\u043b\\u044c\\u043d\\u0438\\u043a, \\u043d\\u0430\\u0441\\u043e\\u0441, LED \\u0441\\u0432\\u0435\\u0442.'));

    expect(profile?.items.some((item) => item.kind === 'pump')).toBe(true);
    expect(profile?.items.find((item) => item.kind === 'pump')).toEqual(expect.objectContaining({
      source: 'estimated_average',
      name: 'pump'
    }));
  });

  it('accepts LLM need extraction as the semantic source for generator loads', () => {
    const update = assistantTestHooks.coerceNeedUpdate({
      activeNeeds: [{
        id: 'generator',
        productClass: 'generator',
        summary: 'Подбор генератора для дома',
        constraints: ['холодильник, насос, LED свет; точных цифр нет'],
        openQuestions: ['тип или мощность насоса'],
        selectedProductIds: [],
        status: 'open'
      }],
      explicitNeeds: [],
      implicitNeeds: [],
      constraints: [],
      importantCriteria: [],
      confirmedFacts: [],
      uncertainInferences: [],
      contradictions: [],
      featureSignals: {
        portable: 0,
        homeUse: 0.8,
        compact: 0,
        lowNoise: 0,
        coldStart: 0,
        professionalDuty: 0,
        budgetSensitive: 0
      },
      selectionState: {
        currentProductClass: 'generator',
        targetProductClass: 'generator',
        hardConstraints: {
          ...baseTurnPlan().requiredProductTraits,
          productIntent: 'generator',
          productRole: 'coreProduct',
          singlePhase220: true,
          mustHaveTraits: [],
          excludedClasses: [],
          brandConstraint: '',
          exactModelConstraint: ''
        },
        softPreferences: {
          ...baseTurnPlan().requiredProductTraits,
          productIntent: 'generator',
          productRole: 'coreProduct',
          mustHaveTraits: [],
          excludedClasses: [],
          brandConstraint: '',
          exactModelConstraint: ''
        },
        unknowns: ['тип или мощность насоса'],
        conflicts: [],
        selectedProductIds: [],
        loadProfile: {
          items: [
            {
              kind: 'pump',
              name: 'pump',
              count: 1,
              runningKw: 0.8,
              startingKw: 2.1,
              source: 'estimated_average',
              evidence: 'точных цифр нет, но насос назван'
            },
            {
              kind: 'refrigerator',
              name: 'refrigerator',
              count: 1,
              runningKw: 0.15,
              startingKw: 1,
              source: 'estimated_average',
              evidence: 'холодильник назван без точной мощности'
            }
          ],
          simultaneousStarting: false,
          confidence: 0.62,
          removedKinds: []
        },
        confidence: 0.72
      },
      lastSummary: 'Покупателю нужен генератор; насос есть, но его мощность неизвестна.'
    });

    expect(update.selectionState?.semanticSource).toBe('llm_need_extraction');
    expect(update.selectionState?.loadProfile?.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'pump', name: 'pump', source: 'estimated_average' })
    ]));
    expect(update.selectionState?.unknowns).toContain('тип или мощность насоса');
  });

  it('keeps deterministic fallback from showing generator catalog when pump is generic unknown', () => {
    const fit = productWithSpecs('fit-5kw', 'Generator gasoline 5.0 kW 220 V', 64_000, 'https://example.test/generators/fit-5kw/', {
      nominalPower: '5.0 kW',
      maxPower: '5.5 kW'
    });
    const pumpState = mergeProductSelectionState(reliableGeneratorSelectionResult().state, {
      hardConstraints: {
        ...reliableGeneratorSelectionResult().state.hardConstraints,
        productIntent: 'generator',
        nominalPowerKwMin: 2.5,
        nominalPowerKwMax: 4.5,
        maxPowerKwMin: 3.1
      },
      loadProfile: {
        items: [
          {
            kind: 'pump',
            name: 'pump',
            count: 1,
            runningKw: 0.8,
            startingKw: 2.1,
            source: 'estimated_average',
            evidence: 'pump, exact type and power unknown'
          },
          {
            kind: 'refrigerator',
            name: 'refrigerator',
            count: 1,
            runningKw: 0.15,
            startingKw: 1,
            source: 'estimated_average',
            evidence: 'one refrigerator'
          }
        ],
        confidence: 0.6,
        calculation: 'generic pump and refrigerator',
        totalRunningKw: 0.95,
        requiredNominalKw: 2.5,
        requiredStartingKw: 3.1,
        simultaneousStarting: true
      } as any,
      confidence: 0.65
    });
    const result = reliableGeneratorSelectionResult({
      state: pumpState,
      matchedProducts: [fit],
      visibleProducts: [fit],
      missingQuestions: [ru('\\u043c\\u043e\\u0449\\u043d\\u043e\\u0441\\u0442\\u044c \\u0438\\u043b\\u0438 \\u0442\\u0438\\u043f \\u043d\\u0430\\u0441\\u043e\\u0441\\u0430')],
      confidence: 0.65
    });

    const answer = assistantTestHooks.deterministicAnswerGenerationFallback({
      cards: [],
      selectionResult: result,
      structuredCatalogSlice: {
        source: 'structured_constraints',
        products: [fit],
        totalMatched: 50,
        visibleLimit: 7,
        constraints: {
          productIntent: 'generator',
          nominalPowerKwMin: 2.5,
          nominalPowerKwMax: 4.5,
          maxPowerKwMin: 3.1
        }
      },
      finalCards: {
        visibleProducts: [],
        hiddenProducts: [fit],
        cards: [],
        initialVisibleCount: 0,
        visibleProductIds: [],
        hiddenProductIds: ['fit-5kw'],
        source: 'textOnly'
      }
    } as any);

    expect(answer).toContain(ru('\\u041a\\u0430\\u0440\\u0442\\u043e\\u0447\\u043a\\u0438 \\u0433\\u0435\\u043d\\u0435\\u0440\\u0430\\u0442\\u043e\\u0440\\u043e\\u0432 \\u043f\\u043e\\u043a\\u0430 \\u043d\\u0435 \\u043f\\u043e\\u043a\\u0430\\u0437\\u044b\\u0432\\u0430\\u044e'));
    expect(answer).toContain(ru('\\u043c\\u043e\\u0449\\u043d\\u043e\\u0441\\u0442\\u044c \\u0438\\u043b\\u0438 \\u0442\\u0438\\u043f \\u043d\\u0430\\u0441\\u043e\\u0441\\u0430'));
    expect(answer).not.toContain('50');
    expect(answer).not.toContain('fit-5kw');
    expect(answer).not.toContain(fit.name);
  });

  it('repairs inflated household generator recommendations back to the calculated minimum', () => {
    const answer = ru('\\u0421\\u043c\\u043e\\u0442\\u0440\\u0435\\u0442\\u044c \\u043b\\u0443\\u0447\\u0448\\u0435 6-8 \\u043a\\u0412\\u0442. \\u0412 \\u0438\\u0434\\u0435\\u0430\\u043b\\u0435 8 \\u043a\\u0412\\u0442.');
    const repaired = assistantTestHooks.repairGeneratorLoadMinimumText(answer, {
      items: [],
      requiredNominalKw: 5,
      requiredStartingKw: 4.3
    });

    expect(repaired).toContain(ru('\\u0420\\u0430\\u0441\\u0447\\u0435\\u0442\\u043d\\u044b\\u0439 \\u043c\\u0438\\u043d\\u0438\\u043c\\u0443\\u043c'));
    expect(repaired).toContain('5 кВт');
    expect(repaired).not.toMatch(/6-8|8\s*кВт/iu);
  });

  it('keeps higher generator powers when the sizing policy supports them', () => {
    const visibleHighPowerCard = productWithSpecs(
      'supported-85',
      ru('\\u0413\\u0435\\u043d\\u0435\\u0440\\u0430\\u0442\\u043e\\u0440 \\u0431\\u0435\\u043d\\u0437\\u0438\\u043d\\u043e\\u0432\\u044b\\u0439 Supported 8500 (8,5 \\u043a\\u0412\\u0442)'),
      110_000,
      'https://example.test/generators/supported-85/',
      {
        'Номинальная мощность': '8.5 кВт',
        'Максимальная мощность': '9.0 кВт'
      }
    );
    const loadProfile = {
      items: [],
      requiredNominalKw: 5,
      requiredStartingKw: 4.3
    };
    const supportedByCard = ru('\\u0420\\u0430\\u0441\\u0447\\u0435\\u0442\\u043d\\u044b\\u0439 \\u043c\\u0438\\u043d\\u0438\\u043c\\u0443\\u043c 5 \\u043a\\u0412\\u0442. \\u0412 \\u043a\\u0430\\u0440\\u0442\\u043e\\u0447\\u043a\\u0430\\u0445 \\u0435\\u0441\\u0442\\u044c Supported 8500 \\u043d\\u0430 8,5 \\u043a\\u0412\\u0442.');
    const supportedByLoad = ru('\\u0420\\u0430\\u0441\\u0447\\u0435\\u0442\\u043d\\u044b\\u0439 \\u043c\\u0438\\u043d\\u0438\\u043c\\u0443\\u043c 8,5 \\u043a\\u0412\\u0442.');

    expect(assistantTestHooks.repairGeneratorLoadMinimumText(supportedByCard, loadProfile, {
      cards: assistantTestHooks.cardsFromPlan([visibleHighPowerCard], emptyNeedState(), 'show supported generator', baseTurnPlan())
    })).toContain('8,5 кВт');
    expect(assistantTestHooks.repairGeneratorLoadMinimumText(supportedByLoad, {
      items: [],
      requiredNominalKw: 8.5,
      requiredStartingKw: 8.2
    })).toBe(supportedByLoad);
  });

  it('keeps LLM previous-selection scope from introducing new catalogue products', async () => {
    const currentMain = productWithSpecs('current-main', ru('Генератор бензиновый SUMEC SU4500i 4.5 kW'), 82000, 'https://example.test/current-main/', {
      'Номинальная мощность': '4.5 кВт',
      'Максимальная мощность': '5.0 кВт'
    });
    const currentBackup = productWithSpecs('current-backup', ru('Генератор бензиновый SUMEC SU7700 5.0 kW'), 99000, 'https://example.test/current-backup/', {
      'Номинальная мощность': '5.0 кВт',
      'Максимальная мощность': '5.5 кВт'
    });
    const cheaperNew = productWithSpecs('cheaper-new', ru('Генератор бензиновый новый дешевле 5.0 kW'), 61000, 'https://example.test/cheaper-new/', {
      'Номинальная мощность': '5.0 кВт',
      'Максимальная мощность': '5.5 кВт'
    });
    const oversizedNew = productWithSpecs('oversized-new', ru('Генератор бензиновый новый мощнее 7.5 kW'), 73000, 'https://example.test/oversized-new/', {
      'Номинальная мощность': '7.5 кВт',
      'Максимальная мощность': '8.0 кВт'
    });
    const assistant = new AssistantService(undefined as never, new FakeProducts([
      cheaperNew,
      oversizedNew,
      currentMain,
      currentBackup
    ] as any) as never);
    const state = mergeNeedState(emptyNeedState(), {
      selectionState: mergeProductSelectionState(emptyNeedState().selectionState, {
        currentProductClass: 'generator',
        targetProductClass: 'generator',
        selectedProductIds: ['current-main', 'current-backup'],
        matchedProductIds: ['current-main', 'current-backup'],
        previousCandidateProductIds: ['current-main', 'current-backup'],
        rankingPreference: 'cheapest',
        confidence: 0.9,
        loadProfile: {
          totalRunningKw: 3.2,
          requiredStartingKw: 4.3,
          requiredNominalKw: 4.5,
          simultaneousStarting: false,
          items: []
        },
        hardConstraints: {
          productIntent: 'generator',
          productRole: 'coreProduct',
          exactModelTokens: [],
          exactModelTokenRoles: [],
          mustHaveTraits: [],
          excludedClasses: [],
          fuel: 'gasoline',
          startType: 'any',
          enclosure: 'any',
          conventionalGenerator: null,
          singlePhase220: true,
          nominalPowerKwMin: 4,
          nominalPowerKwMax: 5.5,
          maxPowerKwMin: 4.3,
          maxPowerKwMax: 6,
          provenance: {}
        } as any
      })
    });
    const plan = baseTurnPlan({
      contextScope: 'previousSelection',
      searchScope: 'previousSelectionOnly',
      catalogSearchQuery: 'сравнить текущие выбранные генераторы, без поиска новых вариантов',
      requiredProductTraits: {
        ...baseTurnPlan().requiredProductTraits,
        productIntent: 'generator',
        productRole: 'coreProduct',
        fuel: 'gasoline',
        singlePhase220: true,
        nominalPowerKwMin: 4,
        nominalPowerKwMax: 5.5,
        maxPowerKwMin: 4.3,
        maxPowerKwMax: 6
      },
      selectionState: {
        ...baseTurnPlan().selectionState,
        currentProductClass: 'generator',
        targetProductClass: 'generator'
      },
      answerGuidance: 'Покупатель продолжает обсуждать уже выбранную пару; не искать новые товары.'
    });

    const result = await assistant.selectProductsForTurn(
      ru('А из этих двух какой сначала брать, а какой оставить запасным?'),
      state,
      plan,
      [cheaperNew, oversizedNew, currentMain, currentBackup] as any
    );

    expect(result.matchedProducts.map((item) => item.id)).toEqual(['current-main', 'current-backup']);
    expect(result.visibleProducts.map((item) => item.id)).toEqual(['current-main', 'current-backup']);
    expect(result.state.selectedProductIds).toEqual(['current-main', 'current-backup']);
  });

  it('keeps a natural first-plus-alternative shortlist narrow and stable on rationale follow-up', async () => {
    const firstChoice = productWithSpecs('first-choice', ru('Генератор бензиновый SUMEC SU7700E 5.0 kW'), 85000, 'https://example.test/first-choice/', {
      'Номинальная мощность': '5.0 кВт',
      'Максимальная мощность': '5.5 кВт'
    });
    const backupChoice = productWithSpecs('backup-choice', ru('Генератор бензиновый SUMEC SU8800E 6.0 kW'), 89000, 'https://example.test/backup-choice/', {
      'Номинальная мощность': '6.0 кВт',
      'Максимальная мощность': '6.5 кВт'
    });
    const hiddenCheaper = productWithSpecs('hidden-cheaper', ru('Генератор бензиновый скрытый дешевле 5.0 kW'), 61000, 'https://example.test/hidden-cheaper/', {
      'Номинальная мощность': '5.0 кВт',
      'Максимальная мощность': '5.5 кВт'
    });
    const hiddenOversized = productWithSpecs('hidden-oversized', ru('Генератор бензиновый скрытый мощнее 7.5 kW'), 78000, 'https://example.test/hidden-oversized/', {
      'Номинальная мощность': '7.5 кВт',
      'Максимальная мощность': '8.0 кВт'
    });
    const assistant = new AssistantService(undefined as never, new FakeProducts([
      hiddenCheaper,
      hiddenOversized,
      firstChoice,
      backupChoice
    ] as any) as never);
    const state = mergeNeedState(emptyNeedState(), {
      selectionState: mergeProductSelectionState(emptyNeedState().selectionState, {
        currentProductClass: 'generator',
        targetProductClass: 'generator',
        selectedProductIds: ['first-choice', 'backup-choice'],
        matchedProductIds: ['first-choice', 'backup-choice', 'hidden-cheaper', 'hidden-oversized'],
        previousCandidateProductIds: ['first-choice', 'backup-choice', 'hidden-cheaper', 'hidden-oversized'],
        rankingPreference: 'cheapest',
        confidence: 0.9,
        loadProfile: {
          totalRunningKw: 3.2,
          requiredStartingKw: 4.3,
          requiredNominalKw: 4.5,
          simultaneousStarting: false,
          items: []
        },
        hardConstraints: {
          productIntent: 'generator',
          productRole: 'coreProduct',
          exactModelTokens: [],
          exactModelTokenRoles: [],
          mustHaveTraits: [],
          excludedClasses: [],
          fuel: 'gasoline',
          startType: 'any',
          enclosure: 'any',
          conventionalGenerator: null,
          singlePhase220: true,
          nominalPowerKwMin: 4,
          nominalPowerKwMax: 6.5,
          maxPowerKwMin: 4.3,
          maxPowerKwMax: 7,
          provenance: {}
        } as any
      })
    });
    const narrowPlan = baseTurnPlan({
      contextScope: 'activeNeed',
      searchScope: 'focusedNeed',
      catalogSearchQuery: 'бензиновый генератор для дачи до 90000',
      requiredProductTraits: {
        ...baseTurnPlan().requiredProductTraits,
        productIntent: 'generator',
        productRole: 'coreProduct',
        fuel: 'gasoline',
        singlePhase220: true,
        budgetMax: 90000,
        nominalPowerKwMin: 4,
        nominalPowerKwMax: 6.5,
        maxPowerKwMin: 4.3,
        maxPowerKwMax: 7
      },
      selectionState: {
        ...baseTurnPlan().selectionState,
        currentProductClass: 'generator',
        targetProductClass: 'generator'
      }
    });

    const narrowed = await assistant.selectProductsForTurn(
      ru('Мне не нужен большой список. Скажите по-человечески: какой вариант вы бы взяли первым, и какая нормальная альтернатива?'),
      state,
      narrowPlan,
      [hiddenCheaper, hiddenOversized, firstChoice, backupChoice] as any
    );

    expect(narrowed.visibleProducts.map((item) => item.id)).toEqual(['first-choice', 'backup-choice']);
    expect(narrowed.state.selectedProductIds).toEqual(['first-choice', 'backup-choice']);

    const rationale = await assistant.selectProductsForTurn(
      ru('Почему именно первый? Хватит ли запаса, если иногда отдельно включать чайник 2 кВт?'),
      { ...state, selectionState: narrowed.state },
      narrowPlan,
      [hiddenCheaper, hiddenOversized, firstChoice, backupChoice] as any,
      undefined,
      2
    );

    expect(rationale.visibleProducts.map((item) => item.id)).toEqual(['first-choice', 'backup-choice']);
    expect(rationale.matchedProducts.slice(0, 2).map((item) => item.id)).toEqual(['first-choice', 'backup-choice']);
  });

  it('does not let planner-only inverter and electric-start preferences erase suitable generator cards', async () => {
    const suitableConventional = productWithSpecs('suitable-conventional', ru('Генератор бензиновый DDE G550E (5,0 кВт)'), 61390, 'https://example.test/suitable-conventional/', {
      'Номинальная мощность': '5.0 кВт',
      'Максимальная мощность': '5.5 кВт'
    });
    const suitableBackup = productWithSpecs('suitable-backup', ru('Генератор бензиновый CHAMPION GG6500 (5,0 кВт)'), 64600, 'https://example.test/suitable-backup/', {
      'Номинальная мощность': '5.0 кВт',
      'Максимальная мощность': '5.5 кВт'
    });
    const inverterOverBudget = productWithSpecs('inverter-over-budget', ru('Генератор бензиновый инверторный EVOline BQH 6200 E (5,0 кВт)'), 129990, 'https://example.test/inverter-over-budget/', {
      'Номинальная мощность': '5.0 кВт',
      'Максимальная мощность': '5.5 кВт'
    });
    const assistant = new AssistantService(undefined as never, new FakeProducts([
      suitableConventional,
      suitableBackup,
      inverterOverBudget
    ] as any) as never);
    const state = mergeNeedState(emptyNeedState(), {
      selectionState: mergeProductSelectionState(emptyNeedState().selectionState, {
        currentProductClass: 'generator',
        targetProductClass: 'generator',
        rankingPreference: 'cheapest',
        confidence: 0.84,
        loadProfile: {
          totalRunningKw: 2.8,
          requiredStartingKw: 4.3,
          requiredNominalKw: 4.5,
          simultaneousStarting: false,
          items: [{
            kind: 'estimated-current-load',
            name: 'холодильник, свет, роутер, ТВ и отдельный инструмент',
            count: 1,
            runningKw: 2.8,
            startingKw: 4.3,
            source: 'estimated_average',
            evidence: 'предыдущий ход: дачные потребители без насоса'
          }]
        },
        hardConstraints: {
          productIntent: 'generator',
          productRole: 'coreProduct',
          exactModelTokens: [],
          exactModelTokenRoles: [],
          mustHaveTraits: [],
          excludedClasses: [],
          fuel: 'gasoline',
          startType: 'electric',
          conventionalGenerator: false,
          singlePhase220: true,
          budgetMax: 90000,
          nominalPowerKwMin: 4.5,
          nominalPowerKwMax: 6,
          maxPowerKwMin: 4.3,
          provenance: {
            fuel: 'planner',
            startType: 'planner',
            conventionalGenerator: 'planner',
            budgetMax: 'explicit_user',
            nominalPowerKwMin: 'inferred_from_load',
            nominalPowerKwMax: 'inferred_from_load',
            maxPowerKwMin: 'inferred_from_load'
          }
        } as any
      })
    });
    const plan = baseTurnPlan({
      catalogSearchQuery: 'бензиновый инверторный генератор 220 В с электростартом около 4,5 кВт до 90000',
      requiredProductTraits: {
        ...baseTurnPlan().requiredProductTraits,
        productIntent: 'generator',
        productRole: 'coreProduct',
        fuel: 'gasoline',
        startType: 'electric',
        conventionalGenerator: false,
        singlePhase220: true,
        budgetMax: 90000,
        nominalPowerKwMin: 4.5,
        nominalPowerKwMax: 6,
        maxPowerKwMin: 4.3
      },
      selectionState: {
        ...baseTurnPlan().selectionState,
        currentProductClass: 'generator',
        targetProductClass: 'generator'
      }
    });

    const result = await assistant.selectProductsForTurn(
      ru('Бюджет примерно до 90 тысяч. Насоса нет. Чайник бывает 2 кВт, но с инструментом одновременно включать не буду. Хочется без лишнего запаса, но чтобы холодильнику и электронике было нормально.'),
      state,
      plan,
      [suitableConventional, suitableBackup, inverterOverBudget] as any
    );

    expect(result.visibleProducts.map((item) => item.id)).toEqual(['suitable-conventional', 'suitable-backup']);
    expect(result.state.hardConstraints.startType).toBeUndefined();
    expect(result.state.hardConstraints.conventionalGenerator).toBeUndefined();
    expect(result.trace?.totalMatched).toBe(2);
  });

  it('uses previousSelection as an anchor, not a cage, when the buyer asks to broaden alternatives', async () => {
    const currentMain = productWithSpecs('current-main', ru('Генератор бензиновый SUMEC SU4500i 4.5 kW'), 82000, 'https://example.test/current-main/', {
      'Номинальная мощность': '4.5 кВт',
      'Максимальная мощность': '5.0 кВт'
    });
    const currentBackup = productWithSpecs('current-backup', ru('Генератор бензиновый SUMEC SU7700 5.0 kW'), 99000, 'https://example.test/current-backup/', {
      'Номинальная мощность': '5.0 кВт',
      'Максимальная мощность': '5.5 кВт'
    });
    const cheaperNew = productWithSpecs('cheaper-new', ru('Генератор бензиновый новый дешевле 5.0 kW'), 61000, 'https://example.test/cheaper-new/', {
      'Номинальная мощность': '5.0 кВт',
      'Максимальная мощность': '5.5 кВт'
    });
    const assistant = new AssistantService(undefined as never, new FakeProducts([
      currentMain,
      currentBackup,
      cheaperNew
    ] as any) as never);
    const state = mergeNeedState(emptyNeedState(), {
      selectionState: mergeProductSelectionState(emptyNeedState().selectionState, {
        currentProductClass: 'generator',
        targetProductClass: 'generator',
        selectedProductIds: ['current-main', 'current-backup'],
        matchedProductIds: ['current-main', 'current-backup'],
        previousCandidateProductIds: ['current-main', 'current-backup'],
        rankingPreference: 'cheapest',
        confidence: 0.9,
        loadProfile: {
          totalRunningKw: 3.2,
          requiredStartingKw: 4.3,
          requiredNominalKw: 4.5,
          simultaneousStarting: false,
          items: []
        },
        hardConstraints: {
          productIntent: 'generator',
          productRole: 'coreProduct',
          exactModelTokens: [],
          exactModelTokenRoles: [],
          mustHaveTraits: [],
          excludedClasses: [],
          fuel: 'gasoline',
          startType: 'any',
          enclosure: 'any',
          conventionalGenerator: null,
          singlePhase220: true,
          nominalPowerKwMin: 4,
          nominalPowerKwMax: 5.5,
          maxPowerKwMin: 4.3,
          maxPowerKwMax: 6,
          provenance: {}
        } as any
      })
    });
    const plan = baseTurnPlan({
      contextScope: 'previousSelection',
      searchScope: 'broadenAlternatives',
      catalogSearchQuery: 'найти более дешевый генератор с теми же критериями',
      requiredProductTraits: {
        ...baseTurnPlan().requiredProductTraits,
        productIntent: 'generator',
        productRole: 'coreProduct',
        fuel: 'gasoline',
        singlePhase220: true,
        nominalPowerKwMin: 4,
        nominalPowerKwMax: 5.5,
        maxPowerKwMin: 4.3,
        maxPowerKwMax: 6
      },
      selectionState: {
        ...baseTurnPlan().selectionState,
        currentProductClass: 'generator',
        targetProductClass: 'generator'
      },
      answerGuidance: 'Покупатель опирается на прежнюю пару, но просит найти новые более дешевые альтернативы.'
    });

    const result = await assistant.selectProductsForTurn(
      ru('А есть дешевле этих двух, но чтобы подходил так же?'),
      state,
      plan,
      [currentMain, currentBackup, cheaperNew] as any
    );

    expect(result.visibleProducts.map((item) => item.id)).toContain('cheaper-new');
    expect(result.matchedProducts[0]?.id).toBe('cheaper-new');
  });

  it('does not cage a fresh catalog range selection inside stale previous generator cards', async () => {
    const tss8 = productWithSpecs('tss-8', ru('Генератор бензиновый ТСС SGG 9000ELA (8,0 кВт)'), 95059, 'https://example.test/tss-8/', {
      'Номинальная мощность': '8,0 кВт',
      'Напряжение': '230 В',
      'Число фаз': 'однофазные'
    });
    const tss9 = productWithSpecs('tss-9', ru('Генератор бензиновый инверторный ТСС SGG 10000EI (9,0 кВт)'), 153112, 'https://example.test/tss-9/', {
      'Номинальная мощность': '9,0 кВт',
      'Напряжение': '230 В',
      'Число фаз': 'однофазные'
    });
    const tss10 = productWithSpecs('tss-10', ru('Генератор бензиновый ТСС SGG 10000EHA (10,0 кВт)'), 213941, 'https://example.test/tss-10/', {
      'Номинальная мощность': '10,0 кВт',
      'Напряжение': '230 В',
      'Число фаз': 'однофазные'
    });
    const tss12 = productWithSpecs('tss-12', ru('Генератор бензиновый ТСС SGG 12000EHLA (12,0 кВт)'), 270006, 'https://example.test/tss-12/', {
      'Номинальная мощность': '12,0 кВт',
      'Напряжение': '230 В',
      'Число фаз': 'однофазные'
    });
    const tss8ThreePhase = productWithSpecs('tss-8-3ph', ru('Генератор бензиновый ТСС SGG 8000EH3NUA (8,0 кВт)'), 90511, 'https://example.test/tss-8-3ph/', {
      'Номинальная мощность': '8,0 кВт',
      'Напряжение': '230/400 В',
      'Число фаз': 'трехфазные'
    });
    const tss17ThreePhase = productWithSpecs('tss-17-3ph', ru('Генератор бензиновый ТСС SGG 17000EH3U (15,5 кВт)'), 380422, 'https://example.test/tss-17-3ph/', {
      'Номинальная мощность': '15,5 кВт',
      'Напряжение': '230/400 В',
      'Число фаз': 'трехфазные'
    });
    const assistant = new AssistantService(undefined as never, new FakeProducts([tss10, tss12, tss8ThreePhase, tss17ThreePhase, tss8, tss9] as any) as never);
    const state = mergeNeedState(emptyNeedState(), {
      selectionState: mergeProductSelectionState(emptyNeedState().selectionState, {
        currentProductClass: 'generator',
        targetProductClass: 'generator',
        selectedProductIds: ['tss-10', 'tss-12'],
        matchedProductIds: ['tss-10', 'tss-12'],
        previousCandidateProductIds: ['tss-10', 'tss-12'],
        rankingPreference: 'cheapest',
        confidence: 0.9,
        hardConstraints: {
          productIntent: 'generator',
          productRole: 'coreProduct',
          exactModelTokens: [],
          exactModelTokenRoles: [],
          mustHaveTraits: ['бренд ТСС', 'бензиновый', 'номинальная мощность 10 кВт', 'однофазный 220 В'],
          excludedClasses: [],
          fuel: 'gasoline',
          startType: 'any',
          enclosure: 'any',
          conventionalGenerator: null,
          singlePhase220: true,
          brandConstraint: 'ТСС',
          nominalPowerKwMin: 10,
          provenance: {
            fuel: 'planner',
            singlePhase220: 'planner',
            brandConstraint: 'planner',
            nominalPowerKwMin: 'planner'
          }
        } as any
      })
    });
    const plan = baseTurnPlan({
      contextScope: 'previousSelection',
      searchScope: 'previousSelectionOnly',
      selectedProductIds: [],
      requiredProductTraits: {
        ...baseTurnPlan().requiredProductTraits,
        productIntent: 'generator',
        productRole: 'coreProduct',
        fuel: 'gasoline',
        singlePhase220: true,
        nominalPowerKwMin: 10
      },
      selectionState: {
        ...baseTurnPlan().selectionState,
        currentProductClass: 'generator',
        targetProductClass: 'generator',
        brandConstraint: 'ТСС',
        mustHaveTraits: ['бренд ТСС', 'бензиновый', 'мощность 8-10 кВт', 'однофазный 220 В'],
        shouldShowCards: true,
        cardDisplayMode: 'structured_selection'
      },
      agentDecision: productSelectionAgentDecision({
        taskType: 'product_selection_with_availability',
        catalogAction: 'find_matching_products',
        currentFocus: 'TSS gasoline single-phase generator 8-10 kW',
        mustAnswerNow: ['show all matching 8-10 kW TSS generators']
      })
    });

    const result = await assistant.selectProductsForTurn(
      'А что есть в наличии от 8 до 10 кВт?',
      state,
      plan,
      [tss10, tss12, tss8ThreePhase, tss17ThreePhase] as any
    );

    expect(result.state.hardConstraints.nominalPowerKwMin).toBe(8);
    expect(result.state.hardConstraints.nominalPowerKwMax).toBe(10);
    expect(result.matchedProducts.map((item) => item.id)).toEqual(['tss-8', 'tss-9', 'tss-10']);
    expect(result.matchedProducts.map((item) => item.id)).not.toContain('tss-12');
    expect(result.matchedProducts.map((item) => item.id)).not.toContain('tss-8-3ph');
    expect(result.matchedProducts.map((item) => item.id)).not.toContain('tss-17-3ph');
    expect((result.trace as any).stalePreviousSelectionCageRepaired).toBe(true);
  });

  it('lets the current planner brand override stale semantic memory brands from a comparison', async () => {
    const tss = productWithSpecs('tss-10', ru('Генератор бензиновый ТСС SGG 10000EHA (10,0 кВт)'), 213941, 'https://example.test/tss-10/', {
      'Номинальная мощность': '10,0 кВт',
      'Напряжение': '230 В',
      'Число фаз': 'однофазные'
    });
    const doosan = productWithSpecs('doosan-10', ru('Генератор дизельный Doosan 10 кВт'), 300000, 'https://example.test/doosan-10/', {
      'Номинальная мощность': '10,0 кВт'
    });
    const assistant = new AssistantService(undefined as never, new FakeProducts([doosan, tss] as any) as never);
    const state = mergeNeedState(emptyNeedState(), {
      semanticMemory: {
        version: 1,
        activeRequirementIds: ['req_old_doosan_brand'],
        requirements: [
          semanticRequirement({
            id: 'req_old_doosan_brand',
            kind: 'brand',
            value: { brand: 'Doosan' }
          })
        ],
        mentionedProducts: [],
        selectionPolicy: {
          primaryRequirementIds: ['req_old_doosan_brand'],
          alternativeMode: 'none',
          explanationRequired: false
        },
        botCommitments: []
      } as SemanticMemory
    });
    const plan = baseTurnPlan({
      requiredProductTraits: {
        ...baseTurnPlan().requiredProductTraits,
        productIntent: 'generator',
        productRole: 'coreProduct',
        fuel: 'gasoline',
        singlePhase220: true,
        nominalPowerKwMin: 10,
        nominalPowerKwMax: 10
      },
      selectionState: {
        ...baseTurnPlan().selectionState,
        currentProductClass: 'generator',
        targetProductClass: 'generator',
        brandConstraint: 'ТСС',
        mustHaveTraits: ['бренд ТСС', 'бензиновый', '10 кВт', 'однофазный 220 В'],
        shouldShowCards: true,
        cardDisplayMode: 'structured_selection'
      },
      agentDecision: productSelectionAgentDecision({
        taskType: 'product_selection_with_availability',
        catalogAction: 'find_matching_products',
        currentFocus: 'TSS gasoline generator 10 kW'
      })
    });

    const result = await assistant.selectProductsForTurn(
      'Есть в наличии ТСС 10 кВт бензин?',
      state,
      plan,
      [doosan, tss] as any
    );

    expect(result.state.hardConstraints.brandConstraint).toBe('ТСС');
    expect(result.matchedProducts.map((item) => item.id)).toContain('tss-10');
    expect(result.matchedProducts.map((item) => item.id)).not.toContain('doosan-10');
  });

  it('sorts suitable products cheapest-first under a budget ceiling unless premium is requested', async () => {
    const cheap = productWithSpecs('cheap-ok', ru('Генератор бензиновый 5.0 kW бюджетный'), 61000, 'https://example.test/cheap-ok/', {
      'Номинальная мощность': '5.0 кВт',
      'Максимальная мощность': '5.5 кВт'
    });
    const expensive = productWithSpecs('expensive-ok', ru('Генератор бензиновый 5.0 kW дорогой'), 99000, 'https://example.test/expensive-ok/', {
      'Номинальная мощность': '5.0 кВт',
      'Максимальная мощность': '5.5 кВт'
    });
    const assistant = new AssistantService(undefined as never, new FakeProducts([expensive, cheap] as any) as never);
    const state = mergeNeedState(emptyNeedState(), {
      selectionState: mergeProductSelectionState(emptyNeedState().selectionState, {
        currentProductClass: 'generator',
        targetProductClass: 'generator',
        rankingPreference: 'cheapest',
        confidence: 0.9,
        hardConstraints: {
          productIntent: 'generator',
          productRole: 'coreProduct',
          exactModelTokens: [],
          exactModelTokenRoles: [],
          mustHaveTraits: [],
          excludedClasses: [],
          fuel: 'gasoline',
          singlePhase220: true,
          budgetMax: 100000,
          nominalPowerKwMin: 4.5,
          nominalPowerKwMax: 5.5,
          maxPowerKwMin: 5,
          maxPowerKwMax: 6,
          provenance: { budgetMax: 'explicit_user' }
        } as any
      })
    });
    const plan = baseTurnPlan({
      catalogSearchQuery: 'бензиновый генератор до 100000',
      requiredProductTraits: {
        ...baseTurnPlan().requiredProductTraits,
        productIntent: 'generator',
        productRole: 'coreProduct',
        fuel: 'gasoline',
        singlePhase220: true,
        budgetMax: 100000,
        nominalPowerKwMin: 4.5,
        nominalPowerKwMax: 5.5,
        maxPowerKwMin: 5,
        maxPowerKwMax: 6
      },
      selectionState: {
        ...baseTurnPlan().selectionState,
        currentProductClass: 'generator',
        targetProductClass: 'generator'
      }
    });

    const result = await assistant.selectProductsForTurn(
      ru('Нужен бензиновый генератор до 100 тысяч, без переплаты.'),
      state,
      plan,
      [expensive, cheap] as any
    );

    expect(result.matchedProducts.map((item) => item.id)).toEqual(['cheap-ok', 'expensive-ok']);
  });

  it('sorts suitable products cheapest-first when no budget is stated', async () => {
    const cheap = productWithSpecs('cheap-ok', 'Генератор бензиновый 5.0 kW базовый', 61_000, 'https://example.test/cheap-ok/', {
      'Номинальная мощность': '5.0 кВт',
      'Максимальная мощность': '5.5 кВт'
    });
    const expensive = productWithSpecs('expensive-ok', 'Генератор бензиновый 5.0 kW расширенный', 99_000, 'https://example.test/expensive-ok/', {
      'Номинальная мощность': '5.0 кВт',
      'Максимальная мощность': '5.5 кВт'
    });
    const assistant = new AssistantService(undefined as never, new FakeProducts([expensive, cheap] as any) as never);
    const plan = baseTurnPlan({
      requiredProductTraits: {
        ...baseTurnPlan().requiredProductTraits,
        productIntent: 'generator',
        productRole: 'coreProduct',
        fuel: 'gasoline',
        nominalPowerKwMin: 4.5,
        nominalPowerKwMax: 5.5
      }
    });

    const result = await assistant.selectProductsForTurn(
      'Нужен бензиновый генератор примерно 5 кВт для дома.',
      emptyNeedState(),
      plan,
      [expensive, cheap] as any
    );

    expect(result.state.rankingPreference).toBe('cheapest');
    expect(result.visibleProducts.map((item) => item.id)).toEqual(['cheap-ok', 'expensive-ok']);
  });

  it('promotes portable plate compactors for any portability wording, not one fixed phrase', async () => {
    const message = ru('\\u041d\\u0443\\u0436\\u043d\\u0430 \\u0432\\u0438\\u0431\\u0440\\u043e\\u043f\\u043b\\u0438\\u0442\\u0430 \\u0434\\u043b\\u044f \\u0434\\u0430\\u0447\\u0438, \\u0431\\u0443\\u0434\\u0443 \\u043e\\u0434\\u0438\\u043d \\u0442\\u0430\\u0441\\u043a\\u0430\\u0442\\u044c \\u0440\\u0443\\u043a\\u0430\\u043c\\u0438, \\u043d\\u0443\\u0436\\u043d\\u0430 \\u043d\\u0435 \\u0442\\u044f\\u0436\\u0435\\u043b\\u0430\\u044f \\u0438 \\u043a\\u043e\\u043c\\u043f\\u0430\\u043a\\u0442\\u043d\\u0430\\u044f');
    const { ranked } = await rank(message, [
      product('heavy', ru('\\u0412\\u0438\\u0431\\u0440\\u043e\\u043f\\u043b\\u0438\\u0442\\u0430 \\u0440\\u0435\\u0432\\u0435\\u0440\\u0441\\u0438\\u0432\\u043d\\u0430\\u044f \\u0434\\u0438\\u0437\\u0435\\u043b\\u044c\\u043d\\u0430\\u044f Wacker Neuson DPU 90 Lec 770 (771 \\u043a\\u0433)'), 2644950, 'https://example.test/catalog/vibroplity/heavy/'),
      product('light', ru('\\u0412\\u0438\\u0431\\u0440\\u043e\\u043f\\u043b\\u0438\\u0442\\u0430 \\u043f\\u0440\\u044f\\u043c\\u043e\\u0445\\u043e\\u0434\\u043d\\u0430\\u044f \\u0431\\u0435\\u043d\\u0437\\u0438\\u043d\\u043e\\u0432\\u0430\\u044f Wacker Neuson BPS 1340 A (67 \\u043a\\u0433)'), 258250, 'https://example.test/catalog/vibroplity/light/')
    ]);

    expect(ranked[0].id).toBe('light');
  });

  it('uses inferred feature signals when the buyer implies portability without saying weight words', async () => {
    const message = ru('\\u041d\\u0443\\u0436\\u043d\\u0430 \\u0432\\u0438\\u0431\\u0440\\u043e\\u043f\\u043b\\u0438\\u0442\\u0430. \\u0411\\u0443\\u0434\\u0443 \\u0431\\u0440\\u0430\\u0442\\u044c \\u0441 \\u0441\\u043e\\u0431\\u043e\\u0439 \\u043d\\u0430 \\u0434\\u0430\\u0447\\u0443');
    const { ranked, state } = await rank(message, [
      product('heavy', ru('\\u0412\\u0438\\u0431\\u0440\\u043e\\u043f\\u043b\\u0438\\u0442\\u0430 \\u0440\\u0435\\u0432\\u0435\\u0440\\u0441\\u0438\\u0432\\u043d\\u0430\\u044f \\u0434\\u0438\\u0437\\u0435\\u043b\\u044c\\u043d\\u0430\\u044f (771 \\u043a\\u0433)'), 2644950, 'https://example.test/catalog/vibroplity/heavy/'),
      product('light', ru('\\u0412\\u0438\\u0431\\u0440\\u043e\\u043f\\u043b\\u0438\\u0442\\u0430 \\u043f\\u0440\\u044f\\u043c\\u043e\\u0445\\u043e\\u0434\\u043d\\u0430\\u044f (67 \\u043a\\u0433)'), 258250, 'https://example.test/catalog/vibroplity/light/')
    ]);

    expect(state.featureSignals.portable).toBeGreaterThan(0.7);
    expect(ranked[0].id).toBe('light');
  });

  it('promotes inverter generators for low-noise home use', async () => {
    const message = ru('\\u041d\\u0443\\u0436\\u0435\\u043d \\u0433\\u0435\\u043d\\u0435\\u0440\\u0430\\u0442\\u043e\\u0440 \\u0434\\u043b\\u044f \\u0434\\u043e\\u043c\\u0430, \\u0447\\u0442\\u043e\\u0431\\u044b \\u043d\\u043e\\u0447\\u044c\\u044e \\u043d\\u0435 \\u043c\\u0435\\u0448\\u0430\\u043b \\u0441\\u043e\\u0441\\u0435\\u0434\\u044f\\u043c');
    const { ranked, state } = await rank(message, [
      product('industrial', ru('\\u0413\\u0435\\u043d\\u0435\\u0440\\u0430\\u0442\\u043e\\u0440 \\u0434\\u0438\\u0437\\u0435\\u043b\\u044c\\u043d\\u044b\\u0439 \\u043e\\u0442\\u043a\\u0440\\u044b\\u0442\\u044b\\u0439 30 \\u043a\\u0412\\u0442'), 700000, 'https://example.test/catalog/dizelnye_generatory/industrial/'),
      product('quiet', ru('\\u0413\\u0435\\u043d\\u0435\\u0440\\u0430\\u0442\\u043e\\u0440 \\u0431\\u0435\\u043d\\u0437\\u0438\\u043d\\u043e\\u0432\\u044b\\u0439 \\u0438\\u043d\\u0432\\u0435\\u0440\\u0442\\u043e\\u0440\\u043d\\u044b\\u0439 Honda EU 10 iT1 0,9 \\u043a\\u0412\\u0442'), 150000, 'https://example.test/catalog/invertornye_generatory/quiet/')
    ]);

    expect(state.featureSignals.lowNoise).toBeGreaterThan(0.7);
    expect(ranked[0].id).toBe('quiet');
  });

  it('promotes duty-grade equipment for daily crew work', async () => {
    const message = ru('\\u041d\\u0443\\u0436\\u043d\\u0430 \\u0442\\u0435\\u0445\\u043d\\u0438\\u043a\\u0430 \\u0434\\u043b\\u044f \\u0431\\u0440\\u0438\\u0433\\u0430\\u0434\\u044b, \\u0440\\u0430\\u0431\\u043e\\u0442\\u0430\\u0442\\u044c \\u0431\\u0443\\u0434\\u0435\\u0442 \\u043a\\u0430\\u0436\\u0434\\u044b\\u0439 \\u0434\\u0435\\u043d\\u044c');
    const { ranked, state } = await rank(message, [
      product('consumer', ru('\\u0413\\u0435\\u043d\\u0435\\u0440\\u0430\\u0442\\u043e\\u0440 \\u0431\\u0435\\u043d\\u0437\\u0438\\u043d\\u043e\\u0432\\u044b\\u0439 \\u0431\\u044b\\u0442\\u043e\\u0432\\u043e\\u0439 2 \\u043a\\u0412\\u0442'), 45000, 'https://example.test/catalog/benzinovye_generatory/consumer/'),
      product('pro', ru('\\u0413\\u0435\\u043d\\u0435\\u0440\\u0430\\u0442\\u043e\\u0440 \\u0434\\u0438\\u0437\\u0435\\u043b\\u044c\\u043d\\u044b\\u0439 \\u043f\\u0440\\u043e\\u043c\\u044b\\u0448\\u043b\\u0435\\u043d\\u043d\\u044b\\u0439 12 \\u043a\\u0412\\u0442'), 240000, 'https://example.test/catalog/dizelnye_generatory/pro/')
    ]);

    expect(state.featureSignals.professionalDuty).toBeGreaterThan(0.8);
    expect(ranked[0].id).toBe('pro');
  });

  it('promotes lower priced options when budget sensitivity is the need', async () => {
    const message = ru('\\u041d\\u0443\\u0436\\u043d\\u0430 \\u0442\\u0435\\u0445\\u043d\\u0438\\u043a\\u0430 \\u043d\\u0435\\u0434\\u043e\\u0440\\u043e\\u0433\\u0430\\u044f, \\u0431\\u044e\\u0434\\u0436\\u0435\\u0442 \\u043e\\u0433\\u0440\\u0430\\u043d\\u0438\\u0447\\u0435\\u043d');
    const { ranked, state } = await rank(message, [
      product('expensive', ru('\\u0412\\u0438\\u0431\\u0440\\u043e\\u043f\\u043b\\u0438\\u0442\\u0430 \\u043f\\u0440\\u043e\\u0444\\u0435\\u0441\\u0441\\u0438\\u043e\\u043d\\u0430\\u043b\\u044c\\u043d\\u0430\\u044f 120 \\u043a\\u0433'), 300000, 'https://example.test/catalog/vibroplity/expensive/'),
      product('budget', ru('\\u0412\\u0438\\u0431\\u0440\\u043e\\u043f\\u043b\\u0438\\u0442\\u0430 \\u0431\\u0435\\u043d\\u0437\\u0438\\u043d\\u043e\\u0432\\u0430\\u044f 60 \\u043a\\u0433'), 55000, 'https://example.test/catalog/vibroplity/budget/')
    ]);

    expect(state.featureSignals.budgetSensitive).toBeGreaterThan(0.7);
    expect(ranked[0].id).toBe('budget');
  });

  it('reduces stale inferred needs after the buyer changes the task', async () => {
    const firstMessage = ru('\\u041d\\u0443\\u0436\\u043d\\u0430 \\u0432\\u0438\\u0431\\u0440\\u043e\\u043f\\u043b\\u0438\\u0442\\u0430. \\u0411\\u0443\\u0434\\u0443 \\u0431\\u0440\\u0430\\u0442\\u044c \\u0441 \\u0441\\u043e\\u0431\\u043e\\u0439 \\u043d\\u0430 \\u0434\\u0430\\u0447\\u0443');
    const nextMessage = ru('\\u0422\\u0435\\u043f\\u0435\\u0440\\u044c \\u043d\\u0443\\u0436\\u0435\\u043d \\u0433\\u0435\\u043d\\u0435\\u0440\\u0430\\u0442\\u043e\\u0440 \\u0434\\u043b\\u044f \\u0431\\u0440\\u0438\\u0433\\u0430\\u0434\\u044b, \\u0440\\u0430\\u0431\\u043e\\u0442\\u0430\\u0442\\u044c \\u0431\\u0443\\u0434\\u0435\\u0442 \\u043a\\u0430\\u0436\\u0434\\u044b\\u0439 \\u0434\\u0435\\u043d\\u044c');
    let state = mergeNeedState(emptyNeedState(), heuristicNeedUpdate(firstMessage));
    state = mergeNeedState(state, heuristicNeedUpdate(nextMessage));

    const assistant = new AssistantService(undefined as never, new FakeProducts([
      product('old-plate', ru('\\u0412\\u0438\\u0431\\u0440\\u043e\\u043f\\u043b\\u0438\\u0442\\u0430 \\u043f\\u0440\\u044f\\u043c\\u043e\\u0445\\u043e\\u0434\\u043d\\u0430\\u044f 67 \\u043a\\u0433'), 258250, 'https://example.test/catalog/vibroplity/light/'),
      product('new-generator', ru('\\u0413\\u0435\\u043d\\u0435\\u0440\\u0430\\u0442\\u043e\\u0440 \\u0434\\u0438\\u0437\\u0435\\u043b\\u044c\\u043d\\u044b\\u0439 \\u043f\\u0440\\u043e\\u043c\\u044b\\u0448\\u043b\\u0435\\u043d\\u043d\\u044b\\u0439 12 \\u043a\\u0412\\u0442'), 240000, 'https://example.test/catalog/dizelnye_generatory/pro/')
    ]) as never);
    const ranked = await assistant.findProducts(nextMessage, state);

    expect(state.featureSignals.portable).toBeLessThan(0.45);
    expect(state.featureSignals.professionalDuty).toBeGreaterThan(0.8);
    expect(ranked[0].id).toBe('new-generator');
  });

  it('prioritizes an exact model code over accessories from the same broad category', async () => {
    const message = ru('\\u041d\\u0443\\u0436\\u0435\\u043d \\u0433\\u0435\\u043d\\u0435\\u0440\\u0430\\u0442\\u043e\\u0440 \\u0422\\u0421\\u0421 \\u0410\\u0414-16\\u0421-\\u0422400-1\\u0420\\u041a\\u041c5, \\u0440\\u0430\\u0441\\u0441\\u043a\\u0430\\u0436\\u0438 \\u0445\\u0430\\u0440\\u0430\\u043a\\u0442\\u0435\\u0440\\u0438\\u0441\\u0442\\u0438\\u043a\\u0438');
    const { ranked } = await rank(message, [
      product('accessory', ru('\\u0421\\u0438\\u0441\\u0442\\u0435\\u043c\\u0430 \\u044d\\u043b.\\u043f\\u043e\\u0434\\u043e\\u0433\\u0440\\u0435\\u0432\\u0430 \\u0431\\u043b\\u043e\\u043a\\u0430 \\u0434\\u0432\\u0438\\u0433\\u0430\\u0442\\u0435\\u043b\\u044f 20-230 \\u043a\\u0412\\u0442 \\u0422\\u0421\\u0421'), 22299, 'https://example.test/catalog/raskhodniki/sistema-generator/'),
      product('generator', ru('\\u0413\\u0435\\u043d\\u0435\\u0440\\u0430\\u0442\\u043e\\u0440 \\u0434\\u0438\\u0437\\u0435\\u043b\\u044c\\u043d\\u044b\\u0439 \\u0422\\u0421\\u0421 \\u0410\\u0414-16\\u0421-\\u0422400-1\\u0420\\u041a\\u041c5 (16,0 \\u043a\\u0412\\u0442) 040441'), 502200, 'https://example.test/catalog/dizelnye_generatory/generator_tss_ad_16s_t400_1rkm5/')
    ]);

    expect(ranked[0].id).toBe('generator');
  });

  it('filters accessories, trowels, and oversized diesel units from a gasoline 5-6 kW generator request', async () => {
    const message = 'Покажите бензиновый генератор 5-6 кВт однофазный 220 В с электростартером для дачи';
    const { ranked } = await rank(message, [
      product('cover', 'Кожух всепогодный/шумозащитный до 9 кВт', 129000, 'https://example.test/catalog/kozhukhi_dlya_generatora/cover/'),
      product('trowel', 'Машина затирочная бензиновая STEM Techno SPT 242', 64000, 'https://example.test/catalog/zatirochnye_mashiny/trowel/'),
      product('diesel16', 'Генератор дизельный ТСС АД-16С-Т400-1РКМ5 (16,0 кВт)', 502200, 'https://example.test/catalog/dizelnye_generatory/diesel16/'),
      productWithSpecs('gas6', 'Генератор бензиновый ТСС SGG 6000EHNA (6,0 кВт)', 67498, 'https://example.test/catalog/benzinovye_generatory/sgg_6000ehna/', { 'тип запуска': 'ручной/электростартер' })
    ]);

    expect(ranked.map((item) => item.id)).toEqual(['gas6']);
  });

  it('recognizes spaced model codes such as SGG 6000EHNA', async () => {
    const message = 'Мне нужен ТСС SGG 6000EHNA, сравните обычный и DUPLEX';
    const { ranked } = await rank(message, [
      product('accessory', 'Система эл.подогрева блока двигателя 20-230 кВт ТСС', 22299, 'https://example.test/catalog/raskhodniki/heater/'),
      product('generator', 'Генератор бензиновый ТСС SGG 6000EHNA (6,0 кВт) 160010', 67498, 'https://example.test/catalog/benzinovye_generatory/sgg_6000ehna/')
    ]);

    expect(ranked[0].id).toBe('generator');
  });

  it('does not fall back to random cards when the plan selected no products', () => {
    const message = 'Нужен генератор для дачи, пока не понимаю какой';
    const state = mergeNeedState(emptyNeedState(), heuristicNeedUpdate(message));
    const cards = assistantTestHooks.cardsFromPlan([
      product('diesel16', 'Генератор дизельный ТСС АД-16С-Т400-1РКМ5 (16,0 кВт)', 502200, 'https://example.test/catalog/dizelnye_generatory/diesel16/'),
      product('trowel', 'Машина затирочная электрическая STEM Techno SPT 24', 68000, 'https://example.test/catalog/zatirochnye_mashiny/trowel/')
    ], state, message, {
      action: 'ask_clarifying_question',
      catalogSearchQuery: 'генератор бензиновый однофазный 220В 3-5 кВт для дачи',
      selectedProductIds: [],
      needsWebSearch: false,
      missingInformation: ['мощность насоса'],
      answerGuidance: 'ask first'
    } as any);

    expect(cards).toEqual([]);
  });

  it('keeps selected cards and fills a wider relevant product set', () => {
    const message = 'generator benzin 5-6 kw 220 for dacha';
    const state = mergeNeedState(emptyNeedState(), heuristicNeedUpdate(message));
    const products = Array.from({ length: 6 }, (_, index) => {
      const kw = index % 2 === 0 ? '6,0' : '5,0';
      return productWithSpecs(
        `gas-${index + 1}`,
        `Generator benzin AP${index + 1} (${kw} kw)`,
        50_000 + index * 1000,
        `https://example.test/catalog/benzinovye_generatory/gas-${index + 1}/`,
        { start: 'manual/electric starter' }
      );
    });

    const cards = assistantTestHooks.cardsFromPlan(products, state, message, {
      action: 'recommend_products',
      catalogSearchQuery: message,
      selectedProductIds: ['gas-2', 'gas-1'],
      needsWebSearch: false,
      missingInformation: [],
      answerGuidance: 'recommend'
    } as any);

    expect(cards).toHaveLength(6);
    expect(cards.slice(0, 2).map((card) => card.id)).toEqual(['gas-1', 'gas-2']);
  });

  it('caps product cards at a manageable wide choice', () => {
    const message = 'generator benzin 5-6 kw 220 for dacha';
    const state = mergeNeedState(emptyNeedState(), heuristicNeedUpdate(message));
    const products = Array.from({ length: 12 }, (_, index) => productWithSpecs(
      `gas-${index + 1}`,
      `Generator benzin AP${index + 1} (${index % 2 === 0 ? '6,0' : '5,0'} kw)`,
      50_000 + index * 1000,
      `https://example.test/catalog/benzinovye_generatory/gas-${index + 1}/`,
      { start: 'manual/electric starter' }
    ));

    const cards = assistantTestHooks.cardsFromPlan(products, state, message, {
      action: 'recommend_products',
      catalogSearchQuery: message,
      selectedProductIds: [],
      needsWebSearch: false,
      missingInformation: [],
      answerGuidance: 'recommend'
    } as any);

    expect(cards).toHaveLength(10);
  });

  it('keeps products over explicit budget out of the wider card set', () => {
    const message = 'Нужен бензиновый генератор 5-6 кВт до 90 тысяч';
    const state = mergeNeedState(emptyNeedState(), heuristicNeedUpdate(message));
    const cards = assistantTestHooks.cardsFromPlan([
      productWithSpecs('within', 'Генератор бензиновый A-iPower 6,0 кВт', 80_000, 'https://example.test/catalog/benzinovye_generatory/within/', { start: 'электростартер' }),
      productWithSpecs('over', 'Генератор бензиновый EUROPOWER 5,4 кВт', 179_990, 'https://example.test/catalog/benzinovye_generatory/over/', { start: 'электростартер' })
    ], state, message, {
      action: 'recommend_products',
      catalogSearchQuery: message,
      selectedProductIds: [],
      needsWebSearch: false,
      missingInformation: [],
      answerGuidance: 'recommend'
    } as any);

    expect(cards.map((card) => card.id)).toEqual(['within']);
  });

  it('builds a full structured plate slice from an explicit weight range', async () => {
    const message = ru('\\u041d\\u0443\\u0436\\u043d\\u0430 \\u0432\\u0438\\u0431\\u0440\\u043e\\u043f\\u043b\\u0438\\u0442\\u0430 \\u043d\\u0435\\u0431\\u043e\\u043b\\u044c\\u0448\\u0430\\u044f 100-150\\u043a\\u0433, \\u043f\\u043b\\u044e\\u0441 \\u043c\\u0438\\u043d\\u0443\\u0441 10\\u043a\\u0433');
    const state = mergeNeedState(emptyNeedState(), heuristicNeedUpdate(message));
    const assistant = new AssistantService(undefined as never, new FakeProducts([
      productWithSpecs('p90', ru('\\u0412\\u0438\\u0431\\u0440\\u043e\\u043f\\u043b\\u0438\\u0442\\u0430 90 \\u043a\\u0433'), 100000, 'https://example.test/p90', { [ru('\\u043c\\u0430\\u0441\\u0441\\u0430, \\u043a\\u0433')]: '90' }),
      productWithSpecs('p120', ru('\\u0412\\u0438\\u0431\\u0440\\u043e\\u043f\\u043b\\u0438\\u0442\\u0430 120 \\u043a\\u0433'), 120000, 'https://example.test/p120', { [ru('\\u043c\\u0430\\u0441\\u0441\\u0430, \\u043a\\u0433')]: '120' }),
      productWithSpecs('p160', ru('\\u0412\\u0438\\u0431\\u0440\\u043e\\u043f\\u043b\\u0438\\u0442\\u0430 160 \\u043a\\u0433'), 160000, 'https://example.test/p160', { [ru('\\u043c\\u0430\\u0441\\u0441\\u0430, \\u043a\\u0433')]: '160' }),
      productWithSpecs('p70', ru('\\u0412\\u0438\\u0431\\u0440\\u043e\\u043f\\u043b\\u0438\\u0442\\u0430 70 \\u043a\\u0433'), 70000, 'https://example.test/p70', { [ru('\\u043c\\u0430\\u0441\\u0441\\u0430, \\u043a\\u0433')]: '70' }),
      productWithSpecs('rammer', ru('\\u0412\\u0438\\u0431\\u0440\\u043e\\u0442\\u0440\\u0430\\u043c\\u0431\\u043e\\u0432\\u043a\\u0430 120 \\u043a\\u0433'), 130000, 'https://example.test/rammer', { [ru('\\u043c\\u0430\\u0441\\u0441\\u0430, \\u043a\\u0433')]: '120' })
    ]) as never);

    const slice = await assistant.findStructuredCatalogSlice(message, state, {
      action: 'recommend_products',
      answerMode: 'productRecommendation',
      cardPolicy: 'showProducts',
      followUpPolicy: 'auto',
      contextScope: 'activeNeed',
      searchScope: 'focusedNeed',
      catalogSearchQuery: message,
      selectedProductIds: [],
      requiredProductTraits: {
        productIntent: 'plate',
        productRole: 'coreProduct',
        fuel: 'unknown',
        startType: 'unknown',
        enclosure: 'unknown',
        conventionalGenerator: null,
        singlePhase220: null,
        nominalPowerKwMin: null,
        nominalPowerKwMax: null,
        maxPowerKwMin: null,
        maxPowerKwMax: null,
        powerReasoning: ''
      },
      needsWebSearch: false,
      missingInformation: [],
      answerGuidance: ''
    } as any);

    expect(slice?.source).toBe('structured_constraints');
    expect(slice?.constraints.weightKgMin).toBe(90);
    expect(slice?.constraints.weightKgMax).toBe(160);
    expect(slice?.products.map((item) => item.id).sort()).toEqual(['p120', 'p160', 'p90']);
  });

  it('lets the resolved turn contract disable structured catalog expansion for factual text-only turns', async () => {
    const message = 'Нужна виброплита 100-150 кг';
    const state = mergeNeedState(emptyNeedState(), heuristicNeedUpdate(message));
    const assistant = new AssistantService(undefined as never, new FakeProducts([
      productWithSpecs('p120', 'Виброплита 120 кг', 120000, 'https://example.test/p120', { 'масса, кг': '120' })
    ]) as never);
    const plan = baseTurnPlan({
      action: 'recommend_products',
      answerMode: 'productRecommendation',
      cardPolicy: 'showProducts',
      catalogSearchQuery: message,
      requiredProductTraits: {
        ...baseTurnPlan().requiredProductTraits,
        productIntent: 'plate',
        productRole: 'coreProduct',
        weightKgMin: 100,
        weightKgMax: 150
      }
    });
    const contract = assistantTestHooks.resolveTurnContractForPlan(plan, {
      forceTextOnlyReason: 'detailed_fact'
    });

    const slice = await assistant.findStructuredCatalogSlice(message, state, plan, contract);

    expect(slice).toBeNull();
  });

  it('lets the resolved turn contract disable full-catalog selection for factual text-only turns', async () => {
    const message = 'Нужна виброплита 100-150 кг';
    const state = mergeNeedState(emptyNeedState(), heuristicNeedUpdate(message));
    const assistant = new AssistantService(undefined as never, new FakeProducts([
      productWithSpecs('p120', 'Виброплита 120 кг', 120000, 'https://example.test/p120', { 'масса, кг': '120' })
    ]) as never);
    const plan = baseTurnPlan({
      action: 'recommend_products',
      answerMode: 'productRecommendation',
      cardPolicy: 'showProducts',
      catalogSearchQuery: message,
      requiredProductTraits: {
        ...baseTurnPlan().requiredProductTraits,
        productIntent: 'plate',
        productRole: 'coreProduct',
        weightKgMin: 100,
        weightKgMax: 150
      },
      selectionState: {
        ...baseTurnPlan().selectionState,
        targetProductClass: 'plate',
        currentProductClass: 'plate',
        hardConstraints: {
          productIntent: 'plate',
          weightKgMin: 100,
          weightKgMax: 150
        },
        confidence: 0.8,
        selectionConfidence: 0.8,
        shouldShowCards: true
      }
    });
    const contract = assistantTestHooks.resolveTurnContractForPlan(plan, {
      forceTextOnlyReason: 'detailed_fact'
    });

    const selection = await assistant.selectProductsForTurn(message, state, plan, [], contract);

    expect(selection.trace.source).toBe('candidate_selection_engine');
    expect(selection.matchedProducts).toHaveLength(0);
    expect(selection.state.selectedProductIds).toEqual([]);
  });

  it('uses resolved turn contract selected products instead of stale planner selections in selection scoring', async () => {
    const message = 'Нужна виброплита 100-150 кг';
    const state = mergeNeedState(emptyNeedState(), heuristicNeedUpdate(message));
    const assistant = new AssistantService(undefined as never, new FakeProducts([
      productWithSpecs('fresh', 'Виброплита 120 кг fresh', 120000, 'https://example.test/fresh', { 'масса, кг': '120' }),
      productWithSpecs('stale', 'Виброплита 120 кг stale', 120000, 'https://example.test/stale', { 'масса, кг': '120' })
    ]) as never);
    const plan = baseTurnPlan({
      action: 'recommend_products',
      answerMode: 'productRecommendation',
      cardPolicy: 'showProducts',
      catalogSearchQuery: message,
      selectedProductIds: ['stale'],
      requiredProductTraits: {
        ...baseTurnPlan().requiredProductTraits,
        productIntent: 'plate',
        productRole: 'coreProduct',
        weightKgMin: 100,
        weightKgMax: 150
      },
      selectionState: {
        ...baseTurnPlan().selectionState,
        targetProductClass: 'plate',
        currentProductClass: 'plate',
        hardConstraints: {
          productIntent: 'plate',
          weightKgMin: 100,
          weightKgMax: 150
        },
        confidence: 0.8,
        selectionConfidence: 0.8,
        shouldShowCards: true
      }
    });
    const baseContract = assistantTestHooks.resolveTurnContractForPlan(plan);
    const contract = {
      ...baseContract,
      selection: {
        ...baseContract.selection,
        selectedProductIds: []
      }
    };

    const selection = await assistant.selectProductsForTurn(message, state, plan, [], contract);

    expect(selection.matchedProducts.map((product) => product.id).slice(0, 2)).toEqual(['fresh', 'stale']);
  });

  it('parses hyphenated plus-minus tolerance in weight ranges', () => {
    const parsed = assistantTestHooks.parseWeightNeedRangeKg('вес 100-150 кг, плюс-минус 10 кг можно');

    expect(parsed).toEqual({ min: 90, max: 160 });
    expect(assistantTestHooks.parseWeightNeedRangeKg('А если взять 100-120 кг, сильно лучше будет?')).toEqual({ min: 100, max: 120 });
    expect(assistantTestHooks.parseWeightNeedRangeKg('нужна виброплита примерно 1000 кг')).toEqual({ min: 800, max: 1200 });
    expect(assistantTestHooks.parseWeightNeedRangeKg('не тяжелее 80 кг')).toEqual({ min: 0, max: 80 });
  });

  it('builds a full catalog slice for generator power constraints, not only plate weights', async () => {
    const message = 'need benzin generator 5-6 kw for dacha';
    const state = mergeNeedState(emptyNeedState(), heuristicNeedUpdate(message));
    const assistant = new AssistantService(undefined as never, new FakeProducts([
      product('plate', 'Plate compactor 120 kg', 120000, 'https://example.test/plate'),
      product('gen55', 'Generator benzin Alpha 5.5 kw', 55000, 'https://example.test/generator-55'),
      product('gen60', 'Generator benzin Bravo 6.0 kw', 65000, 'https://example.test/generator-60'),
      product('gen90', 'Generator benzin Big 9.0 kw', 115000, 'https://example.test/generator-90')
    ]) as never);

    const slice = await assistant.findStructuredCatalogSlice(message, state, {
      action: 'recommend_products',
      answerMode: 'productRecommendation',
      cardPolicy: 'showProducts',
      followUpPolicy: 'auto',
      contextScope: 'activeNeed',
      searchScope: 'focusedNeed',
      catalogSearchQuery: message,
      selectedProductIds: [],
      requiredProductTraits: {
        productIntent: 'generator',
        productRole: 'coreProduct',
        fuel: 'unknown',
        startType: 'unknown',
        enclosure: 'unknown',
        conventionalGenerator: null,
        singlePhase220: null,
        nominalPowerKwMin: 5,
        nominalPowerKwMax: 6,
        maxPowerKwMin: null,
        maxPowerKwMax: null,
        powerReasoning: 'explicit range'
      },
      selectionState: {
        currentProductClass: 'generator',
        targetProductClass: 'generator',
        compatibilityTargetProduct: '',
        mustHaveTraits: ['5-6 kw'],
        niceToHaveTraits: [],
        excludedClasses: [],
        brandConstraint: '',
        exactModelConstraint: '',
        isAccessoryFollowUp: false,
        selectionConfidence: 0.9,
        shouldShowCards: true,
        cardDisplayMode: 'exact_matches'
      },
      needsWebSearch: false,
      missingInformation: [],
      answerGuidance: ''
    } as any);

    expect(slice?.source).toBe('full_catalog_slice');
    expect(slice?.constraints.nominalPowerKwMin).toBe(5);
    expect(slice?.constraints.nominalPowerKwMax).toBe(6);
    expect(slice?.products.map((item) => item.id).sort()).toEqual(['gen55', 'gen60']);
  });

  it('builds a full catalog slice for diamond core diameter constraints', async () => {
    const message = 'need diamond core drill 72 mm for concrete';
    const state = mergeNeedState(emptyNeedState(), heuristicNeedUpdate(message));
    const assistant = new AssistantService(undefined as never, new FakeProducts([
      product('core72', 'Diamond core drill 72 mm', 7000, 'https://example.test/core-72'),
      product('core70', 'Diamond core drill 70 mm', 6800, 'https://example.test/core-70'),
      product('core125', 'Diamond core drill 125 mm', 9500, 'https://example.test/core-125'),
      product('blade72', 'Diamond blade 72 mm', 2500, 'https://example.test/blade-72')
    ]) as never);

    const slice = await assistant.findStructuredCatalogSlice(message, state, {
      action: 'recommend_products',
      answerMode: 'productRecommendation',
      cardPolicy: 'showProducts',
      followUpPolicy: 'auto',
      contextScope: 'activeNeed',
      searchScope: 'focusedNeed',
      catalogSearchQuery: message,
      selectedProductIds: [],
      requiredProductTraits: {
        productIntent: 'diamondCore',
        productRole: 'coreProduct',
        fuel: 'unknown',
        startType: 'unknown',
        enclosure: 'unknown',
        conventionalGenerator: null,
        singlePhase220: null,
        nominalPowerKwMin: null,
        nominalPowerKwMax: null,
        maxPowerKwMin: null,
        maxPowerKwMax: null,
        powerReasoning: ''
      },
      selectionState: {
        currentProductClass: 'diamondCore',
        targetProductClass: 'diamondCore',
        compatibilityTargetProduct: '',
        mustHaveTraits: ['72 mm'],
        niceToHaveTraits: [],
        excludedClasses: [],
        brandConstraint: '',
        exactModelConstraint: '',
        isAccessoryFollowUp: false,
        selectionConfidence: 0.9,
        shouldShowCards: true,
        cardDisplayMode: 'exact_matches'
      },
      needsWebSearch: false,
      missingInformation: [],
      answerGuidance: ''
    } as any);

    expect(slice?.source).toBe('full_catalog_slice');
    expect(slice?.constraints.diameterMmMin).toBe(70);
    expect(slice?.constraints.diameterMmMax).toBe(74);
    expect(slice?.products.map((item) => item.id).sort()).toEqual(['core70', 'core72']);
  });

  it('does not treat LF 80 L as an exact LF 80 LAT match', async () => {
    const message = 'Есть ли в каталоге виброплита Husqvarna LF 80 LAT?';
    const state = mergeNeedState(emptyNeedState(), heuristicNeedUpdate(message));
    const assistant = new AssistantService(undefined as never, new FakeProducts([
      product('lf80l', 'Виброплита прямоходная бензиновая Husqvarna LF 80 L (84 кг)', 251000, 'https://example.test/lf_80_l/'),
      product('lf80lat', 'Виброплита прямоходная бензиновая Husqvarna LF 80 LAT (95 кг) 9678550-02', 255000, 'https://example.test/lf_80_lat/')
    ]) as never);

    const slice = await assistant.findStructuredCatalogSlice(message, state, {
      action: 'recommend_products',
      answerMode: 'productRecommendation',
      cardPolicy: 'showProducts',
      followUpPolicy: 'auto',
      contextScope: 'activeNeed',
      searchScope: 'focusedNeed',
      catalogSearchQuery: message,
      selectedProductIds: [],
      requiredProductTraits: {
        productIntent: 'plate',
        productRole: 'coreProduct',
        fuel: 'unknown',
        startType: 'unknown',
        enclosure: 'unknown',
        conventionalGenerator: null,
        singlePhase220: null,
        nominalPowerKwMin: null,
        nominalPowerKwMax: null,
        maxPowerKwMin: null,
        maxPowerKwMax: null,
        powerReasoning: ''
      },
      selectionState: {
        currentProductClass: 'plate',
        targetProductClass: 'plate',
        compatibilityTargetProduct: '',
        mustHaveTraits: ['LF 80 LAT'],
        niceToHaveTraits: [],
        excludedClasses: [],
        brandConstraint: 'Husqvarna',
        exactModelConstraint: 'LF 80 LAT',
        isAccessoryFollowUp: false,
        selectionConfidence: 0.95,
        shouldShowCards: true,
        cardDisplayMode: 'exact_matches'
      },
      needsWebSearch: false,
      missingInformation: [],
      answerGuidance: ''
    } as any);

    expect(slice?.products.map((item) => item.id)).toEqual(['lf80lat']);
  });

  it('does not mutate final cards when the final answer mentions another valid candidate', () => {
    const message = 'need benzin generator 5-6 kw';
    const state = mergeNeedState(emptyNeedState(), heuristicNeedUpdate(message));
    const products = [
      product('a', 'Generator benzin Alpha 5.5 kw', 55000, 'https://example.test/a'),
      product('b', 'Generator benzin Bravo 6.0 kw', 65000, 'https://example.test/b')
    ];
    const result = assistantTestHooks.enforceAnswerCardContract(
      'Best option here is Generator benzin Bravo 6.0 kw.',
      assistantTestHooks.cardsFromPlan([products[0]], state, message, {
        action: 'recommend_products',
        catalogSearchQuery: message,
        selectedProductIds: [],
        needsWebSearch: false,
        missingInformation: [],
        answerGuidance: ''
      } as any),
      products,
      state,
      message,
      {
        action: 'recommend_products',
        answerMode: 'productRecommendation',
        cardPolicy: 'showProducts',
        followUpPolicy: 'auto',
        contextScope: 'activeNeed',
        searchScope: 'focusedNeed',
        catalogSearchQuery: message,
        selectedProductIds: [],
        requiredProductTraits: {
          productIntent: 'generator',
          productRole: 'coreProduct',
          fuel: 'unknown',
          startType: 'unknown',
          enclosure: 'unknown',
          conventionalGenerator: null,
          singlePhase220: null,
          nominalPowerKwMin: 5,
          nominalPowerKwMax: 6,
          maxPowerKwMin: null,
          maxPowerKwMax: null,
          powerReasoning: ''
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
          selectionConfidence: 0.9,
          shouldShowCards: true,
          cardDisplayMode: 'exact_matches'
        },
        needsWebSearch: false,
        missingInformation: [],
        answerGuidance: ''
      } as any
    );

    expect(result.cards.map((card) => card.id)).toEqual(['a']);
    expect(result.diagnostics.mentionedProductIds).toEqual(['b']);
    expect(result.diagnostics.outsideFinalCardIds).toEqual(['b']);
    expect(result.diagnostics.addedCardIds).toEqual([]);
    expect(result.diagnostics.reordered).toBe(false);
    expect(result.diagnostics.firstCardAligned).toBe(false);
  });

  it('repairs answer text instead of changing final cards when a non-final product is mentioned', () => {
    const message = 'need benzin generator 5-6 kw';
    const state = mergeNeedState(emptyNeedState(), heuristicNeedUpdate(message));
    const products = [
      product('a', 'Generator benzin Alpha 5.5 kw', 55000, 'https://example.test/a'),
      product('b', 'Generator benzin Bravo 6.0 kw', 65000, 'https://example.test/b')
    ];
    const cards = assistantTestHooks.cardsFromPlan([products[0]], state, message, {
      action: 'recommend_products',
      catalogSearchQuery: message,
      selectedProductIds: [],
      needsWebSearch: false,
      missingInformation: [],
      answerGuidance: ''
    } as any);
    const plan = {
      action: 'recommend_products',
      answerMode: 'productRecommendation',
      cardPolicy: 'showProducts',
      followUpPolicy: 'auto',
      contextScope: 'activeNeed',
      searchScope: 'focusedNeed',
      catalogSearchQuery: message,
      selectedProductIds: [],
      requiredProductTraits: {
        productIntent: 'generator',
        productRole: 'coreProduct',
        fuel: 'unknown',
        startType: 'unknown',
        enclosure: 'unknown',
        conventionalGenerator: null,
        singlePhase220: null,
        nominalPowerKwMin: 5,
        nominalPowerKwMax: 6,
        maxPowerKwMin: null,
        maxPowerKwMax: null,
        powerReasoning: ''
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
        selectionConfidence: 0.9,
        shouldShowCards: true,
        cardDisplayMode: 'exact_matches'
      },
      needsWebSearch: false,
      missingInformation: [],
      answerGuidance: ''
    } as any;

    const repaired = assistantTestHooks.repairAnswerForFinalCards(
      'Best option here is Generator benzin Bravo 6.0 kw.',
      cards,
      products,
      state,
      message,
      plan
    );

    expect(repaired).toContain('Generator benzin Alpha 5.5 kw');
    expect(repaired).not.toContain('Generator benzin Bravo 6.0 kw');
  });

  it('does not expose uncarded candidates to product recommendation answer context', () => {
    const shown = product('shown', 'Generator gasoline shown 6.0 kW', 60_000, 'https://example.test/shown');
    const unshown = product('unshown', 'Generator gasoline unshown 6.0 kW', 65_000, 'https://example.test/unshown');
    const cards = [{
      id: shown.id,
      name: shown.name,
      category: shown.category,
      price: shown.price,
      reasons: []
    }];

    const products = assistantTestHooks.answerContextProductsForCards({
      answerNeedsFullCatalogContext: false,
      recommendationAnswer: true,
      blockEstimatedPumpCards: false,
      cards: cards as any,
      candidates: [shown, unshown],
      cardSourceProducts: [shown, unshown]
    });
    const withoutCards = assistantTestHooks.answerContextProductsForCards({
      answerNeedsFullCatalogContext: false,
      recommendationAnswer: true,
      blockEstimatedPumpCards: false,
      cards: [],
      candidates: [shown, unshown],
      cardSourceProducts: [shown, unshown]
    });

    expect(products.map((item) => item.id)).toEqual(['shown']);
    expect(withoutCards).toEqual([]);
  });

  it('keeps expanded fact answers able to use catalog candidates when cards are intentionally suppressed', () => {
    const candidate = product('fact', 'Generator gasoline factual model 6.0 kW', 60_000, 'https://example.test/fact');

    const products = assistantTestHooks.answerContextProductsForCards({
      answerNeedsFullCatalogContext: true,
      recommendationAnswer: false,
      blockEstimatedPumpCards: false,
      cards: [],
      candidates: [candidate],
      cardSourceProducts: []
    });

    expect(products.map((item) => item.id)).toEqual(['fact']);
  });

  it('does not force cards for reliable structured catalog selections when planner made the turn text-only', () => {
    const state = mergeProductSelectionState(emptyNeedState().selectionState, {
      targetProductClass: 'generator',
      hardConstraints: {
        productIntent: 'generator',
        productRole: 'coreProduct',
        nominalPowerKwMin: 5,
        nominalPowerKwMax: 7,
        exactModelTokens: [],
        mustHaveTraits: [],
        excludedClasses: [],
        provenance: {
          nominalPowerKwMin: 'explicit_user',
          nominalPowerKwMax: 'explicit_user'
        }
      },
      confidence: 0.8
    });
    const result = {
      state,
      matchedProducts: [product('g1', 'Generator gasoline inverter 6.0 kW', 80_000, 'https://example.test/g1')],
      confidence: 0.8
    };
    const plan = baseTurnPlan({
      action: 'answer_question',
      answerMode: 'short',
      cardPolicy: 'textOnly',
      selectedProductIds: [],
      selectionState: {
        ...baseTurnPlan().selectionState,
        shouldShowCards: false
      }
    });

    expect(assistantTestHooks.shouldForceStructuredSelectionCards(
      'show all suitable generator options for this load',
      plan,
      result as any
    )).toBe(false);
  });

  it('uses normalized selection constraints for structured card slices instead of stale planner traits', () => {
    const message = 'show suitable house generators with ordinary models as compromise';
    const productItem = productWithSpecs(
      'ordinary',
      'Generator gasoline SUMEC SU7700 5.0 kW open frame',
      42_490,
      'https://example.test/generators/sumec-su7700',
      {}
    );
    const state = {
      ...emptyNeedState(),
      selectionState: mergeProductSelectionState(emptyNeedState().selectionState, {
        targetProductClass: 'generator',
        hardConstraints: {
          productIntent: 'generator',
          productRole: 'coreProduct',
          fuel: 'gasoline',
          nominalPowerKwMin: 5,
          exactModelTokens: [],
          mustHaveTraits: [],
          excludedClasses: []
        },
        confidence: 0.9
      })
    };
    const stalePlannerPlan = baseTurnPlan({
      catalogSearchQuery: message,
      requiredProductTraits: {
        ...baseTurnPlan().requiredProductTraits,
        productIntent: 'generator',
        productRole: 'coreProduct',
        conventionalGenerator: false
      }
    });
    const normalizedPlan = baseTurnPlan({
      catalogSearchQuery: message,
      requiredProductTraits: {
        ...stalePlannerPlan.requiredProductTraits,
        conventionalGenerator: null
      },
      selectedProductIds: ['ordinary'],
      selectionState: {
        ...baseTurnPlan().selectionState,
        shouldShowCards: true,
        cardDisplayMode: 'structured_selection'
      }
    });

    expect(assistantTestHooks.selectCardsFromPlan([productItem], state, message, stalePlannerPlan).cards).toHaveLength(0);
    expect(assistantTestHooks.selectCardsFromPlan([productItem], state, message, normalizedPlan).cards.map((card) => card.id)).toEqual(['ordinary']);
  });

  it('keeps the full structured selection in cards so the UI can reveal more suitable products', () => {
    const message = 'show all suitable house generators';
    const products = Array.from({ length: 12 }, (_, index) => productWithSpecs(
      `g${index}`,
      `Generator gasoline Fit ${index + 5}.0 kW`,
      50_000 + index * 1000,
      `https://example.test/generators/g${index}`,
      {}
    ));
    const state = {
      ...emptyNeedState(),
      selectionState: mergeProductSelectionState(emptyNeedState().selectionState, {
        targetProductClass: 'generator',
        hardConstraints: {
          productIntent: 'generator',
          productRole: 'coreProduct',
          fuel: 'gasoline',
          nominalPowerKwMin: 5,
          exactModelTokens: [],
          mustHaveTraits: [],
          excludedClasses: []
        },
        confidence: 0.9
      })
    };
    const plan = baseTurnPlan({
      catalogSearchQuery: message,
      selectedProductIds: products.slice(0, 7).map((item) => item.id),
      requiredProductTraits: {
        ...baseTurnPlan().requiredProductTraits,
        productIntent: 'generator',
        productRole: 'coreProduct',
        fuel: 'gasoline',
        nominalPowerKwMin: 5
      },
      selectionState: {
        ...baseTurnPlan().selectionState,
        shouldShowCards: true,
        cardDisplayMode: 'structured_selection'
      }
    });

    const result = assistantTestHooks.selectCardsFromPlan(products, state, message, plan, { cardLimit: 50 });

    expect(result.cards).toHaveLength(12);
    expect(result.cards.slice(0, 7).map((card) => card.id)).toEqual(products.slice(0, 7).map((item) => item.id));
  });

  it('caps the initial visible structured selection to seven cards', () => {
    const products = Array.from({ length: 10 }, (_, index) => productWithSpecs(
      `g${index}`,
      `Generator gasoline electric ${index + 1}.0 kW`,
      50_000 + index * 1000,
      `https://example.test/generators/g${index}`,
      {}
    ));
    const cards = products.map((item) => ({
      id: item.id,
      name: item.name,
      category: item.category,
      price: item.price,
      specs: item.specs,
      reasons: [],
      caveats: []
    }));
    const result = reliableGeneratorSelectionResult({
      matchedProducts: products,
      visibleProducts: products,
      hiddenProducts: []
    });

    expect(assistantTestHooks.initialVisibleCardCountForCards(cards as any, result)).toBe(7);
    expect(assistantTestHooks.initialVisibleCardCountForCards(cards as any, result, 2)).toBe(2);
  });

  it('marks visible and show-more suitable products in answer context', () => {
    const first = product('first', 'Generator gasoline inverter first 6.0 kW', 60_000, 'https://example.test/first');
    const extra = product('extra', 'Generator gasoline extra 6.0 kW', 65_000, 'https://example.test/extra');

    const context = assistantTestHooks.compactSuitableProductsForAnswer(
      [first, extra],
      new Set(['first']),
      new Set(['first', 'extra'])
    );

    expect(context).toMatchObject([
      { id: 'first', visibleCard: true, behindShowMore: false, isInverter: true },
      { id: 'extra', visibleCard: false, behindShowMore: true, isConventionalGenerator: true }
    ]);
  });

  it('adds a show-more note for large structured slices when the answer omits it', () => {
    const cards = Array.from({ length: 12 }, (_, index) => ({
      id: `p${index}`,
      name: `Plate ${index}`,
      category: 'Plate compactors',
      price: 100000 + index,
      reasons: []
    }));
    const answer = assistantTestHooks.ensureLargeSliceShowMoreNote(
      'Есть варианты в нужном весе.\n\nУточните, нужна прямоходная или реверсивная?',
      {
        source: 'structured_constraints',
        products: [],
        totalMatched: 12,
        visibleLimit: 7,
        constraints: { productIntent: 'plate' }
      } as any,
      cards as any
    );

    expect(answer).toContain('Показать еще');
    expect(answer.endsWith('Уточните, нужна прямоходная или реверсивная?')).toBe(true);
  });

  it('names hidden show-more cards when the answer only refers to them generically', () => {
    const cards = [
      { id: 'tss-8', name: 'Генератор бензиновый ТСС SGG 9000ELA (8,0 кВт)', category: 'Генераторы', price: 95059, specs: {}, reasons: [], caveats: [] },
      { id: 'tss-9', name: 'Генератор бензиновый инверторный ТСС SGG 10000EI (9,0 кВт)', category: 'Генераторы', price: 153112, specs: {}, reasons: [], caveats: [] },
      { id: 'tss-10', name: 'Генератор бензиновый ТСС SGG 10000EHA (10,0 кВт) 190009', category: 'Генераторы', price: 213941, specs: {}, reasons: [], caveats: [] }
    ];

    const answer = assistantTestHooks.ensureLargeSliceShowMoreNote(
      'В текущем каталоге ТСС есть 3 генератора в диапазоне 8-10 кВт. 10 кВт тоже есть, он лежит под "Показать еще".',
      {
        source: 'structured_constraints',
        products: [],
        totalMatched: 3,
        visibleLimit: 2,
        constraints: { productIntent: 'generator' }
      } as any,
      cards as any,
      2
    );

    expect(answer).toContain('SGG 10000EHA');
  });

  it('keeps catalog availability questions out of current-lineup routing but respects explicit planner web search', () => {
    const message = ru('\\u0410 \\u0447\\u0442\\u043e \\u0440\\u0430\\u0437\\u0432\\u0435 \\u043d\\u0435\\u0442 \\u043f\\u043b\\u0438\\u0442 BPS 1550 WACKER? \\u0418\\u043b\\u0438 \\u043d\\u0435\\u0442 LAT 100 \\u0438\\u043b\\u0438 LAT 80 \\u043e\\u0442 HUSQVARNA?');
    const plan = {
      action: 'answer_question',
      answerMode: 'currentLineup',
      cardPolicy: 'textOnly',
      followUpPolicy: 'answerNowNoDeferredOffer',
      contextScope: 'activeNeed',
      searchScope: 'focusedNeed',
      catalogSearchQuery: message,
      selectedProductIds: [],
      requiredProductTraits: {
        productIntent: 'plate',
        productRole: 'coreProduct',
        fuel: 'unknown',
        startType: 'unknown',
        enclosure: 'unknown',
        conventionalGenerator: null,
        singlePhase220: null,
        nominalPowerKwMin: null,
        nominalPowerKwMax: null,
        maxPowerKwMin: null,
        maxPowerKwMax: null,
        powerReasoning: ''
      },
      needsWebSearch: true,
      missingInformation: [],
      answerGuidance: ''
    } as any;

    expect(assistantTestHooks.isCatalogAvailabilityQuestion(message)).toBe(true);
    expect(assistantTestHooks.isManufacturingStatusQuestion(message)).toBe(false);
    expect(assistantTestHooks.shouldUseCurrentLineupStyle(message, plan)).toBe(false);
    expect(assistantTestHooks.shouldUseWebSearch(message, plan)).toBe(true);
    expect(assistantTestHooks.shouldUseWebSearch(message, {
      ...plan,
      answerMode: 'short',
      needsWebSearch: false
    })).toBe(false);
  });

  it('routes shown-card main/backup follow-ups back to product cards, not current-lineup fact checks', () => {
    const message = ru('\\u0412\\u044b\\u0431\\u0435\\u0440\\u0438\\u0442\\u0435 \\u0438\\u0437 \\u044d\\u0442\\u0438\\u0445 \\u043a\\u0430\\u0440\\u0442\\u043e\\u0447\\u0435\\u043a \\u043e\\u0434\\u0438\\u043d \\u043e\\u0441\\u043d\\u043e\\u0432\\u043d\\u043e\\u0439 \\u0432\\u0430\\u0440\\u0438\\u0430\\u043d\\u0442 \\u0438 \\u043e\\u0434\\u0438\\u043d \\u0437\\u0430\\u043f\\u0430\\u0441\\u043d\\u043e\\u0439, \\u043e\\u0441\\u0442\\u0430\\u043b\\u044c\\u043d\\u044b\\u0435 \\u043f\\u0443\\u0441\\u0442\\u044c \\u0431\\u0443\\u0434\\u0443\\u0442 \\u0432 \\u041f\\u043e\\u043a\\u0430\\u0437\\u0430\\u0442\\u044c \\u0435\\u0449\\u0435.');
    const plan = baseTurnPlan({
      action: 'answer_question',
      answerMode: 'unknown',
      cardPolicy: 'showProducts',
      selectedProductIds: [],
      agentDecision: productSelectionAgentDecision(),
      selectionState: {
        ...baseTurnPlan().selectionState,
        shouldShowCards: false
      }
    });
    const state = mergeProductSelectionState(emptyNeedState().selectionState, {
      currentProductClass: 'generator',
      targetProductClass: 'generator',
      hardConstraints: {
        productIntent: 'generator',
        productRole: 'coreProduct',
        nominalPowerKwMin: 4,
        nominalPowerKwMax: 6,
        exactModelTokens: [],
        mustHaveTraits: [],
        excludedClasses: []
      },
      confidence: 0.86
    });
    const result = {
      matchedProducts: [product('g1', 'Generator gasoline 5 kW', 50_000, 'https://example.test/g1')],
      state,
      confidence: 0.86
    } as any;

    expect(assistantTestHooks.isProductCardSelectionFollowUp(message)).toBe(true);
    expect(assistantTestHooks.shouldUseCurrentLineupStyle(message, plan)).toBe(false);
    expect(assistantTestHooks.shouldForceStructuredSelectionCards(message, plan, result)).toBe(true);
  });

  it('does not invent random cards when a shown-card follow-up has lost selection context', () => {
    const message = ru('\\u0412\\u044b\\u0431\\u0435\\u0440\\u0438\\u0442\\u0435 \\u0438\\u0437 \\u044d\\u0442\\u0438\\u0445 \\u043a\\u0430\\u0440\\u0442\\u043e\\u0447\\u0435\\u043a \\u043e\\u0434\\u0438\\u043d \\u043e\\u0441\\u043d\\u043e\\u0432\\u043d\\u043e\\u0439 \\u0438 \\u043e\\u0434\\u0438\\u043d \\u0437\\u0430\\u043f\\u0430\\u0441\\u043d\\u043e\\u0439.');
    const result = assistantTestHooks.selectCardsFromPlan([
      product('oil', 'Engine oil 10W-40', 640, 'https://example.test/oil'),
      product('disc', 'Diamond blade 110 mm', 713, 'https://example.test/disc')
    ], emptyNeedState(), message, baseTurnPlan({
      action: 'recommend_products',
      answerMode: 'productRecommendation',
      cardPolicy: 'showProducts'
    }));

    expect(result.cards).toHaveLength(0);
    expect(result.diagnostics.fallbackReason).toBe('card_followup_without_previous_selection');
  });

  it('does not let text fallback override a structured planner product intent', () => {
    const profile = assistantTestHooks.buildProductFitProfile(
      emptyNeedState(),
      'oil filter and oil for generator',
      'oil filter and oil for generator',
      {
        ...baseTurnPlan().requiredProductTraits,
        productIntent: 'generator',
        productRole: 'coreProduct'
      }
    );

    expect(profile.intent).toBe('generator');
  });

  it('does not append ranked fallback cards when the planner selected exact visible products', () => {
    const state = emptyNeedState();
    const products = [
      product('selected', 'Generator gasoline Selected 5 kW', 50_000, 'https://example.test/catalog/generators/selected'),
      product('fallback', 'Generator gasoline Fallback 5 kW', 45_000, 'https://example.test/catalog/generators/fallback')
    ];
    const cards = assistantTestHooks.cardsFromPlan(products, state, 'show selected generator', baseTurnPlan({
      selectedProductIds: ['selected'],
      selectionState: {
        ...baseTurnPlan().selectionState,
        selectionConfidence: 0.8,
        shouldShowCards: true
      }
    }));

    expect(cards.map((card) => card.id)).toEqual(['selected']);
  });

  it('does not invent cards when a confident planner chose none', () => {
    const state = emptyNeedState();
    const products = [
      product('fallback', 'Generator gasoline Fallback 5 kW', 45_000, 'https://example.test/catalog/generators/fallback')
    ];
    const cards = assistantTestHooks.cardsFromPlan(products, state, 'show generator', baseTurnPlan({
      selectedProductIds: [],
      selectionState: {
        ...baseTurnPlan().selectionState,
        selectionConfidence: 0.8,
        shouldShowCards: false
      }
    }));

    expect(cards).toEqual([]);
  });

  it('treats electric start as a required need, not only a ranking bonus', () => {
    const message = ru('\\u041d\\u0443\\u0436\\u0435\\u043d \\u0431\\u0435\\u043d\\u0437\\u0438\\u043d\\u043e\\u0432\\u044b\\u0439 \\u0433\\u0435\\u043d\\u0435\\u0440\\u0430\\u0442\\u043e\\u0440 5-6 \\u043a\\u0412\\u0442 220 \\u0412 \\u0441 \\u044d\\u043b\\u0435\\u043a\\u0442\\u0440\\u043e\\u0441\\u0442\\u0430\\u0440\\u0442\\u0435\\u0440\\u043e\\u043c');
    const state = mergeNeedState(emptyNeedState(), heuristicNeedUpdate(message));
    const cards = assistantTestHooks.cardsFromPlan([
      productWithSpecs('manual', ru('\\u0413\\u0435\\u043d\\u0435\\u0440\\u0430\\u0442\\u043e\\u0440 \\u0431\\u0435\\u043d\\u0437\\u0438\\u043d\\u043e\\u0432\\u044b\\u0439 A-iPower LITE AP5500 (5,0 \\u043a\\u0412\\u0442)'), 48990, 'https://example.test/catalog/benzinovye_generatory/ap5500/', { start: ru('\\u0440\\u0443\\u0447\\u043d\\u043e\\u0439') }),
      productWithSpecs('electric', ru('\\u0413\\u0435\\u043d\\u0435\\u0440\\u0430\\u0442\\u043e\\u0440 \\u0431\\u0435\\u043d\\u0437\\u0438\\u043d\\u043e\\u0432\\u044b\\u0439 A-iPower LITE AP5500E (5,0 \\u043a\\u0412\\u0442)'), 55990, 'https://example.test/catalog/benzinovye_generatory/ap5500e/', { start: ru('\\u044d\\u043b\\u0435\\u043a\\u0442\\u0440\\u043e\\u0441\\u0442\\u0430\\u0440\\u0442\\u0435\\u0440') })
    ], state, message, {
      action: 'recommend_products',
      catalogSearchQuery: message,
      selectedProductIds: [],
      needsWebSearch: false,
      missingInformation: [],
      answerGuidance: 'recommend'
    } as any);

    expect(cards.map((card) => card.id)).toEqual(['electric']);
  });

  it('uses planner semantic traits as the main source for electric-start filtering', () => {
    const message = ru('\\u041d\\u0443\\u0436\\u0435\\u043d \\u0431\\u0435\\u043d\\u0437\\u0438\\u043d\\u043e\\u0432\\u044b\\u0439 \\u0433\\u0435\\u043d\\u0435\\u0440\\u0430\\u0442\\u043e\\u0440 220 \\u0412. \\u0411\\u0443\\u0434\\u0435\\u0442 \\u043f\\u043e\\u0436\\u0438\\u043b\\u043e\\u0439 \\u0447\\u0435\\u043b\\u043e\\u0432\\u0435\\u043a, \\u043d\\u0443\\u0436\\u043d\\u043e \\u0447\\u0442\\u043e\\u0431\\u044b \\u0437\\u0430\\u0432\\u0435\\u0441\\u0442\\u0438 \\u0431\\u0435\\u0437 \\u0440\\u044b\\u0432\\u043a\\u0430 \\u0437\\u0430 \\u0448\\u043d\\u0443\\u0440');
    const state = mergeNeedState(emptyNeedState(), heuristicNeedUpdate(message));
    const cards = assistantTestHooks.cardsFromPlan([
      productWithSpecs('manual', ru('\\u0413\\u0435\\u043d\\u0435\\u0440\\u0430\\u0442\\u043e\\u0440 \\u0431\\u0435\\u043d\\u0437\\u0438\\u043d\\u043e\\u0432\\u044b\\u0439 A-iPower AP5500 (5,0 \\u043a\\u0412\\u0442)'), 48990, 'https://example.test/catalog/benzinovye_generatory/ap5500/', { start: ru('\\u0440\\u0443\\u0447\\u043d\\u043e\\u0439') }),
      productWithSpecs('electric', ru('\\u0413\\u0435\\u043d\\u0435\\u0440\\u0430\\u0442\\u043e\\u0440 \\u0431\\u0435\\u043d\\u0437\\u0438\\u043d\\u043e\\u0432\\u044b\\u0439 DAEWOO GDA 6500E (5,5 \\u043a\\u0412\\u0442)'), 67990, 'https://example.test/catalog/benzinovye_generatory/gda6500e/', { start: ru('\\u0440\\u0443\\u0447\\u043d\\u043e\\u0439/\\u044d\\u043b\\u0435\\u043a\\u0442\\u0440\\u043e\\u0441\\u0442\\u0430\\u0440\\u0442\\u0435\\u0440') })
    ], state, message, {
      action: 'recommend_products',
      catalogSearchQuery: ru('\\u0431\\u0435\\u043d\\u0437\\u0438\\u043d\\u043e\\u0432\\u044b\\u0439 \\u0433\\u0435\\u043d\\u0435\\u0440\\u0430\\u0442\\u043e\\u0440 220 \\u0412 \\u0443\\u0434\\u043e\\u0431\\u043d\\u044b\\u0439 \\u0437\\u0430\\u043f\\u0443\\u0441\\u043a'),
      selectedProductIds: [],
      requiredProductTraits: {
        productIntent: 'generator',
        fuel: 'gasoline',
        startType: 'electric',
        conventionalGenerator: null,
        singlePhase220: true,
        nominalPowerKwMin: null,
        nominalPowerKwMax: null,
        maxPowerKwMin: null,
        maxPowerKwMax: null,
        powerReasoning: ru('\\u041f\\u043b\\u0430\\u043d\\u0438\\u0440\\u043e\\u0432\\u0449\\u0438\\u043a \\u043f\\u043e \\u0441\\u043c\\u044b\\u0441\\u043b\\u0443 \\u043f\\u043e\\u043d\\u044f\\u043b, \\u0447\\u0442\\u043e \\u043d\\u0443\\u0436\\u0435\\u043d \\u043b\\u0435\\u0433\\u043a\\u0438\\u0439 \\u0437\\u0430\\u043f\\u0443\\u0441\\u043a.')
      },
      needsWebSearch: false,
      missingInformation: [],
      answerGuidance: 'recommend'
    } as any);

    expect(cards.map((card) => card.id)).toEqual(['electric']);
  });

  it('does not oversize a generator for pump, refrigerator, and lights', () => {
    const message = ru('\\u041d\\u0443\\u0436\\u0435\\u043d \\u0433\\u0435\\u043d\\u0435\\u0440\\u0430\\u0442\\u043e\\u0440 \\u043d\\u0430 \\u0434\\u0430\\u0447\\u0443: \\u043d\\u0430\\u0441\\u043e\\u0441 900 \\u0412\\u0442, \\u0445\\u043e\\u043b\\u043e\\u0434\\u0438\\u043b\\u044c\\u043d\\u0438\\u043a \\u0438 \\u0441\\u0432\\u0435\\u0442. \\u0417\\u0430\\u043f\\u0443\\u0441\\u043a\\u0430\\u0442\\u044c \\u043c\\u043e\\u0433\\u0443 \\u043f\\u043e \\u043e\\u0447\\u0435\\u0440\\u0435\\u0434\\u0438');
    const state = mergeNeedState(emptyNeedState(), heuristicNeedUpdate(message));
    const cards = assistantTestHooks.cardsFromPlan([
      productWithSpecs('right', ru('\\u0413\\u0435\\u043d\\u0435\\u0440\\u0430\\u0442\\u043e\\u0440 \\u0431\\u0435\\u043d\\u0437\\u0438\\u043d\\u043e\\u0432\\u044b\\u0439 Honda 3200 (3,2 \\u043a\\u0412\\u0442)'), 62000, 'https://example.test/catalog/benzinovye_generatory/honda3200/', { 'Максимальная мощность': ru('3,8 \\u043a\\u0412\\u0442') }),
      productWithSpecs('oversized', ru('\\u0413\\u0435\\u043d\\u0435\\u0440\\u0430\\u0442\\u043e\\u0440 \\u0431\\u0435\\u043d\\u0437\\u0438\\u043d\\u043e\\u0432\\u044b\\u0439 BigPower 6000 (6,0 \\u043a\\u0412\\u0442)'), 76000, 'https://example.test/catalog/benzinovye_generatory/big6000/', { 'Максимальная мощность': ru('6,5 \\u043a\\u0412\\u0442') })
    ], state, message, {
      action: 'recommend_products',
      catalogSearchQuery: message,
      selectedProductIds: [],
      needsWebSearch: false,
      missingInformation: [],
      answerGuidance: 'recommend'
    } as any);

    expect(cards.map((card) => card.id)).toEqual(['right']);
  });

  it('uses the current product task when the buyer switches from generator to plate', () => {
    const firstMessage = ru('\\u041d\\u0443\\u0436\\u0435\\u043d \\u0433\\u0435\\u043d\\u0435\\u0440\\u0430\\u0442\\u043e\\u0440 \\u0434\\u043b\\u044f \\u0434\\u0430\\u0447\\u0438');
    const nextMessage = ru('\\u0422\\u0435\\u043f\\u0435\\u0440\\u044c \\u0434\\u0440\\u0443\\u0433\\u0430\\u044f \\u0437\\u0430\\u0434\\u0430\\u0447\\u0430: \\u043d\\u0443\\u0436\\u043d\\u0430 \\u0432\\u0438\\u0431\\u0440\\u043e\\u043f\\u043b\\u0438\\u0442\\u0430 \\u0434\\u043b\\u044f \\u0431\\u0440\\u0438\\u0433\\u0430\\u0434\\u044b');
    let state = mergeNeedState(emptyNeedState(), heuristicNeedUpdate(firstMessage));
    state = mergeNeedState(state, heuristicNeedUpdate(nextMessage));

    const cards = assistantTestHooks.cardsFromPlan([
      product('generator', ru('\\u0413\\u0435\\u043d\\u0435\\u0440\\u0430\\u0442\\u043e\\u0440 \\u0431\\u0435\\u043d\\u0437\\u0438\\u043d\\u043e\\u0432\\u044b\\u0439 5 \\u043a\\u0412\\u0442'), 50000, 'https://example.test/catalog/benzinovye_generatory/generator/'),
      product('plate', ru('\\u0412\\u0438\\u0431\\u0440\\u043e\\u043f\\u043b\\u0438\\u0442\\u0430 \\u0431\\u0435\\u043d\\u0437\\u0438\\u043d\\u043e\\u0432\\u0430\\u044f 90 \\u043a\\u0433'), 110000, 'https://example.test/catalog/vibroplity/plate/')
    ], state, nextMessage, {
      action: 'recommend_products',
      catalogSearchQuery: nextMessage,
      selectedProductIds: [],
      needsWebSearch: false,
      missingInformation: [],
      answerGuidance: 'recommend'
    } as any);

    expect(cards.map((card) => card.id)).toEqual(['plate']);
  });

  it('does not show generators for a diamond blade request after generator context', () => {
    const firstMessage = ru('\\u041d\\u0443\\u0436\\u0435\\u043d \\u0433\\u0435\\u043d\\u0435\\u0440\\u0430\\u0442\\u043e\\u0440');
    const nextMessage = ru('\\u042f \\u043f\\u043b\\u0438\\u0442\\u043e\\u0447\\u043d\\u0438\\u043a, \\u043d\\u0443\\u0436\\u0435\\u043d \\u0430\\u043b\\u043c\\u0430\\u0437\\u043d\\u044b\\u0439 \\u0434\\u0438\\u0441\\u043a 250 \\u043c\\u043c \\u0434\\u043b\\u044f \\u043a\\u0435\\u0440\\u0430\\u043c\\u043e\\u0433\\u0440\\u0430\\u043d\\u0438\\u0442\\u0430');
    let state = mergeNeedState(emptyNeedState(), heuristicNeedUpdate(firstMessage));
    state = mergeNeedState(state, heuristicNeedUpdate(nextMessage));

    const cards = assistantTestHooks.cardsFromPlan([
      product('generator', ru('\\u0413\\u0435\\u043d\\u0435\\u0440\\u0430\\u0442\\u043e\\u0440 \\u0431\\u0435\\u043d\\u0437\\u0438\\u043d\\u043e\\u0432\\u044b\\u0439 5 \\u043a\\u0412\\u0442'), 50000, 'https://example.test/catalog/benzinovye_generatory/generator/'),
      product('blade', ru('\\u0414\\u0438\\u0441\\u043a \\u0430\\u043b\\u043c\\u0430\\u0437\\u043d\\u044b\\u0439 250 \\u043c\\u043c \\u043f\\u043e \\u043a\\u0435\\u0440\\u0430\\u043c\\u043e\\u0433\\u0440\\u0430\\u043d\\u0438\\u0442\\u0443'), 4500, 'https://example.test/catalog/almaznye_diski/blade/')
    ], state, nextMessage, {
      action: 'recommend_products',
      catalogSearchQuery: nextMessage,
      selectedProductIds: [],
      needsWebSearch: false,
      missingInformation: [],
      answerGuidance: 'recommend'
    } as any);

    expect(cards.map((card) => card.id)).toEqual(['blade']);
  });

  it('does not treat a 350-400 mm cutter blade range as a MAGNUS 350/400 generator model', () => {
    const message = ru('\\u041d\\u0443\\u0436\\u0435\\u043d \\u0431\\u0435\\u043d\\u0437\\u0438\\u043d\\u043e\\u0432\\u044b\\u0439 \\u0448\\u0432\\u043e\\u043d\\u0430\\u0440\\u0435\\u0437\\u0447\\u0438\\u043a \\u043f\\u043e\\u0434 \\u0434\\u0438\\u0441\\u043a 350-400 \\u043c\\u043c');
    const state = mergeNeedState(emptyNeedState(), heuristicNeedUpdate(message));
    const cards = assistantTestHooks.cardsFromPlan([
      product('magnus', ru('\\u0413\\u0435\\u043d\\u0435\\u0440\\u0430\\u0442\\u043e\\u0440 \\u0434\\u0438\\u0437\\u0435\\u043b\\u044c\\u043d\\u044b\\u0439 MAGNUS 350/400 FA (350,0 \\u043a\\u0412\\u0442)'), 2470000, 'https://example.test/catalog/dizelnye_generatory/magnus_350_400/'),
      product('cutter', ru('\\u0428\\u0432\\u043e\\u043d\\u0430\\u0440\\u0435\\u0437\\u0447\\u0438\\u043a \\u0431\\u0435\\u043d\\u0437\\u0438\\u043d\\u043e\\u0432\\u044b\\u0439 \\u0434\\u0438\\u0441\\u043a 400 \\u043c\\u043c'), 180000, 'https://example.test/catalog/shvonarezchiki/cutter/')
    ], state, message, {
      action: 'recommend_products',
      catalogSearchQuery: message,
      selectedProductIds: [],
      needsWebSearch: false,
      missingInformation: [],
      answerGuidance: 'recommend'
    } as any);

    expect(cards.map((card) => card.id)).toEqual(['cutter']);
  });

  it('does not show consumables or blades as cutter cards', () => {
    const message = ru('\\u041d\\u0443\\u0436\\u0435\\u043d \\u0431\\u0435\\u043d\\u0437\\u0438\\u043d\\u043e\\u0432\\u044b\\u0439 \\u0448\\u0432\\u043e\\u043d\\u0430\\u0440\\u0435\\u0437\\u0447\\u0438\\u043a \\u043f\\u043e\\u0434 \\u0434\\u0438\\u0441\\u043a 350-400 \\u043c\\u043c');
    const state = mergeNeedState(emptyNeedState(), heuristicNeedUpdate(message));
    const cards = assistantTestHooks.cardsFromPlan([
      product('filter', ru('\\u0424\\u0438\\u043b\\u044c\\u0442\\u0440 \\u0432\\u043e\\u0437\\u0434\\u0443\\u0448\\u043d\\u044b\\u0439 \\u0434\\u043b\\u044f \\u0448\\u0432\\u043e\\u043d\\u0430\\u0440\\u0435\\u0437\\u0447\\u0438\\u043a\\u0430 MFS 735'), 950, 'https://example.test/catalog/raskhodniki/filter/'),
      product('blade', ru('\\u0414\\u0438\\u0441\\u043a \\u0430\\u043b\\u043c\\u0430\\u0437\\u043d\\u044b\\u0439 \\u0434\\u043b\\u044f \\u0440\\u0435\\u0437\\u0447\\u0438\\u043a\\u0430 Husqvarna'), 24300, 'https://example.test/catalog/almaznye_diski/blade/'),
      product('cutter', ru('\\u0428\\u0432\\u043e\\u043d\\u0430\\u0440\\u0435\\u0437\\u0447\\u0438\\u043a \\u0431\\u0435\\u043d\\u0437\\u0438\\u043d\\u043e\\u0432\\u044b\\u0439 Wacker Neuson MFS 735 CE'), 230000, 'https://example.test/catalog/rezchiki/cutter/')
    ], state, message, {
      action: 'recommend_products',
      catalogSearchQuery: message,
      selectedProductIds: [],
      needsWebSearch: false,
      missingInformation: [],
      answerGuidance: 'recommend'
    } as any);

    expect(cards.map((card) => card.id)).toEqual(['cutter']);
  });

  it('records when fallback was suppressed because no relevant cards survived filtering', () => {
    const message = ru('\\u041d\\u0443\\u0436\\u0435\\u043d \\u0430\\u043b\\u043c\\u0430\\u0437\\u043d\\u044b\\u0439 \\u0434\\u0438\\u0441\\u043a 250 \\u043c\\u043c \\u0434\\u043b\\u044f \\u043a\\u0435\\u0440\\u0430\\u043c\\u043e\\u0433\\u0440\\u0430\\u043d\\u0438\\u0442\\u0430');
    const state = mergeNeedState(emptyNeedState(), heuristicNeedUpdate(message));
    const selection = assistantTestHooks.selectCardsFromPlan([
      product('generator', ru('\\u0413\\u0435\\u043d\\u0435\\u0440\\u0430\\u0442\\u043e\\u0440 \\u0431\\u0435\\u043d\\u0437\\u0438\\u043d\\u043e\\u0432\\u044b\\u0439 5 \\u043a\\u0412\\u0442'), 50000, 'https://example.test/catalog/benzinovye_generatory/generator/')
    ], state, message, {
      action: 'recommend_products',
      catalogSearchQuery: message,
      selectedProductIds: [],
      needsWebSearch: false,
      missingInformation: [],
      answerGuidance: 'recommend'
    } as any);

    expect(selection.cards).toEqual([]);
    expect(selection.diagnostics.fallbackSuppressed).toBe(true);
    expect(selection.diagnostics.fallbackReason).toBe('no_relevant_cards_after_current_need_filters');
  });

  it('runs catalog ranking when planner-selected products violate hard constraints', () => {
    const message = 'Подберите ТСС бензиновый генератор 8-10 кВт 220 В';
    const wrong = {
      ...productWithSpecs('tss-7', 'Генератор бензиновый ТСС SGG 7000 (7,0 кВт) 220 В однофазный', 70_000, 'https://example.test/tss-7', {
        'Напряжение': '220 В',
        'Номинальная мощность': '7,0 кВт'
      }),
      brand: 'TSS'
    };
    const matching = {
      ...productWithSpecs('tss-8', 'Генератор бензиновый ТСС SGG 9000ELA (8,0 кВт) 220 В однофазный', 95_000, 'https://example.test/tss-8', {
        'Напряжение': '220 В',
        'Номинальная мощность': '8,0 кВт'
      }),
      brand: 'TSS'
    };
    const selectionState = mergeProductSelectionState(emptyNeedState().selectionState, {
      semanticSource: 'planner',
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
          fuel: 'planner',
          singlePhase220: 'planner',
          brandConstraint: 'planner',
          nominalPowerKwMin: 'planner',
          nominalPowerKwMax: 'planner'
        }
      },
      confidence: 0.9
    });
    const state = { ...emptyNeedState(), selectionState };

    const selection = assistantTestHooks.selectCardsFromPlan([wrong, matching] as any, state, message, baseTurnPlan({
      selectedProductIds: ['tss-7'],
      catalogSearchQuery: message,
      requiredProductTraits: {
        ...baseTurnPlan().requiredProductTraits,
        productIntent: 'generator',
        productRole: 'coreProduct',
        fuel: 'gasoline',
        singlePhase220: true,
        nominalPowerKwMin: 8,
        nominalPowerKwMax: 10
      },
      selectionState: {
        ...baseTurnPlan().selectionState,
        currentProductClass: 'generator',
        targetProductClass: 'generator',
        brandConstraint: 'TSS',
        shouldShowCards: true
      }
    }));

    expect(selection.cards.map((card) => card.id)).toEqual(['tss-8']);
    expect(selection.diagnostics.selectedRejectedCount).toBe(1);
    expect(selection.diagnostics.fallbackSuppressed).toBe(false);
    expect(selection.diagnostics.fallbackReason).toBe('planner_selected_products_rejected_catalog_executor_used_ranked_matches');
  });

  it('keeps a close selected candidate visible for exact model lookup when only the model suffix differs', () => {
    const message = 'BISON 3250 есть у вас?';
    const closeCandidate = {
      ...productWithSpecs('bison-bs3250i', 'Генератор бензиновый инверторный BISON BS3250i', 42_900, 'https://example.test/bison-bs3250i', {
        'производитель оборудования': 'BISON',
        'мощность': '3,0 кВт'
      }),
      brand: 'BISON'
    };
    const otherBrand = {
      ...productWithSpecs('tor-3250', 'Генератор бензиновый TOR 3250', 39_900, 'https://example.test/tor-3250', {
        'производитель оборудования': 'TOR',
        'мощность': '3,0 кВт'
      }),
      brand: 'TOR'
    };
    const selectionState = mergeProductSelectionState(emptyNeedState().selectionState, {
      semanticSource: 'planner',
      currentProductClass: 'generator',
      targetProductClass: 'generator',
      hardConstraints: {
        ...emptyNeedState().selectionState.hardConstraints,
        productIntent: 'generator',
        productRole: 'coreProduct',
        brandConstraint: 'BISON 3250',
        exactModelConstraint: 'BISON 3250',
        provenance: {
          brandConstraint: 'planner',
          exactModelConstraint: 'planner'
        }
      },
      confidence: 0.9
    });
    const state = { ...emptyNeedState(), selectionState };
    const selection = assistantTestHooks.selectCardsFromPlan([otherBrand, closeCandidate] as any, state, message, baseTurnPlan({
      action: 'answer_question',
      answerMode: 'short',
      cardPolicy: 'showProducts',
      selectedProductIds: ['bison-bs3250i'],
      catalogSearchQuery: message,
      agentDecision: {
        answerTask: 'product_selection',
        taskType: 'pure_availability',
        catalogAction: 'exact_model_lookup',
        commercialAction: 'explain_manager_required',
        productCardsPolicy: 'supporting_only',
        mustAnswerNow: ['offer close catalog candidate'],
        currentFocus: 'BISON 3250',
        cardsRole: 'supporting',
        leadAllowed: false,
        leadAllowedReason: 'exact lookup only',
        errorRecoveryPriority: 'ask whether close model was meant'
      },
      requiredProductTraits: {
        ...baseTurnPlan().requiredProductTraits,
        productIntent: 'generator',
        productRole: 'coreProduct'
      },
      selectionState: {
        ...baseTurnPlan().selectionState,
        currentProductClass: 'generator',
        targetProductClass: 'generator',
        brandConstraint: 'BISON 3250',
        exactModelConstraint: 'BISON 3250',
        shouldShowCards: true
      }
    }));

    expect(selection.cards.map((card) => card.id)).toEqual(['bison-bs3250i']);
    expect(selection.diagnostics.selectedRejectedCount).toBe(0);
  });

  it('returns close same-brand model-token alternatives when exact lookup planner forgets selectedProductIds', async () => {
    const message = 'BISON 3250 есть у вас?';
    const closeCandidate = {
      ...productWithSpecs('bison-bs3250i', 'Генератор бензиновый инверторный BISON BS3250i', 42_900, 'https://example.test/bison-bs3250i', {
        'производитель оборудования': 'BISON',
        'мощность': '3,0 кВт'
      }),
      brand: 'BISON'
    };
    const otherBrand = {
      ...productWithSpecs('tor-3250', 'Генератор бензиновый TOR 3250', 39_900, 'https://example.test/tor-3250', {
        'производитель оборудования': 'TOR',
        'мощность': '3,0 кВт'
      }),
      brand: 'TOR'
    };
    const assistant = new AssistantService(undefined as never, new FakeProducts([closeCandidate, otherBrand] as any) as never);
    const selectionState = mergeProductSelectionState(emptyNeedState().selectionState, {
      semanticSource: 'planner',
      currentProductClass: 'generator',
      targetProductClass: 'generator',
      hardConstraints: {
        ...emptyNeedState().selectionState.hardConstraints,
        productIntent: 'generator',
        productRole: 'coreProduct',
        brandConstraint: 'BISON 3250',
        exactModelConstraint: 'BISON 3250',
        exactModelTokens: ['3250'],
        provenance: {
          brandConstraint: 'planner',
          exactModelConstraint: 'planner'
        }
      },
      confidence: 0.9
    });
    const state = { ...emptyNeedState(), selectionState };
    const plan = baseTurnPlan({
      action: 'answer_question',
      answerMode: 'short',
      cardPolicy: 'textOnly',
      selectedProductIds: [],
      catalogSearchQuery: message,
      agentDecision: {
        answerTask: 'product_selection',
        taskType: 'pure_availability',
        catalogAction: 'verify_catalog_absence',
        commercialAction: 'explain_manager_required',
        productCardsPolicy: 'none',
        mustAnswerNow: ['check exact model presence'],
        currentFocus: 'BISON 3250',
        cardsRole: 'none',
        leadAllowed: false,
        leadAllowedReason: 'exact lookup only',
        errorRecoveryPriority: 'say exact card is absent'
      },
      requiredProductTraits: {
        ...baseTurnPlan().requiredProductTraits,
        productIntent: 'generator',
        productRole: 'coreProduct'
      },
      selectionState: {
        ...baseTurnPlan().selectionState,
        currentProductClass: 'generator',
        targetProductClass: 'generator',
        brandConstraint: 'BISON 3250',
        exactModelConstraint: 'BISON 3250',
        shouldShowCards: false
      }
    });

    const result = await assistant.selectProductsForTurn(message, state, plan, [closeCandidate, otherBrand] as any, undefined, undefined, '', {
      forceCatalogVerification: true
    });

    expect(result.visibleProducts.map((item) => item.id)).toEqual(['bison-bs3250i']);
    expect(result.trace.exactLookupAlternative).toBe(true);
    expect(result.trace.exactLookupAlternativeIds).toEqual(['bison-bs3250i']);
  });

  it('keeps a strict brand request from being filled with other brands', () => {
    const message = 'Есть у вас генератор BISON на 5-6 кВт?';
    const state = mergeNeedState(emptyNeedState(), heuristicNeedUpdate(message));
    const cards = assistantTestHooks.cardsFromPlan([
      brandedProduct('bison-1', 'Генератор бензиновый BISON BS6500EP (5,0 кВт)', 'BISON', 'Бензиновые генераторы', 51500, 'https://example.test/catalog/benzinovye_generatory/bison6500/'),
      brandedProduct('bison-2', 'Генератор бензиновый инверторный BISON BS6250IE (5,0 кВт)', 'BISON', 'Инверторные генераторы', 61100, 'https://example.test/catalog/invertornye_generatory/bison6250/'),
      brandedProduct('aipower', 'Генератор бензиновый A-iPower LITE AP5500 (5,0 кВт)', 'A-iPower', 'Бензиновые генераторы', 48990, 'https://example.test/catalog/benzinovye_generatory/ap5500/'),
      brandedProduct('champion', 'Генератор бензиновый CHAMPION GG5000 (5,0 кВт)', 'Champion', 'Бензиновые генераторы', 50190, 'https://example.test/catalog/benzinovye_generatory/gg5000/')
    ], state, message, {
      action: 'recommend_products',
      catalogSearchQuery: message,
      selectedProductIds: [],
      needsWebSearch: false,
      missingInformation: [],
      answerGuidance: 'recommend'
    } as any);

    expect(cards.map((card) => card.id)).toEqual(['bison-1', 'bison-2']);
  });

  it('switches from a known generator model to generator oil cards on an accessory follow-up', () => {
    const firstMessage = 'Интересует инверторный генератор BISON BS6250IE';
    const nextMessage = 'А масло есть для таких генераторов?';
    let state = mergeNeedState(emptyNeedState(), heuristicNeedUpdate(firstMessage));
    state = mergeNeedState(state, heuristicNeedUpdate(nextMessage));
    const cards = assistantTestHooks.cardsFromPlan([
      brandedProduct('generator', 'Генератор бензиновый инверторный BISON BS6250IE (5,0 кВт)', 'BISON', 'Инверторные генераторы', 61100, 'https://example.test/catalog/invertornye_generatory/bison6250/'),
      brandedProduct('oil-1', 'Масло для генератора Teboil Silver SN 10W-40 1 л', 'Teboil', 'Масло для генератора', 650, 'https://example.test/catalog/maslo_dlya_generatora/teboil-1/'),
      brandedProduct('oil-4', 'Масло для генератора TSS SAE 10W-40 4 л', 'TSS', 'Масло для генератора', 1800, 'https://example.test/catalog/maslo_dlya_generatora/tss-4/')
    ], state, nextMessage, {
      action: 'recommend_products',
      catalogSearchQuery: `${nextMessage} ${firstMessage}`,
      selectedProductIds: [],
      needsWebSearch: false,
      missingInformation: [],
      answerGuidance: 'recommend oil'
    } as any);

    expect(cards.map((card) => card.id)).toEqual(['oil-1', 'oil-4']);
  });

  it('switches from a known plate model to suitable four-stroke engine oil cards', () => {
    const firstMessage = 'Интересует виброплита CHAMPION PC5332F';
    const nextMessage = 'А масло для нее у вас есть?';
    let state = mergeNeedState(emptyNeedState(), heuristicNeedUpdate(firstMessage));
    state = mergeNeedState(state, heuristicNeedUpdate(nextMessage));

    const cards = assistantTestHooks.cardsFromPlan([
      brandedProduct('plate', 'Виброплита CHAMPION PC5332F', 'Champion', 'Виброплиты', 52900, 'https://bakautprof.ru/catalog/vibroplity/champion_pc5332f/'),
      brandedProduct('oil-1', 'Масло моторное TEBOIL Silver SN 10W-40 канистра 1 л', 'Teboil', 'Масло для генератора', 640, 'https://bakautprof.ru/catalog/maslo_dlya_generatora/teboil-1/'),
      brandedProduct('oil-4', 'Масло полусинтетическое ТСС SAE 10W-40 API SG/CD канистра 4л', 'TSS', 'Масло для генератора', 1136, 'https://bakautprof.ru/catalog/maslo_dlya_generatora/tss-4/'),
      brandedProduct('oil-15w', 'Масло минеральное ТСС Стандарт SAE 15W40 CF-4 канистра 5л', 'TSS', 'Масло для генератора', 1415, 'https://bakautprof.ru/catalog/maslo_dlya_generatora/tss-15w40/'),
      brandedProduct('two-stroke', 'Масло двухтактное 2T для садовой техники', 'TSS', 'Масло для генератора', 520, 'https://bakautprof.ru/catalog/maslo_dlya_generatora/2t/'),
      brandedProduct('filter-oil', 'Масло для воздушного фильтра', 'TSS', 'Расходники', 350, 'https://bakautprof.ru/catalog/raskhodniki/filter-oil/'),
      brandedProduct('cover', 'Кожух всепогодный для генератора', 'TSS', 'Кожухи для генератора', 129000, 'https://bakautprof.ru/catalog/kozhukhi_dlya_generatora/cover/')
    ], state, nextMessage, {
      action: 'recommend_products',
      catalogSearchQuery: `${nextMessage} ${firstMessage} 4-тактное моторное масло SAE`,
      selectedProductIds: ['plate'],
      requiredProductTraits: {
        productIntent: 'engineOil',
        fuel: 'any',
        startType: 'any',
        conventionalGenerator: null,
        singlePhase220: null,
        nominalPowerKwMin: null,
        nominalPowerKwMax: null,
        maxPowerKwMin: null,
        maxPowerKwMax: null,
        powerReasoning: 'Нужно моторное масло к уже выбранной виброплите, а не карточка самой плиты.'
      },
      needsWebSearch: false,
      missingInformation: [],
      answerGuidance: 'recommend oil'
    } as any);

    expect(cards.map((card) => card.id)).toEqual(['oil-1', 'oil-4']);
  });

  it('does not classify a normal bakautprof product URL as an accessory', () => {
    const message = 'Есть коврик или кожух?';
    const state = mergeNeedState(emptyNeedState(), heuristicNeedUpdate(message));
    const cards = assistantTestHooks.cardsFromPlan([
      brandedProduct('plate', 'Виброплита CHAMPION PC5332F', 'Champion', 'Виброплиты', 52900, 'https://bakautprof.ru/catalog/vibroplity/champion_pc5332f/'),
      brandedProduct('cover', 'Кожух всепогодный для генератора', 'TSS', 'Кожухи для генератора', 129000, 'https://bakautprof.ru/catalog/kozhukhi_dlya_generatora/cover/')
    ], state, message, {
      action: 'recommend_products',
      catalogSearchQuery: message,
      selectedProductIds: [],
      requiredProductTraits: {
        productIntent: 'generatorAccessory',
        fuel: 'any',
        startType: 'any',
        conventionalGenerator: null,
        singlePhase220: null,
        nominalPowerKwMin: null,
        nominalPowerKwMax: null,
        maxPowerKwMin: null,
        maxPowerKwMax: null,
        powerReasoning: ''
      },
      needsWebSearch: false,
      missingInformation: [],
      answerGuidance: 'recommend accessory'
    } as any);

    expect(cards.map((card) => card.id)).toEqual(['cover']);
  });

  it('builds checkout handoff deterministically without waiting for answer model', () => {
    const answer = assistantTestHooks.deterministicLeadCollectionAnswer([
      {
        id: 'gen-main',
        name: 'Генератор бензиновый SUMEC SU7700E (5,0 кВт)',
        category: 'Бензиновые генераторы',
        price: 46590,
        currency: 'RUB',
        sourceUrl: 'https://example.test/sumec',
        specs: {},
        reasons: [],
        caveats: [],
        imageUrl: null
      },
      {
        id: 'gen-backup',
        name: 'Генератор бензиновый BISON BS6500EP (5,0 кВт)',
        category: 'Бензиновые генераторы',
        price: 51500,
        currency: 'RUB',
        sourceUrl: 'https://example.test/bison',
        specs: {},
        reasons: [],
        caveats: [],
        imageUrl: null
      }
    ], 98090);

    expect(answer).toContain('SUMEC SU7700E');
    expect(answer).toContain('BISON BS6500EP');
    expect(answer).toContain('98 090 ₽');
    expect(answer).toContain('Напишите имя и телефон');
    expect(answer).not.toContain('Заявку уже созданной не считаю');
  });

  it('answers delivery handoff like a manager using the accepted need', () => {
    const answer = assistantTestHooks.deterministicLeadCollectionAnswer(
      [],
      null,
      { hasProvidedContact: false, asksContactHandling: false },
      'Подскажите пожалуйста приблизительную стоимость доставки в Краснодарский край... АВР для генератора BISON'
    );

    expect(answer).toContain('Здравствуйте');
    expect(answer).toContain('уточню через логистику');
    expect(answer).toContain('стоимость доставки в Краснодарский край');
    expect(answer).not.toContain('по выбранному товару');
    expect(answer).not.toContain('АВР для генератора BISON');
    expect(answer).toContain('Напишите имя и телефон');
    expect(answer).toContain('перезвон');
  });

  it('does not calculate a bundle total when generator and plate needs are active but cards cover only plates', () => {
    let state = mergeNeedState(emptyNeedState(), heuristicNeedUpdate('Нужен генератор для дачи'));
    state = mergeNeedState(state, heuristicNeedUpdate('Еще нужна виброплита для дорожек'));
    const cards = [
      {
        id: 'plate-1',
        name: 'Виброплита прямоходная бензиновая ТСС TSS-WP70TL',
        category: 'Виброплиты',
        price: 38766,
        currency: 'RUB',
        sourceUrl: 'https://example.test/plate-1',
        specs: {},
        reasons: [],
        caveats: [],
        imageUrl: null
      },
      {
        id: 'plate-2',
        name: 'Виброплита прямоходная бензиновая STEM Techno SPC 162ES',
        category: 'Виброплиты',
        price: 42000,
        currency: 'RUB',
        sourceUrl: 'https://example.test/plate-2',
        specs: {},
        reasons: [],
        caveats: [],
        imageUrl: null
      }
    ];

    const total = assistantTestHooks.reliableBundleTotal(
      cards,
      'Есть ли доставка и скидка, и можно ли понять примерную сумму комплекта без точного заказа?',
      state
    );

    expect(total).toBeNull();
  });

  it('treats buyer contact details after a hot selection as lead handoff instead of reopening catalog', () => {
    const state = mergeNeedState(emptyNeedState(), heuristicNeedUpdate('Нужен генератор для дома 5 кВт'));
    const products = [
      brandedProduct('sumec', 'SUMEC SU7700E бензогенератор 6.0 кВт', 'SUMEC', 'Генераторы', 59900, 'https://example.test/sumec'),
      brandedProduct('bison', 'BISON BS6500EP бензогенератор 5.5 кВт', 'BISON', 'Генераторы', 38190, 'https://example.test/bison'),
      brandedProduct('hidden', 'TSS SGG 9000EHNA бензогенератор 8 кВт', 'ТСС', 'Генераторы', 98000, 'https://example.test/hidden')
    ];
    const plan = assistantTestHooks.purchasePlanIfNeeded(baseTurnPlan({
      action: 'collect_lead',
      answerMode: 'leadCollection',
      cardPolicy: 'textOnly',
      followUpPolicy: 'collectLead',
      selectedProductIds: ['sumec', 'bison'],
      catalogSearchQuery: 'SUMEC SU7700E BISON BS6500EP',
      agentDecision: {
        answerTask: 'lead_handoff',
        mustAnswerNow: ['confirm manager verification of availability and delivery'],
        currentFocus: 'commercial',
        cardsRole: 'primary',
        leadAllowed: true,
        leadAllowedReason: 'buyer provided contact and asks manager to verify commercial conditions',
        errorRecoveryPriority: 'Ask manager handoff with selected products.',
        confidence: 0.96
      }
    }), products, [], state, 'Меня зовут Иван, телефон +7 999 123-45-67, пусть менеджер подтвердит наличие и доставку');
    const cards = assistantTestHooks.cardsFromPlan(products, state, 'Меня зовут Иван, телефон +7 999 123-45-67, пусть менеджер подтвердит наличие и доставку', plan.plan);

    expect(plan.leadRequested).toBe(true);
    expect(plan.plan.action).toBe('collect_lead');
    expect(plan.plan.answerMode).toBe('leadCollection');
    expect(cards.map((card) => card.id)).toEqual(['sumec', 'bison']);
  });

  it('turns a checkout message into a selected bundle and does not add alternatives', () => {
    const state = mergeNeedState(emptyNeedState(), heuristicNeedUpdate('Интересует виброплита CHAMPION PC5332F и масло 10W-40'));
    const products = [
      brandedProduct('plate', 'Виброплита CHAMPION PC5332F', 'Champion', 'Виброплиты', 40490, 'https://example.test/catalog/vibroplity/pc5332f/'),
      brandedProduct('oil-1', 'Масло полусинтетическое ТСС SAE 10W-40 API SG/CD канистра 1л', 'SAE', 'Масло для генератора', 428, 'https://example.test/catalog/maslo/tss-1/'),
      brandedProduct('oil-4', 'Масло полусинтетическое ТСС SAE 10W-40 API SG/CD канистра 4л', 'SAE', 'Масло для генератора', 1136, 'https://example.test/catalog/maslo/tss-4/'),
      brandedProduct('teboil-1', 'Масло моторное TEBOIL Silver SN 10W-40 канистра 1 л', 'Teboil', 'Масло для генератора', 640, 'https://example.test/catalog/maslo/teboil-1/')
    ];
    const plan = assistantTestHooks.purchasePlanIfNeeded({
      action: 'collect_lead',
      answerMode: 'leadCollection',
      followUpPolicy: 'collectLead',
      catalogSearchQuery: 'CHAMPION PC5332F масло 10W-40',
      selectedProductIds: ['oil-4'],
      requiredProductTraits: {
        productIntent: 'engineOil',
        fuel: 'any',
        startType: 'any',
        conventionalGenerator: null,
        singlePhase220: null,
        nominalPowerKwMin: null,
        nominalPowerKwMax: null,
        maxPowerKwMin: null,
        maxPowerKwMax: null,
        powerReasoning: ''
      },
      needsWebSearch: false,
      missingInformation: [],
      answerGuidance: ''
    } as any, products, [{
      id: 'assistant-1',
      sessionId: 'session',
      role: 'assistant',
      content: '',
      metadata: { productCards: [assistantTestHooks.cardsFromPlan([products[0]], state, 'CHAMPION PC5332F', {
        action: 'recommend_products',
        catalogSearchQuery: 'CHAMPION PC5332F',
        selectedProductIds: ['plate'],
        requiredProductTraits: {
          productIntent: 'plate',
          fuel: 'any',
          startType: 'any',
          conventionalGenerator: null,
          singlePhase220: null,
          nominalPowerKwMin: null,
          nominalPowerKwMax: null,
          maxPowerKwMin: null,
          maxPowerKwMax: null,
          powerReasoning: ''
        },
        needsWebSearch: false,
        missingInformation: [],
        answerGuidance: ''
      } as any)[0]] },
      createdAt: new Date().toISOString()
    } as any], state, 'Давайте мне эту плиту и масло 1л под нее');

    const cards = assistantTestHooks.cardsFromPlan(products, state, 'Давайте мне эту плиту и масло 1л под нее', plan.plan);

    expect(plan.leadRequested).toBe(true);
    expect(plan.plan.action).toBe('collect_lead');
    expect(cards.map((card) => card.id)).toEqual(['plate', 'oil-1']);
    expect(cards[1].brand).toBe('ТСС');
  });

  it('keeps the chosen main equipment and first matching consumable when buyer proceeds', () => {
    const state = mergeNeedState(emptyNeedState(), heuristicNeedUpdate('Need vibroplita CHAMPION PC5332F and oil 10W-40'));
    const products = [
      brandedProduct('plate', 'Vibroplita CHAMPION PC5332F', 'Champion', 'vibroplity', 40490, 'https://example.test/catalog/vibroplity/pc5332f/'),
      brandedProduct('tss-1', 'Oil TSS SAE 10W-40 API SG/CD canister 1l', 'TSS', 'oil for generator', 428, 'https://example.test/catalog/oil/tss-1/'),
      brandedProduct('teboil-1', 'Oil motor TEBOIL Silver SN 10W-40 canister 1 l', 'Teboil', 'oil for generator', 640, 'https://example.test/catalog/oil/teboil-1/'),
      brandedProduct('tss-4', 'Oil TSS SAE 10W-40 API SG/CD canister 4l', 'TSS', 'oil for generator', 1136, 'https://example.test/catalog/oil/tss-4/')
    ];
    const previousOilCards = assistantTestHooks.cardsFromPlan([products[1], products[2], products[3]], state, 'Oil for CHAMPION PC5332F', {
      action: 'recommend_products',
      catalogSearchQuery: 'CHAMPION PC5332F oil 10W-40',
      selectedProductIds: ['tss-1', 'teboil-1', 'tss-4'],
      requiredProductTraits: {
        productIntent: 'engineOil',
        fuel: 'any',
        startType: 'any',
        conventionalGenerator: null,
        singlePhase220: null,
        nominalPowerKwMin: null,
        nominalPowerKwMax: null,
        maxPowerKwMin: null,
        maxPowerKwMax: null,
        powerReasoning: ''
      },
      needsWebSearch: false,
      missingInformation: [],
      answerGuidance: ''
    } as any);
    const plan = assistantTestHooks.purchasePlanIfNeeded({
      action: 'collect_lead',
      answerMode: 'leadCollection',
      followUpPolicy: 'collectLead',
      catalogSearchQuery: 'CHAMPION PC5332F oil 10W-40',
      selectedProductIds: ['teboil-1'],
      requiredProductTraits: {
        productIntent: 'engineOil',
        fuel: 'any',
        startType: 'any',
        conventionalGenerator: null,
        singlePhase220: null,
        nominalPowerKwMin: null,
        nominalPowerKwMax: null,
        maxPowerKwMin: null,
        maxPowerKwMax: null,
        powerReasoning: ''
      },
      needsWebSearch: false,
      missingInformation: [],
      answerGuidance: ''
    } as any, products, [{
      id: 'user-1',
      sessionId: 'session',
      role: 'user',
      content: 'Need vibroplita CHAMPION PC5332F and oil for it',
      metadata: {},
      createdAt: new Date().toISOString()
    }, {
      id: 'assistant-1',
      sessionId: 'session',
      role: 'assistant',
      content: 'The main option is TSS 1l.',
      metadata: { productCards: previousOilCards },
      createdAt: new Date().toISOString()
    }] as any, state, 'Take this plate and 1l oil for it');

    const cards = assistantTestHooks.cardsFromPlan(products, state, 'Take this plate and 1l oil for it', plan.plan);

    expect(cards.map((card) => card.id)).toEqual(['plate', 'tss-1']);
  });

  it('lets the resolved turn contract suppress cards even if the legacy planner still says showProducts', () => {
    const state = mergeNeedState(emptyNeedState(), heuristicNeedUpdate('Need generator for factual technical comparison'));
    const products = [
      brandedProduct('gen-1', 'Generator TSS SGG 6000EHNA', 'ТСС', 'generators', 70000, 'https://example.test/catalog/generators/gen-1/')
    ];
    const plan = baseTurnPlan({
      action: 'recommend_products',
      answerMode: 'productRecommendation',
      cardPolicy: 'showProducts',
      selectedProductIds: ['gen-1']
    }) as any;
    const contract = assistantTestHooks.resolveTurnContractForPlan(plan, {
      forceTextOnlyReason: 'detailed_fact'
    });

    const legacyCards = assistantTestHooks.selectCardsFromPlan(products, state, 'Compare service cost, no cards needed', plan).cards;
    const contractSelection = assistantTestHooks.selectCardsFromTurnContract(products, state, 'Compare service cost, no cards needed', plan, contract);

    expect(legacyCards.map((card) => card.id)).toEqual(['gen-1']);
    expect(contractSelection.cards).toHaveLength(0);
    expect(contractSelection.diagnostics).toMatchObject({ reason: 'contract_text_only_detailed_fact' });
  });

  it('does not treat model code fragments like 5W as engine oil', () => {
    const state = mergeNeedState(emptyNeedState(), heuristicNeedUpdate('Need engine oil 10W-40 for vibroplate'));
    const cards = assistantTestHooks.cardsFromPlan([
      brandedProduct('plate-code', 'Vibroplita MASTERPAC PC4515WCH.2', 'Masterpac', 'vibroplity', 155000, 'https://example.test/catalog/vibroplity/pc4515wch/'),
      brandedProduct('oil-1', 'Oil TSS SAE 10W-40 API SG/CD canister 1l', 'TSS', 'oil for generator', 428, 'https://example.test/catalog/oil/tss-1/')
    ], state, 'Need engine oil 10W-40 for vibroplate', {
      action: 'recommend_products',
      catalogSearchQuery: 'engine oil 10W-40 vibroplate',
      selectedProductIds: [],
      requiredProductTraits: {
        productIntent: 'engineOil',
        fuel: 'any',
        startType: 'any',
        conventionalGenerator: null,
        singlePhase220: null,
        nominalPowerKwMin: null,
        nominalPowerKwMax: null,
        maxPowerKwMin: null,
        maxPowerKwMax: null,
        powerReasoning: ''
      },
      needsWebSearch: false,
      missingInformation: [],
      answerGuidance: ''
    } as any);

    expect(cards.map((card) => card.id)).toEqual(['oil-1']);
  });

  it('recognizes trowel, welding generator, and diamond core intents as product classes', () => {
    expect(assistantTestHooks.buildProductFitProfile(emptyNeedState(), 'Нужна затирочная машина для склада').intent).toBe('trowel');
    expect(assistantTestHooks.buildProductFitProfile(emptyNeedState(), 'Нужен сварочный генератор 2 в 1 под электрод 4 мм').intent).toBe('weldingGenerator');
    expect(assistantTestHooks.buildProductFitProfile(emptyNeedState(), 'Нужна алмазная коронка 72 мм под подрозетник в монолите').intent).toBe('diamondCore');
  });

  it('keeps short model codes as exact model tokens', () => {
    const profile = assistantTestHooks.buildProductFitProfile(
      emptyNeedState(),
      'Сравни K770 и TS420 по запчастям, еще есть LAT100 и MP-15CE'
    );

    expect(profile.exactModelTokens.map((token) => token.replace(/\s+/g, ''))).toEqual(expect.arrayContaining(['K770', 'TS420', 'LAT100']));
    expect(profile.exactModelTokens).toEqual(expect.arrayContaining(['MP-15CE']));
  });

  it('removes visible external links from the assistant answer', () => {
    const cleaned = assistantTestHooks.sanitizeVisibleAnswer('Проверил [пример](https://example.com/item) и bakautprof.ru/catalog. Подойдет 10W-40.');
    expect(cleaned).toBe('Проверил пример и Подойдет 10W-40.');
  });

  it('normalizes reversed and duplicate visible power ranges', () => {
    const cleaned = assistantTestHooks.sanitizeVisibleAnswer('Лучше смотреть генератор 4–3,5 кВт, а не писать 5–5 кВт. Запас 6-5,5 кВт тоже норм.');

    expect(cleaned).toContain('3,5–4 кВт');
    expect(cleaned).toContain('5 кВт');
    expect(cleaned).toContain('5,5–6 кВт');
    expect(cleaned).not.toMatch(/4–3,5\s*кВт/);
    expect(cleaned).not.toMatch(/5–5\s*кВт/);
  });

  it('does not normalize hyphenated model names as numeric ranges', () => {
    const cleaned = assistantTestHooks.sanitizeVisibleAnswer('Модель MP-15CE и генератор 220В остаются как есть, диапазон 4-3,5 кВт исправляется.');

    expect(cleaned).toContain('MP-15CE');
    expect(cleaned).toContain('220В');
    expect(cleaned).toContain('3,5–4 кВт');
  });

  it('removes deferred comparison offers at the end of factual answers', () => {
    const noDeferredOfferPlan = { followUpPolicy: 'answerNowNoDeferredOffer' } as any;
    const cleaned = assistantTestHooks.sanitizeVisibleAnswer('K 770 дешевле по ТО.\n\nЕсли хотите, я дальше могу разложить по конкретным позициям: свеча, фильтр, ремень.', noDeferredOfferPlan);
    const cleanedDirect = assistantTestHooks.sanitizeVisibleAnswer('MP-15 не выглядит актуальной моделью в основной линейке.\n\nЕсли хотите, я дальше сравню MP-15 с K770 и TS420 по стоимости владения.', noDeferredOfferPlan);
    const cleanedCatalogTail = assistantTestHooks.sanitizeVisibleAnswer('По нашему каталогу по MP15 есть сама виброплита и запчасти: ремень, амортизатор, система смачивания. Если у вас уже есть MP15, дальше могу быстро собрать список что чаще всего берут на сервис.', noDeferredOfferPlan);
    const cleanedBetterNext = assistantTestHooks.sanitizeVisibleAnswer('По MP15 есть ремень 1 200 ₽ и амортизатор 1 300 ₽.\n\nЕсли хотите, дальше лучше смотреть новую замену на MP15 или сразу подбирать расходники.', noDeferredOfferPlan);

    expect(cleaned).toBe('K 770 дешевле по ТО.');
    expect(cleanedDirect).toBe('MP-15 не выглядит актуальной моделью в основной линейке.');
    expect(cleanedCatalogTail).toBe('По нашему каталогу по MP15 есть сама виброплита и запчасти: ремень, амортизатор, система смачивания.');
    expect(cleanedBetterNext).toBe('По MP15 есть ремень 1 200 ₽ и амортизатор 1 300 ₽.');
  });

  it('forces web verification and a detailed style for service and ownership-cost questions', () => {
    const plan = {
      action: 'verify_with_web',
      answerMode: 'serviceCostComparison',
      cardPolicy: 'textOnly',
      followUpPolicy: 'answerNowNoDeferredOffer',
      catalogSearchQuery: 'Husqvarna K 770 STIHL TS 420 сервис запчасти расходники',
      selectedProductIds: [],
      requiredProductTraits: {
        productIntent: 'unknown',
        fuel: 'unknown',
        startType: 'unknown',
        conventionalGenerator: null,
        singlePhase220: null,
        nominalPowerKwMin: null,
        nominalPowerKwMax: null,
        maxPowerKwMin: null,
        maxPowerKwMax: null,
        powerReasoning: ''
      },
      needsWebSearch: true,
      missingInformation: [],
      answerGuidance: 'Сравнить сервисное обслуживание, стоимость запчастей и расходников'
    } as any;
    const message = 'А что по сервисному обслуживанию и стоимости запасных частей и расходных материалов?';

    expect(assistantTestHooks.shouldUseWebSearch(message, plan)).toBe(true);
    expect(assistantTestHooks.shouldUseDetailedFactStyle(message, plan, 0)).toBe(true);
    expect(assistantTestHooks.shouldUseServiceCostStyle(message, plan, true)).toBe(true);

    expect(assistantTestHooks.shouldUseWebSearch(message, {
      ...plan,
      action: 'answer_question',
      answerMode: 'short',
      cardPolicy: 'auto',
      followUpPolicy: 'auto',
      needsWebSearch: false
    })).toBe(false);
  });

  it('does not use service-cost style for gasoline/diesel reserve comparison without a service question', () => {
    const plan = baseTurnPlan({
      action: 'answer_question',
      answerMode: 'detailedFact',
      cardPolicy: 'textOnly',
      followUpPolicy: 'answerNowNoDeferredOffer',
      catalogSearchQuery: ru('\\u0410 \\u0435\\u0441\\u043b\\u0438 \\u0432\\u0437\\u044f\\u0442\\u044c \\u0434\\u0435\\u0448\\u0435\\u0432\\u043b\\u0435 \\u0438 \\u043f\\u043e\\u0447\\u0442\\u0438 \\u0431\\u0435\\u0437 \\u0437\\u0430\\u043f\\u0430\\u0441\\u0430, \\u0447\\u0435\\u043c \\u0440\\u0438\\u0441\\u043a\\u0443\\u044e? \\u0414\\u043b\\u044f \\u0440\\u0435\\u0434\\u043a\\u0438\\u0445 \\u043e\\u0442\\u043a\\u043b\\u044e\\u0447\\u0435\\u043d\\u0438\\u0439 \\u0431\\u0435\\u043d\\u0437\\u0438\\u043d \\u0438\\u043b\\u0438 \\u0434\\u0438\\u0437\\u0435\\u043b\\u044c \\u0432\\u044b\\u0433\\u043e\\u0434\\u043d\\u0435\\u0435?')
    });
    const message = plan.catalogSearchQuery;

    expect(assistantTestHooks.shouldUseDetailedFactStyle(message, plan, 0)).toBe(true);
    expect(assistantTestHooks.shouldUseServiceCostStyle(message, plan, true)).toBe(false);
  });

  it('routes current-lineup and service comparisons to deeper reasoning', () => {
    expect(assistantTestHooks.shouldUseDeepReasoningForPlanning('А MP-15 Wacker выпускается еще?', [])).toBe(true);
    expect(assistantTestHooks.shouldUseDeepReasoningForPlanning('Сколько стоит сервис K770 и TS420?', [])).toBe(true);
    expect(assistantTestHooks.shouldUseDeepReasoningForAnswer({
      action: 'verify_with_web',
      answerMode: 'currentLineup',
      cardPolicy: 'textOnly',
      followUpPolicy: 'answerNowNoDeferredOffer',
      contextScope: 'latestMessageOnly',
      searchScope: 'focusedNeed',
      catalogSearchQuery: 'MP-15 Wacker выпускается еще?',
      selectedProductIds: [],
      requiredProductTraits: {
        productIntent: 'plate',
        productRole: 'coreProduct',
        fuel: 'unknown',
        startType: 'unknown',
        enclosure: 'unknown',
        conventionalGenerator: null,
        singlePhase220: null,
        nominalPowerKwMin: null,
        nominalPowerKwMax: null,
        maxPowerKwMin: null,
        maxPowerKwMax: null,
        powerReasoning: ''
      },
      needsWebSearch: true,
      missingInformation: [],
      answerGuidance: ''
    } as any, true, false, true, 0)).toBe(true);

    const profile = assistantTestHooks.resolveReasoningProfile('gpt-5.4-mini', 'low', true, 2);
    expect(profile.effort).toBe('xhigh');
    expect(profile.model).not.toBe('gpt-5.4-mini');
  });

  it('uses high web-search context and proof policy for current-lineup fact checks', () => {
    const plan = {
      action: 'verify_with_web',
      answerMode: 'currentLineup',
      cardPolicy: 'textOnly',
      followUpPolicy: 'answerNowNoDeferredOffer',
      contextScope: 'latestMessageOnly',
      searchScope: 'focusedNeed',
      catalogSearchQuery: 'Wacker Neuson MP-15 still produced current lineup',
      selectedProductIds: [],
      requiredProductTraits: {
        productIntent: 'plate',
        productRole: 'coreProduct',
        fuel: 'unknown',
        startType: 'unknown',
        enclosure: 'unknown',
        conventionalGenerator: null,
        singlePhase220: null,
        nominalPowerKwMin: null,
        nominalPowerKwMax: null,
        maxPowerKwMin: null,
        maxPowerKwMax: null,
        powerReasoning: ''
      },
      needsWebSearch: true,
      missingInformation: [],
      answerGuidance: ''
    } as any;

    const policy = assistantTestHooks.buildFactualVerificationPolicy({
      userMessage: 'А MP-15 Wacker выпускается еще?',
      plan,
      currentLineupStyle: true,
      detailedFactStyle: false
    });

    expect(assistantTestHooks.webSearchContextSize(true, false, 1)).toBe('high');
    expect(policy?.mode).toBe('current_lineup_status');
    expect(policy?.sourceCoverage).toContain('manufacturer current product/catalog pages');
    expect(policy?.inferenceRules.join(' ')).toContain('not by itself proof');
    expect(policy?.inferenceRules.join(' ')).toContain('explicitly supports that relationship');
    expect(policy?.answerRules.join(' ')).toContain('distinguish single-direction plates from reversible plates');
    expect(policy?.answerRules.join(' ')).toContain('catalogLineupAlternatives');
    expect(policy?.answerRules.join(' ')).toContain('catalogLineupAlternativeGroups');
    expect(policy?.answerRules.join(' ')).toContain('catalog presence only');
    expect(policy?.answerRules.join(' ')).toContain('mandatoryCatalogLineupAlternativeFacts');
    expect(policy?.answerRules.join(' ')).toContain('best 1-3');
  });

  it('does not show product cards for service and ownership-cost comparison even with exact model matches', () => {
    const state = emptyNeedState();
    const message = 'Сравни обслуживание и стоимость расходников K770 и TS420';
    const cards = assistantTestHooks.cardsFromPlan([
      brandedProduct('k770', 'Бензорез Husqvarna K 770/12"', 'Husqvarna', 'Швонарезчики и Резчики', 108082, 'https://example.test/k770'),
      brandedProduct('k770-kit', 'Комплект сервиса K 770 HUSQVARNA', 'Husqvarna', 'Расходники', 7722, 'https://example.test/k770-kit')
    ], state, message, {
      action: 'verify_with_web',
      catalogSearchQuery: 'K770 TS420 сервис запчасти расходники',
      selectedProductIds: [],
      requiredProductTraits: {
        productIntent: 'unknown',
        fuel: 'unknown',
        startType: 'unknown',
        conventionalGenerator: null,
        singlePhase220: null,
        nominalPowerKwMin: null,
        nominalPowerKwMax: null,
        maxPowerKwMin: null,
        maxPowerKwMax: null,
        powerReasoning: ''
      },
      needsWebSearch: true,
      missingInformation: [],
      answerGuidance: 'Сравнить обслуживание, стоимость запчастей и расходников'
    } as any);

    expect(cards).toEqual([]);
  });

  it('keeps current-lineup questions out of service-cost detailed mode when old context leaks into the plan', () => {
    const plan = {
      action: 'verify_with_web',
      catalogSearchQuery: 'Wacker Neuson MP-15 выпускается ли сейчас, K770 TS420 сервис запчасти расходники',
      selectedProductIds: ['mp15'],
      requiredProductTraits: {
        productIntent: 'plate',
        fuel: 'unknown',
        startType: 'unknown',
        conventionalGenerator: null,
        singlePhase220: null,
        nominalPowerKwMin: null,
        nominalPowerKwMax: null,
        maxPowerKwMin: null,
        maxPowerKwMax: null,
        powerReasoning: ''
      },
      needsWebSearch: true,
      missingInformation: [],
      answerGuidance: 'Проверить, выпускается ли MP-15. В старом контексте было сравнение сервиса K770 TS420 и расходников.'
    } as any;

    const message = 'А mp-15 wacker выпускается еще?';

    expect(assistantTestHooks.shouldUseCurrentLineupStyle(message)).toBe(true);
    expect(assistantTestHooks.shouldUseDetailedFactStyle(message, plan, 0)).toBe(false);
    expect(assistantTestHooks.shouldUseWebSearch(message, plan)).toBe(true);
  });

  it('does not show product cards for current-lineup fact checks unless the buyer asks to buy', () => {
    const state = emptyNeedState();
    const message = 'А mp-15 wacker выпускается еще?';
    const selection = assistantTestHooks.selectCardsFromPlan([
      brandedProduct('mp15', 'Виброплита прямоходная бензиновая Wacker Neuson MP15-CE (83 кг)', 'Wacker Neuson', 'Виброплиты', 154000, 'https://example.test/mp15'),
      brandedProduct('belt', 'Ремень приводной AV13x813Li для виброплиты Wacker Neuson MP-15', 'Wacker Neuson', 'Запчасти', 1200, 'https://example.test/belt')
    ], state, message, {
      action: 'verify_with_web',
      catalogSearchQuery: 'Wacker Neuson MP-15 выпускается ли сейчас',
      selectedProductIds: ['mp15', 'belt'],
      requiredProductTraits: {
        productIntent: 'plate',
        fuel: 'unknown',
        startType: 'unknown',
        conventionalGenerator: null,
        singlePhase220: null,
        nominalPowerKwMin: null,
        nominalPowerKwMax: null,
        maxPowerKwMin: null,
        maxPowerKwMax: null,
        powerReasoning: ''
      },
      needsWebSearch: true,
      missingInformation: [],
      answerGuidance: 'Проверить текущую линейку производителя'
    } as any);

    expect(selection.cards).toEqual([]);
    expect(selection.diagnostics.fallbackReason).toBe('suppressed_for_current_lineup_question');
  });

  it('selection engine keeps hard budget across turns and filters over-budget products', async () => {
    const assistant = new AssistantService(undefined as never, new FakeProducts([
      productWithSpecs('fit', 'Generator gasoline AP6500E 5.5 kW electric start', 80_000, 'https://example.test/catalog/generator/fit', { start: 'electric starter' }),
      productWithSpecs('over', 'Generator gasoline EP6500E 5.5 kW electric start', 180_000, 'https://example.test/catalog/generator/over', { start: 'electric starter' })
    ]) as never);
    const state = {
      ...emptyNeedState(),
      selectionState: mergeProductSelectionState(emptyNeedState().selectionState, {
        currentProductClass: 'generator',
        targetProductClass: 'generator',
        hardConstraints: {
          productIntent: 'generator',
          productRole: 'coreProduct',
          budgetMax: 90_000,
          nominalPowerKwMin: 5,
          nominalPowerKwMax: 6,
          exactModelTokens: [],
          mustHaveTraits: [],
          excludedClasses: []
        },
        confidence: 0.8
      })
    };
    const plan = baseTurnPlan({
      catalogSearchQuery: 'gasoline generator 5-6 kw electric start',
      requiredProductTraits: {
        ...baseTurnPlan().requiredProductTraits,
        productIntent: 'generator',
        productRole: 'coreProduct',
        startType: 'electric'
      }
    });

    const result = await assistant.selectProductsForTurn('show suitable options with electric start', state, plan, []);

    expect(result.matchedProducts.map((item) => item.id)).toEqual(['fit']);
    expect(result.state.hardConstraints.budgetMax).toBe(90_000);
  });

  it('selection engine exposes hidden products and narrowing questions for large catalog slices', async () => {
    const products = Array.from({ length: 12 }, (_, index) =>
      product(`p${index}`, ru(`\\u0412\\u0438\\u0431\\u0440\\u043e\\u043f\\u043b\\u0438\\u0442\\u0430 ${105 + index} \\u043a\\u0433`), 100_000 + index, `https://example.test/catalog/vibroplity/p${index}`)
    );
    const assistant = new AssistantService(undefined as never, new FakeProducts(products) as never);
    const plan = baseTurnPlan({
      catalogSearchQuery: 'plate 100-150 kg',
      requiredProductTraits: {
        ...baseTurnPlan().requiredProductTraits,
        productIntent: 'plate',
        productRole: 'coreProduct'
      },
      selectionState: {
        ...baseTurnPlan().selectionState,
        targetProductClass: 'plate',
        selectionConfidence: 0.8
      }
    });

    const result = await assistant.selectProductsForTurn('Need plate 100-150 kg plus minus 10 kg', emptyNeedState(), plan, products);

    expect(result.matchedProducts).toHaveLength(12);
    expect(result.visibleProducts.length).toBeGreaterThan(0);
    expect(result.hiddenProducts.length).toBeGreaterThan(0);
    expect(result.missingQuestions.length).toBeGreaterThan(0);
  });

  it('keeps extra matched products hidden behind show more when buyer asks for one main and one backup', async () => {
    const products = Array.from({ length: 12 }, (_, index) =>
      productWithSpecs(`g${index}`, `Generator gasoline ${4 + index / 10} kW`, 50_000 + index, `https://example.test/catalog/generators/g${index}`, {})
    );
    const assistant = new AssistantService(undefined as never, new FakeProducts(products) as never);
    const state = {
      ...emptyNeedState(),
      selectionState: mergeProductSelectionState(emptyNeedState().selectionState, {
        currentProductClass: 'generator',
        targetProductClass: 'generator',
        hardConstraints: {
          productIntent: 'generator',
          productRole: 'coreProduct',
          nominalPowerKwMin: 4,
          nominalPowerKwMax: 6,
          exactModelTokens: [],
          mustHaveTraits: [],
          excludedClasses: []
        },
        confidence: 0.8
      })
    };
    const plan = baseTurnPlan({
      requiredProductTraits: {
        ...baseTurnPlan().requiredProductTraits,
        productIntent: 'generator',
        productRole: 'coreProduct'
      }
    });

    const result = await assistant.selectProductsForTurn('Подбери один основной генератор и один запасной, остальное можно под Показать еще', state, plan, []);

    expect(result.matchedProducts).toHaveLength(12);
    expect(result.visibleProducts).toHaveLength(2);
    expect(result.hiddenProducts).toHaveLength(10);
    expect(result.state.selectedProductIds).toEqual(result.visibleProducts.map((item) => item.id));
    expect(result.state.matchedProductIds).toHaveLength(12);
  });

  it('keeps follow-up about the selected main/backup pair inside the visible pair, not hidden matches', async () => {
    const products = Array.from({ length: 12 }, (_, index) =>
      productWithSpecs(`g${index}`, `Generator gasoline ${4 + index / 10} kW`, 50_000 + index, `https://example.test/catalog/generators/g${index}`, {})
    );
    const assistant = new AssistantService(undefined as never, new FakeProducts(products) as never);
    const initialState = {
      ...emptyNeedState(),
      selectionState: mergeProductSelectionState(emptyNeedState().selectionState, {
        currentProductClass: 'generator',
        targetProductClass: 'generator',
        hardConstraints: {
          productIntent: 'generator',
          productRole: 'coreProduct',
          nominalPowerKwMin: 4,
          nominalPowerKwMax: 6,
          exactModelTokens: [],
          mustHaveTraits: [],
          excludedClasses: []
        },
        confidence: 0.8
      })
    };
    const plan = baseTurnPlan({
      requiredProductTraits: {
        ...baseTurnPlan().requiredProductTraits,
        productIntent: 'generator',
        productRole: 'coreProduct'
      }
    });
    const initial = await assistant.selectProductsForTurn(
      'Подбери один основной генератор и один запасной, остальное можно под Показать еще',
      initialState,
      plan,
      []
    );
    expect(initial.visibleProducts).toHaveLength(2);
    expect(initial.hiddenProducts.length).toBeGreaterThan(0);

    const followUp = await assistant.selectProductsForTurn(
      'Из этих двух какой брать основным, а какой оставить резервным?',
      { ...emptyNeedState(), selectionState: initial.state },
      baseTurnPlan({
        contextScope: 'previousSelection',
        searchScope: 'previousSelectionOnly',
        catalogSearchQuery: 'сравнить текущие два выбранных генератора без поиска новых вариантов',
        requiredProductTraits: {
          ...baseTurnPlan().requiredProductTraits,
          productIntent: 'generator',
          productRole: 'coreProduct'
        },
        selectionState: {
          ...baseTurnPlan().selectionState,
          currentProductClass: 'generator',
          targetProductClass: 'generator'
        }
      }),
      products
    );

    expect(followUp.matchedProducts.map((item) => item.id)).toEqual(initial.visibleProducts.map((item) => item.id));
    expect(followUp.visibleProducts.map((item) => item.id)).toEqual(initial.visibleProducts.map((item) => item.id));
    expect(followUp.state.selectedProductIds).toEqual(initial.visibleProducts.map((item) => item.id));
  });

  it('exact model selection does not return an accessory as the core product', async () => {
    const assistant = new AssistantService(undefined as never, new FakeProducts([
      product('mat', ru('\\u041a\\u043e\\u0432\\u0440\\u0438\\u043a \\u0434\\u043b\\u044f \\u0432\\u0438\\u0431\\u0440\\u043e\\u043f\\u043b\\u0438\\u0442\\u044b Husqvarna LF 80 LAT'), 12_000, 'https://example.test/catalog/accessories/lf80-mat'),
      product('plate', ru('\\u0412\\u0438\\u0431\\u0440\\u043e\\u043f\\u043b\\u0438\\u0442\\u0430 Husqvarna LF 80 LAT 95 \\u043a\\u0433'), 154_000, 'https://example.test/catalog/vibroplity/lf80-lat')
    ]) as never);
    const plan = baseTurnPlan({
      catalogSearchQuery: 'Husqvarna LF 80 LAT plate',
      requiredProductTraits: {
        ...baseTurnPlan().requiredProductTraits,
        productIntent: 'plate',
        productRole: 'coreProduct'
      },
      selectionState: {
        ...baseTurnPlan().selectionState,
        targetProductClass: 'plate',
        exactModelConstraint: 'LF 80 LAT',
        selectionConfidence: 0.8
      }
    });

    const result = await assistant.selectProductsForTurn('Is there Husqvarna LF 80 LAT plate?', emptyNeedState(), plan, []);

    expect(result.matchedProducts.map((item) => item.id)).toEqual(['plate']);
  });

  it('fallback turn plan does not select products or hard product traits', () => {
    const plan = assistantTestHooks.fallbackTurnPlan({
      userMessage: 'Need generator 5-6 kw with electric start',
      needState: emptyNeedState(),
      baseQuery: 'Need generator 5-6 kw with electric start'
    });

    expect(plan.selectedProductIds).toEqual([]);
    expect(plan.requiredProductTraits.productIntent).toBe('unknown');
    expect(plan.requiredProductTraits.startType).toBe('unknown');
    expect(plan.selectionState.shouldShowCards).toBe(false);
  });

  it('does not treat voltage and power specs as exact model tokens', () => {
    const tokens = assistantTestHooks.extractModelTokens('Need generator 220V/230V 5-6 kW with electric start, maybe AP6500E');

    expect(tokens.map((token) => token.toLowerCase())).toContain('ap6500e');
    expect(tokens.join(' ')).not.toMatch(/220|230|5-6|kw/i);
    expect(assistantTestHooks.extractModelTokens('What TSS gasoline generators from 8 to 10 kW 220 V are in catalog?')).toEqual([]);
  });

  it('does not treat weight ranges as exact model tokens', () => {
    const message = ru('\\u0418\\u043d\\u0442\\u0435\\u0440\\u0435\\u0441\\u0443\\u0435\\u0442 \\u0432\\u0438\\u0431\\u0440\\u043e\\u043f\\u043b\\u0438\\u0442\\u0430 \\u0434\\u043b\\u044f \\u0430\\u0441\\u0444\\u0430\\u043b\\u044c\\u0442\\u0430 90-100\\u043a\\u0433');

    expect(assistantTestHooks.parseWeightNeedRangeKg(message)).toEqual({ min: 90, max: 100 });
    expect(assistantTestHooks.extractModelTokens(message)).toEqual([]);
  });

  it('drops generic planner exact-model text when the buyer asks for plate cards by weight range', async () => {
    const plate83 = productWithSpecs('plate-83', ru('\\u0412\\u0438\\u0431\\u0440\\u043e\\u043f\\u043b\\u0438\\u0442\\u0430 Wacker Neuson MP15-CE 83 \\u043a\\u0433'), 154_000, 'https://example.test/plate-83', {
      weight: '83 kg'
    });
    const plate100 = productWithSpecs('plate-100', ru('\\u0412\\u0438\\u0431\\u0440\\u043e\\u043f\\u043b\\u0438\\u0442\\u0430 TSS VP100 100 \\u043a\\u0433'), 52_000, 'https://example.test/plate-100', {
      weight: '100 kg'
    });
    const assistant = new AssistantService(undefined as never, new FakeProducts([plate83, plate100] as any) as never);
    const message = ru('\\u041f\\u043e\\u043a\\u0430\\u0436\\u0438\\u0442\\u0435 \\u0438\\u0437 \\u043a\\u0430\\u0442\\u0430\\u043b\\u043e\\u0433\\u0430 \\u0432\\u0438\\u0431\\u0440\\u043e\\u043f\\u043b\\u0438\\u0442\\u044b \\u043f\\u0440\\u0438\\u043c\\u0435\\u0440\\u043d\\u043e 80-100 \\u043a\\u0433 \\u0438 \\u0441\\u043a\\u0430\\u0436\\u0438\\u0442\\u0435, \\u043d\\u0443\\u0436\\u0435\\u043d \\u043b\\u0438 \\u043a\\u043e\\u0432\\u0440\\u0438\\u043a \\u043f\\u043e\\u0434 \\u043f\\u043b\\u0438\\u0442\\u043a\\u0443.');
    const genericExactModelText = ru('\\u0432\\u0438\\u0431\\u0440\\u043e\\u043f\\u043b\\u0438\\u0442\\u044b \\u043f\\u0440\\u0438\\u043c\\u0435\\u0440\\u043d\\u043e 80-100 \\u043a\\u0433');
    const plan = baseTurnPlan({
      catalogSearchQuery: message,
      agentDecision: productSelectionAgentDecision({
        taskType: 'product_selection_with_availability',
        catalogAction: 'find_matching_products',
        productCardsPolicy: 'show_matching_products'
      }),
      requiredProductTraits: {
        ...baseTurnPlan().requiredProductTraits,
        productIntent: 'plate',
        productRole: 'coreProduct',
        weightKgMin: 80,
        weightKgMax: 100
      },
      selectionState: {
        ...baseTurnPlan().selectionState,
        currentProductClass: 'plate',
        targetProductClass: 'plate',
        exactModelConstraint: genericExactModelText
      }
    });

    const result = await assistant.selectProductsForTurn(message, emptyNeedState(), plan, [plate83, plate100] as any);

    expect(result.state.hardConstraints.exactModelConstraint).toBe('');
    expect(result.state.hardConstraints.exactModelTokens).toEqual([]);
    expect(result.state.hardConstraints.weightKgMin).toBe(80);
    expect(result.state.hardConstraints.weightKgMax).toBe(100);
    expect(result.matchedProducts.map((item) => item.id)).toEqual(expect.arrayContaining(['plate-83', 'plate-100']));
  });

  it('supersedes replaced semantic requirements instead of keeping conflicting active ranges', () => {
    const initial = mergeNeedState(emptyNeedState(), {
      semanticMemory: {
        ...emptyNeedState().semanticMemory,
        activeRequirementIds: ['weight-90-100'],
        requirements: [
          semanticRequirement({
            id: 'weight-90-100',
            kind: 'weightKg',
            value: { min: 90, max: 100, unit: 'kg', text: '90-100 kg' }
          })
        ],
        selectionPolicy: {
          primaryRequirementIds: ['weight-90-100'],
          alternativeMode: 'afterPrimary',
          explanationRequired: true
        }
      }
    });
    const changed = mergeNeedState(initial, {
      semanticMemory: {
        ...emptyNeedState().semanticMemory,
        activeRequirementIds: ['weight-100-120'],
        requirements: [
          semanticRequirement({
            id: 'weight-100-120',
            kind: 'weightKg',
            value: { min: 100, max: 120, unit: 'kg', text: '100-120 kg' },
            replacesRequirementIds: ['weight-90-100']
          })
        ],
        selectionPolicy: {
          primaryRequirementIds: ['weight-100-120'],
          alternativeMode: 'afterPrimary',
          explanationRequired: true
        }
      }
    });

    expect(changed.semanticMemory.activeRequirementIds).toEqual(['weight-100-120']);
    expect(changed.semanticMemory.requirements.find((item) => item.id === 'weight-90-100')?.status).toBe('superseded');
    expect(changed.semanticMemory.requirements.find((item) => item.id === 'weight-100-120')?.status).toBe('active');
  });

  it('keeps the full plate-selection cycle aligned when the buyer returns from 100+ kg to 90-100 kg', async () => {
    const products = [
      productWithSpecs('redverg107', ru('\\u0412\\u0438\\u0431\\u0440\\u043e\\u043f\\u043b\\u0438\\u0442\\u0430 REDVERG RD-29265 (107 \\u043a\\u0433)'), 59_990, 'https://example.test/catalog/vibroplity/redverg_107/', { weight: '107 kg', waterTank: '14 l' }),
      productWithSpecs('champion103', ru('\\u0412\\u0438\\u0431\\u0440\\u043e\\u043f\\u043b\\u0438\\u0442\\u0430 CHAMPION PC1151FT (103 \\u043a\\u0433)'), 70_490, 'https://example.test/catalog/vibroplity/champion_103/', { weight: '103 kg' }),
      productWithSpecs('bps1550', ru('\\u0412\\u0438\\u0431\\u0440\\u043e\\u043f\\u043b\\u0438\\u0442\\u0430 Wacker Neuson BPS 1550 Gw-c CE (91 \\u043a\\u0433)'), 160_000, 'https://example.test/catalog/vibroplity/bps_1550/', { weight: '91 kg', waterTank: '10 l' }),
      productWithSpecs('mp15', ru('\\u0412\\u0438\\u0431\\u0440\\u043e\\u043f\\u043b\\u0438\\u0442\\u0430 Wacker Neuson MP15-CE (83 \\u043a\\u0433) 0630338'), 154_000, 'https://example.test/catalog/vibroplity/mp15_ce/', { weight: '83 kg', article: '0630338' }),
      productWithSpecs('lf95', ru('\\u0412\\u0438\\u0431\\u0440\\u043e\\u043f\\u043b\\u0438\\u0442\\u0430 Husqvarna LF 80 LAT (95 \\u043a\\u0433)'), 255_000, 'https://example.test/catalog/vibroplity/lf80lat/', { weight: '95 kg' })
    ];
    const assistant = new AssistantService(undefined as never, new FakeProducts(products) as never);
    let state = emptyNeedState();

    const initialMessage = ru('\\u0418\\u043d\\u0442\\u0435\\u0440\\u0435\\u0441\\u0443\\u0435\\u0442 \\u0432\\u0438\\u0431\\u0440\\u043e\\u043f\\u043b\\u0438\\u0442\\u0430 \\u0434\\u043b\\u044f \\u0430\\u0441\\u0444\\u0430\\u043b\\u044c\\u0442\\u0430 90-100\\u043a\\u0433');
    state = withSemanticMemory(state, {
      activeRequirementIds: ['class-plate', 'task-asphalt', 'weight-90-100'],
      requirements: [
        semanticRequirement({ id: 'class-plate', kind: 'productClass', value: { productClass: 'plate', text: 'plate' } }),
        semanticRequirement({ id: 'task-asphalt', kind: 'task', value: { text: 'asphalt work' } }),
        semanticRequirement({ id: 'weight-90-100', kind: 'weightKg', value: { min: 90, max: 100, unit: 'kg', text: '90-100 kg' } })
      ],
      selectionPolicy: { primaryRequirementIds: ['weight-90-100'], alternativeMode: 'afterPrimary', explanationRequired: true }
    });
    const initial = await assistant.selectProductsForTurn(initialMessage, state, baseTurnPlan({
      catalogSearchQuery: initialMessage,
      requiredProductTraits: {
        ...baseTurnPlan().requiredProductTraits,
        productIntent: 'plate',
        productRole: 'coreProduct',
        weightKgMin: 90,
        weightKgMax: 100
      },
      selectionState: {
        ...baseTurnPlan().selectionState,
        currentProductClass: 'plate',
        targetProductClass: 'plate',
        mustHaveTraits: ['asphalt work']
      }
    }), products);
    state = { ...state, selectionState: initial.state };

    expect(initial.state.hardConstraints.weightKgMin).toBe(90);
    expect(initial.state.hardConstraints.weightKgMax).toBe(100);
    expect(initial.state.hardConstraints.exactModelTokens).toEqual([]);
    const initialIds = initial.visibleProducts.map((item) => item.id);
    expect(initialIds).toEqual(expect.arrayContaining(['bps1550', 'lf95']));
    expect(Math.max(initialIds.indexOf('bps1550'), initialIds.indexOf('lf95'))).toBeLessThan(initialIds.indexOf('champion103'));
    expect(Math.max(initialIds.indexOf('bps1550'), initialIds.indexOf('lf95'))).toBeLessThan(initialIds.indexOf('redverg107'));

    const heavierMessage = ru('\\u0425\\u043e\\u0440\\u043e\\u0448\\u043e, \\u0434\\u0430\\u0432\\u0430\\u0439 \\u0447\\u0443\\u0442\\u044c \\u0431\\u043e\\u043b\\u044c\\u0448\\u0435 100\\u043a\\u0433');
    state = withSemanticMemory(state, {
      activeRequirementIds: ['class-plate', 'task-asphalt', 'weight-100-120'],
      requirements: [
        semanticRequirement({ id: 'class-plate', kind: 'productClass', value: { productClass: 'plate', text: 'plate' } }),
        semanticRequirement({ id: 'task-asphalt', kind: 'task', value: { text: 'asphalt work' } }),
        semanticRequirement({ id: 'weight-90-100', kind: 'weightKg', value: { min: 90, max: 100, unit: 'kg', text: '90-100 kg' }, status: 'superseded' }),
        semanticRequirement({ id: 'weight-100-120', kind: 'weightKg', value: { min: 100, max: 120, unit: 'kg', text: '100-120 kg' }, strictness: 'strictOnly', replacesRequirementIds: ['weight-90-100'] })
      ],
      selectionPolicy: { primaryRequirementIds: ['weight-100-120'], alternativeMode: 'none', explanationRequired: true }
    });
    const heavier = await assistant.selectProductsForTurn(heavierMessage, state, baseTurnPlan({
      catalogSearchQuery: heavierMessage,
      requiredProductTraits: {
        ...baseTurnPlan().requiredProductTraits,
        productIntent: 'plate',
        productRole: 'coreProduct',
        weightKgMin: 100,
        weightKgMax: 120
      },
      selectionState: {
        ...baseTurnPlan().selectionState,
        currentProductClass: 'plate',
        targetProductClass: 'plate',
        mustHaveTraits: ['asphalt work']
      }
    }), products);
    state = { ...state, selectionState: heavier.state };

    expect(heavier.state.hardConstraints.weightKgMin).toBe(100);
    expect(heavier.state.hardConstraints.weightKgMax).toBe(120);
    expect(heavier.visibleProducts.map((item) => item.id)).toEqual(expect.arrayContaining(['redverg107', 'champion103']));
    expect(heavier.visibleProducts.map((item) => item.id)).not.toContain('bps1550');

    const availabilityMessage = ru('\\u041d\\u0438\\u0447\\u0435\\u0433\\u043e \\u043d\\u0435 \\u043f\\u043e\\u043d\\u0438\\u043c\\u0430\\u044e!!! \\u0412\\u0438\\u0431\\u0440\\u043e\\u043f\\u043b\\u0438\\u0442\\u0430 BPS 1550 WACKER \\u0435\\u0441\\u0442\\u044c \\u0443 \\u0432\\u0430\\u0441? \\u0418\\u043b\\u0438 MP-15 CE ??? \\u042f \\u0438\\u0437\\u043d\\u0430\\u0447\\u0430\\u043b\\u044c\\u043d\\u043e \\u0437\\u0430\\u043f\\u0440\\u043e\\u0441\\u0438\\u043b \\u043f\\u043b\\u0438\\u0442\\u0443 90-100\\u043a\\u0433');
    state = withSemanticMemory(state, {
      activeRequirementIds: ['class-plate', 'task-asphalt', 'weight-90-100-return'],
      requirements: [
        semanticRequirement({ id: 'class-plate', kind: 'productClass', value: { productClass: 'plate', text: 'plate' } }),
        semanticRequirement({ id: 'task-asphalt', kind: 'task', value: { text: 'asphalt work' } }),
        semanticRequirement({ id: 'weight-100-120', kind: 'weightKg', value: { min: 100, max: 120, unit: 'kg', text: '100-120 kg' }, status: 'superseded' }),
        semanticRequirement({ id: 'weight-90-100-return', kind: 'weightKg', value: { min: 90, max: 100, unit: 'kg', text: '90-100 kg' }, replacesRequirementIds: ['weight-100-120'] })
      ],
      mentionedProducts: [
        { token: 'BPS 1550', normalizedToken: 'bps1550', role: 'availabilityCheck', status: 'unresolved', productIds: [], evidence: availabilityMessage, updatedAt: '2026-05-09T00:00:00.000Z' },
        { token: 'MP-15 CE', normalizedToken: 'mp15ce', role: 'availabilityCheck', status: 'unresolved', productIds: [], evidence: availabilityMessage, updatedAt: '2026-05-09T00:00:00.000Z' }
      ],
      selectionPolicy: { primaryRequirementIds: ['weight-90-100-return'], alternativeMode: 'afterPrimary', explanationRequired: true }
    });
    const corrected = await assistant.selectProductsForTurn(availabilityMessage, state, baseTurnPlan({
      catalogSearchQuery: availabilityMessage,
      requiredProductTraits: {
        ...baseTurnPlan().requiredProductTraits,
        productIntent: 'plate',
        productRole: 'coreProduct',
        weightKgMin: 90,
        weightKgMax: 100
      },
      selectionState: {
        ...baseTurnPlan().selectionState,
        currentProductClass: 'plate',
        targetProductClass: 'plate',
        mustHaveTraits: ['asphalt work']
      }
    }), products);

    expect(corrected.state.hardConstraints.weightKgMin).toBe(90);
    expect(corrected.state.hardConstraints.weightKgMax).toBe(100);
    expect(corrected.state.hardConstraints.exactModelTokens).toEqual([]);
    expect(corrected.visibleProducts.map((item) => item.id)).toContain('bps1550');
    expect(corrected.visibleProducts.map((item) => item.id).indexOf('redverg107')).toBeGreaterThan(corrected.visibleProducts.map((item) => item.id).indexOf('bps1550'));
    expect(corrected.visibleProducts.map((item) => item.id).indexOf('champion103')).toBeGreaterThan(corrected.visibleProducts.map((item) => item.id).indexOf('bps1550'));
    expect(corrected.comparisonProducts.map((item) => item.id)).toContain('mp15');
    expect(corrected.rejectedProducts.find((item) => item.productId === 'mp15')?.reason).toContain('below 90 kg');
    expect(state.semanticMemory.activeRequirementIds).toContain('weight-90-100-return');
    expect(state.semanticMemory.requirements.find((item) => item.id === 'weight-100-120')?.status).toBe('superseded');
    expect(state.semanticMemory.mentionedProducts.map((item) => [item.token, item.role])).toEqual(expect.arrayContaining([
      ['BPS 1550', 'availabilityCheck'],
      ['MP-15 CE', 'availabilityCheck']
    ]));

    const fallbackProducts = products.filter((product) => !['bps1550', 'lf95'].includes(product.id));
    const fallbackAssistant = new AssistantService(undefined as never, new FakeProducts(fallbackProducts) as never);
    const fallbackState = withSemanticMemory(emptyNeedState(), {
      activeRequirementIds: ['class-plate', 'task-asphalt', 'weight-90-100'],
      requirements: [
        semanticRequirement({ id: 'class-plate', kind: 'productClass', value: { productClass: 'plate', text: 'plate' } }),
        semanticRequirement({ id: 'task-asphalt', kind: 'task', value: { text: 'asphalt work' } }),
        semanticRequirement({ id: 'weight-90-100', kind: 'weightKg', value: { min: 90, max: 100, unit: 'kg', text: '90-100 kg' }, strictness: 'fallbackAllowed' })
      ],
      selectionPolicy: { primaryRequirementIds: ['weight-90-100'], alternativeMode: 'fallbackOnly', explanationRequired: true }
    });
    const fallback = await fallbackAssistant.selectProductsForTurn(initialMessage, fallbackState, baseTurnPlan({
      catalogSearchQuery: initialMessage,
      requiredProductTraits: {
        ...baseTurnPlan().requiredProductTraits,
        productIntent: 'plate',
        productRole: 'coreProduct',
        weightKgMin: 90,
        weightKgMax: 100
      },
      selectionState: {
        ...baseTurnPlan().selectionState,
        currentProductClass: 'plate',
        targetProductClass: 'plate',
        mustHaveTraits: ['asphalt work']
      }
    }), fallbackProducts);

    expect(fallback.visibleProducts.map((item) => item.id)).toEqual(expect.arrayContaining(['champion103', 'redverg107']));
  });

  it('does not classify a concrete vibrator with 380V in the name as a generator', async () => {
    const assistant = new AssistantService(undefined as never, new FakeProducts([
      product('vibrator', 'Вибратор глубинный (привод) H3EM-I, 380В GRANDPOOL', 9_580, 'https://example.test/catalog/vibratory/h3em'),
      product('generator', 'Генератор бензиновый TOR KM2800i 2.8 кВт', 23_272, 'https://example.test/catalog/generator/km2800i')
    ]) as never);

    const result = await assistant.selectProductsForTurn('Нужен генератор для дома 3 кВт', emptyNeedState(), baseTurnPlan({
      requiredProductTraits: {
        ...baseTurnPlan().requiredProductTraits,
        productIntent: 'generator',
        productRole: 'coreProduct'
      }
    }), []);

    expect(result.visibleProducts.map((item) => item.id)).not.toContain('vibrator');
    expect(result.visibleProducts.map((item) => item.id)).toContain('generator');
  });

  it('does not create hard budget from an unknown answer', async () => {
    const assistant = new AssistantService(undefined as never, new FakeProducts([
      productWithSpecs('g1', 'Generator gasoline A3500i 3.0 kW', 40_000, 'https://example.test/catalog/generators/g1', {})
    ]) as never);
    const state = {
      ...emptyNeedState(),
      selectionState: mergeProductSelectionState(emptyNeedState().selectionState, {
        currentProductClass: 'generator',
        targetProductClass: 'generator',
        hardConstraints: {
          productIntent: 'generator',
          productRole: 'coreProduct',
          exactModelTokens: [],
          mustHaveTraits: [],
          excludedClasses: []
        },
        confidence: 0.7
      })
    };

    const result = await assistant.selectProductsForTurn('не знаю', state, baseTurnPlan({
      requiredProductTraits: {
        ...baseTurnPlan().requiredProductTraits,
        productIntent: 'generator',
        productRole: 'coreProduct'
      }
    }), []);

    expect(result.state.hardConstraints.budgetMax).toBeUndefined();
  });

  it('keeps a boiler article as compatibility target, not generator exact token', async () => {
    const assistant = new AssistantService(undefined as never, new FakeProducts([]) as never);
    const state = {
      ...emptyNeedState(),
      selectionState: mergeProductSelectionState(emptyNeedState().selectionState, {
        currentProductClass: 'generator',
        targetProductClass: 'generator',
        hardConstraints: {
          productIntent: 'generator',
          productRole: 'coreProduct',
          exactModelTokens: [],
          mustHaveTraits: [],
          excludedClasses: []
        },
        confidence: 0.7
      })
    };

    const result = await assistant.selectProductsForTurn('котел у меня Baxi Ampera Plus, на нем артикул E8403106', state, baseTurnPlan({
      requiredProductTraits: {
        ...baseTurnPlan().requiredProductTraits,
        productIntent: 'generator',
        productRole: 'coreProduct'
      }
    }), []);

    expect(result.state.hardConstraints.exactModelTokens).not.toContain('E8403106');
    expect(result.state.compatibilityTargetProduct?.article).toBe('E8403106');
  });

  it('does not turn an inverter explanation question into a hard inverter requirement', async () => {
    const assistant = new AssistantService(undefined as never, new FakeProducts([]) as never);
    const state = {
      ...emptyNeedState(),
      selectionState: mergeProductSelectionState(emptyNeedState().selectionState, {
        currentProductClass: 'generator',
        targetProductClass: 'generator',
        hardConstraints: {
          productIntent: 'generator',
          productRole: 'coreProduct',
          exactModelTokens: [],
          mustHaveTraits: [],
          excludedClasses: []
        },
        confidence: 0.7
      })
    };

    const result = await assistant.selectProductsForTurn('Инверторный? А что это вообще?', state, baseTurnPlan({
      requiredProductTraits: {
        ...baseTurnPlan().requiredProductTraits,
        productIntent: 'generator',
        productRole: 'coreProduct'
      }
    }), []);

    expect(result.state.hardConstraints.conventionalGenerator).toBeUndefined();
  });

  it('infers 220 V from ordinary home load context without treating it as planner-made hard data', async () => {
    const assistant = new AssistantService(undefined as never, new FakeProducts([]) as never);

    const result = await assistant.selectProductsForTurn('Для дома: два холодильника, свет и котел.', emptyNeedState(), baseTurnPlan({
      requiredProductTraits: {
        ...baseTurnPlan().requiredProductTraits,
        productIntent: 'generator',
        productRole: 'coreProduct'
      }
    }), []);

    expect(result.state.hardConstraints.singlePhase220).toBe(true);
    expect(result.state.hardConstraints.provenance?.singlePhase220).toBe('inferred_from_load');
  });

  it('replaces stale low generator power after a confirmed boiler load and keeps cheapest within that set', async () => {
    const products = [
      productWithSpecs('weak', 'Generator gasoline BISON BS3250i 3.0 kW', 28_032, 'https://example.test/catalog/generators/weak', {}),
      productWithSpecs('expensive', 'Generator gasoline FUBAG TI 7000 A ES 6.5 kW', 126_060, 'https://example.test/catalog/generators/expensive', { start: 'electric starter' }),
      productWithSpecs('cheap-fit', 'Generator gasoline TSS SGG 7000Ei 7.0 kW', 80_913, 'https://example.test/catalog/generators/cheap-fit', { start: 'electric starter' })
    ];
    const assistant = new AssistantService(undefined as never, new FakeProducts(products) as never);
    const initialSelection = mergeProductSelectionState(emptyNeedState().selectionState, {
      currentProductClass: 'generator',
      targetProductClass: 'generator',
      compatibilityTargetProduct: { kind: 'boiler', name: 'Baxi Ampera Plus', article: 'E8403106' },
      hardConstraints: {
        productIntent: 'generator',
        productRole: 'coreProduct',
        nominalPowerKwMin: 2,
        nominalPowerKwMax: 3.5,
        exactModelTokens: [],
        mustHaveTraits: [],
        excludedClasses: []
      },
      confidence: 0.8
    });

    const powered = await assistant.selectProductsForTurn('нашел он 6 квт', { ...emptyNeedState(), selectionState: initialSelection }, baseTurnPlan({
      requiredProductTraits: {
        ...baseTurnPlan().requiredProductTraits,
        productIntent: 'generator',
        productRole: 'coreProduct'
      }
    }), []);

    expect(powered.state.hardConstraints.nominalPowerKwMin).toBe(6);
    expect(powered.matchedProducts.map((item) => item.id)).not.toContain('weak');

    const cheapest = await assistant.selectProductsForTurn('а какой самый дешевый вариант?', { ...emptyNeedState(), selectionState: powered.state }, baseTurnPlan({
      requiredProductTraits: {
        ...baseTurnPlan().requiredProductTraits,
        productIntent: 'generator',
        productRole: 'coreProduct'
      }
    }), []);

    expect(cheapest.state.hardConstraints.nominalPowerKwMin).toBe(6);
    expect(cheapest.visibleProducts[0]?.id).toBe('cheap-fit');
    expect(cheapest.visibleProducts.map((item) => item.id)).not.toContain('weak');
  });

  it('calculates generator load from boiler, refrigerators, and lighting before matching products', async () => {
    const products = [
      productWithSpecs('six', 'Generator gasoline Budget 6.0 kW', 50_000, 'https://example.test/catalog/generators/six', {}),
      productWithSpecs('seven', 'Generator gasoline Mid 7.0 kW', 70_000, 'https://example.test/catalog/generators/seven', {}),
      productWithSpecs('nine', 'Generator gasoline Fit 9.0 kW', 90_000, 'https://example.test/catalog/generators/nine', {})
    ];
    const assistant = new AssistantService(undefined as never, new FakeProducts(products) as never);
    const plan = baseTurnPlan({
      requiredProductTraits: {
        ...baseTurnPlan().requiredProductTraits,
        productIntent: 'generator',
        productRole: 'coreProduct'
      }
    });
    const planWithCompatibilityBrand = baseTurnPlan({
      selectionState: {
        ...baseTurnPlan().selectionState,
        currentProductClass: 'generator',
        targetProductClass: 'generator',
        brandConstraint: 'Baxi'
      },
      requiredProductTraits: {
        ...baseTurnPlan().requiredProductTraits,
        productIntent: 'generator',
        productRole: 'coreProduct'
      }
    });

    const home = await assistant.selectProductsForTurn(
      ru('\\u0414\\u043b\\u044f \\u0434\\u043e\\u043c\\u0430: \\u0434\\u0432\\u0430 \\u0445\\u043e\\u043b\\u043e\\u0434\\u0438\\u043b\\u044c\\u043d\\u0438\\u043a\\u0430, \\u0441\\u0432\\u0435\\u0442 \\u0438 \\u043a\\u043e\\u0442\\u0435\\u043b, \\u043e\\u0431\\u044b\\u0447\\u043d\\u0430\\u044f \\u0441\\u0435\\u0442\\u044c 220 \\u0412.'),
      emptyNeedState(),
      plan,
      []
    );
    const boiler = await assistant.selectProductsForTurn(
      ru('\\u041a\\u043e\\u0442\\u0435\\u043b Baxi Ampera Plus, \\u0430\\u0440\\u0442\\u0438\\u043a\\u0443\\u043b E8403106.'),
      { ...emptyNeedState(), selectionState: home.state },
      planWithCompatibilityBrand,
      []
    );
    const powered = await assistant.selectProductsForTurn(
      ru('\\u041a\\u043e\\u0442\\u0435\\u043b 6 \\u043a\\u0412\\u0442, \\u0445\\u043e\\u043b\\u043e\\u0434\\u0438\\u043b\\u044c\\u043d\\u0438\\u043a\\u0438 \\u043e\\u0431\\u044b\\u0447\\u043d\\u044b\\u0435, \\u0441\\u0432\\u0435\\u0442 \\u043f\\u0440\\u0438\\u043c\\u0435\\u0440\\u043d\\u043e 800 \\u0412\\u0442.'),
      { ...emptyNeedState(), selectionState: boiler.state },
      planWithCompatibilityBrand,
      products
    );

    expect(powered.state.loadProfile?.requiredNominalKw).toBe(9);
    expect(powered.state.hardConstraints.nominalPowerKwMin).toBe(9);
    expect(powered.state.hardConstraints.brandConstraint).toBeUndefined();
    expect(powered.visibleProducts.map((item) => item.id)).toEqual(['nine']);
    expect(powered.matchedProducts.map((item) => item.id)).not.toContain('six');
    expect(powered.matchedProducts.map((item) => item.id)).not.toContain('seven');
  });

  it('does not promote non-simultaneous mentioned loads into the active generator scenario', async () => {
    const products = [
      productWithSpecs('four', 'Генератор бензиновый инверторный SUMEC SU4500i 4.0 kW', 36_500, 'https://example.test/catalog/generators/four', {}),
      productWithSpecs('five', 'Генератор бензиновый SUMEC SU7700 5.0 kW', 42_490, 'https://example.test/catalog/generators/five', {}),
      productWithSpecs('seven-half', 'Генератор бензиновый ET-POWER ET8000EAX 7.5 kW', 72_500, 'https://example.test/catalog/generators/seven-half', {})
    ];
    const assistant = new AssistantService(undefined as never, new FakeProducts(products) as never);
    const plan = baseTurnPlan({
      requiredProductTraits: {
        ...baseTurnPlan().requiredProductTraits,
        productIntent: 'generator',
        productRole: 'coreProduct'
      }
    });

    const initial = await assistant.selectProductsForTurn(
      'Нужен генератор для дачи: свет, холодильник и болгарка или дрель, мощность инструмента не знаю. Сеть 220 В. Подбери один основной генератор и один запасной.',
      emptyNeedState(),
      plan,
      products,
      undefined,
      2
    );
    const followUp = await assistant.selectProductsForTurn(
      'Если добавлю роутер, телевизор и ноутбук, это меняет выбор? Чайник и инструмент одновременно включать не буду.',
      { ...emptyNeedState(), selectionState: initial.state },
      plan,
      products,
      undefined,
      2
    );

    expect(followUp.state.loadProfile?.items.map((item) => item.name)).not.toContain('электрочайник');
    expect(followUp.state.loadProfile?.requiredNominalKw).toBeLessThanOrEqual(5);
    expect(followUp.state.loadProfile?.simultaneousStarting).toBe(false);
    expect(followUp.state.hardConstraints.nominalPowerKwMin).toBeLessThanOrEqual(5);
  });

  it('removes an estimated pump load when the buyer explicitly says there is no pump', async () => {
    const products = [
      productWithSpecs('five', 'Генератор бензиновый SUMEC SU7700 5.0 kW', 42_490, 'https://example.test/catalog/generators/five', {}),
      productWithSpecs('six', 'Генератор бензиновый A-iPower LITE AP6500E 6.0 kW', 56_900, 'https://example.test/catalog/generators/six', {}),
      productWithSpecs('seven-half', 'Генератор бензиновый ET-POWER ET8000EAX 7.5 kW', 72_500, 'https://example.test/catalog/generators/seven-half', {})
    ];
    const assistant = new AssistantService(undefined as never, new FakeProducts(products) as never);
    const plan = baseTurnPlan({
      requiredProductTraits: {
        ...baseTurnPlan().requiredProductTraits,
        productIntent: 'generator',
        productRole: 'coreProduct'
      }
    });

    const initial = await assistant.selectProductsForTurn(
      'Нужен генератор для дачи: холодильник, свет и насос, мощность насоса не знаю. Сеть 220 В.',
      emptyNeedState(),
      plan,
      products,
      undefined,
      2
    );
    expect(initial.state.loadProfile?.items.map((item) => item.kind)).toContain('pump');

    const followUp = await assistant.selectProductsForTurn(
      'Насоса нет, только холодильник, свет, роутер, телевизор и иногда ручной инструмент 800–1200 Вт.',
      { ...emptyNeedState(), selectionState: initial.state },
      plan,
      products,
      undefined,
      2
    );

    expect(followUp.state.loadProfile?.items.map((item) => item.kind)).not.toContain('pump');
    expect(followUp.state.loadProfile?.calculation).not.toMatch(/pump|насос/iu);
    expect(followUp.state.hardConstraints.nominalPowerKwMin).toBeLessThan(7);
  });

  it('updates a previous generic pump load when the buyer later names the pump type', async () => {
    const products = [
      productWithSpecs('five', 'Generator gasoline SUMEC SU7700 5.0 kW', 42_490, 'https://example.test/catalog/generators/five', {}),
      productWithSpecs('six', 'Generator gasoline A-iPower LITE AP6500E 6.0 kW', 56_900, 'https://example.test/catalog/generators/six', {})
    ];
    const assistant = new AssistantService(undefined as never, new FakeProducts(products) as never);
    const plan = baseTurnPlan({
      action: 'answer_question',
      answerMode: 'short',
      cardPolicy: 'auto',
      requiredProductTraits: {
        ...baseTurnPlan().requiredProductTraits,
        productIntent: 'generator',
        productRole: 'coreProduct'
      }
    });

    const initial = await assistant.selectProductsForTurn(
      ru('\\u0414\\u043e\\u043c 220 \\u0412, \\u043d\\u0430\\u0441\\u043e\\u0441 \\u043d\\u0435 \\u0437\\u043d\\u0430\\u044e \\u043a\\u0430\\u043a\\u043e\\u0439, \\u0445\\u043e\\u043b\\u043e\\u0434\\u0438\\u043b\\u044c\\u043d\\u0438\\u043a, \\u0441\\u0432\\u0435\\u0442, \\u0431\\u043e\\u043b\\u0433\\u0430\\u0440\\u043a\\u0430 1,2 \\u043a\\u0412\\u0442.'),
      emptyNeedState(),
      plan,
      products,
      undefined,
      2
    );
    const initialPump = initial.state.loadProfile?.items.find((item) => item.kind === 'pump');
    expect(initialPump?.name).toBe('pump');
    expect(initialPump?.source).toBe('estimated_average');
    expect(assistantTestHooks.pumpTypeFromText([initialPump?.name, initialPump?.evidence].filter(Boolean).join(' '))).toBe('generic');
    expect(assistantTestHooks.shouldBlockGeneratorCardsForEstimatedPump(initial.state)).toBe(true);

    const followUp = await assistant.selectProductsForTurn(
      ru('\\u0423\\u0442\\u043e\\u0447\\u043d\\u0438\\u043b: \\u043d\\u0430\\u0441\\u043e\\u0441 \\u0441\\u043a\\u0432\\u0430\\u0436\\u0438\\u043d\\u043d\\u044b\\u0439, 220 \\u0412, \\u043c\\u043e\\u0449\\u043d\\u043e\\u0441\\u0442\\u044c \\u043d\\u0435 \\u0437\\u043d\\u0430\\u044e. \\u041f\\u0440\\u0438\\u043a\\u0438\\u043d\\u044c\\u0442\\u0435 \\u0432\\u0430\\u0440\\u0438\\u0430\\u043d\\u0442\\u044b \\u0433\\u0435\\u043d\\u0435\\u0440\\u0430\\u0442\\u043e\\u0440\\u0430.'),
      { ...emptyNeedState(), selectionState: initial.state },
      plan,
      products,
      undefined,
      2
    );
    const pump = followUp.state.loadProfile?.items.find((item) => item.kind === 'pump');

    expect(pump?.name).toBe('borehole pump');
    expect(pump?.evidence).toMatch(/скважин/i);
    expect(assistantTestHooks.shouldBlockGeneratorCardsForEstimatedPump(followUp.state)).toBe(false);
    expect(followUp.visibleProducts.length).toBeGreaterThan(0);
    const primarySelectionContract = {
      cardsRole: 'primary',
      answerTask: 'product_selection',
      mustAnswerNow: [],
      activeNeeds: [],
      currentFocus: 'generator',
      leadAllowed: true,
      leadAllowedReason: 'test',
      errorRecoveryPriority: 'test',
      validatorWarnings: []
    } as never;
    expect(assistantTestHooks.shouldPromotePrimarySelectionCards(primarySelectionContract, plan, initial, true)).toBe(false);
    expect(assistantTestHooks.shouldPromotePrimarySelectionCards(primarySelectionContract, plan, followUp, false)).toBe(true);
  });

  it('keeps pump wattage memory out of generator power hard constraints', async () => {
    const products = [
      productWithSpecs('three', 'Generator gasoline HOME 3.2 kW 220 V', 38_900, 'https://example.test/catalog/generators/three', {
        nominalPower: '3.2 kW',
        maxPower: '3.8 kW'
      }),
      productWithSpecs('four', 'Generator gasoline HOME 3.8 kW 220 V', 44_900, 'https://example.test/catalog/generators/four', {
        nominalPower: '3.8 kW',
        maxPower: '4.5 kW'
      })
    ];
    const assistant = new AssistantService(undefined as never, new FakeProducts(products) as never);
    const pumpLoadProfile = {
      items: [
        { kind: 'refrigerator', name: 'refrigerator', count: 1, runningKw: 0.15, startingKw: 0.6, source: 'estimated_average', evidence: 'fridge' },
        { kind: 'boiler', name: 'boiler', count: 1, runningKw: 0.1, startingKw: 0.1, source: 'estimated_average', evidence: 'boiler' },
        { kind: 'lighting', name: 'lighting', count: 1, runningKw: 0.1, startingKw: 0.1, source: 'estimated_average', evidence: 'lights' },
        { kind: 'pump', name: 'borehole pump', count: 1, runningKw: 0.75, startingKw: 2, source: 'estimated_average', evidence: 'pump about 750 W' }
      ],
      confidence: 0.58,
      calculation: 'fridge, boiler, lighting, borehole pump 750 W',
      totalRunningKw: 1.1,
      requiredNominalKw: 2.5,
      requiredStartingKw: 2.4,
      simultaneousStarting: false,
      simultaneousStartingKinds: []
    } as any;
    const state = withSemanticMemory({
      ...emptyNeedState(),
      selectionState: mergeProductSelectionState(emptyProductSelectionState(), {
        semanticSource: 'llm_need_extraction',
        currentProductClass: 'generator',
        targetProductClass: 'generator',
        hardConstraints: {
          productIntent: 'generator',
          productRole: 'coreProduct',
          exactModelTokens: [],
          mustHaveTraits: [],
          excludedClasses: []
        },
        loadProfile: pumpLoadProfile,
        confidence: 0.72
      })
    }, {
      activeRequirementIds: ['req_pump_power_750w'],
      requirements: [
        semanticRequirement({
          id: 'req_pump_power_750w',
          kind: 'powerKw',
          value: { amount: 0.75, min: 0.75, max: 0.75, text: '750 W', unit: 'kW' },
          evidence: 'pump about 750 W',
          replacesRequirementIds: ['req_load_pump']
        })
      ]
    });
    const plan = baseTurnPlan({
      agentDecision: productSelectionAgentDecision(),
      requiredProductTraits: {
        ...baseTurnPlan().requiredProductTraits,
        productIntent: 'generator',
        productRole: 'coreProduct',
        nominalPowerKwMin: 3,
        nominalPowerKwMax: 4,
        maxPowerKwMin: 3.5,
        maxPowerKwMax: 5,
        powerReasoning: 'Use the pump load profile to choose a practical generator class, not a 0.75 kW generator.'
      },
      selectionState: {
        ...baseTurnPlan().selectionState,
        currentProductClass: 'generator',
        targetProductClass: 'generator',
        selectionConfidence: 0.86,
        shouldShowCards: true,
        mustHaveTraits: ['home backup', 'pump 750 W']
      }
    });

    const result = await assistant.selectProductsForTurn(
      'The pump is a submersible well pump, about 750 W. Show generator options for the house.',
      state,
      plan,
      products,
      undefined,
      2
    );

    expect(result.state.hardConstraints.nominalPowerKwMin).toBeGreaterThanOrEqual(3);
    expect(result.state.hardConstraints.nominalPowerKwMax).toBeGreaterThanOrEqual(4);
    expect(result.state.hardConstraints.nominalPowerKwMin).not.toBe(0.75);
    expect(result.visibleProducts.length).toBeGreaterThan(0);
    expect(result.visibleProducts.every((item) => item.id === 'three' || item.id === 'four')).toBe(true);
    expect(assistantTestHooks.shouldBlockGeneratorCardsForEstimatedPump(result.state)).toBe(false);
  });

  it('merges LLM load-state updates as appliance refinements instead of duplicate loads', () => {
    const initial = mergeProductSelectionState(emptyNeedState().selectionState, {
      semanticSource: 'llm_need_extraction',
      currentProductClass: 'generator',
      targetProductClass: 'generator',
      loadProfile: {
        items: [
          { kind: 'refrigerator', name: 'refrigerator', count: 1, runningKw: 0.2, startingKw: 0.8, source: 'estimated_average', evidence: 'one fridge' },
          { kind: 'pump', name: 'pump', count: 1, runningKw: 0.75, startingKw: 2, source: 'estimated_average', evidence: 'generic pump' },
          { kind: 'lighting', name: 'lighting', count: 1, runningKw: 0.1, startingKw: 0.1, source: 'estimated_average', evidence: 'lights' },
          { kind: 'tool', name: 'tool', count: 1, runningKw: 1.5, startingKw: 3, source: 'estimated_average', evidence: 'tool' }
        ],
        simultaneousStarting: false,
        simultaneousStartingKinds: [],
        confidence: 0.6,
        removedKinds: []
      },
      confidence: 0.6
    });

    const updated = mergeProductSelectionState(initial, {
      semanticSource: 'llm_need_extraction',
      currentProductClass: 'generator',
      targetProductClass: 'generator',
      loadProfile: {
        items: [
          { kind: 'pump', name: 'borehole pump', count: 1, runningKw: 1.1, startingKw: 2.9, source: 'estimated_average', evidence: 'borehole pump' },
          { kind: 'lighting', name: 'LED lighting', count: 1, runningKw: 0.08, startingKw: 0.08, source: 'estimated_average', evidence: 'LED lights' },
          { kind: 'handheld_tool', name: 'angle grinder', count: 1, runningKw: 1.2, startingKw: 2.2, source: 'explicit_user', evidence: 'angle grinder 1.2 kW' }
        ],
        simultaneousStarting: true,
        simultaneousStartingKinds: ['pump', 'refrigerator'],
        confidence: 0.7,
        removedKinds: []
      },
      confidence: 0.7
    });

    expect(updated.loadProfile?.items.filter((item) => item.kind === 'pump')).toHaveLength(1);
    expect(updated.loadProfile?.items.filter((item) => item.kind === 'lighting')).toHaveLength(1);
    expect(updated.loadProfile?.items.filter((item) => ['tool', 'handheld_tool'].includes(item.kind))).toHaveLength(1);
    expect(updated.loadProfile?.items.find((item) => item.kind === 'pump')?.name).toBe('borehole pump');
    expect(updated.loadProfile?.simultaneousStartingKinds).toEqual(['pump', 'refrigerator']);
    expect(updated.loadProfile?.requiredStartingKw).toBeCloseTo(5, 5);
    expect(updated.loadProfile?.requiredNominalKw).toBe(5);
  });

  it('does not treat a question about switching to 7-8 kW as a desired generator range', async () => {
    const products = [
      productWithSpecs('five', 'Генератор бензиновый SUMEC SU7700 5.0 kW', 42_490, 'https://example.test/catalog/generators/five', {}),
      productWithSpecs('six', 'Генератор бензиновый A-iPower LITE AP6500E 6.0 kW', 56_900, 'https://example.test/catalog/generators/six', {}),
      productWithSpecs('seven-half', 'Генератор бензиновый ET-POWER ET8000EAX 7.5 kW', 72_500, 'https://example.test/catalog/generators/seven-half', {})
    ];
    const assistant = new AssistantService(undefined as never, new FakeProducts(products) as never);
    const state = {
      ...emptyNeedState(),
      selectionState: mergeProductSelectionState(emptyNeedState().selectionState, {
        currentProductClass: 'generator',
        targetProductClass: 'generator',
        hardConstraints: {
          productIntent: 'generator',
          productRole: 'coreProduct',
          exactModelTokens: [],
          mustHaveTraits: [],
          excludedClasses: [],
          nominalPowerKwMin: 4,
          nominalPowerKwMax: 6,
          singlePhase220: true
        },
        matchedProductIds: ['five', 'six'],
        previousCandidateProductIds: ['five', 'six'],
        selectedProductIds: ['six', 'five'],
        confidence: 0.8
      })
    };

    const followUp = await assistant.selectProductsForTurn(
      'Если иногда добавится чайник 2 кВт, но строго не одновременно с инструментом, надо переходить на 7–8 кВт или нет?',
      state,
      baseTurnPlan({
        contextScope: 'previousSelection',
        searchScope: 'previousSelectionOnly',
        requiredProductTraits: {
          ...baseTurnPlan().requiredProductTraits,
          productIntent: 'generator',
          productRole: 'coreProduct'
        }
      }),
      products,
      undefined,
      2
    );

    expect(followUp.state.hardConstraints.nominalPowerKwMin).toBeLessThan(7);
    expect(followUp.visibleProducts.map((item) => item.id)).not.toContain('seven-half');
  });

  it('ranking follow-up can sort the previous matched set instead of dropping cards', async () => {
    const products = [
      productWithSpecs('fit-expensive', 'Generator gasoline inverter FUBAG TI 7000 A ES 6.5 kW', 126_060, 'https://example.test/catalog/generators/fit-expensive', {}),
      productWithSpecs('fit-cheap', 'Generator gasoline inverter TSS SGG 6000Ei 6.0 kW', 80_377, 'https://example.test/catalog/generators/fit-cheap', {})
    ];
    const assistant = new AssistantService(undefined as never, new FakeProducts(products) as never);
    const state = {
      ...emptyNeedState(),
      selectionState: mergeProductSelectionState(emptyNeedState().selectionState, {
        currentProductClass: 'generator',
        targetProductClass: 'generator',
        hardConstraints: {
          productIntent: 'generator',
          productRole: 'coreProduct',
          exactModelTokens: ['non-existing-model'],
          mustHaveTraits: [],
          excludedClasses: []
        },
        matchedProductIds: ['fit-expensive', 'fit-cheap'],
        previousCandidateProductIds: ['fit-expensive', 'fit-cheap'],
        confidence: 0.8
      })
    };

    const cheapest = await assistant.selectProductsForTurn('а какой самый дешевый вариант?', state, baseTurnPlan({
      requiredProductTraits: {
        ...baseTurnPlan().requiredProductTraits,
        productIntent: 'generator',
        productRole: 'coreProduct'
      }
    }), []);

    expect(cheapest.visibleProducts.map((item) => item.id)).toEqual(['fit-cheap', 'fit-expensive']);
  });

  it('sorts suitable products cheapest-first under a budget ceiling', async () => {
    const products = [
      productWithSpecs('mid', 'Generator gasoline Fit 9.0 kW', 70_000, 'https://example.test/catalog/generators/mid', {}),
      productWithSpecs('cheap', 'Generator gasoline Fit 9.0 kW', 50_000, 'https://example.test/catalog/generators/cheap', {}),
      productWithSpecs('near-budget', 'Generator gasoline Fit 9.0 kW', 90_000, 'https://example.test/catalog/generators/near-budget', {})
    ];
    const assistant = new AssistantService(undefined as never, new FakeProducts(products) as never);
    const baseHardConstraints: ProductSelectionCriteria = {
      productIntent: 'generator',
      productRole: 'coreProduct',
      nominalPowerKwMin: 9,
      nominalPowerKwMax: 10,
      exactModelTokens: [],
      mustHaveTraits: [],
      excludedClasses: []
    };
    const baseSelection: Parameters<typeof mergeProductSelectionState>[1] = {
      currentProductClass: 'generator',
      targetProductClass: 'generator',
      hardConstraints: baseHardConstraints,
      confidence: 0.8
    };
    const plan = baseTurnPlan({
      requiredProductTraits: {
        ...baseTurnPlan().requiredProductTraits,
        productIntent: 'generator',
        productRole: 'coreProduct'
      }
    });

    const noBudget = await assistant.selectProductsForTurn('show generator options', {
      ...emptyNeedState(),
      selectionState: mergeProductSelectionState(emptyNeedState().selectionState, baseSelection)
    }, plan, products);
    const withBudget = await assistant.selectProductsForTurn('show generator options', {
      ...emptyNeedState(),
      selectionState: mergeProductSelectionState(emptyNeedState().selectionState, {
        ...baseSelection,
        hardConstraints: {
          ...baseHardConstraints,
          budgetMax: 100_000
        }
      })
    }, plan, products);

    expect(noBudget.visibleProducts.map((item) => item.id)).toEqual(['cheap', 'mid', 'near-budget']);
    expect(withBudget.visibleProducts.map((item) => item.id)).toEqual(['cheap', 'mid', 'near-budget']);
  });

  it('sorts planner-selected suitable products cheapest-first when no budget was requested', async () => {
    const products = [
      productWithSpecs('cheap', 'Generator gasoline Fit 5.0 kW', 50_000, 'https://example.test/catalog/generators/cheap', {}),
      productWithSpecs('best-fit', 'Generator gasoline Fit 5.0 kW electric start low noise', 90_000, 'https://example.test/catalog/generators/best-fit', {
        start: 'electric starter'
      })
    ];
    const assistant = new AssistantService(undefined as never, new FakeProducts(products) as never);
    const baseHardConstraints: ProductSelectionCriteria = {
      productIntent: 'generator',
      productRole: 'coreProduct',
      nominalPowerKwMin: 5,
      nominalPowerKwMax: 6,
      exactModelTokens: [],
      mustHaveTraits: [],
      excludedClasses: []
    };
    const state = {
      ...emptyNeedState(),
      selectionState: mergeProductSelectionState(emptyNeedState().selectionState, {
        currentProductClass: 'generator',
        targetProductClass: 'generator',
        hardConstraints: baseHardConstraints,
        confidence: 0.8
      })
    };
    const plan = baseTurnPlan({
      selectedProductIds: ['best-fit'],
      requiredProductTraits: {
        ...baseTurnPlan().requiredProductTraits,
        productIntent: 'generator',
        productRole: 'coreProduct'
      }
    });

    const result = await assistant.selectProductsForTurn('show suitable generator options', state, plan, products);

    expect(result.visibleProducts.map((item) => item.id)).toEqual(['cheap', 'best-fit']);
  });

  it('enforces LLM-planned hard traits against planner-selected cards', async () => {
    const products = [
      productWithSpecs('diesel', 'Генератор дизельный ENERGO ED5.0/230-KL (4,5 кВт)', 203_111, 'https://example.test/catalog/dizelnye_generatory/ed5-kl/', {}),
      productWithSpecs('honda5000', 'Генератор бензиновый Honda EG 5000 CX (4,0 кВт)', 179_900, 'https://example.test/catalog/benzinovye_generatory/honda-eg-5000/', { start: ru('\\u044d\\u043b\\u0435\\u043a\\u0442\\u0440\\u043e\\u0441\\u0442\\u0430\\u0440\\u0442\\u0435\\u0440') }),
      productWithSpecs('honda4000', 'Генератор бензиновый Honda EG 4000 CX (3,2 кВт)', 149_990, 'https://example.test/catalog/benzinovye_generatory/honda-eg-4000/', { start: ru('\\u044d\\u043b\\u0435\\u043a\\u0442\\u0440\\u043e\\u0441\\u0442\\u0430\\u0440\\u0442\\u0435\\u0440') }),
      productWithSpecs('manual', 'Генератор бензиновый Manual 4.0 kW', 90_000, 'https://example.test/catalog/benzinovye_generatory/manual/', { start: ru('\\u0440\\u0443\\u0447\\u043d\\u043e\\u0439') })
    ];
    const assistant = new AssistantService(undefined as never, new FakeProducts(products) as never);
    const state = {
      ...emptyNeedState(),
      selectionState: mergeProductSelectionState(emptyNeedState().selectionState, {
        currentProductClass: 'generator',
        targetProductClass: 'generator',
        hardConstraints: {
          productIntent: 'generator',
          productRole: 'coreProduct',
          fuel: 'gasoline',
          nominalPowerKwMin: 3.2,
          nominalPowerKwMax: 4.5,
          budgetMax: 200_000,
          exactModelTokens: [],
          mustHaveTraits: [],
          excludedClasses: []
        },
        confidence: 0.8
      })
    };
    const message = ru('\\u041f\\u043e\\u043a\\u0430\\u0436\\u0438 \\u0431\\u0435\\u043d\\u0437\\u0438\\u043d\\u043e\\u0432\\u044b\\u0435 \\u0433\\u0435\\u043d\\u0435\\u0440\\u0430\\u0442\\u043e\\u0440\\u044b \\u0441 \\u044d\\u043b\\u0435\\u043a\\u0442\\u0440\\u043e\\u0441\\u0442\\u0430\\u0440\\u0442\\u043e\\u043c.');
    const plan = baseTurnPlan({
      selectedProductIds: ['diesel', 'manual', 'honda5000'],
      requiredProductTraits: {
        ...baseTurnPlan().requiredProductTraits,
        productIntent: 'generator',
        productRole: 'coreProduct',
        fuel: 'gasoline',
        startType: 'electric'
      }
    });

    const result = await assistant.selectProductsForTurn(message, state, plan, products);
    const cards = assistantTestHooks.cardsFromPlan(products, { ...state, selectionState: result.state }, message, plan);

    expect(result.state.hardConstraints.fuel).toBe('gasoline');
    expect(result.matchedProducts.map((item) => item.id)).toEqual(['honda4000', 'honda5000']);
    expect(result.visibleProducts.map((item) => item.id)).not.toContain('diesel');
    expect(result.visibleProducts.map((item) => item.id)).not.toContain('manual');
    expect(cards.map((item) => item.id)).not.toContain('diesel');
    expect(cards.map((item) => item.id)).not.toContain('manual');
  });

  it('does not mark arbitrary small generators as suitable before load is known', async () => {
    const products = [
      productWithSpecs('small', 'Generator gasoline inverter 1.0 kW', 20_000, 'https://example.test/catalog/generators/small', {}),
      productWithSpecs('mid', 'Generator gasoline inverter 3.0 kW', 45_000, 'https://example.test/catalog/generators/mid', {})
    ];
    const assistant = new AssistantService(undefined as never, new FakeProducts(products) as never);
    const plan = baseTurnPlan({
      requiredProductTraits: {
        ...baseTurnPlan().requiredProductTraits,
        productIntent: 'generator',
        productRole: 'coreProduct'
      }
    });

    const result = await assistant.selectProductsForTurn(ru('\\u041d\\u0443\\u0436\\u0435\\u043d \\u0433\\u0435\\u043d\\u0435\\u0440\\u0430\\u0442\\u043e\\u0440 \\u0434\\u043b\\u044f \\u0434\\u043e\\u043c\\u0430.'), emptyNeedState(), plan, products);

    expect(result.visibleProducts).toEqual([]);
    expect(result.matchedProducts).toEqual([]);
    expect(result.missingQuestions.join(' ')).toContain('catalog_uncertainty:generator_load_or_power_basis_missing');
  });

  it('keeps exact comparison products separate from hard-matched plate recommendations', async () => {
    const assistant = new AssistantService(undefined as never, new FakeProducts([
      product('small', ru('\\u0412\\u0438\\u0431\\u0440\\u043e\\u043f\\u043b\\u0438\\u0442\\u0430 small 60 \\u043a\\u0433'), 50_000, 'https://example.test/catalog/vibroplity/small'),
      product('bps', ru('\\u0412\\u0438\\u0431\\u0440\\u043e\\u043f\\u043b\\u0438\\u0442\\u0430 Wacker Neuson BPS 1550 91 \\u043a\\u0433'), 160_000, 'https://example.test/catalog/vibroplity/bps1550'),
      productWithSpecs('lf100', ru('\\u0412\\u0438\\u0431\\u0440\\u043e\\u043f\\u043b\\u0438\\u0442\\u0430 Husqvarna LF 100 PACE 105 \\u043a\\u0433'), undefined as any, 'https://example.test/catalog/vibroplity/lf100pace', {}),
      product('lf', ru('\\u0412\\u0438\\u0431\\u0440\\u043e\\u043f\\u043b\\u0438\\u0442\\u0430 Husqvarna LF 80 LAT 95 \\u043a\\u0433'), 255_000, 'https://example.test/catalog/vibroplity/lf80lat')
    ]) as never);
    const state = {
      ...emptyNeedState(),
      selectionState: mergeProductSelectionState(emptyNeedState().selectionState, {
        currentProductClass: 'plate',
        targetProductClass: 'plate',
        hardConstraints: {
          productIntent: 'plate',
          productRole: 'coreProduct',
          weightKgMin: 90,
          weightKgMax: 160,
          budgetMax: 200_000,
          exactModelTokens: [],
          mustHaveTraits: [],
          excludedClasses: []
        },
        confidence: 0.8
      })
    };

    const result = await assistant.selectProductsForTurn('why not compare BPS 1550, LF 100 and LF 80 LAT?', state, baseTurnPlan({
      requiredProductTraits: {
        ...baseTurnPlan().requiredProductTraits,
        productIntent: 'plate',
        productRole: 'coreProduct'
      },
      selectionState: {
        ...baseTurnPlan().selectionState,
        targetProductClass: 'plate'
      }
    }), []);

    expect(result.matchedProducts.map((item) => item.id)).toEqual(['bps']);
    expect(result.visibleProducts.map((item) => item.id)).not.toContain('lf100');
    expect(result.comparisonProducts.map((item) => item.id)).toContain('lf100');
    expect(result.comparisonProducts.map((item) => item.id)).toContain('lf');
    expect(result.rejectedProducts.find((item) => item.productId === 'lf100')?.reason).toContain('price is unknown');
    expect(result.rejectedProducts.find((item) => item.productId === 'lf')?.reason).toContain('budget');
  });

  it('repairs product recommendation text that names no visible card', () => {
    const repaired = assistantTestHooks.repairAnswerCardText('— это самый удобный вариант из подборки.', [{
      id: 'g1',
      name: 'Generator gasoline A3500i 3.0 kW',
      category: 'Generators',
      price: 40_000,
      currency: 'RUB',
      imageUrl: null,
      sourceUrl: null,
      brand: null,
      specs: {},
      reasons: [],
      caveats: []
    }], baseTurnPlan());

    expect(repaired).toContain('Generator gasoline A3500i 3.0 kW');
  });

  it('keeps the model answer when no cards satisfy the LLM-planned constraints', () => {
    const answer = 'I do not see a catalog card that satisfies gasoline, about 4 kW, and electric start at the same time.';
    const repaired = assistantTestHooks.repairAnswerCardText(answer, [], baseTurnPlan({
      action: 'recommend_products',
      answerMode: 'productRecommendation'
    }));

    expect(repaired).toBe(answer);
  });

  it('repairs generator load minimum text when the first card has higher power', () => {
    const repaired = assistantTestHooks.repairGeneratorLoadMinimumText('По вашей нагрузке минимум нужен генератор около 5 кВт с запасом. По расчету вам нужен генератор с запасом от 5 кВт по номиналу.', {
      items: [],
      totalRunningKw: 2.1,
      requiredStartingKw: 3.9,
      requiredNominalKw: 4,
      simultaneousStarting: false,
      calculation: '',
      confidence: 0.82
    });

    expect(repaired).toContain('около 4 кВт');
    expect(repaired).toContain('с запасом от 5 кВт');

    const repairedClass = assistantTestHooks.repairGeneratorLoadMinimumText(ru('\\u041f\\u043e \\u0432\\u0430\\u0448\\u0435\\u0439 \\u043d\\u0430\\u0433\\u0440\\u0443\\u0437\\u043a\\u0435 \\u044f \\u0431\\u044b \\u0441\\u043c\\u043e\\u0442\\u0440\\u0435\\u043b \\u043d\\u0430 \\u043a\\u043b\\u0430\\u0441\\u0441 **5 \\u043a\\u0412\\u0442 \\u043d\\u043e\\u043c\\u0438\\u043d\\u0430\\u043b / 6+ \\u043a\\u0412\\u0442 \\u043c\\u0430\\u043a\\u0441\\u0438\\u043c\\u0443\\u043c**.'), {
      items: [],
      totalRunningKw: 1.6,
      requiredStartingKw: 3.8,
      requiredNominalKw: 4,
      simultaneousStarting: true,
      calculation: '',
      confidence: 0.82
    });
    expect(repairedClass).toContain('4 кВт');
    expect(repairedClass).not.toContain('5 кВт номинал / 6+');
  });

  it('does not reintroduce reversed power ranges after generator load repair', () => {
    const sanitized = assistantTestHooks.sanitizeVisibleAnswer('Лучше смотреть уже 5–3,5 кВт из-за пускового тока.');
    const repaired = assistantTestHooks.repairGeneratorLoadMinimumText(sanitized, {
      items: [],
      totalRunningKw: 2.1,
      requiredStartingKw: 3.9,
      requiredNominalKw: 3.5,
      simultaneousStarting: false,
      calculation: '',
      confidence: 0.82
    });

    expect(repaired).not.toMatch(/5\s*[-–—]\s*3,5\s*кВт/);
    expect(repaired).not.toMatch(/3,5\s*[-–—]\s*3,5\s*кВт/);
    expect(repaired).toContain('3,5–5 кВт');
  });

  it('collapses duplicate power ranges introduced after generator load repair', () => {
    const repaired = assistantTestHooks.repairGeneratorLoadMinimumText('Для скважинного насоса я бы смотрел 5–5 кВт номинал.', {
      items: [],
      totalRunningKw: 2.1,
      requiredStartingKw: 3.9,
      requiredNominalKw: 4,
      simultaneousStarting: false,
      calculation: '',
      confidence: 0.82
    });

    expect(repaired).not.toMatch(/5\s*[-–—]\s*5\s*кВт/);
    expect(repaired).toContain('5 кВт');
  });

  it('does not rewrite a named generator card power spec while repairing load minimum text', () => {
    const repaired = assistantTestHooks.repairGeneratorLoadMinimumText('По расчёту минимум: 4 кВт номинальной; первым смотрите SUMEC SU7700E 5 кВт — нормальный запас.', {
      items: [],
      totalRunningKw: 2.1,
      requiredStartingKw: 3.9,
      requiredNominalKw: 4,
      simultaneousStarting: false,
      calculation: '',
      confidence: 0.82
    });

    expect(repaired).toContain('минимум: 4 кВт');
    expect(repaired).toContain('SUMEC SU7700E 5 кВт');
    expect(repaired).not.toContain('SUMEC SU7700E 4 кВт');
  });

  it('does not let answer text call the calculated 4 kW class borderline', () => {
    const repaired = assistantTestHooks.repairGeneratorLoadMinimumText('Для вашей нагрузки я бы смотрел от 5 кВт номинала. Модели на 4 кВт здесь уже скорее компромисс, а не уверенный выбор.', {
      items: [],
      totalRunningKw: 1.6,
      requiredStartingKw: 3.2,
      requiredNominalKw: 4,
      simultaneousStarting: false,
      calculation: '',
      confidence: 0.82
    });

    expect(repaired).toContain('4 кВт по номиналу здесь является расчетным минимумом');
    expect(repaired).toContain('4 кВт номинала как расчетный минимум');
    expect(repaired).not.toContain('на грани');
    expect(repaired).not.toContain('компромисс');
  });

  it('does not allow a non-first visible card to be called the first card', () => {
    const repaired = assistantTestHooks.repairAnswerCardText('Wacker Neuson BPS 1550 показан первой карточкой.', [{
      id: 'redverg',
      name: 'Виброплита REDVERG RD-29155 (91 кг)',
      category: 'Виброплиты',
      price: 54_000,
      currency: 'RUB',
      imageUrl: null,
      sourceUrl: null,
      brand: null,
      specs: {},
      reasons: [],
      caveats: []
    }, {
      id: 'bps',
      name: 'Виброплита Wacker Neuson BPS 1550 Gw-c CE (91 кг)',
      category: 'Виброплиты',
      price: 160_000,
      currency: 'RUB',
      imageUrl: null,
      sourceUrl: null,
      brand: null,
      specs: {},
      reasons: [],
      caveats: []
    }], baseTurnPlan());

    expect(repaired).toContain('есть среди карточек');
    expect(repaired).not.toContain('первой карточкой');
  });

  it('uses an estimated pump load before recommending house generators', async () => {
    const products = [
      productWithSpecs('weak', 'Generator gasoline inverter 2.8 kW', 30_000, 'https://example.test/generators/weak', {}),
      productWithSpecs('fit', 'Generator gasoline inverter 3.8 kW', 70_000, 'https://example.test/generators/fit', {})
    ];
    const assistant = new AssistantService(undefined as never, new FakeProducts(products) as never);
    const plan = baseTurnPlan({
      requiredProductTraits: {
        ...baseTurnPlan().requiredProductTraits,
        productIntent: 'generator',
        productRole: 'coreProduct'
      }
    });

    const result = await assistant.selectProductsForTurn(ru('\\u041d\\u0443\\u0436\\u0435\\u043d \\u0433\\u0435\\u043d\\u0435\\u0440\\u0430\\u0442\\u043e\\u0440 \\u0434\\u043b\\u044f \\u0434\\u043e\\u043c\\u0430: \\u0441\\u043a\\u0432\\u0430\\u0436\\u0438\\u043d\\u043d\\u044b\\u0439 \\u043d\\u0430\\u0441\\u043e\\u0441, \\u0445\\u043e\\u043b\\u043e\\u0434\\u0438\\u043b\\u044c\\u043d\\u0438\\u043a \\u0438 \\u0441\\u0432\\u0435\\u0442.'), emptyNeedState(), plan, products);

    expect(result.state.loadProfile?.items.some((item) => item.kind === 'pump' && item.source === 'estimated_average')).toBe(true);
    expect(result.state.loadProfile?.requiredNominalKw).toBeGreaterThanOrEqual(3.5);
    expect(result.visibleProducts.map((item) => item.id)).toEqual(['fit']);
  });

  it('recalculates generator load when explicit pump power appears', async () => {
    const products = [
      productWithSpecs('weak', 'Generator gasoline inverter 2.8 kW', 30_000, 'https://example.test/generators/weak', {}),
      productWithSpecs('fit', 'Generator gasoline inverter 4.0 kW', 80_000, 'https://example.test/generators/fit', {})
    ];
    const assistant = new AssistantService(undefined as never, new FakeProducts(products) as never);
    const plan = baseTurnPlan({
      requiredProductTraits: {
        ...baseTurnPlan().requiredProductTraits,
        productIntent: 'generator',
        productRole: 'coreProduct'
      }
    });

    const result = await assistant.selectProductsForTurn(ru('\\u041d\\u0430\\u0441\\u043e\\u0441 1,1 \\u043a\\u0412\\u0442, \\u043e\\u0431\\u044b\\u0447\\u043d\\u044b\\u0439 \\u0445\\u043e\\u043b\\u043e\\u0434\\u0438\\u043b\\u044c\\u043d\\u0438\\u043a \\u0438 \\u0441\\u0432\\u0435\\u0442 800 \\u0412\\u0442.'), emptyNeedState(), plan, products);

    expect(result.state.loadProfile?.items.find((item) => item.kind === 'pump')?.runningKw).toBe(1.1);
    expect(result.visibleProducts.map((item) => item.id)).toEqual(['fit']);
    expect(result.matchedProducts.map((item) => item.id)).not.toContain('weak');
  });

  it('keeps calculated load above planner power guesses from appliance watts', async () => {
    const products = [
      productWithSpecs('fit', 'Generator gasoline inverter 4.0 kW', 80_000, 'https://example.test/generators/fit', {}),
      productWithSpecs('oversized', 'Generator gasoline inverter 8.0 kW', 120_000, 'https://example.test/generators/oversized', {})
    ];
    const assistant = new AssistantService(undefined as never, new FakeProducts(products) as never);
    const plan = baseTurnPlan({
      requiredProductTraits: {
        ...baseTurnPlan().requiredProductTraits,
        productIntent: 'generator',
        productRole: 'coreProduct',
        budgetMax: 800,
        nominalPowerKwMin: 8,
        nominalPowerKwMax: 8
      }
    });

    const result = await assistant.selectProductsForTurn(ru('\\u041d\\u0430\\u0441\\u043e\\u0441 1,1 \\u043a\\u0412\\u0442, \\u043e\\u0431\\u044b\\u0447\\u043d\\u044b\\u0439 \\u0445\\u043e\\u043b\\u043e\\u0434\\u0438\\u043b\\u044c\\u043d\\u0438\\u043a \\u0438 \\u0441\\u0432\\u0435\\u0442 800 \\u0412\\u0442.'), emptyNeedState(), plan, products);

    expect(result.state.loadProfile?.requiredNominalKw).toBe(4);
    expect(result.state.hardConstraints.nominalPowerKwMin).toBe(4);
    expect(result.state.hardConstraints.budgetMax).toBeUndefined();
    expect(result.visibleProducts.map((item) => item.id)).toEqual(['fit']);
  });

  it('does not read previous generator constraint text as pump power', async () => {
    const products = [
      productWithSpecs('fit', 'Generator gasoline inverter 4.0 kW', 80_000, 'https://example.test/generators/fit', {}),
      productWithSpecs('oversized', 'Generator gasoline inverter 8.0 kW', 120_000, 'https://example.test/generators/oversized', {})
    ];
    const assistant = new AssistantService(undefined as never, new FakeProducts(products) as never);
    const previousSelection = mergeProductSelectionState(emptyNeedState().selectionState, {
      targetProductClass: 'generator',
      currentProductClass: 'generator',
      hardConstraints: {
        ...emptyNeedState().selectionState.hardConstraints,
        productIntent: 'generator',
        productRole: 'coreProduct',
        nominalPowerKwMin: 4,
        nominalPowerKwMax: 5.5,
        maxPowerKwMin: 3.9
      },
      loadProfile: {
        items: [{
          kind: 'pump',
          name: 'pump',
          count: 1,
          runningKw: 1.1,
          startingKw: 2.9,
          source: 'estimated_average',
          evidence: 'pump estimate'
        }],
        totalRunningKw: 2.1,
        requiredStartingKw: 3.9,
        requiredNominalKw: 4,
        simultaneousStarting: false,
        calculation: '',
        confidence: 0.58
      }
    });
    const state = {
      ...emptyNeedState(),
      selectionState: previousSelection,
      explicitNeeds: [{
        value: ru('\\u0441\\u043a\\u0432\\u0430\\u0436\\u0438\\u043d\\u043d\\u044b\\u0439 \\u043d\\u0430\\u0441\\u043e\\u0441'),
        confidence: 0.9,
        source: 'user' as const,
        evidence: 'test',
        updatedAt: new Date().toISOString()
      }]
    };
    const plan = baseTurnPlan({
      requiredProductTraits: {
        ...baseTurnPlan().requiredProductTraits,
        productIntent: 'generator',
        productRole: 'coreProduct'
      }
    });

    const result = await assistant.selectProductsForTurn(ru('\\u041d\\u0430\\u0441\\u043e\\u0441 1,1 \\u043a\\u0412\\u0442, \\u0445\\u043e\\u043b\\u043e\\u0434\\u0438\\u043b\\u044c\\u043d\\u0438\\u043a \\u0438 \\u0441\\u0432\\u0435\\u0442 800 \\u0412\\u0442.'), state, plan, products);

    expect(result.state.loadProfile?.items.find((item) => item.kind === 'pump')?.runningKw).toBe(1.1);
    expect(result.state.loadProfile?.requiredNominalKw).toBe(4);
    expect(result.visibleProducts.map((item) => item.id)).toEqual(['fit']);
  });

  it('keeps a grounded 30 kW generator need when the buyer gives 25 kW aggregate load with a unit typo', async () => {
    const products = [
      productWithSpecs('weak', 'Generator gasoline 4.0 kW', 30_000, 'https://example.test/generators/weak', {}),
      productWithSpecs('small', 'Generator diesel 20.0 kW', 300_000, 'https://example.test/generators/small', {}),
      productWithSpecs('fit', 'Generator diesel 30.0 kW', 500_000, 'https://example.test/generators/fit', {}),
      productWithSpecs('oversized', 'Generator diesel 50.0 kW', 900_000, 'https://example.test/generators/oversized', {})
    ];
    const assistant = new AssistantService(undefined as never, new FakeProducts(products) as never);
    const previousSelection = mergeProductSelectionState(emptyNeedState().selectionState, {
      targetProductClass: 'generator',
      currentProductClass: 'generator',
      hardConstraints: {
        ...emptyNeedState().selectionState.hardConstraints,
        productIntent: 'generator',
        productRole: 'coreProduct',
        nominalPowerKwMin: 30,
        nominalPowerKwMax: 32,
        provenance: {
          nominalPowerKwMin: 'explicit_user',
          nominalPowerKwMax: 'explicit_user'
        }
      },
      confidence: 0.8
    });
    const plan = baseTurnPlan({
      requiredProductTraits: {
        ...baseTurnPlan().requiredProductTraits,
        productIntent: 'generator',
        productRole: 'coreProduct'
      }
    });

    const result = await assistant.selectProductsForTurn(
      'Суммарная мощность всех работающих приборов 25 кВ одновременно, электрик раскидает их на три фазы, пусковые токи чайник/гриль/микроволновка/противоток бассейна.',
      { ...emptyNeedState(), selectionState: previousSelection },
      plan,
      products
    );

    expect(result.state.loadProfile?.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'aggregate_load', runningKw: 25, source: 'explicit_user' })
    ]));
    expect(result.state.loadProfile?.requiredNominalKw).toBe(25);
    expect(result.state.hardConstraints.nominalPowerKwMin).toBe(30);
    expect(result.visibleProducts.map((item) => item.id)).toEqual(['fit']);
    expect(result.visibleProducts.map((item) => item.id)).not.toContain('oversized');
  });

  it('uses explicit aggregate load instead of estimating one listed appliance', async () => {
    const products = [
      productWithSpecs('weak', 'Generator gasoline 4.0 kW', 30_000, 'https://example.test/generators/weak', {}),
      productWithSpecs('fit', 'Generator diesel 25.0 kW', 450_000, 'https://example.test/generators/fit', {})
    ];
    const assistant = new AssistantService(undefined as never, new FakeProducts(products) as never);
    const plan = baseTurnPlan({
      requiredProductTraits: {
        ...baseTurnPlan().requiredProductTraits,
        productIntent: 'generator',
        productRole: 'coreProduct'
      }
    });

    const result = await assistant.selectProductsForTurn(
      'Общая нагрузка 25 кВт, одновременно работают приборы: чайник, микроволновка и насос бассейна.',
      emptyNeedState(),
      plan,
      products
    );

    expect(result.state.loadProfile?.requiredNominalKw).toBe(25);
    expect(result.state.loadProfile?.items.map((item) => item.kind)).toEqual(['aggregate_load']);
    expect(result.state.hardConstraints.nominalPowerKwMin).toBe(25);
    expect(result.visibleProducts.map((item) => item.id)).toEqual(['fit']);
  });

  it('preserves an earlier raw 30 kW generator request when a follow-up gives lower aggregate load', async () => {
    const products = [
      productWithSpecs('load-only', 'Generator diesel 25.0 kW', 450_000, 'https://example.test/generators/load-only', {}),
      productWithSpecs('requested', 'Generator diesel 30.0 kW', 520_000, 'https://example.test/generators/requested', {})
    ];
    const assistant = new AssistantService(undefined as never, new FakeProducts(products) as never);
    const plan = baseTurnPlan({
      catalogSearchQuery: 'подбор дизельного генератора для помещения',
      requiredProductTraits: {
        ...baseTurnPlan().requiredProductTraits,
        productIntent: 'generator',
        productRole: 'coreProduct'
      }
    });

    const result = await assistant.selectProductsForTurn(
      'Общая нагрузка 25 кВт, электрик раскидает по трем фазам.',
      emptyNeedState(),
      plan,
      products,
      undefined,
      undefined,
      'Нужен генератор на 30 кВт, в помещение, с охлаждением, зимой до -20.'
    );

    expect(result.state.loadProfile?.requiredNominalKw).toBe(25);
    expect(result.state.hardConstraints.nominalPowerKwMin).toBe(30);
    expect(result.visibleProducts.map((item) => item.id)).toEqual(['requested']);
  });

  it('does not treat one estimated appliance as a reliable generator selection basis', async () => {
    const products = [
      productWithSpecs('weak', 'Generator gasoline 4.0 kW', 30_000, 'https://example.test/generators/weak', {}),
      productWithSpecs('big', 'Generator diesel 30.0 kW', 500_000, 'https://example.test/generators/big', {})
    ];
    const assistant = new AssistantService(undefined as never, new FakeProducts(products) as never);
    const plan = baseTurnPlan({
      requiredProductTraits: {
        ...baseTurnPlan().requiredProductTraits,
        productIntent: 'generator',
        productRole: 'coreProduct'
      }
    });

    const result = await assistant.selectProductsForTurn(
      'Пока понятно только что будет чайник, остальную нагрузку электрик считает.',
      emptyNeedState(),
      plan,
      products
    );

    expect(result.state.loadProfile?.items.length).toBe(1);
    expect(result.state.hardConstraints.nominalPowerKwMin).toBeUndefined();
    expect(result.missingQuestions.length).toBeGreaterThan(0);
    expect(result.rejectedProducts.find((item) => item.productId === 'big')?.reason ?? '').not.toContain('above 4');
  });

  it('does not convert a technical electrician remark into lead collection', () => {
    const state = mergeNeedState(emptyNeedState(), heuristicNeedUpdate('Нужен генератор на 30 кВт, в помещение, зимой до -20.'));
    const plan = assistantTestHooks.purchasePlanIfNeeded(baseTurnPlan({
      action: 'collect_lead',
      answerMode: 'leadCollection',
      followUpPolicy: 'collectLead',
      cardPolicy: 'textOnly',
      requiredProductTraits: {
        ...baseTurnPlan().requiredProductTraits,
        productIntent: 'generator',
        productRole: 'coreProduct'
      }
    }), [], [], state, 'Суммарная мощность всех работающих приборов 25 кВт одновременно, электрик раскидает их на три фазы, поняла что без электрика я генератор не выберу');

    expect(plan.leadRequested).toBe(false);
    expect(plan.plan.action).toBe('ask_clarifying_question');
    expect(plan.plan.followUpPolicy).toBe('askClarifyingQuestion');
    expect(plan.plan.answerGuidance).toContain('технический подбор');
  });

  it('sorts budgeted catalog matches from the budget ceiling downward', async () => {
    const products = [
      product('cheap', 'Vibroplita 80 kg', 60_000, 'https://example.test/plates/cheap'),
      product('near-budget', 'Vibroplita 90 kg wheel kit', 95_000, 'https://example.test/plates/near-budget'),
      product('mid', 'Vibroplita 83 kg', 82_000, 'https://example.test/plates/mid')
    ];
    const assistant = new AssistantService(undefined as never, new FakeProducts(products) as never);
    const plan = baseTurnPlan({
      requiredProductTraits: {
        ...baseTurnPlan().requiredProductTraits,
        productIntent: 'plate',
        productRole: 'coreProduct',
        budgetMax: 100_000,
        weightKgMax: 90
      }
    });

    const result = await assistant.selectProductsForTurn('Need vibroplita under 100000 rub, up to 90 kg, easy to transport.', emptyNeedState(), plan, products);

    expect(result.visibleProducts.map((item) => item.id)).toEqual(['cheap', 'mid', 'near-budget']);
  });

  it('keeps previous-selection cards when fresh optional traits would reject them', () => {
    const selectedInverter = productWithSpecs(
      'su4500i',
      ru('\\u0413\\u0435\\u043d\\u0435\\u0440\\u0430\\u0442\\u043e\\u0440 \\u0431\\u0435\\u043d\\u0437\\u0438\\u043d\\u043e\\u0432\\u044b\\u0439 \\u0438\\u043d\\u0432\\u0435\\u0440\\u0442\\u043e\\u0440\\u043d\\u044b\\u0439 SUMEC SU4500i (4,0 \\u043a\\u0412\\u0442)'),
      69_990,
      'https://example.test/su4500i',
      { [ru('\\u0422\\u0438\\u043f')]: ru('\\u0438\\u043d\\u0432\\u0435\\u0440\\u0442\\u043e\\u0440\\u043d\\u044b\\u0439') }
    );
    const selectedConventional = productWithSpecs(
      'su7700',
      ru('\\u0413\\u0435\\u043d\\u0435\\u0440\\u0430\\u0442\\u043e\\u0440 \\u0431\\u0435\\u043d\\u0437\\u0438\\u043d\\u043e\\u0432\\u044b\\u0439 SUMEC SU7700 (5,0 \\u043a\\u0412\\u0442) \\u043e\\u0442\\u043a\\u0440\\u044b\\u0442\\u0430\\u044f \\u0440\\u0430\\u043c\\u0430'),
      36_500,
      'https://example.test/su7700',
      { [ru('\\u041d\\u043e\\u043c\\u0438\\u043d\\u0430\\u043b\\u044c\\u043d\\u0430\\u044f \\u043c\\u043e\\u0449\\u043d\\u043e\\u0441\\u0442\\u044c')]: '5,0 kW' }
    );
    const baseSelection = emptyNeedState().selectionState;
    const state = {
      ...emptyNeedState(),
      selectionState: mergeProductSelectionState(baseSelection, {
        currentProductClass: 'generator',
        targetProductClass: 'generator',
        hardConstraints: {
          ...baseSelection.hardConstraints,
          productIntent: 'generator',
          productRole: 'coreProduct',
          enclosure: 'enclosed',
          conventionalGenerator: true,
          provenance: { enclosure: 'planner', conventionalGenerator: 'planner' }
        }
      })
    };
    const plan = baseTurnPlan({
      searchScope: 'previousSelectionOnly',
      selectedProductIds: ['su4500i', 'su7700'],
      requiredProductTraits: {
        ...baseTurnPlan().requiredProductTraits,
        productIntent: 'generator',
        productRole: 'coreProduct',
        enclosure: 'enclosed',
        conventionalGenerator: true
      },
      selectionState: {
        ...baseTurnPlan().selectionState,
        cardDisplayMode: 'structured_selection'
      }
    });

    const result = assistantTestHooks.selectCardsFromPlan(
      [selectedInverter, selectedConventional] as any,
      state as any,
      ru('\\u0418\\u0437 \\u044d\\u0442\\u0438\\u0445 \\u0434\\u0432\\u0443\\u0445 \\u043e\\u0441\\u0442\\u0430\\u0432\\u044c \\u043e\\u0434\\u0438\\u043d \\u043e\\u0441\\u043d\\u043e\\u0432\\u043d\\u043e\\u0439 \\u0438 \\u043e\\u0434\\u0438\\u043d \\u0437\\u0430\\u043f\\u0430\\u0441\\u043d\\u043e\\u0439.'),
      plan,
      { cardLimit: 2 }
    );

    expect(result.cards.map((card: { id: string }) => card.id)).toEqual(['su4500i', 'su7700']);
    expect(result.diagnostics.selectedRejectedCount).toBe(0);
  });

  it('does not parse appliance power as the budget ceiling', () => {
    expect(parseBudgetMax('Нужен генератор: инструмент до 1,5 кВт. Бюджет до 80 тысяч.')).toBe(80_000);
    expect(parseBudgetMax('Нужен генератор до 1,5 кВт без бюджета.')).toBeUndefined();
  });

  it('parses catalog availability budget phrasing with za and within', () => {
    expect(parseBudgetMax(ru('\\u0427\\u0442\\u043e \\u043d\\u0435\\u0442\\u0443 \\u0437\\u0430 30 000 \\u0433\\u0435\\u043d\\u0435\\u0440\\u0430\\u0442\\u043e\\u0440\\u043e\\u0432 2 \\u043a\\u0432\\u0442 \\u0437\\u0430\\u043a\\u0440\\u044b\\u0442\\u044b\\u0445?'))).toBe(30_000);
    expect(parseBudgetMax(ru('\\u041d\\u0443\\u0436\\u0435\\u043d \\u0437\\u0430\\u043a\\u0440\\u044b\\u0442\\u044b\\u0439 \\u0433\\u0435\\u043d\\u0435\\u0440\\u0430\\u0442\\u043e\\u0440 \\u0432 \\u043f\\u0440\\u0435\\u0434\\u0435\\u043b\\u0430\\u0445 35 000 \\u0440\\u0443\\u0431\\u043b\\u0435\\u0439'))).toBe(35_000);
  });

  it('keeps extra suitable cards in payload when only two should be initially visible', () => {
    const products = Array.from({ length: 12 }, (_, index) =>
      productWithSpecs(`g${index}`, `Generator gasoline ${4 + index / 10} kW`, 50_000 + index, `https://example.test/catalog/generators/g${index}`, {})
    );
    const result = assistantTestHooks.selectCardsFromPlan(
      products as any,
      emptyNeedState(),
      'Подбери один основной генератор и один запасной, остальное можно под Показать еще',
      baseTurnPlan({
        requiredProductTraits: {
          ...baseTurnPlan().requiredProductTraits,
          productIntent: 'generator',
          productRole: 'coreProduct'
        }
      }),
      { cardLimit: 50, respectRequestedCardLimit: false }
    );

    expect(result.cards).toHaveLength(12);
  });

  it('treats occasional tool use separately in generator load selection', async () => {
    const fourKw = productWithSpecs('four-kw', 'Генератор бензиновый 4.0 kW', 72_000, 'https://example.test/generators/four', {
      'Номинальная мощность': '4.0 кВт',
      'Максимальная мощность': '4.4 кВт'
    });
    const fiveKw = productWithSpecs('five-kw', 'Генератор бензиновый 5.0 kW', 79_000, 'https://example.test/generators/five', {
      'Номинальная мощность': '5.0 кВт',
      'Максимальная мощность': '5.5 кВт'
    });
    const oversized = productWithSpecs('oversized', 'Генератор бензиновый ТСС 7.8 kW', 95_000, 'https://example.test/generators/oversized', {
      'Номинальная мощность': '7.8 кВт',
      'Максимальная мощность': '8.0 кВт'
    });
    const assistant = new AssistantService(undefined as never, new FakeProducts([oversized, fiveKw, fourKw] as any) as never);
    const plan = baseTurnPlan({
      requiredProductTraits: {
        ...baseTurnPlan().requiredProductTraits,
        productIntent: 'generator',
        productRole: 'coreProduct',
        fuel: 'gasoline',
        singlePhase220: true
      }
    });

    const result = await assistant.selectProductsForTurn(
      'Нужен бензиновый генератор 220 В для дачи. Одновременно холодильник 300 Вт, обычный поверхностный насос 1 кВт, свет 300 Вт и иногда инструмент до 1,5 кВт. Бюджет до 80 тысяч.',
      emptyNeedState(),
      plan,
      [oversized, fiveKw, fourKw] as any
    );

    expect(result.state.hardConstraints.budgetMax).toBe(80_000);
    expect(result.state.loadProfile?.requiredNominalKw).toBe(4);
    expect(result.state.loadProfile?.items.some((item) => item.kind === 'handheld_tool')).toBe(false);
    expect(result.matchedProducts.map((item) => item.id)).toEqual(['four-kw', 'five-kw']);
    expect(result.matchedProducts.map((item) => item.id)).not.toContain('oversized');
  });

  it('reconciles an LLM load profile that counted occasional tool use as active', async () => {
    const fourKw = productWithSpecs('four-kw', 'Генератор бензиновый 4.0 kW 220 V', 74_000, 'https://example.test/generators/four', {
      'Номинальная мощность': '4.0 кВт',
      'Максимальная мощность': '4.5 кВт'
    });
    const sixKw = productWithSpecs('six-kw', 'Генератор бензиновый 6.0 kW 220 V', 92_000, 'https://example.test/generators/six', {
      'Номинальная мощность': '6.0 кВт',
      'Максимальная мощность': '6.5 кВт'
    });
    const assistant = new AssistantService(undefined as never, new FakeProducts([sixKw, fourKw] as any) as never);
    const message = 'Здравствуйте. Подбираю резервное питание для дома: насос в скважине, холодильник, свет и иногда небольшой инструмент. Хочу понять разумный запас, без покупки слишком мощного генератора.';
    const inflatedLlmSelection = mergeProductSelectionState(emptyNeedState().selectionState, {
      semanticSource: 'llm_need_extraction',
      currentProductClass: 'generator',
      targetProductClass: 'generator',
      hardConstraints: {
        ...emptyNeedState().selectionState.hardConstraints,
        productIntent: 'generator',
        productRole: 'coreProduct',
        nominalPowerKwMin: 6,
        nominalPowerKwMax: 7,
        maxPowerKwMin: 6,
        provenance: {
          nominalPowerKwMin: 'planner',
          nominalPowerKwMax: 'planner',
          maxPowerKwMin: 'planner'
        }
      },
      loadProfile: {
        items: [
          { kind: 'pump', name: 'скважинный насос', count: 1, runningKw: 1.1, startingKw: 4, source: 'estimated_average', evidence: message },
          { kind: 'refrigerator', name: 'холодильник', count: 1, runningKw: 0.25, startingKw: 1.2, source: 'estimated_average', evidence: message },
          { kind: 'lighting', name: 'свет', count: 1, runningKw: 0.2, startingKw: 0.2, source: 'estimated_average', evidence: message },
          { kind: 'handheld_tool', name: 'небольшой инструмент', count: 1, runningKw: 1.5, startingKw: 3, source: 'estimated_average', evidence: message }
        ],
        totalRunningKw: 3.05,
        requiredStartingKw: 5.95,
        requiredNominalKw: 6,
        simultaneousStarting: false,
        calculation: 'LLM counted occasional tool as active',
        confidence: 0.68
      } as any,
      confidence: 0.72
    });
    const plan = baseTurnPlan({
      catalogSearchQuery: message,
      agentDecision: productSelectionAgentDecision(),
      requiredProductTraits: {
        ...baseTurnPlan().requiredProductTraits,
        productIntent: 'generator',
        productRole: 'coreProduct',
        nominalPowerKwMin: 6,
        nominalPowerKwMax: 7,
        maxPowerKwMin: 6
      },
      selectionState: {
        ...baseTurnPlan().selectionState,
        currentProductClass: 'generator',
        targetProductClass: 'generator'
      }
    });

    const result = await assistant.selectProductsForTurn(
      message,
      { ...emptyNeedState(), selectionState: inflatedLlmSelection },
      plan,
      [sixKw, fourKw] as any
    );

    expect(result.state.loadProfile?.items.some((item) => ['handheld_tool', 'tool'].includes(item.kind))).toBe(false);
    expect(result.state.loadProfile?.requiredNominalKw).toBe(3.5);
    expect(result.state.hardConstraints.nominalPowerKwMin).toBe(3.5);
    expect(result.state.hardConstraints.nominalPowerKwMax).toBe(4.5);
    expect(result.visibleProducts[0]?.id).toBe('four-kw');
  });

  it('keeps household vibroplate selection in light affordable models when no weight or budget is given', async () => {
    const heavy = product('heavy', 'Виброплита реверсивная дизельная 900 кг', 2_600_000, 'https://example.test/catalog/vibroplity/heavy/');
    const mid = product('mid', 'Виброплита прямоходная бензиновая 95 кг', 90_000, 'https://example.test/catalog/vibroplity/mid/');
    const light = product('light', 'Виброплита прямоходная бензиновая 65 кг', 60_000, 'https://example.test/catalog/vibroplity/light/');
    const assistant = new AssistantService(undefined as never, new FakeProducts([heavy, mid, light] as any) as never);
    const plan = baseTurnPlan({
      requiredProductTraits: {
        ...baseTurnPlan().requiredProductTraits,
        productIntent: 'plate',
        productRole: 'coreProduct'
      }
    });

    const result = await assistant.selectProductsForTurn(
      'Нужна виброплита для дорожек на участке, что взять?',
      emptyNeedState(),
      plan,
      [heavy, mid, light] as any
    );

    expect(result.state.hardConstraints.weightKgMax).toBe(120);
    expect(result.matchedProducts.map((item) => item.id)).toEqual(['light', 'mid']);
    expect(result.matchedProducts.map((item) => item.id)).not.toContain('heavy');
  });

  it('does not treat light plate cards as matching a single explicit 1000 kg request', async () => {
    const mid = product('mid', 'Виброплита прямоходная бензиновая 95 кг', 90_000, 'https://example.test/catalog/vibroplity/mid/');
    const light = product('light', 'Виброплита прямоходная бензиновая 65 кг', 60_000, 'https://example.test/catalog/vibroplity/light/');
    const assistant = new AssistantService(undefined as never, new FakeProducts([mid, light] as any) as never);
    const plan = baseTurnPlan({
      action: 'recommend_products',
      cardPolicy: 'showProducts',
      requiredProductTraits: {
        ...baseTurnPlan().requiredProductTraits,
        productIntent: 'plate',
        productRole: 'coreProduct'
      },
      selectionState: {
        ...baseTurnPlan().selectionState,
        currentProductClass: 'plate',
        targetProductClass: 'plate',
        shouldShowCards: true,
        selectionConfidence: 0.8
      }
    });

    const result = await assistant.selectProductsForTurn(
      'Нужна виброплита примерно 1000 кг. Есть такие или что вместо нее смотреть?',
      emptyNeedState(),
      plan,
      [mid, light] as any
    );

    expect(result.state.hardConstraints.weightKgMin).toBe(800);
    expect(result.state.hardConstraints.weightKgMax).toBe(1200);
    expect(result.visibleProducts).toEqual([]);
    expect(result.matchedProducts).toEqual([]);
  });

  it('keeps closest heavy plate cards as primary options for a large single weight target', async () => {
    const dpu130 = productWithSpecs('dpu130', 'Vibroplita reversivnaya dizelnaya Wacker Neuson DPU 130 (1185 kg)', 3_500_000, 'https://example.test/catalog/vibroplity/dpu-130/', {
      'rabochaya massa, kg': '1185'
    });
    const dpu110 = productWithSpecs('dpu110', 'Vibroplita reversivnaya dizelnaya Wacker Neuson DPU 110 Lem 970 (830 kg)', 2_800_000, 'https://example.test/catalog/vibroplity/dpu-110/', {
      'rabochaya massa, kg': '830'
    });
    const mid = productWithSpecs('mid', 'Vibroplita reversivnaya dizelnaya Wacker Neuson DPU 6555 (530 kg)', 1_499_000, 'https://example.test/catalog/vibroplity/dpu-6555/', {
      'rabochaya massa, kg': '530'
    });
    const light = productWithSpecs('light', 'Vibroplita pryamokhodnaya benzinovaya 95 kg', 90_000, 'https://example.test/catalog/vibroplity/light/', {
      'rabochaya massa, kg': '95'
    });
    const assistant = new AssistantService(undefined as never, new FakeProducts([mid, dpu130, light, dpu110] as any) as never);
    const plan = baseTurnPlan({
      action: 'recommend_products',
      cardPolicy: 'showProducts',
      requiredProductTraits: {
        ...baseTurnPlan().requiredProductTraits,
        productIntent: 'plate',
        productRole: 'coreProduct'
      },
      selectionState: {
        ...baseTurnPlan().selectionState,
        currentProductClass: 'plate',
        targetProductClass: 'plate',
        shouldShowCards: true,
        selectionConfidence: 0.8
      }
    });

    const result = await assistant.selectProductsForTurn(
      'Need vibroplita about 1000 kg. Any close models?',
      emptyNeedState(),
      plan,
      [mid, dpu130, light, dpu110] as any
    );

    expect(result.state.hardConstraints.weightKgMin).toBe(800);
    expect(result.state.hardConstraints.weightKgMax).toBe(1200);
    expect(result.visibleProducts.map((item) => item.id)).toEqual(expect.arrayContaining(['dpu130', 'dpu110']));
    expect(result.visibleProducts.map((item) => item.id)).not.toContain('mid');
    expect(result.visibleProducts.map((item) => item.id)).not.toContain('light');
  });

  it('promotes supporting heavy plate alternatives to visible cards when exact 1000 kg target has matched products', () => {
    const dpu130 = productWithSpecs('dpu130', 'Vibroplita reversivnaya dizelnaya Wacker Neuson DPU 130 (1185 kg)', 3_500_000, 'https://example.test/catalog/vibroplity/dpu-130/', {
      'rabochaya massa, kg': '1185'
    });
    const dpu110 = productWithSpecs('dpu110', 'Vibroplita reversivnaya dizelnaya Wacker Neuson DPU 110 Lem 970 (830 kg)', 2_800_000, 'https://example.test/catalog/vibroplity/dpu-110/', {
      'rabochaya massa, kg': '830'
    });
    const light = productWithSpecs('light', 'Vibroplita pryamokhodnaya benzinovaya 95 kg', 90_000, 'https://example.test/catalog/vibroplity/light/', {
      'rabochaya massa, kg': '95'
    });
    const state = { ...emptyNeedState(), selectionState: mergeProductSelectionState(emptyProductSelectionState(), {
      currentProductClass: 'plate',
      targetProductClass: 'plate',
      matchedProductIds: ['dpu130', 'dpu110'],
      hardConstraints: {
        ...emptyProductSelectionState().hardConstraints,
        productIntent: 'plate',
        productRole: 'coreProduct',
        weightKgMin: 800,
        weightKgMax: 1200,
        mustHaveTraits: ['heavy reversible plate'],
        excludedClasses: [],
        provenance: {
          weightKgMin: 'explicit_user',
          weightKgMax: 'explicit_user'
        }
      }
    }) };
    const plan = baseTurnPlan({
      action: 'answer_question',
      answerMode: 'short',
      cardPolicy: 'textOnly',
      agentDecision: productSelectionAgentDecision({
        taskType: 'product_selection_with_availability',
        answerTask: 'mixed',
        catalogAction: 'find_matching_products',
        productCardsPolicy: 'supporting_only',
        cardsRole: 'supporting'
      }),
      requiredProductTraits: {
        ...baseTurnPlan().requiredProductTraits,
        productIntent: 'plate',
        productRole: 'coreProduct',
        weightKgMin: 800,
        weightKgMax: 1200
      }
    });
    const result = {
      state: state.selectionState,
      matchedProducts: [dpu110, dpu130],
      visibleProducts: [],
      hiddenProducts: [],
      comparisonProducts: [],
      rejectedProducts: [],
      missingQuestions: [],
      confidence: 0.95,
      trace: {
        canRecommendFromSelection: true,
        source: 'full_catalog_selection_engine'
      }
    } as any;

    expect(assistantTestHooks.shouldPromoteSupportingSelectionCards(plan.agentDecision as any, plan, result, false)).toBe(true);

    const promoted = assistantTestHooks.promotePlanToSelectionCatalogCards(plan, result, 'show supporting alternatives') as any;
    expect(promoted.cardPolicy).toBe('showProducts');
    expect(promoted.selectedProductIds).toEqual(['dpu110', 'dpu130']);

    const cards = assistantTestHooks.cardsFromPlan([light, dpu110, dpu130] as any, state, 'Need vibroplita about 1000 kg. Any close models?', promoted);
    expect(cards.map((card) => card.id)).toEqual(expect.arrayContaining(['dpu110', 'dpu130']));
    expect(cards.map((card) => card.id)).not.toContain('light');
  });

  it('selects nearest heavy plate targets when no card lands inside the practical target window', async () => {
    const nearLow = productWithSpecs('near-low', 'Vibroplita reversivnaya dizelnaya Wacker Neuson DPU 90 (770 kg)', 2_600_000, 'https://example.test/catalog/vibroplity/dpu-90/', {
      'rabochaya massa, kg': '770'
    });
    const nearHigh = productWithSpecs('near-high', 'Vibroplita reversivnaya dizelnaya 1280 kg', 3_900_000, 'https://example.test/catalog/vibroplity/heavy-1280/', {
      'rabochaya massa, kg': '1280'
    });
    const tooSmall = productWithSpecs('too-small', 'Vibroplita reversivnaya dizelnaya 530 kg', 1_500_000, 'https://example.test/catalog/vibroplity/dpu-6555/', {
      'rabochaya massa, kg': '530'
    });
    const light = productWithSpecs('light', 'Vibroplita pryamokhodnaya 95 kg', 90_000, 'https://example.test/catalog/vibroplity/light/', {
      'rabochaya massa, kg': '95'
    });
    const assistant = new AssistantService(undefined as never, new FakeProducts([tooSmall, light, nearLow, nearHigh] as any) as never);
    const plan = baseTurnPlan({
      action: 'recommend_products',
      cardPolicy: 'showProducts',
      requiredProductTraits: {
        ...baseTurnPlan().requiredProductTraits,
        productIntent: 'plate',
        productRole: 'coreProduct'
      },
      selectionState: {
        ...baseTurnPlan().selectionState,
        currentProductClass: 'plate',
        targetProductClass: 'plate',
        shouldShowCards: true,
        selectionConfidence: 0.8
      }
    });

    const result = await assistant.selectProductsForTurn(
      'Need vibroplita about 1000 kg. Any close models?',
      emptyNeedState(),
      plan,
      [tooSmall, light, nearLow, nearHigh] as any
    );

    expect(result.state.hardConstraints.weightKgMin).toBe(800);
    expect(result.state.hardConstraints.weightKgMax).toBe(1200);
    expect(result.visibleProducts.map((item) => item.id)).toEqual(expect.arrayContaining(['near-low', 'near-high']));
    expect(result.visibleProducts.map((item) => item.id)).not.toContain('too-small');
    expect(result.visibleProducts.map((item) => item.id)).not.toContain('light');
  });

  it('lets the latest explicit heavy plate target override exact planner memory weight', async () => {
    const dpu110 = productWithSpecs('dpu110', 'Vibroplita reversivnaya dizelnaya Wacker Neuson DPU 110 Lem 970 (830 kg)', 2_800_000, 'https://example.test/catalog/vibroplity/dpu-110/', {
      'rabochaya massa, kg': '830'
    });
    const light = productWithSpecs('light', 'Vibroplita pryamokhodnaya 95 kg', 90_000, 'https://example.test/catalog/vibroplity/light/', {
      'rabochaya massa, kg': '95'
    });
    const assistant = new AssistantService(undefined as never, new FakeProducts([light, dpu110] as any) as never);
    const state = withSemanticMemory(emptyNeedState(), {
      activeRequirementIds: ['req_productclass_plate', 'req_weight_1000kg'],
      requirements: [
        semanticRequirement({
          id: 'req_productclass_plate',
          kind: 'productClass',
          value: { text: 'vibroplita', productClass: 'plate' },
          strictness: 'strictOnly'
        }),
        semanticRequirement({
          id: 'req_weight_1000kg',
          kind: 'weightKg',
          value: { min: 1000, max: 1000, amount: 1000, unit: 'kg', text: 'about 1000 kg', productClass: 'plate' },
          strictness: 'targetRange'
        })
      ],
      mentionedProducts: [{
        role: 'targetProduct',
        token: 'vibroplita',
        status: 'unresolved',
        evidence: 'Need vibroplita about 1000 kg',
        updatedAt: '2026-05-18T00:00:00.000Z',
        productIds: [],
        normalizedToken: 'plate'
      }],
      selectionPolicy: {
        primaryRequirementIds: ['req_productclass_plate', 'req_weight_1000kg'],
        alternativeMode: 'none',
        explanationRequired: false
      }
    } as any);
    const plan = baseTurnPlan({
      action: 'recommend_products',
      cardPolicy: 'showProducts',
      requiredProductTraits: {
        ...baseTurnPlan().requiredProductTraits,
        productIntent: 'plate',
        productRole: 'coreProduct',
        weightKgMin: 1000,
        weightKgMax: 1000
      },
      selectionState: {
        ...baseTurnPlan().selectionState,
        currentProductClass: 'plate',
        targetProductClass: 'plate',
        shouldShowCards: true,
        selectionConfidence: 0.8
      }
    });

    const result = await assistant.selectProductsForTurn(
      'Need vibroplita about 1000 kg. Any close models?',
      state,
      plan,
      [light, dpu110] as any
    );

    expect(result.state.hardConstraints.weightKgMin).toBe(800);
    expect(result.state.hardConstraints.weightKgMax).toBe(1200);
    expect(result.state.hardConstraints.provenance?.weightKgMin).toBe('explicit_user');
    expect(result.state.hardConstraints.exactModelTokens).toEqual([]);
    expect(result.visibleProducts.map((item) => item.id)).toContain('dpu110');
    expect(result.visibleProducts.map((item) => item.id)).not.toContain('light');
  });

  it('lets the latest explicit generator catalog power override stale load memory', async () => {
    const tiny = productWithSpecs('tiny-light', 'Generator gasoline lighting load 0.2 kW', 12_000, 'https://example.test/catalog/generators/tiny/', {
      nominalPower: '0.2 kW'
    });
    const four = productWithSpecs('four-kw', 'Generator gasoline 4.0 kW home backup', 75_000, 'https://example.test/catalog/generators/four/', {
      nominalPower: '4.0 kW',
      maxPower: '4.5 kW'
    });
    const six = productWithSpecs('six-kw', 'Generator gasoline 6.0 kW larger backup', 120_000, 'https://example.test/catalog/generators/six/', {
      nominalPower: '6.0 kW',
      maxPower: '6.5 kW'
    });
    const assistant = new AssistantService(undefined as never, new FakeProducts([tiny, four, six] as any) as never);
    const state = withSemanticMemory(emptyNeedState(), {
      activeRequirementIds: ['req_product_generator', 'req_load_lighting'],
      requirements: [
        semanticRequirement({
          id: 'req_product_generator',
          kind: 'productClass',
          value: { text: 'generator', productClass: 'generator' },
          strictness: 'strictOnly'
        }),
        semanticRequirement({
          id: 'req_load_lighting',
          kind: 'powerKw',
          value: { min: 0.1, max: 0.2, amount: 0.2, unit: 'kW', text: 'lighting estimated', productClass: 'generator' },
          strictness: 'fallbackAllowed'
        })
      ],
      selectionPolicy: {
        primaryRequirementIds: ['req_product_generator', 'req_load_lighting'],
        alternativeMode: 'none',
        explanationRequired: false
      }
    } as any);
    const plan = baseTurnPlan({
      action: 'recommend_products',
      cardPolicy: 'showProducts',
      requiredProductTraits: {
        ...baseTurnPlan().requiredProductTraits,
        productIntent: 'generator',
        productRole: 'coreProduct',
        nominalPowerKwMin: 0.1,
        nominalPowerKwMax: 0.2
      },
      selectionState: {
        ...baseTurnPlan().selectionState,
        currentProductClass: 'generator',
        targetProductClass: 'generator',
        shouldShowCards: true,
        selectionConfidence: 0.8
      },
      agentDecision: productSelectionAgentDecision({
        taskType: 'product_selection_with_delivery',
        commercialAction: 'explain_manager_required'
      })
    });

    const result = await assistant.selectProductsForTurn(
      'Покажите, какие 4 кВт генераторы сейчас есть, потом доставку посчитаем.',
      state,
      plan,
      [tiny, four, six] as any
    );

    expect(result.state.hardConstraints.nominalPowerKwMin).toBeLessThanOrEqual(4);
    expect(result.state.hardConstraints.nominalPowerKwMax).toBeGreaterThanOrEqual(4);
    expect(result.state.hardConstraints.provenance?.nominalPowerKwMin).toBe('explicit_user');
    expect(result.visibleProducts.map((item) => item.id)).toContain('four-kw');
    expect(result.visibleProducts.map((item) => item.id)).not.toContain('tiny-light');
  });

  it('does not let generic generator target memory suppress 13 kW catalog alternatives', async () => {
    const near12 = productWithSpecs('near-12', 'Generator diesel 12.0 kW 13.0 kW max', 210_000, 'https://example.test/catalog/generators/near-12/', {
      nominalPower: '12.0 kW',
      maxPower: '13.0 kW'
    });
    const near14 = productWithSpecs('near-14', 'Generator gasoline 13.8 kW backup', 260_000, 'https://example.test/catalog/generators/near-14/', {
      nominalPower: '13.8 kW',
      maxPower: '15.0 kW'
    });
    const small = productWithSpecs('small', 'Generator gasoline 4.0 kW', 75_000, 'https://example.test/catalog/generators/small/', {
      nominalPower: '4.0 kW'
    });
    const assistant = new AssistantService(undefined as never, new FakeProducts([small, near12, near14] as any) as never);
    const state = withSemanticMemory(emptyNeedState(), {
      activeRequirementIds: ['req_product_generator', 'req_power_13'],
      requirements: [
        semanticRequirement({
          id: 'req_product_generator',
          kind: 'productClass',
          value: { text: 'generator', productClass: 'generator' },
          strictness: 'strictOnly'
        }),
        semanticRequirement({
          id: 'req_power_13',
          kind: 'powerKw',
          value: { min: 13, max: 13, amount: 13, unit: 'kW', text: 'about 13 kW', productClass: 'generator' },
          strictness: 'targetRange'
        })
      ],
      mentionedProducts: [{
        role: 'targetProduct',
        token: 'генератор',
        status: 'unresolved',
        evidence: 'нужен генератор примерно 13 кВт',
        updatedAt: '2026-05-18T00:00:00.000Z',
        productIds: [],
        normalizedToken: 'generator'
      }],
      selectionPolicy: {
        primaryRequirementIds: ['req_product_generator', 'req_power_13'],
        alternativeMode: 'none',
        explanationRequired: false
      }
    } as any);
    const plan = baseTurnPlan({
      action: 'recommend_products',
      cardPolicy: 'showProducts',
      requiredProductTraits: {
        ...baseTurnPlan().requiredProductTraits,
        productIntent: 'generator',
        productRole: 'coreProduct',
        nominalPowerKwMin: 13,
        nominalPowerKwMax: 13
      },
      selectionState: {
        ...baseTurnPlan().selectionState,
        currentProductClass: 'generator',
        targetProductClass: 'generator',
        shouldShowCards: true,
        selectionConfidence: 0.8
      },
      agentDecision: productSelectionAgentDecision()
    });

    const result = await assistant.selectProductsForTurn(
      'Теперь отдельно нужен генератор примерно 13 кВт. Что есть в каталоге?',
      state,
      plan,
      [small, near12, near14] as any
    );

    expect(result.state.hardConstraints.exactModelTokens).toEqual([]);
    expect(result.state.hardConstraints.nominalPowerKwMin).toBeLessThan(13);
    expect(result.state.hardConstraints.nominalPowerKwMax).toBeGreaterThan(13);
    expect(result.visibleProducts.map((item) => item.id)).toEqual(expect.arrayContaining(['near-12', 'near-14']));
    expect(result.visibleProducts.map((item) => item.id)).not.toContain('small');
  });

  it('detects mixed product catalog plus delivery questions so recovery cannot answer delivery only', () => {
    expect(assistantTestHooks.isMixedCatalogAndCommercialQuestion(
      'Покажите, какие 4 кВт генераторы есть в наличии и что нужно для расчета доставки.',
      {
        answerTask: 'mixed',
        taskType: 'product_selection_with_delivery',
        catalogAction: 'find_matching_products',
        commercialAction: 'explain_manager_required',
        productCardsPolicy: 'show_matching_products',
        mustAnswerNow: ['show generator cards', 'explain delivery verification'],
        activeNeeds: [{ id: 'need_generator', productClass: 'generator', summary: '4 kW generator' }],
        currentFocus: 'generator with delivery',
        cardsRole: 'primary',
        leadAllowed: false,
        leadAllowedReason: 'buyer has not selected a model',
        errorRecoveryPriority: 'show catalog products first',
        validatorWarnings: []
      } as any
    )).toBe(true);
  });

  it('does not turn a generic cutter target phrase into an exact model token', async () => {
    const cutter = productWithSpecs('fs309', 'Gasoline cutter Husqvarna FS 309 max disc 350 mm', 250_000, 'https://example.test/catalog/rezchiki/fs-309/', {
      'max disc, mm': '350'
    });
    const small = productWithSpecs('small', 'Gasoline cutter 300 mm', 150_000, 'https://example.test/catalog/rezchiki/small/', {
      'max disc, mm': '300'
    });
    const assistant = new AssistantService(undefined as never, new FakeProducts([small, cutter] as any) as never);
    const state = withSemanticMemory(emptyNeedState(), {
      activeRequirementIds: ['req_productclass_cutter', 'req_diameter_350mm'],
      requirements: [
        semanticRequirement({
          id: 'req_productclass_cutter',
          kind: 'productClass',
          value: { text: 'gasoline cutter', productClass: 'cutter' },
          strictness: 'strictOnly'
        }),
        semanticRequirement({
          id: 'req_diameter_350mm',
          kind: 'diameterMm',
          value: { min: 350, max: 350, amount: 350, unit: 'mm', text: '350 mm', productClass: 'cutter' },
          strictness: 'targetRange'
        })
      ],
      mentionedProducts: [{
        role: 'targetProduct',
        token: 'gasoline cutter for 350 mm disc',
        status: 'unresolved',
        evidence: 'Need gasoline cutter 350 mm',
        updatedAt: '2026-05-18T00:00:00.000Z',
        productIds: [],
        normalizedToken: 'cutter'
      }],
      selectionPolicy: {
        primaryRequirementIds: ['req_productclass_cutter', 'req_diameter_350mm'],
        alternativeMode: 'none',
        explanationRequired: false
      }
    } as any);
    const plan = baseTurnPlan({
      action: 'recommend_products',
      cardPolicy: 'showProducts',
      requiredProductTraits: {
        ...baseTurnPlan().requiredProductTraits,
        productIntent: 'cutter',
        productRole: 'coreProduct',
        fuel: 'gasoline',
        diameterMmMin: 350,
        diameterMmMax: 350
      },
      selectionState: {
        ...baseTurnPlan().selectionState,
        currentProductClass: 'cutter',
        targetProductClass: 'cutter',
        excludedClasses: ['diamondBlade'],
        shouldShowCards: true,
        selectionConfidence: 0.8
      }
    });

    const result = await assistant.selectProductsForTurn(
      'Need gasoline cutter for 350 mm disc. Show what you have.',
      state,
      plan,
      [small, cutter] as any
    );

    expect(result.state.hardConstraints.exactModelTokens).toEqual([]);
    expect(result.state.hardConstraints.diameterMmMin).toBeLessThanOrEqual(350);
    expect(result.state.hardConstraints.diameterMmMax).toBeGreaterThanOrEqual(350);
    expect(result.visibleProducts.map((item) => item.id)).toContain('fs309');
    expect(result.visibleProducts.map((item) => item.id)).not.toContain('small');
  });

  it('does not turn a Russian generic cutter target with disc size into an exact model token', async () => {
    const cutter = productWithSpecs('gt350', 'Gasoline cutter TSS GT-6508S max disc 350 mm', 250_000, 'https://example.test/catalog/rezchiki/gt-6508s/', {
      'max disc, mm': '350'
    });
    const assistant = new AssistantService(undefined as never, new FakeProducts([cutter] as any) as never);
    const state = withSemanticMemory(emptyNeedState(), {
      activeRequirementIds: ['req_productclass_cutter', 'req_diameter_350mm'],
      requirements: [
        semanticRequirement({
          id: 'req_productclass_cutter',
          kind: 'productClass',
          value: { text: 'бензиновый резчик', productClass: 'cutter' },
          strictness: 'strictOnly'
        }),
        semanticRequirement({
          id: 'req_diameter_350mm',
          kind: 'diameterMm',
          value: { min: 350, max: 350, amount: 350, unit: 'mm', text: 'диск 350 мм', productClass: 'cutter' },
          strictness: 'targetRange'
        })
      ],
      mentionedProducts: [{
        role: 'targetProduct',
        token: 'бензиновый резчик под диск 350 мм',
        status: 'unresolved',
        evidence: 'Нужен бензиновый резчик под диск 350 мм',
        updatedAt: '2026-05-18T00:00:00.000Z',
        productIds: [],
        normalizedToken: 'cutter'
      }],
      selectionPolicy: {
        primaryRequirementIds: ['req_productclass_cutter', 'req_diameter_350mm'],
        alternativeMode: 'none',
        explanationRequired: false
      }
    } as any);
    const plan = baseTurnPlan({
      action: 'recommend_products',
      cardPolicy: 'showProducts',
      requiredProductTraits: {
        ...baseTurnPlan().requiredProductTraits,
        productIntent: 'cutter',
        productRole: 'coreProduct',
        fuel: 'gasoline',
        diameterMmMin: 350,
        diameterMmMax: 350
      },
      selectionState: {
        ...baseTurnPlan().selectionState,
        currentProductClass: 'cutter',
        targetProductClass: 'cutter',
        shouldShowCards: true,
        selectionConfidence: 0.8
      }
    });

    const result = await assistant.selectProductsForTurn(
      'И еще нужен бензиновый резчик под диск 350 мм. Покажите, что есть.',
      state,
      plan,
      [cutter] as any
    );

    expect(result.state.hardConstraints.exactModelTokens).toEqual([]);
    expect(result.visibleProducts.map((item) => item.id)).toEqual(['gt350']);
  });

  it('resets stale generator load when the buyer switches to a vibroplate need', async () => {
    const plate = product('plate', 'Виброплита прямоходная бензиновая 80 кг', 75_000, 'https://example.test/catalog/vibroplity/plate/');
    const generator = productWithSpecs('generator', 'Generator gasoline electric start 3.0 kW', 54_000, 'https://example.test/catalog/generators/generator/', {});
    const assistant = new AssistantService(undefined as never, new FakeProducts([generator, plate] as any) as never);
    const previousSelection = mergeProductSelectionState(emptyNeedState().selectionState, {
      currentProductClass: 'generator',
      targetProductClass: 'generator',
      compatibilityTargetProduct: { kind: 'boiler', evidence: 'котел 150 Вт' },
      hardConstraints: {
        ...emptyNeedState().selectionState.hardConstraints,
        productIntent: 'generator',
        productRole: 'coreProduct',
        nominalPowerKwMin: 2,
        nominalPowerKwMax: 3.5,
        maxPowerKwMin: 1.9,
        provenance: {
          nominalPowerKwMin: 'inferred_from_load',
          nominalPowerKwMax: 'inferred_from_load',
          maxPowerKwMin: 'inferred_from_load'
        }
      },
      loadProfile: {
        items: [{
          kind: 'boiler',
          name: 'котел',
          count: 1,
          runningKw: 0.15,
          startingKw: 0.15,
          source: 'explicit_user',
          evidence: 'котел 150 Вт'
        }],
        totalRunningKw: 0.15,
        requiredNominalKw: 2,
        requiredStartingKw: 0.15,
        simultaneousStarting: false
      }
    });
    const state = { ...emptyNeedState(), selectionState: previousSelection };
    const plan = baseTurnPlan({
      requiredProductTraits: {
        ...baseTurnPlan().requiredProductTraits,
        productIntent: 'plate',
        productRole: 'coreProduct'
      },
      selectionState: {
        ...baseTurnPlan().selectionState,
        currentProductClass: 'plate',
        targetProductClass: 'plate',
        shouldShowCards: true
      }
    });

    const result = await assistant.selectProductsForTurn(
      'Теперь нужна виброплита для дорожки: щебень и песок, 35 квадратов, проходы узкие.',
      state,
      plan,
      [generator, plate] as any
    );

    expect(result.state.targetProductClass).toBe('plate');
    expect(result.state.hardConstraints.productIntent).toBe('plate');
    expect(result.state.loadProfile).toBeUndefined();
    expect(result.visibleProducts.map((item) => item.id)).toEqual(['plate']);
    expect(assistantTestHooks.shouldForceStructuredSelectionCards(
      'Теперь нужна виброплита для дорожки: щебень и песок, 35 квадратов, проходы узкие.',
      { ...plan, agentDecision: productSelectionAgentDecision({ currentFocus: 'plate' }) },
      result
    )).toBe(true);
  });

  it('trusts the LLM planner brand constraint instead of overriding it with phrase checks', async () => {
    const cheap = brandedProduct('cheap', ru('\\u0412\\u0438\\u0431\\u0440\\u043e\\u043f\\u043b\\u0438\\u0442\\u0430 \\u043f\\u0440\\u044f\\u043c\\u043e\\u0445\\u043e\\u0434\\u043d\\u0430\\u044f STEM Techno 50 \\u043a\\u0433'), 'STEM', ru('\\u0412\\u0438\\u0431\\u0440\\u043e\\u043f\\u043b\\u0438\\u0442\\u044b'), 35_500, 'https://example.test/catalog/vibroplity/stem/');
    const expensiveBrand = brandedProduct('husqvarna', ru('\\u0412\\u0438\\u0431\\u0440\\u043e\\u043f\\u043b\\u0438\\u0442\\u0430 Husqvarna LF 50 LAT 56 \\u043a\\u0433'), 'Husqvarna', ru('\\u0412\\u0438\\u0431\\u0440\\u043e\\u043f\\u043b\\u0438\\u0442\\u044b'), 220_000, 'https://example.test/catalog/vibroplity/husqvarna/');
    const assistant = new AssistantService(undefined as never, new FakeProducts([expensiveBrand, cheap] as any) as never);
    const plan = baseTurnPlan({
      requiredProductTraits: {
        ...baseTurnPlan().requiredProductTraits,
        productIntent: 'plate',
        productRole: 'coreProduct'
      },
      selectionState: {
        ...baseTurnPlan().selectionState,
        targetProductClass: 'plate',
        currentProductClass: 'plate',
        brandConstraint: 'Husqvarna',
        rankingPreference: 'premium'
      }
    });

    const result = await assistant.selectProductsForTurn(
      ru('\\u041d\\u0443\\u0436\\u043d\\u0430 \\u0432\\u0438\\u0431\\u0440\\u043e\\u043f\\u043b\\u0438\\u0442\\u0430 \\u0434\\u043b\\u044f \\u0434\\u043e\\u0440\\u043e\\u0436\\u0435\\u043a \\u043d\\u0430 \\u0443\\u0447\\u0430\\u0441\\u0442\\u043a\\u0435, \\u0447\\u0442\\u043e \\u0432\\u0437\\u044f\\u0442\\u044c?'),
      emptyNeedState(),
      plan,
      [expensiveBrand, cheap] as any
    );

    expect(result.state.hardConstraints.brandConstraint).toBe('Husqvarna');
    expect(result.state.rankingPreference).toBe('cheapest');
    expect(result.matchedProducts.map((item) => item.id)).toEqual(['husqvarna']);
  });

  it('answers contact handling directly when a handoff turn already contains a contact', () => {
    const answer = assistantTestHooks.deterministicLeadCollectionAnswer([], null, {
      hasProvidedContact: true,
      asksContactHandling: true
    });

    expect(answer).toContain(ru('\\u041a\\u043e\\u043d\\u0442\\u0430\\u043a\\u0442 \\u0432 \\u0441\\u043e\\u043e\\u0431\\u0449\\u0435\\u043d\\u0438\\u0438 \\u0432\\u0438\\u0436\\u0443'));
    expect(answer).toContain(ru('\\u0437\\u0430\\u044f\\u0432\\u043a\\u0430 \\u0430\\u0432\\u0442\\u043e\\u043c\\u0430\\u0442\\u0438\\u0447\\u0435\\u0441\\u043a\\u0438 \\u043d\\u0435 \\u0441\\u043e\\u0437\\u0434\\u0430\\u043d\\u0430'));
    expect(answer).toContain(ru('\\u0437\\u0430\\u043f\\u043e\\u043b\\u043d\\u0438\\u0442\\u0435 \\u0444\\u043e\\u0440\\u043c\\u0443'));
  });

  it('does not force the lead form after an automatic chat lead is created', () => {
    const answer = assistantTestHooks.deterministicLeadCollectionAnswer([], null, {
      hasProvidedContact: true,
      asksContactHandling: true,
      autoLead: { created: true, emailStatus: 'sent_email' }
    });

    expect(answer).toContain('заявку сформировал');
    expect(answer).toContain('кратким содержанием диалога');
    expect(answer).not.toContain('заполните форму');
  });

  it('keeps an exact single power request exact when planner tries to broaden it', () => {
    const message = 'Есть в наличии ТСС 10 кВт бензин?';
    const plan = baseTurnPlan({
      agentDecision: productSelectionAgentDecision({
        taskType: 'product_selection_with_availability',
        commercialAction: 'explain_manager_required'
      }),
      catalogSearchQuery: 'ТСС бензиновый генератор около 10 кВт, варианты 8-12 кВт',
      requiredProductTraits: {
        ...baseTurnPlan().requiredProductTraits,
        productIntent: 'generator',
        productRole: 'coreProduct',
        fuel: 'gasoline',
        startType: 'any',
        enclosure: 'any',
        nominalPowerKwMin: 8,
        nominalPowerKwMax: 12
      },
      selectionState: {
        ...baseTurnPlan().selectionState,
        currentProductClass: 'generator',
        targetProductClass: 'generator',
        brandConstraint: 'ТСС',
        mustHaveTraits: ['ТСС', 'бензин', '10 кВт'],
        shouldShowCards: true
      }
    });
    const current = emptyProductSelectionState();
    const profile = assistantTestHooks.buildProductFitProfile(
      { ...emptyNeedState(), selectionState: current },
      message,
      plan.catalogSearchQuery,
      plan.requiredProductTraits
    );

    const next = assistantTestHooks.explicitCriteriaFromTurn(current, message, message, plan, profile, message);
    const hard = next.hardConstraints!;

    expect(hard.nominalPowerKwMin).toBe(10);
    expect(hard.nominalPowerKwMax).toBe(10);
    expect(hard.provenance?.nominalPowerKwMin).toBe('explicit_user');
    expect(hard.provenance?.nominalPowerKwMax).toBe('explicit_user');
  });

  it('puts exact power catalog matches ahead of cheaper nearby alternatives', async () => {
    const message = 'Есть в наличии ТСС 10 кВт бензин?';
    const near8 = productWithSpecs('tss-8', 'Генератор бензиновый ТСС SGG 9000ELA (8,0 кВт)', 95_059, 'https://example.test/tss-8', {
      'производитель оборудования': 'ТСС',
      'вид топлива': 'бензиновые',
      'мощность номинальная при 220 в, квт': '8',
      'max. мощность, квт': '8.5'
    });
    const exact10 = productWithSpecs('tss-10', 'Генератор бензиновый ТСС SGG 10000EHA (10,0 кВт)', 213_941, 'https://example.test/tss-10', {
      'производитель оборудования': 'ТСС',
      'вид топлива': 'бензиновые',
      'мощность номинальная при 220 в, квт': '10',
      'max. мощность, квт': '11'
    });
    const assistant = new AssistantService(undefined as never, new FakeProducts([near8, exact10] as any) as never);
    const plan = baseTurnPlan({
      agentDecision: productSelectionAgentDecision({
        taskType: 'product_selection_with_availability',
        commercialAction: 'explain_manager_required'
      }),
      catalogSearchQuery: 'ТСС бензиновый генератор около 10 кВт, варианты 8-12 кВт',
      requiredProductTraits: {
        ...baseTurnPlan().requiredProductTraits,
        productIntent: 'generator',
        productRole: 'coreProduct',
        fuel: 'gasoline',
        startType: 'any',
        enclosure: 'any',
        nominalPowerKwMin: 8,
        nominalPowerKwMax: 12
      },
      selectionState: {
        ...baseTurnPlan().selectionState,
        currentProductClass: 'generator',
        targetProductClass: 'generator',
        brandConstraint: 'ТСС',
        mustHaveTraits: ['ТСС', 'бензин', '10 кВт'],
        shouldShowCards: true
      }
    });

    const result = await assistant.selectProductsForTurn(message, emptyNeedState(), plan, [near8, exact10] as any);

    expect(result.matchedProducts.map((item) => item.id)).toEqual(['tss-10']);
    expect(result.visibleProducts.map((item) => item.id)).toEqual(['tss-10']);
  });

  it('does not treat a single requested generator power as a max-only range in recovered state', () => {
    const message = ru('\\u0415\\u0441\\u0442\\u044c \\u0432 \\u043d\\u0430\\u043b\\u0438\\u0447\\u0438\\u0438 \\u0422\\u0421\\u0421 10 \\u043a\\u0412\\u0442 \\u0431\\u0435\\u043d\\u0437\\u0438\\u043d?');
    const low2 = productWithSpecs('tss-2', ru('\\u0413\\u0435\\u043d\\u0435\\u0440\\u0430\\u0442\\u043e\\u0440 \\u0431\\u0435\\u043d\\u0437\\u0438\\u043d\\u043e\\u0432\\u044b\\u0439 \\u0422\\u0421\\u0421 SGG 2000N (2,0 \\u043a\\u0412\\u0442)'), 24_687, 'https://example.test/tss-2', {
      [ru('\\u043f\\u0440\\u043e\\u0438\\u0437\\u0432\\u043e\\u0434\\u0438\\u0442\\u0435\\u043b\\u044c \\u043e\\u0431\\u043e\\u0440\\u0443\\u0434\\u043e\\u0432\\u0430\\u043d\\u0438\\u044f')]: ru('\\u0422\\u0421\\u0421'),
      [ru('\\u0432\\u0438\\u0434 \\u0442\\u043e\\u043f\\u043b\\u0438\\u0432\\u0430')]: ru('\\u0431\\u0435\\u043d\\u0437\\u0438\\u043d\\u043e\\u0432\\u044b\\u0435'),
      [ru('\\u043c\\u043e\\u0449\\u043d\\u043e\\u0441\\u0442\\u044c \\u043d\\u043e\\u043c\\u0438\\u043d\\u0430\\u043b\\u044c\\u043d\\u0430\\u044f \\u043f\\u0440\\u0438 220 \\u0432, \\u043a\\u0432\\u0442')]: '2'
    });
    const exact10 = productWithSpecs('tss-10', ru('\\u0413\\u0435\\u043d\\u0435\\u0440\\u0430\\u0442\\u043e\\u0440 \\u0431\\u0435\\u043d\\u0437\\u0438\\u043d\\u043e\\u0432\\u044b\\u0439 \\u0422\\u0421\\u0421 SGG 10000EHA (10,0 \\u043a\\u0412\\u0442)'), 213_941, 'https://example.test/tss-10', {
      [ru('\\u043f\\u0440\\u043e\\u0438\\u0437\\u0432\\u043e\\u0434\\u0438\\u0442\\u0435\\u043b\\u044c \\u043e\\u0431\\u043e\\u0440\\u0443\\u0434\\u043e\\u0432\\u0430\\u043d\\u0438\\u044f')]: ru('\\u0422\\u0421\\u0421'),
      [ru('\\u0432\\u0438\\u0434 \\u0442\\u043e\\u043f\\u043b\\u0438\\u0432\\u0430')]: ru('\\u0431\\u0435\\u043d\\u0437\\u0438\\u043d\\u043e\\u0432\\u044b\\u0435'),
      [ru('\\u043c\\u043e\\u0449\\u043d\\u043e\\u0441\\u0442\\u044c \\u043d\\u043e\\u043c\\u0438\\u043d\\u0430\\u043b\\u044c\\u043d\\u0430\\u044f \\u043f\\u0440\\u0438 220 \\u0432, \\u043a\\u0432\\u0442')]: '10'
    });
    const selectionState = mergeProductSelectionState(emptyProductSelectionState(), {
      semanticSource: 'llm_need_extraction',
      currentProductClass: 'generator',
      targetProductClass: 'generator',
      hardConstraints: {
        ...emptyProductSelectionState().hardConstraints,
        productIntent: 'generator',
        productRole: 'coreProduct',
        fuel: 'gasoline',
        brandConstraint: ru('\\u0422\\u0421\\u0421'),
        nominalPowerKwMax: 10,
        mustHaveTraits: [ru('\\u0422\\u0421\\u0421'), ru('\\u0431\\u0435\\u043d\\u0437\\u0438\\u043d'), ru('\\u043e\\u043a\\u043e\\u043b\\u043e 10 \\u043a\\u0412\\u0442')],
        excludedClasses: [],
        exactModelTokens: [],
        provenance: { nominalPowerKwMax: 'planner' }
      }
    });
    const profile = assistantTestHooks.buildProductFitProfile({ ...emptyNeedState(), selectionState }, message);

    expect(assistantTestHooks.productFitPenalty(low2 as any, profile)).toBeLessThanOrEqual(-140);
    expect(assistantTestHooks.productFitPenalty(exact10 as any, profile)).toBe(0);
  });

  it('does not accept a planner conventional-generator hard constraint without evidence', () => {
    const message = 'Нет, просто покажите варианты';
    const plan = baseTurnPlan({
      agentDecision: productSelectionAgentDecision({
        taskType: 'product_selection_with_availability'
      }),
      catalogSearchQuery: 'бензиновый генератор ТСС 8-10 кВт, 220 В, однофазный',
      requiredProductTraits: {
        ...baseTurnPlan().requiredProductTraits,
        productIntent: 'generator',
        productRole: 'coreProduct',
        fuel: 'gasoline',
        startType: 'any',
        enclosure: 'any',
        conventionalGenerator: true,
        singlePhase220: true,
        nominalPowerKwMin: 8,
        nominalPowerKwMax: 10
      },
      selectionState: {
        ...baseTurnPlan().selectionState,
        currentProductClass: 'generator',
        targetProductClass: 'generator',
        brandConstraint: 'ТСС',
        mustHaveTraits: ['ТСС', 'бензин', '220 В', 'однофазный', '8-10 кВт'],
        shouldShowCards: true
      }
    });
    const current = emptyProductSelectionState();
    const profile = assistantTestHooks.buildProductFitProfile(
      { ...emptyNeedState(), selectionState: current },
      message,
      plan.catalogSearchQuery,
      plan.requiredProductTraits
    );

    const next = assistantTestHooks.explicitCriteriaFromTurn(current, message, message, plan, profile, message);
    const hard = next.hardConstraints!;

    expect(hard.conventionalGenerator).toBeUndefined();
    expect(hard.provenance?.conventionalGenerator).toBeUndefined();
  });

  it('does not append duplicate manager/logistics verification text', () => {
    const answer = 'Доставку до Ейска можно посчитать, но итог по доставке и срокам проверит менеджер/логистика.';
    const result = assistantTestHooks.ensureCommercialManagerVerification(answer, {
      taskType: 'product_selection_with_delivery',
      commercialAction: 'explain_manager_required'
    } as any);

    expect(result).toContain('Доставку и условия посчитаю по адресу через логистику.');
    expect(result).not.toMatch(/менеджер/iu);
  });

  it('appends commercial verification in first person, not as a third-person manager', () => {
    const result = assistantTestHooks.ensureCommercialManagerVerification('BISON BS3250i в каталоге вижу как близкий вариант.', {
      taskType: 'pure_availability',
      commercialAction: 'explain_manager_required'
    } as any);

    expect(result).toContain('Актуальный склад и возможность отгрузки сверю перед оформлением.');
    expect(result).not.toMatch(/должен подтвердить менеджер|проверяет менеджер/iu);
  });

  it('cleans stale third-person manager verification from visible answers', () => {
    const cleaned = assistantTestHooks.sanitizeVisibleAnswer(
      'Живое складское наличие и условия проверяет менеджер. Точное наличие и возможность отгрузки должен подтвердить менеджер по актуальному складу.'
    );

    expect(cleaned).toBe('Актуальный склад и возможность отгрузки сверю перед оформлением.');
    expect(cleaned).not.toMatch(/менеджер/iu);
  });

  it('cleans third-person manager role from order process wording', () => {
    const cleaned = assistantTestHooks.sanitizeVisibleAnswer(
      'Если всё устраивает — дальше уже оформляем через менеджера.'
    );

    expect(cleaned).toBe('Если всё устраивает — дальше оформляем заказ.');
    expect(cleaned).not.toMatch(/через\s+менеджер/iu);
  });

  it('does not treat a non-restrictive brand note as a hard brand', async () => {
    const generator = productWithSpecs('bison-5', 'Generator gasoline BISON BS6500EP 5.0 kW 230 V single phase', 51_500, 'https://example.test/bison', {
      voltage: '230 V',
      nominalPower: '5.0 kW'
    });
    const assistant = new AssistantService(undefined as never, new FakeProducts([generator] as any) as never);
    const plan = baseTurnPlan({
      agentDecision: productSelectionAgentDecision({
        taskType: 'product_selection_with_availability'
      }),
      requiredProductTraits: {
        ...baseTurnPlan().requiredProductTraits,
        productIntent: 'generator',
        productRole: 'coreProduct',
        singlePhase220: true,
        nominalPowerKwMin: 4,
        nominalPowerKwMax: 6
      },
      selectionState: {
        ...baseTurnPlan().selectionState,
        targetProductClass: 'generator',
        brandConstraint: 'brand not important'
      }
    });

    const result = await assistant.selectProductsForTurn('Show cheaper generators 4-6 kW 220 V, brand is not important', emptyNeedState(), plan, [generator] as any);

    expect(result.state.hardConstraints.brandConstraint ?? '').toBe('');
    expect(result.matchedProducts.map((item) => item.id)).toEqual(['bison-5']);
  });

  it('lets exact model lookup bypass stale sizing and conventional-generator constraints', async () => {
    const closeCandidate = productWithSpecs('bison-bs3250i', 'Generator gasoline inverter BISON BS3250i 3.0 kW 230 V single phase', 28_032, 'https://example.test/bison-bs3250i', {
      voltage: '230 V',
      nominalPower: '3.0 kW'
    });
    const assistant = new AssistantService(undefined as never, new FakeProducts([closeCandidate] as any) as never);
    const previousSelection = mergeProductSelectionState(emptyProductSelectionState(), {
      targetProductClass: 'generator',
      hardConstraints: {
        ...emptyProductSelectionState().hardConstraints,
        productIntent: 'generator',
        productRole: 'coreProduct',
        fuel: 'gasoline',
        startType: 'manual',
        enclosure: 'open',
        nominalPowerKwMin: 4,
        nominalPowerKwMax: 6,
        conventionalGenerator: true,
        exactModelTokens: [],
        exactModelTokenRoles: [],
        mustHaveTraits: [],
        excludedClasses: [],
        provenance: {
          nominalPowerKwMin: 'planner',
          nominalPowerKwMax: 'planner',
          fuel: 'planner',
          startType: 'planner',
          enclosure: 'planner',
          conventionalGenerator: 'planner'
        }
      },
      loadProfile: {
        items: [{
          kind: 'pump',
          name: 'pump',
          count: 1,
          runningKw: 0.75,
          startingKw: 2,
          source: 'estimated_average',
          evidence: 'stale previous generator sizing'
        }],
        confidence: 0.77,
        calculation: 'stale previous generator sizing',
        totalRunningKw: 3,
        requiredNominalKw: 4.5,
        requiredStartingKw: 4.3,
        simultaneousStarting: false
      } as any
    });
    const state = { ...emptyNeedState(), selectionState: previousSelection };
    const plan = baseTurnPlan({
      agentDecision: productSelectionAgentDecision({
        taskType: 'pure_availability',
        catalogAction: 'exact_model_lookup',
        productCardsPolicy: 'none'
      }),
      requiredProductTraits: {
        ...baseTurnPlan().requiredProductTraits,
        productIntent: 'generator',
        productRole: 'coreProduct'
      },
      selectionState: {
        ...baseTurnPlan().selectionState,
        targetProductClass: 'generator',
        exactModelConstraint: 'Bison 3250'
      }
    });

    const result = await assistant.selectProductsForTurn('A Bison 3250 available? Maybe I typed the model wrong.', state, plan, [closeCandidate] as any, undefined, undefined, '', {
      forceCatalogVerification: true
    });

    expect(result.trace.exactLookupAlternative).toBe(true);
    expect(result.matchedProducts.map((item) => item.id)).toEqual(['bison-bs3250i']);
  });

  it('renders exact lookup alternatives even when previous generator load is stronger than the model', () => {
    const closeCandidate = productWithSpecs('bison-bs3250i', 'Generator gasoline inverter BISON BS3250i 3.0 kW 230 V single phase', 28_032, 'https://example.test/bison-bs3250i', {
      voltage: '230 V',
      nominalPower: '3.0 kW'
    });
    const staleSelection = mergeProductSelectionState(emptyProductSelectionState(), {
      targetProductClass: 'generator',
      selectedProductIds: ['bison-bs3250i'],
      hardConstraints: {
        ...emptyProductSelectionState().hardConstraints,
        productIntent: 'generator',
        productRole: 'coreProduct',
        fuel: 'gasoline',
        nominalPowerKwMin: 4,
        nominalPowerKwMax: 6,
        singlePhase220: true,
        brandConstraint: 'BISON',
        exactModelConstraint: 'Bison 3250',
        exactModelTokens: ['Bison 3250'],
        mustHaveTraits: [],
        excludedClasses: [],
        provenance: {
          nominalPowerKwMin: 'planner',
          nominalPowerKwMax: 'planner',
          singlePhase220: 'planner',
          brandConstraint: 'planner',
          exactModelConstraint: 'planner'
        }
      },
      loadProfile: {
        items: [{
          kind: 'pump',
          name: 'pump',
          count: 1,
          runningKw: 0.75,
          startingKw: 2,
          source: 'estimated_average',
          evidence: 'stale previous generator sizing'
        }],
        confidence: 0.77,
        calculation: 'stale previous generator sizing',
        totalRunningKw: 3,
        requiredNominalKw: 4.5,
        requiredStartingKw: 4.3,
        simultaneousStarting: false
      } as any
    });
    const state = { ...emptyNeedState(), selectionState: staleSelection };
    const plan = baseTurnPlan({
      action: 'recommend_products',
      cardPolicy: 'showProducts',
      selectedProductIds: ['bison-bs3250i'],
      agentDecision: productSelectionAgentDecision({
        taskType: 'pure_availability',
        catalogAction: 'exact_model_lookup',
        productCardsPolicy: 'supporting_only',
        cardsRole: 'supporting',
        answerTask: 'technical_explanation'
      }),
      requiredProductTraits: {
        ...baseTurnPlan().requiredProductTraits,
        productIntent: 'generator',
        productRole: 'coreProduct'
      },
      selectionState: {
        ...baseTurnPlan().selectionState,
        targetProductClass: 'generator',
        exactModelConstraint: 'Bison 3250',
        shouldShowCards: true
      }
    });

    const result = assistantTestHooks.selectCardsFromPlan(
      [closeCandidate] as any,
      state,
      'A Bison 3250 available? Maybe I typed the model wrong.',
      plan
    );

    expect(result.cards.map((card) => card.id)).toEqual(['bison-bs3250i']);
  });

  it('promotes close exact lookup cards even if the planner labeled the answer as technical text', () => {
    const contract = productSelectionAgentDecision({
      taskType: 'pure_availability',
      answerTask: 'technical_explanation',
      catalogAction: 'verify_catalog_absence',
      productCardsPolicy: 'none',
      cardsRole: 'none'
    });
    const plan = baseTurnPlan({
      action: 'answer_question',
      answerMode: 'detailedFact',
      cardPolicy: 'textOnly',
      agentDecision: contract
    });
    const result = {
      trace: {
        exactLookupAlternative: true,
        canRecommendFromSelection: true
      },
      visibleProducts: [],
      matchedProducts: [{ id: 'bison-bs3250i' }],
      hiddenProducts: [],
      confidence: 0.78,
      state: mergeProductSelectionState(emptyProductSelectionState(), {
        hardConstraints: {
          ...emptyProductSelectionState().hardConstraints,
          productIntent: 'generator',
          exactModelConstraint: 'Bison 3250',
          exactModelTokens: ['Bison 3250'],
          mustHaveTraits: [],
          excludedClasses: []
        }
      })
    } as any;

    expect(assistantTestHooks.shouldPromoteCatalogFactCheckedCards(contract as any, plan, result, false)).toBe(true);
    expect(assistantTestHooks.shouldPromoteCatalogFactCheckedCards(contract as any, plan, result, true)).toBe(false);

    const promoted = assistantTestHooks.promotePlanToSelectionCatalogCards(plan, result, 'show close alternative') as any;
    expect(promoted.selectedProductIds).toEqual(['bison-bs3250i']);
    expect(promoted.cardPolicy).toBe('showProducts');
  });

  it('keeps stale generator memory from blocking a new plate catalog selection', async () => {
    const plate = productWithSpecs('plate-100', ru('\\u0412\\u0438\\u0431\\u0440\\u043e\\u043f\\u043b\\u0438\\u0442\\u0430 TSS VP100 100 \\u043a\\u0433'), 44_000, 'https://example.test/plate-100', {
      weight: ru('100 \\u043a\\u0433')
    });
    const generator = productWithSpecs('generator-15', 'Diesel generator 15 kW 380 V', 500_000, 'https://example.test/generator-15', {
      nominalPower: '15 kW',
      voltage: '380 V'
    });
    const assistant = new AssistantService(undefined as never, new FakeProducts([plate, generator] as any) as never);
    const memory: SemanticMemory = {
      version: 1,
      activeRequirementIds: ['req_generator', 'req_power', 'req_plate', 'req_weight'],
      requirements: [
        semanticRequirement({ id: 'req_generator', kind: 'productClass', value: { text: 'generator', productClass: 'generator' } }),
        semanticRequirement({ id: 'req_power', kind: 'powerKw', value: { min: 15, max: 20 } }),
        semanticRequirement({ id: 'req_plate', kind: 'productClass', value: { text: 'plate', productClass: 'plate' } }),
        semanticRequirement({ id: 'req_weight', kind: 'weightKg', value: { min: 90, max: 120 } })
      ],
      mentionedProducts: [
        { role: 'targetProduct', token: 'Bison 3250', status: 'unresolved', evidence: 'earlier exact lookup', updatedAt: '2026-05-13T00:00:00.000Z', productIds: [], normalizedToken: 'bison3250' }
      ],
      selectionPolicy: {
        primaryRequirementIds: ['req_plate', 'req_weight'],
        alternativeMode: 'none',
        explanationRequired: false
      },
      botCommitments: []
    };
    const state = { ...emptyNeedState(), semanticMemory: memory };
    const plan = baseTurnPlan({
      agentDecision: productSelectionAgentDecision({
        taskType: 'product_selection_with_availability'
      }),
      requiredProductTraits: {
        ...baseTurnPlan().requiredProductTraits,
        productIntent: 'plate',
        productRole: 'coreProduct',
        weightKgMin: 90,
        weightKgMax: 120
      },
      selectionState: {
        ...baseTurnPlan().selectionState,
        targetProductClass: 'generator'
      }
    });

    const result = await assistant.selectProductsForTurn('Show catalog vibratory plates 90-120 kg, preferably not the most expensive.', state, plan, [plate, generator] as any);

    expect(result.state.hardConstraints.productIntent).toBe('plate');
    expect(result.state.hardConstraints.exactModelTokens).toEqual([]);
    expect(result.state.hardConstraints.nominalPowerKwMin).toBeUndefined();
    expect(result.matchedProducts.map((item) => item.id)).toEqual(['plate-100']);
  });

  it('clears stale exact model and load sizing when a new generator catalog power range is explicit', async () => {
    const diesel16 = productWithSpecs('diesel-16', 'Генератор дизельный TSS SDG 16000EHA 16 кВт 380 В', 420_000, 'https://example.test/diesel-16', {
      nominalPower: '16 kW',
      maxPower: '17 kW',
      voltage: '380 V',
      fuel: 'diesel'
    });
    const bison = productWithSpecs('bison-bs3250i', 'Генератор бензиновый инверторный BISON BS3250i 3.0 kW 230 V', 28_032, 'https://example.test/bison', {
      nominalPower: '3.0 kW',
      voltage: '230 V'
    });
    const staleSelection = mergeProductSelectionState(emptyProductSelectionState(), {
      targetProductClass: 'generator',
      hardConstraints: {
        ...emptyProductSelectionState().hardConstraints,
        productIntent: 'generator',
        productRole: 'coreProduct',
        exactModelConstraint: 'Bison 3250',
        exactModelTokens: ['Bison 3250'],
        nominalPowerKwMin: 4,
        nominalPowerKwMax: 6,
        maxPowerKwMin: 4.3,
        singlePhase220: true,
        mustHaveTraits: ['для дачи', '220 В'],
        excludedClasses: [],
        provenance: {
          exactModelConstraint: 'planner',
          nominalPowerKwMin: 'planner',
          nominalPowerKwMax: 'planner',
          maxPowerKwMin: 'inferred_from_load',
          singlePhase220: 'explicit_user'
        }
      },
      loadProfile: {
        items: [{
          kind: 'pump',
          name: 'pump',
          count: 1,
          runningKw: 0.75,
          startingKw: 2,
          source: 'estimated_average',
          evidence: 'stale household pump'
        }],
        confidence: 0.77,
        calculation: 'stale household load',
        totalRunningKw: 3,
        requiredNominalKw: 4.5,
        requiredStartingKw: 4.3,
        simultaneousStarting: false
      } as any
    });
    const assistant = new AssistantService(undefined as never, new FakeProducts([diesel16, bison] as any) as never);
    const message = 'Теперь другая задача: для бригады нужен дизельный генератор 15-20 кВт, 380 В. Что в каталоге есть?';
    const plan = baseTurnPlan({
      catalogSearchQuery: message,
      agentDecision: productSelectionAgentDecision({
        taskType: 'product_selection_with_availability',
        catalogAction: 'find_matching_products',
        productCardsPolicy: 'show_matching_products'
      }),
      requiredProductTraits: {
        ...baseTurnPlan().requiredProductTraits,
        productIntent: 'generator',
        productRole: 'coreProduct',
        fuel: 'diesel',
        singlePhase220: false,
        nominalPowerKwMin: 15,
        nominalPowerKwMax: 20
      },
      selectionState: {
        ...baseTurnPlan().selectionState,
        currentProductClass: 'generator',
        targetProductClass: 'generator',
        mustHaveTraits: ['дизельный', '380 В', '15-20 кВт']
      }
    });

    const result = await assistant.selectProductsForTurn(message, { ...emptyNeedState(), selectionState: staleSelection }, plan, [diesel16, bison] as any);

    expect(result.state.hardConstraints.exactModelConstraint).toBe('');
    expect(result.state.hardConstraints.exactModelTokens).toEqual([]);
    expect(result.state.hardConstraints.singlePhase220).toBe(false);
    expect(result.state.hardConstraints.mustHaveTraits).toEqual(['дизельный', '380 В', '15-20 кВт']);
    expect(result.state.hardConstraints.mustHaveTraits).not.toContain('для дачи');
    expect(result.state.hardConstraints.mustHaveTraits).not.toContain('220 В');
    expect(result.state.hardConstraints.maxPowerKwMin).toBeUndefined();
    expect(result.state.loadProfile).toBeUndefined();
    expect(result.matchedProducts.map((item) => item.id)).toContain('diesel-16');
    expect(result.rejectedProducts.find((item) => item.productId === 'diesel-16')?.reason).toBeUndefined();
  });

  it('lets the latest explicit plate weight range override stale planner traits and generator fuel', async () => {
    const plate83 = productWithSpecs('plate-83', 'Виброплита аккумуляторная Wacker APS1340we 83 кг', 298_060, 'https://example.test/plate-83', {
      weight: '83 кг'
    });
    const plate100 = productWithSpecs('plate-100', 'Виброплита бензиновая ТСС VP100 100 кг', 52_000, 'https://example.test/plate-100', {
      weight: '100 кг'
    });
    const staleSelection = mergeProductSelectionState(emptyProductSelectionState(), {
      targetProductClass: 'plate',
      hardConstraints: {
        ...emptyProductSelectionState().hardConstraints,
        productIntent: 'plate',
        productRole: 'coreProduct',
        fuel: 'diesel',
        weightKgMin: 80,
        weightKgMax: 90,
        mustHaveTraits: ['старый диапазон 80-90 кг'],
        excludedClasses: [],
        provenance: {
          fuel: 'planner',
          weightKgMin: 'planner',
          weightKgMax: 'planner'
        }
      }
    });
    const assistant = new AssistantService(undefined as never, new FakeProducts([plate83, plate100] as any) as never);
    const message = 'Покажите из каталога виброплиты 90-120 кг, желательно не самые дорогие.';
    const plan = baseTurnPlan({
      catalogSearchQuery: message,
      agentDecision: productSelectionAgentDecision({
        taskType: 'product_selection_with_availability',
        catalogAction: 'find_matching_products',
        productCardsPolicy: 'show_matching_products'
      }),
      requiredProductTraits: {
        ...baseTurnPlan().requiredProductTraits,
        productIntent: 'plate',
        productRole: 'coreProduct',
        fuel: 'diesel',
        weightKgMin: 80,
        weightKgMax: 90
      },
      selectionState: {
        ...baseTurnPlan().selectionState,
        currentProductClass: 'plate',
        targetProductClass: 'plate',
        mustHaveTraits: ['виброплита', 'вес 90-120 кг', 'не самый дорогой вариант']
      }
    });

    const result = await assistant.selectProductsForTurn(message, { ...emptyNeedState(), selectionState: staleSelection }, plan, [plate83, plate100] as any);

    expect(result.state.hardConstraints.weightKgMin).toBe(90);
    expect(result.state.hardConstraints.weightKgMax).toBe(120);
    expect(result.state.hardConstraints.fuel).toBeUndefined();
    expect(result.matchedProducts.map((item) => item.id)).toEqual(['plate-100']);
    expect(result.matchedProducts.map((item) => item.id)).not.toContain('plate-83');
  });

  it('uses web verification for technical model comparisons with unverified specs', () => {
    const plan = baseTurnPlan({
      answerMode: 'productRecommendation',
      needsWebSearch: false
    });

    expect(assistantTestHooks.shouldUseWebSearch('Compare TOR KM2800i and FUBAG BS 3300: which is quieter and better THD for a boiler?', plan)).toBe(true);
  });
});
