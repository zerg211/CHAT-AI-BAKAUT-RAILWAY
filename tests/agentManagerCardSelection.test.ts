import { describe, expect, it } from 'vitest';

import {
  assessStrictSelectionRequirements,
  assessVisibleCardReadiness,
  filterGeneratorProductsByLoadProfile,
  gateStrictSelectionRequirements,
  rankCatalogProductsByNumericFit,
  selectProductsForVisibleCards,
  suppressVisibleCardsForReadiness,
  toolRequestProductIntent
} from '../src/ai/agentManagerCardSelection.js';
import type {
  AgentIntentContract,
  AgentSelectionPolicy,
  AnswerContract,
  ToolResult
} from '../src/ai/agentManagerContracts.js';
import type { CustomerNeedState, Product } from '../src/shared/types.js';

function answerContract(selectionReadiness: AnswerContract['selectionReadiness']): AnswerContract {
  return {
    answerText: 'Подходит TSS-WP60L.',
    factsUsed: [],
    questionsAsked: [],
    toolResultIds: [],
    leadAction: 'none',
    riskFlags: [],
    selectionReadiness
  };
}

function cardSelection(intent: 'plate' | 'generator', products: Product[]) {
  return {
    intent,
    products,
    selectedProductIds: products.map((product) => product.id),
    answerMentionedProductIds: products.map((product) => product.id),
    droppedProductIds: [],
    warnings: []
  };
}

function needStateWithBudget(budgetMax?: number, budgetKey = 'budget.max'): CustomerNeedState {
  const budgetConstraint = budgetMax ? [{
    value: `${budgetKey}: ${budgetMax}`,
    evidence: 'userMessage',
    confidence: 1,
    updatedAt: '2026-05-21T00:00:00.000Z'
  }] : [];
  return {
    activeNeeds: [],
    semanticMemory: {
      version: 1,
      activeRequirementIds: [],
      requirements: [],
      mentionedProducts: [],
      selectionPolicy: {
        primaryRequirementIds: [],
        alternativeMode: 'none',
        explanationRequired: false
      },
      botCommitments: []
    },
    explicitNeeds: budgetConstraint,
    implicitNeeds: [],
    constraints: budgetConstraint,
    importantCriteria: [],
    confirmedFacts: budgetConstraint,
    uncertainInferences: [],
    contradictions: [],
    featureSignals: {
      portable: 0,
      homeUse: 0,
      compact: 0,
      lowNoise: 0,
      coldStart: 0,
      professionalDuty: 0,
      budgetSensitive: 0
    },
    selectionState: {
      currentProductClass: 'unknown',
      targetProductClass: 'unknown',
      hardConstraints: {
        productIntent: 'unknown',
        productRole: 'unknown',
        exactModelTokens: [],
        exactModelTokenRoles: [],
        mustHaveTraits: [],
        excludedClasses: [],
        provenance: {}
      },
      softPreferences: {
        productIntent: 'unknown',
        productRole: 'unknown',
        exactModelTokens: [],
        exactModelTokenRoles: [],
        mustHaveTraits: [],
        excludedClasses: [],
        provenance: {}
      },
      unknowns: [],
      conflicts: [],
      selectedProductIds: [],
      matchedProductIds: [],
      comparisonProductIds: [],
      rejectedProducts: [],
      previousCandidateProductIds: [],
      confidence: 0,
      updatedAt: '2026-05-21T00:00:00.000Z'
    },
    lastSummary: budgetMax ? `${budgetKey}: ${budgetMax}` : ''
  };
}

const plate: Product = {
  id: 'plate-1',
  name: 'Виброплита TSS-WP60L 60 кг',
  brand: 'ТСС',
  category: 'Виброплиты',
  price: 65000,
  currency: 'RUB',
  specs: {}
};

const overBudgetPlate: Product = {
  id: 'plate-over-budget',
  name: 'Виброплита TSS-WP60TH 72 кг',
  brand: 'ТСС',
  category: 'Виброплиты',
  price: 79592,
  currency: 'RUB',
  specs: {}
};

const generator: Product = {
  id: 'generator-1',
  name: 'Генератор 5 кВт',
  brand: 'ТСС',
  category: 'Генераторы',
  price: 90000,
  currency: 'RUB',
  specs: {}
};

function generatorWithPower(id: string, powerKw: string): Product {
  return {
    id,
    name: `Generator gasoline ${powerKw} kW`,
    brand: 'TSS',
    category: 'Generators',
    price: 90000,
    currency: 'RUB',
    specs: {
      'Nominal power': `${powerKw} kW`
    }
  };
}

function generatorWithPowerAndVoltage(id: string, powerKw: string, voltage: string): Product {
  return {
    id,
    name: `Generator diesel ${powerKw} kW ${voltage}`,
    brand: 'TSS',
    category: 'Generators',
    price: 90000,
    currency: 'RUB',
    specs: {
      'Nominal power': `${powerKw} kW`,
      voltage
    }
  };
}

function batteryStationWithPower(id: string, powerKw: string): Product {
  return {
    id,
    name: `Battery power station generator ${powerKw} kW`,
    brand: 'APS',
    category: 'Battery power stations generators',
    price: 90000,
    currency: 'RUB',
    sourceUrl: `https://example.test/battery/${id}`,
    specs: {
      'Nominal power': `${powerKw} kW`
    }
  };
}

function batteryStationWithWatts(id: string, watts: number): Product {
  return {
    id,
    name: `Battery power station generator ${watts} W`,
    brand: 'APS',
    category: 'Battery power stations generators',
    price: 90000,
    currency: 'RUB',
    sourceUrl: `https://example.test/battery/${id}`,
    specs: {
      'Nominal power': `${watts} W`
    }
  };
}

function structuredSelectionIntent(
  policy: Partial<AgentSelectionPolicy> = {}
): AgentIntentContract {
  return {
    userMessageSummary: 'structured generator selection',
    dialogueUnderstanding: 'use the typed selection contract',
    nextStepRationale: 'show only the products selected by the answer writer that pass hard facts',
    requiresTools: true,
    toolRequests: [{
      id: 'catalog-search',
      tool: 'catalog.search',
      args: {
        productIntent: 'generator',
        canonicalProductIntent: 'generator',
        query: 'generator'
      },
      rationale: 'ground generator candidates',
      required: true
    }],
    productMentions: [],
    selectionPolicy: {
      targetProductClass: 'generator',
      canonicalProductClass: 'generator',
      needAction: 'continue',
      alternativePolicy: 'same_class_only',
      reusePreviousCards: false,
      maxCards: 4,
      powerSource: 'any',
      phase: 'any',
      requirements: [],
      rationale: 'typed test policy',
      ...policy
    },
    policyRuleIds: [],
    mustNotAskQuestionIds: [],
    riskFlags: []
  };
}

function generatorLoadDerivedConstraintIntent(): AgentIntentContract {
  const intent = structuredSelectionIntent({
    requirements: [{
      id: 'simultaneous-loads',
      kind: 'generator_load_scenario',
      value: true,
      unit: null,
      role: 'hard_constraint',
      strictness: 'strict',
      evidence: 'pump and angle grinder must run at the same time',
      verification: {
        mode: 'typed_tool',
        toolRequestId: 'load-calculation',
        tool: 'calculator.generatorLoad',
        verifier: 'generator_load_profile',
        bindAs: 'nominal_power_min_kw'
      }
    }]
  });
  intent.toolRequests = [{
    id: 'load-calculation',
    tool: 'calculator.generatorLoad',
    args: {
      loads: [{
        name: 'pump and angle grinder',
        count: 1,
        runningKw: 2.6,
        startingKw: 5.5,
        source: 'explicit_user',
        evidence: '1.1 kW + 1.5 kW, simultaneous operation',
        basisKind: 'exact_power',
        basisSignals: ['explicit_power', 'simultaneous_operation_known']
      }],
      simultaneousStarting: false,
      simultaneousStartingKinds: [],
      estimateBasis: 'exact_or_user_provided'
    },
    rationale: 'derive the minimum generator power from the operating condition',
    required: true,
    coversRequirementIds: ['simultaneous-loads']
  }, ...intent.toolRequests];
  return intent;
}

function generatorLoadResult(
  status: ToolResult['status'] = 'ok',
  requiredNominalKw: unknown = 5.5
): ToolResult {
  return {
    requestId: 'load-calculation',
    tool: 'calculator.generatorLoad',
    status,
    payload: { profile: { requiredNominalKw } },
    warnings: []
  };
}

function diamondBlade(id: string, name: string, specs: Record<string, string> = {}): Product {
  return {
    id,
    name,
    brand: 'TEST',
    category: 'Diamond blades',
    price: 9000,
    currency: 'RUB',
    specs
  };
}

function generatorWithPrice(id: string, name: string, price: number): Product {
  return {
    id,
    name,
    brand: name.startsWith('Dinking') ? 'Dinking' : 'TSS',
    category: 'Generators',
    price,
    currency: 'RUB',
    specs: {
      'Nominal power': '7 kW'
    }
  };
}

function plateWithWeight(id: string, weightKg: number): Product {
  return {
    id,
    name: `Виброплита ${weightKg} кг`,
    brand: 'ТСС',
    category: 'Виброплиты',
    price: 60000 + weightKg,
    currency: 'RUB',
    specs: {
      'рабочая масса, кг': String(weightKg)
    }
  };
}

function plateWithNameAndWeight(id: string, name: string, weightKg: number): Product {
  return {
    id,
    name,
    brand: 'Husqvarna',
    category: 'vibroplity',
    price: 120000 + weightKg,
    currency: 'RUB',
    specs: {
      weight: `${weightKg} kg`
    }
  };
}

