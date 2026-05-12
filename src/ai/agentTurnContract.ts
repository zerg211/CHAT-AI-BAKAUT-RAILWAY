import type { AgentTurnContract, CustomerNeedState, ProductSelectionClass } from '../shared/types.js';

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

const re = (pattern: string, flags = 'iu') => new RegExp(pattern, flags);

const comparisonRe = re(String.raw`(?:\u0441\u0440\u0430\u0432\u043d|compare|\u0447\u0442\u043e\s+\u043b\u0443\u0447\u0448|\u0431\u0435\u043d\u0437\u0438\u043d.{0,80}\u0434\u0438\u0437\u0435\u043b|\u0434\u0438\u0437\u0435\u043b.{0,80}\u0431\u0435\u043d\u0437\u0438\u043d|\u0431\u0435\u0437\s+\u0437\u0430\u043f\u0430\u0441)`);
const techRe = re(String.raw`(?:\u0430\u0432\u0440|avr|\u0430\u0432\u0442\u043e\u0437\u0430\u043f\u0443\u0441\u043a|\u043e\u0431\u0441\u043b\u0443\u0436|\u044d\u043a\u0441\u043f\u043b\u0443\u0430\u0442|\u043f\u0443\u0441\u043a\u043e\u0432|\u0444\u0430\u0437|\u043a\u0432\u0442|\u043d\u0430\u0433\u0440\u0443\u0437|\u043c\u043e\u0449\u043d\u043e\u0441\u0442|\u0440\u0438\u0441\u043a)`);
const productSelectionRe = re(String.raw`(?:\u043f\u043e\u0434\u0431\u0435\u0440|\u043f\u043e\u0441\u043e\u0432\u0435\u0442|\u043f\u043e\u043a\u0430\u0436|\u0432\u0430\u0440\u0438\u0430\u043d\u0442|\u043c\u043e\u0434\u0435\u043b|\u043d\u0443\u0436\u0435\u043d|\u043d\u0443\u0436\u043d\u0430)`);
const leadRe = re(String.raw`(?:\u0434\u043e\u0441\u0442\u0430\u0432\u043a|\u043d\u0430\u043b\u0438\u0447|\u0441\u043a\u0438\u0434\u043a|\u0441\u043f\u0435\u0446\u0443\u0441\u043b\u043e\u0432|\u043e\u0444\u043e\u0440\u043c|\u0437\u0430\u043a\u0430\u0437|\u043a\u0443\u043f\u0438\u0442|\u043f\u0435\u0440\u0435\u0437\u0432\u043e\u043d|\u043b\u043e\u0433\u0438\u0441\u0442)`);
const generatorRe = re(String.raw`(?:\u0433\u0435\u043d\u0435\u0440\u0430\u0442\u043e\u0440|\u044d\u043b\u0435\u043a\u0442\u0440\u043e\u0441\u0442\u0430\u043d\u0446)`);
const plateRe = re(String.raw`(?:\u0432\u0438\u0431\u0440\u043e\u043f\u043b\u0438\u0442|\u043f\u043b\u0438\u0442\u0443)`);

function compactActiveNeeds(state: CustomerNeedState) {
  return (state.activeNeeds ?? []).map((need) => ({
    id: need.id,
    productClass: need.productClass,
    summary: need.summary
  }));
}

function currentFocusFromMessage(message: string, state: CustomerNeedState): string {
  if (generatorRe.test(message)) return 'generator';
  if (plateRe.test(message)) return 'plate';
  if (leadRe.test(message)) return 'commercial';
  return state.activeNeeds?.find((need) => need.status === 'open')?.id ?? 'latest_message';
}

