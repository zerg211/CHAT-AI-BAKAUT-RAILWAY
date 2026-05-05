import { describe, expect, it } from 'vitest';
import { AssistantService, assistantTestHooks } from '../src/ai/assistant.js';
import { emptyNeedState, heuristicNeedUpdate, mergeNeedState, mergeProductSelectionState } from '../src/ai/needState.js';
import { classifyProduct, isCoreEquipment, parseBudgetMax } from '../src/ai/productClassifier.js';
import type { ProductSelectionCriteria } from '../src/shared/types.js';

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

async function rank(message: string, products: ReturnType<typeof product>[]) {
  const assistant = new AssistantService(undefined as never, new FakeProducts(products) as never);
  const state = mergeNeedState(emptyNeedState(), heuristicNeedUpdate(message));
  return {
    state,
    ranked: await assistant.findProducts(message, state)
  };
}

describe('recommendation ranking', () => {
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
      selectionHasEstimatedPump: false,
      cards: cards as any,
      candidates: [shown, unshown],
      cardSourceProducts: [shown, unshown]
    });
    const withoutCards = assistantTestHooks.answerContextProductsForCards({
      answerNeedsFullCatalogContext: false,
      recommendationAnswer: true,
      selectionHasEstimatedPump: false,
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
      selectionHasEstimatedPump: false,
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
        excludedClasses: []
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
      cardPolicy: 'auto',
      selectedProductIds: [],
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
    expect(answer).toContain('Оставьте имя и телефон');
    expect(answer).toContain('Заявку уже созданной не считаю');
  });

  it('treats buyer contact details after a hot selection as lead handoff instead of reopening catalog', () => {
    const state = mergeNeedState(emptyNeedState(), heuristicNeedUpdate('Нужен генератор для дома 5 кВт'));
    const products = [
      brandedProduct('sumec', 'SUMEC SU7700E бензогенератор 6.0 кВт', 'SUMEC', 'Генераторы', 59900, 'https://example.test/sumec'),
      brandedProduct('bison', 'BISON BS6500EP бензогенератор 5.5 кВт', 'BISON', 'Генераторы', 38190, 'https://example.test/bison'),
      brandedProduct('hidden', 'TSS SGG 9000EHNA бензогенератор 8 кВт', 'ТСС', 'Генераторы', 98000, 'https://example.test/hidden')
    ];
    const plan = assistantTestHooks.purchasePlanIfNeeded(baseTurnPlan({
      action: 'answer_question',
      answerMode: 'directAnswer',
      cardPolicy: 'textOnly',
      followUpPolicy: 'auto',
      selectedProductIds: ['sumec', 'bison'],
      catalogSearchQuery: 'SUMEC SU7700E BISON BS6500EP'
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

    expect(assistantTestHooks.shouldUseWebSearch(message, {
      ...plan,
      action: 'answer_question',
      answerMode: 'short',
      cardPolicy: 'auto',
      followUpPolicy: 'auto',
      needsWebSearch: false
    })).toBe(false);
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
    expect(result.missingQuestions.length).toBeGreaterThan(0);
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
    const message = 'Покажи подходящие варианты.';
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
    expect(result.missingQuestions.join(' ')).toContain(ru('\\u043a\\u0430\\u043a\\u0438\\u0435 \\u043f\\u0440\\u0438\\u0431\\u043e\\u0440\\u044b'));
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
    expect(repaired).toContain('от 4 кВт');

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

  it('ignores planner brand constraints for household vibroplates unless the buyer named the brand', async () => {
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

    expect(result.state.hardConstraints.brandConstraint).toBeFalsy();
    expect(result.state.rankingPreference).toBe('cheapest');
    expect(result.matchedProducts.map((item) => item.id)).toEqual(['cheap', 'husqvarna']);
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

  it('uses web verification for technical model comparisons with unverified specs', () => {
    const plan = baseTurnPlan({
      answerMode: 'productRecommendation',
      needsWebSearch: false
    });

    expect(assistantTestHooks.shouldUseWebSearch('Compare TOR KM2800i and FUBAG BS 3300: which is quieter and better THD for a boiler?', plan)).toBe(true);
  });
});
