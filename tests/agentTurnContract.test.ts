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
      plan: {
        ...basePlan,
        agentDecision: {
          answerTask: 'comparison' as const,
          taskType: 'comparison' as const,
          catalogAction: 'none' as const,
          commercialAction: 'none' as const,
          productCardsPolicy: 'none' as const,
          mustAnswerNow: ['Compare gasoline vs diesel for the buyer context.', 'Explain the risk of selecting a generator without reserve.'],
          currentFocus: 'generator comparison',
          cardsRole: 'none' as const,
          leadAllowed: true,
          leadAllowedReason: 'technical comparison only',
          errorRecoveryPriority: 'answer comparison first',
          confidence: 0.94
        }
      },
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
      },
      agentDecision: {
        answerTask: 'product_selection' as const,
        taskType: 'product_selection' as const,
        catalogAction: 'find_matching_products' as const,
        commercialAction: 'none' as const,
        productCardsPolicy: 'show_matching_products' as const,
        mustAnswerNow: ['show generator variants from the catalog'],
        currentFocus: 'generator',
        cardsRole: 'primary' as const,
        leadAllowed: true,
        leadAllowedReason: 'buyer asks for catalog variants',
        errorRecoveryPriority: 'show product cards',
        confidence: 0.93
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

  it('does not upgrade contradictory catalog lookup contracts without LLM card policy', () => {
    const contradictoryPlan = {
      ...basePlan,
      action: 'answer_question',
      answerMode: 'short',
      cardPolicy: 'textOnly',
      selectedProductIds: [],
      selectionState: {
        shouldShowCards: false
      },
      agentDecision: {
        answerTask: 'product_selection' as const,
        taskType: 'pure_availability' as const,
        catalogAction: 'find_matching_products' as const,
        commercialAction: 'none' as const,
        productCardsPolicy: 'none' as const,
        mustAnswerNow: ['show matching TSS generator variants from the catalog'],
        currentFocus: 'generator',
        cardsRole: 'none' as const,
        leadAllowed: false,
        leadAllowedReason: 'buyer asks for variants, not contact',
        errorRecoveryPriority: 'show catalog variants first',
        confidence: 0.91
      }
    };

    const contract = deriveAgentTurnContract({
      userMessage: '\u0410 \u0447\u0442\u043e \u0435\u0441\u0442\u044c \u043e\u0442 8 \u0434\u043e 10 \u043a\u0412\u0442?',
      plan: contradictoryPlan,
      needState: emptyNeedState()
    });
    const plan = applyAgentTurnContractToPlan(contradictoryPlan, contract);

    expect(contract.catalogAction).toBe('find_matching_products');
    expect(contract.productCardsPolicy).toBe('none');
    expect(contract.cardsRole).toBe('none');
    expect(plan.action).toBe('answer_question');
    expect(plan.cardPolicy).toBe('textOnly');
    expect(plan.selectionState.shouldShowCards).toBe(false);
  });

  it('shows close catalog candidates as supporting cards for exact model lookup', () => {
    const exactLookupPlan = {
      ...basePlan,
      action: 'answer_question',
      answerMode: 'short',
      cardPolicy: 'textOnly',
      selectedProductIds: ['bison-bs3250i'],
      selectionState: {
        shouldShowCards: false
      },
      answerGuidance: 'Точной модели BISON 3250 нет, не показывай карточки.',
      agentDecision: {
        answerTask: 'product_selection' as const,
        taskType: 'pure_availability' as const,
        catalogAction: 'exact_model_lookup' as const,
        commercialAction: 'explain_manager_required' as const,
        productCardsPolicy: 'none' as const,
        mustAnswerNow: ['answer exact model availability and offer close catalog candidate'],
        currentFocus: 'BISON 3250',
        cardsRole: 'none' as const,
        leadAllowed: false,
        leadAllowedReason: 'buyer asked exact model availability only',
        errorRecoveryPriority: 'show close candidate and ask whether it was meant',
        confidence: 0.9
      }
    };

    const contract = deriveAgentTurnContract({
      userMessage: 'BISON 3250 есть у вас?',
      plan: exactLookupPlan,
      needState: emptyNeedState()
    });
    const plan = applyAgentTurnContractToPlan(exactLookupPlan, contract);

    expect(contract.catalogAction).toBe('exact_model_lookup');
    expect(contract.productCardsPolicy).toBe('supporting_only');
    expect(contract.cardsRole).toBe('supporting');
    expect(contract.validatorWarnings).toContain('exact_lookup_candidate_cards_repaired');
    expect(plan.cardPolicy).toBe('showProducts');
    expect(plan.selectionState.shouldShowCards).toBe(true);
    expect(plan.answerGuidance).not.toContain('не показывай карточки');
    expect(plan.answerGuidance).toContain('close model');
  });

  it('keeps product selection with delivery as catalog/card work even when contact handoff is refused', () => {
    const mixedPlan = {
      ...basePlan,
      action: 'collect_lead',
      answerMode: 'leadCollection',
      cardPolicy: 'textOnly',
      followUpPolicy: 'collectLead',
      selectedProductIds: [],
      selectionState: {
        shouldShowCards: false
      },
      agentDecision: {
        answerTask: 'mixed' as const,
        taskType: 'product_selection_with_delivery' as const,
        catalogAction: 'find_matching_products' as const,
        commercialAction: 'explain_manager_required' as const,
        productCardsPolicy: 'show_matching_products' as const,
        mustAnswerNow: ['select matching generators first', 'explain that delivery is calculated by logistics'],
        currentFocus: 'generator',
        cardsRole: 'primary' as const,
        leadAllowed: false,
        leadAllowedReason: 'buyer declined contact but still wants product selection',
        errorRecoveryPriority: 'Continue selection without asking for phone.',
        confidence: 0.95
      }
    };

    const contract = deriveAgentTurnContract({
      userMessage: 'Подберите ТСС 8-10 кВт 220 и посчитайте доставку, номер пока не оставляю',
      plan: mixedPlan,
      needState: emptyNeedState()
    });
    const plan = applyAgentTurnContractToPlan(mixedPlan, contract);

    expect(contract.taskType).toBe('product_selection_with_delivery');
    expect(contract.catalogAction).toBe('find_matching_products');
    expect(contract.productCardsPolicy).toBe('show_matching_products');
    expect(plan.action).toBe('recommend_products');
    expect(plan.answerMode).toBe('productRecommendation');
    expect(plan.cardPolicy).toBe('showProducts');
    expect(plan.followUpPolicy).toBe('answerNowNoDeferredOffer');
    expect(plan.selectionState.shouldShowCards).toBe(true);
  });

  it('repairs contradictory product-selection delivery contracts to run catalog execution', () => {
    const contradictoryPlan = {
      ...basePlan,
      action: 'answer_question',
      answerMode: 'short',
      cardPolicy: 'textOnly',
      answerGuidance: 'Карточки не показывать, точных совпадений нет.',
      selectedProductIds: [],
      selectionState: {
        shouldShowCards: false
      },
      agentDecision: {
        answerTask: 'product_selection' as const,
        taskType: 'product_selection_with_delivery' as const,
        catalogAction: 'verify_catalog_absence' as const,
        commercialAction: 'none' as const,
        productCardsPolicy: 'none' as const,
        mustAnswerNow: ['select catalog products and explain delivery verification'],
        currentFocus: 'generator',
        cardsRole: 'none' as const,
        leadAllowed: false,
        leadAllowedReason: 'buyer is selecting, not leaving contact',
        errorRecoveryPriority: 'do not skip catalog execution for selection turns',
        confidence: 0.9
      }
    };

    const contract = deriveAgentTurnContract({
      userMessage: 'Подберите ТСС 8-10 кВт 220 и посчитайте доставку',
      plan: contradictoryPlan,
      needState: emptyNeedState()
    });
    const plan = applyAgentTurnContractToPlan(contradictoryPlan, contract);

    expect(contract.catalogAction).toBe('find_matching_products');
    expect(contract.productCardsPolicy).toBe('show_matching_products');
    expect(contract.commercialAction).toBe('explain_manager_required');
    expect(contract.cardsRole).toBe('primary');
    expect(contract.validatorWarnings).toEqual(expect.arrayContaining([
      'selection_task_catalog_action_repaired',
      'selection_task_cards_policy_repaired',
      'commercial_action_repaired_for_manager_verification'
    ]));
    expect(plan.action).toBe('recommend_products');
    expect(plan.cardPolicy).toBe('showProducts');
    expect(plan.answerGuidance).not.toContain('Карточки не показывать');
    expect(plan.answerGuidance).toContain('Use the validated catalog selection');
  });
});
