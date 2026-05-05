export type ConversationStatus = 'active' | 'closed' | 'expired';
export type MessageRole = 'user' | 'assistant' | 'system' | 'tool';
export type LeadStatus = 'pending_email' | 'sent_email' | 'email_failed';

export interface ConversationSession {
  id: string;
  status: ConversationStatus;
  conversationNumber: number;
  topic?: string | null;
  title: string;
  visitorId?: string | null;
  pageUrl?: string | null;
  userAgent?: string | null;
  needState: CustomerNeedState;
  historySummary?: string | null;
  createdAt: string;
  updatedAt: string;
  lastHeartbeatAt: string;
  closedAt?: string | null;
}

export interface ConversationSummary extends ConversationSession {
  messageCount: number;
  leadCount: number;
  latestMessageAt?: string | null;
  latestUserMessage?: string | null;
  latestAssistantMessage?: string | null;
}

export interface Message {
  id: string;
  sessionId: string;
  role: MessageRole;
  content: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface Product {
  id: string;
  externalId?: string | null;
  slug?: string | null;
  sourceUrl?: string | null;
  name: string;
  brand?: string | null;
  category?: string | null;
  price?: number | null;
  currency?: string | null;
  imageUrl?: string | null;
  description?: string | null;
  specs: Record<string, unknown>;
  raw?: Record<string, unknown>;
}

export interface ProductCard {
  id: string;
  name: string;
  brand?: string | null;
  category?: string | null;
  price?: number | null;
  currency?: string | null;
  imageUrl?: string | null;
  sourceUrl?: string | null;
  specs: Record<string, unknown>;
  reasons: string[];
  caveats: string[];
}

export interface ProductFact {
  productId: string;
  attribute: string;
  value: string;
  unit?: string | null;
  sourceType: 'site' | 'csv' | 'web' | 'manual';
  sourceUrl?: string | null;
  confidence: number;
}

export interface CatalogPage {
  id: string;
  sourceUrl: string;
  pageType: string;
  title: string;
  content: string;
  summary?: string | null;
  raw: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface CatalogPageInput {
  sourceUrl: string;
  pageType: string;
  title: string;
  content: string;
  summary?: string;
  raw?: Record<string, unknown>;
}

export interface DataConflict {
  id: string;
  productId: string;
  attribute: string;
  values: unknown[];
  status: 'open' | 'resolved' | 'ignored';
  resolution?: Record<string, unknown> | null;
}

export interface Lead {
  id: string;
  sessionId?: string | null;
  name: string;
  phone?: string | null;
  email?: string | null;
  question?: string | null;
  status: LeadStatus;
  createdAt: string;
}

export interface NeedItem {
  value: string;
  evidence: string;
  confidence: number;
  updatedAt: string;
}

export type ProductSelectionClass =
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

export type ProductSelectionRole = 'coreProduct' | 'accessory' | 'consumable' | 'unknown';
export type ProductSelectionConstraintSource = 'explicit_user' | 'inferred_from_load' | 'catalog_fact' | 'previous_selection' | 'planner';
export type ProductSelectionTokenRole = 'targetProduct' | 'comparisonProduct' | 'compatibilityTarget' | 'ignored';
export type ProductRankingPreference = 'cheapest' | 'balanced' | 'premium';

export interface ProductSelectionToken {
  value: string;
  role: ProductSelectionTokenRole;
  evidence?: string;
}

export interface ProductSelectionRejection {
  productId: string;
  reason: string;
}

export interface ProductSelectionCompatibilityTarget {
  name?: string;
  article?: string;
  kind?: string;
  evidence?: string;
}

export type ProductElectricalLoadSource = 'explicit_user' | 'estimated_average' | 'web_average' | 'catalog_fact';

export interface ProductElectricalLoadItem {
  kind: string;
  name?: string;
  count: number;
  runningKw?: number;
  startingKw?: number;
  source: ProductElectricalLoadSource;
  evidence?: string;
}

export interface ProductGeneratorLoadProfile {
  items: ProductElectricalLoadItem[];
  totalRunningKw?: number;
  requiredStartingKw?: number;
  requiredNominalKw?: number;
  simultaneousStarting?: boolean;
  calculation?: string;
  confidence?: number;
  removedKinds?: string[];
}

export type ProductSelectionConstraintProvenance = Partial<Record<
  | 'budgetMax'
  | 'nominalPowerKwMin'
  | 'nominalPowerKwMax'
  | 'maxPowerKwMin'
  | 'maxPowerKwMax'
  | 'weightKgMin'
  | 'weightKgMax'
  | 'diameterMmMin'
  | 'diameterMmMax'
  | 'fuel'
  | 'startType'
  | 'enclosure'
  | 'conventionalGenerator'
  | 'singlePhase220'
  | 'brandConstraint'
  | 'exactModelConstraint',
  ProductSelectionConstraintSource
>>;

export interface ProductSelectionCriteria {
  productIntent: ProductSelectionClass;
  productRole: ProductSelectionRole;
  budgetMax?: number;
  nominalPowerKwMin?: number;
  nominalPowerKwMax?: number;
  maxPowerKwMin?: number;
  maxPowerKwMax?: number;
  weightKgMin?: number;
  weightKgMax?: number;
  diameterMmMin?: number;
  diameterMmMax?: number;
  fuel?: 'gasoline' | 'diesel' | 'any' | 'unknown';
  startType?: 'electric' | 'manual' | 'any' | 'unknown';
  enclosure?: 'enclosed' | 'open' | 'any' | 'unknown';
  conventionalGenerator?: boolean | null;
  singlePhase220?: boolean | null;
  brandConstraint?: string;
  exactModelConstraint?: string;
  exactModelTokens: string[];
  exactModelTokenRoles?: ProductSelectionToken[];
  mustHaveTraits: string[];
  excludedClasses: ProductSelectionClass[];
  provenance?: ProductSelectionConstraintProvenance;
}

export interface ProductSelectionState {
  currentProductClass: ProductSelectionClass;
  targetProductClass: ProductSelectionClass;
  activeRequirement?: ProductSelectionCriteria;
  hardConstraints: ProductSelectionCriteria;
  softPreferences: ProductSelectionCriteria;
  unknowns: string[];
  conflicts: string[];
  selectedProductIds: string[];
  matchedProductIds?: string[];
  comparisonProductIds?: string[];
  rejectedProducts?: ProductSelectionRejection[];
  compatibilityTargetProduct?: ProductSelectionCompatibilityTarget;
  loadProfile?: ProductGeneratorLoadProfile;
  previousCandidateProductIds?: string[];
  rankingPreference?: ProductRankingPreference;
  confidence: number;
  updatedAt?: string;
}

export interface ProductSelectionMetadata {
  matchedProductIds: string[];
  visibleProductIds: string[];
  hiddenProductIds: string[];
  comparisonProductIds?: string[];
  rejectedProducts?: ProductSelectionRejection[];
  totalMatched: number;
  selectionConfidence: number;
  missingQuestions: string[];
  loadProfile?: ProductGeneratorLoadProfile;
  rankingPreference?: ProductRankingPreference;
  activeHardConstraints?: ProductSelectionCriteria;
  selectionTrace?: Record<string, unknown>;
}

export interface CustomerNeedState {
  explicitNeeds: NeedItem[];
  implicitNeeds: NeedItem[];
  constraints: NeedItem[];
  importantCriteria: NeedItem[];
  confirmedFacts: NeedItem[];
  uncertainInferences: NeedItem[];
  contradictions: NeedItem[];
  featureSignals: {
    portable: number;
    homeUse: number;
    compact: number;
    lowNoise: number;
    coldStart: number;
    professionalDuty: number;
    budgetSensitive: number;
  };
  selectionState: ProductSelectionState;
  lastSummary: string;
}

export interface CardDisplayOptions {
  initialVisibleCount?: number;
}

export interface AiFallbackDiagnostic {
  used: boolean;
  reason?: string;
}

export interface AiGenerationDiagnostics {
  needExtractionFallback: AiFallbackDiagnostic;
  turnPlanningFallback: AiFallbackDiagnostic;
  answerGenerationFallback: AiFallbackDiagnostic;
}

export interface ChatResponsePayload {
  answer: string;
  needState: CustomerNeedState;
  productCards: ProductCard[];
  cardDisplay?: CardDisplayOptions;
  usedWebSearch: boolean;
  leadRequested?: boolean;
  leadCreated?: boolean;
  assistantMessageId?: string;
  metadata?: {
    selection?: ProductSelectionMetadata;
    cardDisplay?: CardDisplayOptions;
    aiDiagnostics?: AiGenerationDiagnostics;
    answerGenerationFallback?: AiFallbackDiagnostic;
    [key: string]: unknown;
  };
}

export interface CatalogProductInput {
  externalId?: string;
  sourceUrl?: string;
  slug?: string;
  name: string;
  brand?: string;
  category?: string;
  price?: number;
  currency?: string;
  imageUrl?: string;
  description?: string;
  specs?: Record<string, unknown>;
  raw?: Record<string, unknown>;
  sourcePriority?: number;
}

export type GeneratorPowerProfileSource = 'planner' | 'explicit_text' | 'estimated_load';

export interface GeneratorPowerProfile {
  nominalMin?: number;
  nominalMax?: number;
  maxMin?: number;
  maxMax?: number;
  source: GeneratorPowerProfileSource;
}

export interface ProductFitProfile {
  intent: ProductSelectionClass;
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
}
