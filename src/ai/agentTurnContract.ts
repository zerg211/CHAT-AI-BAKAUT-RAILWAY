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

function coerceSemanticAgentDecision(plan: PlannerLike, state: CustomerNeedState): AgentTurnContract | null {
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
  const taskType = taskTypes.includes(decision.taskType as NonNullable<AgentTurnContract['taskType']>)
    ? decision.taskType as NonNullable<AgentTurnContract['taskType']>
    : undefined;
  const catalogAction = catalogActions.includes(decision.catalogAction as NonNullable<AgentTurnContract['catalogAction']>)
    ? decision.catalogAction as NonNullable<AgentTurnContract['catalogAction']>
    : taskType === 'pure_delivery' || taskType === 'technical_answer' || taskType === 'comparison'
      ? 'none'
      : taskType === 'pure_availability'
        ? 'exact_model_lookup'
        : taskType === 'product_selection' ||
          taskType === 'product_selection_with_delivery' ||
          taskType === 'product_selection_with_availability' ||
          taskType === 'contact_refusal_continue_selection'
          ? 'find_matching_products'
          : undefined;
  const commercialAction = commercialActions.includes(decision.commercialAction as NonNullable<AgentTurnContract['commercialAction']>)
    ? decision.commercialAction as NonNullable<AgentTurnContract['commercialAction']>
    : taskType === 'pure_delivery' || taskType === 'pure_availability' || taskType === 'product_selection_with_delivery' || taskType === 'product_selection_with_availability'
      ? 'explain_manager_required'
      : 'none';
  const rawProductCardsPolicy = productCardsPolicies.includes(decision.productCardsPolicy as NonNullable<AgentTurnContract['productCardsPolicy']>)
    ? decision.productCardsPolicy as NonNullable<AgentTurnContract['productCardsPolicy']>
    : catalogAction === 'exact_model_lookup'
      ? 'show_exact_matches'
      : catalogAction === 'find_matching_products'
        ? 'show_matching_products'
        : 'none';
  const productCardsPolicy = rawProductCardsPolicy === 'none' && catalogAction === 'exact_model_lookup'
    ? 'show_exact_matches'
    : rawProductCardsPolicy === 'none' && catalogAction === 'find_matching_products'
      ? 'show_matching_products'
      : rawProductCardsPolicy;
  const answerTask = answerTasks.includes(decision.answerTask as AgentTurnContract['answerTask'])
    ? decision.answerTask as AgentTurnContract['answerTask']
    : taskType === 'comparison'
      ? 'comparison'
      : taskType === 'technical_answer'
        ? 'technical_explanation'
        : taskType === 'pure_delivery' || taskType === 'pure_availability'
          ? 'lead_handoff'
          : taskType === 'product_selection'
            ? 'product_selection'
            : 'mixed';
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
  const leadAllowed = typeof decision.leadAllowed === 'boolean' ? decision.leadAllowed : true;
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
  if (rawProductCardsPolicy === 'none' && productCardsPolicy !== 'none') {
    validatorWarnings.push('product_cards_policy_upgraded_from_catalog_action');
  }

  return {
    answerTask,
    taskType,
    catalogAction,
    commercialAction,
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
  const semanticContract = coerceSemanticAgentDecision(plan, needState);
  if (semanticContract) return semanticContract;

  const validatorWarnings: string[] = ['contract_source:missing_llm_contract'];
  const cardsRole: AgentTurnContract['cardsRole'] = plan.action === 'recommend_products' && plan.cardPolicy === 'showProducts'
    ? 'supporting'
    : 'none';

  return {
    answerTask: 'mixed',
    mustAnswerNow: [],
    activeNeeds: compactActiveNeeds(needState),
    currentFocus: defaultCurrentFocus(needState),
    cardsRole,
    leadAllowed: true,
    leadAllowedReason: 'planner_missing_semantic_contract',
    errorRecoveryPriority: 'Missing semantic turn contract. Use validated state and catalog facts; do not infer intent from phrase patterns.',
    validatorWarnings
  };
}

export function applyAgentTurnContractToPlan<T extends PlannerLike>(plan: T, contract: AgentTurnContract): T {
  const catalogRequiresCards = contract.catalogAction === 'find_matching_products' ||
    contract.productCardsPolicy === 'show_matching_products' ||
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

  if (contract.answerTask === 'lead_handoff') {
    return {
      ...plan,
      action: shouldRecommendFromCatalog ? 'recommend_products' : shouldShowCatalogCards ? 'answer_question' : contract.leadAllowed ? plan.action : 'answer_question',
      answerMode: shouldRecommendFromCatalog
        ? 'productRecommendation'
        : shouldShowCatalogCards
          ? 'short'
        : contract.leadAllowed
          ? plan.answerMode
          : plan.answerMode === 'leadCollection' ? 'short' : plan.answerMode,
      cardPolicy: shouldShowCatalogCards ? 'showProducts' : contract.cardsRole === 'none' ? 'textOnly' : plan.cardPolicy,
      followUpPolicy: contract.leadAllowed ? plan.followUpPolicy : 'answerNowNoDeferredOffer',
      selectionState: {
        ...plan.selectionState,
        shouldShowCards: shouldShowCatalogCards || contract.cardsRole === 'primary'
      },
      answerGuidance: [
        (plan as { answerGuidance?: string }).answerGuidance,
        contract.leadAllowed
          ? 'AgentTurnContract treats this as a commercial/specialist handoff. Answer the buyer question first, do not show catalog cards unless cardsRole is primary, then ask for contact only if the specialist is needed for final delivery/discount/availability terms.'
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
        (plan as { answerGuidance?: string }).answerGuidance,
        contract.leadAllowed
          ? 'AgentTurnContract treats this turn as product selection. Use validated catalog selection as primary output and show product cards when validators allow it.'
          : 'Buyer refused contact handoff, not catalog selection. Continue product selection with validated cards, but do not ask for a phone as the main answer.'
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
        (plan as { answerGuidance?: string }).answerGuidance,
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
        (plan as { answerGuidance?: string }).answerGuidance,
        'Buyer refused to leave contact or form now. Give the useful technical/commercial summary and do not ask for a phone as the main answer.'
      ].filter(Boolean).join('\n')
    };
  }
  return plan;
}
