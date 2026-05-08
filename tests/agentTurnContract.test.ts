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
});
