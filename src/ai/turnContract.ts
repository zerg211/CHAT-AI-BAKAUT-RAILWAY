export type TurnAction =
  | 'answer_question'
  | 'recommend_products'
  | 'ask_clarifying_question'
  | 'verify_with_web'
  | 'collect_lead'
  | 'handoff_specialist';

export type TurnAnswerMode =
  | 'short'
  | 'productRecommendation'
  | 'detailedFact'
  | 'serviceCostComparison'
  | 'currentLineup'
  | 'leadCollection'
  | 'unknown';

export type TurnCardPolicy = 'auto' | 'showProducts' | 'showAccessories' | 'textOnly';
export type TurnFollowUpPolicy = 'auto' | 'answerNowNoDeferredOffer' | 'askClarifyingQuestion' | 'offerNextStepAllowed' | 'collectLead';
export type TurnContextScope = 'latestMessageOnly' | 'activeNeed' | 'previousSelection' | 'fullSession';
export type TurnSearchScope = 'focusedNeed' | 'broadenAlternatives' | 'sameBrandOnly' | 'previousSelectionOnly';
export type TurnRenderCards = 'auto' | 'showProducts' | 'showAccessories' | 'selectedOnly' | 'none';

export interface PlannerLikeTurn {
  action: TurnAction;
  answerMode: TurnAnswerMode;
  cardPolicy: TurnCardPolicy;
  followUpPolicy: TurnFollowUpPolicy;
  contextScope: TurnContextScope;
  searchScope: TurnSearchScope;
  catalogSearchQuery: string;
  selectedProductIds: string[];
  needsWebSearch: boolean;
  missingInformation: string[];
  answerGuidance: string;
  requiredProductTraits?: unknown;
  selectionState?: unknown;
}

export interface ResolvedTurnContract {
  action: {
    primary: TurnAction;
    answerMode: TurnAnswerMode;
    followUpPolicy: TurnFollowUpPolicy;
  };
  scope: {
    context: TurnContextScope;
    search: TurnSearchScope;
    catalogSearchQuery: string;
  };
  knowledge: {
    webRequired: boolean;
    missingInformation: string[];
  };
  selection: {
    selectedProductIds: string[];
    requiredProductTraits?: unknown;
    selectionState?: unknown;
  };
  render: {
    cards: TurnRenderCards;
    leadForm: boolean;
    textOnlyReason?: string;
  };
  guidance: string;
  diagnostics: {
    sourcePlan: PlannerLikeTurn;
    overrides: string[];
  };
}

export function isLeadAction(action: TurnAction) {
  return action === 'collect_lead' || action === 'handoff_specialist';
}

export function resolveTurnContract(input: {
  plan: PlannerLikeTurn;
  forceTextOnlyReason?: string;
  forceCards?: TurnRenderCards;
  forceWebRequired?: boolean;
}): ResolvedTurnContract {
  const overrides: string[] = [];
  const leadForm = isLeadAction(input.plan.action) || input.plan.answerMode === 'leadCollection' || input.plan.followUpPolicy === 'collectLead';

  let cards: TurnRenderCards = input.plan.cardPolicy === 'textOnly'
    ? 'none'
    : input.plan.cardPolicy === 'showProducts'
      ? 'showProducts'
      : input.plan.cardPolicy === 'showAccessories'
        ? 'showAccessories'
        : 'auto';

  if (leadForm && cards === 'auto') {
    cards = 'selectedOnly';
    overrides.push('lead_auto_cards_selected_only');
  }
  if (input.forceTextOnlyReason) {
    cards = 'none';
    overrides.push(`force_text_only:${input.forceTextOnlyReason}`);
  }
  if (input.forceCards) {
    cards = input.forceCards;
    overrides.push(`force_cards:${input.forceCards}`);
  }

  return {
    action: {
      primary: input.plan.action,
      answerMode: input.plan.answerMode,
      followUpPolicy: input.plan.followUpPolicy
    },
    scope: {
      context: input.plan.contextScope,
      search: input.plan.searchScope,
      catalogSearchQuery: input.plan.catalogSearchQuery
    },
    knowledge: {
      webRequired: input.forceWebRequired ?? input.plan.needsWebSearch,
      missingInformation: [...input.plan.missingInformation]
    },
    selection: {
      selectedProductIds: [...input.plan.selectedProductIds],
      requiredProductTraits: input.plan.requiredProductTraits,
      selectionState: input.plan.selectionState
    },
    render: {
      cards,
      leadForm,
      textOnlyReason: input.forceTextOnlyReason
    },
    guidance: input.plan.answerGuidance,
    diagnostics: {
      sourcePlan: input.plan,
      overrides
    }
  };
}
