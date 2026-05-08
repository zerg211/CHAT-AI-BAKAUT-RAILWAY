import type { AgentTurnContract, CustomerNeedState, ProductSelectionClass } from '../shared/types.js';

type PlannerLike = {
  action: string;
  answerMode: string;
  cardPolicy: string;
  followUpPolicy: string;
  selectedProductIds: string[];
  answerGuidance?: string;
  selectionState?: {
    shouldShowCards?: boolean;
  };
};

const re = (pattern: string, flags = 'iu') => new RegExp(pattern, flags);

const comparisonRe = re(String.raw`(?:\u0441\u0440\u0430\u0432\u043d|compare|\u0447\u0442\u043e\s+\u043b\u0443\u0447\u0448|\u0431\u0435\u043d\u0437\u0438\u043d.{0,80}\u0434\u0438\u0437\u0435\u043b|\u0434\u0438\u0437\u0435\u043b.{0,80}\u0431\u0435\u043d\u0437\u0438\u043d|\u0431\u0435\u0437\s+\u0437\u0430\u043f\u0430\u0441)`);
const techRe = re(String.raw`(?:\u0430\u0432\u0440|avr|\u0430\u0432\u0442\u043e\u0437\u0430\u043f\u0443\u0441\u043a|\u043e\u0431\u0441\u043b\u0443\u0436|\u044d\u043a\u0441\u043f\u043b\u0443\u0430\u0442|\u043f\u0443\u0441\u043a\u043e\u0432|\u0444\u0430\u0437|\u043a\u0432\u0442|\u043d\u0430\u0433\u0440\u0443\u0437|\u043c\u043e\u0449\u043d\u043e\u0441\u0442|\u0440\u0438\u0441\u043a)`);
const productSelectionRe = re(String.raw`(?:\u043f\u043e\u0434\u0431\u0435\u0440|\u043f\u043e\u0441\u043e\u0432\u0435\u0442|\u043f\u043e\u043a\u0430\u0436|\u0432\u0430\u0440\u0438\u0430\u043d\u0442|\u043c\u043e\u0434\u0435\u043b|\u043d\u0443\u0436\u0435\u043d|\u043d\u0443\u0436\u043d\u0430)`);
const leadRe = re(String.raw`(?:\u0434\u043e\u0441\u0442\u0430\u0432\u043a|\u043d\u0430\u043b\u0438\u0447|\u0441\u043a\u0438\u0434\u043a|\u0441\u043f\u0435\u0446\u0443\u0441\u043b\u043e\u0432|\u043e\u0444\u043e\u0440\u043c|\u0437\u0430\u043a\u0430\u0437|\u043a\u0443\u043f\u0438\u0442|\u043f\u0435\u0440\u0435\u0437\u0432\u043e\u043d|\u043b\u043e\u0433\u0438\u0441\u0442)`);
const leadRefusalRe = re(String.raw`(?:\u043d\u043e\u043c\u0435\u0440.{0,30}\u043f\u043e\u043a\u0430\s+\u043d\u0435|\u043a\u043e\u043d\u0442\u0430\u043a\u0442.{0,30}\u043f\u043e\u043a\u0430\s+\u043d\u0435|\u043d\u0435\s+\u0431\u0443\u0434\u0443.{0,40}\u043e\u0441\u0442\u0430\u0432|\u0431\u0435\u0437\s+\u0437\u0430\u044f\u0432\u043a|\u0437\u0430\u044f\u0432\u043a\u0443.{0,30}\u043d\u0435\s+\u043e\u0441\u0442\u0430\u0432|\u043f\u043e\u043a\u0430\s+\u043d\u0435\s+\u043e\u0441\u0442\u0430\u0432)`);
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

export function deriveAgentTurnContract(input: {
  userMessage: string;
  plan: PlannerLike;
  needState: CustomerNeedState;
}): AgentTurnContract {
  const { userMessage, plan, needState } = input;
  const mustAnswerNow: string[] = [];
  const validatorWarnings: string[] = [];
  const hasComparison = comparisonRe.test(userMessage);
  const hasTech = techRe.test(userMessage);
  const hasLead = leadRe.test(userMessage) || plan.answerMode === 'leadCollection' || plan.followUpPolicy === 'collectLead';
  const leadAllowed = !leadRefusalRe.test(userMessage);
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
  if (hasLead && !leadAllowed) mustAnswerNow.push('Respect refusal to leave contact and avoid lead pressure.');

  let cardsRole: AgentTurnContract['cardsRole'] = 'none';
  if (answerTask === 'product_selection') cardsRole = 'primary';
  if (answerTask === 'mixed') cardsRole = 'supporting';
  if ((answerTask === 'comparison' || answerTask === 'technical_explanation') && plan.cardPolicy !== 'textOnly') {
    cardsRole = 'supporting';
    validatorWarnings.push('cards_support_only_for_factual_turn');
  }

  if (!leadAllowed && hasLead) validatorWarnings.push('lead_refusal_detected');
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

export function leadRefusalDetected(text: string) {
  return leadRefusalRe.test(text);
}