describe('AgentManager visible card readiness', () => {
  it('keeps non-generator catalog cards when answer selection readiness is not applicable', () => {
    const readiness = assessVisibleCardReadiness({
      cardSelection: cardSelection('plate', [plate]),
      answer: answerContract({
        productClass: 'generator',
        status: 'not_applicable',
        canShowProductCards: false,
        missingFacts: [],
        rationale: 'Запрос относится к виброплите, дополнительные уточнения не нужны.'
      })
    });

    const visible = suppressVisibleCardsForReadiness({
      cardSelection: cardSelection('plate', [plate]),
      readiness
    });

    expect(readiness.status).toBe('ready_for_cards');
    expect(readiness.warnings).toContain('selection_readiness_not_applicable_preserved_cards');
    expect(visible.products).toEqual([plate]);
  });

  it('still blocks generator cards when load basis is unconfirmed', () => {
    const toolResult: ToolResult = {
      requestId: 'load-1',
      tool: 'calculator.generatorLoad',
      status: 'ok',
      payload: {},
      warnings: ['generator_load_unbounded_guess']
    };

    const readiness = assessVisibleCardReadiness({
      cardSelection: cardSelection('generator', [generator]),
      answer: answerContract({
        productClass: 'generator',
        status: 'ready_for_preliminary_cards',
        canShowProductCards: true,
        missingFacts: [],
        rationale: 'Можно показать предварительные варианты.'
      }),
      toolResults: [toolResult]
    });

    const visible = suppressVisibleCardsForReadiness({
      cardSelection: cardSelection('generator', [generator]),
      readiness
    });

    expect(readiness.status).toBe('blocked_by_tool_safety');
    expect(visible.products).toEqual([]);
  });

  it('filters selected non-generator cards by structured budget when in-budget options exist', () => {
    const selection = selectProductsForVisibleCards({
      products: [overBudgetPlate, plate],
      userMessage: 'Бюджет до 70 000, нужна не слишком тяжелая.',
      history: [],
      intent: {
        userMessageSummary: 'buyer narrows plate budget',
        dialogueUnderstanding: 'budget limit for plate',
        nextStepRationale: 'show catalog plates',
        requiresTools: true,
        toolRequests: [{
          id: 'catalog-1',
          tool: 'catalog.search',
          args: { productIntent: 'plate', query: 'виброплита до 70000' },
          rationale: 'find plate compactors',
          required: true
        }],
        mustNotAskQuestionIds: [],
        riskFlags: []
      },
      answerText: 'Подойдут Виброплита TSS-WP60TH 72 кг и Виброплита TSS-WP60L 60 кг.',
      needState: needStateWithBudget(70000)
    });

    expect(selection.products).toEqual([plate]);
    expect(selection.droppedProductIds).toContain('plate-over-budget');
    expect(selection.warnings).toContain('product_cards_filtered_by_budget:1');
  });

  it('orders visible cards by the recommendation order in the answer text', () => {
    const wp70: Product = {
      id: 'wp70',
      name: 'Виброплита прямоходная бензиновая ТСС TSS-WP70TL (72 кг)',
      brand: 'ТСС',
      category: 'Виброплиты',
      price: 38766,
      currency: 'RUB',
      specs: {}
    };
    const stemE: Product = {
      id: 'stem-e',
      name: 'Виброплита прямоходная бензиновая STEM Techno SPC 162E (67 кг)',
      brand: 'STEM Techno',
      category: 'Виброплиты',
      price: 44100,
      currency: 'RUB',
      specs: {}
    };
    const stemEs: Product = {
      id: 'stem-es',
      name: 'Виброплита прямоходная бензиновая STEM Techno SPC 162ES (67 кг)',
      brand: 'STEM Techno',
      category: 'Виброплиты',
      price: 42000,
      currency: 'RUB',
      specs: {}
    };
    const wp60: Product = {
      id: 'wp60',
      name: 'Виброплита прямоходная бензиновая ТСС TSS-WP60L (60 кг)',
      brand: 'ТСС',
      category: 'Виброплиты',
      price: 49907,
      currency: 'RUB',
      specs: {}
    };

    const selection = selectProductsForVisibleCards({
      products: [wp70, stemE, stemEs, wp60],
      userMessage: 'Строго до 60 тысяч, без заявки, где компромисс.',
      history: [],
      intent: {
        userMessageSummary: 'buyer asks for in-budget plate options',
        dialogueUnderstanding: 'budget is strict and cards should match textual recommendation order',
        nextStepRationale: 'show catalog plates under budget',
        requiresTools: true,
        toolRequests: [{
          id: 'catalog-1',
          tool: 'catalog.search',
          args: { productIntent: 'plate', query: 'виброплита до 60000' },
          rationale: 'find plate compactors under budget',
          required: true
        }],
        mustNotAskQuestionIds: [],
        riskFlags: []
      },
      answerText: 'Я бы начинал с ТСС TSS-WP60L. Если нужен запас — TSS-WP70TL. Еще варианты: STEM Techno SPC 162ES или STEM Techno SPC 162E.',
      needState: needStateWithBudget(60000)
    });

    expect(selection.products.map((product) => product.id)).toEqual(['wp60', 'wp70', 'stem-es', 'stem-e']);
  });

  it('does not collapse visible cards to one mentioned product when several catalog products honestly fit', () => {
    const wp60: Product = {
      id: 'wp60',
      name: 'Виброплита ТСС TSS-WP60L (60 кг)',
      brand: 'ТСС',
      category: 'Виброплиты',
      price: 49907,
      currency: 'RUB',
      specs: { 'рабочая масса, кг': '60', 'центробежная сила, кН': '10,5' }
    };
    const masalta: Product = {
      id: 'masalta',
      name: 'Виброплита Masalta MS50-2 (54 кг)',
      brand: 'Masalta',
      category: 'Виброплиты',
      price: 55000,
      currency: 'RUB',
      specs: { 'рабочая масса, кг': '54', 'центробежная сила, кН': '8,2' }
    };
    const zitrek: Product = {
      id: 'zitrek',
      name: 'Виброплита Zitrek z3k60 (57 кг)',
      brand: 'Zitrek',
      category: 'Виброплиты',
      price: 38000,
      currency: 'RUB',
      specs: { 'рабочая масса, кг': '57', 'центробежная сила, кН': '11' }
    };

    const selection = selectProductsForVisibleCards({
      products: [masalta, wp60, zitrek],
      userMessage: 'До 60 тысяч, не самую дешевую, нужна нормальная для дорожек.',
      history: [],
      intent: {
        userMessageSummary: 'buyer asks for vibroplate options under budget',
        dialogueUnderstanding: 'several in-budget plate options can honestly fit; do not collapse to one card',
        nextStepRationale: 'show all honest in-budget matches before compromises',
        requiresTools: true,
        toolRequests: [{
          id: 'catalog-1',
          tool: 'catalog.search',
          args: { productIntent: 'plate', query: 'виброплита до 60000' },
          rationale: 'find all suitable plate compactors',
          required: true
        }],
        mustNotAskQuestionIds: [],
        riskFlags: []
      },
      answerText: 'Из нормальных я бы начал с TSS-WP60L, но есть несколько подходящих вариантов до 60 тысяч.',
      needState: needStateWithBudget(60000)
    });

    expect(selection.products.map((product) => product.id)).toEqual(['wp60', 'masalta', 'zitrek']);
    expect(selection.warnings).not.toContain('product_cards_filtered:2');
  });





  it('filters previous 70000 rub cards when buyer says no options around 70k and asks to narrow to two', () => {
    const wp60: Product = {
      id: 'wp60',
      name: 'Виброплита прямоходная бензиновая ТСС TSS-WP60L (60 кг) 207191',
      brand: 'ТСС',
      category: 'Виброплиты',
      price: 49907,
      currency: 'RUB',
      specs: { 'рабочая масса, кг': '60' }
    };
    const wp70: Product = {
      id: 'wp70',
      name: 'Виброплита прямоходная бензиновая ТСС TSS-WP70TL (72 кг) 207188',
      brand: 'ТСС',
      category: 'Виброплиты',
      price: 38766,
      currency: 'RUB',
      specs: { 'рабочая масса, кг': '72' }
    };
    const wp50: Product = {
      id: 'wp50',
      name: 'Виброплита прямоходная бензиновая ТСС TSS-WP50L (54кг) 207189',
      brand: 'ТСС',
      category: 'Виброплиты',
      price: 43313,
      currency: 'RUB',
      specs: { 'рабочая масса, кг': '54' }
    };
    const masalta70: Product = {
      id: 'masalta70',
      name: 'Виброплита бензиновая Masalta MSR60-2 (62 кг) ВИБ172',
      brand: 'Masalta',
      category: 'Виброплиты',
      price: 70000,
      currency: 'RUB',
      specs: { 'рабочая масса, кг': '62' }
    };

    const selection = selectProductsForVisibleCards({
      products: [wp60, wp70, wp50, masalta70],
      userMessage: 'Теперь без вариантов около 70 тысяч. Сведите к двум: первая легче для переноски, вторая более уверенная под щебень.',
      history: [],
      intent: {
        userMessageSummary: 'buyer rejects around 70000 rub options and wants two plate cards',
        dialogueUnderstanding: 'previous 70000 rub compromise must not remain visible',
        nextStepRationale: 'narrow visible cards to two under the rejected price point',
        requiresTools: false,
        toolRequests: [],
        productMentions: [{ name: 'виброплита', role: 'target_product', productClass: 'plate', evidence: 'plate follow-up' }],
        mustNotAskQuestionIds: [],
        riskFlags: []
      },
      answerText: 'TSS-WP60L — легче для переноски. TSS-WP70TL — более уверенная под щебень.',
      needState: needStateWithBudget(70000),
      allowHistoricalProducts: true
    });

    expect(selection.products.map((product) => product.id)).toEqual(['wp60', 'wp70']);
    expect(selection.droppedProductIds).toContain('masalta70');
  });

  it('keeps a heavier answer-mentioned plate card when buyer asks for one light and one stronger option', () => {
    const light: Product = {
      id: 'wp50',
      name: 'Виброплита прямоходная бензиновая ТСС TSS-WP50L (54кг, колесный комплект) 207189',
      brand: 'ТСС',
      category: 'Виброплиты',
      price: 43313,
      currency: 'RUB',
      specs: { 'рабочая масса, кг': '54' }
    };
    const champion: Product = {
      id: 'champion90',
      name: 'Виброплита прямоходная CHAMPION PC 9045 F (90 кг)',
      brand: 'CHAMPION',
      category: 'Виброплиты',
      price: 52000,
      currency: 'RUB',
      specs: { 'рабочая масса, кг': '90' }
    };

    const selection = selectProductsForVisibleCards({
      products: [light, champion],
      userMessage: 'Одному реально перекатывать и грузить в машину. Оставьте две позиции: более легкую для переноски и более уверенную под щебень. Строго без вариантов за 70 тысяч.',
      history: [],
      intent: {
        userMessageSummary: 'buyer asks for one light plate and one stronger plate under budget',
        dialogueUnderstanding: 'one heavier in-budget plate is allowed as the stronger option, not a hidden mismatch',
        nextStepRationale: 'show both answer-mentioned cards',
        requiresTools: false,
        toolRequests: [],
        productMentions: [{
          name: 'виброплита',
          role: 'target_product',
          productClass: 'plate',
          evidence: 'buyer continues plate selection'
        }],
        mustNotAskQuestionIds: [],
        riskFlags: []
      },
      answerText: 'TSS-WP50L — более удобная для переноски. CHAMPION PC9045F — более уверенная под щебень и песок, но тяжелее.',
      needState: needStateWithBudget(65000),
      allowHistoricalProducts: true
    });

    expect(selection.products.map((product) => product.id)).toEqual(['wp50', 'champion90']);
  });

  it('keeps only the two in-budget TSS cards when buyer rejects a 70000 rub compromise', () => {
    const wp60: Product = {
      id: 'wp60',
      name: 'Виброплита ТСС TSS-WP60L (60 кг) 207191',
      brand: 'ТСС',
      category: 'Виброплиты',
      price: 49907,
      currency: 'RUB',
      specs: { 'рабочая масса, кг': '60' }
    };
    const wp50: Product = {
      id: 'wp50',
      name: 'Виброплита ТСС TSS-WP50L (54кг, колесный комплект) 207189',
      brand: 'ТСС',
      category: 'Виброплиты',
      price: 43313,
      currency: 'RUB',
      specs: { 'рабочая масса, кг': '54' }
    };
    const masalta70: Product = {
      id: 'masalta70',
      name: 'Виброплита бензиновая Masalta MSR60-2 (62 кг) ВИБ172',
      brand: 'Masalta',
      category: 'Виброплиты',
      price: 70000,
      currency: 'RUB',
      specs: { 'рабочая масса, кг': '62' }
    };

    const selection = selectProductsForVisibleCards({
      products: [wp60, wp50, masalta70],
      userMessage: 'Строго в рамках бюджета, без 70 тысяч. Оставьте две модели: одну легче, вторую увереннее под щебень.',
      history: [],
      intent: {
        userMessageSummary: 'buyer rejects the 70000 rub compromise and wants two in-budget plate options',
        dialogueUnderstanding: 'visible cards must match the two named TSS options, not previous over-budget Masalta compromise',
        nextStepRationale: 'show two in-budget cards only',
        requiresTools: false,
        toolRequests: [],
        productMentions: [{
          name: 'виброплита',
          role: 'target_product',
          productClass: 'plate',
          evidence: 'buyer continues plate selection'
        }],
        mustNotAskQuestionIds: [],
        riskFlags: []
      },
      answerText: 'TSS-WP50L — более удобная для переноски. TSS-WP60L — более уверенная под щебень и плитку.',
      needState: needStateWithBudget(65000),
      allowHistoricalProducts: true
    });

    expect(selection.products.map((product) => product.id)).toEqual(['wp50', 'wp60']);
    expect(selection.droppedProductIds).toContain('masalta70');
  });

  it('removes 72 kg plate cards when the buyer explicitly narrows to light 54-60 kg options', () => {
    const wp50: Product = {
      id: 'wp50',
      name: 'Виброплита ТСС TSS-WP50L (54 кг)',
      brand: 'ТСС',
      category: 'Виброплиты',
      price: 43313,
      currency: 'RUB',
      specs: { 'рабочая масса, кг': '54', 'центробежная сила, кН': '8,2' }
    };
    const wp60: Product = {
      id: 'wp60',
      name: 'Виброплита ТСС TSS-WP60L (60 кг)',
      brand: 'ТСС',
      category: 'Виброплиты',
      price: 49907,
      currency: 'RUB',
      specs: { 'рабочая масса, кг': '60', 'центробежная сила, кН': '10,5' }
    };
    const masalta: Product = {
      id: 'masalta',
      name: 'Виброплита Masalta MS50-2 (54 кг)',
      brand: 'Masalta',
      category: 'Виброплиты',
      price: 55000,
      currency: 'RUB',
      specs: { 'рабочая масса, кг': '54', 'центробежная сила, кН': '8,2' }
    };
    const wp70: Product = {
      id: 'wp70',
      name: 'Виброплита ТСС TSS-WP70TL (72 кг)',
      brand: 'ТСС',
      category: 'Виброплиты',
      price: 38766,
      currency: 'RUB',
      specs: { 'рабочая масса, кг': '72', 'центробежная сила, кН': '14' }
    };
    const wp60tl: Product = {
      id: 'wp60tl',
      name: 'Виброплита ТСС TSS-WP60TL (72 кг)',
      brand: 'ТСС',
      category: 'Виброплиты',
      price: 53360,
      currency: 'RUB',
      specs: { 'рабочая масса, кг': '72', 'центробежная сила, кН': '15' }
    };

    const selection = selectProductsForVisibleCards({
      products: [wp70, wp60tl, wp50, wp60, masalta],
      userMessage: 'Оставьте из легких две самые удачные. 72 кг пока уберите из основного выбора, хочу 54-60 кг.',
      history: [],
      intent: {
        userMessageSummary: 'buyer removes 72 kg compromise plates from the main choice',
        dialogueUnderstanding: 'latest narrowing says light 54-60 kg plates only; 72 kg cards would contradict the answer',
        nextStepRationale: 'show light plate cards and drop 72 kg compromises',
        requiresTools: false,
        toolRequests: [],
        productMentions: [{
          name: 'виброплита',
          role: 'target_product',
          productClass: 'plate',
          evidence: 'buyer continues the plate selection'
        }],
        mustNotAskQuestionIds: [],
        riskFlags: []
      },
      answerText: 'Да, из легких я бы оставил так. 72 кг из основного списка убрал, как просили.',
      needState: needStateWithBudget(60000),
      allowHistoricalProducts: true
    });

    expect(selection.products.map((product) => product.id)).toEqual(['wp50', 'wp60']);
    expect(selection.droppedProductIds).toEqual(expect.arrayContaining(['wp70', 'wp60tl']));
    expect(selection.products.some((product) => product.name.includes('72 кг'))).toBe(false);
  });

  it('allows previous visible cards for a narrowing turn without a new catalog tool', () => {
    const selection = selectProductsForVisibleCards({
      products: [plate],
      userMessage: 'Бюджет до 70 тысяч, нужна не слишком тяжелая.',
      history: [],
      intent: {
        userMessageSummary: 'buyer narrows previous plate options',
        dialogueUnderstanding: 'previous visible plate cards remain relevant',
        nextStepRationale: 'continue selection from visible cards',
        requiresTools: false,
        toolRequests: [],
        productMentions: [{
          name: 'виброплита',
          role: 'target_product',
          productClass: 'plate',
          evidence: 'buyer is narrowing the plate selection'
        }],
        mustNotAskQuestionIds: [],
        riskFlags: []
      },
      answerText: 'Из уже показанных вариантов лучше оставить Виброплита TSS-WP60L 60 кг.',
      needState: needStateWithBudget(70000),
      allowHistoricalProducts: true
    });

    expect(selection.products).toEqual([plate]);
    expect(selection.warnings).not.toContain('product_cards_suppressed:no_explicit_catalog_card_tool');
  });

  it('falls back to in-budget cards when the answer only mentions over-budget products', () => {
    const selection = selectProductsForVisibleCards({
      products: [overBudgetPlate, plate],
      userMessage: 'Бюджет до 70 000, покажите подходящие варианты.',
      history: [],
      intent: {
        userMessageSummary: 'buyer asks for catalog options within budget',
        dialogueUnderstanding: 'budget limit is a hard visible-card constraint',
        nextStepRationale: 'show catalog products under budget when possible',
        requiresTools: true,
        toolRequests: [{
          id: 'catalog-1',
          tool: 'catalog.search',
          args: { productIntent: 'plate', query: 'plate compactors under 70000' },
          rationale: 'find plate compactors',
          required: true
        }],
        mustNotAskQuestionIds: [],
        riskFlags: []
      },
      answerText: 'Ближайший вариант — Виброплита TSS-WP60TH 72 кг.',
      needState: needStateWithBudget(70000)
    });

    expect(selection.products).toEqual([plate]);
    expect(selection.answerMentionedProductIds).toEqual(['plate-over-budget']);
    expect(selection.droppedProductIds).toContain('plate-over-budget');
    expect(selection.warnings).toContain('product_cards_filtered_by_budget:1');
  });

  it('keeps selected cards above budget when no in-budget options exist', () => {
    const selection = selectProductsForVisibleCards({
      products: [overBudgetPlate],
      userMessage: 'Бюджет до 70 000, нужна не слишком тяжелая.',
      history: [],
      intent: {
        userMessageSummary: 'buyer narrows plate budget',
        dialogueUnderstanding: 'budget limit for plate',
        nextStepRationale: 'show nearest catalog plates',
        requiresTools: true,
        toolRequests: [{
          id: 'catalog-1',
          tool: 'catalog.search',
          args: { productIntent: 'plate', query: 'виброплита до 70000' },
          rationale: 'find nearest plate compactors',
          required: true
        }],
        mustNotAskQuestionIds: [],
        riskFlags: []
      },
      answerText: 'Ближайший вариант Виброплита TSS-WP60TH 72 кг.',
      needState: needStateWithBudget(70000)
    });

    expect(selection.products).toEqual([overBudgetPlate]);
    expect(selection.warnings).not.toContain('product_cards_filtered_by_budget:1');
  });

  it('accepts budget facts stored with the budget ledger key', () => {
    const selection = selectProductsForVisibleCards({
      products: [overBudgetPlate, plate],
      userMessage: 'Р‘СЋРґР¶РµС‚ 70 000, РЅСѓР¶РЅР° РЅРµ СЃР»РёС€РєРѕРј С‚СЏР¶РµР»Р°СЏ.',
      history: [],
      intent: {
        userMessageSummary: 'buyer narrows plate budget',
        dialogueUnderstanding: 'budget limit for plate',
        nextStepRationale: 'show catalog plates',
        requiresTools: true,
        toolRequests: [{
          id: 'catalog-1',
          tool: 'catalog.search',
          args: { productIntent: 'plate', query: 'РІРёР±СЂРѕРїР»РёС‚Р° РґРѕ 70000' },
          rationale: 'find plate compactors',
          required: true
        }],
        mustNotAskQuestionIds: [],
        riskFlags: []
      },
      answerText: 'РџРѕРґРѕР№РґСѓС‚ Р’РёР±СЂРѕРїР»РёС‚Р° TSS-WP60TH 72 РєРі Рё Р’РёР±СЂРѕРїР»РёС‚Р° TSS-WP60L 60 РєРі.',
      needState: needStateWithBudget(70000, 'budget')
    });

    expect(selection.products).toEqual([plate]);
    expect(selection.droppedProductIds).toContain('plate-over-budget');
    expect(selection.warnings).toContain('product_cards_filtered_by_budget:1');
  });

  it('accepts budget facts stored with the budget_max ledger key', () => {
    const selection = selectProductsForVisibleCards({
      products: [overBudgetPlate, plate],
      userMessage: 'Budget max 70000.',
      history: [],
      intent: {
        userMessageSummary: 'buyer narrows plate budget',
        dialogueUnderstanding: 'budget limit for plate',
        nextStepRationale: 'show catalog plates',
        requiresTools: true,
        toolRequests: [{
          id: 'catalog-1',
          tool: 'catalog.search',
          args: { productIntent: 'plate', query: 'plate budget max 70000' },
          rationale: 'find plate compactors',
          required: true
        }],
        mustNotAskQuestionIds: [],
        riskFlags: []
      },
      answerText: 'Ближайшие варианты — TSS-WP60TH и TSS-WP60L.',
      needState: needStateWithBudget(70000, 'budget_max')
    });

    expect(selection.products).toEqual([plate]);
    expect(selection.droppedProductIds).toContain('plate-over-budget');
    expect(selection.warnings).toContain('product_cards_filtered_by_budget:1');
  });

  it('suppresses generator cards when every same-intent candidate is over structured budget', () => {
    const dinking = generatorWithPrice('dinking-8500', 'Dinking DK8500E Generator 7 kW', 170000);
    const tss = generatorWithPrice('tss-7000', 'TSS SGG 7000E Generator 7 kW', 149000);

    const selection = selectProductsForVisibleCards({
      products: [dinking, tss],
      userMessage: 'Budget max 90000. Need a generator for pump load, but pump power is not confirmed yet.',
      history: [],
      intent: {
        userMessageSummary: 'buyer needs generator with strict max budget',
        dialogueUnderstanding: 'all catalog generator candidates exceed the structured budget',
        nextStepRationale: 'do not show over-budget generator cards',
        requiresTools: true,
        toolRequests: [{
          id: 'catalog-1',
          tool: 'catalog.search',
          args: { productIntent: 'generator', query: 'generator within 90000 budget' },
          rationale: 'find generator candidates',
          required: true
        }],
        mustNotAskQuestionIds: [],
        riskFlags: []
      },
      answerText: 'Dinking DK8500E is above the 90000 budget, so there is no suitable card to show yet.',
      needState: needStateWithBudget(90000, 'budget_max')
    });

    expect(selection.products).toEqual([]);
    expect(selection.selectedProductIds).toEqual([]);
    expect(selection.answerMentionedProductIds).toEqual(['dinking-8500']);
    expect(selection.droppedProductIds).toEqual(expect.arrayContaining(['dinking-8500', 'tss-7000']));
    expect(selection.warnings).toEqual(expect.arrayContaining([
      'product_cards_filtered_by_budget:1',
      'product_cards_suppressed:budget_no_fit'
    ]));

    const readiness = assessVisibleCardReadiness({
      cardSelection: selection,
      answer: answerContract({
        productClass: 'generator',
        status: 'ready_for_preliminary_cards',
        canShowProductCards: true,
        missingFacts: ['pump power'],
        rationale: 'No generator under the structured budget is available.'
      }),
      toolResults: []
    });

    expect(readiness.status).toBe('blocked_by_answer_contract');
    expect(readiness.warnings).toContain('product_cards_suppressed:budget_no_fit');
  });

  it('prefers in-range plate cards over an out-of-range answer-mentioned caveat', () => {
    const heavy = plateWithNameAndWeight('lfe-88', 'Husqvarna LFe 60 LAT 88 kg', 88);
    const medium = plateWithNameAndWeight('lf-67', 'Husqvarna LF 60 LAT 67 kg', 67);
    const light = plateWithNameAndWeight('lf-56', 'Husqvarna LF 50 LAT 56 kg', 56);

    const selection = selectProductsForVisibleCards({
      products: [heavy, medium, light],
      userMessage: 'I need to load it myself into a car, show plate options.',
      history: [],
      intent: {
        userMessageSummary: 'buyer needs a plate compactor that can be self-loaded',
        dialogueUnderstanding: 'self-loading makes plate weight a visible-card constraint',
        nextStepRationale: 'show plate compactors inside the self-loading range',
        requiresTools: true,
        toolRequests: [{
          id: 'catalog-1',
          tool: 'catalog.search',
          args: { productIntent: 'plate', query: 'vibroplita for self-loading' },
          rationale: 'find plate compactors',
          required: true
        }],
        mustNotAskQuestionIds: [],
        riskFlags: []
      },
      answerText: 'Husqvarna LFe 60 LAT 88 kg is not the first choice when one person must load it.',
      needState: needStateWithBudget()
    });

    expect(selection.answerMentionedProductIds).toEqual(['lfe-88']);
    expect(selection.selectedProductIds).toEqual(['lf-67', 'lf-56']);
    expect(selection.selectedProductIds).not.toContain('lfe-88');
    expect(selection.droppedProductIds).toContain('lfe-88');
    expect(selection.warnings).toContain('product_cards_filtered_by_numeric_fit:1');
  });

  it('matches short brand-model plate names so answer text and cards stay aligned', () => {
    const husqvarna = plateWithNameAndWeight('lf-50-lat', 'Виброплита прямоходная бензиновая Husqvarna LF 50 LAT (56 кг)', 56);
    const tss = plateWithNameAndWeight('tss-wp60tl', 'Виброплита прямоходная бензиновая ТСС TSS-WP60TL (72 кг)', 72);
    const unrelated = plateWithNameAndWeight('masalta-ms50', 'Виброплита бензиновая Masalta MS50-2 (54 кг)', 54);

    const selection = selectProductsForVisibleCards({
      products: [husqvarna, tss, unrelated],
      userMessage: 'Нужна виброплита для подготовки основания под плитку.',
      history: [],
      intent: {
        userMessageSummary: 'buyer switched to plate compactor selection',
        dialogueUnderstanding: 'catalog plate candidates are available',
        nextStepRationale: 'show plate compactors named in the answer',
        requiresTools: true,
        toolRequests: [{
          id: 'catalog-1',
          tool: 'catalog.search',
          args: { productIntent: 'plate', query: 'виброплита под плитку' },
          rationale: 'find plate compactors',
          required: true
        }],
        mustNotAskQuestionIds: [],
        riskFlags: []
      },
      answerText: 'Я бы смотрел Husqvarna LF 50 LAT и ТСС TSS-WP60TL.',
      needState: needStateWithBudget()
    });

    expect(selection.answerMentionedProductIds).toEqual(['lf-50-lat', 'tss-wp60tl']);
    expect(selection.selectedProductIds).toEqual(['lf-50-lat', 'tss-wp60tl']);
    expect(selection.droppedProductIds).toContain('masalta-ms50');
  });

  it('keeps generator card ranking for explicit power ranges without regex parsing', () => {
    const fourKw = generatorWithPower('four-kw', '4.0');
    const fiveKw = generatorWithPower('five-kw', '5.0');
    const eightKw = generatorWithPower('eight-kw', '8.0');

    const ranked = rankCatalogProductsByNumericFit({
      products: [eightKw, fourKw, fiveKw],
      intent: 'generator',
      query: 'show gasoline generator 4-6 kw',
      semanticContext: '',
      userMessage: ''
    });

    expect(ranked.map((product) => product.id)).toEqual(['five-kw', 'four-kw', 'eight-kw']);
  });

  it('filters generator cards below the structured load profile requirement', () => {
    const twoKw = generatorWithPower('two-kw', '2.0');
    const threeKw = generatorWithPower('three-kw', '3.4');
    const sevenKw = generatorWithPower('seven-kw', '7.2');

    const filtered = filterGeneratorProductsByLoadProfile([twoKw, sevenKw, threeKw], 7);

    expect(filtered.products.map((product) => product.id)).toEqual(['seven-kw']);
    expect(filtered.droppedProductIds).toEqual(['two-kw', 'three-kw']);
    expect(filtered.warnings).toContain('catalog_products_filtered_by_generator_load:2');
    expect(filtered.warnings).not.toContain('catalog_search_no_generator_load_fit');
  });

  it('marks generator catalog search as empty when no product fits the structured load profile', () => {
    const twoKw = generatorWithPower('two-kw', '2.0');
    const threeKw = generatorWithPower('three-kw', '3.4');

    const filtered = filterGeneratorProductsByLoadProfile([twoKw, threeKw], 7);

    expect(filtered.products).toEqual([]);
    expect(filtered.droppedProductIds).toEqual(['two-kw', 'three-kw']);
    expect(filtered.warnings).toEqual(expect.arrayContaining([
      'catalog_products_filtered_by_generator_load:2',
      'catalog_search_no_generator_load_fit'
    ]));
  });

  it('keeps generator card ranking for exact decimal power requests without regex parsing', () => {
    const fiveKw = generatorWithPower('five-kw', '5.0');
    const fiveHalfKw = generatorWithPower('five-half-kw', '5.5');
    const sevenKw = generatorWithPower('seven-kw', '7.0');

    const ranked = rankCatalogProductsByNumericFit({
      products: [sevenKw, fiveKw, fiveHalfKw],
      intent: 'generator',
      query: 'need generator 5,5 kw',
      semanticContext: '',
      userMessage: ''
    });

    expect(ranked.map((product) => product.id)).toEqual(['five-half-kw', 'five-kw', 'seven-kw']);
  });

  it('normalizes watt power requests before ranking generator cards', () => {
    const pointEightKw = generatorWithPower('point-eight-kw', '0.8');
    const oneEightKw = generatorWithPower('one-eight-kw', '1.8');
    const fiveKw = generatorWithPower('five-kw', '5.0');

    const ranked = rankCatalogProductsByNumericFit({
      products: [fiveKw, oneEightKw, pointEightKw],
      intent: 'generator',
      query: 'need accumulator generator 800 watt',
      semanticContext: '',
      userMessage: ''
    });

    expect(ranked.map((product) => product.id)).toEqual(['point-eight-kw', 'one-eight-kw', 'five-kw']);
  });

  it('normalizes watt product specs against kilowatt range requests', () => {
    const aps600 = batteryStationWithWatts('aps-600', 600);
    const aps800 = batteryStationWithWatts('aps-800', 800);
    const aps1800 = batteryStationWithWatts('aps-1800', 1800);

    const ranked = rankCatalogProductsByNumericFit({
      products: [aps600, aps800, aps1800],
      intent: 'generator',
      query: 'battery generator 1-1.8 kW 220 V',
      semanticContext: '',
      userMessage: ''
    });

    expect(ranked.map((product) => product.id)).toEqual(['aps-1800', 'aps-800', 'aps-600']);
  });

  it('filters visible generator cards to battery stations when the structured need requires battery power', () => {
    const battery = batteryStationWithPower('aps-800', '0.8');
    const gasoline = generatorWithPower('gasoline-1kw', '1.0');
    const diesel = {
      ...generatorWithPower('diesel-24kw', '24.0'),
      name: 'Diesel generator 24 kW'
    };

    const needState = needStateWithBudget();
    needState.selectionState.hardConstraints.mustHaveTraits = ['battery_powered: true'];
    const selection = selectProductsForVisibleCards({
      products: [gasoline, diesel, battery],
      userMessage: 'Need battery power station 220v 800 watt',
      history: [],
      intent: {
        userMessageSummary: 'buyer needs a battery powered generator',
        dialogueUnderstanding: 'power_source: battery, 220v, 800 watt',
        nextStepRationale: 'show only battery power station cards',
        requiresTools: true,
        toolRequests: [{
          id: 'catalog-search',
          tool: 'catalog.search',
          args: { query: 'battery power station 800 watt', limit: 8 },
          rationale: 'find battery stations',
          required: true
        }],
        mustNotAskQuestionIds: [],
        riskFlags: []
      },
      answerText: 'Here are the relevant generator options.',
      needState
    });

    expect(selection.selectedProductIds).toEqual(['aps-800']);
    expect(selection.droppedProductIds).toEqual(expect.arrayContaining(['gasoline-1kw', 'diesel-24kw']));
    expect(selection.warnings).toContain('product_cards_filtered_by_power_source:battery:2');
  });

  it('filters battery station cards below an explicit watt lower bound even when the answer rejects them by name', () => {
    const aps600 = batteryStationWithWatts('aps-600', 600);
    const aps800 = batteryStationWithWatts('aps-800', 800);
    const aps1800 = batteryStationWithWatts('aps-1800', 1800);

    const needState = needStateWithBudget();
    needState.selectionState.hardConstraints.mustHaveTraits = ['power_source:battery', 'minimum 800 W'];
    const selection = selectProductsForVisibleCards({
      products: [aps600, aps800, aps1800],
      userMessage: 'Need battery power station 800 W or more, 220 V.',
      history: [],
      intent: {
        userMessageSummary: 'buyer needs a battery power station at least 800 W',
        dialogueUnderstanding: 'APS600 is below the buyer minimum and must not be a visible recommendation card',
        nextStepRationale: 'show only battery station cards that satisfy the minimum power',
        requiresTools: true,
        toolRequests: [{
          id: 'catalog-search',
          tool: 'catalog.search',
          args: { productIntent: 'generator', query: 'battery power station 800 W or more 220 V' },
          rationale: 'find battery stations',
          required: true
        }],
        mustNotAskQuestionIds: [],
        riskFlags: []
      },
      answerText: 'APS800 fits the minimum. APS1800 is a stronger reserve option. APS600 is weaker than the required minimum, so I am not taking it into the selection.',
      needState
    });

    expect(selection.selectedProductIds).toEqual(['aps-800', 'aps-1800']);
    expect(selection.droppedProductIds).toContain('aps-600');
    expect(selection.warnings).toContain('product_cards_filtered_by_generator_power:1');
  });

  it('filters battery station cards below an exact watt request as visibly weaker alternatives', () => {
    const aps600 = batteryStationWithWatts('aps-600', 600);
    const aps800 = batteryStationWithWatts('aps-800', 800);

    const needState = needStateWithBudget();
    needState.selectionState.hardConstraints.mustHaveTraits = ['power_source:battery', '800 W'];
    const selection = selectProductsForVisibleCards({
      products: [aps800, aps600],
      userMessage: 'Need battery power station 800 W, 220 V.',
      history: [],
      intent: {
        userMessageSummary: 'buyer needs a battery power station 800 W',
        dialogueUnderstanding: 'APS600 is weaker than the exact requested power',
        nextStepRationale: 'show the 800 W card, not weaker alternatives',
        requiresTools: true,
        toolRequests: [{
          id: 'catalog-search',
          tool: 'catalog.search',
          args: { productIntent: 'generator', query: 'battery power station 800 W 220 V' },
          rationale: 'find battery stations',
          required: true
        }],
        mustNotAskQuestionIds: [],
        riskFlags: []
      },
      answerText: 'APS800 fits. APS600 is weaker than the request.',
      needState
    });

    expect(selection.selectedProductIds).toEqual(['aps-800']);
    expect(selection.droppedProductIds).toContain('aps-600');
    expect(selection.warnings).toContain('product_cards_filtered_by_generator_power:1');
  });

  it('filters single-phase 220 V generator cards when the buyer requires 380 V even if the answer names them as unsuitable', () => {
    const threePhase = generatorWithPowerAndVoltage('diesel-380', '16', '380 V three phase');
    const singlePhase = generatorWithPowerAndVoltage('diesel-220', '16', '220 V single phase');

    const needState = needStateWithBudget();
    needState.constraints = [{ value: '380 V', evidence: 'explicit buyer voltage', confidence: 1, updatedAt: '2026-07-08T00:00:00.000Z' }];
    needState.selectionState.hardConstraints.mustHaveTraits = ['diesel', '380 V'];
    const selection = selectProductsForVisibleCards({
      products: [threePhase, singlePhase],
      userMessage: 'Need diesel generator 15-20 kW for 380 V. Gasoline does not fit.',
      history: [],
      intent: {
        userMessageSummary: 'buyer needs diesel 15-20 kW 380 V generator',
        dialogueUnderstanding: 'single-phase 220 V cards contradict the explicit 380 V requirement',
        nextStepRationale: 'show diesel generator cards compatible with 380 V',
        requiresTools: true,
        toolRequests: [{
          id: 'catalog-search',
          tool: 'catalog.search',
          args: { productIntent: 'generator', query: 'diesel generator 15-20 kW 380 V' },
          rationale: 'find diesel 380 V generators',
          required: true
        }],
        mustNotAskQuestionIds: [],
        riskFlags: []
      },
      answerText: 'The 16 kW 380 V model fits. The 16 kW 220 V model is single-phase and does not fit a 380 V request.',
      needState
    });

    expect(selection.selectedProductIds).toEqual(['diesel-380']);
    expect(selection.droppedProductIds).toContain('diesel-220');
    expect(selection.warnings).toContain('product_cards_filtered_by_generator_phase:1');
  });

  it('requires an explicit canonical product intent instead of classifying free-form text in code', () => {
    const freeFormIntent = toolRequestProductIntent({
      id: 'catalog-search',
      tool: 'catalog.search',
      args: {
        productIntent: 'battery power station',
        query: 'battery power station 800 W 220 V'
      },
      rationale: 'find battery power stations',
      required: true
    } as never);
    const canonicalIntent = toolRequestProductIntent({
      id: 'catalog-search-canonical',
      tool: 'catalog.search',
      args: {
        productIntent: 'battery power station',
        canonicalProductIntent: 'generator',
        query: 'battery power station 800 W 220 V'
      },
      rationale: 'LLM supplied the canonical class explicitly',
      required: true
    } as never);

    expect(freeFormIntent).toBe('unknown');
    expect(canonicalIntent).toBe('generator');
  });

  it('filters concrete-only diamond blade cards when the buyer asks for porcelain or ceramic tile', () => {
    const porcelain = diamondBlade('porcelain', 'Diamond blade 350 porcelain tile ceramic');
    const concrete = diamondBlade('concrete', 'Diamond blade 350 concrete reinforced concrete');

    const selection = selectProductsForVisibleCards({
      products: [porcelain, concrete],
      userMessage: 'Need a 350 mm diamond blade for porcelain tile.',
      history: [],
      intent: {
        userMessageSummary: 'buyer needs a 350 mm diamond blade for porcelain tile',
        dialogueUnderstanding: 'concrete-only blades must not be visible as suitable cards for porcelain tile',
        nextStepRationale: 'show ceramic/porcelain diamond blade cards',
        requiresTools: true,
        toolRequests: [{
          id: 'catalog-search',
          tool: 'catalog.search',
          args: { productIntent: 'diamondBlade', query: 'diamond blade 350 porcelain tile' },
          rationale: 'find diamond blades for porcelain tile',
          required: true
        }],
        mustNotAskQuestionIds: [],
        riskFlags: []
      },
      answerText: 'The porcelain blade fits. The concrete blade is for concrete, not porcelain tile.',
      needState: needStateWithBudget()
    });

    expect(selection.selectedProductIds).toEqual(['porcelain']);
    expect(selection.droppedProductIds).toContain('concrete');
    expect(selection.warnings).toContain('product_cards_filtered_by_diamond_material:1');
  });

  it('keeps self-loading plate card ranking without regex parsing', () => {
    const light = plateWithWeight('light-60', 60);
    const heavy = plateWithWeight('heavy-110', 110);

    const ranked = rankCatalogProductsByNumericFit({
      products: [heavy, light],
      intent: 'plate',
      query: 'сам буду грузить в машину',
      semanticContext: '',
      userMessage: ''
    });

    expect(ranked.map((product) => product.id)).toEqual(['light-60', 'heavy-110']);
  });

  it('keeps small-site plate card ranking without regex parsing', () => {
    const light = plateWithWeight('light-50', 50);
    const mid = plateWithWeight('mid-83', 83);
    const heavy = plateWithWeight('heavy-160', 160);

    const ranked = rankCatalogProductsByNumericFit({
      products: [heavy, light, mid],
      intent: 'plate',
      query: 'въезд на участке, плитка и песок',
      semanticContext: '',
      userMessage: ''
    });

    expect(ranked.map((product) => product.id)).toEqual(['mid-83', 'light-50', 'heavy-160']);
  });

  it('keeps heavy-site signals from applying the small-site plate range', () => {
    const light = plateWithWeight('light-50', 50);
    const mid = plateWithWeight('mid-83', 83);
    const heavy = plateWithWeight('heavy-160', 160);

    const ranked = rankCatalogProductsByNumericFit({
      products: [heavy, light, mid],
      intent: 'plate',
      query: 'въезд и плитка, но объект тяжелый, нужна реверсивная плита',
      semanticContext: '',
      userMessage: ''
    });

    expect(ranked.map((product) => product.id)).toEqual(['heavy-160', 'light-50', 'mid-83']);
  });

  it('suppresses previous 400 kg plate cards when the current task is home paving tile', () => {
    const grost = plateWithNameAndWeight('grost-vh-400d', 'GROST VH 400D 400 kg vibroplita', 400);
    const masterpac = plateWithNameAndWeight('masterpac-pcr7060h2', 'MASTERPAC PCR7060H.2 400 kg vibroplita', 400);
    const husqvarna = plateWithNameAndWeight('husqvarna-lg-400', 'Husqvarna LG 400 398 kg vibroplita', 398);

    const selection = selectProductsForVisibleCards({
      products: [grost, masterpac, husqvarna],
      userMessage: 'For home paving tile in the yard, which vibroplita of these is better?',
      history: [],
      intent: {
        userMessageSummary: 'buyer compares previous 400 kg vibroplates for home paving tile',
        dialogueUnderstanding: 'current use is home paving tile, not heavy base compaction',
        nextStepRationale: 'reject unsuitable heavy previous options and search a lighter plate class',
        requiresTools: false,
        toolRequests: [],
        mustNotAskQuestionIds: [],
        riskFlags: []
      },
      answerText: 'Husqvarna LG 400 is lighter than the rest.',
      needState: needStateWithBudget(),
      allowHistoricalProducts: true
    });

    expect(selection.selectedProductIds).toEqual([]);
    expect(selection.droppedProductIds).toEqual(['grost-vh-400d', 'masterpac-pcr7060h2', 'husqvarna-lg-400']);
    expect(selection.warnings).toContain('product_cards_suppressed:plate_task_weight_mismatch:selected_outside_task_range');
  });

  it('keeps 400 kg plate cards for explicit heavy professional plate work', () => {
    const grost = plateWithNameAndWeight('grost-vh-400d', 'GROST VH 400D 400 kg vibroplita', 400);
    const husqvarna = plateWithNameAndWeight('husqvarna-lg-400', 'Husqvarna LG 400 398 kg vibroplita', 398);

    const selection = selectProductsForVisibleCards({
      products: [grost, husqvarna],
      userMessage: 'Need about 400 kg reversible vibroplita for a heavy professional site and crushed stone base',
      history: [],
      intent: {
        userMessageSummary: 'buyer needs heavy reversible 400 kg vibroplate',
        dialogueUnderstanding: 'professional heavy site, crushed stone base',
        nextStepRationale: 'compare heavy reversible plates',
        requiresTools: false,
        toolRequests: [],
        mustNotAskQuestionIds: [],
        riskFlags: []
      },
      answerText: 'GROST VH 400D and Husqvarna LG 400 match.',
      needState: needStateWithBudget(),
      allowHistoricalProducts: true
    });

    expect(selection.selectedProductIds).toEqual(['grost-vh-400d', 'husqvarna-lg-400']);
    expect(selection.warnings).not.toEqual(expect.arrayContaining([
      expect.stringContaining('plate_task_weight_mismatch')
    ]));
  });

  it('fails closed on unknown phase for a structured three-phase selection', () => {
    const knownThreePhase = {
      ...generatorWithPowerAndVoltage('diesel-380', '16', '380 V three phase'),
      name: 'TSS SDG 16000EHA diesel generator 16 kW 380 V three phase'
    };
    const unknownPhase = {
      ...generatorWithPower('unknown-phase', '16'),
      name: 'TSS SDG 16000UNKNOWN diesel generator 16 kW'
    };
    const intent = structuredSelectionIntent({ powerSource: 'fuel', phase: 'three_phase' });

    const selection = selectProductsForVisibleCards({
      products: [knownThreePhase, unknownPhase],
      userMessage: 'Нужен дизельный генератор 380 В.',
      history: [],
      intent,
      answerText: `${knownThreePhase.name} подходит. ${unknownPhase.name} тоже рассматривался.`,
      selectedProductIds: [knownThreePhase.id, unknownPhase.id],
      needState: needStateWithBudget()
    });

    expect(selection.semanticAuthority).toBe('llm_contract');
    expect(selection.selectedProductIds).toEqual(['diesel-380']);
    expect(selection.droppedProductIds).toContain('unknown-phase');
  });

  it('suppresses an invalid structured selection without substituting an unselected catalog product', () => {
    const selectedOverBudget = generatorWithPrice('selected-expensive', 'TSS SGG 6000EH gasoline generator 5 kW', 120_000);
    const unselectedWithinBudget = generatorWithPrice('unselected-cheap', 'TSS SGG 5000EH gasoline generator 5 kW', 70_000);
    const intent = structuredSelectionIntent({
      requirements: [{
        id: 'budget',
        kind: 'budget_max_rub',
        value: 80_000,
        unit: 'RUB',
        role: 'hard_constraint',
        strictness: 'strict',
        evidence: 'Бюджет до 80 000 рублей'
      }]
    });

    const selection = selectProductsForVisibleCards({
      products: [selectedOverBudget, unselectedWithinBudget],
      userMessage: 'Бюджет до 80 000 рублей.',
      history: [],
      intent,
      answerText: `${selectedOverBudget.name} выбран.`,
      selectedProductIds: [selectedOverBudget.id],
      needState: needStateWithBudget()
    });

    expect(selection.selectedProductIds).toEqual([]);
    expect(selection.selectedProductIds).not.toContain(unselectedWithinBudget.id);
    expect(selection.warnings).toContain('product_cards_suppressed:budget_no_fit');
  });

  it('does not enforce a preferred requirement as a hard structured filter', () => {
    const selected = generatorWithPrice('preferred-budget', 'TSS SGG 6000EHA gasoline generator 5 kW', 120_000);
    const intent = structuredSelectionIntent({
      requirements: [{
        id: 'preferred-budget',
        kind: 'budget_max_rub',
        value: 80_000,
        unit: 'RUB',
        role: 'hard_constraint',
        strictness: 'preferred',
        evidence: 'Желательно уложиться в 80 000 рублей'
      }]
    });

    const selection = selectProductsForVisibleCards({
      products: [selected],
      userMessage: 'Желательно уложиться в 80 000 рублей.',
      history: [],
      intent,
      answerText: `${selected.name} — осознанный вариант выше желаемого бюджета.`,
      selectedProductIds: [selected.id],
      needState: needStateWithBudget()
    });

    expect(selection.selectedProductIds).toEqual([selected.id]);
  });

  it('supports a strict price-lower-than-reference requirement and excludes the reference price itself', () => {
    const intent = structuredSelectionIntent({
      targetProductClass: 'виброплита',
      canonicalProductClass: 'plate',
      selectionGoal: 'preliminary_fit',
      requirements: [{
        id: 'lower-than-reference',
        kind: 'price_lower_than_reference',
        value: 79_592,
        unit: 'RUB',
        role: 'hard_constraint',
        strictness: 'strict',
        relation: 'must_have',
        evidence: 'Нужна модель дешевле ранее показанной',
        verification: { mode: 'product_attribute' }
      }]
    });
    intent.toolRequests = [{
      id: 'plate-price-search',
      tool: 'catalog.search',
      args: {
        query: 'виброплита дешевле ориентира',
        productIntent: 'виброплита',
        canonicalProductIntent: 'plate'
      },
      rationale: 'Найти более дешёвую виброплиту.',
      required: true,
      coversRequirementIds: ['lower-than-reference']
    }];

    expect(assessStrictSelectionRequirements(intent, 'plate').blockers).toEqual([]);
    const selection = selectProductsForVisibleCards({
      products: [plate, overBudgetPlate],
      userMessage: 'Нужна модель дешевле ранее показанной.',
      history: [],
      intent,
      answerText: `${plate.name} дешевле, ${overBudgetPlate.name} — исходный ориентир.`,
      selectedProductIds: [plate.id, overBudgetPlate.id],
      needState: needStateWithBudget()
    });

    expect(selection.selectedProductIds).toEqual([plate.id]);
    expect(selection.droppedProductIds).toContain(overBudgetPlate.id);
  });

  it('accepts a strict operating condition only through its covered successful typed calculation and filters weak cards', () => {
    const intent = generatorLoadDerivedConstraintIntent();
    const weak = {
      ...generatorWithPower('weak-generator', '4.5'),
      name: 'TSS SGG 5000EH generator'
    };
    const suitable = {
      ...generatorWithPower('suitable-generator', '9'),
      name: 'TSS SGG 10000EH generator'
    };
    const toolResults = [generatorLoadResult()];

    const assessment = assessStrictSelectionRequirements(intent, 'generator', toolResults);
    expect(assessment).toEqual({ blockers: [], generatorNominalPowerMinKw: 5.5 });

    const selection = selectProductsForVisibleCards({
      products: [weak, suitable],
      userMessage: 'The pump and angle grinder must run at the same time.',
      history: [],
      intent,
      answerText: `${weak.name} and ${suitable.name} were considered; ${suitable.name} fits the calculated minimum.`,
      selectedProductIds: [weak.id, suitable.id],
      needState: needStateWithBudget(),
      toolResults
    });

    expect(selection.selectedProductIds).toEqual([suitable.id]);
    expect(selection.warnings).not.toContain(
      'product_cards_suppressed:unsupported_or_unverifiable_strict_hard_constraint:1'
    );
  });

  it('accepts scenario and explicit derived-minimum requirements sharing one covered calculator proof', () => {
    const intent = generatorLoadDerivedConstraintIntent();
    intent.selectionPolicy!.requirements.push({
      id: 'calculated-nominal-minimum',
      kind: 'nominal_power_min_kw',
      value: null,
      unit: 'kW',
      role: 'hard_constraint',
      strictness: 'strict',
      evidence: 'the nominal minimum is derived by the referenced load calculation',
      verification: {
        mode: 'typed_tool',
        toolRequestId: 'load-calculation',
        tool: 'calculator.generatorLoad',
        verifier: 'generator_load_profile',
        bindAs: 'nominal_power_min_kw'
      }
    });
    intent.toolRequests[0]!.coversRequirementIds = [
      'simultaneous-loads',
      'calculated-nominal-minimum'
    ];

    expect(assessStrictSelectionRequirements(intent, 'generator', [generatorLoadResult()])).toEqual({
      blockers: [],
      generatorNominalPowerMinKw: 5.5
    });
  });

  it('reuses a prior safe generator calculation for a preliminary comparison but never for final fit', () => {
    const preliminary = generatorLoadDerivedConstraintIntent();
    preliminary.toolRequests = [];
    preliminary.selectionPolicy = {
      ...preliminary.selectionPolicy!,
      selectionGoal: 'preliminary_fit',
      reusePreviousCards: true
    };
    const verification = preliminary.selectionPolicy.requirements[0]!.verification;
    if (verification?.mode === 'typed_tool') verification.toolRequestId = 'carried-load-context';

    expect(assessStrictSelectionRequirements(preliminary, 'generator', [generatorLoadResult()])).toEqual({
      blockers: [],
      generatorNominalPowerMinKw: 5.5
    });

    const finalFit = structuredClone(preliminary);
    finalFit.selectionPolicy!.selectionGoal = 'final_fit';
    expect(assessStrictSelectionRequirements(finalFit, 'generator', [generatorLoadResult()]).blockers).toEqual([
      expect.objectContaining({ reason: 'typed_tool_request_missing' })
    ]);
  });

  it('accepts the power_min_kw alias with a Russian kW unit for a typed derived minimum', () => {
    const intent = generatorLoadDerivedConstraintIntent();
    intent.selectionPolicy!.requirements = [{
      id: 'calculated-power-minimum',
      kind: 'power_min_kw',
      value: null,
      unit: 'кВт',
      role: 'hard_constraint',
      strictness: 'strict',
      evidence: 'the required minimum comes from the referenced load calculation',
      verification: {
        mode: 'typed_tool',
        toolRequestId: 'load-calculation',
        tool: 'calculator.generatorLoad',
        verifier: 'generator_load_profile',
        bindAs: 'nominal_power_min_kw'
      }
    }];
    intent.toolRequests[0]!.coversRequirementIds = ['calculated-power-minimum'];

    expect(assessStrictSelectionRequirements(intent, 'generator', [generatorLoadResult()])).toEqual({
      blockers: [],
      generatorNominalPowerMinKw: 5.5
    });
  });

  it.each([
    { value: 5.5, unit: 'kW' },
    { value: null, unit: null },
    { value: null, unit: 'kVA' }
  ])('fails closed for malformed typed derived-minimum shape %#', ({ value, unit }) => {
    const intent = generatorLoadDerivedConstraintIntent();
    intent.selectionPolicy!.requirements = [{
      id: 'malformed-derived-minimum',
      kind: 'nominal_power_min_kw',
      value,
      unit,
      role: 'hard_constraint',
      strictness: 'strict',
      evidence: 'malformed derived constraint must not be laundered through a successful calculation',
      verification: {
        mode: 'typed_tool',
        toolRequestId: 'load-calculation',
        tool: 'calculator.generatorLoad',
        verifier: 'generator_load_profile',
        bindAs: 'nominal_power_min_kw'
      }
    }];
    intent.toolRequests[0]!.coversRequirementIds = ['malformed-derived-minimum'];

    expect(assessStrictSelectionRequirements(intent, 'generator', [generatorLoadResult()]).blockers).toEqual([
      expect.objectContaining({ reason: 'generator_load_requirement_shape_mismatch' })
    ]);
  });

  it('keeps only products with explicit no-autostart facts for an explicit must-not-have requirement', () => {
    const intent = structuredSelectionIntent({
      requirements: [{
        id: 'no-autostart',
        kind: 'autostart_required',
        value: false,
        unit: null,
        relation: 'must_not_have',
        role: 'hard_constraint',
        strictness: 'strict',
        evidence: 'the buyer does not need automatic start',
        verification: { mode: 'product_attribute' }
      }]
    });
    const withoutAutoStart = {
      ...generatorWithPower('without-autostart', '6'),
      name: 'TSS SGG 6000NA generator',
      specs: { 'Nominal power': '6 kW', Autostart: 'no' }
    };
    const withAutoStart = {
      ...generatorWithPower('with-autostart', '6'),
      name: 'TSS SGG 6000ATS generator',
      specs: { 'Nominal power': '6 kW', Autostart: 'yes' }
    };
    const unknownAutoStart = {
      ...generatorWithPower('unknown-autostart', '6'),
      name: 'TSS SGG 6000U generator'
    };
    const conflictingAutoStart = {
      ...generatorWithPower('conflicting-autostart', '6'),
      name: 'TSS SGG 6000C generator',
      specs: { 'Nominal power': '6 kW', 'Auto start': 'yes', Autostart: 'no' }
    };
    const products = [withoutAutoStart, withAutoStart, unknownAutoStart, conflictingAutoStart];

    const selection = selectProductsForVisibleCards({
      products,
      userMessage: 'Show a generator without automatic start.',
      history: [],
      intent,
      answerText: products.map((item) => item.name).join(', '),
      selectedProductIds: products.map((item) => item.id),
      needState: needStateWithBudget()
    });

    expect(selection.selectedProductIds).toEqual([withoutAutoStart.id]);
    expect(selection.droppedProductIds).toEqual(expect.arrayContaining([
      withAutoStart.id,
      unknownAutoStart.id,
      conflictingAutoStart.id
    ]));
    expect(selection.warnings).toContain('product_cards_filtered_by_generator_autostart:3');

    const selectionWithoutExplicitIds = selectProductsForVisibleCards({
      products,
      userMessage: 'Show a generator without automatic start.',
      history: [],
      intent,
      answerText: products.map((item) => item.name).join(', '),
      needState: needStateWithBudget()
    });
    expect(selectionWithoutExplicitIds.selectedProductIds).toEqual([withoutAutoStart.id]);
  });

  it('does not exclude products with autostart when the feature is merely not required', () => {
    const intent = structuredSelectionIntent({
      requirements: [{
        id: 'autostart-optional',
        kind: 'autostart_required',
        value: false,
        unit: null,
        relation: 'not_required',
        role: 'preference',
        strictness: 'informational',
        evidence: 'the buyer says automatic start is not needed',
        verification: { mode: 'product_attribute' }
      }]
    });
    const products = [{
      ...generatorWithPower('with-autostart', '6'),
      name: 'TSS SGG 6000ATS generator',
      specs: { 'Nominal power': '6 kW', Autostart: 'yes' }
    }, {
      ...generatorWithPower('without-autostart', '6'),
      name: 'TSS SGG 6000NA generator',
      specs: { 'Nominal power': '6 kW', Autostart: 'no' }
    }];

    const selection = selectProductsForVisibleCards({
      products,
      userMessage: 'Automatic start is not needed.',
      history: [],
      intent,
      answerText: products.map((product) => product.name).join(', '),
      selectedProductIds: products.map((product) => product.id),
      needState: needStateWithBudget()
    });

    expect(selection.selectedProductIds).toEqual(products.map((product) => product.id));
  });

  it('supports the auto_start_required alias in the true direction', () => {
    const intent = structuredSelectionIntent({
      requirements: [{
        id: 'needs-autostart',
        kind: 'auto_start_required',
        value: true,
        unit: null,
        role: 'hard_constraint',
        strictness: 'strict',
        evidence: 'the buyer explicitly needs automatic start',
        verification: { mode: 'product_attribute' }
      }]
    });
    const withAutoStart = {
      ...generatorWithPower('with-autostart', '6'),
      name: 'TSS SGG 6000ATS generator',
      specs: { 'Nominal power': '6 kW', Autostart: true }
    };
    const withoutAutoStart = {
      ...generatorWithPower('without-autostart', '6'),
      name: 'TSS SGG 6000NA generator',
      specs: { 'Nominal power': '6 kW', Autostart: false }
    };

    const selection = selectProductsForVisibleCards({
      products: [withAutoStart, withoutAutoStart],
      userMessage: 'Automatic start is required.',
      history: [],
      intent,
      answerText: `${withAutoStart.name}, ${withoutAutoStart.name}`,
      selectedProductIds: [withAutoStart.id, withoutAutoStart.id],
      needState: needStateWithBudget()
    });

    expect(selection.selectedProductIds).toEqual([withAutoStart.id]);
  });

  it('rejects malformed and conflicting strict autostart requirements', () => {
    const malformed = structuredSelectionIntent({
      requirements: [{
        id: 'malformed-autostart',
        kind: 'autostart_required',
        value: 'false',
        unit: null,
        role: 'hard_constraint',
        strictness: 'strict',
        evidence: 'a string must not be treated as the typed boolean constraint',
        verification: { mode: 'product_attribute' }
      }]
    });
    expect(assessStrictSelectionRequirements(malformed, 'generator').blockers).toEqual([
      expect.objectContaining({ reason: 'autostart_requirement_shape_or_product_class_mismatch' })
    ]);

    const wrongUnit = structuredSelectionIntent({
      requirements: [{
        id: 'unit-bearing-autostart',
        kind: 'auto_start_required',
        value: false,
        unit: 'bool',
        relation: 'must_not_have',
        role: 'hard_constraint',
        strictness: 'strict',
        evidence: 'the typed boolean constraint must not carry a unit',
        verification: { mode: 'product_attribute' }
      }]
    });
    expect(assessStrictSelectionRequirements(wrongUnit, 'generator').blockers).toEqual([
      expect.objectContaining({ reason: 'autostart_requirement_shape_or_product_class_mismatch' })
    ]);

    const wrongProductClass = structuredSelectionIntent({
      requirements: [{
        id: 'plate-autostart',
        kind: 'autostart_required',
        value: false,
        unit: null,
        relation: 'must_not_have',
        role: 'hard_constraint',
        strictness: 'strict',
        evidence: 'autostart requirement cannot be applied to an unrelated product class',
        verification: { mode: 'product_attribute' }
      }]
    });
    expect(assessStrictSelectionRequirements(wrongProductClass, 'plate').blockers).toEqual([
      expect.objectContaining({ reason: 'autostart_requirement_shape_or_product_class_mismatch' })
    ]);

    const conflicting = structuredSelectionIntent({
      requirements: [{
        id: 'autostart-on',
        kind: 'auto_start_required',
        value: true,
        unit: null,
        relation: 'must_have',
        role: 'hard_constraint',
        strictness: 'strict',
        evidence: 'first strict requirement',
        verification: { mode: 'product_attribute' }
      }, {
        id: 'autostart-off',
        kind: 'autostart_required',
        value: false,
        unit: null,
        relation: 'must_not_have',
        role: 'hard_constraint',
        strictness: 'strict',
        evidence: 'contradictory strict requirement',
        verification: { mode: 'product_attribute' }
      }]
    });
    expect(assessStrictSelectionRequirements(conflicting, 'generator').blockers).toEqual([
      expect.objectContaining({ id: 'autostart-off', reason: 'conflicting_autostart_requirements' })
    ]);
  });

  it.each([
    {
      name: 'failed result',
      mutate: (_intent: AgentIntentContract) => [generatorLoadResult('error')],
      reason: 'typed_tool_result_error'
    },
    {
      name: 'missing result',
      mutate: (_intent: AgentIntentContract) => [],
      reason: 'typed_tool_result_missing'
    },
    {
      name: 'wrong request id',
      mutate: (intent: AgentIntentContract) => {
        intent.selectionPolicy!.requirements[0]!.verification = {
          mode: 'typed_tool',
          toolRequestId: 'another-calculation',
          tool: 'calculator.generatorLoad',
          verifier: 'generator_load_profile',
          bindAs: 'nominal_power_min_kw'
        };
        return [generatorLoadResult()];
      },
      reason: 'typed_tool_request_missing'
    },
    {
      name: 'wrong tool request',
      mutate: (intent: AgentIntentContract) => {
        intent.toolRequests[0] = {
          id: 'load-calculation',
          tool: 'catalog.search',
          args: { query: 'generator' },
          rationale: 'mismatched tool request',
          required: true,
          coversRequirementIds: ['simultaneous-loads']
        };
        return [generatorLoadResult()];
      },
      reason: 'typed_tool_request_tool_mismatch'
    },
    {
      name: 'missing request coverage',
      mutate: (intent: AgentIntentContract) => {
        intent.toolRequests[0]!.coversRequirementIds = [];
        return [generatorLoadResult()];
      },
      reason: 'typed_tool_request_missing_requirement_coverage'
    },
    {
      name: 'malformed profile',
      mutate: (_intent: AgentIntentContract) => [generatorLoadResult('ok', '5.5')],
      reason: 'generator_load_profile_missing_positive_required_nominal_kw'
    },
    {
      name: 'selection-blocking calculation warning',
      mutate: (_intent: AgentIntentContract) => [{
        ...generatorLoadResult(),
        warnings: ['generator_load_bounded_basis_incomplete']
      }],
      reason: 'generator_load_result_not_final_fit_safe'
    }
  ])('fails closed for a typed-tool strict requirement with $name', ({ mutate, reason }) => {
    const intent = generatorLoadDerivedConstraintIntent();
    const assessment = assessStrictSelectionRequirements(intent, 'generator', mutate(intent));
    expect(assessment.blockers).toEqual([
      expect.objectContaining({ id: 'simultaneous-loads', reason })
    ]);
  });

  it('uses an incomplete bounded calculation for preliminary orientation but not final fit', () => {
    const preliminary = generatorLoadDerivedConstraintIntent();
    preliminary.selectionPolicy!.selectionGoal = 'preliminary_fit';
    const boundedIncompleteResult = {
      ...generatorLoadResult(),
      warnings: ['generator_load_bounded_basis_incomplete']
    };

    expect(assessStrictSelectionRequirements(preliminary, 'generator', [boundedIncompleteResult])).toEqual({
      blockers: [],
      generatorNominalPowerMinKw: 5.5
    });

    const finalFit = generatorLoadDerivedConstraintIntent();
    finalFit.selectionPolicy!.selectionGoal = 'final_fit';
    expect(assessStrictSelectionRequirements(finalFit, 'generator', [boundedIncompleteResult]).blockers).toEqual([
      expect.objectContaining({ reason: 'generator_load_result_not_final_fit_safe' })
    ]);
  });

  it('does not let an unbounded load warning close explicit catalog browsing', () => {
    const intent = structuredSelectionIntent();
    intent.selectionPolicy!.selectionGoal = 'browse_catalog';
    const cardSelection = {
      semanticAuthority: 'llm_contract' as const,
      intent: 'generator' as const,
      products: [generatorWithPower('browse-generator', '6')],
      selectedProductIds: ['browse-generator'],
      answerMentionedProductIds: ['browse-generator'],
      droppedProductIds: [],
      warnings: []
    };
    const answer: AnswerContract = {
      answerText: 'Here is a catalog option in the requested power range; load compatibility is not confirmed yet.',
      factsUsed: [],
      questionsAsked: [],
      toolResultIds: ['load-calculation'],
      selectedProductIds: ['browse-generator'],
      leadAction: 'none',
      riskFlags: [],
      selectionReadiness: {
        productClass: 'generator',
        status: 'ready_for_preliminary_cards',
        canShowProductCards: true,
        missingFacts: ['exact load basis'],
        rationale: 'Catalog browsing does not claim final compatibility.'
      }
    };
    const unsafeLoadResult = {
      ...generatorLoadResult(),
      warnings: ['generator_load_unbounded_guess']
    };

    expect(assessVisibleCardReadiness({
      cardSelection,
      answer,
      toolResults: [unsafeLoadResult],
      intent
    }).status).toBe('ready_for_cards');

    intent.selectionPolicy!.selectionGoal = 'preliminary_fit';
    expect(assessVisibleCardReadiness({
      cardSelection,
      answer,
      toolResults: [unsafeLoadResult],
      intent
    }).status).toBe('blocked_by_tool_safety');
  });

  it('does not use a generator-load proof for a different product class', () => {
    const assessment = assessStrictSelectionRequirements(
      generatorLoadDerivedConstraintIntent(),
      'plate',
      [generatorLoadResult()]
    );
    expect(assessment.blockers).toEqual([
      expect.objectContaining({
        id: 'simultaneous-loads',
        reason: 'generator_load_product_class_mismatch'
      })
    ]);
  });

  it('does not let an unsupported strict product attribute borrow a successful generator-load proof', () => {
    const intent = generatorLoadDerivedConstraintIntent();
    intent.selectionPolicy!.requirements[0] = {
      ...intent.selectionPolicy!.requirements[0]!,
      kind: 'noise_max_db',
      value: 60,
      unit: 'dB',
      evidence: 'noise must be no more than 60 dB'
    };

    expect(assessStrictSelectionRequirements(intent, 'generator', [generatorLoadResult()]).blockers).toEqual([
      expect.objectContaining({
        id: 'simultaneous-loads',
        reason: 'generator_load_requirement_kind_mismatch'
      })
    ]);
  });

  it('rejects an incompatible value or unit on a derived generator-load requirement', () => {
    const intent = generatorLoadDerivedConstraintIntent();
    intent.selectionPolicy!.requirements[0] = {
      ...intent.selectionPolicy!.requirements[0]!,
      value: 60,
      unit: 'dB',
      evidence: 'noise must be no more than 60 dB'
    };

    expect(assessStrictSelectionRequirements(intent, 'generator', [generatorLoadResult()]).blockers).toEqual([
      expect.objectContaining({ reason: 'generator_load_requirement_shape_mismatch' })
    ]);
  });

  it('rejects a supported numeric kind when its unit belongs to another attribute', () => {
    const intent = structuredSelectionIntent({
      requirements: [{
        id: 'laundered-noise',
        kind: 'weight_max_kg',
        value: 60,
        unit: 'dB',
        role: 'hard_constraint',
        strictness: 'strict',
        evidence: 'noise must be no more than 60 dB',
        verification: { mode: 'product_attribute' }
      }]
    });

    expect(assessStrictSelectionRequirements(intent, 'generator').blockers).toEqual([
      expect.objectContaining({ reason: 'numeric_requirement_unit_mismatch' })
    ]);
  });

  it('does not treat maximum power as nominal power for a derived generator-load minimum', () => {
    const intent = generatorLoadDerivedConstraintIntent();
    const maximumOnly: Product = {
      ...generatorWithPower('maximum-only', '6'),
      name: 'TSS SGG 6000EH gasoline generator maximum power 6 kW',
      specs: { 'Максимальная мощность': '6 кВт' }
    };

    const selection = selectProductsForVisibleCards({
      products: [maximumOnly],
      userMessage: 'The pump and angle grinder must run at the same time.',
      history: [],
      intent,
      answerText: `${maximumOnly.name} fits the calculated minimum.`,
      selectedProductIds: [maximumOnly.id],
      needState: needStateWithBudget(),
      toolResults: [generatorLoadResult()]
    });

    expect(selection.selectedProductIds).toEqual([]);
    expect(selection.droppedProductIds).toContain(maximumOnly.id);
    expect(selection.answerMentionedProductIds).toContain(maximumOnly.id);
  });

  it('does not treat nominal apparent power in kVA as confirmed active power in kW', () => {
    const intent = generatorLoadDerivedConstraintIntent();
    const apparentPowerOnly: Product = {
      ...generatorWithPower('apparent-only', '6'),
      name: 'TSS SGG 6000EH gasoline generator',
      specs: { 'Номинальная мощность': '6 кВА' }
    };

    const selection = selectProductsForVisibleCards({
      products: [apparentPowerOnly],
      userMessage: 'The pump and angle grinder must run at the same time.',
      history: [],
      intent,
      answerText: `${apparentPowerOnly.name} fits the calculated minimum.`,
      selectedProductIds: [apparentPowerOnly.id],
      needState: needStateWithBudget(),
      toolResults: [generatorLoadResult()]
    });

    expect(selection.answerMentionedProductIds).toContain(apparentPowerOnly.id);
    expect(selection.selectedProductIds).toEqual([]);
    expect(selection.droppedProductIds).toContain(apparentPowerOnly.id);
  });

  it('accepts the real Bakaut catalog shape with kW in the nominal spec key and a unitless value', () => {
    const intent = generatorLoadDerivedConstraintIntent();
    const realCatalogShape: Product = {
      ...generatorWithPower('real-key-unit', '6'),
      name: 'TSS SGG 6000EH gasoline generator',
      specs: { 'мощность номинальная при 220 в, квт': '6' }
    };

    const selection = selectProductsForVisibleCards({
      products: [realCatalogShape],
      userMessage: 'The pump and angle grinder must run at the same time.',
      history: [],
      intent,
      answerText: `${realCatalogShape.name} fits the calculated minimum.`,
      selectedProductIds: [realCatalogShape.id],
      needState: needStateWithBudget(),
      toolResults: [generatorLoadResult()]
    });

    expect(selection.answerMentionedProductIds).toContain(realCatalogShape.id);
    expect(selection.selectedProductIds).toEqual([realCatalogShape.id]);
  });

  it('keeps a unitless value under a nominal kVA key fail-closed', () => {
    const intent = generatorLoadDerivedConstraintIntent();
    const apparentKeyOnly: Product = {
      ...generatorWithPower('apparent-key-only', '6'),
      name: 'TSS SGG 6500EH gasoline generator',
      specs: { 'номинальная мощность, ква': '6' }
    };

    const selection = selectProductsForVisibleCards({
      products: [apparentKeyOnly],
      userMessage: 'The pump and angle grinder must run at the same time.',
      history: [],
      intent,
      answerText: `${apparentKeyOnly.name} fits the calculated minimum.`,
      selectedProductIds: [apparentKeyOnly.id],
      needState: needStateWithBudget(),
      toolResults: [generatorLoadResult()]
    });

    expect(selection.answerMentionedProductIds).toContain(apparentKeyOnly.id);
    expect(selection.selectedProductIds).toEqual([]);
  });

  it('fails closed when a strict planner constraint has no deterministic product verifier', () => {
    const selected = generatorWithPrice('g1', 'TSS SGG 5000EH gasoline generator 5 kW', 70000);
    const intent = structuredSelectionIntent({
      requirements: [{
        id: 'noise-limit',
        kind: 'noise_max_db',
        value: 60,
        unit: 'dB',
        role: 'hard_constraint',
        strictness: 'strict',
        evidence: 'noise must be no more than 60 dB'
      }]
    });

    const selection = selectProductsForVisibleCards({
      products: [selected],
      userMessage: 'Noise must be no more than 60 dB.',
      history: [],
      intent,
      answerText: `${selected.name} fits.`,
      selectedProductIds: [selected.id],
      needState: needStateWithBudget()
    });

    expect(selection.selectedProductIds).toEqual([]);
    expect(selection.products).toEqual([]);
    expect(selection.droppedProductIds).toEqual([selected.id]);
    expect(selection.warnings).toContain(
      'product_cards_suppressed:unsupported_or_unverifiable_strict_hard_constraint:1'
    );
  });

  it('keeps an explicitly product-attribute strict requirement fail-closed when the attribute is unsupported', () => {
    const intent = structuredSelectionIntent({
      requirements: [{
        id: 'verified-noise-limit',
        kind: 'noise_max_db',
        value: 60,
        unit: 'dB',
        role: 'hard_constraint',
        strictness: 'strict',
        evidence: 'noise must be no more than 60 dB',
        verification: { mode: 'product_attribute' }
      }]
    });

    expect(assessStrictSelectionRequirements(intent, 'generator').blockers).toEqual([
      expect.objectContaining({
        id: 'verified-noise-limit',
        reason: 'unsupported_strict_requirement_kind'
      })
    ]);
  });

  it('keeps web-covered unverified attributes as preliminary plate candidates but remains fail-closed for final fit', () => {
    const intent = structuredSelectionIntent({
      targetProductClass: 'виброплита',
      canonicalProductClass: 'plate',
      selectionGoal: 'preliminary_fit',
      requirements: [{
        id: 'material-crushed-stone',
        kind: 'material',
        value: 'crushed_stone',
        unit: null,
        relation: 'must_have',
        role: 'hard_constraint',
        strictness: 'strict',
        evidence: 'для трамбовки щебня',
        verification: {
          mode: 'typed_tool',
          toolRequestId: 'plate-web-check',
          tool: 'web.researchProductFacts',
          verifier: 'technical_source_review',
          bindAs: 'material_suitability'
        }
      }, {
        id: 'layer-by-layer',
        kind: 'compaction_method',
        value: 'layer_by_layer',
        unit: null,
        relation: 'must_have',
        role: 'hard_constraint',
        strictness: 'strict',
        evidence: 'будем делать послойно',
        verification: { mode: 'product_attribute' }
      }]
    });
    intent.toolRequests = [{
      id: 'plate-search',
      tool: 'catalog.search',
      args: {
        query: 'виброплита для щебня',
        productIntent: 'виброплита',
        canonicalProductIntent: 'plate'
      },
      rationale: 'find plate candidates',
      required: true,
      coversRequirementIds: []
    }, {
      id: 'plate-web-check',
      tool: 'web.researchProductFacts',
      args: {
        query: 'verify plate suitability for crushed stone',
        productIntent: 'виброплита',
        canonicalProductIntent: 'plate',
        productNames: []
      },
      rationale: 'verify facts missing from catalog cards',
      required: true,
      coversRequirementIds: ['material-crushed-stone', 'layer-by-layer']
    }];

    const preliminaryGate = gateStrictSelectionRequirements(intent, 'plate', [{
      requestId: 'plate-web-check',
      tool: 'web.researchProductFacts',
      status: 'timeout',
      payload: { error: 'timeout' },
      warnings: ['tool_execution_error']
    }]);
    expect(preliminaryGate.blockers).toEqual([]);
    expect(preliminaryGate.preliminaryUnverified).toEqual([
      expect.objectContaining({ id: 'material-crushed-stone', reason: 'typed_tool_result_timeout' }),
      expect.objectContaining({ id: 'layer-by-layer' })
    ]);

    const preliminarySelection = selectProductsForVisibleCards({
      products: [plate],
      userMessage: 'Нужна виброплита для щебня, работаем послойно.',
      history: [],
      intent,
      answerText: `${plate.name} — предварительный вариант; применение по щебню ещё проверяется.`,
      selectedProductIds: [plate.id],
      needState: needStateWithBudget(),
      toolResults: [{
        requestId: 'plate-web-check',
        tool: 'web.researchProductFacts',
        status: 'timeout',
        payload: { error: 'timeout' },
        warnings: ['tool_execution_error']
      }]
    });
    expect(preliminarySelection.selectedProductIds).toEqual([plate.id]);
    expect(preliminarySelection.warnings).toContain(
      'product_cards_preliminary:unverified_web_covered_strict_requirements:2'
    );

    intent.selectionPolicy!.selectionGoal = 'final_fit';
    const finalSelection = selectProductsForVisibleCards({
      products: [plate],
      userMessage: 'Подтвердите окончательную совместимость.',
      history: [],
      intent,
      answerText: `${plate.name} точно подходит.`,
      selectedProductIds: [plate.id],
      needState: needStateWithBudget(),
      toolResults: []
    });
    expect(finalSelection.selectedProductIds).toEqual([]);
    expect(finalSelection.warnings).toContain(
      'product_cards_suppressed:unsupported_or_unverifiable_strict_hard_constraint:2'
    );
  });

  it('accepts a typed strict gasoline requirement and removes diesel generator cards', () => {
    const gasoline = {
      ...generatorWithPrice('gasoline-5', 'TSS SGG 5000N gasoline generator 5 kW', 49281),
      specs: {
        'Nominal power': '5 kW',
        'вид топлива': 'бензиновые',
        'число фаз': 'однофазные'
      }
    };
    const diesel = {
      ...generatorWithPrice('diesel-5', 'FIRMAN SDG5500CLE diesel generator 4.8 kW', 98900),
      specs: {
        'Nominal power': '4.8 kW',
        'вид топлива': 'дизельные',
        'число фаз': 'однофазные'
      }
    };
    const intent = structuredSelectionIntent({
      powerSource: 'fuel',
      requirements: [{
        id: 'gasoline-only',
        kind: 'fuel_type',
        value: 'gasoline',
        unit: null,
        role: 'hard_constraint',
        strictness: 'strict',
        relation: 'must_have',
        evidence: 'Buyer chose a gasoline generator.',
        verification: { mode: 'product_attribute' }
      }]
    });

    expect(assessStrictSelectionRequirements(intent, 'generator')).toEqual({ blockers: [] });
    const selection = selectProductsForVisibleCards({
      products: [diesel, gasoline],
      userMessage: 'Show gasoline generators.',
      history: [],
      intent,
      answerText: `${gasoline.name} fits; ${diesel.name} does not match the requested fuel.`,
      selectedProductIds: [gasoline.id, diesel.id],
      needState: needStateWithBudget()
    });

    expect(selection.selectedProductIds).toEqual([gasoline.id]);
    expect(selection.products.map((product) => product.id)).toEqual([gasoline.id]);
    expect(selection.warnings).toContain('product_cards_filtered_by_generator_fuel:gasoline:1');
  });

  it('accepts strict price visibility and removes cards without a real catalog price', () => {
    const priced = generatorWithPrice('priced-5', 'TSS SGG 5000N gasoline generator 5 kW', 49281);
    const unpriced = { ...generatorWithPrice('unpriced-5', 'FIRMAN RD7910 gasoline generator 5 kW', 1), price: null };
    const intent = structuredSelectionIntent({
      requirements: [{
        id: 'price-required',
        kind: 'price_visibility',
        value: true,
        unit: null,
        role: 'hard_constraint',
        strictness: 'strict',
        relation: 'must_have',
        evidence: 'Buyer explicitly asked to see prices.',
        verification: { mode: 'product_attribute' }
      }]
    });

    expect(assessStrictSelectionRequirements(intent, 'generator')).toEqual({ blockers: [] });
    const selection = selectProductsForVisibleCards({
      products: [priced, unpriced],
      userMessage: 'Show generators with prices.',
      history: [],
      intent,
      answerText: `${priced.name} costs 49,281 RUB; ${unpriced.name} has no confirmed price.`,
      selectedProductIds: [priced.id, unpriced.id],
      needState: needStateWithBudget()
    });

    expect(selection.products.map((product) => product.id)).toEqual([priced.id]);
    expect(selection.warnings).toContain('product_cards_filtered_by_price_visibility:1');
  });

  it('binds an exact comparison scope to named comparison subjects instead of treating it as an unknown product attribute', () => {
    const first = generatorWithPrice('tss-5000n', 'TSS SGG 5000N gasoline generator 5 kW', 49281);
    const second = generatorWithPrice('bison-6250ie', 'BISON BS6250IE inverter generator 5 kW', 61100);
    const unrelated = generatorWithPrice('firman-rd7910', 'FIRMAN RD7910 gasoline generator 5 kW', 57200);
    const intent = structuredSelectionIntent({
      alternativePolicy: 'exact_only',
      maxCards: 2,
      requirements: [{
        id: 'compare-only-these-models',
        kind: 'comparison_scope',
        value: 'only_tss_sgg_5000n_and_bison_bs6250ie',
        unit: null,
        role: 'hard_constraint',
        strictness: 'strict',
        relation: 'must_have',
        evidence: 'Compare only TSS SGG 5000N and BISON BS6250IE.',
        verification: { mode: 'product_attribute' }
      }]
    });
    intent.productMentions = [{
      name: 'TSS SGG 5000N',
      role: 'comparison_subject',
      productClass: 'generator',
      evidence: 'first named comparison product'
    }, {
      name: 'BISON BS6250IE',
      role: 'comparison_subject',
      productClass: 'generator',
      evidence: 'second named comparison product'
    }];

    expect(assessStrictSelectionRequirements(intent, 'generator')).toEqual({ blockers: [] });
    const selection = selectProductsForVisibleCards({
      products: [unrelated, first, second],
      userMessage: 'Compare only TSS SGG 5000N and BISON BS6250IE.',
      history: [],
      intent,
      answerText: `${first.name} costs 49,281 RUB; ${second.name} costs 61,100 RUB.`,
      selectedProductIds: [unrelated.id, first.id, second.id],
      needState: needStateWithBudget()
    });

    expect(selection.products.map((product) => product.id)).toEqual([first.id, second.id]);
    expect(selection.droppedProductIds).toContain(unrelated.id);
  });

  it('accepts typed 220 V as a generator fact and removes three-phase-only cards', () => {
    const singlePhase = {
      ...generatorWithPowerAndVoltage('single-220', '5', '230 V single phase'),
      name: 'TSS SGG 5000N generator 5 kW 230 V single phase'
    };
    const threePhase = {
      ...generatorWithPowerAndVoltage('three-380', '5', '400 V three phase'),
      name: 'TSS SGG 5000E3 generator 5 kW 400 V three phase'
    };
    const intent = structuredSelectionIntent({
      phase: 'single_phase',
      requirements: [{
        id: 'voltage-required',
        kind: 'voltage_v',
        value: 220,
        unit: 'V',
        role: 'hard_constraint',
        strictness: 'strict',
        relation: 'must_have',
        evidence: 'The buyer has a 220 V house supply.',
        verification: { mode: 'product_attribute' }
      }]
    });

    expect(assessStrictSelectionRequirements(intent, 'generator')).toEqual({ blockers: [] });
    const selection = selectProductsForVisibleCards({
      products: [singlePhase, threePhase],
      userMessage: 'Show a 220 V generator.',
      history: [],
      intent,
      answerText: `${singlePhase.name} fits 220 V; ${threePhase.name} is three-phase only.`,
      selectedProductIds: [singlePhase.id, threePhase.id],
      needState: needStateWithBudget()
    });

    expect(selection.products.map((product) => product.id)).toEqual([singlePhase.id]);
    expect(selection.warnings).toContain('product_cards_filtered_by_generator_voltage:220:1');
  });

  it('accepts a null unit when the stable voltage_v kind is bound to the typed phase policy', () => {
    const singlePhase = {
      ...generatorWithPowerAndVoltage('single-220-null-unit', '5', '230 V single phase'),
      name: 'SUMEC SU7700 generator 5 kW 230 V single phase'
    };
    const intent = structuredSelectionIntent({
      phase: 'single_phase',
      requirements: [{
        id: 'voltage-required-without-duplicate-unit',
        kind: 'voltage_v',
        value: 220,
        unit: null,
        role: 'hard_constraint',
        strictness: 'strict',
        relation: 'must_have',
        evidence: 'The buyer has a 220 V house supply.',
        verification: { mode: 'product_attribute' }
      }]
    });

    expect(assessStrictSelectionRequirements(intent, 'generator')).toEqual({ blockers: [] });
    const selection = selectProductsForVisibleCards({
      products: [singlePhase],
      userMessage: 'Show a 220 V generator.',
      history: [],
      intent,
      answerText: `${singlePhase.name} fits 220 V.`,
      selectedProductIds: [singlePhase.id],
      needState: needStateWithBudget()
    });

    expect(selection.products.map((product) => product.id)).toEqual([singlePhase.id]);

    const wrongUnitIntent = structuredSelectionIntent({
      phase: 'single_phase',
      requirements: [{
        id: 'voltage-with-wrong-unit',
        kind: 'voltage_v',
        value: 220,
        unit: 'kg',
        role: 'hard_constraint',
        strictness: 'strict',
        relation: 'must_have',
        evidence: 'Malformed typed voltage requirement.',
        verification: { mode: 'product_attribute' }
      }]
    });
    expect(assessStrictSelectionRequirements(wrongUnitIntent, 'generator').blockers).toEqual([
      expect.objectContaining({
        id: 'voltage-with-wrong-unit',
        reason: 'generator_voltage_not_bound_to_typed_phase_policy'
      })
    ]);
  });

  it('binds a strict product type to the canonical product class and fails closed on mismatch', () => {
    const intent = structuredSelectionIntent({
      requirements: [{
        id: 'required-product-class',
        kind: 'product_type',
        value: 'generator',
        unit: null,
        role: 'hard_constraint',
        strictness: 'strict',
        evidence: 'Need a generator',
        verification: { mode: 'product_attribute' }
      }]
    });

    expect(assessStrictSelectionRequirements(intent, 'generator').blockers).toEqual([]);
    expect(assessStrictSelectionRequirements(intent, 'plate').blockers).toEqual([
      expect.objectContaining({
        id: 'required-product-class',
        reason: 'product_class_not_bound_to_canonical_policy'
      })
    ]);
  });

  it('fails closed when a supported strict numeric constraint has an invalid value', () => {
    const selected = generatorWithPrice('g2', 'TSS SGG 6000EH gasoline generator 5 kW', 70000);
    const intent = structuredSelectionIntent({
      requirements: [{
        id: 'invalid-budget',
        kind: 'budget_max_rub',
        value: null,
        unit: 'RUB',
        role: 'hard_constraint',
        strictness: 'strict',
        evidence: 'budget was marked strict but no value was supplied'
      }]
    });

    const selection = selectProductsForVisibleCards({
      products: [selected],
      userMessage: 'The budget is a hard limit.',
      history: [],
      intent,
      answerText: `${selected.name} fits.`,
      selectedProductIds: [selected.id],
      needState: needStateWithBudget()
    });

    expect(selection.selectedProductIds).toEqual([]);
    expect(selection.warnings).toContain(
      'product_cards_suppressed:unsupported_or_unverifiable_strict_hard_constraint:1'
    );
  });

  it('does not apply an old legacy budget to a new structured plate need without a budget requirement', () => {
    const intent = structuredSelectionIntent({
      targetProductClass: 'plate',
      canonicalProductClass: 'plate',
      requirements: []
    });
    intent.toolRequests = [{
      id: 'plate-search',
      tool: 'catalog.search',
      args: {
        query: 'plate compactor',
        productIntent: 'plate',
        canonicalProductIntent: 'plate'
      },
      rationale: 'ground the current structured plate need',
      required: true
    }];

    const selection = selectProductsForVisibleCards({
      products: [plate, overBudgetPlate],
      userMessage: 'Покажите две виброплиты для новой задачи.',
      history: [],
      intent,
      answerText: `${plate.name} и ${overBudgetPlate.name} подходят под новую задачу.`,
      selectedProductIds: [plate.id, overBudgetPlate.id],
      needState: needStateWithBudget(70_000)
    });

    expect(selection.selectedProductIds).toEqual([plate.id, overBudgetPlate.id]);
    expect(selection.warnings).not.toContain('product_cards_filtered_by_budget:1');
  });

  it('keeps an unfamiliar structured product class unknown instead of falling back to a paused generator need', () => {
    const intent = structuredSelectionIntent({
      targetProductClass: 'laser cleaning machine',
      canonicalProductClass: null,
      reusePreviousCards: false,
      requirements: []
    });
    intent.requiresTools = false;
    intent.toolRequests = [];
    const needState = needStateWithBudget();
    needState.activeNeeds = [{
      id: 'old-generator',
      productClass: 'generator',
      summary: 'old generator task',
      constraints: [],
      openQuestions: [],
      selectedProductIds: [generator.id],
      status: 'paused',
      updatedAt: '2026-05-21T00:00:00.000Z'
    }, {
      id: 'laser-cleaner',
      productClass: 'unknown',
      summary: 'current unfamiliar equipment task',
      constraints: [],
      openQuestions: [],
      selectedProductIds: [],
      status: 'open',
      updatedAt: '2026-05-21T00:01:00.000Z'
    }];

    const selection = selectProductsForVisibleCards({
      products: [generator],
      userMessage: 'Нужна установка лазерной очистки.',
      history: [],
      intent,
      answerText: 'Сначала уточню параметры установки лазерной очистки.',
      selectedProductIds: [],
      needState
    });

    expect(selection.intent).toBe('unknown');
    expect(selection.selectedProductIds).toEqual([]);
  });
});
