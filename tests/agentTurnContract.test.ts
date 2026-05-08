import { describe, expect, it } from 'vitest';
import { deriveAgentTurnContract, applyAgentTurnContractToPlan } from '../src/ai/agentTurnContract.js';
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

  it('uses the LLM planner contract, not a phrase regex, to disable lead pressure', () => {
    const message = 'Номер пока не оставляю, сначала дайте итог по генератору и виброплите.';
    const collectPlan = {
      ...basePlan,
      action: 'collect_lead',
      answerMode: 'leadCollection',
      followUpPolicy: 'collectLead',
      agentDecision: {
        answerTask: 'lead_handoff' as const,
        mustAnswerNow: ['summarize generator need', 'summarize plate need'],
        currentFocus: 'commercial',
        cardsRole: 'none' as const,
        leadAllowed: false,
        leadAllowedReason: 'buyer wants the summary without a call/contact handoff now',
        errorRecoveryPriority: 'Give the summary without asking for a phone.',
        confidence: 0.93
      }
    };
    const contract = deriveAgentTurnContract({
      userMessage: message,
      plan: collectPlan,
      needState: emptyNeedState()
    });
    const plan = applyAgentTurnContractToPlan(collectPlan, contract);

    expect(contract.leadAllowed).toBe(false);
    expect(contract.validatorWarnings).toContain('contract_source:llm_planner');
    expect(plan.action).toBe('answer_question');
    expect(plan.followUpPolicy).toBe('answerNowNoDeferredOffer');
    expect(plan.cardPolicy).toBe('textOnly');
  });

  it('does not infer contact refusal from words when the planner says the meaning is different', () => {
    const contract = deriveAgentTurnContract({
      userMessage: 'Пока без звонка цена на доставку вообще считается отдельно?',
      plan: {
        ...basePlan,
        action: 'handoff_specialist',
        answerMode: 'leadCollection',
        followUpPolicy: 'collectLead',
        agentDecision: {
          answerTask: 'lead_handoff' as const,
          mustAnswerNow: ['explain that delivery is calculated separately'],
          currentFocus: 'commercial',
          cardsRole: 'none' as const,
          leadAllowed: true,
          leadAllowedReason: 'buyer asks a delivery condition question and has not refused a later specialist handoff',
          errorRecoveryPriority: 'Answer the delivery pricing limitation first.',
          confidence: 0.82
        }
      },
      needState: emptyNeedState()
    });

    expect(contract.leadAllowed).toBe(true);
    expect(contract.leadAllowedReason).toContain('delivery');
  });

  it('keeps commercial handoff text-only when the planner says cards are not part of the turn', () => {
    const commercialPlan = {
      ...basePlan,
      action: 'handoff_specialist',
      answerMode: 'leadCollection',
      cardPolicy: 'showProducts',
      followUpPolicy: 'collectLead',
      agentDecision: {
        answerTask: 'lead_handoff' as const,
        mustAnswerNow: ['answer delivery and discount limits before asking for contact'],
        currentFocus: 'commercial',
        cardsRole: 'none' as const,
        leadAllowed: true,
        leadAllowedReason: 'commercial conditions need specialist verification',
        errorRecoveryPriority: 'Explain delivery/discount limits first.',
        confidence: 0.9
      }
    };
    const contract = deriveAgentTurnContract({
      userMessage: 'Есть доставка и скидка? Сколько будет комплект примерно?',
      plan: commercialPlan,
      needState: emptyNeedState()
    });
    const plan = applyAgentTurnContractToPlan(commercialPlan, contract);

    expect(contract.answerTask).toBe('lead_handoff');
    expect(contract.cardsRole).toBe('none');
    expect(plan.cardPolicy).toBe('textOnly');
    expect(plan.selectionState.shouldShowCards).toBe(false);
    expect(plan.followUpPolicy).toBe('collectLead');
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
