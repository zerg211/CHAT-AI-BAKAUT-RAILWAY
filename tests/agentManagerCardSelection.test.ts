import { describe, expect, it } from 'vitest';

import {
  assessVisibleCardReadiness,
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
});
