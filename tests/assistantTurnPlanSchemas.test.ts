import { describe, expect, it } from 'vitest';

import { agentContractV2Schema, turnPlanSchema } from '../src/ai/assistantTurnPlanSchemas.js';

describe('assistant turn plan schemas', () => {
  it('keeps agent contract v2 schema policy fields stable', () => {
    const contract = agentContractV2Schema() as any;

    expect(contract.additionalProperties).toBe(false);
    expect(contract.required).toEqual([
      'version',
      'intent',
      'answerTask',
      'taskType',
      'catalogAction',
      'commercialAction',
      'productCardsPolicy',
      'cardsRole',
      'leadPolicy',
      'sourcePolicy',
      'needDelta',
      'missingFacts',
      'toolPlan',
      'selectedProductIds',
      'rejectedProductIds',
      'mustAnswerNow',
      'currentFocus',
      'errorRecoveryPriority',
      'confidence',
      'warnings'
    ]);
    expect(contract.properties.version.enum).toEqual([2]);
    expect(contract.properties.intent.enum).toContain('availability_check');
    expect(contract.properties.catalogAction.enum).toEqual([
      'none',
      'exact_model_lookup',
      'find_matching_products',
      'verify_catalog_absence'
    ]);
    expect(contract.properties.sourcePolicy.properties.allowed.items.enum).toEqual([
      'catalog',
      'visible_cards',
      'web',
      'specialist',
      'conversation_memory'
    ]);
    expect(contract.properties.toolPlan.items.properties.tool.enum).toContain('webFactSearch');
  });

  it('keeps turn plan schema nested contract and card limits stable', () => {
    const plan = turnPlanSchema(10) as any;

    expect(plan.additionalProperties).toBe(false);
    expect(plan.required).toEqual([
      'action',
      'answerMode',
      'cardPolicy',
      'followUpPolicy',
      'contextScope',
      'searchScope',
      'catalogSearchQuery',
      'selectedProductIds',
      'requiredProductTraits',
      'selectionState',
      'agentContractV2',
      'agentDecision',
      'needsWebSearch',
      'missingInformation',
      'answerGuidance'
    ]);
    expect(plan.properties.selectedProductIds.maxItems).toBe(10);
    expect(plan.properties.action.enum).toContain('recommend_products');
    expect(plan.properties.answerMode.enum).toContain('currentLineup');
    expect(plan.properties.requiredProductTraits.required).toContain('powerReasoning');
    expect(plan.properties.selectionState.properties.cardDisplayMode.enum).toEqual([
      'exact_matches',
      'compatible_accessories',
      'alternatives',
      'structured_selection',
      'preliminary',
      'none'
    ]);
    expect(plan.properties.agentContractV2.required).toEqual(agentContractV2Schema().required);
  });

  it('uses the caller supplied selected product limit', () => {
    expect((turnPlanSchema(3) as any).properties.selectedProductIds.maxItems).toBe(3);
    expect((turnPlanSchema(12) as any).properties.selectedProductIds.maxItems).toBe(12);
  });
});
