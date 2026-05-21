import { describe, expect, it } from 'vitest';

import {
  assessVisibleCardReadiness,
  suppressVisibleCardsForReadiness
} from '../src/ai/agentManagerCardSelection.js';
import type { AnswerContract, ToolResult } from '../src/ai/agentManagerContracts.js';
import type { Product } from '../src/shared/types.js';

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

const plate: Product = {
  id: 'plate-1',
  name: 'Виброплита TSS-WP60L 60 кг',
  brand: 'ТСС',
  category: 'Виброплиты',
  price: 65000,
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
});
