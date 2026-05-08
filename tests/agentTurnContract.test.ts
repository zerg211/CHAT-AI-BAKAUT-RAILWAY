import { describe, expect, it } from 'vitest';
import { deriveAgentTurnContract, applyAgentTurnContractToPlan, leadRefusalDetected } from '../src/ai/agentTurnContract.js';
import { emptyNeedState } from '../src/ai/needState.js';

const basePlan = {
  action: 'recommend_products',
  answerMode: 'productRecommendation',
  cardPolicy: 'showProducts',
  followUpPolicy: 'auto',
  selectedProductIds: ['p1'],
  answerGuidance: '',
  selectionState: {
    shouldShowCards: true
  }
};

describe('agent turn contract', () => {
  it('keeps gasoline/diesel reserve comparison as answer-first instead of catalog shortlist', () => {
    const contract = deriveAgentTurnContract({
      userMessage: 'Сравните бензиновый и дизельный генератор для редких отключений, и какой риск если взять без запаса?',
      plan: basePlan,
      needState: emptyNeedState()
    });
    const plan = applyAgentTurnContractToPlan(basePlan, contract);

    expect(contract.answerTask).toBe('comparison');
    expect(contract.mustAnswerNow.join(' ')).toMatch(/gasoline vs diesel/i);
    expect(contract.mustAnswerNow.join(' ')).toMatch(/without reserve/i);
    expect(plan.action).toBe('answer_question');
    expect(plan.answerMode).toBe('detailedFact');
    expect(plan.followUpPolicy).toBe('answerNowNoDeferredOffer');
  });

  it('detects contact refusal and disables lead pressure', () => {
    const message = 'Номер пока не оставляю, сначала дайте итог по генератору и виброплите.';
    const contract = deriveAgentTurnContract({
      userMessage: message,
      plan: { ...basePlan, action: 'collect_lead', answerMode: 'leadCollection', followUpPolicy: 'collectLead' },
      needState: emptyNeedState()
    });
    const plan = applyAgentTurnContractToPlan(basePlan, contract);

    expect(leadRefusalDetected(message)).toBe(true);
    expect(contract.leadAllowed).toBe(false);
    expect(plan.action).toBe('answer_question');
    expect(plan.followUpPolicy).toBe('answerNowNoDeferredOffer');
  });

  it('promotes product-selection turns to card-capable recommendation plans', () => {
    const textOnlyPlan = {
      ...basePlan,
      action: 'answer_question',
      answerMode: 'short',
      cardPolicy: 'textOnly',
      selectedProductIds: [],
      selectionState: {
        shouldShowCards: false
      }
    };
    const contract = deriveAgentTurnContract({
      userMessage: '\u041f\u043e\u043a\u0430\u0436\u0438\u0442\u0435 \u0432\u0430\u0440\u0438\u0430\u043d\u0442\u044b \u0433\u0435\u043d\u0435\u0440\u0430\u0442\u043e\u0440\u043e\u0432: \u043c\u0438\u043d\u0438\u043c\u0430\u043b\u044c\u043d\u044b\u0439 \u0438 \u0441 \u0437\u0430\u043f\u0430\u0441\u043e\u043c.',
      plan: textOnlyPlan,
      needState: emptyNeedState()
    });
    const plan = applyAgentTurnContractToPlan(textOnlyPlan, contract);

    expect(contract.answerTask).toBe('product_selection');
    expect(contract.cardsRole).toBe('primary');
    expect(plan.action).toBe('recommend_products');
    expect(plan.answerMode).toBe('productRecommendation');
    expect(plan.cardPolicy).toBe('showProducts');
    expect(plan.selectionState.shouldShowCards).toBe(true);
  });
});
