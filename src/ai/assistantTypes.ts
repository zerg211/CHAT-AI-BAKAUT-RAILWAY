import type { CustomerNeedState, DataConflict, Message, Product, ProductCard, ProductSelectionRejection, ProductSelectionState } from '../shared/types.js';

export interface GenerateAnswerInput {
  sessionId: string;
  userMessage: string;
  onDelta?: (text: string) => void | Promise<void>;
  signal?: AbortSignal;
}


export type AssistantTurnAction =
  | 'answer_question'
  | 'recommend_products'
  | 'ask_clarifying_question'
  | 'verify_with_web'
  | 'collect_lead'
  | 'handoff_specialist';

export type AnswerMode =
  | 'short'
  | 'productRecommendation'
  | 'detailedFact'
  | 'serviceCostComparison'
  | 'currentLineup'
  | 'leadCollection'
  | 'unknown';

export type CardPolicy =
  | 'auto'
  | 'showProducts'
  | 'showAccessories'
  | 'textOnly';

export type FollowUpPolicy =
  | 'auto'
  | 'answerNowNoDeferredOffer'
  | 'askClarifyingQuestion'
  | 'offerNextStepAllowed'
  | 'collectLead';

export type ContextScope =
  | 'latestMessageOnly'
  | 'activeNeed'
  | 'previousSelection'
  | 'fullSession';

export type SearchScope =
  | 'focusedNeed'
  | 'broadenAlternatives'
  | 'sameBrandOnly'
  | 'previousSelectionOnly';

export type CardDisplayMode =
  | 'exact_matches'
  | 'compatible_accessories'
  | 'alternatives'
  | 'structured_selection'
  | 'preliminary'
  | 'none';

export type SelectionState = {
  currentProductClass: ProductIntent;
  targetProductClass: ProductIntent;
  compatibilityTargetProduct: string;
  mustHaveTraits: string[];
  niceToHaveTraits: string[];
  excludedClasses: ProductIntent[];
  brandConstraint: string;
  exactModelConstraint: string;
  isAccessoryFollowUp: boolean;
  selectionConfidence: number;
  shouldShowCards: boolean;
  cardDisplayMode: CardDisplayMode;
};

export type AssistantTurnPlan = {
  action: AssistantTurnAction;
  answerMode: AnswerMode;
  cardPolicy: CardPolicy;
  followUpPolicy: FollowUpPolicy;
  contextScope: ContextScope;
  searchScope: SearchScope;
  catalogSearchQuery: string;
  selectedProductIds: string[];
  requiredProductTraits: RequiredProductTraits;
  selectionState: SelectionState;
  needsWebSearch: boolean;
  missingInformation: string[];
  answerGuidance: string;
};

export type ProductIntent =
  | 'generator'
  | 'weldingGenerator'
  | 'generatorOil'
  | 'engineOil'
  | 'generatorAccessory'
  | 'plateAccessory'
  | 'plate'
  | 'rammer'
  | 'roller'
  | 'cutter'
  | 'diamondBlade'
  | 'diamondCore'
  | 'trowel'
  | 'unknown';
export type ProductFuel = 'gasoline' | 'diesel' | 'any' | 'unknown';
export type ProductStartType = 'electric' | 'manual' | 'any' | 'unknown';
export type ProductRole = 'coreProduct' | 'accessory' | 'consumable' | 'unknown';
export type ProductEnclosure = 'enclosed' | 'open' | 'any' | 'unknown';

export type RequiredProductTraits = {
  productIntent: ProductIntent;
  productRole: ProductRole;
  fuel: ProductFuel;
  startType: ProductStartType;
  enclosure: ProductEnclosure;
  conventionalGenerator: boolean | null;
  singlePhase220: boolean | null;
  budgetMax: number | null;
  weightKgMin: number | null;
  weightKgMax: number | null;
  diameterMmMin: number | null;
  diameterMmMax: number | null;
  nominalPowerKwMin: number | null;
  nominalPowerKwMax: number | null;
  maxPowerKwMin: number | null;
  maxPowerKwMax: number | null;
  powerReasoning: string;
};

export type GeneratorPowerProfile = {
  nominalMin?: number;
  nominalMax?: number;
  maxMin?: number;
  maxMax?: number;
  source: 'planner' | 'explicit_text' | 'estimated_load';
};

export type ProductFitProfile = {
  intent: ProductIntent;
  activeNeedText: string;
  requestedBrands: string[];
  accessoryRequested: boolean;
  weldingRequested: boolean;
  wantsGasoline: boolean;
  wantsDiesel: boolean;
  wantsElectricStart: boolean;
  wantsInverterGenerator: boolean;
  wantsEnclosedGenerator: boolean;
  wantsConventionalGenerator: boolean;
  wantsSinglePhase220: boolean;
  desiredPowerRange?: { min: number; max: number };
  generatorPower?: GeneratorPowerProfile;
  budgetMax?: number;
  exactModelTokens: string[];
};

export type StructuredCatalogSlice = {
  source: 'structured_constraints' | 'exact_model_lookup' | 'full_catalog_slice';
  products: Product[];
  totalMatched: number;
  visibleLimit: number;
  constraints: {
    productIntent: ProductIntent;
    weightKgMin?: number;
    weightKgMax?: number;
    diameterMmMin?: number;
    diameterMmMax?: number;
    nominalPowerKwMin?: number;
    nominalPowerKwMax?: number;
    maxPowerKwMin?: number;
    maxPowerKwMax?: number;
    budgetMax?: number;
    brandConstraint?: string;
    exactModelConstraint?: string;
    mustHaveTraits?: string[];
    exactModelTokens?: string[];
  };
  exactCatalogMatches?: Product[];
};

export type ProductSelectionResult = {
  state: ProductSelectionState;
  matchedProducts: Product[];
  visibleProducts: Product[];
  hiddenProducts: Product[];
  comparisonProducts: Product[];
  rejectedProducts: ProductSelectionRejection[];
  missingQuestions: string[];
  confidence: number;
  trace: Record<string, unknown>;
};

export type CardSelectionDiagnostics = {
  profile: {
    intent: ProductIntent;
    requestedBrands: string[];
    wantsGasoline: boolean;
    wantsDiesel: boolean;
    wantsElectricStart: boolean;
    wantsInverterGenerator: boolean;
    wantsEnclosedGenerator: boolean;
    wantsConventionalGenerator: boolean;
    desiredPowerRange?: { min: number; max: number };
    generatorPower?: GeneratorPowerProfile;
    budgetMax?: number;
  };
  selectedCount: number;
  selectedRejectedCount: number;
  rankedCount: number;
  fallbackSuppressed: boolean;
  fallbackReason?: string;
};

export type CardContractDiagnostics = {
  mentionedProductIds: string[];
  addedCardIds: string[];
  reordered: boolean;
  firstCardAligned: boolean;
};

export const MAX_PRODUCT_CARDS = 10;
export const FULL_SLICE_PRODUCT_CARDS = 50;
export const LARGE_SLICE_VISIBLE_CARDS = 7;
export const PLANNER_CANDIDATE_LIMIT = 16;
export const MIN_JSON_OUTPUT_TOKENS = 2400;
export const PLANNER_HISTORY_LIMIT = 8;
export const PLANNER_HISTORY_CONTENT_LIMIT = 700;
export const PLANNER_PRODUCT_DESCRIPTION_LIMIT = 900;
export const PLANNER_PAGE_SUMMARY_LIMIT = 600;
export const PLANNER_PAGE_CONTENT_LIMIT = 1200;

