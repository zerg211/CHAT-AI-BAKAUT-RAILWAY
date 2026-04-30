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

type ProductSelectionConstraintSource = 'explicit_user' | 'inferred_from_load' | 'catalog_fact' | 'previous_selection' | 'planner';

type TraitsWithProvenance = {
  productIntent?: string;
  singlePhase220?: boolean | null;
  provenance?: {
    singlePhase220?: ProductSelectionConstraintSource;
  };
};

const GENERATOR_PHASE_MISSING_INFO = '220 В или 380 В';
const GENERATOR_PHASE_GUIDANCE = 'До явного подтверждения покупателем 220 В или 380 В не финально рекомендуй генератор и не показывай карточки. Коротко объясни, что бытовая нагрузка похожа на 220 В, но финальный подбор зависит от нужного выхода, и задай один вопрос: нужен генератор 220 В или 380 В?';

function traitsOf(plan: PlannerLikeTurn): TraitsWithProvenance {
  return (plan.requiredProductTraits ?? {}) as TraitsWithProvenance;
}

function isGeneratorIntent(intent: string | undefined) {
  return intent === 'generator' || intent === 'weldingGenerator';
}

function hasExplicitGeneratorPhase(traits: TraitsWithProvenance) {
  if (traits.singlePhase220 === null || typeof traits.singlePhase220 === 'undefined') return false;
  const source = traits.provenance?.singlePhase220;
  return source === 'explicit_user' || source === 'previous_selection';
}

function needsGeneratorPhaseConfirmation(plan: PlannerLikeTurn) {
  const traits = traitsOf(plan);
  if (plan.action !== 'recommend_products' || !isGeneratorIntent(traits.productIntent)) return false;

  const source = traits.provenance?.singlePhase220;
  return typeof traits.singlePhase220 !== 'undefined' && traits.singlePhase220 !== null && source === 'inferred_from_load' && !hasExplicitGeneratorPhase(traits);
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
  const requiresGeneratorPhaseConfirmation = needsGeneratorPhaseConfirmation(input.plan);
  const leadForm = !requiresGeneratorPhaseConfirmation &&
    (isLeadAction(input.plan.action) || input.plan.answerMode === 'leadCollection' || input.plan.followUpPolicy === 'collectLead');

  const primaryAction: TurnAction = requiresGeneratorPhaseConfirmation ? 'ask_clarifying_question' : input.plan.action;
  const answerMode: TurnAnswerMode = requiresGeneratorPhaseConfirmation ? 'short' : input.plan.answerMode;
  const followUpPolicy: TurnFollowUpPolicy = requiresGeneratorPhaseConfirmation ? 'askClarifyingQuestion' : input.plan.followUpPolicy;
  const selectedProductIds = requiresGeneratorPhaseConfirmation ? [] : [...input.plan.selectedProductIds];
  const missingInformation = [...input.plan.missingInformation];
  let guidance = input.plan.answerGuidance;
  if (requiresGeneratorPhaseConfirmation) {
    if (!missingInformation.includes(GENERATOR_PHASE_MISSING_INFO)) missingInformation.push(GENERATOR_PHASE_MISSING_INFO);
    guidance = [guidance, GENERATOR_PHASE_GUIDANCE].filter(Boolean).join('\n');
    overrides.push('generator_phase_requires_explicit_confirmation');
  }

  let cards: TurnRenderCards = requiresGeneratorPhaseConfirmation
    ? 'none'
    : input.plan.cardPolicy === 'textOnly'
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
  if (input.forceCards && !requiresGeneratorPhaseConfirmation) {
    cards = input.forceCards;
    overrides.push(`force_cards:${input.forceCards}`);
  }

  return {
    action: {
      primary: primaryAction,
      answerMode,
      followUpPolicy
    },
    scope: {
      context: input.plan.contextScope,
      search: input.plan.searchScope,
      catalogSearchQuery: input.plan.catalogSearchQuery
    },
    knowledge: {
      webRequired: input.forceWebRequired ?? input.plan.needsWebSearch,
      missingInformation
    },
    selection: {
      selectedProductIds,
      requiredProductTraits: input.plan.requiredProductTraits,
      selectionState: input.plan.selectionState
    },
    render: {
      cards,
      leadForm,
      textOnlyReason: input.forceTextOnlyReason
    },
    guidance,
    diagnostics: {
      sourcePlan: input.plan,
      overrides
    }
  };
}
