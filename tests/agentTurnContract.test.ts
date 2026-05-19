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
  it('repairs shown-card choice plus delivery so product reasoning stays before the form', () => {
    const message = '\u0414\u043b\u044f \u043c\u043e\u0435\u0433\u043e \u0432\u044a\u0435\u0437\u0434\u0430, \u043d\u0430\u0432\u0435\u0440\u043d\u043e\u0435, \u043b\u0443\u0447\u0448\u0435 \u0447\u0442\u043e-\u0442\u043e \u0432 \u0440\u0430\u0439\u043e\u043d\u0435 70\u201380 \u043a\u0433, \u0447\u0442\u043e\u0431\u044b \u0438 \u043f\u0435\u0441\u043e\u043a, \u0438 \u0449\u0435\u0431\u0435\u043d\u044c \u043d\u043e\u0440\u043c\u0430\u043b\u044c\u043d\u043e \u0442\u0440\u0430\u043c\u0431\u043e\u0432\u0430\u043b\u0430. \u041f\u043e\u0434\u0441\u043a\u0430\u0436\u0438\u0442\u0435, \u0438\u0437 \u044d\u0442\u0438\u0445 \u043a\u0430\u043a\u0430\u044f \u043f\u0440\u0430\u043a\u0442\u0438\u0447\u043d\u0435\u0435 \u0438 \u0435\u0441\u0442\u044c \u043b\u0438 \u043f\u043e \u043d\u0435\u0439 \u0434\u043e\u0441\u0442\u0430\u0432\u043a\u0430?';
    const needState = {
      ...emptyNeedState(),
      selectionState: {
        ...emptyNeedState().selectionState,
        currentProductClass: 'plate',
        targetProductClass: 'plate'
      },
      activeNeeds: [{
        id: 'need_plate',
        productClass: 'plate',
        summary: 'vibroplate 70-80 kg for driveway',
        constraints: ['70-80 kg', 'driveway', 'sand and gravel'],
        openQuestions: [],
        selectedProductIds: [],
        status: 'open',
        updatedAt: '2026-05-19T00:00:00.000Z'
      }]
    } as ReturnType<typeof emptyNeedState>;
    const commercialPlan = {
      ...basePlan,
      action: 'collect_lead',
      answerMode: 'leadCollection',
      cardPolicy: 'textOnly',
      followUpPolicy: 'collectLead',
      agentDecision: {
        answerTask: 'lead_handoff' as const,
        taskType: 'pure_delivery' as const,
        catalogAction: 'none' as const,
        commercialAction: 'explain_manager_required' as const,
        productCardsPolicy: 'none' as const,
        mustAnswerNow: ['explain delivery verification'],
        currentFocus: 'commercial',
        cardsRole: 'none' as const,
        leadAllowed: true,
        leadAllowedReason: 'delivery requires logistics verification',
        errorRecoveryPriority: 'answer delivery safely',
        confidence: 0.83
      }
    };

    const contract = deriveAgentTurnContract({
      userMessage: message,
      plan: commercialPlan,
      needState
    });
    const applied = applyAgentTurnContractToPlan(commercialPlan, contract);

    expect(contract.answerTask).toBe('mixed');
    expect(contract.taskType).toBe('product_selection_with_delivery');
    expect(contract.catalogAction).toBe('find_matching_products');
    expect(contract.productCardsPolicy).toBe('show_matching_products');
    expect(contract.cardsRole).toBe('primary');
    expect(contract.commercialAction).toBe('explain_manager_required');
    expect(contract.mustAnswerNow[0]).toMatch(/product choice/i);
    expect(contract.validatorWarnings).toContain('shown_product_choice_commercial_repaired');
    expect(applied.action).toBe('recommend_products');
    expect(applied.cardPolicy).toBe('showProducts');
    expect(applied.selectionState.shouldShowCards).toBe(true);
  });

  it('keeps pure commercial questions about shown positions as a handoff', () => {
    const message = '\u041f\u043e \u044d\u0442\u0438\u043c \u043f\u043e\u0437\u0438\u0446\u0438\u044f\u043c \u0435\u0441\u0442\u044c \u0434\u043e\u0441\u0442\u0430\u0432\u043a\u0430 \u0438 \u0441\u043a\u0438\u0434\u043a\u0430?';
    const commercialPlan = {
      ...basePlan,
      action: 'collect_lead',
      answerMode: 'leadCollection',
      cardPolicy: 'textOnly',
      followUpPolicy: 'collectLead',
      agentDecision: {
        answerTask: 'lead_handoff' as const,
        taskType: 'pure_delivery' as const,
        catalogAction: 'none' as const,
        commercialAction: 'explain_manager_required' as const,
        productCardsPolicy: 'none' as const,
        mustAnswerNow: ['explain delivery and discount verification'],
        currentFocus: 'commercial',
        cardsRole: 'none' as const,
        leadAllowed: true,
        leadAllowedReason: 'commercial terms require verification',
        errorRecoveryPriority: 'answer commercial terms safely',
        confidence: 0.9
      }
    };

    const contract = deriveAgentTurnContract({
      userMessage: message,
      plan: commercialPlan,
      needState: emptyNeedState()
    });

    expect(contract.answerTask).toBe('lead_handoff');
    expect(contract.taskType).toBe('pure_delivery');
    expect(contract.catalogAction).toBe('none');
    expect(contract.productCardsPolicy).toBe('none');
    expect(contract.validatorWarnings).not.toContain('shown_product_choice_commercial_repaired');
  });

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

  it('keeps no-contact technical summaries text-only even when planner tries to show previous cards', () => {
    const message = 'Пока без звонка. Сначала хочу понять по технике: что сейчас брать по генератору, что по виброплите и какие данные еще надо уточнить.';
    const planWithCards = {
      ...basePlan,
      agentDecision: {
        answerTask: 'product_selection' as const,
        taskType: 'product_selection' as const,
        catalogAction: 'find_matching_products' as const,
        commercialAction: 'none' as const,
        productCardsPolicy: 'show_matching_products' as const,
        mustAnswerNow: ['summarize current generator and plate technical choice'],
        currentFocus: 'technical_summary',
        cardsRole: 'primary' as const,
        leadAllowed: false,
        leadAllowedReason: 'buyer explicitly refused a call and asks for a technical summary',
        errorRecoveryPriority: 'summarize without contact handoff',
        confidence: 0.86
      }
    };

    const contract = deriveAgentTurnContract({
      userMessage: message,
      plan: planWithCards,
      needState: emptyNeedState()
    });
    const applied = applyAgentTurnContractToPlan(planWithCards, contract);

    expect(contract.taskType).toBe('contact_refusal_continue_selection');
    expect(contract.answerTask).toBe('technical_explanation');
    expect(contract.catalogAction).toBe('none');
    expect(contract.productCardsPolicy).toBe('none');
    expect(contract.cardsRole).toBe('none');
    expect(contract.validatorWarnings).toContain('contact_refusal_summary_cards_suppressed');
    expect(applied.cardPolicy).toBe('textOnly');
    expect(applied.selectionState.shouldShowCards).toBe(false);
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

  it('lets mixed product selection with delivery keep cards and request the form', () => {
    const commercialSelectionPlan = {
      ...basePlan,
      action: 'recommend_products',
      answerMode: 'productRecommendation',
      followUpPolicy: 'collectLead',
      agentDecision: {
        answerTask: 'product_selection' as const,
        taskType: 'product_selection_with_delivery' as const,
        catalogAction: 'find_matching_products' as const,
        commercialAction: 'explain_manager_required' as const,
        productCardsPolicy: 'show_matching_products' as const,
        mustAnswerNow: ['show matching generator cards', 'explain that delivery terms require verification'],
        currentFocus: 'generator_delivery',
        cardsRole: 'primary' as const,
        leadAllowed: true,
        leadAllowedReason: 'buyer asks product selection plus delivery verification',
        errorRecoveryPriority: 'show cards and open the form for delivery verification',
        confidence: 0.9
      }
    };

    const contract = deriveAgentTurnContract({
      userMessage: 'Show gasoline 5 kW generators and check delivery to Krasnodar',
      plan: commercialSelectionPlan,
      needState: emptyNeedState()
    });
    const plan = applyAgentTurnContractToPlan(commercialSelectionPlan, contract);

    expect(contract.taskType).toBe('product_selection_with_delivery');
    expect(contract.answerTask).toBe('product_selection');
    expect(contract.commercialAction).toBe('explain_manager_required');
    expect(contract.leadAllowed).toBe(true);
    expect(contract.cardsRole).toBe('primary');
    expect(plan.cardPolicy).toBe('showProducts');
    expect(plan.followUpPolicy).toBe('collectLead');
    expect(plan.selectionState.shouldShowCards).toBe(true);
    expect(contract.validatorWarnings).not.toContain('delivery_selection_lead_allowed_repaired');
  });

  it('keeps explicit contact refusal from opening the commercial form', () => {
    const refusalPlan = {
      ...basePlan,
      action: 'recommend_products',
      answerMode: 'productRecommendation',
      followUpPolicy: 'collectLead',
      agentDecision: {
        answerTask: 'product_selection' as const,
        taskType: 'product_selection_with_availability' as const,
        catalogAction: 'find_matching_products' as const,
        commercialAction: 'explain_manager_required' as const,
        productCardsPolicy: 'show_matching_products' as const,
        mustAnswerNow: ['show matching catalog options', 'explain stock must be verified later'],
        currentFocus: 'generator_availability',
        cardsRole: 'primary' as const,
        leadAllowed: false,
        leadAllowedReason: 'buyer explicitly refuses contact or a call',
        errorRecoveryPriority: 'show catalog options without opening the form',
        confidence: 0.88
      }
    };

    const contract = deriveAgentTurnContract({
      userMessage: 'Show what is available, but no call and no form now',
      plan: refusalPlan,
      needState: emptyNeedState()
    });
    const plan = applyAgentTurnContractToPlan(refusalPlan, contract);

    expect(contract.taskType).toBe('product_selection_with_availability');
    expect(contract.leadAllowed).toBe(false);
    expect(plan.cardPolicy).toBe('showProducts');
    expect(plan.followUpPolicy).toBe('answerNowNoDeferredOffer');
    expect(plan.selectionState.shouldShowCards).toBe(true);
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

  it('turns confirmed exact availability into a contact handoff for stock verification', () => {
    const exactAvailabilityPlan = {
      ...basePlan,
      action: 'recommend_products',
      answerMode: 'productRecommendation',
      followUpPolicy: 'answerNowNoDeferredOffer',
      selectedProductIds: ['bison-bs6250ie'],
      agentDecision: {
        answerTask: 'technical_explanation' as const,
        taskType: 'pure_availability' as const,
        catalogAction: 'exact_model_lookup' as const,
        commercialAction: 'none' as const,
        productCardsPolicy: 'show_exact_matches' as const,
        mustAnswerNow: ['answer whether BISON BS6250IE is in stock'],
        currentFocus: 'BISON BS6250IE availability',
        cardsRole: 'supporting' as const,
        leadAllowed: false,
        leadAllowedReason: 'buyer asks for exact availability, not a callback',
        errorRecoveryPriority: 'separate catalog presence from live stock',
        confidence: 0.94
      }
    };

    const contract = deriveAgentTurnContract({
      userMessage: 'Да он, есть в наличии?',
      plan: exactAvailabilityPlan,
      needState: emptyNeedState()
    });
    const plan = applyAgentTurnContractToPlan(exactAvailabilityPlan, contract);

    expect(contract.answerTask).toBe('lead_handoff');
    expect(contract.taskType).toBe('pure_availability');
    expect(contract.leadAllowed).toBe(true);
    expect(contract.validatorWarnings).toEqual(expect.arrayContaining([
      'commercial_action_repaired_for_manager_verification',
      'availability_handoff_lead_allowed_repaired',
      'availability_handoff_answer_task_repaired'
    ]));
    expect(plan.action).toBe('handoff_specialist');
    expect(plan.answerMode).toBe('leadCollection');
    expect(plan.followUpPolicy).toBe('collectLead');
    expect(plan.cardPolicy).toBe('showProducts');
    expect(plan.answerGuidance).toContain('check the warehouse and call back');
  });

  it('does not ask for contact on exact availability after an explicit contact refusal', () => {
    const exactAvailabilityPlan = {
      ...basePlan,
      action: 'recommend_products',
      selectedProductIds: ['bison-bs6250ie'],
      agentDecision: {
        answerTask: 'technical_explanation' as const,
        taskType: 'pure_availability' as const,
        catalogAction: 'exact_model_lookup' as const,
        commercialAction: 'none' as const,
        productCardsPolicy: 'show_exact_matches' as const,
        mustAnswerNow: ['answer whether BISON BS6250IE is in stock without contact pressure'],
        currentFocus: 'BISON BS6250IE availability',
        cardsRole: 'supporting' as const,
        leadAllowed: false,
        leadAllowedReason: 'buyer explicitly refuses phone contact now',
        errorRecoveryPriority: 'answer without asking for phone',
        confidence: 0.94
      }
    };

    const contract = deriveAgentTurnContract({
      userMessage: 'Номер не оставляю, просто скажите есть ли',
      plan: exactAvailabilityPlan,
      needState: emptyNeedState()
    });
    const plan = applyAgentTurnContractToPlan(exactAvailabilityPlan, contract);

    expect(contract.leadAllowed).toBe(false);
    expect(contract.answerTask).toBe('technical_explanation');
    expect(contract.validatorWarnings).not.toContain('availability_handoff_lead_allowed_repaired');
    expect(plan.followUpPolicy).toBe('answerNowNoDeferredOffer');
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

  it('keeps delivery and discount explanation text-only when buyer asks order of work without choosing new products', () => {
    const commercialPlan = {
      ...basePlan,
      action: 'answer_question',
      answerMode: 'short',
      cardPolicy: 'textOnly',
      followUpPolicy: 'answerNowNoDeferredOffer',
      selectedProductIds: [],
      selectionState: {
        shouldShowCards: false
      },
      agentDecision: {
        answerTask: 'lead_handoff' as const,
        taskType: 'product_selection_with_delivery' as const,
        catalogAction: 'none' as const,
        commercialAction: 'explain_manager_required' as const,
        productCardsPolicy: 'none' as const,
        mustAnswerNow: ['explain delivery to Eysk', 'explain discount depends on final bundle'],
        currentFocus: 'delivery and discount order',
        cardsRole: 'none' as const,
        leadAllowed: false,
        leadAllowedReason: 'buyer explicitly does not want to leave a phone and asks only the order of work',
        errorRecoveryPriority: 'answer delivery and discount process without showing a new catalog shortlist',
        confidence: 0.92
      }
    };

    const contract = deriveAgentTurnContract({
      userMessage: 'Доставка до Ейска и скидка есть, если брать генератор и виброплиту? Номер пока не оставляю, просто хочу понять порядок.',
      plan: commercialPlan,
      needState: emptyNeedState()
    });
    const plan = applyAgentTurnContractToPlan(commercialPlan, contract);

    expect(contract.answerTask).toBe('lead_handoff');
    expect(contract.catalogAction).toBe('none');
    expect(contract.productCardsPolicy).toBe('none');
    expect(contract.cardsRole).toBe('none');
    expect(contract.validatorWarnings).not.toContain('selection_task_cards_policy_repaired');
    expect(plan.action).toBe('answer_question');
    expect(plan.cardPolicy).toBe('textOnly');
    expect(plan.selectionState.shouldShowCards).toBe(false);
  });

  it('keeps delivery selection card-capable while allowing commercial form handoff', () => {
    const mixedPlan = {
      ...basePlan,
      action: 'recommend_products',
      answerMode: 'productRecommendation',
      cardPolicy: 'showProducts',
      followUpPolicy: 'collectLead',
      selectedProductIds: ['single-220'],
      selectionState: {
        shouldShowCards: true
      },
      agentDecision: {
        answerTask: 'product_selection' as const,
        taskType: 'product_selection_with_delivery' as const,
        catalogAction: 'find_matching_products' as const,
        commercialAction: 'offer_contact_after_answer' as const,
        productCardsPolicy: 'show_matching_products' as const,
        mustAnswerNow: ['show matching products and answer delivery limitation'],
        currentFocus: 'generator with delivery',
        cardsRole: 'primary' as const,
        leadAllowed: true,
        leadAllowedReason: 'delivery requested and requires logistics verification after showing products',
        errorRecoveryPriority: 'show cards and request the form for delivery verification',
        confidence: 0.92
      }
    };

    const contract = deriveAgentTurnContract({
      userMessage: 'Подберите ТСС 8-10 кВт 220 и посчитайте доставку до Ейска',
      plan: mixedPlan,
      needState: emptyNeedState()
    });
    const plan = applyAgentTurnContractToPlan(mixedPlan, contract);

    expect(contract.commercialAction).toBe('explain_manager_required');
    expect(contract.leadAllowed).toBe(true);
    expect(contract.validatorWarnings).toEqual(expect.arrayContaining([
      'delivery_selection_commercial_action_repaired'
    ]));
    expect(contract.validatorWarnings).not.toContain('delivery_selection_lead_allowed_repaired');
    expect(plan.followUpPolicy).toBe('collectLead');
    expect(plan.cardPolicy).toBe('showProducts');
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

  it('repairs generator option requests from text-only comparison into catalog selection with cards', () => {
    const textOnlyComparisonPlan = {
      ...basePlan,
      action: 'answer_question',
      answerMode: 'detailedFact',
      cardPolicy: 'textOnly',
      selectedProductIds: [],
      selectionState: {
        shouldShowCards: false
      },
      agentDecision: {
        answerTask: 'comparison' as const,
        taskType: 'comparison' as const,
        catalogAction: 'none' as const,
        commercialAction: 'none' as const,
        productCardsPolicy: 'none' as const,
        mustAnswerNow: ['estimate minimum and reserve generator power'],
        currentFocus: 'generator power sizing',
        cardsRole: 'none' as const,
        leadAllowed: false,
        leadAllowedReason: 'buyer is sizing generator options',
        errorRecoveryPriority: 'answer sizing and keep selection moving',
        confidence: 0.9
      }
    };

    const contract = deriveAgentTurnContract({
      userMessage: 'Уточнил: насос скважинный 220 В, мощность не знаю. Уже можно прикинуть варианты генераторов: минимальный и с запасом?',
      plan: textOnlyComparisonPlan,
      needState: emptyNeedState()
    });
    const plan = applyAgentTurnContractToPlan(textOnlyComparisonPlan, contract);

    expect(contract.answerTask).toBe('mixed');
    expect(contract.taskType).toBe('product_selection');
    expect(contract.catalogAction).toBe('find_matching_products');
    expect(contract.productCardsPolicy).toBe('show_matching_products');
    expect(contract.cardsRole).toBe('primary');
    expect(contract.validatorWarnings).toContain('generator_option_selection_repaired');
    expect(plan.action).toBe('recommend_products');
    expect(plan.cardPolicy).toBe('showProducts');
  });

  it('switches from a stale generator clarification to a new plate selection turn', () => {
    const generatorClarificationState = {
      ...emptyNeedState(),
      activeNeeds: [{
        id: 'generator',
        productClass: 'generator' as const,
        summary: 'home backup generator; pump power still unknown',
        constraints: [],
        openQuestions: ['pump type and power'],
        selectedProductIds: [],
        status: 'open' as const,
        updatedAt: '2026-05-17T00:00:00.000Z'
      }],
      selectionState: {
        ...emptyNeedState().selectionState,
        currentProductClass: 'generator' as const,
        targetProductClass: 'generator' as const,
        hardConstraints: {
          ...emptyNeedState().selectionState.hardConstraints,
          productIntent: 'generator' as const
        }
      }
    };
    const staleTextOnlyPlan = {
      ...basePlan,
      action: 'answer_question',
      answerMode: 'short',
      cardPolicy: 'textOnly',
      selectedProductIds: [],
      selectionState: {
        shouldShowCards: false
      },
      agentDecision: {
        answerTask: 'technical_explanation' as const,
        taskType: 'technical_answer' as const,
        catalogAction: 'none' as const,
        commercialAction: 'none' as const,
        productCardsPolicy: 'none' as const,
        mustAnswerNow: ['wait for pump details before generator selection'],
        currentFocus: 'generator',
        cardsRole: 'none' as const,
        leadAllowed: false,
        leadAllowedReason: 'previous generator clarification is still open',
        errorRecoveryPriority: 'ask pump question',
        confidence: 0.88
      }
    };

    const contract = deriveAgentTurnContract({
      userMessage: 'Еще нужна виброплита для въезда: основание щебень с песком, сверху будет плитка. Нужен не профессиональный монстр, а нормальный вариант для частного участка.',
      plan: staleTextOnlyPlan,
      needState: generatorClarificationState
    });
    const plan = applyAgentTurnContractToPlan(staleTextOnlyPlan, contract);

    expect(contract.currentFocus).toBe('plate');
    expect(contract.answerTask).toBe('mixed');
    expect(contract.taskType).toBe('product_selection');
    expect(contract.catalogAction).toBe('find_matching_products');
    expect(contract.productCardsPolicy).toBe('show_matching_products');
    expect(contract.cardsRole).toBe('primary');
    expect(contract.validatorWarnings).toContain('product_option_selection_repaired');
    expect(plan.action).toBe('recommend_products');
    expect(plan.cardPolicy).toBe('showProducts');
    expect(plan.selectionState.shouldShowCards).toBe(true);
  });
});