function inferLatestProductClass(message: string, state: CustomerNeedState): ProductSelectionClass | 'commercial' | undefined {
  if (generatorRe.test(message)) return 'generator';
  if (plateRe.test(message)) return 'plate';
  if (leadRe.test(message)) return 'commercial';
  return state.selectionState?.targetProductClass !== 'unknown' ? state.selectionState.targetProductClass : undefined;
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
  const productCardsPolicy = productCardsPolicies.includes(decision.productCardsPolicy as NonNullable<AgentTurnContract['productCardsPolicy']>)
    ? decision.productCardsPolicy as NonNullable<AgentTurnContract['productCardsPolicy']>
    : catalogAction === 'exact_model_lookup'
      ? 'show_exact_matches'
      : catalogAction === 'find_matching_products'
        ? 'show_matching_products'
        : 'none';
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
  const { userMessage, plan, needState } = input;
  const semanticContract = coerceSemanticAgentDecision(plan, needState);
  if (semanticContract) return semanticContract;

  const mustAnswerNow: string[] = [];
  const validatorWarnings: string[] = [];
  const hasComparison = comparisonRe.test(userMessage);
  const hasTech = techRe.test(userMessage);
  const hasLead = leadRe.test(userMessage) || plan.answerMode === 'leadCollection' || plan.followUpPolicy === 'collectLead';
  const leadAllowed = true;
  const latestProductClass = inferLatestProductClass(userMessage, needState);

  let answerTask: AgentTurnContract['answerTask'] = 'mixed';
  if (hasLead && !hasComparison && !hasTech) answerTask = 'lead_handoff';
  if (productSelectionRe.test(userMessage) || plan.action === 'recommend_products' || plan.answerMode === 'productRecommendation') answerTask = 'product_selection';
  if (hasTech) answerTask = 'technical_explanation';
  if (hasComparison) answerTask = 'comparison';
  if ((hasComparison || hasTech) && productSelectionRe.test(userMessage)) answerTask = 'mixed';

  if (hasComparison) {
    if (re(String.raw`(?:\u0431\u0435\u043d\u0437\u0438\u043d|\u0434\u0438\u0437\u0435\u043b)`).test(userMessage)) {
      mustAnswerNow.push('Compare gasoline vs diesel for the buyer context.');
    }
    if (re(String.raw`(?:\u0431\u0435\u0437\s+\u0437\u0430\u043f\u0430\u0441|\u0437\u0430\u043f\u0430\u0441)`).test(userMessage)) {
      mustAnswerNow.push('Explain the risk of selecting a generator without reserve.');
    }
  }
  if (hasTech) mustAnswerNow.push('Answer the technical use/maintenance question before any catalog shortlist.');

  let cardsRole: AgentTurnContract['cardsRole'] = 'none';
  if (answerTask === 'product_selection') cardsRole = 'primary';
  if (answerTask === 'mixed') cardsRole = 'supporting';
  if ((answerTask === 'comparison' || answerTask === 'technical_explanation') && plan.cardPolicy !== 'textOnly') {
    cardsRole = 'supporting';
    validatorWarnings.push('cards_support_only_for_factual_turn');
  }

  validatorWarnings.push('contract_source:legacy_text_fallback');
  if ((answerTask === 'comparison' || answerTask === 'technical_explanation') && plan.action === 'recommend_products') {
    validatorWarnings.push('planner_catalog_shortlist_reduced_to_supporting');
  }
  if (latestProductClass && !needState.activeNeeds?.some((need) => need.productClass === latestProductClass || need.id === latestProductClass)) {
    validatorWarnings.push(`active_need_missing:${latestProductClass}`);
  }

  return {
    answerTask,
    mustAnswerNow,
    activeNeeds: compactActiveNeeds(needState),
    currentFocus: currentFocusFromMessage(userMessage, needState),
    cardsRole,
    leadAllowed,
    leadAllowedReason: leadAllowed ? 'no_contact_refusal_detected' : 'buyer_refused_contact_or_form',
    errorRecoveryPriority: mustAnswerNow[0] ?? 'Give a concise answer to the latest user question from the current validated context.',
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
