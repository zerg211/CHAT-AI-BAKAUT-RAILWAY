import { describe, expect, it } from 'vitest';

import {
  assessVisibleCardReadiness,
  filterGeneratorProductsByLoadProfile,
  rankCatalogProductsByNumericFit,
  selectProductsForVisibleCards,
  suppressVisibleCardsForReadiness
} from '../src/ai/agentManagerCardSelection.js';
import type { AnswerContract, ToolResult } from '../src/ai/agentManagerContracts.js';
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
});
