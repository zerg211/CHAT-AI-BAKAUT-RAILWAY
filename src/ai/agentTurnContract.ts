import type { AgentTurnContract, CustomerNeedState } from '../shared/types.js';

type PlannerLike = {
  action: string;
  answerMode: string;
  cardPolicy: string;
  followUpPolicy: string;
  selectedProductIds: string[];
  answerGuidance?: string;
  agentDecision?: Partial<Pick<
    AgentTurnContract,
    | 'answerTask'
    | 'taskType'
    | 'catalogAction'
    | 'commercialAction'
    | 'productCardsPolicy'
    | 'mustAnswerNow'
    | 'currentFocus'
    | 'cardsRole'
    | 'leadAllowed'
    | 'leadAllowedReason'
    | 'errorRecoveryPriority'
  >> & { confidence?: number };
  selectionState?: {
    shouldShowCards?: boolean;
  };
};

function compactActiveNeeds(state: CustomerNeedState) {
  return (state.activeNeeds ?? []).map((need) => ({
    id: need.id,
    productClass: need.productClass,
    summary: need.summary
  }));
}

function defaultCurrentFocus(state: CustomerNeedState) {
  const selectionTarget = state.selectionState?.targetProductClass;
  if (selectionTarget && selectionTarget !== 'unknown') return selectionTarget;
  const selectionCurrent = state.selectionState?.currentProductClass;
  if (selectionCurrent && selectionCurrent !== 'unknown') return selectionCurrent;
  return state.activeNeeds?.find((need) => need.status === 'open')?.id ?? 'latest_message';
}

function contactRefusalText(value: string) {
  return /(?:номер|телефон|контакт|звон|перезвон)[^.!?\n]{0,80}(?:не\s+(?:остав|даю|надо|нуж|хоч)|пока\s+не)|(?:не\s+(?:остав|даю|надо|нуж|хоч)[^.!?\n]{0,80}(?:номер|телефон|контакт|звон|перезвон))|(?:без|пока\s+без)\s+(?:звон|перезвон|контакт|телефон|номера)/iu.test(value);
}

function isGeneratorCatalogOptionRequest(userMessage: string, state: CustomerNeedState) {
  const text = userMessage.toLocaleLowerCase('ru');
  const generatorContext =
    /(?:\u0433\u0435\u043d\u0435\u0440\u0430\u0442|\u044d\u043b\u0435\u043a\u0442\u0440\u043e\u0441\u0442\u0430\u043d\u0446|generator)/iu.test(text) ||
    state.selectionState?.targetProductClass === 'generator' ||
    state.selectionState?.currentProductClass === 'generator' ||
    (state.activeNeeds ?? []).some((need) => need.status !== 'closed' && need.productClass === 'generator');
  if (!generatorContext) return false;
  const asksForCatalogOptions = /(?:\u0432\u0430\u0440\u0438\u0430\u043d\u0442|\u043c\u043e\u0434\u0435\u043b|\u043a\u0430\u0440\u0442\u043e\u0447|\u043f\u043e\u0434\u0431\u0435\u0440|\u043f\u043e\u0441\u043c\u043e\u0442\u0440|\u0447\u0442\u043e\s+\u0432\u0437\u044f\u0442|\u043a\u0430\u043a\u043e\u0439\s+\u0432\u0437\u044f\u0442|\u043c\u043e\u0436\u043d\u043e\s+\u043f\u0440\u0438\u043a\u0438\u043d|\u0441\s+\u0437\u0430\u043f\u0430\u0441|\u043c\u0438\u043d\u0438\u043c\u0430\u043b)/iu.test(text);
  if (!asksForCatalogOptions) return false;
  const commercialOnly = /(?:\u0434\u043e\u0441\u0442\u0430\u0432|\u0441\u043a\u0438\u0434|\u043d\u0430\u043b\u0438\u0447|\u0441\u043a\u043b\u0430\u0434|\u043e\u0442\u0433\u0440\u0443\u0437|\u0443\u0441\u043b\u043e\u0432)/iu.test(text) &&
    !/(?:\u0432\u0430\u0440\u0438\u0430\u043d\u0442|\u043c\u043e\u0434\u0435\u043b|\u043f\u043e\u0434\u0431\u0435\u0440|\u0433\u0435\u043d\u0435\u0440\u0430\u0442)/iu.test(text);
  return !commercialOnly;
}

