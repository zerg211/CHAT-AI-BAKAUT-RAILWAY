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
  lastSeenAt?: string | null;
  lastSyncedAt?: string | null;
  isActive?: boolean;
  sourceContentHash?: string | null;
  retrievalScore?: number | null;
  retrievalSource?: ProductRetrievalSource | null;
}

export type ProductRetrievalSource = 'text' | 'exact' | 'vector' | 'unknown';

export interface EmbeddingMetadata {
  model: string;
  sourceHash: string;
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

export type VerifiedProductFactConfidence = 'high' | 'medium' | 'low';
export type VerifiedProductFactSource = 'web' | 'catalog' | 'manual';

export interface VerifiedProductFact {
  id: string;
  productId?: string | null;
  productKey: string;
  productName: string;
  attribute: string;
  value: string;
  sourceType: VerifiedProductFactSource;
  sourceUrl?: string | null;
  sourceTitle?: string | null;
  evidence?: string | null;
  confidence: VerifiedProductFactConfidence;
  status: 'active' | 'superseded' | 'rejected';
  firstSeenAt: string;
  lastVerifiedAt: string;
  hitCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface VerifiedProductFactInput {
  productId?: string | null;
  productName: string;
  attribute: string;
  value: string;
  sourceType: VerifiedProductFactSource;
  sourceUrl?: string | null;
  sourceTitle?: string | null;
  evidence?: string | null;
  confidence: VerifiedProductFactConfidence;
}

export interface TroubleshootingCase {
  id: string;
  model: string;
  modelKey: string;
  faultCodes: string[];
  problemSummary: string;
  problemKey: string;
  answer: string;
  sourceUrls: string[];
  sourceTitles: string[];
  confidence: number;
  firstSeenMessage?: string | null;
  hitCount: number;
  semanticScore?: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface TroubleshootingCaseInput {
  model: string;
  modelKey: string;
  faultCodes?: string[];
  problemSummary: string;
  problemKey: string;
  answer: string;
  sourceUrls?: string[];
  sourceTitles?: string[];
  confidence?: number;
  firstSeenMessage?: string;
}

export interface CatalogPage {
  id: string;
  sourceUrl: string;
  pageType: string;
  title: string;
  content: string;
  summary?: string | null;
  raw: Record<string, unknown>;
  lastSeenAt?: string | null;
  lastSyncedAt?: string | null;
  isActive?: boolean;
  sourceContentHash?: string | null;
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
  clientLeadId?: string | null;
  clientRequestHash?: string | null;
  originTurnId?: string | null;
  originToolRequestId?: string | null;
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
export type SemanticRequirementKind =
  | 'productClass'
  | 'task'
  | 'weightKg'
  | 'budgetRub'
  | 'powerKw'
  | 'diameterMm'
  | 'brand'
  | 'fuel'
  | 'startType'
  | 'phase';
export type SemanticRequirementStatus = 'active' | 'superseded' | 'rejected' | 'paused';
export type SemanticRequirementStrictness = 'strictOnly' | 'targetRange' | 'fallbackAllowed';
export type SemanticMemorySource = 'explicit_user' | 'llm_inference' | 'catalog_fact';
export type MentionedProductRole = 'targetProduct' | 'availabilityCheck' | 'comparison' | 'example' | 'compatibilityTarget';
export type MentionedProductStatus = 'unresolved' | 'foundInCatalog' | 'notFound' | 'notMatchingRequirement';
export type SemanticAlternativeMode = 'none' | 'afterPrimary' | 'fallbackOnly';
export type BotCommitmentKind = 'availability' | 'recommendation' | 'constraint' | 'fact';

export interface ProductSelectionToken {
  value: string;
  role: ProductSelectionTokenRole;
  evidence?: string;
}

export interface SemanticRequirement {
  id: string;
  kind: SemanticRequirementKind;
  value: Record<string, unknown>;
  status: SemanticRequirementStatus;
  strictness: SemanticRequirementStrictness;
  evidence: string;
  source: SemanticMemorySource;
  replacesRequirementIds: string[];
  updatedAt: string;
}

export interface MentionedProductMemory {
  token: string;
  normalizedToken: string;
  role: MentionedProductRole;
  status: MentionedProductStatus;
  productIds: string[];
  evidence: string;
  updatedAt: string;
}

export interface SemanticSelectionPolicy {
  primaryRequirementIds: string[];
  alternativeMode: SemanticAlternativeMode;
  explanationRequired: boolean;
}

export interface BotCommitment {
  kind: BotCommitmentKind;
  text: string;
  productIds: string[];
  evidence: string;
  updatedAt: string;
}

export interface SemanticMemory {
  version: 1;
  activeRequirementIds: string[];
  requirements: SemanticRequirement[];
  mentionedProducts: MentionedProductMemory[];
  selectionPolicy: SemanticSelectionPolicy;
  botCommitments: BotCommitment[];
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

export interface ProductGeneratorLoadScenario {
  id: string;
  label: string;
  itemKinds: string[];
  totalRunningKw: number;
  requiredStartingKw: number;
  requiredNominalKw: number;
  calculation?: string;
}

export interface ProductGeneratorLoadProfile {
  items: ProductElectricalLoadItem[];
  totalRunningKw?: number;
  requiredStartingKw?: number;
  requiredNominalKw?: number;
  simultaneousStarting?: boolean;
  simultaneousStartingKinds?: string[];
  scenarios?: ProductGeneratorLoadScenario[];
  primaryScenarioId?: string;
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
  semanticSource?: 'llm_need_extraction' | 'legacy_text_fallback' | 'planner';
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

export type ActiveNeedStatus = 'open' | 'selected' | 'paused' | 'closed';

export interface ActiveCustomerNeed {
  id: string;
  productClass: ProductSelectionClass | 'commercial';
  summary: string;
  constraints: string[];
  openQuestions: string[];
  selectedProductIds: string[];
  status: ActiveNeedStatus;
  updatedAt: string;
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
  activeNeeds: ActiveCustomerNeed[];
  semanticMemory: SemanticMemory;
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

export type TurnLifecycleStatus =
  | 'received'
  | 'need_extracted'
  | 'planned'
  | 'answering'
  | 'completed'
  | 'failed'
  | 'recovered';

export type AgentAnswerTask =
  | 'technical_explanation'
  | 'comparison'
  | 'product_selection'
  | 'mixed'
  | 'lead_handoff';

export type AgentCardsRole = 'none' | 'supporting' | 'primary';
export type AgentTaskType =
  | 'pure_delivery'
  | 'pure_availability'
  | 'product_selection'
  | 'product_selection_with_delivery'
  | 'product_selection_with_availability'
  | 'technical_answer'
  | 'comparison'
  | 'contact_refusal_continue_selection';
export type AgentCatalogAction = 'none' | 'exact_model_lookup' | 'find_matching_products' | 'verify_catalog_absence';
export type AgentCommercialAction = 'none' | 'explain_manager_required' | 'offer_contact_after_answer';
export type AgentProductCardsPolicy = 'none' | 'show_exact_matches' | 'show_matching_products' | 'supporting_only';

export type AgentSource = 'catalog' | 'visible_cards' | 'web' | 'specialist' | 'conversation_memory';
export type AgentWebPurpose = 'technical_specs' | 'manual_or_service' | 'current_lineup' | 'none';
export type AgentToolName =
  | 'searchCatalog'
  | 'getProductDetails'
  | 'selectProducts'
  | 'compareProducts'
  | 'webFactSearch'
  | 'createLeadDraft'
  | 'createLead';

export interface AgentSourcePolicyV2 {
  allowed: AgentSource[];
  required: AgentSource[];
  forbidden: AgentSource[];
  webPurpose?: AgentWebPurpose;
}

export interface AgentToolPlanStepV2 {
  tool: AgentToolName;
  reason: string;
  required: boolean;
  inputHint: Record<string, unknown>;
}

export type AgentIntentV2 =
  | 'product_selection'
  | 'technical_answer'
  | 'comparison'
  | 'exact_model_lookup'
  | 'availability_check'
  | 'delivery_or_discount'
  | 'lead_handoff'
  | 'offtopic';

export interface AgentTurnContractV2 {
  version: 2;
  intent: AgentIntentV2;
  answerTask: AgentAnswerTask;
  taskType?: AgentTaskType;
  catalogAction: AgentCatalogAction;
  commercialAction: AgentCommercialAction;
  productCardsPolicy: AgentProductCardsPolicy;
  cardsRole: AgentCardsRole;
  leadPolicy: ExecutionLeadPolicy;
  sourcePolicy: AgentSourcePolicyV2;
  needDelta: {
    newRequirements: string[];
    confirmedRequirements: string[];
    changedRequirements: string[];
    supersededRequirementIds: string[];
    rejectedProductIds: string[];
  };
  missingFacts: string[];
  toolPlan: AgentToolPlanStepV2[];
  selectedProductIds: string[];
  rejectedProductIds: string[];
  mustAnswerNow: string[];
  currentFocus: string;
  errorRecoveryPriority: string;
  confidence: number;
  warnings: string[];
}

export interface AgentTurnContract {
  answerTask: AgentAnswerTask;
  taskType?: AgentTaskType;
  catalogAction?: AgentCatalogAction;
  commercialAction?: AgentCommercialAction;
  productCardsPolicy?: AgentProductCardsPolicy;
  mustAnswerNow: string[];
  activeNeeds: Array<{
    id: string;
    productClass: ProductSelectionClass | 'commercial';
    summary: string;
  }>;
  currentFocus: string;
  cardsRole: AgentCardsRole;
  leadAllowed: boolean;
  leadAllowedReason: string;
  errorRecoveryPriority: string;
  validatorWarnings: string[];
}

export type ExecutionCatalogPolicy = AgentCatalogAction;
export type ExecutionCardsPolicy = 'none' | 'primary' | 'supporting' | 'selected_only';
export type ExecutionLeadPolicy = 'none' | 'forbidden' | 'optional_after_answer' | 'required_now';
export type ExecutionFactPolicy = 'catalog_only' | 'web_required' | 'specialist_required';

export interface ExecutionContract {
  version: 1;
  source: 'agent_turn_contract';
  answerTask: AgentAnswerTask;
  taskType?: AgentTaskType;
  catalogPolicy: ExecutionCatalogPolicy;
  cardsPolicy: ExecutionCardsPolicy;
  leadPolicy: ExecutionLeadPolicy;
  factPolicy: ExecutionFactPolicy;
  activeRequirementIds: string[];
  activeConstraints?: ProductSelectionCriteria;
  postconditions: string[];
  warnings: string[];
}

export type RequirementLedgerItemSource = SemanticMemorySource | 'selection_state';
export type RequirementLedgerItemStatus = SemanticRequirementStatus | 'derived';

export interface RequirementLedgerItem {
  id: string;
  kind: SemanticRequirementKind | 'exactModel' | 'startType' | 'enclosure';
  value: Record<string, unknown>;
  status: RequirementLedgerItemStatus;
  strictness: SemanticRequirementStrictness;
  source: RequirementLedgerItemSource;
  evidence: string;
}

export interface RequirementLedger {
  version: 1;
  activeRequirementIds: string[];
  primaryRequirementIds: string[];
  alternativeMode: SemanticAlternativeMode;
  items: RequirementLedgerItem[];
  hardConstraintKeys: string[];
  warnings: string[];
}

export type CardManifestRole = 'primary' | 'supporting' | 'alternative' | 'hidden';
export type CardConstraintStatus = 'satisfies_hard_constraints' | 'violates_hard_constraints' | 'unchecked';

export interface CardManifestItem {
  productId: string;
  name: string;
  rank: number;
  visible: boolean;
  role: CardManifestRole;
  constraintStatus: CardConstraintStatus;
  violations: string[];
}

export interface CardManifest {
  version: 1;
  source: 'execution_contract';
  cardsPolicy: ExecutionCardsPolicy;
  visibleProductIds: string[];
  hiddenProductIds: string[];
  items: CardManifestItem[];
  warnings: string[];
}

export type FactClaimSourcePolicy = 'catalog' | 'visible_cards' | 'web' | 'specialist' | 'conversation_memory';
export type FactClaimRisk = 'low' | 'medium' | 'high';

export interface FactClaimPlanner {
  version: 1;
  factPolicy: ExecutionFactPolicy;
  allowedSources: FactClaimSourcePolicy[];
  requiredDisclaimers: string[];
  forbiddenClaims: string[];
  risk: FactClaimRisk;
  warnings: string[];
}

export type FactClaimKind =
  | 'product_reference'
  | 'price'
  | 'availability'
  | 'delivery'
  | 'discount_or_terms'
  | 'technical_spec'
  | 'current_lineup';
export type FactClaimGroundingStatus =
  | 'grounded'
  | 'requires_specialist_verification'
  | 'requires_web_verification'
  | 'ungrounded'
  | 'unchecked';

export interface FactClaim {
  kind: FactClaimKind;
  text: string;
  requiredSource: FactClaimSourcePolicy;
  groundingStatus: FactClaimGroundingStatus;
  matchedProductIds: string[];
  warning?: string;
}

export interface FactClaimAudit {
  version: 1;
  claims: FactClaim[];
  warnings: string[];
}

export type LeadMachineState =
  | 'not_allowed'
  | 'not_needed'
  | 'optional_after_answer'
  | 'required_contact_missing'
  | 'ready_to_create'
  | 'created'
  | 'failed';

export type LeadMachineNextAction =
  | 'do_not_ask_contact'
  | 'answer_without_lead'
  | 'offer_contact_after_answer'
  | 'ask_for_missing_contact'
  | 'create_or_confirm_lead'
  | 'confirm_created_lead'
  | 'manual_follow_up_required';

export interface LeadStateMachine {
  version: 1;
  state: LeadMachineState;
  nextAction: LeadMachineNextAction;
  leadPolicy: ExecutionLeadPolicy;
  hasContactInTurn: boolean;
  leadRequested: boolean;
  leadCreated: boolean;
  missing?: 'name' | 'contact';
  warnings: string[];
}

export interface LeadDraft {
  version: 1;
  reason: 'availability' | 'delivery' | 'discount' | 'order' | 'specialist_consultation' | 'service_terms';
  productIds: string[];
  buyerQuestion: string;
  missingFacts: string[];
  contact?: {
    name?: string;
    phone?: string;
    email?: string;
  };
}

export interface AgentToolTraceItem {
  tool: AgentToolName;
  ok: boolean;
  risk: 'safe' | 'sensitive';
  reason: string;
  required: boolean;
  durationMs?: number;
  summary?: string;
  warnings: string[];
  error?: string;
}

export interface ProductEvidenceItem {
  productId: string;
  name: string;
  source: 'catalog' | 'visible_card' | 'web';
  role: 'primary' | 'supporting' | 'alternative' | 'hidden' | 'rejected';
  allowedInAnswerText: boolean;
  allowedAsVisibleCard: boolean;
  rejectionReason?: string;
  constraintStatus: CardConstraintStatus;
  evidence: string[];
}

export interface ProductEvidenceRegistry {
  version: 1;
  items: ProductEvidenceItem[];
  visibleProductIds: string[];
  hiddenProductIds: string[];
  rejectedProductIds: string[];
  allowedProductIdsForText: string[];
  warnings: string[];
}

export interface PolicyGateResult {
  version: 1;
  ok: boolean;
  blockedReasons: string[];
  requiredActions: AgentToolName[];
  answerConstraints: string[];
  warnings: string[];
}

export type PolicyGateEnforcementMode = 'pass' | 'repair' | 'hard_block';

export interface PolicyGateEnforcement {
  version: 1;
  mode: PolicyGateEnforcementMode;
  hardBlockReasons: string[];
  repairedReasons: string[];
  requiredActions: AgentToolName[];
  answerConstraints: string[];
  failedRequiredTools: AgentToolName[];
  warnings: string[];
}

export type PostAnswerVerificationStatus = 'pass' | 'warn' | 'error';
export type PostAnswerVerificationSeverity = 'warning' | 'error';

export interface PostAnswerVerificationIssue {
  code: string;
  severity: PostAnswerVerificationSeverity;
  message: string;
}

export interface PostAnswerVerification {
  version: 1;
  status: PostAnswerVerificationStatus;
  issues: PostAnswerVerificationIssue[];
  checkedPolicies: string[];
}

export interface PostAnswerVerificationRecovery {
  attempted: boolean;
  recovered: boolean;
  issuesBefore: string[];
  issuesAfter: string[];
  method?: 'none' | 'deterministic_text_repair' | 'llm_rewrite';
  repairableIssues?: string[];
  unrecoverableIssues?: string[];
  reason?: string;
}

export interface ConversationTurn {
  id: string;
  sessionId: string;
  clientMessageId?: string | null;
  userMessageId?: string | null;
  assistantMessageId?: string | null;
  status: TurnLifecycleStatus;
  requestHash: string;
  stage?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  plannerContract?: AgentTurnContract | Record<string, unknown> | null;
  activeNeedsBefore?: ActiveCustomerNeed[] | null;
  activeNeedsAfter?: ActiveCustomerNeed[] | null;
  executionOwner?: string | null;
  executionLeaseExpiresAt?: string | null;
  createdAt: string;
  updatedAt: string;
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
  turnId?: string;
  answer: string;
  needState: CustomerNeedState;
  productCards: ProductCard[];
  cardDisplay?: CardDisplayOptions;
  usedWebSearch: boolean;
  leadRequested?: boolean;
  leadCreated?: boolean;
  assistantMessageId?: string;
  metadata?: {
    runtimeMode?: 'agent_manager' | 'legacy';
    runtimeModeReason?: string;
    agentManagerRuntime?: {
      runtimeMode?: 'agent_manager' | 'legacy';
      reason?: string;
      agentManagerHarnessEnabled?: boolean;
      globalHarnessEnabled?: boolean;
      urlOptIn?: boolean;
      urlOptInParam?: string;
      legacyAnswerWritersDisabled?: boolean;
    };
    legacyRuntime?: {
      active?: boolean;
      path?: string;
      reason?: string;
      legacyAnswerWritersDisabled?: boolean;
    };
    selection?: ProductSelectionMetadata;
    cardDisplay?: CardDisplayOptions;
    aiDiagnostics?: AiGenerationDiagnostics;
    turnId?: string;
    turnContract?: AgentTurnContract;
    agentContractV2?: AgentTurnContractV2;
    sourcePolicy?: AgentSourcePolicyV2;
    toolTrace?: AgentToolTraceItem[];
    productEvidenceRegistry?: ProductEvidenceRegistry;
    policyGate?: PolicyGateResult;
    policyGateEnforcement?: PolicyGateEnforcement;
    leadDraft?: LeadDraft;
    requirementLedger?: RequirementLedger;
    executionContract?: ExecutionContract;
    cardManifest?: CardManifest;
    factClaimPlanner?: FactClaimPlanner;
    factClaimAudit?: FactClaimAudit;
    leadStateMachine?: LeadStateMachine;
    postAnswerVerification?: PostAnswerVerification;
    postAnswerVerificationRecovery?: PostAnswerVerificationRecovery;
    activeNeedsBefore?: ActiveCustomerNeed[];
    activeNeedsAfter?: ActiveCustomerNeed[];
    cardsRole?: AgentCardsRole;
    leadAllowed?: boolean;
    validatorWarnings?: string[];
    recoveryAttempts?: number;
    openAiError?: unknown;
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
