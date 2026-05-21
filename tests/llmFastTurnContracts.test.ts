import { describe, expect, it } from 'vitest';

import {
  coerceLlmFastTurnAnswerContract,
  coerceLlmFastTurnDecision,
  llmFastTurnAnswerTextFormat,
  llmFastTurnRouteTextFormat
} from '../src/ai/llmFastTurnContracts.js';

describe('LLM fast-turn contracts', () => {
  it('keeps commercial handoff route defaults stable', () => {
    const decision = coerceLlmFastTurnDecision({
      route: 'commercial_handoff',
      confidence: 3,
      rationale: ' buyer asks delivery ',
      leadAllowed: true,
      mustAnswerNow: ['delivery', 42, ' discount ', ''],
      warnings: ['commercial_terms']
    });

    expect(decision).toMatchObject({
      route: 'commercial_handoff',
      confidence: 1,
      rationale: 'buyer asks delivery',
      answerTask: 'lead_handoff',
      taskType: 'pure_delivery',
      catalogAction: 'none',
      commercialAction: 'explain_manager_required',
      productCardsPolicy: 'none',
      cardsRole: 'none',
      leadAllowed: true,
      pricePolicy: 'visible_cards_only',
      usePriorShownCards: true,
      needsCatalogSelection: false,
      createLeadIfContactPresent: false,
      mustAnswerNow: ['delivery', 'discount'],
      warnings: ['commercial_terms']
    });
  });

  it('keeps catalog selection route defaults stable', () => {
    const decision = coerceLlmFastTurnDecision({
      route: 'catalog_selection',
      confidence: 0.7
    });

    expect(decision).toMatchObject({
      route: 'catalog_selection',
      answerTask: 'product_selection',
      taskType: 'product_selection',
      catalogAction: 'find_matching_products',
      commercialAction: 'none',
      productCardsPolicy: 'show_matching_products',
      cardsRole: 'primary',
      pricePolicy: 'visible_cards_only',
      usePriorShownCards: false,
      needsCatalogSelection: true
    });
  });

  it('coerces answer contracts with trimming and array limits', () => {
    const contract = coerceLlmFastTurnAnswerContract({
      answer: '  Подойдет компактная виброплита.  ',
      leadRequested: 'yes',
      namedProductIds: Array.from({ length: 30 }, (_, index) => `product-${index}`),
      factsUsed: [' weight ', null, 'budget'],
      safetyNotes: [' no stock promise '],
      rationale: '  grounded in visible cards '
    });

    expect(contract.answer).toBe('Подойдет компактная виброплита.');
    expect(contract.leadRequested).toBe(false);
    expect(contract.namedProductIds).toHaveLength(24);
    expect(contract.factsUsed).toEqual(['weight', 'budget']);
    expect(contract.safetyNotes).toEqual(['no stock promise']);
    expect(contract.rationale).toBe('grounded in visible cards');
  });

  it('exports the same structured response formats used by the fast-turn model calls', () => {
    expect(llmFastTurnRouteTextFormat.format.name).toBe('llm_fast_turn_route');
    expect(llmFastTurnAnswerTextFormat.format.name).toBe('llm_fast_turn_answer');
  });
});