function coerceSemanticAgentDecision(plan: PlannerLike, state: CustomerNeedState, userMessage: string): AgentTurnContract | null {
  const decision = plan.agentDecision;
  if (!decision) return null;

  const answerTasks: AgentTurnContract['answerTask'][] = [
    'technical_explanation',
    'comparison',
    'product_selection',
    'mixed',
    'lead_handoff'
  ];
  const taskTypes: NonNullable<AgentTurnContract['taskType']>[] = [
    'pure_delivery',
    'pure_availability',
    'product_selection',
    'product_selection_with_delivery',
    'product_selection_with_availability',
    'technical_answer',
    'comparison',
    'contact_refusal_continue_selection'
  ];
  const catalogActions: NonNullable<AgentTurnContract['catalogAction']>[] = [
    'none',
    'exact_model_lookup',
    'find_matching_products',
    'verify_catalog_absence'
  ];
  const commercialActions: NonNullable<AgentTurnContract['commercialAction']>[] = [
    'none',
    'explain_manager_required',
    'offer_contact_after_answer'
  ];
  const productCardsPolicies: NonNullable<AgentTurnContract['productCardsPolicy']>[] = [
    'none',
    'show_exact_matches',
    'show_matching_products',
    'supporting_only'
  ];
  const cardsRoles: AgentTurnContract['cardsRole'][] = ['none', 'supporting', 'primary'];
  let taskType = taskTypes.includes(decision.taskType as NonNullable<AgentTurnContract['taskType']>)
    ? decision.taskType as NonNullable<AgentTurnContract['taskType']>
    : undefined;
  let explicitAnswerTask = answerTasks.includes(decision.answerTask as AgentTurnContract['answerTask'])
    ? decision.answerTask as AgentTurnContract['answerTask']
    : undefined;
  const generatorOptionSelectionRepair = isGeneratorCatalogOptionRequest(userMessage, state) &&
    (taskType === 'comparison' ||
      taskType === 'technical_answer' ||
      explicitAnswerTask === 'comparison' ||
      explicitAnswerTask === 'technical_explanation' ||
      decision.catalogAction === 'none' ||
      decision.productCardsPolicy === 'none' ||
      decision.cardsRole === 'none');
  if (generatorOptionSelectionRepair) {
    taskType = 'product_selection';
    explicitAnswerTask = 'mixed';
  }
  const deliverySelectionDefaultsToCatalog = explicitAnswerTask !== 'lead_handoff' && (
    taskType === 'product_selection_with_delivery' ||
    taskType === 'product_selection_with_availability'
  );
  const selectionTaskRequiresCatalog = taskType === 'product_selection' ||
    deliverySelectionDefaultsToCatalog;
  const rawCatalogAction = catalogActions.includes(decision.catalogAction as NonNullable<AgentTurnContract['catalogAction']>)
    ? decision.catalogAction as NonNullable<AgentTurnContract['catalogAction']>
    : taskType === 'pure_delivery' || taskType === 'technical_answer' || taskType === 'comparison'
      ? 'none'
      : taskType === 'pure_availability'
        ? 'exact_model_lookup'
          : taskType === 'product_selection' ||
            deliverySelectionDefaultsToCatalog ||
            taskType === 'contact_refusal_continue_selection'
            ? 'find_matching_products'
            : undefined;
  const catalogAction = selectionTaskRequiresCatalog && rawCatalogAction !== 'find_matching_products'
    ? 'find_matching_products'
    : rawCatalogAction;
  const rawCommercialAction = commercialActions.includes(decision.commercialAction as NonNullable<AgentTurnContract['commercialAction']>)
    ? decision.commercialAction as NonNullable<AgentTurnContract['commercialAction']>
    : taskType === 'pure_delivery' || taskType === 'pure_availability' || taskType === 'product_selection_with_delivery' || taskType === 'product_selection_with_availability'
      ? 'explain_manager_required'
      : 'none';
  const commercialAction = (taskType === 'pure_delivery' ||
    taskType === 'pure_availability' ||
    taskType === 'product_selection_with_delivery' ||
    taskType === 'product_selection_with_availability') &&
    rawCommercialAction === 'none'
    ? 'explain_manager_required'
    : rawCommercialAction;
  const hasExplicitProductCardsPolicy = productCardsPolicies.includes(decision.productCardsPolicy as NonNullable<AgentTurnContract['productCardsPolicy']>);
  const rawProductCardsPolicy = hasExplicitProductCardsPolicy
    ? decision.productCardsPolicy as NonNullable<AgentTurnContract['productCardsPolicy']>
    : catalogAction === 'exact_model_lookup'
      ? 'show_exact_matches'
      : catalogAction === 'find_matching_products'
        ? 'show_matching_products'
        : 'none';
  const exactLookupHasSelectedCandidate = catalogAction === 'exact_model_lookup' && plan.selectedProductIds.length > 0;
  const productCardsPolicy = selectionTaskRequiresCatalog && rawProductCardsPolicy === 'none'
    ? 'show_matching_products'
    : exactLookupHasSelectedCandidate && rawProductCardsPolicy === 'none'
      ? 'supporting_only'
      : rawProductCardsPolicy;
  const exactAvailabilityNeedsContact = taskType === 'pure_availability' &&
    rawProductCardsPolicy === 'show_exact_matches' &&
    plan.selectedProductIds.length > 0 &&
    commercialAction === 'explain_manager_required';
  const contactRefused = contactRefusalText(`${userMessage}\n${String(decision.leadAllowedReason ?? '')}`);
  const rawLeadAllowed = typeof decision.leadAllowed === 'boolean' ? decision.leadAllowed : true;
  const preliminaryAnswerTask = explicitAnswerTask
    ?? (taskType === 'comparison'
      ? 'comparison'
      : taskType === 'technical_answer'
        ? 'technical_explanation'
        : taskType === 'pure_delivery' || taskType === 'pure_availability'
          ? 'lead_handoff'
          : taskType === 'product_selection'
            ? 'product_selection'
        : 'mixed');
  const preliminarySelectionDeliveryStillSelecting = taskType === 'product_selection_with_delivery' && preliminaryAnswerTask !== 'lead_handoff';
  const leadAllowed = preliminarySelectionDeliveryStillSelecting
    ? false
    : exactAvailabilityNeedsContact && !contactRefused
      ? true
      : rawLeadAllowed;
  const answerTask = exactAvailabilityNeedsContact && leadAllowed
    ? 'lead_handoff'
    : preliminaryAnswerTask;
  const selectionDeliveryStillSelecting = taskType === 'product_selection_with_delivery' && answerTask !== 'lead_handoff';
  const effectiveCommercialAction = selectionDeliveryStillSelecting && commercialAction === 'offer_contact_after_answer'
    ? 'explain_manager_required'
    : commercialAction;
  const inferredCardsRole: AgentTurnContract['cardsRole'] = productCardsPolicy === 'show_matching_products'
    ? 'primary'
    : productCardsPolicy === 'show_exact_matches' || productCardsPolicy === 'supporting_only'
      ? 'supporting'
      : answerTask === 'product_selection'
        ? 'primary'
        : answerTask === 'mixed'
          ? 'supporting'
          : 'none';
  const rawCardsRole = cardsRoles.includes(decision.cardsRole as AgentTurnContract['cardsRole'])
    ? decision.cardsRole as AgentTurnContract['cardsRole']
    : inferredCardsRole;
  const cardsRole = rawCardsRole === 'none' && productCardsPolicy !== 'none'
    ? inferredCardsRole
    : rawCardsRole;
  const mustAnswerNow = Array.isArray(decision.mustAnswerNow)
    ? decision.mustAnswerNow.map((item) => String(item).trim()).filter(Boolean).slice(0, 8)
    : [];
  const validatorWarnings: string[] = ['contract_source:llm_planner'];

  if ((answerTask === 'comparison' || answerTask === 'technical_explanation') && plan.action === 'recommend_products') {
    validatorWarnings.push('planner_catalog_shortlist_reduced_to_supporting');
  }
  if (!leadAllowed && (plan.answerMode === 'leadCollection' || plan.followUpPolicy === 'collectLead')) {
    validatorWarnings.push('lead_refusal_from_llm_contract');
  }
  if (cardsRole === 'primary' && plan.cardPolicy === 'textOnly') {
    validatorWarnings.push('llm_contract_wants_cards_but_plan_text_only');
  }
  if (selectionTaskRequiresCatalog && rawCatalogAction !== catalogAction) {
    validatorWarnings.push('selection_task_catalog_action_repaired');
  }
  if (selectionTaskRequiresCatalog && rawProductCardsPolicy !== productCardsPolicy) {
    validatorWarnings.push('selection_task_cards_policy_repaired');
  }
  if (exactLookupHasSelectedCandidate && rawProductCardsPolicy === 'none') {
    validatorWarnings.push('exact_lookup_candidate_cards_repaired');
  }
  if (rawCommercialAction !== commercialAction) {
    validatorWarnings.push('commercial_action_repaired_for_manager_verification');
  }
  if (effectiveCommercialAction !== commercialAction) {
    validatorWarnings.push('delivery_selection_commercial_action_repaired');
  }
  if (leadAllowed !== rawLeadAllowed) {
    validatorWarnings.push(exactAvailabilityNeedsContact ? 'availability_handoff_lead_allowed_repaired' : 'delivery_selection_lead_allowed_repaired');
  }
  if (answerTask !== explicitAnswerTask && exactAvailabilityNeedsContact && leadAllowed) {
    validatorWarnings.push('availability_handoff_answer_task_repaired');
  }
  if (generatorOptionSelectionRepair) {
    validatorWarnings.push('generator_option_selection_repaired');
  }

  return {
    answerTask,
    taskType,
    catalogAction,
    commercialAction: effectiveCommercialAction,
    productCardsPolicy,
    mustAnswerNow,
    activeNeeds: compactActiveNeeds(state),
    currentFocus: String(decision.currentFocus ?? '').trim() || defaultCurrentFocus(state),
    cardsRole,
    leadAllowed,
    leadAllowedReason: String(decision.leadAllowedReason ?? '').trim() || (leadAllowed ? 'llm_allows_contact_handoff' : 'llm_detected_no_contact_handoff_now'),
    errorRecoveryPriority: String(decision.errorRecoveryPriority ?? '').trim() || mustAnswerNow[0] || 'Give a concise answer to the latest user question from the current validated context.',
    validatorWarnings
  };
}

export function deriveAgentTurnContract(input: {
  userMessage: string;
  plan: PlannerLike;
  needState: CustomerNeedState;
}): AgentTurnContract {
  const { plan, needState } = input;
  const semanticContract = coerceSemanticAgentDecision(plan, needState, input.userMessage);
  if (semanticContract) return semanticContract;

  const validatorWarnings: string[] = ['contract_source:missing_llm_contract'];

  return {
    answerTask: 'mixed',
    catalogAction: 'none',
    productCardsPolicy: 'none',
    mustAnswerNow: [],
    activeNeeds: compactActiveNeeds(needState),
    currentFocus: defaultCurrentFocus(needState),
    cardsRole: 'none',
    leadAllowed: true,
    leadAllowedReason: 'planner_missing_semantic_contract',
    errorRecoveryPriority: 'Missing semantic turn contract. Answer text-only from validated context; do not infer product intent, select products, or show cards from phrase patterns.',
    validatorWarnings
  };
}

export function applyAgentTurnContractToPlan<T extends PlannerLike>(plan: T, contract: AgentTurnContract): T {
  const contractRepaired = contract.validatorWarnings.some((warning) => warning.includes('_repaired'));
  const originalGuidance = contractRepaired ? undefined : (plan as { answerGuidance?: string }).answerGuidance;
  const catalogRequiresCards = contract.productCardsPolicy === 'show_matching_products' ||
    contract.productCardsPolicy === 'show_exact_matches';
  const shouldRecommendFromCatalog = catalogRequiresCards &&
    (contract.answerTask === 'product_selection' ||
      contract.answerTask === 'mixed' ||
      contract.taskType === 'product_selection' ||
      contract.taskType === 'product_selection_with_delivery' ||
      contract.taskType === 'product_selection_with_availability' ||
      contract.taskType === 'contact_refusal_continue_selection');
  const shouldShowCatalogCards = shouldRecommendFromCatalog ||
    contract.productCardsPolicy === 'show_exact_matches' ||
    contract.productCardsPolicy === 'supporting_only';
  const exactAvailabilityHandoff = contract.leadAllowed &&
    contract.answerTask === 'lead_handoff' &&
    contract.taskType === 'pure_availability' &&
    contract.commercialAction === 'explain_manager_required';

  if (contract.answerTask === 'lead_handoff') {
    return {
      ...plan,
      action: shouldRecommendFromCatalog
        ? 'recommend_products'
        : exactAvailabilityHandoff
          ? 'handoff_specialist'
          : shouldShowCatalogCards
            ? 'answer_question'
            : contract.leadAllowed ? plan.action : 'answer_question',
      answerMode: shouldRecommendFromCatalog
        ? 'productRecommendation'
        : exactAvailabilityHandoff
          ? 'leadCollection'
          : shouldShowCatalogCards
          ? 'short'
        : contract.leadAllowed
          ? plan.answerMode
          : plan.answerMode === 'leadCollection' ? 'short' : plan.answerMode,
      cardPolicy: shouldShowCatalogCards ? 'showProducts' : contract.cardsRole === 'none' ? 'textOnly' : plan.cardPolicy,
      followUpPolicy: exactAvailabilityHandoff
        ? 'collectLead'
        : contract.leadAllowed ? plan.followUpPolicy : 'answerNowNoDeferredOffer',
      selectionState: {
        ...plan.selectionState,
        shouldShowCards: shouldShowCatalogCards || contract.cardsRole === 'primary'
      },
      answerGuidance: [
        originalGuidance,
        contractRepaired
          ? 'AgentTurnContract repaired a contradictory planner decision. Ignore any earlier guidance that says not to show cards, claims no exact matches without catalog evidence, or asks to broaden before using validated catalog matches.'
          : undefined,
        contract.leadAllowed
          ? exactAvailabilityHandoff
            ? 'AgentTurnContract treats exact availability as a stock-verification handoff. Say the catalog card is present, do not promise live stock, and ask for name and phone so the BAKAUT AI manager can check the warehouse and call back with the answer.'
            : 'AgentTurnContract treats this as a commercial/specialist handoff. Answer the buyer question first, do not show catalog cards unless cardsRole is primary, then ask for contact only if the specialist is needed for final delivery/discount/availability terms.'
          : 'Buyer does not want a call/contact handoff now. Answer the useful summary and do not ask for a phone as the main answer.'
      ].filter(Boolean).join('\n')
    };
  }
  if (shouldRecommendFromCatalog || (contract.answerTask === 'product_selection' && contract.cardsRole === 'primary')) {
    return {
      ...plan,
      action: 'recommend_products',
      answerMode: 'productRecommendation',
      cardPolicy: 'showProducts',
      followUpPolicy: contract.leadAllowed ? plan.followUpPolicy : 'answerNowNoDeferredOffer',
      selectionState: {
        ...plan.selectionState,
        shouldShowCards: true
      },
      answerGuidance: [
        originalGuidance,
        contractRepaired
          ? 'AgentTurnContract repaired a contradictory planner decision. Use the validated catalog selection and do not repeat stale guidance that says cards should be hidden or matching products are absent.'
          : undefined,
        contract.leadAllowed
          ? 'AgentTurnContract treats this turn as product selection. Use validated catalog selection as primary output and show product cards when validators allow it.'
          : 'Buyer refused contact handoff, not catalog selection. Continue product selection with validated cards, but do not ask for a phone as the main answer.'
      ].filter(Boolean).join('\n')
    };
  }
  if (shouldShowCatalogCards) {
    return {
      ...plan,
      action: plan.action === 'collect_lead' || plan.action === 'handoff_specialist' ? 'answer_question' : plan.action,
      answerMode: plan.answerMode === 'leadCollection' ? 'short' : plan.answerMode,
      cardPolicy: 'showProducts',
      followUpPolicy: contract.leadAllowed ? plan.followUpPolicy : 'answerNowNoDeferredOffer',
      selectionState: {
        ...plan.selectionState,
        shouldShowCards: true
      },
      answerGuidance: [
        originalGuidance,
        contractRepaired
          ? 'AgentTurnContract found catalog candidates for an exact lookup. Show them as supporting alternatives, do not claim the conversation is finished by absence of the exact spelling, and ask whether the buyer meant the close model.'
          : undefined,
        'Use shown cards only as supporting catalog evidence for the direct answer; do not turn the answer into a broad product selection.'
      ].filter(Boolean).join('\n')
    };
  }
  if (contract.answerTask === 'comparison' || contract.answerTask === 'technical_explanation') {
    return {
      ...plan,
      action: 'answer_question',
      answerMode: 'detailedFact',
      cardPolicy: contract.cardsRole === 'none' ? 'textOnly' : plan.cardPolicy,
      followUpPolicy: 'answerNowNoDeferredOffer',
      selectionState: {
        ...plan.selectionState,
        shouldShowCards: contract.cardsRole !== 'none'
      },
      answerGuidance: [
        originalGuidance,
        `AgentTurnContract requires answering now: ${contract.mustAnswerNow.join('; ') || contract.errorRecoveryPriority}. CardsRole=${contract.cardsRole}; cards cannot replace the text answer.`
      ].filter(Boolean).join('\n')
    };
  }
  if (!contract.leadAllowed) {
    return {
      ...plan,
      action: 'answer_question',
      answerMode: plan.answerMode === 'leadCollection' ? 'short' : plan.answerMode,
      followUpPolicy: 'answerNowNoDeferredOffer',
      selectionState: {
        ...plan.selectionState,
        shouldShowCards: contract.cardsRole === 'primary'
      },
      answerGuidance: [
        originalGuidance,
        'Buyer refused to leave contact or form now. Give the useful technical/commercial summary and do not ask for a phone as the main answer.'
      ].filter(Boolean).join('\n')
    };
  }
  return plan;
}
