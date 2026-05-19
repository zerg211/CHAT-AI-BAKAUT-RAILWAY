import { config } from '../config.js';
import { ConversationRepository, LeadRepository, ProductRepository } from '../db/repositories.js';
import yaml from 'js-yaml';
import type { ActiveCustomerNeed, AgentToolTraceItem, AgentTurnContract, AgentTurnContractV2, BotCommitment, CardDisplayOptions, CardManifest, ChatResponsePayload, ConversationSession, CustomerNeedState, DataConflict, ExecutionContract, FactClaimPlanner, GeneratorPowerProfile, Lead, LeadDraft, LeadStateMachine, MentionedProductMemory, Message, PolicyGateEnforcement, PolicyGateResult, PostAnswerVerificationRecovery, Product, ProductCard, ProductElectricalLoadItem, ProductEvidenceRegistry, ProductFitProfile, ProductGeneratorLoadProfile, ProductRankingPreference, ProductSelectionClass, ProductSelectionCriteria, ProductSelectionMetadata, ProductSelectionRejection, ProductSelectionState, ProductSelectionToken, RequirementLedger, SemanticMemory, SemanticMemorySource, SemanticRequirement, SemanticRequirementKind, SemanticRequirementStatus, SemanticRequirementStrictness, SemanticSelectionPolicy, TroubleshootingCase } from '../shared/types.js';
import { buildAssistantContext, buildNeedExtractorPrompt, buildSystemPrompt, buildTurnPlannerPrompt } from './prompts.js';
import { createEmbedding, createOpenAIClient, withRetry } from './openaiClient.js';
import { sendLeadEmail } from '../email/httpEmail.js';
import { emptyNeedState, emptyProductSelectionState, emptySemanticMemory, mergeNeedState, mergeProductSelectionState, summarizeNeedState } from './needState.js';
import { calculateGeneratorLoadProfile as calculateStructuredGeneratorLoadProfile, canonicalElectricalLoadKind } from './loadProfile.js';
import {
  fromEscaped, weightRegex, powerRegex, powerRangeRegex, budgetMaxRegex,
  plateTerms, generatorTerms, rammerTerms, cutterTerms, diamondBladeTerms,
  weightTerms, wheelTransportTerms, homeTerms, inverterTerms, dieselTerms,
  gasolineTerms, professionalTerms, coldStartTerms, quietTerms,
  accessoryTerms, accessoryNeedTerms, trowelTerms, weldingTerms, oilTerms,
  diamondCoreTerms, rollerTerms, singlePhaseTerms, fourStrokeOilTerms,
  incompatibleOilTerms, plateAccessoryTerms,
  containsAny, oilViscosities, hasOilProductSignal, requestedLiters, productLiters,
  parseLoosePositiveNumber, extractWeightKg, extractDimensionMm,
  extractPowerKw, extractNamePowerKw, normalizePowerValue,
  extractPowerNearKeywords, extractGeneratorPower, numberNearNeed,
  compactModelText, normalizeBrandKey, requestedBrandKeysFromProducts,
  productMatchesRequestedBrand, productMatchesIntent,
  extractGeneratorPowerForHardSelection, isTechnicalSpecToken, isLikelyModelToken,
  extractModelTokens, expandModelTokenAliases,
  parseWeightNeedRangeKg, parseSingleWeightTargetKg, parseDimensionNeedRangeMm,
  isCatalogAvailabilityQuestion, isManufacturingStatusQuestion,
  parseDesiredPowerRange, parseBudgetMax, hasBudgetSignal,
  hasExplicitGeneratorPowerRequest, inferProductIntent,
  fallbackDetectGeneratorEnclosureSignal, fallbackDetectStandaloneGeneratorAccessoryRequest,
  hasElectricStartSignal,
  productFullText, productHasExactModel, strictExactModelTokens,
  productMatchesExactModelConstraint, classifyProduct,
  isCoreEquipment, isOilCard, productMentionedInText, strongProductMentionIndex,
  generatorPhaseProfile,
  displayProductBrand, intentTextPatterns
} from './productClassifier.js';
import { getSessionGuard, cleanupSessionGuard } from './consistencyGuard.js';
import { buildOfftopicGuard } from './offtopicPolicy.js';
import { assessLeadTemperature, temperatureGuidance } from './leadTemperature.js';
import { traceTimer, emitTrace } from './tracing.js';
import { classifyGeneratorLoadText, enrichGeneratorLoadReferenceFromWeb, generatorReferenceLoadItemsFromText, shouldEnrichGeneratorLoadReference } from './generatorLoadReference.js';
import { resolveTurnContract, type ResolvedTurnContract } from './turnContract.js';
import { applyAgentTurnContractToPlan, deriveAgentTurnContract } from './agentTurnContract.js';
import { buildCardManifest, enforceVisibleCardConstraints } from './cardManifest.js';
import { buildExecutionContract } from './executionContract.js';
import { auditAnswerFactClaims, buildFactClaimPlanner } from './factClaimPlanner.js';
import { buildLeadStateMachine } from './leadStateMachine.js';
import { classifyPostAnswerRecovery, repairAnswerForPostAnswerVerification, verifyPostAnswer } from './postAnswerVerifier.js';
import { buildRequirementLedger } from './requirementLedger.js';
import { sanitizeVisibleAnswerNumbers } from './answerSanity.js';
import { recordOpenAIUsageOnce } from './openaiUsageGuard.js';
import { coercePlannerAgentTurnContractV2, contractV2ToLegacyAgentContract, deriveAgentTurnContractV2 } from './agentTurnContractV2.js';
import { AgentToolRegistry, toolResultToTrace } from './agentTools.js';
import { createRuntimeArtifactToolHandlers } from './agentRuntimeTools.js';
import { buildProductEvidenceRegistry, compactProductEvidenceRegistry } from './productEvidenceRegistry.js';
import { enforcePolicyGateBeforeAnswer, runPolicyGate } from './policyGate.js';
import { buildLeadDraft, shouldCommitLeadFromDraft } from './leadDraft.js';
import { sourcePolicyRequiresWeb } from './sourcePolicy.js';
import { applyContractNeedDelta } from './requirementDelta.js';
import { isShownProductChoiceOrComparisonQuestion } from './shownProductChoice.js';
import {
  buildTroubleshootingCaseDraft,
  buildTroubleshootingSearchQuery
} from './troubleshootingMemory.js';

function cleanEmpty(obj: any): any {
  if (obj === null || obj === undefined || obj === '') return undefined;
  if (Array.isArray(obj)) {
    const cleaned = obj.map(cleanEmpty).filter((v) => v !== undefined);
    return cleaned.length > 0 ? cleaned : undefined;
  }
  if (typeof obj === 'object') {
    const cleaned: Record<string, any> = {};
    for (const [key, val] of Object.entries(obj)) {
      const v = cleanEmpty(val);
      if (v !== undefined) cleaned[key] = v;
    }
    return Object.keys(cleaned).length > 0 ? cleaned : undefined;
  }
  return obj;
}

interface GenerateAnswerInput {
  sessionId: string;
  userMessage: string;
  turnId?: string;
  skipUserMessage?: boolean;
  onDelta?: (text: string) => void | Promise<void>;
  signal?: AbortSignal;
}

type AiFallbackDiagnostic = {
  used: boolean;
  reason?: string;
};

type AiGenerationDiagnostics = {
  needExtractionFallback: AiFallbackDiagnostic;
  turnPlanningFallback: AiFallbackDiagnostic;
  answerGenerationFallback: AiFallbackDiagnostic;
};

type AiFallbackStage = keyof AiGenerationDiagnostics;

function emptyAiGenerationDiagnostics(): AiGenerationDiagnostics {
  return {
    needExtractionFallback: { used: false },
    turnPlanningFallback: { used: false },
    answerGenerationFallback: { used: false }
  };
}

function aiFailureReason(error: unknown, fallback = 'unknown_error') {
  if (typeof error === 'string') return error;
  const details = safeError(error);
  return details.code || details.message || (details.status ? `status_${details.status}` : fallback);
}

function markAiFallback(diagnostics: AiGenerationDiagnostics | undefined, stage: AiFallbackStage, error: unknown, fallback?: string) {
  const entry = { used: true, reason: aiFailureReason(error, fallback) };
  if (diagnostics) diagnostics[stage] = entry;
  return entry;
}

function aiStageFailure(stage: string, diagnostic?: AiFallbackDiagnostic): Error {
  return new Error(`AI ${stage} failed: ${diagnostic?.reason ?? 'unknown_error'}`);
}

function applyPostAnswerVerificationPolicy(input: {
  answer: string;
  factClaimPlanner: FactClaimPlanner;
  leadStateMachine: LeadStateMachine;
  cardManifest: CardManifest;
  productEvidenceRegistry?: ProductEvidenceRegistry;
}) {
  let answer = input.answer.trim();
  let factClaimAudit = auditAnswerFactClaims({
    answer,
    factClaimPlanner: input.factClaimPlanner,
    cardManifest: input.cardManifest
  });
  let postAnswerVerification = verifyPostAnswer({
    answer,
    factClaimPlanner: input.factClaimPlanner,
    leadStateMachine: input.leadStateMachine,
    cardManifest: input.cardManifest,
    factClaimAudit,
    productEvidenceRegistry: input.productEvidenceRegistry
  });
  const postAnswerVerificationRecovery: PostAnswerVerificationRecovery = {
    attempted: false,
    recovered: false,
    issuesBefore: postAnswerVerification.issues.map((issue) => issue.code),
    issuesAfter: postAnswerVerification.issues.map((issue) => issue.code),
    method: 'none',
    repairableIssues: [],
    unrecoverableIssues: [],
    reason: undefined
  };

  if (postAnswerVerification.status === 'error') {
    const recoveryPolicy = classifyPostAnswerRecovery(postAnswerVerification);
    postAnswerVerificationRecovery.repairableIssues = recoveryPolicy.repairableIssues;
    postAnswerVerificationRecovery.unrecoverableIssues = recoveryPolicy.unrecoverableIssues;
    postAnswerVerificationRecovery.reason = recoveryPolicy.requiresRegenerationOrTooling
      ? 'unrecoverable_issues_require_regeneration_or_tooling'
      : 'deterministic_text_repair_available';
    const repairedAnswer = repairAnswerForPostAnswerVerification({ answer, verification: postAnswerVerification });
    if (repairedAnswer !== answer) {
      postAnswerVerificationRecovery.attempted = true;
      postAnswerVerificationRecovery.method = 'deterministic_text_repair';
      answer = repairedAnswer;
      factClaimAudit = auditAnswerFactClaims({
        answer,
        factClaimPlanner: input.factClaimPlanner,
        cardManifest: input.cardManifest
      });
      postAnswerVerification = verifyPostAnswer({
        answer,
        factClaimPlanner: input.factClaimPlanner,
        leadStateMachine: input.leadStateMachine,
        cardManifest: input.cardManifest,
        factClaimAudit,
        productEvidenceRegistry: input.productEvidenceRegistry
      });
      postAnswerVerificationRecovery.recovered = postAnswerVerification.status !== 'error';
      postAnswerVerificationRecovery.issuesAfter = postAnswerVerification.issues.map((issue) => issue.code);
      if (!postAnswerVerificationRecovery.recovered) {
        const afterRecoveryPolicy = classifyPostAnswerRecovery(postAnswerVerification);
        postAnswerVerificationRecovery.unrecoverableIssues = afterRecoveryPolicy.unrecoverableIssues;
        postAnswerVerificationRecovery.reason = afterRecoveryPolicy.requiresRegenerationOrTooling
          ? 'deterministic_text_repair_left_unrecoverable_issues'
          : 'deterministic_text_repair_did_not_clear_errors';
      }
    }
  }

  return {
    answer,
    factClaimAudit,
    postAnswerVerification,
    postAnswerVerificationRecovery
  };
}

type WebCitation = {
  url: string;
  title?: string;
  snippet?: string;
};

type TroubleshootingMemoryDecision = {
  usable: boolean;
  selectedCaseIds: string[];
  confidence: number;
  answerGuidance: string;
};

type TroubleshootingMemoryResult = {
  cases: TroubleshootingCase[];
  guidance: string;
  confidence: number;
};

type AssistantTurnAction =
  | 'answer_question'
  | 'recommend_products'
  | 'ask_clarifying_question'
  | 'verify_with_web'
  | 'collect_lead'
  | 'handoff_specialist';

type AnswerMode =
  | 'short'
  | 'productRecommendation'
  | 'detailedFact'
  | 'serviceCostComparison'
  | 'currentLineup'
  | 'leadCollection'
  | 'unknown';

type CardPolicy =
  | 'auto'
  | 'showProducts'
  | 'showAccessories'
  | 'textOnly';

type FollowUpPolicy =
  | 'auto'
  | 'answerNowNoDeferredOffer'
  | 'askClarifyingQuestion'
  | 'offerNextStepAllowed'
  | 'collectLead';

type ContextScope =
  | 'latestMessageOnly'
  | 'activeNeed'
  | 'previousSelection'
  | 'fullSession';

type SearchScope =
  | 'focusedNeed'
  | 'broadenAlternatives'
  | 'sameBrandOnly'
  | 'previousSelectionOnly';

type CardDisplayMode =
  | 'exact_matches'
  | 'compatible_accessories'
  | 'alternatives'
  | 'structured_selection'
  | 'preliminary'
  | 'none';

type SelectionState = {
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

type AssistantTurnPlan = {
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
  agentContractV2?: AgentTurnContractV2 | null;
  needsWebSearch: boolean;
  missingInformation: string[];
  answerGuidance: string;
};

type ProductIntent = ProductSelectionClass;
type ProductFuel = 'gasoline' | 'diesel' | 'any' | 'unknown';
type ProductStartType = 'electric' | 'manual' | 'any' | 'unknown';
type ProductRole = 'coreProduct' | 'accessory' | 'consumable' | 'unknown';
type ProductEnclosure = 'enclosed' | 'open' | 'any' | 'unknown';

type RequiredProductTraits = {
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
  provenance?: ProductSelectionCriteria['provenance'];
};



type StructuredCatalogSlice = {
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

type ProductSelectionResult = {
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

type CardSelectionDiagnostics = {
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

type CardContractDiagnostics = {
  mentionedProductIds: string[];
  addedCardIds: string[];
  outsideFinalCardIds: string[];
  reordered: boolean;
  firstCardAligned: boolean;
};

type FinalCardsDecision = {
  visibleProducts: Product[];
  hiddenProducts: Product[];
  cards: ProductCard[];
  initialVisibleCount: number;
  visibleProductIds: string[];
  hiddenProductIds: string[];
  source: 'selection' | 'turnContract' | 'leadSelection' | 'textOnly';
};

const MAX_PRODUCT_CARDS = 10;
const FULL_SLICE_PRODUCT_CARDS = 50;
const ANSWER_SUITABLE_PRODUCT_CONTEXT_LIMIT = 12;
const ANSWER_HIDDEN_CARD_PREVIEW_LIMIT = 12;
const LARGE_SLICE_VISIBLE_CARDS = 7;
const PLANNER_CANDIDATE_LIMIT = 16;
const MIN_JSON_OUTPUT_TOKENS = 2400;
const PLANNER_HISTORY_LIMIT = 8;
const PLANNER_HISTORY_CONTENT_LIMIT = 700;
const PLANNER_PRODUCT_DESCRIPTION_LIMIT = 900;
const PLANNER_PAGE_SUMMARY_LIMIT = 600;
const PLANNER_PAGE_CONTENT_LIMIT = 1200;
const PLANNER_JSON_OUTPUT_TOKEN_MIN = 8000;
const JSON_RETRY_OUTPUT_TOKEN_MIN = 12000;

function jsonOutputTokenLimit(value: number) {
  return Math.max(value, MIN_JSON_OUTPUT_TOKENS);
}

function truncateForAI(value: unknown, contentLimit: number) {
  const content = String(value ?? '').trim();
  return content.length > contentLimit
    ? `${content.slice(0, contentLimit).trim()}...`
    : content;
}

function compactHistoryForAI(history: Message[], limit: number, contentLimit: number) {
  return history.slice(-limit).map((message) => ({
    role: message.role,
    content: truncateForAI(message.content, contentLimit)
  }));
}

function parseJsonObject(outputText: string | undefined, stage: string) {
  const cleaned = String(outputText ?? '')
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```$/i, '')
    .trim();
  if (!cleaned) throw new Error(`${stage} returned empty JSON`);
  try {
    return JSON.parse(cleaned);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    throw new Error(`${stage} returned invalid JSON: ${message}`);
  }
}

function responseTextForJson(response: unknown) {
  const value = response as { output_text?: string; output?: Array<{ content?: Array<{ text?: string }> }> };
  try {
    if (typeof value.output_text === 'string' && value.output_text.trim()) return value.output_text;
  } catch {
    // Some SDK response helpers throw when the response was incomplete.
  }
  const directText = value.output?.[0]?.content?.[0]?.text;
  if (typeof directText === 'string' && directText.trim()) return directText;
  return extractResponseText(response);
}

async function createStructuredJsonResponse(
  client: ReturnType<typeof createOpenAIClient>,
  request: Record<string, unknown>,
  stage: string,
  signal?: AbortSignal
) {
  if (!client) throw new Error('OpenAI client is not configured');
  const send = (body: Record<string, unknown>) =>
    withRetry(() => client.responses.create(body as any, signal ? { signal } : undefined), 2, signal);
  const response = await send(request);
  try {
    return { response, parsed: parseJsonObject(responseTextForJson(response), stage) };
  } catch (error) {
    if (signal?.aborted) throw error;
    console.warn(`[${stage}] Structured JSON parse failed; retrying with a larger output budget`, safeError(error));
    const currentMax = Number(request.max_output_tokens ?? 0);
    const retryResponse = await send({
      ...request,
      max_output_tokens: Math.max(currentMax * 2, JSON_RETRY_OUTPUT_TOKEN_MIN)
    });
    return { response: retryResponse, parsed: parseJsonObject(responseTextForJson(retryResponse), stage) };
  }
}

function toNeedItems(items: unknown) {
  if (!Array.isArray(items)) return [];
  const now = new Date().toISOString();
  return items
    .filter((item) => item && typeof item === 'object')
    .map((item: any) => ({
      value: String(item.value ?? '').trim(),
      evidence: String(item.evidence ?? '').trim(),
      confidence: Math.max(0, Math.min(1, Number(item.confidence ?? 0.4))),
      updatedAt: now
    }))
    .filter((item) => item.value.length > 0);
}

function clamp01(value: unknown, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(1, number)) : fallback;
}

function shortText(value: unknown, limit: number) {
  return String(value ?? '').trim().slice(0, limit);
}

function coerceActiveNeedProductClass(value: unknown): ActiveCustomerNeed['productClass'] {
  return value === 'commercial' ? 'commercial' : coerceProductIntent(value);
}

function toActiveNeeds(value: unknown): ActiveCustomerNeed[] {
  if (!Array.isArray(value)) return [];
  const now = new Date().toISOString();
  const allowedStatuses: ActiveCustomerNeed['status'][] = ['open', 'selected', 'paused', 'closed'];
  const result: ActiveCustomerNeed[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const raw = item as any;
    const productClass = coerceActiveNeedProductClass(raw.productClass);
    const summary = shortText(raw.summary, 240);
    if (productClass === 'unknown' || !summary) continue;
    const id = shortText(raw.id, 80) || productClass;
    const status = allowedStatuses.includes(raw.status) ? raw.status as ActiveCustomerNeed['status'] : 'open';
    result.push({
      id,
      productClass,
      summary,
      constraints: coerceStringList(raw.constraints, 16),
      openQuestions: coerceStringList(raw.openQuestions, 12),
      selectedProductIds: coerceStringList(raw.selectedProductIds, 16),
      status,
      updatedAt: now
    });
  }
  return result;
}

function coerceElectricalLoadSource(value: unknown): ProductElectricalLoadItem['source'] {
  const allowed: ProductElectricalLoadItem['source'][] = ['explicit_user', 'estimated_average', 'web_average', 'catalog_fact'];
  return allowed.includes(value as ProductElectricalLoadItem['source'])
    ? value as ProductElectricalLoadItem['source']
    : 'estimated_average';
}

function coerceElectricalLoadItems(value: unknown): ProductElectricalLoadItem[] {
  if (!Array.isArray(value)) return [];
  const result: ProductElectricalLoadItem[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const raw = item as any;
    const kind = shortText(raw.kind, 60);
    const runningKw = coerceNullableNumber(raw.runningKw) ?? undefined;
    const startingKw = coerceNullableNumber(raw.startingKw) ?? undefined;
    if (!kind || (!runningKw && !startingKw)) continue;
    result.push({
      kind,
      name: shortText(raw.name, 100) || kind,
      count: Math.max(1, Math.min(12, Math.round(Number(raw.count) || 1))),
      runningKw,
      startingKw,
      source: coerceElectricalLoadSource(raw.source),
      evidence: shortText(raw.evidence, 300)
    });
  }
  return result.slice(0, 16);
}

function coerceGeneratorLoadProfile(value: unknown): ProductGeneratorLoadProfile | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const object = value as Record<string, unknown>;
  const items = coerceElectricalLoadItems(object.items);
  const removedKinds = coerceStringList(object.removedKinds, 12);
  const simultaneousStarting = Boolean(object.simultaneousStarting);
  const simultaneousStartingKinds = coerceStringList(object.simultaneousStartingKinds, 8);
  const calculated = calculateGeneratorLoadProfile(items, simultaneousStarting, simultaneousStartingKinds);
  if (!calculated && !removedKinds.length) return undefined;
  return {
    ...(calculated ?? { items }),
    removedKinds: removedKinds.length ? removedKinds : calculated?.removedKinds,
    simultaneousStarting,
    simultaneousStartingKinds,
    confidence: clamp01(object.confidence, calculated?.confidence ?? 0.5)
  };
}

function coerceCriteriaFromNeedExtraction(value: unknown, fallbackIntent: ProductIntent): ProductSelectionCriteria | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as any;
  const traits = coerceRequiredProductTraits(raw);
  const productIntent = traits.productIntent !== 'unknown' ? traits.productIntent : fallbackIntent;
  const criteria: ProductSelectionCriteria = {
    productIntent,
    productRole: traits.productRole !== 'unknown' ? traits.productRole : productIntent === 'unknown' ? 'unknown' : 'coreProduct',
    exactModelTokens: [],
    exactModelTokenRoles: [],
    mustHaveTraits: coerceStringList(raw.mustHaveTraits, 16),
    excludedClasses: coerceProductIntentList(raw.excludedClasses, 16),
    provenance: {}
  };
  const setNumber = (
    key: 'budgetMax' | 'nominalPowerKwMin' | 'nominalPowerKwMax' | 'maxPowerKwMin' | 'maxPowerKwMax' | 'weightKgMin' | 'weightKgMax' | 'diameterMmMin' | 'diameterMmMax',
    next: number | null
  ) => {
    if (next !== null) {
      criteria[key] = next;
      criteria.provenance![key] = 'planner';
    }
  };
  setNumber('budgetMax', traits.budgetMax);
  setNumber('nominalPowerKwMin', traits.nominalPowerKwMin);
  setNumber('nominalPowerKwMax', traits.nominalPowerKwMax);
  setNumber('maxPowerKwMin', traits.maxPowerKwMin);
  setNumber('maxPowerKwMax', traits.maxPowerKwMax);
  setNumber('weightKgMin', traits.weightKgMin);
  setNumber('weightKgMax', traits.weightKgMax);
  setNumber('diameterMmMin', traits.diameterMmMin);
  setNumber('diameterMmMax', traits.diameterMmMax);
  if (traits.fuel !== 'unknown') {
    criteria.fuel = traits.fuel;
    criteria.provenance!.fuel = 'planner';
  }
  if (traits.startType !== 'unknown') {
    criteria.startType = traits.startType;
    criteria.provenance!.startType = 'planner';
  }
  if (traits.enclosure !== 'unknown') {
    criteria.enclosure = traits.enclosure;
    criteria.provenance!.enclosure = 'planner';
  }
  if (traits.conventionalGenerator !== null) {
    criteria.conventionalGenerator = traits.conventionalGenerator;
    criteria.provenance!.conventionalGenerator = 'planner';
  }
  if (traits.singlePhase220 !== null) {
    criteria.singlePhase220 = traits.singlePhase220;
    criteria.provenance!.singlePhase220 = 'planner';
  }
  const brandConstraint = sanitizeBrandConstraintText(shortText(raw.brandConstraint, 80));
  if (brandConstraint) {
    criteria.brandConstraint = brandConstraint;
    criteria.provenance!.brandConstraint = 'planner';
  }
  const exactModelConstraint = shortText(raw.exactModelConstraint, 120);
  if (exactModelConstraint) {
    criteria.exactModelConstraint = exactModelConstraint;
    criteria.provenance!.exactModelConstraint = 'planner';
  }
  return criteria;
}

function coerceSelectionStateFromNeedExtraction(value: unknown): ProductSelectionState | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const object = value as Record<string, unknown>;
  const loadProfile = coerceGeneratorLoadProfile(object.loadProfile);
  const targetProductClass = coerceProductIntent(object.targetProductClass);
  const currentProductClass = coerceProductIntent(object.currentProductClass);
  const effectiveTarget = targetProductClass !== 'unknown'
    ? targetProductClass
    : loadProfile ? 'generator' : 'unknown';
  const hardConstraints = coerceCriteriaFromNeedExtraction(object.hardConstraints, effectiveTarget);
  const softPreferences = coerceCriteriaFromNeedExtraction(object.softPreferences, effectiveTarget);
  const confidence = clamp01(object.confidence, loadProfile ? 0.58 : 0);
  const hasUpdate = effectiveTarget !== 'unknown' ||
    currentProductClass !== 'unknown' ||
    Boolean(hardConstraints || softPreferences || loadProfile) ||
    coerceStringList(object.unknowns, 16).length > 0;
  if (!hasUpdate) return undefined;
  return mergeProductSelectionState(emptyProductSelectionState(), {
    semanticSource: 'llm_need_extraction',
    currentProductClass: currentProductClass !== 'unknown' ? currentProductClass : effectiveTarget,
    targetProductClass: effectiveTarget,
    hardConstraints,
    softPreferences,
    unknowns: coerceStringList(object.unknowns, 16),
    conflicts: coerceStringList(object.conflicts, 16),
    selectedProductIds: coerceStringList(object.selectedProductIds, 16),
    loadProfile,
    confidence,
    updatedAt: new Date().toISOString()
  });
}

function coerceSemanticRequirementKind(value: unknown): SemanticRequirementKind | undefined {
  const allowed: SemanticRequirementKind[] = ['productClass', 'task', 'weightKg', 'budgetRub', 'powerKw', 'diameterMm', 'brand', 'fuel', 'phase'];
  return allowed.includes(value as SemanticRequirementKind) ? value as SemanticRequirementKind : undefined;
}

function coerceSemanticRequirementStatus(value: unknown): SemanticRequirementStatus {
  const allowed: SemanticRequirementStatus[] = ['active', 'superseded', 'rejected', 'paused'];
  return allowed.includes(value as SemanticRequirementStatus) ? value as SemanticRequirementStatus : 'active';
}

function coerceSemanticRequirementStrictness(value: unknown): SemanticRequirementStrictness {
  const allowed: SemanticRequirementStrictness[] = ['strictOnly', 'targetRange', 'fallbackAllowed'];
  return allowed.includes(value as SemanticRequirementStrictness) ? value as SemanticRequirementStrictness : 'targetRange';
}

function coerceSemanticMemorySource(value: unknown): SemanticMemorySource {
  const allowed: SemanticMemorySource[] = ['explicit_user', 'llm_inference', 'catalog_fact'];
  return allowed.includes(value as SemanticMemorySource) ? value as SemanticMemorySource : 'llm_inference';
}

function coerceSemanticValue(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object') return {};
  const raw = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const key of ['text', 'min', 'max', 'unit', 'productClass', 'brand', 'amount']) {
    const item = raw[key];
    if (item === null || item === undefined || item === '') continue;
    if (typeof item === 'number' && Number.isFinite(item)) result[key] = item;
    if (typeof item === 'string') result[key] = shortText(item, 160);
    if (typeof item === 'boolean') result[key] = item;
  }
  return result;
}

function coerceSemanticRequirements(value: unknown): SemanticRequirement[] {
  if (!Array.isArray(value)) return [];
  const now = new Date().toISOString();
  const result: SemanticRequirement[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const raw = item as Record<string, unknown>;
    const kind = coerceSemanticRequirementKind(raw.kind);
    if (!kind) continue;
    const id = shortText(raw.id, 96) || `${kind}:${result.length}`;
    result.push({
      id,
      kind,
      value: coerceSemanticValue(raw.value),
      status: coerceSemanticRequirementStatus(raw.status),
      strictness: coerceSemanticRequirementStrictness(raw.strictness),
      evidence: shortText(raw.evidence, 300),
      source: coerceSemanticMemorySource(raw.source),
      replacesRequirementIds: coerceStringList(raw.replacesRequirementIds, 24),
      updatedAt: now
    });
  }
  return result.slice(0, 40);
}

function coerceMentionedProductRole(value: unknown): MentionedProductMemory['role'] {
  const allowed: MentionedProductMemory['role'][] = ['targetProduct', 'availabilityCheck', 'comparison', 'example', 'compatibilityTarget'];
  return allowed.includes(value as MentionedProductMemory['role']) ? value as MentionedProductMemory['role'] : 'targetProduct';
}

function coerceMentionedProductStatus(value: unknown): MentionedProductMemory['status'] {
  const allowed: MentionedProductMemory['status'][] = ['unresolved', 'foundInCatalog', 'notFound', 'notMatchingRequirement'];
  return allowed.includes(value as MentionedProductMemory['status']) ? value as MentionedProductMemory['status'] : 'unresolved';
}

function coerceMentionedProducts(value: unknown): MentionedProductMemory[] {
  if (!Array.isArray(value)) return [];
  const now = new Date().toISOString();
  const result: MentionedProductMemory[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const raw = item as Record<string, unknown>;
    const token = shortText(raw.token, 120);
    if (!token) continue;
    const normalizedToken = compactModelText(shortText(raw.normalizedToken, 120) || token);
    result.push({
      token,
      normalizedToken,
      role: coerceMentionedProductRole(raw.role),
      status: coerceMentionedProductStatus(raw.status),
      productIds: coerceStringList(raw.productIds, 24),
      evidence: shortText(raw.evidence, 300),
      updatedAt: now
    });
  }
  return result.slice(0, 40);
}

function coerceSemanticAlternativeMode(value: unknown): SemanticSelectionPolicy['alternativeMode'] {
  const allowed: SemanticSelectionPolicy['alternativeMode'][] = ['none', 'afterPrimary', 'fallbackOnly'];
  return allowed.includes(value as SemanticSelectionPolicy['alternativeMode']) ? value as SemanticSelectionPolicy['alternativeMode'] : 'none';
}

function coerceBotCommitments(value: unknown): BotCommitment[] {
  if (!Array.isArray(value)) return [];
  const now = new Date().toISOString();
  const allowed: BotCommitment['kind'][] = ['availability', 'recommendation', 'constraint', 'fact'];
  const result: BotCommitment[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const raw = item as Record<string, unknown>;
    const kind = allowed.includes(raw.kind as BotCommitment['kind']) ? raw.kind as BotCommitment['kind'] : undefined;
    const text = shortText(raw.text, 260);
    if (!kind || !text) continue;
    result.push({
      kind,
      text,
      productIds: coerceStringList(raw.productIds, 16),
      evidence: shortText(raw.evidence, 300),
      updatedAt: now
    });
  }
  return result.slice(-30);
}

function coerceSemanticMemory(value: unknown): SemanticMemory | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  return {
    version: 1,
    activeRequirementIds: coerceStringList(raw.activeRequirementIds, 64),
    requirements: coerceSemanticRequirements(raw.requirements),
    mentionedProducts: coerceMentionedProducts(raw.mentionedProducts),
    selectionPolicy: {
      primaryRequirementIds: coerceStringList((raw.selectionPolicy as Record<string, unknown> | undefined)?.primaryRequirementIds, 64),
      alternativeMode: coerceSemanticAlternativeMode((raw.selectionPolicy as Record<string, unknown> | undefined)?.alternativeMode),
      explanationRequired: Boolean((raw.selectionPolicy as Record<string, unknown> | undefined)?.explanationRequired)
    },
    botCommitments: coerceBotCommitments(raw.botCommitments)
  };
}

function coerceNeedUpdate(value: any): Partial<CustomerNeedState> {
  return {
    activeNeeds: toActiveNeeds(value?.activeNeeds),
    explicitNeeds: toNeedItems(value?.explicitNeeds),
    implicitNeeds: toNeedItems(value?.implicitNeeds),
    constraints: toNeedItems(value?.constraints),
    importantCriteria: toNeedItems(value?.importantCriteria),
    confirmedFacts: toNeedItems(value?.confirmedFacts),
    uncertainInferences: toNeedItems(value?.uncertainInferences),
    contradictions: toNeedItems(value?.contradictions),
    featureSignals: {
      portable: Number(value?.featureSignals?.portable ?? 0),
      homeUse: Number(value?.featureSignals?.homeUse ?? 0),
      compact: Number(value?.featureSignals?.compact ?? 0),
      lowNoise: Number(value?.featureSignals?.lowNoise ?? 0),
      coldStart: Number(value?.featureSignals?.coldStart ?? 0),
      professionalDuty: Number(value?.featureSignals?.professionalDuty ?? 0),
      budgetSensitive: Number(value?.featureSignals?.budgetSensitive ?? 0)
    },
    selectionState: coerceSelectionStateFromNeedExtraction(value?.selectionState),
    semanticMemory: coerceSemanticMemory(value?.semanticMemory),
    lastSummary: typeof value?.lastSummary === 'string' ? value.lastSummary : ''
  };
}

function activeSemanticRequirements(memory: SemanticMemory | undefined, kind?: SemanticRequirementKind) {
  if (!memory) return [] as SemanticRequirement[];
  const activeIds = new Set(memory.activeRequirementIds ?? []);
  return (memory.requirements ?? []).filter((item) =>
    item.status === 'active' &&
    (!activeIds.size || activeIds.has(item.id)) &&
    (!kind || item.kind === kind)
  );
}

function semanticNumber(value: Record<string, unknown>, key: 'min' | 'max' | 'amount') {
  const number = Number(value[key]);
  return Number.isFinite(number) && number > 0 ? number : undefined;
}

function semanticText(value: Record<string, unknown>, key: 'text' | 'productClass' | 'brand') {
  return typeof value[key] === 'string' ? String(value[key]).trim() : '';
}

function nonRestrictiveConstraintText(value?: string | null) {
  const compact = compactModelText(String(value ?? ''));
  if (!compact) return true;
  return [
    'any',
    'all',
    'none',
    'no',
    'notimportant',
    'brandnotimportant',
    'makenotimportant',
    'doesntmatter',
    'branddoesntmatter',
    'makedoesntmatter',
    'любой',
    'любая',
    'любое',
    'неважен',
    'неважна',
    'неважно',
    'безразницы',
    'брендневажен',
    'марканеважна'
  ].includes(compact);
}

function sanitizeBrandConstraintText(value?: string | null) {
  const text = String(value ?? '').trim();
  return nonRestrictiveConstraintText(text) ? '' : text;
}

function modelTokenGroundedInCurrentTurn(token: string, groundingText: string) {
  const compactToken = compactModelText(token);
  if (compactToken.length < 3) return false;
  return compactModelText(groundingText).includes(compactToken);
}

function productTextLooselyMatchesModelToken(productCompactText: string, token: string) {
  const compactToken = compactModelText(token);
  if (compactToken.length < 3) return false;
  if (productCompactText.includes(compactToken)) return true;
  const parts = String(token)
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/gu)
    .map((part) => compactModelText(part))
    .filter((part) => part.length >= 3);
  const letterParts = parts.filter((part) => /\p{L}/u.test(part));
  const numberParts = parts.filter((part) => /\p{N}/u.test(part));
  return Boolean(letterParts.length && numberParts.length) &&
    letterParts.every((part) => productCompactText.includes(part)) &&
    numberParts.every((part) => productCompactText.includes(part));
}

function withoutExactLookupContextConstraints(criteria: ProductSelectionCriteria): ProductSelectionCriteria {
  const provenance = { ...(criteria.provenance ?? {}) };
  delete provenance.brandConstraint;
  delete provenance.exactModelConstraint;
  delete provenance.nominalPowerKwMin;
  delete provenance.nominalPowerKwMax;
  delete provenance.maxPowerKwMin;
  delete provenance.maxPowerKwMax;
  delete provenance.weightKgMin;
  delete provenance.weightKgMax;
  delete provenance.diameterMmMin;
  delete provenance.diameterMmMax;
  delete provenance.budgetMax;
  delete provenance.fuel;
  delete provenance.startType;
  delete provenance.enclosure;
  delete provenance.conventionalGenerator;
  delete provenance.singlePhase220;
  return {
    ...criteria,
    brandConstraint: '',
    exactModelConstraint: '',
    exactModelTokens: [],
    exactModelTokenRoles: [],
    mustHaveTraits: [],
    excludedClasses: [],
    nominalPowerKwMin: undefined,
    nominalPowerKwMax: undefined,
    maxPowerKwMin: undefined,
    maxPowerKwMax: undefined,
    weightKgMin: undefined,
    weightKgMax: undefined,
    diameterMmMin: undefined,
    diameterMmMax: undefined,
    budgetMax: undefined,
    fuel: undefined,
    startType: undefined,
    enclosure: undefined,
    conventionalGenerator: undefined,
    singlePhase220: undefined,
    provenance
  };
}

function exactLookupRelaxedSelectionState(state: ProductSelectionState): ProductSelectionState {
  return {
    ...state,
    activeRequirement: state.activeRequirement
      ? withoutExactLookupContextConstraints(state.activeRequirement)
      : state.activeRequirement,
    hardConstraints: withoutExactLookupContextConstraints(state.hardConstraints),
    loadProfile: undefined
  };
}

function exactLookupRelaxedTraits(traits: RequiredProductTraits): RequiredProductTraits {
  return {
    ...traits,
    fuel: 'unknown',
    startType: 'unknown',
    enclosure: 'unknown',
    conventionalGenerator: null,
    singlePhase220: null,
    budgetMax: null,
    weightKgMin: null,
    weightKgMax: null,
    diameterMmMin: null,
    diameterMmMax: null,
    nominalPowerKwMin: null,
    nominalPowerKwMax: null,
    maxPowerKwMin: null,
    maxPowerKwMax: null,
    powerReasoning: ''
  };
}

function intentAcceptsRequirementKind(intent: ProductIntent, kind: SemanticRequirementKind) {
  if (kind === 'powerKw' || kind === 'phase') return intent === 'generator' || intent === 'weldingGenerator';
  if (kind === 'weightKg') return ['plate', 'rammer', 'roller', 'trowel'].includes(intent);
  if (kind === 'diameterMm') return ['diamondBlade', 'diamondCore', 'cutter', 'trowel'].includes(intent);
  return true;
}

function generatorOnlyIntent(intent: ProductIntent) {
  return intent === 'generator' || intent === 'weldingGenerator';
}

function intentTermsForGenericTarget(intent: ProductIntent) {
  if (intent === 'plate') return plateTerms;
  if (intent === 'generator' || intent === 'weldingGenerator') return [...generatorTerms, ...weldingTerms];
  if (intent === 'rammer') return rammerTerms;
  if (intent === 'roller') return rollerTerms;
  if (intent === 'cutter') return cutterTerms;
  if (intent === 'diamondBlade') return diamondBladeTerms;
  if (intent === 'diamondCore') return diamondCoreTerms;
  if (intent === 'trowel') return trowelTerms;
  return [];
}

function hasModelLikeNumberWithoutUnit(token: string) {
  const normalized = token.toLowerCase();
  const matches = [...normalized.matchAll(/\d{2,5}/gu)];
  if (!matches.length) return false;
  return matches.some((match) => {
    const index = match.index ?? 0;
    const after = normalized.slice(index + match[0].length, index + match[0].length + 12);
    return !/^\s*(?:кг|kg|квт|kw|вт|w|мм|mm|в|v)(?:\s|$|[.,;:)\]-])/iu.test(after);
  });
}

function isGenericProductTargetToken(token: string, intent: ProductIntent) {
  const terms = intentTermsForGenericTarget(intent);
  if (!terms.length || !containsAny(token, terms)) return false;
  if (/(?:\d+(?:[,.]\d+)?\s*(?:[-\u2010-\u2015]|\u0434\u043e|to)\s*\d+(?:[,.]\d+)?|\b\d+(?:[,.]\d+)?)\s*(?:\u043a\u0433|kg|\u043a\u0432\u0442|kw|\u0432\u0442|w|\u043c\u043c|mm|\u0432|v)(?:\s|$|[.,;:!?])/iu.test(token)) return true;
  if (hasModelLikeNumberWithoutUnit(token)) return false;
  return /(?:нуж|под|для|показ|есть|вариант|примерн|около|порядка|диск|need|show|for|about|around|disc|disk|option)/iu.test(token);
}

function isSemanticExactModelTargetToken(token: string, intent: ProductIntent) {
  const targetIntent = coerceProductIntent(intent);
  return isLikelyModelToken(token) && !isGenericProductTargetToken(token, targetIntent);
}

function clearUngroundedExactModelCriteria(criteria: ProductSelectionCriteria, groundingText: string): ProductSelectionCriteria {
  const targetIntent = coerceProductIntent(criteria.productIntent);
  const groundedTokens = (criteria.exactModelTokens ?? []).filter((token) =>
    modelTokenGroundedInCurrentTurn(token, groundingText) &&
    isSemanticExactModelTargetToken(token, targetIntent)
  );
  const exactModelConstraint = criteria.exactModelConstraint &&
    modelTokenGroundedInCurrentTurn(criteria.exactModelConstraint, groundingText) &&
    isSemanticExactModelTargetToken(criteria.exactModelConstraint, targetIntent)
    ? criteria.exactModelConstraint
    : '';
  const exactModelTokenRoles = (criteria.exactModelTokenRoles ?? []).filter((item) =>
    item.role !== 'targetProduct' ||
    (
      modelTokenGroundedInCurrentTurn(item.value, groundingText) &&
      isSemanticExactModelTargetToken(item.value, targetIntent)
    )
  );
  if (
    exactModelConstraint === criteria.exactModelConstraint &&
    groundedTokens.length === (criteria.exactModelTokens ?? []).length &&
    exactModelTokenRoles.length === (criteria.exactModelTokenRoles ?? []).length
  ) {
    return criteria;
  }
  const provenance = { ...(criteria.provenance ?? {}) };
  if (!exactModelConstraint) delete provenance.exactModelConstraint;
  return {
    ...criteria,
    exactModelConstraint,
    exactModelTokens: groundedTokens,
    exactModelTokenRoles,
    provenance
  };
}

function clearUngroundedExactModelSelectionState(state: ProductSelectionState, groundingText: string): ProductSelectionState {
  const hardConstraints = clearUngroundedExactModelCriteria(state.hardConstraints, groundingText);
  const activeRequirement = state.activeRequirement
    ? clearUngroundedExactModelCriteria(state.activeRequirement, groundingText)
    : state.activeRequirement;
  return {
    ...state,
    hardConstraints,
    activeRequirement
  };
}

function plannerSelectionIsCurrentContract(plan: AssistantTurnPlan) {
  if (!plannerHasSemanticSelection(plan)) return false;
  const catalogAction = plan.agentDecision?.catalogAction;
  return catalogAction === 'find_matching_products' ||
    catalogAction === 'exact_model_lookup' ||
    catalogAction === 'verify_catalog_absence' ||
    plan.selectionState.shouldShowCards ||
    plan.cardPolicy === 'showProducts';
}

function productIntentFromPlannerContract(plan: AssistantTurnPlan): ProductIntent {
  const selectionTarget = coerceProductIntent(plan.selectionState.targetProductClass);
  if (selectionTarget !== 'unknown') return selectionTarget;
  const selectionCurrent = coerceProductIntent(plan.selectionState.currentProductClass);
  if (selectionCurrent !== 'unknown') return selectionCurrent;
  return plan.requiredProductTraits.productIntent;
}

function applyPlannerSelectionContract(state: ProductSelectionState, plan: AssistantTurnPlan): ProductSelectionState {
  if (!plannerSelectionIsCurrentContract(plan)) return state;
  const plannerTraits = plan.requiredProductTraits;
  const productIntent = productIntentFromPlannerContract(plan);
  const plannerMustHaveTraits = uniqueList([
    ...plan.selectionState.mustHaveTraits,
    ...plan.selectionState.niceToHaveTraits
  ], 24);
  const plannerBrand = sanitizeBrandConstraintText(plan.selectionState.brandConstraint);
  const rawPlannerExactModel = shortText(plan.selectionState.exactModelConstraint, 160).trim();
  const plannerExactModel = isSemanticExactModelTargetToken(rawPlannerExactModel, productIntent)
    ? rawPlannerExactModel
    : '';
  const syncCriteria = (criteria: ProductSelectionCriteria): ProductSelectionCriteria => {
    const provenance = { ...(criteria.provenance ?? {}) };
    const next: ProductSelectionCriteria = {
      ...criteria,
      mustHaveTraits: plannerMustHaveTraits,
      provenance
    };

    if (!plannerBrand && provenance.brandConstraint === 'planner') {
      next.brandConstraint = '';
      delete provenance.brandConstraint;
    }
    if (!plannerExactModel && provenance.exactModelConstraint === 'planner') {
      next.exactModelConstraint = '';
      next.exactModelTokens = [];
      next.exactModelTokenRoles = [];
      delete provenance.exactModelConstraint;
    }

    if (generatorOnlyIntent(productIntent)) {
      if (plannerTraits.fuel === 'gasoline' || plannerTraits.fuel === 'diesel') {
        next.fuel = plannerTraits.fuel;
        provenance.fuel = 'planner';
      } else if (provenance.fuel === 'planner') {
        next.fuel = undefined;
        delete provenance.fuel;
      }
      if (plannerTraits.singlePhase220 !== null) {
        const priorPhaseSource = criteria.provenance?.singlePhase220;
        const priorPhaseStillMatches = criteria.singlePhase220 === plannerTraits.singlePhase220;
        next.singlePhase220 = plannerTraits.singlePhase220;
        provenance.singlePhase220 = priorPhaseSource === 'explicit_user' && priorPhaseStillMatches ? 'explicit_user' : 'planner';
      } else if (provenance.singlePhase220 === 'planner') {
        next.singlePhase220 = undefined;
        delete provenance.singlePhase220;
      }
    }

    return next;
  };

  return {
    ...state,
    hardConstraints: syncCriteria(state.hardConstraints),
    activeRequirement: state.activeRequirement ? syncCriteria(state.activeRequirement) : state.activeRequirement,
    selectedProductIds: [...plan.selectedProductIds]
  };
}

function applyCurrentTurnExplicitNumericCriteria(state: ProductSelectionState, userMessage: string): ProductSelectionState {
  const productIntent = state.targetProductClass !== 'unknown'
    ? state.targetProductClass
    : state.hardConstraints.productIntent;
  const explicitPowerRange = generatorOnlyIntent(productIntent as ProductIntent)
    ? currentTurnExplicitGeneratorPowerRange(userMessage)
    : undefined;
  const parsedWeightRange = intentAcceptsRequirementKind(productIntent as ProductIntent, 'weightKg')
    ? parseWeightNeedRangeKg(userMessage)
    : undefined;
  const singleWeightTarget = parseSingleWeightTargetKg(userMessage);
  const explicitWeightRangeOrBound = /(?:\d{2,4}\s*(?:[-\u2010-\u2015]|\u0434\u043e)\s*\d{2,4}\s*(?:\u043a\u0433|kg)|(?:\u0434\u043e|\u043d\u0435\s+\u0442\u044f\u0436\u0435\u043b\u0435\u0435|\u043e\u0442|\u043d\u0435\s+\u043b\u0435\u0433\u0447\u0435|\u043c\u0438\u043d(?:\u0438\u043c\u0443\u043c)?|\u043c\u0430\u043a\u0441(?:\u0438\u043c\u0443\u043c)?|from|up\s+to|min(?:imum)?|max(?:imum)?)\s*\d{2,4}\s*(?:\u043a\u0433|kg))/iu.test(userMessage);
  const weightRange = parsedWeightRange && (explicitWeightRangeOrBound || (singleWeightTarget ?? 0) >= 600)
    ? parsedWeightRange
    : undefined;
  const dimensionRange = intentAcceptsRequirementKind(productIntent as ProductIntent, 'diameterMm')
    ? parseDimensionNeedRangeMm(userMessage)
    : undefined;
  if (!explicitPowerRange && !weightRange && !dimensionRange) return state;

  const apply = (criteria: ProductSelectionCriteria): ProductSelectionCriteria => {
    const provenance = { ...(criteria.provenance ?? {}) };
    const next: ProductSelectionCriteria = { ...criteria, provenance };
    if (explicitPowerRange) {
      next.nominalPowerKwMin = explicitPowerRange.min;
      next.nominalPowerKwMax = explicitPowerRange.max;
      provenance.nominalPowerKwMin = 'explicit_user';
      provenance.nominalPowerKwMax = 'explicit_user';
      if (provenance.maxPowerKwMin !== 'explicit_user') {
        next.maxPowerKwMin = undefined;
        delete provenance.maxPowerKwMin;
      }
      if (provenance.maxPowerKwMax !== 'explicit_user') {
        next.maxPowerKwMax = undefined;
        delete provenance.maxPowerKwMax;
      }
    }
    if (weightRange) {
      next.weightKgMin = weightRange.min;
      next.weightKgMax = weightRange.max;
      provenance.weightKgMin = 'explicit_user';
      provenance.weightKgMax = 'explicit_user';
    }
    if (dimensionRange) {
      next.diameterMmMin = dimensionRange.min;
      next.diameterMmMax = dimensionRange.max;
      provenance.diameterMmMin = 'explicit_user';
      provenance.diameterMmMax = 'explicit_user';
    }
    return next;
  };

  return {
    ...state,
    hardConstraints: apply(state.hardConstraints),
    activeRequirement: state.activeRequirement ? apply(state.activeRequirement) : state.activeRequirement
  };
}

function roundGeneratorTargetPower(value: number) {
  return Math.round(value * 10) / 10;
}

function practicalSingleGeneratorPowerRangeKw(value: number) {
  const tolerance = value <= 3
    ? 0.5
    : value <= 6
      ? 0.8
      : value <= 15
        ? Math.max(1, value * 0.1)
        : value * 0.12;
  return {
    min: Math.max(0.5, roundGeneratorTargetPower(value - tolerance)),
    max: roundGeneratorTargetPower(value + tolerance)
  };
}

function currentTurnExplicitGeneratorPowerRange(userMessage: string) {
  const range = parseDesiredPowerRange(userMessage);
  if (range) return range;
  if (!hasExplicitGeneratorPowerRequest(userMessage)) return undefined;
  const target = explicitGeneratorPowerRequestKw(userMessage);
  if (!target || !Number.isFinite(target)) return undefined;
  return practicalSingleGeneratorPowerRangeKw(target);
}

function clearStaleLoadSizingForExplicitCatalogPower(state: ProductSelectionState, userMessage: string, plan: AssistantTurnPlan): ProductSelectionState {
  if (!generatorOnlyIntent(state.hardConstraints.productIntent as ProductIntent)) return state;
  if (plan.agentDecision?.catalogAction !== 'find_matching_products') return state;
  const hasExplicitPower = Boolean(parseDesiredPowerRange(userMessage) || hasExplicitGeneratorPowerRequest(userMessage));
  if (!hasExplicitPower) return state;
  const clearCriteria = (criteria: ProductSelectionCriteria): ProductSelectionCriteria => {
    const provenance = { ...(criteria.provenance ?? {}) };
    const next = { ...criteria, provenance };
    if (provenance.maxPowerKwMin === 'inferred_from_load') {
      delete next.maxPowerKwMin;
      delete provenance.maxPowerKwMin;
    }
    if (provenance.maxPowerKwMax === 'inferred_from_load') {
      delete next.maxPowerKwMax;
      delete provenance.maxPowerKwMax;
    }
    return next;
  };
  return {
    ...state,
    loadProfile: undefined,
    hardConstraints: clearCriteria(state.hardConstraints),
    activeRequirement: state.activeRequirement ? clearCriteria(state.activeRequirement) : state.activeRequirement
  };
}

function clearGeneratorOnlyCriteriaForNonGeneratorState(state: ProductSelectionState): ProductSelectionState {
  if (generatorOnlyIntent(state.hardConstraints.productIntent as ProductIntent)) return state;
  const clearCriteria = (criteria: ProductSelectionCriteria): ProductSelectionCriteria => {
    const provenance = { ...(criteria.provenance ?? {}) };
    delete provenance.fuel;
    delete provenance.startType;
    delete provenance.enclosure;
    delete provenance.conventionalGenerator;
    delete provenance.singlePhase220;
    delete provenance.nominalPowerKwMin;
    delete provenance.nominalPowerKwMax;
    delete provenance.maxPowerKwMin;
    delete provenance.maxPowerKwMax;
    return {
      ...criteria,
      fuel: undefined,
      startType: undefined,
      enclosure: undefined,
      conventionalGenerator: undefined,
      singlePhase220: undefined,
      nominalPowerKwMin: undefined,
      nominalPowerKwMax: undefined,
      maxPowerKwMin: undefined,
      maxPowerKwMax: undefined,
      provenance
    };
  };
  return {
    ...state,
    loadProfile: undefined,
    hardConstraints: clearCriteria(state.hardConstraints),
    activeRequirement: state.activeRequirement ? clearCriteria(state.activeRequirement) : state.activeRequirement
  };
}

function currentTurnGeneratorPhase(text: string): boolean | undefined {
  const hasThreePhase = /(?:380\s*(?:в|v)|400\s*(?:в|v)|230\s*\/\s*400|220\s*\/\s*380|тр[её]х\s*фаз|тр[её]хфаз|3\s*фаз|three[-\s]?phase)/iu.test(text);
  if (hasThreePhase) return false;
  const hasSinglePhase = /(?:220\s*(?:в|v)|230\s*(?:в|v)|одно\s*фаз|однофаз|single[-\s]?phase)/iu.test(text);
  return hasSinglePhase ? true : undefined;
}

function applyCurrentTurnGeneratorPhase(state: ProductSelectionState, groundingText: string, plannerSinglePhase?: boolean | null): ProductSelectionState {
  if (!generatorOnlyIntent(state.hardConstraints.productIntent as ProductIntent)) return state;
  const hasPlannerPhase = plannerSinglePhase !== undefined && plannerSinglePhase !== null;
  const groundedPhase = currentTurnGeneratorPhase(groundingText);
  const singlePhase220 = groundedPhase !== undefined ? groundedPhase : hasPlannerPhase ? plannerSinglePhase : undefined;
  if (singlePhase220 === undefined) return state;
  const source = groundedPhase !== undefined ? 'explicit_user' : 'planner';
  const apply = (criteria: ProductSelectionCriteria): ProductSelectionCriteria => ({
    ...criteria,
    singlePhase220,
    provenance: {
      ...(criteria.provenance ?? {}),
      singlePhase220: source
    }
  });
  return {
    ...state,
    hardConstraints: apply(state.hardConstraints),
    activeRequirement: state.activeRequirement ? apply(state.activeRequirement) : state.activeRequirement
  };
}

function applySemanticMemoryToSelectionState(
  selectionState: ProductSelectionState,
  memory: SemanticMemory | undefined,
  groundingText = ''
): ProductSelectionState {
  const requirements = activeSemanticRequirements(memory);
  if (!requirements.length && !(memory?.mentionedProducts ?? []).length) return selectionState;

  let hardConstraints: ProductSelectionCriteria = {
    ...selectionState.hardConstraints,
    exactModelTokens: [...selectionState.hardConstraints.exactModelTokens],
    exactModelTokenRoles: [...(selectionState.hardConstraints.exactModelTokenRoles ?? [])],
    mustHaveTraits: [...selectionState.hardConstraints.mustHaveTraits],
    excludedClasses: [...selectionState.hardConstraints.excludedClasses],
    provenance: { ...(selectionState.hardConstraints.provenance ?? {}) }
  };
  let currentProductClass = selectionState.currentProductClass;
  let targetProductClass = selectionState.targetProductClass;
  const currentTurnTargetClass = selectionState.targetProductClass !== 'unknown'
    ? selectionState.targetProductClass
    : selectionState.hardConstraints.productIntent !== 'unknown'
      ? selectionState.hardConstraints.productIntent
      : undefined;

  for (const requirement of requirements) {
    const value = requirement.value ?? {};
    if (requirement.kind === 'productClass') {
      const productClass = coerceProductIntent(semanticText(value, 'productClass') || semanticText(value, 'text'));
      if (productClass !== 'unknown') {
        currentProductClass = currentProductClass !== 'unknown' ? currentProductClass : productClass;
        if (!currentTurnTargetClass || currentTurnTargetClass === productClass) {
          targetProductClass = productClass;
          hardConstraints.productIntent = productClass;
        }
      }
    }
    if (requirement.kind === 'task') {
      const task = semanticText(value, 'text');
      if (task) hardConstraints.mustHaveTraits = uniqueList([...hardConstraints.mustHaveTraits, task], 24);
    }
    if (requirement.kind === 'weightKg') {
      if (!intentAcceptsRequirementKind(targetProductClass, requirement.kind)) continue;
      const min = semanticNumber(value, 'min');
      const max = semanticNumber(value, 'max') ?? semanticNumber(value, 'amount');
      hardConstraints = {
        ...hardConstraints,
        weightKgMin: min,
        weightKgMax: max,
        provenance: {
          ...(hardConstraints.provenance ?? {}),
          weightKgMin: min !== undefined ? 'planner' : hardConstraints.provenance?.weightKgMin,
          weightKgMax: max !== undefined ? 'planner' : hardConstraints.provenance?.weightKgMax
        }
      };
    }
    if (requirement.kind === 'budgetRub') {
      const budget = semanticNumber(value, 'max') ?? semanticNumber(value, 'amount');
      if (budget) {
        hardConstraints.budgetMax = budget;
        hardConstraints.provenance = { ...(hardConstraints.provenance ?? {}), budgetMax: 'planner' };
      }
    }
    if (requirement.kind === 'powerKw') {
      if (!intentAcceptsRequirementKind(targetProductClass, requirement.kind)) continue;
      if (!semanticRequirementAppliesToSelection(requirement, targetProductClass)) continue;
      const amount = semanticNumber(value, 'amount');
      let min = semanticNumber(value, 'min');
      let max = semanticNumber(value, 'max') ?? amount;
      const evidenceText = [
        semanticText(value, 'text'),
        requirement.evidence
      ].filter(Boolean).join(' ');
      if (!min && amount && max === amount && !textMarksPowerUpperBound(evidenceText) && !parseDesiredPowerRange(evidenceText)) {
        min = amount;
      }
      hardConstraints = {
        ...hardConstraints,
        nominalPowerKwMin: min,
        nominalPowerKwMax: max,
        provenance: {
          ...(hardConstraints.provenance ?? {}),
          nominalPowerKwMin: min !== undefined ? 'planner' : hardConstraints.provenance?.nominalPowerKwMin,
          nominalPowerKwMax: max !== undefined ? 'planner' : hardConstraints.provenance?.nominalPowerKwMax
        }
      };
    }
    if (requirement.kind === 'diameterMm') {
      if (!intentAcceptsRequirementKind(targetProductClass, requirement.kind)) continue;
      const min = semanticNumber(value, 'min');
      const max = semanticNumber(value, 'max') ?? semanticNumber(value, 'amount');
      hardConstraints = {
        ...hardConstraints,
        diameterMmMin: min,
        diameterMmMax: max,
        provenance: {
          ...(hardConstraints.provenance ?? {}),
          diameterMmMin: min !== undefined ? 'planner' : hardConstraints.provenance?.diameterMmMin,
          diameterMmMax: max !== undefined ? 'planner' : hardConstraints.provenance?.diameterMmMax
        }
      };
    }
    if (requirement.kind === 'brand') {
      const brand = sanitizeBrandConstraintText(semanticText(value, 'brand') || semanticText(value, 'text'));
      if (brand && !hardConstraints.brandConstraint) {
        hardConstraints.brandConstraint = brand;
        hardConstraints.provenance = { ...(hardConstraints.provenance ?? {}), brandConstraint: 'planner' };
      }
    }
    if (requirement.kind === 'fuel') {
      const fuelText = semanticText(value, 'text').toLowerCase();
      if (fuelText === 'gasoline' || fuelText === 'diesel' || fuelText === 'any') {
        hardConstraints.fuel = fuelText;
        hardConstraints.provenance = { ...(hardConstraints.provenance ?? {}), fuel: 'planner' };
      }
    }
    if (requirement.kind === 'phase') {
      if (!intentAcceptsRequirementKind(targetProductClass, requirement.kind)) continue;
      const phaseText = semanticText(value, 'text').toLowerCase();
      if (phaseText === 'single_phase_220' || phaseText === '220' || phaseText === '220v') {
        hardConstraints.singlePhase220 = true;
        hardConstraints.provenance = { ...(hardConstraints.provenance ?? {}), singlePhase220: 'planner' };
      }
    }
  }

  for (const product of memory?.mentionedProducts ?? []) {
    if (!product.token) continue;
    if (product.role === 'targetProduct') {
      if (!modelTokenGroundedInCurrentTurn(product.token, groundingText)) continue;
      if (!isSemanticExactModelTargetToken(product.token, targetProductClass)) continue;
      hardConstraints.exactModelTokens = uniqueList([...hardConstraints.exactModelTokens, product.token], 16);
    } else if (product.role === 'availabilityCheck' || product.role === 'comparison') {
      hardConstraints.exactModelTokenRoles = [
        ...(hardConstraints.exactModelTokenRoles ?? []),
        { value: product.token, role: 'comparisonProduct' as const, evidence: product.evidence }
      ].filter((item, index, all) => all.findIndex((candidate) => candidate.value === item.value && candidate.role === item.role) === index).slice(0, 24);
    } else if (product.role === 'compatibilityTarget') {
      hardConstraints.exactModelTokenRoles = [
        ...(hardConstraints.exactModelTokenRoles ?? []),
        { value: product.token, role: 'compatibilityTarget' as const, evidence: product.evidence }
      ].filter((item, index, all) => all.findIndex((candidate) => candidate.value === item.value && candidate.role === item.role) === index).slice(0, 24);
    }
  }

  return {
    ...selectionState,
    semanticSource: 'llm_need_extraction',
    currentProductClass,
    targetProductClass,
    hardConstraints,
    activeRequirement: {
      ...(selectionState.activeRequirement ?? hardConstraints),
      ...hardConstraints
    }
  };
}

function semanticAlternativeMode(memory: SemanticMemory | undefined, targetProductClass: ProductIntent = 'unknown') {
  const active = activeSemanticRequirements(memory).filter((item) =>
    ['weightKg', 'budgetRub', 'powerKw', 'diameterMm'].includes(item.kind) &&
    (targetProductClass === 'unknown' || semanticRequirementAppliesToSelection(item, targetProductClass))
  );
  if (!active.length) return { mode: memory?.selectionPolicy?.alternativeMode ?? 'none' as const, hasNumeric: false, strictOnly: false };
  if (memory?.selectionPolicy?.alternativeMode) {
    if (memory.selectionPolicy.alternativeMode === 'none') {
      return { mode: 'none' as const, hasNumeric: true, strictOnly: true };
    }
    return { mode: memory.selectionPolicy.alternativeMode, hasNumeric: true, strictOnly: false };
  }
  if (active.some((item) => item.strictness === 'fallbackAllowed')) return { mode: 'fallbackOnly' as const, hasNumeric: true, strictOnly: false };
  if (active.some((item) => item.strictness === 'targetRange')) return { mode: 'afterPrimary' as const, hasNumeric: true, strictOnly: false };
  return { mode: 'none' as const, hasNumeric: true, strictOnly: true };
}

function semanticMentionTokens(memory: SemanticMemory | undefined, roles: MentionedProductMemory['role'][]) {
  const allowedRoles = new Set(roles);
  return uniqueList((memory?.mentionedProducts ?? [])
    .filter((item) => allowedRoles.has(item.role))
    .map((item) => item.token), 32);
}

function coerceProductIntent(value: unknown): ProductIntent {
  const allowed: ProductIntent[] = [
    'generator',
    'weldingGenerator',
    'generatorOil',
    'engineOil',
    'generatorAccessory',
    'plateAccessory',
    'plate',
    'rammer',
    'roller',
    'cutter',
    'diamondBlade',
    'diamondCore',
    'trowel',
    'unknown'
  ];
  return allowed.includes(value as ProductIntent) ? value as ProductIntent : 'unknown';
}

function coerceFuel(value: unknown): ProductFuel {
  const allowed: ProductFuel[] = ['gasoline', 'diesel', 'any', 'unknown'];
  return allowed.includes(value as ProductFuel) ? value as ProductFuel : 'unknown';
}

function coerceStartType(value: unknown): ProductStartType {
  const allowed: ProductStartType[] = ['electric', 'manual', 'any', 'unknown'];
  return allowed.includes(value as ProductStartType) ? value as ProductStartType : 'unknown';
}

function coerceProductRole(value: unknown): ProductRole {
  const allowed: ProductRole[] = ['coreProduct', 'accessory', 'consumable', 'unknown'];
  return allowed.includes(value as ProductRole) ? value as ProductRole : 'unknown';
}

function coerceProductEnclosure(value: unknown): ProductEnclosure {
  const allowed: ProductEnclosure[] = ['enclosed', 'open', 'any', 'unknown'];
  return allowed.includes(value as ProductEnclosure) ? value as ProductEnclosure : 'unknown';
}

function coerceAnswerMode(value: unknown): AnswerMode {
  const allowed: AnswerMode[] = [
    'short',
    'productRecommendation',
    'detailedFact',
    'serviceCostComparison',
    'currentLineup',
    'leadCollection',
    'unknown'
  ];
  return allowed.includes(value as AnswerMode) ? value as AnswerMode : 'unknown';
}

function coerceCardPolicy(value: unknown): CardPolicy {
  const allowed: CardPolicy[] = ['auto', 'showProducts', 'showAccessories', 'textOnly'];
  return allowed.includes(value as CardPolicy) ? value as CardPolicy : 'auto';
}

function coerceFollowUpPolicy(value: unknown): FollowUpPolicy {
  const allowed: FollowUpPolicy[] = [
    'auto',
    'answerNowNoDeferredOffer',
    'askClarifyingQuestion',
    'offerNextStepAllowed',
    'collectLead'
  ];
  return allowed.includes(value as FollowUpPolicy) ? value as FollowUpPolicy : 'auto';
}

function coerceAgentAnswerTask(value: unknown): AgentTurnContract['answerTask'] {
  const allowed: AgentTurnContract['answerTask'][] = [
    'technical_explanation',
    'comparison',
    'product_selection',
    'mixed',
    'lead_handoff'
  ];
  return allowed.includes(value as AgentTurnContract['answerTask'])
    ? value as AgentTurnContract['answerTask']
    : 'mixed';
}

function coerceAgentCardsRole(value: unknown): AgentTurnContract['cardsRole'] {
  const allowed: AgentTurnContract['cardsRole'][] = ['none', 'supporting', 'primary'];
  return allowed.includes(value as AgentTurnContract['cardsRole'])
    ? value as AgentTurnContract['cardsRole']
    : 'none';
}

function coerceAgentTaskType(value: unknown): AgentTurnContract['taskType'] | undefined {
  const allowed: NonNullable<AgentTurnContract['taskType']>[] = [
    'pure_delivery',
    'pure_availability',
    'product_selection',
    'product_selection_with_delivery',
    'product_selection_with_availability',
    'technical_answer',
    'comparison',
    'contact_refusal_continue_selection'
  ];
  return allowed.includes(value as NonNullable<AgentTurnContract['taskType']>)
    ? value as NonNullable<AgentTurnContract['taskType']>
    : undefined;
}

function coerceAgentCatalogAction(value: unknown): AgentTurnContract['catalogAction'] | undefined {
  const allowed: NonNullable<AgentTurnContract['catalogAction']>[] = [
    'none',
    'exact_model_lookup',
    'find_matching_products',
    'verify_catalog_absence'
  ];
  return allowed.includes(value as NonNullable<AgentTurnContract['catalogAction']>)
    ? value as NonNullable<AgentTurnContract['catalogAction']>
    : undefined;
}

function coerceAgentCommercialAction(value: unknown): AgentTurnContract['commercialAction'] | undefined {
  const allowed: NonNullable<AgentTurnContract['commercialAction']>[] = [
    'none',
    'explain_manager_required',
    'offer_contact_after_answer'
  ];
  return allowed.includes(value as NonNullable<AgentTurnContract['commercialAction']>)
    ? value as NonNullable<AgentTurnContract['commercialAction']>
    : undefined;
}

function coerceAgentProductCardsPolicy(value: unknown): AgentTurnContract['productCardsPolicy'] | undefined {
  const allowed: NonNullable<AgentTurnContract['productCardsPolicy']>[] = [
    'none',
    'show_exact_matches',
    'show_matching_products',
    'supporting_only'
  ];
  return allowed.includes(value as NonNullable<AgentTurnContract['productCardsPolicy']>)
    ? value as NonNullable<AgentTurnContract['productCardsPolicy']>
    : undefined;
}

function coerceAgentDecision(value: any): AssistantTurnPlan['agentDecision'] | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const confidence = Number(value.confidence);
  return {
    answerTask: coerceAgentAnswerTask(value.answerTask),
    taskType: coerceAgentTaskType(value.taskType),
    catalogAction: coerceAgentCatalogAction(value.catalogAction),
    commercialAction: coerceAgentCommercialAction(value.commercialAction),
    productCardsPolicy: coerceAgentProductCardsPolicy(value.productCardsPolicy),
    mustAnswerNow: coerceStringList(value.mustAnswerNow, 8),
    currentFocus: String(value.currentFocus ?? '').trim().slice(0, 80),
    cardsRole: coerceAgentCardsRole(value.cardsRole),
    leadAllowed: typeof value.leadAllowed === 'boolean' ? value.leadAllowed : true,
    leadAllowedReason: String(value.leadAllowedReason ?? '').trim().slice(0, 240),
    errorRecoveryPriority: String(value.errorRecoveryPriority ?? '').trim().slice(0, 400),
    confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0
  };
}

function agentDecisionFromContractV2(contract: AgentTurnContractV2): AssistantTurnPlan['agentDecision'] {
  const legacy = contractV2ToLegacyAgentContract(contract);
  return {
    answerTask: legacy.answerTask,
    taskType: legacy.taskType,
    catalogAction: legacy.catalogAction,
    commercialAction: legacy.commercialAction,
    productCardsPolicy: legacy.productCardsPolicy,
    mustAnswerNow: legacy.mustAnswerNow,
    currentFocus: legacy.currentFocus,
    cardsRole: legacy.cardsRole,
    leadAllowed: legacy.leadAllowed,
    leadAllowedReason: legacy.leadAllowedReason,
    errorRecoveryPriority: legacy.errorRecoveryPriority,
    confidence: contract.confidence
  };
}

function coerceContextScope(value: unknown): ContextScope {
  const allowed: ContextScope[] = ['latestMessageOnly', 'activeNeed', 'previousSelection', 'fullSession'];
  return allowed.includes(value as ContextScope) ? value as ContextScope : 'activeNeed';
}

function coerceSearchScope(value: unknown): SearchScope {
  const allowed: SearchScope[] = ['focusedNeed', 'broadenAlternatives', 'sameBrandOnly', 'previousSelectionOnly'];
  return allowed.includes(value as SearchScope) ? value as SearchScope : 'focusedNeed';
}

function coerceCardDisplayMode(value: unknown): CardDisplayMode {
  const allowed: CardDisplayMode[] = ['exact_matches', 'compatible_accessories', 'alternatives', 'structured_selection', 'preliminary', 'none'];
  return allowed.includes(value as CardDisplayMode) ? value as CardDisplayMode : 'preliminary';
}

function coerceStringList(value: unknown, limit = 12) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item).trim()).filter(Boolean).slice(0, limit);
}

function coerceProductIntentList(value: unknown, limit = 12): ProductIntent[] {
  if (!Array.isArray(value)) return [];
  return value.map(coerceProductIntent).filter((item) => item !== 'unknown').slice(0, limit);
}

function coerceNullableBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function coerceNullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function emptyRequiredProductTraits(): RequiredProductTraits {
  return {
    productIntent: 'unknown',
    productRole: 'unknown',
    fuel: 'unknown',
    startType: 'unknown',
    enclosure: 'unknown',
    conventionalGenerator: null,
    singlePhase220: null,
    budgetMax: null,
    weightKgMin: null,
    weightKgMax: null,
    diameterMmMin: null,
    diameterMmMax: null,
    nominalPowerKwMin: null,
    nominalPowerKwMax: null,
    maxPowerKwMin: null,
    maxPowerKwMax: null,
    powerReasoning: ''
  };
}

function requiredTraitsHaveHardConstraints(traits?: RequiredProductTraits) {
  if (!traits) return false;
  return traits.productIntent !== 'unknown' ||
    traits.productRole !== 'unknown' ||
    traits.fuel !== 'unknown' ||
    traits.startType !== 'unknown' ||
    traits.enclosure !== 'unknown' ||
    traits.conventionalGenerator !== null ||
    traits.singlePhase220 !== null ||
    traits.budgetMax !== null ||
    traits.weightKgMin !== null ||
    traits.weightKgMax !== null ||
    traits.diameterMmMin !== null ||
    traits.diameterMmMax !== null ||
    traits.nominalPowerKwMin !== null ||
    traits.nominalPowerKwMax !== null ||
    traits.maxPowerKwMin !== null ||
    traits.maxPowerKwMax !== null;
}

function plannerHasSemanticSelection(plan: AssistantTurnPlan) {
  return Boolean(plan.agentDecision);
}

function coerceRequiredProductTraits(value: any): RequiredProductTraits {
  const fallback = emptyRequiredProductTraits();
  if (!value || typeof value !== 'object') return fallback;
  return {
    productIntent: coerceProductIntent(value.productIntent),
    productRole: coerceProductRole(value.productRole),
    fuel: coerceFuel(value.fuel),
    startType: coerceStartType(value.startType),
    enclosure: coerceProductEnclosure(value.enclosure),
    conventionalGenerator: coerceNullableBoolean(value.conventionalGenerator),
    singlePhase220: coerceNullableBoolean(value.singlePhase220),
    budgetMax: coerceNullableNumber(value.budgetMax),
    weightKgMin: coerceNullableNumber(value.weightKgMin),
    weightKgMax: coerceNullableNumber(value.weightKgMax),
    diameterMmMin: coerceNullableNumber(value.diameterMmMin),
    diameterMmMax: coerceNullableNumber(value.diameterMmMax),
    nominalPowerKwMin: coerceNullableNumber(value.nominalPowerKwMin),
    nominalPowerKwMax: coerceNullableNumber(value.nominalPowerKwMax),
    maxPowerKwMin: coerceNullableNumber(value.maxPowerKwMin),
    maxPowerKwMax: coerceNullableNumber(value.maxPowerKwMax),
    powerReasoning: String(value.powerReasoning ?? '').trim().slice(0, 800)
  };
}

function emptySelectionState(intent: ProductIntent = 'unknown'): SelectionState {
  return {
    currentProductClass: intent,
    targetProductClass: intent,
    compatibilityTargetProduct: '',
    mustHaveTraits: [],
    niceToHaveTraits: [],
    excludedClasses: [],
    brandConstraint: '',
    exactModelConstraint: '',
    isAccessoryFollowUp: false,
    selectionConfidence: intent === 'unknown' ? 0 : 0.45,
    shouldShowCards: intent !== 'unknown',
    cardDisplayMode: intent === 'unknown' ? 'none' : 'preliminary'
  };
}

function coerceSelectionState(value: any, traits: RequiredProductTraits, fallbackIntent: ProductIntent): SelectionState {
  const fallback = emptySelectionState(fallbackIntent);
  if (!value || typeof value !== 'object') return fallback;
  const targetProductClass = coerceProductIntent(value.targetProductClass);
  const currentProductClass = coerceProductIntent(value.currentProductClass);
  const confidence = Number(value.selectionConfidence);
  return {
    currentProductClass: currentProductClass === 'unknown' ? fallback.currentProductClass : currentProductClass,
    targetProductClass: targetProductClass === 'unknown'
      ? traits.productIntent !== 'unknown' ? traits.productIntent : fallback.targetProductClass
      : targetProductClass,
    compatibilityTargetProduct: String(value.compatibilityTargetProduct ?? '').trim().slice(0, 160),
    mustHaveTraits: coerceStringList(value.mustHaveTraits, 16),
    niceToHaveTraits: coerceStringList(value.niceToHaveTraits, 16),
    excludedClasses: coerceProductIntentList(value.excludedClasses, 16),
    brandConstraint: sanitizeBrandConstraintText(String(value.brandConstraint ?? '').trim().slice(0, 80)),
    exactModelConstraint: String(value.exactModelConstraint ?? '').trim().slice(0, 120),
    isAccessoryFollowUp: Boolean(value.isAccessoryFollowUp) || traits.productRole === 'accessory' || traits.productRole === 'consumable',
    selectionConfidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : fallback.selectionConfidence,
    shouldShowCards: typeof value.shouldShowCards === 'boolean' ? value.shouldShowCards : fallback.shouldShowCards,
    cardDisplayMode: coerceCardDisplayMode(value.cardDisplayMode)
  };
}

function coerceTurnPlan(value: any, baseQuery: string, latestUserMessage = baseQuery): AssistantTurnPlan {
  const allowedActions: AssistantTurnAction[] = [
    'answer_question',
    'recommend_products',
    'ask_clarifying_question',
    'verify_with_web',
    'collect_lead',
    'handoff_specialist'
  ];
  const action = allowedActions.includes(value?.action) ? value.action as AssistantTurnAction : 'answer_question';
  const selectedProductIds = Array.isArray(value?.selectedProductIds)
    ? value.selectedProductIds.map((id: unknown) => String(id)).filter(Boolean).slice(0, MAX_PRODUCT_CARDS)
    : [];
  const missingInformation = Array.isArray(value?.missingInformation)
    ? value.missingInformation.map((item: unknown) => String(item).trim()).filter(Boolean).slice(0, 6)
    : [];
  const contextScope = coerceContextScope(value?.contextScope);
  const scopedFallbackQuery = contextScope === 'latestMessageOnly' ? latestUserMessage : baseQuery;
  const rawCatalogSearchQuery = contextScope === 'latestMessageOnly'
    ? latestUserMessage
    : value?.catalogSearchQuery ?? scopedFallbackQuery;
  const catalogSearchQuery = String(rawCatalogSearchQuery).trim() || scopedFallbackQuery;
  const requiredProductTraits = coerceRequiredProductTraits(value?.requiredProductTraits);
  const agentContractV2 = coercePlannerAgentTurnContractV2(value?.agentContractV2);
  const agentDecision = coerceAgentDecision(value?.agentDecision) ??
    (agentContractV2 ? agentDecisionFromContractV2(agentContractV2) : undefined);

  return {
    action,
    answerMode: coerceAnswerMode(value?.answerMode),
    cardPolicy: coerceCardPolicy(value?.cardPolicy),
    followUpPolicy: coerceFollowUpPolicy(value?.followUpPolicy),
    contextScope,
    searchScope: coerceSearchScope(value?.searchScope),
    catalogSearchQuery: catalogSearchQuery.slice(0, 1200),
    selectedProductIds,
    requiredProductTraits,
    selectionState: coerceSelectionState(value?.selectionState, requiredProductTraits, requiredProductTraits.productIntent),
    agentDecision,
    agentContractV2,
    needsWebSearch: Boolean(value?.needsWebSearch),
    missingInformation,
    answerGuidance: String(value?.answerGuidance ?? '').trim().slice(0, 2000)
  };
}

function compactTurnPlanForAnswer(plan: AssistantTurnPlan): AssistantTurnPlan {
  return {
    ...plan,
    missingInformation: plan.missingInformation.slice(0, 4),
    answerGuidance: truncateForAI(plan.answerGuidance, 700)
  };
}

function fallbackTurnPlan(input: { userMessage: string; needState: CustomerNeedState; baseQuery: string }): AssistantTurnPlan {
  const traits = emptyRequiredProductTraits();
  const agentDecision: NonNullable<AssistantTurnPlan['agentDecision']> = {
    answerTask: 'mixed',
    taskType: 'technical_answer',
    catalogAction: 'none',
    commercialAction: 'none',
    productCardsPolicy: 'none',
    mustAnswerNow: [],
    currentFocus: 'latest_message',
    cardsRole: 'none',
    leadAllowed: true,
    leadAllowedReason: 'planner_fallback_text_only',
    errorRecoveryPriority: 'The LLM planner did not return a valid semantic contract. Answer text-only from validated context; do not infer intent, select products, or show cards from phrase patterns.',
    confidence: 0
  };
  const fallbackLegacyContract = deriveAgentTurnContract({
    userMessage: input.userMessage,
    plan: {
      action: 'answer_question',
      answerMode: 'short',
      cardPolicy: 'textOnly',
      followUpPolicy: 'answerNowNoDeferredOffer',
      selectedProductIds: [],
      answerGuidance: '',
      selectionState: { shouldShowCards: false },
      agentDecision
    },
    needState: input.needState
  });
  const agentContractV2 = deriveAgentTurnContractV2({
    userMessage: input.userMessage,
    legacyContract: fallbackLegacyContract,
    plan: { selectedProductIds: [], missingInformation: [] },
    needState: input.needState
  });
  return {
    action: 'answer_question',
    answerMode: 'short',
    cardPolicy: 'textOnly',
    followUpPolicy: 'answerNowNoDeferredOffer',
    contextScope: 'activeNeed',
    searchScope: 'focusedNeed',
    catalogSearchQuery: input.baseQuery,
    selectedProductIds: [],
    requiredProductTraits: traits,
    selectionState: {
      ...emptySelectionState('unknown'),
      shouldShowCards: false,
      cardDisplayMode: 'none'
    },
    agentDecision,
    agentContractV2,
    needsWebSearch: false,
    missingInformation: [],
    answerGuidance: 'Planner fallback: no valid LLM semantic contract. Не делай keyword-подбор. Keep the turn text-only, do not select catalog products, do not show cards, and do not infer intent from phrase patterns.'
  };
}

function productSearchText(message: string, state: CustomerNeedState) {
  const activeValues = (items: CustomerNeedState['explicitNeeds']) =>
    items.filter((item) => item.confidence >= 0.32).map((item) => item.value).join(' ');
  const parts = [
    message,
    selectionText(state.selectionState),
    activeValues(state.explicitNeeds),
    activeValues(state.implicitNeeds),
    activeValues(state.constraints),
    activeValues(state.importantCriteria)
  ];
  return parts.filter(Boolean).join(' ').slice(0, 1200);
}

function latestMessageScopedRecoveryNeedState(state: CustomerNeedState, latestUserMessage: string): CustomerNeedState {
  const latestTokens = expandModelTokenAliases(extractModelTokens(latestUserMessage));
  if (latestTokens.length !== 1 || !state.selectionState) return state;
  const latestToken = latestTokens[0]!;
  const latestCompact = compactModelText(latestToken);
  if (!latestCompact) return state;

  const selectionState = state.selectionState;
  const hard = selectionState.hardConstraints;
  const currentTokenCompacts = new Set((hard.exactModelTokens ?? []).map((token) => compactModelText(token)).filter(Boolean));
  const currentConstraintCompact = hard.exactModelConstraint ? compactModelText(hard.exactModelConstraint) : '';
  const hasStaleExactToken = [...currentTokenCompacts].some((token) => token !== latestCompact);
  const hasStaleExactConstraint = Boolean(currentConstraintCompact && currentConstraintCompact !== latestCompact);
  if (!hasStaleExactToken && !hasStaleExactConstraint) return state;

  const oldExactCompacts = new Set([
    ...currentTokenCompacts,
    currentConstraintCompact
  ].filter(Boolean));
  const keepTrait = (trait: string) => {
    const compactTrait = compactModelText(trait);
    if (/^exactmodel/i.test(compactTrait)) return false;
    return ![...oldExactCompacts].some((token) => token && compactTrait.includes(token));
  };
  const exactModelTokenRoles: ProductSelectionToken[] = [{
    value: latestToken,
    role: 'targetProduct',
    evidence: latestUserMessage
  }];
  const nextHard: ProductSelectionCriteria = {
    ...hard,
    exactModelConstraint: latestToken,
    exactModelTokens: [latestToken],
    exactModelTokenRoles,
    mustHaveTraits: uniqueList([
      ...(hard.mustHaveTraits ?? []).filter(keepTrait),
      `exact model ${latestToken}`
    ], 24),
    provenance: {
      ...(hard.provenance ?? {}),
      exactModelConstraint: 'explicit_user'
    }
  };
  const nextSoft: ProductSelectionCriteria = {
    ...selectionState.softPreferences,
    exactModelConstraint: latestToken,
    exactModelTokens: [],
    exactModelTokenRoles: [],
    mustHaveTraits: uniqueList([
      ...(selectionState.softPreferences?.mustHaveTraits ?? []).filter(keepTrait),
      `exact model ${latestToken}`
    ], 24),
    provenance: {
      ...(selectionState.softPreferences?.provenance ?? {}),
      exactModelConstraint: 'explicit_user'
    }
  };
  return {
    ...state,
    selectionState: {
      ...selectionState,
      hardConstraints: nextHard,
      softPreferences: nextSoft,
      activeRequirement: selectionState.activeRequirement
        ? {
            ...selectionState.activeRequirement,
            exactModelConstraint: latestToken,
            exactModelTokens: [latestToken],
            exactModelTokenRoles,
            mustHaveTraits: uniqueList([
              ...(selectionState.activeRequirement.mustHaveTraits ?? []).filter(keepTrait),
              `exact model ${latestToken}`
            ], 24),
            provenance: {
              ...(selectionState.activeRequirement.provenance ?? {}),
              exactModelConstraint: 'explicit_user'
            }
          }
        : selectionState.activeRequirement,
      selectedProductIds: [],
      matchedProductIds: [],
      previousCandidateProductIds: [],
      updatedAt: new Date().toISOString()
    }
  };
}

function currentLineupRecoveryContract(contract: AgentTurnContract, latestUserMessage: string): AgentTurnContract {
  if (!shouldUseCurrentLineupStyle(latestUserMessage)) return contract;
  const allowLeadAfterAnswer = isCatalogAvailabilityQuestion(latestUserMessage);
  return {
    ...contract,
    answerTask: 'technical_explanation',
    taskType: 'technical_answer',
    catalogAction: 'exact_model_lookup',
    commercialAction: allowLeadAfterAnswer ? 'offer_contact_after_answer' : 'none',
    productCardsPolicy: 'none',
    cardsRole: 'none',
    leadAllowed: allowLeadAfterAnswer,
    leadAllowedReason: allowLeadAfterAnswer
      ? 'current-lineup recovery can answer factually first and offer specialist stock verification after the answer'
      : 'current-lineup recovery is a factual text answer',
    mustAnswerNow: uniqueList([
      ...contract.mustAnswerNow,
      'separate BAKAUT catalog presence, live stock, and current manufacturer status'
    ], 8),
    errorRecoveryPriority: 'Recover the current-lineup/current-production question with a concise factual answer. Use web verification for manufacturer status; do not show product cards.',
    validatorWarnings: uniqueList([
      ...(contract.validatorWarnings ?? []),
      'current_lineup_recovery_forced_text_only_web_policy'
    ], 40)
  };
}

function deterministicCurrentLineupRecoveryFallback(input: {
  latestUserMessage: string;
  catalogProducts: Product[];
  leadAllowed: boolean;
}) {
  const latestToken = extractModelTokens(input.latestUserMessage)[0]?.trim();
  const tokenCompact = latestToken ? compactModelText(latestToken) : '';
  const latestIntent = inferProductIntent(input.latestUserMessage);
  const matchingCatalogProducts = tokenCompact
    ? input.catalogProducts.filter((product) => compactModelText(productFullText(product)).includes(tokenCompact))
    : input.catalogProducts;
  const intentMatchedProducts = latestIntent === 'unknown'
    ? matchingCatalogProducts
    : matchingCatalogProducts.filter((product) => productMatchesIntent(product, latestIntent));
  const coreMatch = intentMatchedProducts.find(isCoreEquipment);
  const modelText = latestToken ? `по ${latestToken}` : 'по этой модели';
  const catalogLine = coreMatch
    ? `В каталоге вижу ${coreMatch.name}.`
    : `По каталогу ${modelText} нужно сверить точную карточку, чтобы не подставить товар из предыдущего выбора.`;
  const lines = [
    catalogLine,
    'Заводской статус без внешней проверки не буду утверждать как факт.'
  ];
  if (input.leadAllowed) {
    lines.push('Живой склад и возможность заказа проверяет специалист: можно оставить имя и телефон в форме, и мы вернемся с точным ответом.');
  }
  return lines.join('\n\n');
}

function currentLineupRecoveryCatalogProducts(latestUserMessage: string, products: Product[]) {
  const latestTokens = expandModelTokenAliases(extractModelTokens(latestUserMessage));
  const tokenCompacts = latestTokens.map((token) => compactModelText(token)).filter(Boolean);
  const latestIntent = inferProductIntent(latestUserMessage);
  const tokenMatched = tokenCompacts.length
    ? products.filter((product) => {
        const compact = compactModelText(productFullText(product));
        return tokenCompacts.some((token) => compact.includes(token));
      })
    : products;
  if (latestIntent === 'unknown') return tokenMatched;
  return tokenMatched.filter((product) => productMatchesIntent(product, latestIntent));
}

function deriveConversationTopic(userMessage: string, state: CustomerNeedState) {
  const values = [
    state.explicitNeeds.find((item) => item.confidence >= 0.45)?.value,
    state.importantCriteria.find((item) => item.confidence >= 0.5)?.value,
    state.lastSummary,
    userMessage
  ];
  const raw = values.find((value) => value && value.trim().length >= 8) ?? userMessage;
  const cleaned = raw
    .replace(/https?:\/\/\S+/gi, '')
    .replace(/^(здравствуйте|добрый день|привет|подскажите|посоветуйте|помогите|нужен|нужна|нужно|хочу)\b[,.!\s-]*/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return 'Новая консультация';
  return cleaned.length > 70 ? `${cleaned.slice(0, 67).trim()}...` : cleaned;
}


function stateText(state: CustomerNeedState, userMessage: string) {
  return [
    userMessage,
    selectionText(state.selectionState),
    state.explicitNeeds.map((x) => x.value).join(' '),
    state.implicitNeeds.map((x) => x.value).join(' '),
    state.constraints.map((x) => x.value).join(' '),
    state.importantCriteria.map((x) => x.value).join(' ')
  ].join(' ');
}

function selectionText(selection?: ProductSelectionState | null) {
  if (!selection) return '';
  const hard = selection.hardConstraints;
  const soft = selection.softPreferences;
  return [
    selection.targetProductClass !== 'unknown' ? selection.targetProductClass : '',
    hard.productIntent !== 'unknown' ? hard.productIntent : '',
    hard.productRole !== 'unknown' ? hard.productRole : '',
    hard.budgetMax ? `budget ${hard.budgetMax}` : '',
    hard.nominalPowerKwMin || hard.nominalPowerKwMax ? `nominal ${hard.nominalPowerKwMin ?? ''}-${hard.nominalPowerKwMax ?? ''} kw` : '',
    hard.maxPowerKwMin || hard.maxPowerKwMax ? `max ${hard.maxPowerKwMin ?? ''}-${hard.maxPowerKwMax ?? ''} kw` : '',
    hard.weightKgMin || hard.weightKgMax ? `weight ${hard.weightKgMin ?? ''}-${hard.weightKgMax ?? ''} kg` : '',
    hard.diameterMmMin || hard.diameterMmMax ? `diameter ${hard.diameterMmMin ?? ''}-${hard.diameterMmMax ?? ''} mm` : '',
    hard.fuel && hard.fuel !== 'unknown' ? hard.fuel : '',
    hard.startType && hard.startType !== 'unknown' ? `${hard.startType} start` : '',
    hard.enclosure && hard.enclosure !== 'unknown' ? hard.enclosure : '',
    hard.brandConstraint,
    hard.exactModelConstraint,
    hard.exactModelTokens.join(' '),
    hard.mustHaveTraits.join(' '),
    soft.mustHaveTraits.join(' ')
  ].filter(Boolean).join(' ');
}


function hasNegatedPumpLoad(text: string) {
  return /(?:насос\w*|pump)[^.!?;\n]{0,40}(?:нет|не\s+будет|не\s+планир|отсутств|исключ)/iu.test(text) ||
    /(?:без|отсутств(?:ует|уют)?|исключ(?:аем|ить)?)[^.!?;\n]{0,24}(?:насос\w*|pump)/iu.test(text) ||
    /(?:нет|не\s+будет|не\s+планир\w*)\s+(?:у\s+\S+\s+)?(?:насос\w*|pump)/iu.test(text);
}

function estimatedGeneratorPowerFromLoads(text: string): GeneratorPowerProfile | undefined {
  const lower = text.toLowerCase();
  const loads: Array<{ running: number; starting: number }> = [];
  for (const item of generatorReferenceLoadItemsFromText(text)) {
    if (['lighting', 'refrigerator', 'pump'].includes(item.kind)) continue;
    const running = item.runningKw;
    const starting = item.startingKw ?? running;
    if (running && starting) loads.push({ running, starting });
  }
  if (!hasNegatedPumpLoad(text) && /(?:\u043d\u0430\u0441\u043e\u0441|pump)/i.test(lower)) {
    const running = numberNearNeed(lower, /(?:\u043d\u0430\u0441\u043e\u0441|pump)/i) ?? 0.8;
    loads.push({ running, starting: Math.max(running * 2.8, running + 1.2) });
  }
  if (/(?:\u0445\u043e\u043b\u043e\u0434\u0438\u043b|fridge|refrigerator)/i.test(lower)) {
    const running = numberNearNeed(lower, /(?:\u0445\u043e\u043b\u043e\u0434\u0438\u043b|fridge|refrigerator)/i) ?? 0.25;
    loads.push({ running, starting: Math.max(running * 4, 1.1) });
  }
  if (/(?:\u0441\u0432\u0435\u0442|\u043b\u0430\u043c\u043f|light)/i.test(lower)) {
    const running = numberNearNeed(lower, /(?:\u0441\u0432\u0435\u0442|\u043b\u0430\u043c\u043f|light)/i) ?? 0.25;
    loads.push({ running, starting: running });
  }
  if (!loads.length) return undefined;

  const runningSum = loads.reduce((sum, load) => sum + load.running, 0);
  const stagedStart = /(?:\u043d\u0435\s+\u043e\u0434\u043d\u043e\u0432\u0440\u0435\u043c|\u043f\u043e\s+\u043e\u0447\u0435\u0440\u0435\u0434|\u0440\u0430\u0437\u0434\u0435\u043b|not\s+simultaneously|one\s+by\s+one)/i.test(lower);
  const peak = stagedStart
    ? Math.max(...loads.map((load) => load.starting)) + Math.max(0.2, runningSum * 0.25)
    : Math.max(...loads.map((load, index) => load.starting + loads.reduce((sum, other, otherIndex) => sum + (otherIndex === index ? 0 : other.running), 0)));
  const nominalTarget = Math.max(1.8, runningSum * 1.45);
  const maxTarget = Math.max(2.5, peak * 1.15);

  return {
    nominalMin: Math.max(1.6, Math.round((nominalTarget - 0.4) * 10) / 10),
    nominalMax: Math.round(Math.min(5.2, nominalTarget + 1.2) * 10) / 10,
    maxMin: Math.round(Math.max(2.4, maxTarget - 0.4) * 10) / 10,
    maxMax: Math.round(Math.min(6.0, maxTarget + 0.9) * 10) / 10,
    source: 'estimated_load'
  };
}


function generatorPowerFromTraits(traits?: RequiredProductTraits): GeneratorPowerProfile | undefined {
  if (!traits) return undefined;
  const range: GeneratorPowerProfile = { source: 'planner' };
  if (traits.nominalPowerKwMin) range.nominalMin = traits.nominalPowerKwMin;
  if (traits.nominalPowerKwMax) range.nominalMax = traits.nominalPowerKwMax;
  if (traits.maxPowerKwMin) range.maxMin = traits.maxPowerKwMin;
  if (traits.maxPowerKwMax) range.maxMax = traits.maxPowerKwMax;
  return range.nominalMin || range.nominalMax || range.maxMin || range.maxMax ? range : undefined;
}

function generatorPowerFromSelectionHardConstraints(hard: ProductSelectionCriteria): GeneratorPowerProfile | undefined {
  const range: GeneratorPowerProfile = { source: 'explicit_text' };
  if (hard.nominalPowerKwMin) range.nominalMin = hard.nominalPowerKwMin;
  if (hard.nominalPowerKwMax) range.nominalMax = hard.nominalPowerKwMax;
  if (hard.maxPowerKwMin) range.maxMin = hard.maxPowerKwMin;
  if (hard.maxPowerKwMax) range.maxMax = hard.maxPowerKwMax;
  return range.nominalMin || range.nominalMax || range.maxMin || range.maxMax
    ? completeSingleTargetNominalPower(range, hard)
    : undefined;
}

function normalizePowerRange(range?: GeneratorPowerProfile) {
  if (!range) return undefined;
  const normalized = { ...range };
  if (normalized.nominalMin && normalized.nominalMax && normalized.nominalMin > normalized.nominalMax) {
    [normalized.nominalMin, normalized.nominalMax] = [normalized.nominalMax, normalized.nominalMin];
  }
  if (normalized.maxMin && normalized.maxMax && normalized.maxMin > normalized.maxMax) {
    [normalized.maxMin, normalized.maxMax] = [normalized.maxMax, normalized.maxMin];
  }
  return normalized;
}

function textMarksPowerUpperBound(text: string) {
  return /(?:\u0434\u043e\s+\d|\u043d\u0435\s+(?:\u0431\u043e\u043b\u044c\u0448\u0435|\u0432\u044b\u0448\u0435)\s+\d|\u043c\u0430\u043a\u0441(?:\u0438\u043c\u0443\u043c|\.)?\s*\d|max(?:imum)?\s*\d|up\s+to\s+\d|under\s+\d|below\s+\d|<=\s*\d)/iu.test(text);
}

function exactSinglePowerFromCriteriaText(criteria: ProductSelectionCriteria) {
  const text = [
    criteria.mustHaveTraits.join(' '),
    criteria.exactModelConstraint,
    criteria.exactModelTokens.join(' ')
  ].filter(Boolean).join(' ');
  if (!text || textMarksPowerUpperBound(text) || parseDesiredPowerRange(text)) return undefined;
  return singlePowerKwFromText(text);
}

function completeSingleTargetNominalPower(range: GeneratorPowerProfile, criteria: ProductSelectionCriteria) {
  if (range.nominalMin || !range.nominalMax) return range;
  const exactPower = exactSinglePowerFromCriteriaText(criteria);
  if (!exactPower || Math.abs(exactPower - range.nominalMax) > 0.25) return range;
  return {
    ...range,
    nominalMin: exactPower,
    nominalMax: exactPower
  };
}

function hasExplicitGeneratorElectricStartNeed(text: string) {
  return /(?:\u044d\u043b\u0435\u043a\u0442\u0440(?:\u043e)?\s*\u0441\u0442\u0430\u0440\u0442\u0435\u0440|\u044d\u043b\u0435\u043a\u0442\u0440\u043e\u0441\u0442\u0430\u0440\u0442|\u044d\u043b\.?\s*\u0441\u0442\u0430\u0440\u0442|\u0430\u0432\u0442\u043e\s*\u0437\u0430\u043f\u0443\u0441\u043a|\u0430\u0432\u0442\u043e\u0437\u0430\u043f\u0443\u0441\u043a|\u0437\u0430\u043f\u0443\u0441\u043a\s+(?:\u0441\s+)?(?:\u043a\u043d\u043e\u043f\u043a|\u043a\u043b\u044e\u0447)|(?:\u043a\u043d\u043e\u043f\u043a|\u043a\u043b\u044e\u0447)[\p{L}\s]{0,18}\u0437\u0430\u043f\u0443\u0441\u043a|\u0440\u0443\u0447\u043d[\p{L}]*\s*\/\s*\u044d\u043b\u0435\u043a\u0442\u0440|\u043d\u0435\s+\u0440\u0443\u0447\u043d[\p{L}]*\s+\u0437\u0430\u043f\u0443\u0441\u043a|\u0431\u0435\u0437\s+\u0440\u0443\u0447\u043d[\p{L}]*\s+\u0437\u0430\u043f\u0443\u0441\u043a|\u0431\u0435\u0437\s+(?:\u0440\u044b\u0432\u043a|\u0434\u0435\u0440\u0433\u0430\u043d)[^.!?\n]{0,24}(?:\u0448\u043d\u0443\u0440|\u0442\u0440\u043e\u0441)|\u043d\u0435\s+\u0434\u0435\u0440\u0433\u0430\u0442\u044c[^.!?\n]{0,24}(?:\u0448\u043d\u0443\u0440|\u0442\u0440\u043e\u0441)|electric\s+start|button\s+start|key\s+start)/iu.test(text);
}

function needEvidenceText(state: CustomerNeedState) {
  return [
    ...state.explicitNeeds,
    ...state.implicitNeeds,
    ...state.constraints,
    ...state.importantCriteria,
    ...state.confirmedFacts,
    ...state.uncertainInferences
  ].map((item) => item.evidence).filter(Boolean).join(' ');
}

function clearUngroundedGeneratorElectricStart(state: ProductSelectionState, evidenceText: string) {
  const hard = state.hardConstraints;
  const target = state.targetProductClass !== 'unknown' ? state.targetProductClass : hard.productIntent;
  if (target !== 'generator' || hard.startType !== 'electric') return state;
  if (hasExplicitGeneratorElectricStartNeed(evidenceText)) return state;

  const provenance = { ...(hard.provenance ?? {}) };
  delete provenance.startType;
  const sanitizedHard = { ...hard, provenance };
  delete sanitizedHard.startType;

  let activeRequirement = state.activeRequirement;
  if (activeRequirement?.startType === 'electric') {
    const activeProvenance = { ...(activeRequirement.provenance ?? {}) };
    delete activeProvenance.startType;
    activeRequirement = { ...activeRequirement, provenance: activeProvenance };
    delete activeRequirement.startType;
  }

  return {
    ...state,
    hardConstraints: sanitizedHard,
    activeRequirement
  };
}

function buildProductFitProfile(state: CustomerNeedState, userMessage: string, retrievalQuery = '', traits?: RequiredProductTraits): ProductFitProfile {
  const latestText = userMessage.trim();
  const queryText = retrievalQuery.trim();
  const stateMemoryText = stateText(state, '');
  const selection = state.selectionState ?? emptyProductSelectionState();
  const hard = selection.hardConstraints;
  const activeNeedText = [latestText, queryText, selectionText(selection)].filter(Boolean).join(' ') || stateMemoryText;
  const plannerOrLedgerHasConstraints = selection.semanticSource === 'llm_need_extraction' ||
    selection.semanticSource === 'planner';
  const lexicalHintText = plannerOrLedgerHasConstraints ? '' : activeNeedText;
  const latestIntent = plannerOrLedgerHasConstraints ? 'unknown' : inferProductIntent(latestText);
  const queryIntent = plannerOrLedgerHasConstraints ? 'unknown' : inferProductIntent(queryText);
  const memoryIntent = plannerOrLedgerHasConstraints
    ? 'unknown'
    : inferProductIntent([state.lastSummary, stateMemoryText].filter(Boolean).join(' '));
  const traitIntent = traits?.productIntent ?? 'unknown';
  const selectionIntent = selection.targetProductClass !== 'unknown' ? selection.targetProductClass : hard.productIntent;
  const activeNeedLower = lexicalHintText.toLowerCase();
  const plannerKnowsProductRole = Boolean(traits && traits.productRole !== 'unknown');
  const plannerKnowsEnclosure = Boolean(traits && traits.enclosure !== 'unknown');
  const explicitElectricStartNeed = plannerOrLedgerHasConstraints
    ? false
    : hasExplicitGeneratorElectricStartNeed([latestText, queryText].filter(Boolean).join(' '));
  const generatorInEnclosureRequest = !plannerOrLedgerHasConstraints && !plannerKnowsEnclosure
    ? fallbackDetectGeneratorEnclosureSignal(activeNeedLower)
    : false;
  const coreProductTrait = traits?.productRole === 'coreProduct' ||
    (traits?.productIntent === 'generator' && traits?.enclosure === 'enclosed');
  const accessoryTrait = traits?.productRole === 'accessory' || traits?.productRole === 'consumable';
  const intent = traitIntent !== 'unknown'
    ? traitIntent
      : latestIntent !== 'unknown'
      ? latestIntent
      : queryIntent !== 'unknown'
        ? queryIntent
        : selectionIntent !== 'unknown'
          ? selectionIntent
          : memoryIntent;
  const exactModelTokens = expandModelTokenAliases(extractModelTokens([
    ...(plannerOrLedgerHasConstraints ? [] : [userMessage, retrievalQuery]),
    hard.exactModelConstraint,
    hard.exactModelTokens.join(' ')
  ].filter(Boolean).join(' ')));
  const desiredPowerRange = plannerOrLedgerHasConstraints ? undefined : parseDesiredPowerRange(activeNeedText);
  const hardGeneratorPower = generatorPowerFromSelectionHardConstraints(hard);
  const generatorPower = normalizePowerRange(
    (plannerOrLedgerHasConstraints ? hardGeneratorPower : undefined) ??
    generatorPowerFromTraits(traits) ??
    hardGeneratorPower ??
    (desiredPowerRange ? { nominalMin: desiredPowerRange.min, nominalMax: desiredPowerRange.max, source: 'explicit_text' } : undefined) ??
    (plannerOrLedgerHasConstraints ? undefined : estimatedGeneratorPowerFromLoads(activeNeedText))
  );

  return {
    intent,
    activeNeedText,
    requestedBrands: [],
    accessoryRequested: accessoryTrait ||
      (!plannerOrLedgerHasConstraints && !coreProductTrait && !plannerKnowsProductRole && (
        (containsAny(lexicalHintText, accessoryNeedTerms) && !generatorInEnclosureRequest && traits?.enclosure !== 'enclosed') ||
        fallbackDetectStandaloneGeneratorAccessoryRequest(activeNeedLower)
      )),
    weldingRequested: plannerOrLedgerHasConstraints ? intent === 'weldingGenerator' : containsAny(lexicalHintText, weldingTerms),
    wantsGasoline: hard.fuel === 'gasoline' || traits?.fuel === 'gasoline' || (!plannerOrLedgerHasConstraints && (!traits || traits.fuel === 'unknown') && containsAny(lexicalHintText, gasolineTerms)),
    wantsDiesel: hard.fuel === 'diesel' || traits?.fuel === 'diesel' || (!plannerOrLedgerHasConstraints && (!traits || traits.fuel === 'unknown') && containsAny(lexicalHintText, dieselTerms)),
    wantsElectricStart: hard.startType === 'electric' || traits?.startType === 'electric' || ((!traits || traits.startType === 'unknown') && explicitElectricStartNeed),
    wantsInverterGenerator: hard.conventionalGenerator === false || traits?.conventionalGenerator === false || (!plannerOrLedgerHasConstraints && (!traits || traits.conventionalGenerator === null) && containsAny(lexicalHintText, inverterTerms)),
    wantsEnclosedGenerator: hard.enclosure === 'enclosed' || traits?.enclosure === 'enclosed' || (!traits || traits.enclosure === 'unknown' ? generatorInEnclosureRequest : false),
    wantsConventionalGenerator: hard.conventionalGenerator === true || traits?.conventionalGenerator === true || (!plannerOrLedgerHasConstraints && (!traits || traits.conventionalGenerator === null) && hasConventionalGeneratorSignal(lexicalHintText)),
    wantsSinglePhase220: hard.singlePhase220 === true || traits?.singlePhase220 === true || (!plannerOrLedgerHasConstraints && (!traits || traits.singlePhase220 === null) && containsAny(lexicalHintText, singlePhaseTerms)),
    desiredPowerRange,
    generatorPower,
    budgetMax: traits?.budgetMax ?? hard.budgetMax ?? (plannerOrLedgerHasConstraints ? undefined : parseBudgetMax(activeNeedText)),
    exactModelTokens
  };
}

function generatorPowerPenalty(product: Product, profile: ProductFitProfile) {
  if (!profile.generatorPower) return 0;
  const power = extractGeneratorPower(product);
  const nominal = power.nominalKw;
  const max = power.maxKw;
  const range = profile.generatorPower;
  const nominalLowerTolerance = range.source === 'estimated_load' ? 0.4 : 0;
  const nominalUpperTolerance = range.source === 'estimated_load' ? 0.3 : 0;
  const maxLowerTolerance = range.source === 'estimated_load' ? 0.5 : 0;
  const maxUpperTolerance = range.source === 'estimated_load' ? 0.5 : 0;
  if (range.nominalMin && nominal !== undefined && nominal < range.nominalMin - nominalLowerTolerance) return -150;
  if (range.nominalMax && nominal !== undefined && nominal > range.nominalMax + nominalUpperTolerance) return -150;
  if (range.maxMin && max !== undefined && max < range.maxMin - maxLowerTolerance) return -150;
  if (range.maxMax && max !== undefined && max > range.maxMax + maxUpperTolerance) return -90;
  return 0;
}

function productFitPenalty(product: Product, profile: ProductFitProfile) {
  const flags = classifyProduct(product);
  const powerKw = extractPowerKw(product);
  const exactModel = productHasExactModel(product, profile);
  const requestedOilViscosities = oilViscosities(profile.activeNeedText);
  const productOilViscosities = oilViscosities(flags.text);

  if (profile.budgetMax && product.price && product.price > profile.budgetMax * 1.02) return -130;

  if (profile.intent === 'weldingGenerator') {
    if (!flags.isWeldingGenerator) return -190;
    if (profile.wantsGasoline && flags.isDiesel) return -120;
    if (profile.wantsDiesel && flags.isGasoline) return -120;
  }

  if (profile.intent === 'generatorOil') {
    if (!flags.isGeneratorOil) return -190;
    if (requestedOilViscosities.length && !productOilViscosities.some((item) => requestedOilViscosities.includes(item))) return -150;
  }

  if (profile.intent === 'engineOil') {
    if (!flags.isEngineOil) return -190;
    if (requestedOilViscosities.length && !productOilViscosities.some((item) => requestedOilViscosities.includes(item))) return -150;
    if (!requestedOilViscosities.length && productOilViscosities.some((item) => item.startsWith('15w'))) return -120;
  }

  if (profile.intent === 'generatorAccessory') {
    if (!flags.isGeneratorAccessory && !flags.isGeneratorOil) return -180;
  }

  if (profile.intent === 'plateAccessory') {
    if (!flags.isPlateAccessory) return -190;
  }

  if (profile.intent === 'generator') {
    if (flags.isGeneratorAccessory && !profile.accessoryRequested) return -220;
    if (flags.isGeneratorOil && !profile.accessoryRequested) return -220;
    if (flags.isEngineOil || flags.isPlateAccessory) return -220;
    if (flags.isWeldingGenerator && !profile.weldingRequested) return -180;
    if (flags.isPlate || flags.isRammer || flags.isRoller || flags.isCutter || flags.isDiamondBlade || flags.isDiamondCore || flags.isTrowel) return -220;
    if (!flags.isGenerator) return -160;
    if (profile.wantsGasoline && flags.isDiesel) return -180;
    if (profile.wantsDiesel && flags.isGasoline) return -140;
    if (profile.wantsGasoline && !flags.isGasoline) return -90;
    if (profile.wantsDiesel && !flags.isDiesel) return -90;
    if (profile.wantsInverterGenerator && !flags.isInverter) return -170;
    if (profile.wantsConventionalGenerator && flags.isInverter) return -160;
    if (profile.wantsEnclosedGenerator && !flags.hasGeneratorEnclosureSignal) return -150;
    if (profile.wantsSinglePhase220) {
      const phase = generatorPhaseProfile(product);
      if (phase === 'mixed_220_380' || phase === 'three_phase_380') return -220;
    }
    if (profile.desiredPowerRange && powerKw !== undefined) {
      const { min, max } = profile.desiredPowerRange;
      if (powerKw < min - 0.4 || powerKw > max + 0.8) return -170;
    }
    const powerPenalty = generatorPowerPenalty(product, profile);
    if (powerPenalty <= -140) return powerPenalty;
    if (profile.wantsElectricStart && !flags.hasElectricStart) return -220;
  }

  if (profile.intent === 'plate') {
    if (flags.isGeneratorAccessory || flags.isGeneratorOil || flags.isEngineOil || flags.isPlateAccessory || flags.isDiamondBlade || flags.isDiamondCore || flags.isCutter || flags.isRammer || flags.isRoller) return -180;
    if (!flags.isPlate) return -160;
  }
  if (profile.intent === 'rammer') {
    if (flags.isGeneratorAccessory || flags.isGeneratorOil || flags.isEngineOil || flags.isPlateAccessory || flags.isDiamondBlade || flags.isDiamondCore || flags.isCutter || flags.isPlate || flags.isRoller) return -180;
    if (!flags.isRammer) return -160;
  }
  if (profile.intent === 'roller') {
    if (flags.isGeneratorAccessory || flags.isGeneratorOil || flags.isEngineOil || flags.isPlateAccessory || flags.isDiamondBlade || flags.isDiamondCore || flags.isCutter || flags.isPlate || flags.isRammer) return -180;
    if (!flags.isRoller) return -160;
  }
  if (profile.intent === 'cutter') {
    if (flags.isGeneratorAccessory || flags.isGeneratorOil || flags.isEngineOil || flags.isPlateAccessory || flags.isDiamondBlade || flags.isDiamondCore || flags.isPlate || flags.isRammer || flags.isRoller) return -180;
    if (!flags.isCutter) return -160;
  }
  if (profile.intent === 'diamondBlade' && !flags.isDiamondBlade) return -180;
  if (profile.intent === 'diamondCore' && !flags.isDiamondCore) return -180;
  if (profile.intent === 'trowel' && !flags.isTrowel) return -180;

  if (exactModel) return 0;

  return 0;
}

function exactModelCanBypassFit(profile: ProductFitProfile) {
  return !['engineOil', 'generatorOil', 'generatorAccessory', 'plateAccessory'].includes(profile.intent);
}

function violatesHardRequiredTraits(product: Product, profile: ProductFitProfile) {
  const flags = classifyProduct(product);
  if (profile.intent !== 'generator') return false;
  if (flags.isGeneratorAccessory || flags.isGeneratorOil || flags.isEngineOil || flags.isPlateAccessory) return true;
  if (flags.isWeldingGenerator && !profile.weldingRequested) return true;
  if (flags.isPlate || flags.isRammer || flags.isRoller || flags.isCutter || flags.isDiamondBlade || flags.isDiamondCore || flags.isTrowel) return true;
  if (!flags.isGenerator) return true;
  if (profile.wantsGasoline && flags.isDiesel) return true;
  if (profile.wantsDiesel && flags.isGasoline) return true;
  if (profile.wantsInverterGenerator && !flags.isInverter) return true;
  if (profile.wantsConventionalGenerator && flags.isInverter) return true;
  if (profile.wantsEnclosedGenerator && !flags.hasGeneratorEnclosureSignal) return true;
  if (profile.wantsSinglePhase220) {
    const phase = generatorPhaseProfile(product);
    if (phase === 'mixed_220_380' || phase === 'three_phase_380') return true;
  }
  if (profile.wantsElectricStart && !flags.hasElectricStart) return true;
  const powerKw = extractPowerKw(product);
  if (profile.desiredPowerRange && powerKw !== undefined) {
    const { min, max } = profile.desiredPowerRange;
    if (powerKw < min - 0.4 || powerKw > max + 0.8) return true;
  }
  return generatorPowerPenalty(product, profile) <= -140;
}

function isCardWorthy(product: Product, profile: ProductFitProfile, score: number) {
  if (productHasExactModel(product, profile)) {
    if (violatesHardRequiredTraits(product, profile)) return false;
    return exactModelCanBypassFit(profile)
      ? productFitPenalty(product, profile) > -160
      : productFitPenalty(product, profile) >= 0;
  }
  if (profile.intent === 'unknown') return score >= 80;
  return productFitPenalty(product, profile) >= 0 && score >= 55;
}

function generatorPowerScore(product: Product, profile: ProductFitProfile) {
  if (!profile.generatorPower) return 0;
  const power = extractGeneratorPower(product);
  const nominal = power.nominalKw;
  const max = power.maxKw;
  const range = profile.generatorPower;
  let score = 0;

  if (range.nominalMin || range.nominalMax) {
    const min = range.nominalMin ?? 0;
    const maxRange = range.nominalMax ?? Number.POSITIVE_INFINITY;
    if (nominal === undefined) score -= 8;
    else if (nominal >= min && nominal <= maxRange) score += 48;
    else {
      const center = Number.isFinite(maxRange) ? (min + maxRange) / 2 : min;
      score -= Math.min(70, Math.abs(nominal - center) * 16);
    }
  }

  if (range.maxMin || range.maxMax) {
    const min = range.maxMin ?? 0;
    const maxRange = range.maxMax ?? Number.POSITIVE_INFINITY;
    if (max === undefined) score -= 8;
    else if (max >= min && max <= maxRange) score += range.source === 'estimated_load' ? 58 : 42;
    else {
      const center = Number.isFinite(maxRange) ? (min + maxRange) / 2 : min;
      score -= Math.min(60, Math.abs(max - center) * 12);
    }
  }

  if (range.source === 'estimated_load' && nominal !== undefined) {
    if (range.nominalMax && nominal > range.nominalMax + 0.5) score -= Math.min(80, (nominal - range.nominalMax) * 22);
    if (nominal >= 2.5 && nominal <= 4.8) score += 18;
  }

  return score;
}

function supplementalCatalogQueries(profile: ProductFitProfile) {
  if (profile.intent === 'weldingGenerator') return [fromEscaped('\\u0421\\u0432\\u0430\\u0440\\u043e\\u0447\\u043d\\u044b\\u0435 \\u0433\\u0435\\u043d\\u0435\\u0440\\u0430\\u0442\\u043e\\u0440\\u044b')];
  if (profile.intent === 'generatorOil') return [
    fromEscaped('\\u041c\\u0430\\u0441\\u043b\\u043e \\u0434\\u043b\\u044f \\u0433\\u0435\\u043d\\u0435\\u0440\\u0430\\u0442\\u043e\\u0440\\u0430'),
    fromEscaped('\\u041c\\u0430\\u0441\\u043b\\u043e \\u0434\\u043b\\u044f \\u0433\\u0435\\u043d\\u0435\\u0440\\u0430\\u0442\\u043e\\u0440\\u043e\\u0432')
  ];
  if (profile.intent === 'engineOil') return [
    fromEscaped('\\u041c\\u0430\\u0441\\u043b\\u043e \\u0434\\u043b\\u044f \\u0433\\u0435\\u043d\\u0435\\u0440\\u0430\\u0442\\u043e\\u0440\\u0430'),
    fromEscaped('\\u041c\\u043e\\u0442\\u043e\\u0440\\u043d\\u043e\\u0435 \\u043c\\u0430\\u0441\\u043b\\u043e SAE 10W-40'),
    fromEscaped('\\u041c\\u0430\\u0441\\u043b\\u043e 4T SAE')
  ];
  if (profile.intent === 'generatorAccessory') return [
    fromEscaped('\\u0420\\u0430\\u0441\\u0445\\u043e\\u0434\\u043d\\u0438\\u043a\\u0438 \\u0434\\u043b\\u044f \\u0433\\u0435\\u043d\\u0435\\u0440\\u0430\\u0442\\u043e\\u0440\\u043e\\u0432'),
    fromEscaped('\\u041a\\u043e\\u0436\\u0443\\u0445\\u0438 \\u0434\\u043b\\u044f \\u0433\\u0435\\u043d\\u0435\\u0440\\u0430\\u0442\\u043e\\u0440\\u0430')
  ];
  if (profile.intent === 'plateAccessory') return [
    fromEscaped('\\u041a\\u043e\\u0432\\u0440\\u0438\\u043a \\u0434\\u043b\\u044f \\u0432\\u0438\\u0431\\u0440\\u043e\\u043f\\u043b\\u0438\\u0442\\u044b'),
    fromEscaped('\\u041d\\u0430\\u043a\\u043b\\u0430\\u0434\\u043a\\u0430 \\u0434\\u043b\\u044f \\u0432\\u0438\\u0431\\u0440\\u043e\\u043f\\u043b\\u0438\\u0442\\u044b')
  ];
  if (profile.intent === 'generator') {
    const gasoline = fromEscaped('\\u0411\\u0435\\u043d\\u0437\\u0438\\u043d\\u043e\\u0432\\u044b\\u0435 \\u0433\\u0435\\u043d\\u0435\\u0440\\u0430\\u0442\\u043e\\u0440\\u044b');
    const inverter = fromEscaped('\\u0418\\u043d\\u0432\\u0435\\u0440\\u0442\\u043e\\u0440\\u043d\\u044b\\u0435 \\u0433\\u0435\\u043d\\u0435\\u0440\\u0430\\u0442\\u043e\\u0440\\u044b');
    const diesel = fromEscaped('\\u0414\\u0438\\u0437\\u0435\\u043b\\u044c\\u043d\\u044b\\u0435 \\u0433\\u0435\\u043d\\u0435\\u0440\\u0430\\u0442\\u043e\\u0440\\u044b');
    if (profile.wantsGasoline) return [gasoline, inverter];
    if (profile.wantsDiesel) return [diesel];
    return [gasoline, diesel, inverter];
  }
  if (profile.intent === 'plate') return [fromEscaped('\\u0412\\u0438\\u0431\\u0440\\u043e\\u043f\\u043b\\u0438\\u0442\\u044b')];
  if (profile.intent === 'rammer') return [fromEscaped('\\u0412\\u0438\\u0431\\u0440\\u043e\\u0442\\u0440\\u0430\\u043c\\u0431\\u043e\\u0432\\u043a\\u0438')];
  if (profile.intent === 'roller') return [fromEscaped('\\u0412\\u0438\\u0431\\u0440\\u043e\\u043a\\u0430\\u0442\\u043a\\u0438')];
  if (profile.intent === 'trowel') return [fromEscaped('\\u0417\\u0430\\u0442\\u0438\\u0440\\u043e\\u0447\\u043d\\u044b\\u0435 \\u043c\\u0430\\u0448\\u0438\\u043d\\u044b')];
  if (profile.intent === 'cutter') return [fromEscaped('\\u0428\\u0432\\u043e\\u043d\\u0430\\u0440\\u0435\\u0437\\u0447\\u0438\\u043a\\u0438 \\u0420\\u0435\\u0437\\u0447\\u0438\\u043a\\u0438')];
  if (profile.intent === 'diamondBlade') return [
    fromEscaped('\\u0410\\u043b\\u043c\\u0430\\u0437\\u043d\\u044b\\u0435 \\u0434\\u0438\\u0441\\u043a\\u0438'),
    fromEscaped('\\u0410\\u043b\\u043c\\u0430\\u0437\\u043d\\u0430\\u044f \\u043e\\u0441\\u043d\\u0430\\u0441\\u0442\\u043a\\u0430')
  ];
  if (profile.intent === 'diamondCore') return [
    fromEscaped('\\u0410\\u043b\\u043c\\u0430\\u0437\\u043d\\u044b\\u0435 \\u043a\\u043e\\u0440\\u043e\\u043d\\u043a\\u0438'),
    fromEscaped('\\u041a\\u043e\\u0440\\u043e\\u043d\\u043a\\u0438 \\u0430\\u043b\\u043c\\u0430\\u0437\\u043d\\u044b\\u0435')
  ];
  return [];
}

function plannerContextSupplementalQueries(query: string) {
  const result: string[] = [];
  if (containsAny(query, plateTerms)) result.push(fromEscaped('\\u0412\\u0438\\u0431\\u0440\\u043e\\u043f\\u043b\\u0438\\u0442\\u044b'));
  if (containsAny(query, generatorTerms)) result.push(
    fromEscaped('\\u0413\\u0435\\u043d\\u0435\\u0440\\u0430\\u0442\\u043e\\u0440\\u044b'),
    fromEscaped('\\u0411\\u0435\\u043d\\u0437\\u0438\\u043d\\u043e\\u0432\\u044b\\u0435 \\u0433\\u0435\\u043d\\u0435\\u0440\\u0430\\u0442\\u043e\\u0440\\u044b')
  );
  if (containsAny(query, rammerTerms)) result.push(fromEscaped('\\u0412\\u0438\\u0431\\u0440\\u043e\\u0442\\u0440\\u0430\\u043c\\u0431\\u043e\\u0432\\u043a\\u0438'));
  if (containsAny(query, cutterTerms)) result.push(fromEscaped('\\u0428\\u0432\\u043e\\u043d\\u0430\\u0440\\u0435\\u0437\\u0447\\u0438\\u043a\\u0438 \\u0420\\u0435\\u0437\\u0447\\u0438\\u043a\\u0438'));
  if (containsAny(query, accessoryNeedTerms)) result.push(
    fromEscaped('\\u0420\\u0430\\u0441\\u0445\\u043e\\u0434\\u043d\\u0438\\u043a\\u0438'),
    fromEscaped('\\u0417\\u0430\\u043f\\u0447\\u0430\\u0441\\u0442\\u0438')
  );
  return uniqueList(result, 8);
}

function recommendationScore(product: Product, state: CustomerNeedState, userMessage: string, profile = buildProductFitProfile(state, userMessage)) {
  const needText = profile.activeNeedText || stateText(state, userMessage);
  const productText = [product.name, product.category, product.sourceUrl, product.description].join(' ').toLowerCase();
  const wantsPlate = profile.intent === 'plate';
  const wantsGenerator = profile.intent === 'generator';
  const wantsWeldingGenerator = profile.intent === 'weldingGenerator';
  const wantsGeneratorOil = profile.intent === 'generatorOil';
  const wantsEngineOil = profile.intent === 'engineOil';
  const wantsGeneratorAccessory = profile.intent === 'generatorAccessory';
  const wantsPlateAccessory = profile.intent === 'plateAccessory';
  const wantsCutter = profile.intent === 'cutter';
  const wantsDiamondBlade = profile.intent === 'diamondBlade';
  const wantsDiamondCore = profile.intent === 'diamondCore';
  const wantsTrowel = profile.intent === 'trowel';
  const wantsRoller = profile.intent === 'roller';
  const wantsPortable = state.featureSignals.portable >= 0.45 || state.featureSignals.compact >= 0.6 || containsAny(needText, weightTerms);
  const wantsHomeUse = state.featureSignals.homeUse >= 0.45 || containsAny(needText, homeTerms);
  const wantsLowNoise = state.featureSignals.lowNoise >= 0.45;
  const wantsColdStart = state.featureSignals.coldStart >= 0.45;
  const wantsProfessionalDuty = state.featureSignals.professionalDuty >= 0.45;
  const wantsBudget = state.featureSignals.budgetSensitive >= 0.45;
  const weight = extractWeightKg(product);
  const powerKw = extractPowerKw(product);
  const productCompact = compactModelText(productText);
  const modelTokens = profile.exactModelTokens.length ? profile.exactModelTokens : extractModelTokens(needText);
  const flags = classifyProduct(product);
  let score = productFitPenalty(product, profile);

  if (wantsPlate && containsAny(productText, plateTerms)) score += 60;
  if (wantsGenerator && containsAny(productText, generatorTerms)) score += 60;
  if (wantsWeldingGenerator && containsAny(productText, weldingTerms)) score += 80;
  if (wantsGeneratorOil && containsAny(productText, oilTerms)) score += 80;
  if (wantsEngineOil && flags.isEngineOil) score += 95;
  if (wantsGeneratorAccessory && containsAny(productText, accessoryTerms)) score += 65;
  if (wantsPlateAccessory && flags.isPlateAccessory) score += 90;
  if (wantsCutter && containsAny(productText, cutterTerms)) score += 60;
  if (wantsDiamondBlade && containsAny(productText, diamondBladeTerms)) score += 60;
  if (wantsDiamondCore && containsAny(productText, diamondCoreTerms)) score += 80;
  if (wantsTrowel && containsAny(productText, trowelTerms)) score += 70;
  if (wantsRoller && containsAny(productText, rollerTerms)) score += 70;
  for (const token of modelTokens) {
    const compact = compactModelText(token);
    if (compact && productCompact.includes(compact) && exactModelCanBypassFit(profile)) score += 240;
  }
  if (product.price) score += Math.max(0, 12 - product.price / 100_000);

  if (wantsGenerator && !containsAny(needText, accessoryNeedTerms) && containsAny(productText, accessoryTerms)) {
    score -= 85;
  }

  if (wantsGenerator && profile.wantsGasoline && containsAny(productText, gasolineTerms)) score += 36;
  if (wantsGenerator && profile.wantsDiesel && containsAny(productText, dieselTerms)) score += 28;
  if (wantsGenerator && profile.wantsInverterGenerator && flags.isInverter) score += 45;
  if (wantsGenerator && profile.wantsEnclosedGenerator && flags.hasGeneratorEnclosureSignal) score += 55;
  if (wantsGenerator && profile.wantsSinglePhase220 && containsAny(productText, singlePhaseTerms)) score += 18;
  if (wantsGenerator && profile.wantsElectricStart && hasElectricStartSignal(productText)) score += 24;
  if (wantsGenerator && profile.desiredPowerRange && powerKw !== undefined) {
    const { min, max } = profile.desiredPowerRange;
    const center = (min + max) / 2;
    if (powerKw >= min - 0.2 && powerKw <= max + 0.2) score += 48;
    else score -= Math.min(80, Math.abs(powerKw - center) * 14);
  }
  if (wantsGenerator) score += generatorPowerScore(product, profile);

  if (wantsPortable && weight !== undefined) {
    if (weight <= 60) score += 55;
    else if (weight <= 80) score += 45;
    else if (weight <= 100) score += 28;
    else if (weight <= 130) score += 12;
    else if (weight <= 160) score -= 15;
    else if (weight <= 250) score -= 35;
    else score -= 80;
  }

  if (wantsPlate && wantsPortable && containsAny(productText, wheelTransportTerms)) score += 24;

  if (wantsHomeUse && weight !== undefined) {
    if (weight <= 100) score += 18;
    if (weight > 180) score -= 25;
  }

  if (wantsHomeUse && productText.includes(fromEscaped('\\u0434\\u0438\\u0437\\u0435\\u043b'))) score -= 8;
  if (productText.includes(fromEscaped('\\u043f\\u0440\\u044f\\u043c\\u043e\\u0445\\u043e\\u0434'))) score += 6;

  if (wantsLowNoise) {
    if (containsAny(productText, inverterTerms)) score += 42;
    if (containsAny(productText, quietTerms)) score += 28;
    if (containsAny(productText, dieselTerms)) score -= 18;
    if (powerKw !== undefined && powerKw > 12) score -= 10;
  }

  if (wantsColdStart) {
    if (containsAny(productText, coldStartTerms)) score += 36;
    if (containsAny(productText, gasolineTerms)) score += 8;
    if (containsAny(productText, dieselTerms) && !containsAny(productText, coldStartTerms)) score -= 10;
  }

  if (wantsProfessionalDuty) {
    if (containsAny(productText, professionalTerms)) score += 30;
    if (containsAny(productText, dieselTerms)) score += 18;
    if (weight !== undefined && weight >= 120 && containsAny(productText, plateTerms)) score += 16;
    if (powerKw !== undefined && powerKw >= 8 && containsAny(productText, generatorTerms)) score += 18;
    if (product.price && product.price < 60_000) score -= 8;
  }

  if (wantsBudget && product.price) {
    if (product.price <= 70_000) score += 70;
    else if (product.price <= 100_000) score += 42;
    else if (product.price <= 140_000) score += 22;
    else if (product.price <= 180_000) score += 10;
    else if (product.price >= 500_000) score -= 20;
    score += Math.max(0, 36 - product.price / 4000);
  }

  if (profile.budgetMax && product.price) {
    const ratio = product.price / profile.budgetMax;
    if (ratio <= 0.75) score += 10;
    else if (ratio <= 1) score += 6;
    else if (ratio > 1.02) score -= 90;
  }

  return score;
}

function productCards(products: Product[], state: CustomerNeedState, userMessage = '', profile = buildProductFitProfile(state, userMessage), limit = MAX_PRODUCT_CARDS): ProductCard[] {
  const criteria: string[] = [];

  return products.slice(0, limit).map((product) => ({
    id: product.id,
    name: product.name,
    brand: displayProductBrand(product),
    category: product.category,
    price: product.price,
    currency: product.currency,
    imageUrl: product.imageUrl,
    sourceUrl: product.sourceUrl,
    specs: product.specs,
    reasons: productReasons(product, state, criteria, userMessage, profile),
    caveats: product.price ? [] : ['Цена требует проверки перед оформлением']
  }));
}

function productCardPriceRange(cards: ProductCard[]) {
  const prices = cards
    .map((card) => typeof card.price === 'number' ? card.price : undefined)
    .filter((price): price is number => typeof price === 'number' && Number.isFinite(price) && price > 0);
  if (!prices.length) return null;
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  return {
    min,
    max,
    text: min === max
      ? `${Math.round(min).toLocaleString('ru-RU')} ₽`
      : `${Math.round(min).toLocaleString('ru-RU')}–${Math.round(max).toLocaleString('ru-RU')} ₽`
  };
}

function answerContextProductsForCards(input: {
  answerNeedsFullCatalogContext: boolean;
  recommendationAnswer: boolean;
  blockEstimatedPumpCards: boolean;
  cards: ProductCard[];
  candidates: Product[];
  cardSourceProducts: Product[];
}) {
  if (input.blockEstimatedPumpCards) return [];
  if (input.answerNeedsFullCatalogContext && !input.recommendationAnswer) return input.candidates;
  const cardIds = new Set(input.cards.map((card) => card.id));
  if (!cardIds.size) return [];
  return input.cardSourceProducts.filter((product) => cardIds.has(product.id));
}

function compactSuitableProductsForAnswer(products: Product[], visibleCardIds: Set<string>, shownCardIds: Set<string>, limit = FULL_SLICE_PRODUCT_CARDS) {
  return products.slice(0, limit).map((product) => {
    const flags = classifyProduct(product);
    return {
      id: product.id,
      name: product.name,
      category: product.category,
      price: product.price,
      visibleCard: visibleCardIds.has(product.id),
      behindShowMore: shownCardIds.has(product.id) && !visibleCardIds.has(product.id),
      powerKw: extractPowerKw(product),
      weightKg: extractWeightKg(product),
      isInverter: flags.isInverter,
      isConventionalGenerator: flags.isGenerator && !flags.isInverter,
      isCoreProduct: isCoreEquipment(product)
    };
  });
}

function compactRuntimeContractsForAnswer(input: {
  requirementLedger: RequirementLedger;
  executionContract: ExecutionContract;
  cardManifest: CardManifest;
  factClaimPlanner: FactClaimPlanner;
  leadStateMachine: LeadStateMachine;
}) {
  return {
    requirementLedger: {
      activeRequirementIds: input.requirementLedger.activeRequirementIds.slice(0, 12),
      primaryRequirementIds: input.requirementLedger.primaryRequirementIds.slice(0, 8),
      hardConstraintKeys: input.requirementLedger.hardConstraintKeys.slice(0, 12),
      alternativeMode: input.requirementLedger.alternativeMode,
      warnings: input.requirementLedger.warnings.slice(0, 6)
    },
    executionContract: {
      answerTask: input.executionContract.answerTask,
      taskType: input.executionContract.taskType,
      catalogPolicy: input.executionContract.catalogPolicy,
      cardsPolicy: input.executionContract.cardsPolicy,
      leadPolicy: input.executionContract.leadPolicy,
      factPolicy: input.executionContract.factPolicy,
      activeRequirementIds: input.executionContract.activeRequirementIds.slice(0, 12),
      postconditions: input.executionContract.postconditions.slice(0, 8),
      warnings: input.executionContract.warnings.slice(0, 6)
    },
    cardManifest: {
      cardsPolicy: input.cardManifest.cardsPolicy,
      visibleProductIds: input.cardManifest.visibleProductIds.slice(0, 12),
      hiddenProductCount: input.cardManifest.hiddenProductIds.length,
      hiddenProductIdsPreview: input.cardManifest.hiddenProductIds.slice(0, ANSWER_HIDDEN_CARD_PREVIEW_LIMIT),
      items: input.cardManifest.items
        .filter((item) => item.visible || item.constraintStatus === 'violates_hard_constraints')
        .slice(0, 12)
        .map((item) => ({
          productId: item.productId,
          rank: item.rank,
          visible: item.visible,
          role: item.role,
          constraintStatus: item.constraintStatus,
          violations: item.violations.slice(0, 4)
        })),
      warnings: input.cardManifest.warnings.slice(0, 6)
    },
    factClaimPlanner: {
      factPolicy: input.factClaimPlanner.factPolicy,
      allowedSources: input.factClaimPlanner.allowedSources,
      requiredDisclaimers: input.factClaimPlanner.requiredDisclaimers.slice(0, 8),
      forbiddenClaims: input.factClaimPlanner.forbiddenClaims.slice(0, 8),
      risk: input.factClaimPlanner.risk,
      warnings: input.factClaimPlanner.warnings.slice(0, 6)
    },
    leadStateMachine: {
      state: input.leadStateMachine.state,
      nextAction: input.leadStateMachine.nextAction,
      leadPolicy: input.leadStateMachine.leadPolicy,
      hasContactInTurn: input.leadStateMachine.hasContactInTurn,
      leadRequested: input.leadStateMachine.leadRequested,
      leadCreated: input.leadStateMachine.leadCreated,
      missing: input.leadStateMachine.missing,
      warnings: input.leadStateMachine.warnings.slice(0, 6)
    }
  };
}


function productBrandKey(product: Product) {
  const nameBrand = product.name
    .replace(/^(?:генератор|generator)\s+(?:бензиновый|дизельный|gasoline|diesel)?\s*/i, '')
    .split(/\s+/)[0];
  return String(product.brand || nameBrand || product.id).trim().toLowerCase();
}

function diversifyRankedProducts(items: Array<{ product: Product; score: number }>, limit = MAX_PRODUCT_CARDS) {
  const remaining = [...items];
  const result: Product[] = [];
  const usedBrands = new Set<string>();

  while (remaining.length && result.length < limit) {
    let pickIndex = 0;
    if (result.length < 4) {
      const bestScore = remaining[0].score;
      const diverseIndex = remaining.findIndex((item) =>
        !usedBrands.has(productBrandKey(item.product)) &&
        item.score >= bestScore - 28
      );
      if (diverseIndex >= 0) pickIndex = diverseIndex;
    }
    const [picked] = remaining.splice(pickIndex, 1);
    result.push(picked.product);
    usedBrands.add(productBrandKey(picked.product));
  }

  return result;
}

function productReasons(product: Product, state: CustomerNeedState, criteria: string[], userMessage = '', profile = buildProductFitProfile(state, userMessage)) {
  const text = [product.name, product.category, product.sourceUrl, product.description, JSON.stringify(product.specs ?? {})].join(' ').toLowerCase();
  const reasons: string[] = [];
  const weight = extractWeightKg(product);
  const powerKw = extractPowerKw(product);
  const productCompact = compactModelText(text);
  const exactToken = profile.exactModelTokens.find((token) => productCompact.includes(compactModelText(token)));
  const flags = classifyProduct(product);

  if (exactToken) {
    reasons.push(`Совпадает с указанной моделью: ${exactToken}`);
  }

  if (profile.intent === 'generator' && flags.isGenerator) {
    if (flags.isGasoline) reasons.push('Подходит по классу: бензиновый генератор для резервного питания');
    else reasons.push('Подходит по классу: генератор, а не аксессуар или другая техника');
    if (powerKw !== undefined) {
      const hasPowerCriterion = Boolean(profile.generatorPower || profile.desiredPowerRange);
      reasons.push(hasPowerCriterion
        ? `Мощность около ${powerKw} кВт соответствует заданному диапазону`
        : `Мощность около ${powerKw} кВт`);
    }
    if (profile.wantsEnclosedGenerator && flags.hasGeneratorEnclosureSignal) reasons.push('Есть признаки закрытого или шумозащитного исполнения');
    if (profile.wantsElectricStart && flags.hasElectricStart) reasons.push('Есть признаки запуска ключом/кнопкой');
  }

  if (profile.intent === 'weldingGenerator' && flags.isWeldingGenerator) {
    reasons.push('Подходит по классу: сварочный генератор, а не обычная электростанция');
  }

  if (profile.intent === 'generatorOil' && flags.isGeneratorOil) {
    reasons.push('Подходит по классу: масло для генератора');
  }

  if (profile.intent === 'engineOil' && flags.isEngineOil) {
    reasons.push(fromEscaped('\\u041f\\u043e\\u0434\\u0445\\u043e\\u0434\\u0438\\u0442 \\u043f\\u043e \\u043a\\u043b\\u0430\\u0441\\u0441\\u0443: 4-\\u0442\\u0430\\u043a\\u0442\\u043d\\u043e\\u0435 \\u043c\\u043e\\u0442\\u043e\\u0440\\u043d\\u043e\\u0435 \\u043c\\u0430\\u0441\\u043b\\u043e'));
  }

  if (profile.intent === 'generatorAccessory' && (flags.isGeneratorAccessory || flags.isGeneratorOil)) {
    reasons.push('Подходит по классу: расходник или аксессуар для генератора');
  }

  if (profile.intent === 'plateAccessory' && flags.isPlateAccessory) {
    reasons.push(fromEscaped('\\u041f\\u043e\\u0434\\u0445\\u043e\\u0434\\u0438\\u0442 \\u043f\\u043e \\u043a\\u043b\\u0430\\u0441\\u0441\\u0443: \\u043a\\u043e\\u0432\\u0440\\u0438\\u043a/\\u043d\\u0430\\u043a\\u043b\\u0430\\u0434\\u043a\\u0430 \\u043a \\u0432\\u0438\\u0431\\u0440\\u043e\\u043f\\u043b\\u0438\\u0442\\u0435'));
  }

  if (profile.intent === 'plate' && flags.isPlate) {
    const plateKind = /(?:реверсив|reversible)/iu.test(text)
      ? 'реверсивная виброплита'
      : /(?:прямоход|single[-\s]?direction)/iu.test(text)
        ? 'прямоходная виброплита'
        : 'виброплита';
    reasons.push(`Подходит по классу: ${plateKind} для основания и плиточных работ`);
  }

  if (profile.intent === 'cutter' && flags.isCutter) {
    reasons.push('Подходит по классу: швонарезчик/резчик для дорожных и бетонных работ');
  }

  if (profile.intent === 'diamondBlade' && flags.isDiamondBlade) {
    reasons.push('Подходит по классу: алмазный диск/оснастка под текущую задачу резки');
  }

  if (profile.intent === 'diamondCore' && flags.isDiamondCore) {
    reasons.push('Подходит по классу: алмазная коронка под бурение');
  }

  if (profile.intent === 'trowel' && flags.isTrowel) {
    reasons.push('Подходит по классу: затирочная машина для бетонного пола');
  }

  if (profile.intent === 'roller' && flags.isRoller) {
    reasons.push('Подходит по классу: виброкаток для уплотнения');
  }
  if ((state.featureSignals.portable >= 0.45 || state.featureSignals.compact >= 0.45) && weight !== undefined) {
    if (weight <= 80) reasons.push(`Легкая модель для своего класса: около ${weight} кг, ее проще перевозить и переносить`);
    else if (weight <= 110) reasons.push(`Вес около ${weight} кг: переносимость уже надо оценить по условиям, но это не тяжелый промышленный класс`);
    else reasons.push(`Вес около ${weight} кг: подойдет только если есть способ погрузки и перемещения`);
  }

  if (state.featureSignals.lowNoise >= 0.45) {
    if (containsAny(text, inverterTerms)) reasons.push('Инверторный тип лучше подходит для бытовых задач, где важны шум и стабильность питания');
    else if (containsAny(text, quietTerms)) reasons.push('В описании есть признаки тихого исполнения или закрытого кожуха');
  }

  if (state.featureSignals.professionalDuty >= 0.45) {
    if (containsAny(text, professionalTerms) || containsAny(text, dieselTerms)) reasons.push('Больше подходит под регулярную профессиональную нагрузку, чем бытовые облегченные варианты');
    if (powerKw !== undefined && powerKw >= 8) reasons.push(`Мощность около ${powerKw} кВт дает запас для рабочих нагрузок`);
  }

  if (state.featureSignals.coldStart >= 0.45 && containsAny(text, coldStartTerms)) {
    reasons.push('Есть признаки исполнения, которое полезно для запуска и работы в холодных условиях');
  }

  if (state.featureSignals.budgetSensitive >= 0.45 && product.price && reasons.length < 3) {
    reasons.push(`Цена в карточке: ${product.price.toLocaleString('ru-RU')} ${product.currency ?? 'RUB'}, актуальность нужно проверить перед оформлением`);
  }

  const usefulCriteria = criteria.filter((criterion) => !/^подбор\s+/i.test(criterion.trim()));
  for (const criterion of usefulCriteria.slice(0, 3)) {
    if (reasons.length >= 3) break;
    reasons.push(`Учитывает вашу задачу: ${criterion}`);
  }

  return reasons.length ? reasons.slice(0, 3) : ['Найден в каталоге БАКАУТ по вашему запросу'];
}

function cardDiagnostics(
  profile: ProductFitProfile,
  selectedCount: number,
  selectedRejectedCount: number,
  rankedCount: number,
  fallbackSuppressed: boolean,
  fallbackReason?: string
): CardSelectionDiagnostics {
  return {
    profile: {
      intent: profile.intent,
      requestedBrands: profile.requestedBrands,
      wantsGasoline: profile.wantsGasoline,
      wantsDiesel: profile.wantsDiesel,
      wantsElectricStart: profile.wantsElectricStart,
      wantsInverterGenerator: profile.wantsInverterGenerator,
      wantsEnclosedGenerator: profile.wantsEnclosedGenerator,
      wantsConventionalGenerator: profile.wantsConventionalGenerator,
      desiredPowerRange: profile.desiredPowerRange,
      generatorPower: profile.generatorPower,
      budgetMax: profile.budgetMax
    },
    selectedCount,
    selectedRejectedCount,
    rankedCount,
    fallbackSuppressed,
    fallbackReason
  };
}

function isLeadAction(action: AssistantTurnAction) {
  return action === 'collect_lead' || action === 'handoff_specialist';
}

function isLeadPlan(plan: AssistantTurnPlan) {
  return isLeadAction(plan.action) || plan.answerMode === 'leadCollection' || plan.followUpPolicy === 'collectLead';
}

function planAllowsCatalogSelectionOverride(plan: AssistantTurnPlan) {
  return !isLeadPlan(plan) && (
    plan.action === 'recommend_products' ||
    plan.answerMode === 'productRecommendation' ||
    plan.cardPolicy === 'showProducts' ||
    plan.selectionState.shouldShowCards ||
    plan.selectedProductIds.length > 0
  );
}

function planContractRequestsProductCards(plan: AssistantTurnPlan) {
  const decision = plan.agentDecision;
  if (!decision) return false;
  if (decision.cardsRole === 'none') return false;
  return decision.productCardsPolicy === 'show_matching_products' ||
    decision.productCardsPolicy === 'show_exact_matches' ||
    decision.productCardsPolicy === 'supporting_only';
}

function isCatalogShortlistTurn(userMessage: string, plan?: AssistantTurnPlan) {
  if (plan?.agentDecision?.catalogAction) {
    if (plan.agentDecision.catalogAction === 'find_matching_products' ||
      plan.agentDecision.catalogAction === 'exact_model_lookup' ||
      plan.agentDecision.catalogAction === 'verify_catalog_absence') return true;
  }
  const catalogText = [userMessage, plan?.catalogSearchQuery].filter(Boolean).join(' ');
  const catalogAvailability = isCatalogAvailabilityQuestion(catalogText) && !isManufacturingStatusQuestion(userMessage);
  if (!catalogAvailability) return false;
  if (fallbackDetectOwnershipCostQuestion(userMessage) || fallbackDetectTechnicalSpecVerificationQuestion(userMessage)) return false;
  return true;
}

function shouldForceStructuredSelectionCards(userMessage: string, plan: AssistantTurnPlan, result: ProductSelectionResult) {
  const catalogShortlistTurn = isCatalogShortlistTurn(userMessage, plan);
  const plannerAllowsCards = plan.cardPolicy !== 'textOnly' &&
    planAllowsCatalogSelectionOverride(plan) &&
    planContractRequestsProductCards(plan);
  return result.matchedProducts.length > 0 &&
    (plannerAllowsCards || selectionResultCanDriveCards(plan, result, userMessage)) &&
    hasReliableGeneratorSelectionBasis(result.state) &&
    !shouldBlockGeneratorCardsForEstimatedPump(result.state) &&
    result.confidence >= 0.55 &&
    !isLeadPlan(plan) &&
    (catalogShortlistTurn || !shouldUseCurrentLineupStyle(userMessage, plan)) &&
    !shouldUseDetailedFactStyle(userMessage, plan, 0) &&
    !isTextOnlyFactualTurn(userMessage, plan);
}

function shouldPromotePrimarySelectionCards(
  contract: AgentTurnContract,
  plan: AssistantTurnPlan,
  result: ProductSelectionResult,
  blockEstimatedPumpCards: boolean
) {
  return contract.cardsRole === 'primary' &&
    !isLeadPlan(plan) &&
    !blockEstimatedPumpCards &&
    result.trace?.canRecommendFromSelection === true &&
    result.visibleProducts.length > 0 &&
    result.matchedProducts.length > 0 &&
    result.confidence >= 0.55 &&
    (
      hasReliableGeneratorSelectionBasis(result.state) ||
      shouldAllowPreliminaryCatalogCardsForEstimatedPump(contract, result)
    );
}

function shouldPromoteCatalogFactCheckedCards(
  contract: AgentTurnContract,
  plan: AssistantTurnPlan,
  result: ProductSelectionResult,
  blockEstimatedPumpCards: boolean
) {
  const factCheckFoundCatalogProducts = contract.catalogAction === 'verify_catalog_absence' ||
    contract.catalogAction === 'exact_model_lookup';
  const exactLookupAlternativeFound = result.trace?.exactLookupAlternative === true;
  return factCheckFoundCatalogProducts &&
    ((contract.cardsRole !== 'none' && (contract.productCardsPolicy ?? 'none') !== 'none') || exactLookupAlternativeFound) &&
    !isLeadPlan(plan) &&
    !blockEstimatedPumpCards &&
    (!isCurrentLevelTechnicalTurn(contract) || exactLookupAlternativeFound) &&
    result.trace?.canRecommendFromSelection === true &&
    (result.visibleProducts.length > 0 || (exactLookupAlternativeFound && result.matchedProducts.length > 0)) &&
    result.matchedProducts.length > 0 &&
    result.confidence >= 0.55 &&
    hasReliableGeneratorSelectionBasis(result.state);
}

function shouldPromoteSupportingSelectionCards(
  contract: AgentTurnContract,
  plan: AssistantTurnPlan,
  result: ProductSelectionResult,
  blockEstimatedPumpCards: boolean
) {
  const taskNeedsCatalogSelection = contract.catalogAction === 'find_matching_products' &&
    (contract.taskType === 'product_selection' ||
      contract.taskType === 'product_selection_with_availability' ||
      contract.taskType === 'product_selection_with_delivery' ||
      contract.answerTask === 'product_selection' ||
      contract.answerTask === 'mixed');
  const hard = result.state.hardConstraints;
  const hasMaterialSelectionConstraint = Boolean(
    hard.exactModelTokens.length ||
    hard.exactModelConstraint ||
    hard.weightKgMin ||
    hard.weightKgMax ||
    hard.diameterMmMin ||
    hard.diameterMmMax ||
    hard.nominalPowerKwMin ||
    hard.nominalPowerKwMax ||
    hard.maxPowerKwMin ||
    hard.maxPowerKwMax ||
    hard.budgetMax ||
    hard.brandConstraint ||
    hard.mustHaveTraits.length
  );
  return taskNeedsCatalogSelection &&
    contract.cardsRole === 'supporting' &&
    (contract.productCardsPolicy ?? 'none') !== 'none' &&
    !isLeadPlan(plan) &&
    !blockEstimatedPumpCards &&
    result.trace?.canRecommendFromSelection === true &&
    result.matchedProducts.length > 0 &&
    result.confidence >= 0.55 &&
    hasReliableGeneratorSelectionBasis(result.state) &&
    hard.productIntent !== 'unknown' &&
    (hasMaterialSelectionConstraint || hasUserGroundedSelectionEvidence(result.state));
}

function promotePlanToSelectionCatalogCards(
  plan: AssistantTurnPlan,
  result: ProductSelectionResult,
  guidance: string
): AssistantTurnPlan {
  const hard = result.state.hardConstraints;
  const selectedProducts = result.visibleProducts.length
    ? result.visibleProducts
    : result.trace?.exactLookupAlternative === true
      ? result.matchedProducts
      : result.matchedProducts;
  return {
    ...plan,
    action: 'recommend_products',
    answerMode: 'productRecommendation',
    cardPolicy: 'showProducts',
    followUpPolicy: result.hiddenProducts.length ? 'askClarifyingQuestion' : 'auto',
    selectedProductIds: selectedProducts.map((product) => product.id),
    requiredProductTraits: {
      ...plan.requiredProductTraits,
      productIntent: hard.productIntent,
      productRole: hard.productRole,
      fuel: hard.fuel ?? 'unknown',
      startType: hard.startType ?? 'unknown',
      enclosure: hard.enclosure ?? 'unknown',
      conventionalGenerator: hard.conventionalGenerator ?? null,
      singlePhase220: hard.singlePhase220 ?? null,
      budgetMax: hard.budgetMax ?? null,
      nominalPowerKwMin: hard.nominalPowerKwMin ?? null,
      nominalPowerKwMax: hard.nominalPowerKwMax ?? null,
      maxPowerKwMin: hard.maxPowerKwMin ?? null,
      maxPowerKwMax: hard.maxPowerKwMax ?? null,
      provenance: hard.provenance ?? plan.requiredProductTraits.provenance,
      weightKgMin: hard.weightKgMin ?? null,
      weightKgMax: hard.weightKgMax ?? null,
      diameterMmMin: hard.diameterMmMin ?? null,
      diameterMmMax: hard.diameterMmMax ?? null
    },
    selectionState: {
      ...plan.selectionState,
      shouldShowCards: true,
      cardDisplayMode: 'structured_selection'
    },
    needsWebSearch: false,
    answerGuidance: [
      plan.answerGuidance,
      guidance
    ].filter(Boolean).join('\n')
  };
}

function shouldPromoteGeneratorSizingCards(userMessage: string, result: ProductSelectionResult, blockEstimatedPumpCards: boolean) {
  void userMessage;
  return shouldPromoteGeneratorSizingCardsForContract(undefined, result, blockEstimatedPumpCards);
}

function shouldPromoteGeneratorSizingCardsForContract(
  contract: AgentTurnContract | undefined,
  result: ProductSelectionResult,
  blockEstimatedPumpCards: boolean
) {
  if (!contract ||
    contract.cardsRole === 'none' ||
    (contract.catalogAction ?? 'none') === 'none' ||
    (contract.productCardsPolicy ?? 'none') === 'none'
  ) return false;
  if (blockEstimatedPumpCards) return false;
  if (result.state.hardConstraints.productIntent !== 'generator') return false;
  if (result.trace?.canRecommendFromSelection !== true) return false;
  if (!result.visibleProducts.length || !result.matchedProducts.length) return false;
  if (result.confidence < 0.55 || !hasReliableGeneratorSelectionBasis(result.state)) return false;
  return contract.cardsRole === 'primary' || contract.cardsRole === 'supporting';
}

function selectionResultCanDriveCards(plan: AssistantTurnPlan, result: ProductSelectionResult, userMessage: string) {
  const catalogShortlistTurn = isCatalogShortlistTurn(userMessage, plan);
  const exactLookupAlternativeFound = result.trace?.exactLookupAlternative === true;
  return (planContractRequestsProductCards(plan) || catalogShortlistTurn) &&
    (plan.cardPolicy === 'showProducts' || plan.selectionState.shouldShowCards || catalogShortlistTurn) &&
    (result.trace?.canRecommendFromSelection === true || exactLookupAlternativeFound) &&
    result.visibleProducts.length > 0 &&
    result.matchedProducts.length > 0 &&
    result.confidence >= 0.55 &&
    hasReliableGeneratorSelectionBasis(result.state) &&
    !shouldBlockGeneratorCardsForEstimatedPump(result.state) &&
    !isLeadPlan(plan) &&
    (catalogShortlistTurn || !shouldUseCurrentLineupStyle(userMessage, plan)) &&
    !shouldUseDetailedFactStyle(userMessage, plan, 0) &&
    !isTextOnlyFactualTurn(userMessage, plan);
}

function isTextOnlyFactualTurn(userMessage: string, plan: AssistantTurnPlan) {
  const catalogShortlistTurn = isCatalogShortlistTurn(userMessage, plan);
  if (shouldUseDetailedFactStyle(userMessage, plan, 0) || (!catalogShortlistTurn && shouldUseCurrentLineupStyle(userMessage, plan))) return true;
  if (fallbackDetectOwnershipCostQuestion(userMessage) || fallbackDetectTechnicalSpecVerificationQuestion(userMessage)) return true;
  const catalogOnlyAvailability = isCatalogAvailabilityQuestion(userMessage) && !isManufacturingStatusQuestion(userMessage);
  return !catalogOnlyAvailability &&
    !isProductCardSelectionFollowUp(userMessage) &&
    fallbackDetectCurrentLineupQuestion(userMessage);
}

function hasUserGroundedSelectionEvidence(state: ProductSelectionState) {
  const activeIntent = state.targetProductClass !== 'unknown'
    ? state.targetProductClass
    : state.hardConstraints.productIntent;
  if (activeIntent === 'unknown') return false;
  const provenance = state.hardConstraints.provenance ?? {};
  const groundedConstraint = Object.entries(provenance).some(([key, value]) =>
    key !== 'singlePhase220' &&
    (value === 'explicit_user' || value === 'inferred_from_load' || value === 'previous_selection')
  );
  return groundedConstraint ||
    Boolean(state.loadProfile?.requiredNominalKw) ||
    Boolean(state.hardConstraints.exactModelTokens.length || state.hardConstraints.exactModelConstraint);
}

function fallbackDetectPurchaseIntent(text: string) {
  return /(?:\bbuy\b|\border\b|\btake\b|куплю|(?:^|[^\p{L}])беру(?:$|[^\p{L}])|(?:^|[^\p{L}])возьму(?:$|[^\p{L}])|давайте|оформ|заказ|в\s+заявк|оставлю\s+контакт|передайте\s+менеджеру)/iu.test(text);
}

function fallbackDetectLeadHandoffIntent(text: string) {
  const normalized = text.toLowerCase();
  const hasContact = /(?:\+?\d[\d\s()\-]{8,}\d|тел(?:ефон)?|контакт|зовут|меня\s+зовут|whatsapp|ватсап|telegram|телеграм)/iu.test(normalized);
  if (!hasContact) return false;
  return fallbackDetectPurchaseIntent(normalized) ||
    /(?:специалист|менеджер|свяж|перезвон|подтверд|провер|налич|цен[ау]|доставк|оформ|заявк)/iu.test(normalized);
}

function fallbackDetectOperationalHandoffQuestion(text: string) {
  const normalized = text.toLowerCase();
  const hasOperationalTerm = /(?:доставк|налич|в\s+наличии|на\s+складе|скидк|спецуслов|самовывоз|оплат|оформ|заказ|купить|забрать|актуальн\w*\s+цен|финальн\w*\s+цен|точн\w*\s+цен|срок[иов]*\s+(?:достав|получ))/iu.test(normalized);
  if (!hasOperationalTerm) return false;
  return /(?:сколько|стоим|услов|есть\s+ли|точно|можно\s+ли|могу\s+оставить|оставлю|перезвон|свяж|логист|менеджер|телефон|контакт)/iu.test(normalized);
}

function isTechnicalConsultationContinuation(text: string) {
  const normalized = text.toLowerCase();
  const technicalContext = /(?:электрик|пусков\w*\s+ток|тр[её]хфаз|3\s*фаз|фаз[аы]|нагрузк|мощност|квт|кв\b|прибор|генератор|расчет|рассчит)/iu.test(normalized);
  if (!technicalContext) return false;
  const asksForHandoff = /(?:перезвон|свяж|позвон|оставлю\s+контакт|оставить\s+контакт|передайте\s+менеджеру|оформ|заказ|купить|(?:^|[^\p{L}])беру(?:$|[^\p{L}])|(?:^|[^\p{L}])возьму(?:$|[^\p{L}])|доставк|налич|актуальн[\p{L}]*\s+цен|точн[\p{L}]*\s+цен)/iu.test(normalized);
  if (asksForHandoff || hasLikelyContactText(text)) return false;
  return /(?:без\s+электрик\w*\s+.*(?:не\s+выбер|не\s+подбер)|нуж[её]н\s+электрик|надо\s+с\s+электрик|электрик\s+.*(?:раскида|распредел|посчита)|пусков\w*\s+ток|суммарн\w*\s+мощност|общ\w*\s+нагрузк)/iu.test(normalized);
}

function fallbackDetectOwnershipCostQuestion(text: string) {
  const normalized = text.toLowerCase();
  const hasServiceOrCostTerm = /(?:сервис|обслуживан|регламент|то\b|ремонт|запчаст|детал|расходник|фильтр|свеч|ремен|стоимост|цен[ауы]|ценник|владени|эксплуатацион|service|maintenance|repair|spare|parts|consumable|ownership)/iu.test(normalized);
  const asksForFacts = /(?:сколько|стоит|цены?|стоимост|что\s+по|как\s+с|сравн|ориентир|актуальн|в\s+сети|какие|меняют|дорог|дешев|выгодн|затрат)/iu.test(normalized);
  return hasServiceOrCostTerm && asksForFacts;
}

function fallbackDetectTechnicalSpecVerificationQuestion(text: string) {
  const normalized = text.toLowerCase();
  const asksComparison = /(?:\u0441\u0440\u0430\u0432\u043d|compare|\u0447\u0442\u043e\s+\u043b\u0443\u0447\u0448|\u0433\u0434\u0435\s+\u043b\u0443\u0447\u0448|better|which)/iu.test(normalized);
  const asksUnverifiedSpecs = /(?:\u0448\u0443\u043c|\u0442\u0438\u0448\u0435|\u0434\u0431|db|thd|\u0433\u0430\u0440\u043c\u043e\u043d\u0438\u043a|avr|\u0430\u0432\u0440|\u0441\u0438\u043d\u0443\u0441|\u043d\u0430\u043f\u0440\u044f\u0436|\u0447\u0430\u0441\u0442\u043e\u0442|\u0438\u043d\u0432\u0435\u0440\u0442\u043e\u0440|\u044d\u043a\u043e\u043d\u043e\u043c\u0438\u0447|\u0440\u0430\u0441\u0445\u043e\u0434\s+\u0442\u043e\u043f\u043b|noise|quieter|sine|voltage|frequency|inverter|economy|fuel\s+consumption)/iu.test(normalized);
  return asksComparison && asksUnverifiedSpecs && extractModelTokens(text).length >= 2;
}

function fallbackDetectCurrentLineupQuestion(text: string) {
  const normalized = text.toLowerCase();
  return /(?:выпуска(?:ет|ется|ют|ютcя)?|производ(?:ит|ится|ят|ятcя)?|снят[аоы]?\s+с\s+производства|снима(?:ют|ется)\s+с\s+производства|актуальн(?:ая|ой|ую)?\s+линейк|текущ(?:ая|ей|ую)?\s+линейк|еще\s+в\s+линейк|ещ[её]\??|сейчас\s+(?:есть|выпуска|производ)|current\s+lineup|discontinued|still\s+made|still\s+produced)/iu.test(normalized);
}

function shouldUseCurrentLineupStyle(userMessage: string, plan?: AssistantTurnPlan) {
  if (isProductCardSelectionFollowUp(userMessage)) return false;
  if (isCatalogShortlistTurn(userMessage, plan)) return false;
  if (isCatalogAvailabilityQuestion(userMessage) && !isManufacturingStatusQuestion(userMessage)) return false;
  if (plan?.answerMode === 'currentLineup') return true;
  if (plan?.answerMode && plan.answerMode !== 'unknown') return false;
  return fallbackDetectCurrentLineupQuestion(userMessage) && !fallbackDetectOwnershipCostQuestion(userMessage);
}

function shouldUseWebSearch(userMessage: string, plan: AssistantTurnPlan) {
  if (plan.agentDecision) {
    if (plan.needsWebSearch) return true;
    if (plan.action === 'verify_with_web') return true;
    if (plan.answerMode === 'currentLineup' || plan.answerMode === 'serviceCostComparison') return true;
    return false;
  }
  const planText = [
    plan.action,
    plan.catalogSearchQuery,
    plan.answerGuidance,
    plan.missingInformation.join(' ')
  ].join(' ');
  if (plan.needsWebSearch) return true;
  if (isCatalogShortlistTurn(userMessage, plan)) return false;
  if (plan.action === 'verify_with_web') return true;
  if (plan.answerMode === 'currentLineup' || plan.answerMode === 'serviceCostComparison') return true;
  if (fallbackDetectTechnicalSpecVerificationQuestion(`${userMessage} ${planText}`)) return true;
  const fallbackAllowed = plan.answerMode === 'unknown';
  return fallbackAllowed && fallbackDetectOwnershipCostQuestion(`${userMessage} ${planText}`);
}

function shouldUseDetailedFactStyle(userMessage: string, plan: AssistantTurnPlan, cardCount: number) {
  if (plan.agentDecision) {
    if (plan.answerMode === 'serviceCostComparison' || plan.answerMode === 'detailedFact') return true;
    return false;
  }
  if (plan.answerMode === 'serviceCostComparison' || plan.answerMode === 'detailedFact') return true;
  if (plan.answerMode === 'currentLineup') return false;
  if (plan.answerMode && plan.answerMode !== 'unknown') return false;
  if (cardCount > 0 && plan.action === 'recommend_products') return false;
  if (shouldUseCurrentLineupStyle(userMessage, plan)) return false;
  const text = [
    userMessage,
    plan.catalogSearchQuery,
    plan.answerGuidance,
    plan.missingInformation.join(' ')
  ].join(' ');
  return fallbackDetectOwnershipCostQuestion(text) || /(?:подроб|развернут|таблиц|сравнени|ориентир)/iu.test(text);
}

function shouldUseServiceCostStyle(userMessage: string, plan: AssistantTurnPlan, detailedFactStyle: boolean) {
  return detailedFactStyle &&
    (plan.answerMode === 'serviceCostComparison' || fallbackDetectOwnershipCostQuestion(userMessage));
}

function shouldUseDeepReasoningForPlanning(userMessage: string, conflicts: DataConflict[]) {
  return fallbackDetectCurrentLineupQuestion(userMessage) ||
    fallbackDetectOwnershipCostQuestion(userMessage) ||
    conflicts.length > 0;
}

function resolveReasoningProfile(
  baseModel: string,
  baseEffort: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh',
  deepReasoning: boolean,
  complexityScore = 0
): { model: string; effort: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' } {
  if (!deepReasoning) return { model: baseModel, effort: baseEffort };
  return {
    model: config.OPENAI_DEEP_REASONING_MODEL,
    effort: complexityScore >= 2 ? 'xhigh' : 'high'
  };
}

function shouldUseDeepReasoningForAnswer(plan: AssistantTurnPlan, currentLineupStyle: boolean, detailedFactStyle: boolean, mustUseWebSearch: boolean, conflictCount: number) {
  return plan.answerMode === 'currentLineup' ||
    plan.answerMode === 'serviceCostComparison' ||
    plan.answerMode === 'detailedFact' ||
    plan.action === 'verify_with_web' ||
    plan.needsWebSearch ||
    currentLineupStyle ||
    detailedFactStyle ||
    mustUseWebSearch ||
    conflictCount > 0;
}

function roundNumber(value: number | undefined, digits = 2) {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  const multiplier = 10 ** digits;
  return Math.round(value * multiplier) / multiplier;
}

function productComparisonSnapshot(product: Product) {
  const power = extractGeneratorPower(product);
  return {
    id: product.id,
    name: product.name,
    price: product.price,
    currency: product.currency ?? 'RUB',
    nominalPowerKw: roundNumber(power.nominalKw),
    maxPowerKw: roundNumber(power.maxKw)
  };
}

function buildCatalogComparisonDiagnostics(userMessage: string, products: Product[]) {
  const modelTokens = extractModelTokens(userMessage).map((token) => compactModelText(token));
  if (!modelTokens.length) return null;

  const baseline = products.find((product) => {
    const productText = compactModelText(productFullText(product));
    return modelTokens.some((token) => productText.includes(token));
  });
  if (!baseline) return null;

  const baselineSnapshot = productComparisonSnapshot(baseline);
  const baselinePower = baselineSnapshot.nominalPowerKw ?? baselineSnapshot.maxPowerKw;
  const alternatives = products
    .filter((product) => product.id !== baseline.id)
    .slice(0, PLANNER_CANDIDATE_LIMIT)
    .map((product) => {
      const snapshot = productComparisonSnapshot(product);
      const candidatePower = snapshot.nominalPowerKw ?? snapshot.maxPowerKw;
      const priceDeltaRub = typeof snapshot.price === 'number' && typeof baselineSnapshot.price === 'number'
        ? roundNumber(snapshot.price - baselineSnapshot.price, 2)
        : undefined;
      const powerDeltaKw = candidatePower !== undefined && baselinePower !== undefined
        ? roundNumber(candidatePower - baselinePower, 2)
        : undefined;
      return {
        ...snapshot,
        priceDeltaRub,
        powerDeltaKw,
        isCheaper: priceDeltaRub === undefined ? null : priceDeltaRub < 0,
        isMorePowerful: powerDeltaKw === undefined ? null : powerDeltaKw > 0,
        isCheaperAndMorePowerful: priceDeltaRub !== undefined && powerDeltaKw !== undefined
          ? priceDeltaRub < 0 && powerDeltaKw > 0
          : null
      };
    });

  return {
    baseline: baselineSnapshot,
    alternatives,
    hasCheaperAndMorePowerfulAlternative: alternatives.some((item) => item.isCheaperAndMorePowerful === true)
  };
}

function buildFactualVerificationPolicy(input: {
  userMessage: string;
  plan: AssistantTurnPlan;
  currentLineupStyle: boolean;
  detailedFactStyle: boolean;
}) {
  if (!input.currentLineupStyle && !input.detailedFactStyle && input.plan.action !== 'verify_with_web') return null;

  if (input.currentLineupStyle) {
    return {
      mode: 'current_lineup_status',
      question: input.userMessage,
      sourceCoverage: [
        'manufacturer current product/catalog pages',
        'manufacturer support, manuals and spare-parts pages',
        'official distributors and current dealer catalogs',
        'archived, used-equipment and parts-only evidence',
        'explicit discontinued, successor or replacement notices when available'
      ],
      inferenceRules: [
        'A current-production or current-lineup claim needs positive current evidence, preferably from manufacturer or official current catalog.',
        'Absence from the current manufacturer catalog is evidence for "not visible in the current public lineup"; it is not by itself proof that production stopped.',
        'A discontinued/replaced claim needs explicit discontinued/replacement evidence, or a consistent pattern where current official sources omit the model while only used, archived or parts/support pages remain.',
        'Catalog stock, spare parts, manuals or used listings prove support/market presence only; they do not prove current factory production.',
        'Do not call an alternative model a successor or replacement unless a source explicitly supports that relationship; otherwise call it a current model in the same class or a practical alternative.',
        'If neither side is proven, preserve the known facts and state the confidence level instead of forcing yes/no.'
      ],
      answerRules: [
        'Give the buyer the practical answer first.',
        'Separate confirmed facts from inference.',
        'Do not expose URLs, domains or markdown links.',
        'Name a successor/current replacement only when the search result clearly supports it.',
        'When listing current alternatives, do not make the list sound exhaustive unless the evidence covers the whole current line; distinguish single-direction plates from reversible plates.',
        'After finding source-mentioned alternatives or current same-class lineups, check catalogLineupAlternatives/catalogCandidates and say which concrete alternatives are present in our catalog with prices; if none are present, say that explicitly.',
        'A same-family catalog item near the questioned model is catalog presence only; do not call it a current manufacturer alternative, successor or replacement unless web evidence also supports that relation.',
        'If mandatoryCatalogLineupAlternativeFacts is non-empty, use its concrete model names and RUB prices in the buyer-facing answer.',
        'When several catalog alternatives are present, name the best 1-3 by buyer relevance and price, then briefly group other relevant source-mentioned families from catalogLineupAlternativeGroups with RUB price floors; do not imply that the catalog contains only the models you named.'
      ],
      searchHints: [
        input.userMessage,
        input.plan.catalogSearchQuery,
        `${input.plan.catalogSearchQuery} official current product catalog`,
        `${input.plan.catalogSearchQuery} discontinued replacement successor`,
        `${input.plan.catalogSearchQuery} manual spare parts support used`
      ].filter(Boolean)
    };
  }

  return {
    mode: 'technical_factual_verification',
    question: input.userMessage,
    sourceCoverage: [
      'catalog data provided in context',
      'manufacturer documentation',
      'official service or parts documentation',
      'reputable dealer/marketplace price evidence when commercial facts are requested'
    ],
    inferenceRules: [
      'State a fact as confirmed only when the catalog or web evidence supports it.',
      'If evidence conflicts, say what is confirmed and what remains uncertain.',
      'If proof is missing, keep the known fact and mark the uncertain part as not confirmed.'
    ],
    answerRules: [
      'Do not show URLs, domains or markdown links.',
      'Answer the current buyer question directly; avoid generic handoff unless the fact cannot be responsibly answered.'
    ],
    searchHints: [
      input.userMessage,
      input.plan.catalogSearchQuery
    ].filter(Boolean)
  };
}

function webSearchContextSize(currentLineupStyle: boolean, detailedFactStyle: boolean, answerComplexityScore: number) {
  return currentLineupStyle || detailedFactStyle || answerComplexityScore >= 2 ? 'high' : 'medium';
}

function productLineupRole(product: Product) {
  const flags = classifyProduct(product);
  if (flags.isGenerator || flags.isWeldingGenerator) return 'generator';
  if (flags.isPlate) return 'plate';
  if (flags.isRammer) return 'rammer';
  if (flags.isRoller) return 'roller';
  if (flags.isCutter) return 'cutter';
  if (flags.isDiamondBlade) return 'diamondBlade';
  if (flags.isDiamondCore) return 'diamondCore';
  if (flags.isTrowel) return 'trowel';
  return 'unknown';
}

function isCoreLineupProduct(product: Product) {
  const flags = classifyProduct(product);
  if (flags.isGeneratorAccessory || flags.isGeneratorOil || flags.isEngineOil || flags.isPlateAccessory) return false;
  return productLineupRole(product) !== 'unknown';
}

function isSameLineupClass(anchor: Product, product: Product) {
  const anchorRole = productLineupRole(anchor);
  if (anchorRole === 'unknown') return false;
  return productLineupRole(product) === anchorRole;
}

function findLineupAnchorProduct(userMessage: string, state: CustomerNeedState, products: Product[]) {
  const profile = buildProductFitProfile(state, userMessage);
  return products.find((product) => isCoreLineupProduct(product) && productHasExactModel(product, profile)) ??
    products.find((product) => isCoreLineupProduct(product));
}

function catalogLineupAlternativesContext(products: Product[]) {
  return products.map((product) => ({
    id: product.id,
    name: product.name,
    family: productLineupFamily(product),
    applicationClass: productLineupApplicationClass(product),
    brand: product.brand,
    category: product.category,
    price: product.price,
    currency: product.currency ?? 'RUB',
    sourceUrl: product.sourceUrl
  }));
}

function productLineupFamily(product: Product) {
  const text = `${product.name} ${product.category}`;
  const match = text.match(/\b(APS|BPS|VP|WP|WPU|MP|DPU|DPS)\s*[-]?\s*\d*/i);
  return match ? match[1].toUpperCase() : 'unknown';
}

function productLineupApplicationClass(product: Product) {
  const text = `${product.name} ${product.category} ${product.description ?? ''}`.toLowerCase();
  const family = productLineupFamily(product);
  if (['WPU', 'DPU', 'DPS'].includes(family) || containsAny(text, ['реверсив', 'reversible'])) return 'reversible_or_heavier_class';
  if (family === 'APS' || containsAny(text, ['аккумулятор', 'battery', 'electric', 'электр'])) return 'battery_or_electric_class';
  if (containsAny(text, ['прямоход', 'single direction', 'single-direction'])) return 'single_direction_class';
  return 'same_broad_class';
}

type CatalogLineupAlternativeGroup = {
  family: string;
  applicationClass: string;
  count: number;
  minPrice: number | null;
  sampleNames: string[];
};

function catalogLineupAlternativeGroupsContext(products: Product[]) {
  const groups = new Map<string, CatalogLineupAlternativeGroup>();

  for (const product of products) {
    const family = productLineupFamily(product);
    const applicationClass = productLineupApplicationClass(product);
    const key = `${family}:${applicationClass}`;
    const existing: CatalogLineupAlternativeGroup = groups.get(key) ?? {
      family,
      applicationClass,
      count: 0,
      minPrice: null,
      sampleNames: []
    };
    existing.count += 1;
    if (typeof product.price === 'number') {
      existing.minPrice = existing.minPrice === null ? product.price : Math.min(existing.minPrice, product.price);
    }
    if (existing.sampleNames.length < 3) existing.sampleNames.push(product.name);
    groups.set(key, existing);
  }

  return [...groups.values()]
    .sort((a, b) => (a.minPrice ?? Number.MAX_SAFE_INTEGER) - (b.minPrice ?? Number.MAX_SAFE_INTEGER))
    .slice(0, 8);
}

function rubPrice(value?: number | null) {
  return typeof value === 'number'
    ? `${new Intl.NumberFormat('ru-RU').format(value)} ₽`
    : 'цена не указана';
}

function lineupFamilyFromText(value: string) {
  const match = value.match(/\b(APS|BPS|VP|WP|WPU|MP|DPU|DPS)\s*[-]?\s*\d*/i);
  return match ? match[1].toUpperCase() : 'unknown';
}

function productShortName(product: Product) {
  const brand = product.brand ? normalizeBrandKey(product.brand) : '';
  let name = product.name;
  if (brand && normalizeBrandKey(name).startsWith(brand)) {
    name = name.slice(product.brand?.length ?? 0).trim();
  }
  return name.replace(/\s+/g, ' ').trim();
}

function compactProductWithPrice(product: Product) {
  return `${productShortName(product)} - ${rubPrice(product.price)}`;
}

function mandatoryCatalogLineupAlternativeFacts(userMessage: string, products: Product[]) {
  if (!products.length) return '';

  const anchorFamily = lineupFamilyFromText(userMessage);
  const directDifferentFamily = products.filter((product) => {
    const family = productLineupFamily(product);
    const applicationClass = productLineupApplicationClass(product);
    return family !== anchorFamily && ['single_direction_class', 'same_broad_class'].includes(applicationClass);
  });
  const sameFamily = products.filter((product) => {
    const family = productLineupFamily(product);
    return anchorFamily !== 'unknown' && family === anchorFamily;
  });
  const familyGroups = catalogLineupAlternativeGroupsContext(products)
    .map((group) => {
      const classNote = group.applicationClass === 'reversible_or_heavier_class'
        ? 'реверсивная/другой класс'
        : group.applicationClass === 'battery_or_electric_class'
          ? 'аккумуляторная/электрическая'
          : 'прямоходная/близкий класс';
      return `${group.family}: от ${rubPrice(group.minPrice)} (${classNote})`;
    });

  const facts = [
    directDifferentFamily.length
      ? `Лучшие прямые альтернативы из каталога по другим текущим семействам: ${directDifferentFamily.slice(0, 3).map(compactProductWithPrice).join('; ')}.`
      : '',
    sameFamily.length
      ? `Позиции того же семейства, что и старая модель, есть в каталоге, но сами по себе не доказывают текущее заводское производство: ${sameFamily.slice(0, 2).map(compactProductWithPrice).join('; ')}.`
      : '',
    familyGroups.length
      ? `Семейства, которые тоже нашлись в каталоге: ${familyGroups.join('; ')}.`
      : ''
  ].filter(Boolean);

  return facts.join(' ');
}

function deterministicCatalogSliceAnswer(slice: StructuredCatalogSlice, cards: ProductCard[]) {
  if (slice.source === 'structured_constraints' || slice.source === 'full_catalog_slice') {
    const constraints = [
      slice.constraints.weightKgMin && slice.constraints.weightKgMax ? `${slice.constraints.weightKgMin}-${slice.constraints.weightKgMax} кг` : '',
      slice.constraints.diameterMmMin && slice.constraints.diameterMmMax ? `${slice.constraints.diameterMmMin}-${slice.constraints.diameterMmMax} мм` : '',
      slice.constraints.nominalPowerKwMin && slice.constraints.nominalPowerKwMax ? `${slice.constraints.nominalPowerKwMin}-${slice.constraints.nominalPowerKwMax} кВт` : '',
      slice.constraints.maxPowerKwMin && slice.constraints.maxPowerKwMax ? `${slice.constraints.maxPowerKwMin}-${slice.constraints.maxPowerKwMax} кВт максимум` : '',
      slice.constraints.budgetMax ? `до ${rubPrice(slice.constraints.budgetMax)}` : '',
      slice.constraints.brandConstraint || ''
    ].filter(Boolean);
    const range = constraints.length ? constraints.join(', ') : 'заданным критериям';
    const visible = cards.slice(0, slice.totalMatched > MAX_PRODUCT_CARDS ? LARGE_SLICE_VISIBLE_CARDS : MAX_PRODUCT_CARDS);
    const names = visible.map((card) => {
      const weight = parseLoosePositiveNumber(card.specs?.['масса, кг'] ?? card.specs?.['Масса, кг']) ?? undefined;
      return `${card.name}${weight ? ` (${weight} кг)` : ''}${card.price ? ` - ${rubPrice(card.price)}` : ''}`;
    });
    const intro = `В каталоге по диапазону ${range} нашлось ${slice.totalMatched} подходящ${slice.totalMatched === 1 ? 'ая позиция' : 'их позиций'}.`;
    const budgetMax = slice.constraints.budgetMax;
    const visibleWithinBudget = budgetMax
      ? visible.filter((card) => typeof card.price === 'number' && card.price <= budgetMax * 1.02).length
      : 0;
    const budgetVariantWord = visibleWithinBudget === 1 ? 'вариант' : visibleWithinBudget >= 2 && visibleWithinBudget <= 4 ? 'варианта' : 'вариантов';
    const finalIntro = budgetMax && visible.length && visibleWithinBudget < visible.length
      ? visibleWithinBudget > 0
        ? `В бюджет до ${rubPrice(budgetMax)} проходит ${visibleWithinBudget} ${budgetVariantWord}; остальные карточки показываю как ближайшие компромиссы.`
        : `Точных карточек в бюджет до ${rubPrice(budgetMax)} не вижу; показываю ближайшие компромиссы.`
      : intro;
    const list = names.length ? `Показываю ${names.length}: ${names.join('; ')}.` : '';
    const productIntent = slice.constraints.productIntent;
    const tail = productIntent === 'generator'
      ? slice.totalMatched > visible.length
        ? 'Остальные подходящие варианты оставляю за кнопкой "Показать еще". Для финального выбора по генератору уточните, что важнее: запас мощности, тип запуска, шум или цена.'
        : 'Для финального выбора по генератору уточните, есть ли жесткие требования по запуску, шуму, весу и запасу мощности.'
      : productIntent === 'plate'
        ? slice.totalMatched > MAX_PRODUCT_CARDS
          ? 'Остальные подходящие варианты оставляю за кнопкой "Показать еще". Чтобы сузить выбор, уточните: нужна прямоходная плита для небольших работ или реверсивная для более плотного грунта и объема?'
          : 'Чтобы точнее выбрать из них, уточните: чаще будете работать по песку/щебню или по асфальту?'
        : slice.totalMatched > MAX_PRODUCT_CARDS
          ? 'Остальные подходящие варианты оставляю за кнопкой "Показать еще".'
          : 'Чтобы точнее выбрать из них, уточните главное ограничение: цена, габариты или режим работы?';
    return [finalIntro, list, tail].filter(Boolean).join('\n\n');
  }

  const exact = (slice.exactCatalogMatches ?? slice.products).slice(0, 10);
  if (exact.length) {
    const lines = exact.map((product) => {
      const kind = isCoreEquipment(product) ? 'товар' : 'позиция/расходник';
      const weight = extractWeightKg(product);
      return `${product.name}${weight ? ` (${weight} кг)` : ''}${product.price ? ` - ${rubPrice(product.price)}` : ''}: ${kind}`;
    });
    return `Проверил по каталогу: по указанным моделям нашлись такие позиции.\n\n${lines.join('; ')}.\n\nЕсли это расходник, он подтверждает привязку к модели, но не заменяет карточку самой плиты.`;
  }

  return '';
}

function recoveredSelectionIntentLabel(intent: ProductSelectionClass | 'commercial' | undefined) {
  if (intent === 'plate') return 'виброплите';
  if (intent === 'generator') return 'генератору';
  if (intent === 'cutter') return 'резчику';
  if (intent === 'diamondBlade') return 'диску';
  if (intent === 'rammer') return 'трамбовке';
  if (intent === 'roller') return 'катку';
  return 'товару';
}

function recoveredSelectionCardLine(card: ProductCard, intent: ProductSelectionClass | 'commercial' | undefined) {
  const product = productFromCard(card);
  const facts: string[] = [];
  const weight = extractWeightKg(product);
  const power = extractGeneratorPower(product);
  const diameter = extractDimensionMm(product);
  if (intent === 'plate' || intent === 'rammer' || intent === 'roller') {
    if (weight) facts.push(`${roundNumber(weight, 0)} кг`);
  } else if (intent === 'generator') {
    if (power.nominalKw) facts.push(`${roundNumber(power.nominalKw, 1)} кВт ном.`);
    if (power.maxKw) facts.push(`${roundNumber(power.maxKw, 1)} кВт макс.`);
  } else if (intent === 'cutter' || intent === 'diamondBlade') {
    if (diameter) facts.push(`${roundNumber(diameter, 0)} мм`);
  }
  return `${card.name}${facts.length ? ` (${facts.join(', ')})` : ''}${card.price ? ` - ${rubPrice(card.price)}` : ''}`;
}

function deterministicRecoveredSelectionAnswer(input: {
  contract: AgentTurnContract;
  cards: ProductCard[];
  state: CustomerNeedState;
  latestUserMessage: string;
}) {
  if (!input.cards.length || input.contract.cardsRole === 'none') return '';
  const selectionState = input.state.selectionState ?? emptyProductSelectionState();
  const intent = selectionState.targetProductClass !== 'unknown'
    ? selectionState.targetProductClass
    : input.contract.activeNeeds.find((need) => need.productClass !== 'commercial')?.productClass;
  const hard = selectionState.hardConstraints ?? emptyProductSelectionState().hardConstraints;
  const label = recoveredSelectionIntentLabel(intent);
  const visible = input.cards.slice(0, Math.min(input.cards.length, LARGE_SLICE_VISIBLE_CARDS));
  const named = visible.slice(0, 2).map((card) => recoveredSelectionCardLine(card, intent)).join('; ');
  const lines: string[] = [];

  if (intent === 'plate' && (hard.weightKgMin || hard.weightKgMax)) {
    const midpoint = hard.weightKgMin && hard.weightKgMax
      ? roundNumber((hard.weightKgMin + hard.weightKgMax) / 2, 0)
      : hard.weightKgMin ?? hard.weightKgMax;
    lines.push(midpoint
      ? `По запросу около ${midpoint} кг показываю ближайшие тяжелые варианты из каталога. Для точного выбора нужно смотреть тип работ и основание: тяжелая реверсивная плита не всегда заменяет каток.`
      : 'Показываю ближайшие тяжелые варианты из каталога. Для точного выбора нужно смотреть тип работ и основание: тяжелая реверсивная плита не всегда заменяет каток.');
  } else if (intent === 'generator' && (hard.nominalPowerKwMin || hard.nominalPowerKwMax || hard.maxPowerKwMin || hard.maxPowerKwMax)) {
    const nominalMin = hard.nominalPowerKwMin ?? hard.maxPowerKwMin;
    const nominalMax = hard.nominalPowerKwMax ?? hard.maxPowerKwMax;
    const powerRange = nominalMin && nominalMax
      ? nominalMin === nominalMax ? `${roundNumber(nominalMin, 1)} кВт` : `${roundNumber(nominalMin, 1)}-${roundNumber(nominalMax, 1)} кВт`
      : nominalMin ? `от ${roundNumber(nominalMin, 1)} кВт` : `до ${roundNumber(nominalMax, 1)} кВт`;
    lines.push(`По запросу ${powerRange} показываю ближайшие варианты из каталога. Смотрите номинал, максимум, фазность и запас под пусковые нагрузки.`);
  } else if ((intent === 'cutter' || intent === 'diamondBlade') && (hard.diameterMmMin || hard.diameterMmMax)) {
    const diameterMin = hard.diameterMmMin ?? hard.diameterMmMax;
    const diameterMax = hard.diameterMmMax ?? hard.diameterMmMin;
    const diameterRange = diameterMin && diameterMax
      ? diameterMin === diameterMax ? `${roundNumber(diameterMin, 0)} мм` : `${roundNumber(diameterMin, 0)}-${roundNumber(diameterMax, 0)} мм`
      : `${roundNumber(diameterMin ?? diameterMax, 0)} мм`;
    lines.push(`По диску ${diameterRange} показываю ближайшие варианты из каталога. Важно сверить посадку, глубину реза и тип материала.`);
  } else {
    lines.push(`Продолжаю подбор по ${label}: показываю ближайшие варианты из каталога.`);
  }

  if (named) {
    lines.push(`В первых карточках: ${named}.`);
  }
  if (input.cards.length > visible.length) {
    lines.push('Остальные подходящие позиции оставил за кнопкой "Показать еще".');
  }
  if (input.contract.commercialAction === 'explain_manager_required' && isExplicitCommercialQuestion(input.latestUserMessage)) {
    lines.push('По наличию и доставке точные условия нужно сверить отдельно: каталог показывает подходящие позиции, но не обещает live-остаток, стоимость доставки или сроки.');
  }
  return lines.join('\n\n');
}

function productFromCard(card: ProductCard): Product {
  return {
    id: card.id,
    name: card.name,
    brand: card.brand,
    category: card.category,
    price: card.price,
    currency: card.currency,
    imageUrl: card.imageUrl,
    sourceUrl: card.sourceUrl,
    specs: card.specs ?? {},
    description: null
  };
}

function lastShownProductCards(history: Message[]) {
  for (const message of [...history].reverse()) {
    if (message.role !== 'assistant') continue;
    const cards = (message.metadata as { productCards?: unknown })?.productCards;
    if (!Array.isArray(cards) || cards.length === 0) continue;
    return cards
      .filter((card): card is ProductCard => Boolean(card && typeof card === 'object' && typeof (card as ProductCard).id === 'string' && typeof (card as ProductCard).name === 'string'))
      .map((card) => productFromCard(card));
  }
  return [];
}

function lastVisibleShownProductCards(history: Message[]) {
  for (const message of [...history].reverse()) {
    if (message.role !== 'assistant') continue;
    const metadata = message.metadata as { productCards?: unknown; cardDisplay?: { initialVisibleCount?: unknown } } | undefined;
    const cards = metadata?.productCards;
    if (!Array.isArray(cards) || cards.length === 0) continue;
    const initialVisibleCount = Number(metadata?.cardDisplay?.initialVisibleCount);
    const visibleCount = Number.isFinite(initialVisibleCount) && initialVisibleCount > 0
      ? Math.min(cards.length, Math.max(1, Math.floor(initialVisibleCount)))
      : cards.length;
    return cards
      .slice(0, visibleCount)
      .filter((card): card is ProductCard => Boolean(card && typeof card === 'object' && typeof (card as ProductCard).id === 'string' && typeof (card as ProductCard).name === 'string'))
      .map((card) => productFromCard(card));
  }
  return [];
}

function allShownProductCards(history: Message[]) {
  const byId = new Map<string, ProductCard>();
  for (const message of history) {
    if (message.role !== 'assistant') continue;
    const cards = (message.metadata as { productCards?: unknown })?.productCards;
    if (!Array.isArray(cards) || cards.length === 0) continue;
    for (const card of cards) {
      if (card && typeof card === 'object' && typeof (card as ProductCard).id === 'string' && typeof (card as ProductCard).name === 'string') {
        byId.set((card as ProductCard).id, card as ProductCard);
      }
    }
  }
  return [...byId.values()];
}

function recentConversationText(history: Message[], maxMessages = 10) {
  return history.slice(-maxMessages).map((message) => message.content).filter(Boolean).join(' ');
}

function recentUserConversationText(history: Message[], maxMessages = 10) {
  return history
    .slice(-maxMessages)
    .filter((message) => message.role === 'user')
    .map((message) => message.content)
    .filter(Boolean)
    .join(' ');
}

function mergeProductsById(products: Product[], extraProducts: Product[]) {
  const byId = new Map<string, Product>();
  for (const product of [...products, ...extraProducts]) byId.set(product.id, product);
  return [...byId.values()];
}

function uniqueList(values: Array<string | undefined | null>, limit: number) {
  return [...new Set(values.map((value) => String(value ?? '').trim()).filter(Boolean))].slice(0, limit);
}

function knownProductIntent(value: ProductIntent | undefined | null): value is ProductIntent {
  return Boolean(value && value !== 'unknown');
}

function activeProductIntentsForSelectionState(state: ProductSelectionState) {
  return new Set([
    state.targetProductClass as ProductIntent,
    state.currentProductClass as ProductIntent,
    state.hardConstraints.productIntent as ProductIntent,
    state.activeRequirement?.productIntent as ProductIntent | undefined
  ].filter(knownProductIntent));
}

function removeActiveIntentExclusions(excludedClasses: ProductIntent[] | undefined, activeIntents: Set<ProductIntent>) {
  if (!activeIntents.size) return uniqueList(excludedClasses ?? [], 24) as ProductIntent[];
  return uniqueList((excludedClasses ?? []).filter((intent) => !activeIntents.has(intent)), 24) as ProductIntent[];
}

function sanitizeCriteriaSelfExclusions(criteria: ProductSelectionCriteria, activeIntents: Set<ProductIntent>): ProductSelectionCriteria {
  const excludedClasses = removeActiveIntentExclusions(criteria.excludedClasses as ProductIntent[], activeIntents);
  return excludedClasses.length === criteria.excludedClasses.length
    ? criteria
    : { ...criteria, excludedClasses };
}

function sanitizeSelfExcludingSelectionState(state: ProductSelectionState): ProductSelectionState {
  const activeIntents = activeProductIntentsForSelectionState(state);
  if (!activeIntents.size) return state;
  return {
    ...state,
    hardConstraints: sanitizeCriteriaSelfExclusions(state.hardConstraints, activeIntents),
    softPreferences: sanitizeCriteriaSelfExclusions(state.softPreferences, activeIntents),
    activeRequirement: state.activeRequirement
      ? sanitizeCriteriaSelfExclusions(state.activeRequirement, activeIntents)
      : state.activeRequirement
  };
}

function effectiveExcludedClassesForState(state: ProductSelectionState) {
  return removeActiveIntentExclusions(
    state.hardConstraints.excludedClasses as ProductIntent[],
    activeProductIntentsForSelectionState(state)
  );
}

function productIntentFromSelection(state: ProductSelectionState, plan: AssistantTurnPlan, profile: ProductFitProfile): ProductIntent {
  if (plan.requiredProductTraits.productIntent !== 'unknown') return plan.requiredProductTraits.productIntent;
  if (profile.intent !== 'unknown') return profile.intent;
  if (plan.selectionState.targetProductClass !== 'unknown') return plan.selectionState.targetProductClass;
  if (state.targetProductClass !== 'unknown') return state.targetProductClass as ProductIntent;
  if (state.hardConstraints.productIntent !== 'unknown') return state.hardConstraints.productIntent as ProductIntent;
  if (plannerHasSemanticSelection(plan)) return 'unknown';
  return 'unknown';
}

function rankingPreferenceFromText(text: string): ProductRankingPreference | undefined {
  if (/(?:сам(?:ый|ая|ое|ые)\s+дешев|дешевле|подешевле|бюджетн|минимальн\w*\s+цен|cheapest|lowest\s+price|budget)/iu.test(text)) return 'cheapest';
  if (/(?:премиум|лучше(?:е|ий)?\b|сам(?:ый|ая|ое)\s+лучш|дороже\b|premium|best)/iu.test(text)) return 'premium';
  if (/(?:оптимальн|сбаланс|по\s+соотношению|balanced|value)/iu.test(text)) return 'balanced';
  return undefined;
}

function isSmallSitePlateNeed(text: string) {
  const normalized = text.toLowerCase();
  const smallSite = /(?:участк|участок|дач|сад|дорож|тротуар|плитк|пешеход|частн|двор|гараж|path|garden|yard|sidewalk)/iu.test(normalized);
  return smallSite && !isHeavyDutyPlateNeed(text);
}

function isHeavyDutyPlateNeed(text: string) {
  const normalized = text.toLowerCase().replace(/\s+/g, ' ');
  const professionalActor = /(?:бригад|бизнес|коммерческ|проф(?:ессиональн)?|под\s+ключ|объект|ежеднев|аренд|industrial|professional|crew)/iu.test(normalized);
  const heavySurface = /(?:парковк|стоянк|заезд|дорог|проезд|щеб[её]н|щебень\s*20\s*[-–—]?\s*40|пгс|грави|основан|road\s*base|parking|driveway)/iu.test(normalized);
  const thickLayer = /(?:слой|слоя|толщин)[^.!?\n]{0,40}(?:1[5-9]|2[0-9]|3[0-9])\s*(?:см|cm)|(?:1[5-9]|2[0-9]|3[0-9])\s*(?:см|cm)[^.!?\n]{0,40}(?:слой|щеб|основан)/iu.test(normalized);
  const largeArea = /(?:\d{3,4}\s*(?:[-–—]\s*)?\d{0,4}\s*(?:м2|м²|квадрат|кв\.?\s*м)|площад[ьи]\s+[^.!?\n]{0,50}\d{3,4})/iu.test(normalized);
  const rollerContext = /(?:каток|без\s+катка|каток\s+не\s+всегда|roller)/iu.test(normalized);
  const heavyClassWords = /(?:реверсив|тяж[её]л|центробеж|кн\b|кН\b|уплотн[а-яё]*\s+щеб|больш[а-яё]+\s+объем|котлован|транше|reversible|heavy\s*duty)/iu.test(normalized);
  const transportAllowsHeavy = /(?:газел|аппарел|рамп|погрузчик|минипогруз|до\s*(?:2[0-9]{2}|3[0-9]{2})\s*кг)/iu.test(normalized);

  const score = [
    professionalActor,
    heavySurface,
    thickLayer,
    largeArea,
    rollerContext,
    heavyClassWords,
    transportAllowsHeavy
  ].filter(Boolean).length;

  return score >= 2 || (professionalActor && heavySurface) || (thickLayer && heavySurface) || (largeArea && heavySurface);
}

function implicitPlateWeightRangeFromNeed(text: string, intent: ProductIntent) {
  if (intent !== 'plate') return undefined;
  if (isHeavyDutyPlateNeed(text)) return { min: 120, max: 350 };
  if (isSmallSitePlateNeed(text)) return { min: 0, max: 120 };
  return undefined;
}

function isRankingOnlyFollowUp(text: string) {
  const hasRanking = Boolean(rankingPreferenceFromText(text));
  if (!hasRanking) return false;
  return !parseDesiredPowerRange(text) &&
    !parseWeightNeedRangeKg(text) &&
    !parseDimensionNeedRangeMm(text) &&
    !parseBudgetMax(text) &&
    inferProductIntent(text) === 'unknown';
}

function isProductCardSelectionFollowUp(text: string) {
  const normalized = text.toLowerCase();
  const referencesShownCards = /(?:из\s+(?:этих|показанн|карточек)|карточк|подборк|вариант|показать\s+ещ[её]|show\s+more)/iu.test(normalized);
  const asksToChoose = /(?:выбер|выбери|подбери|оставь|оставить|какой\s+(?:брать|лучше|основн)|основн|запасн|резервн|main|backup|primary|reserve)/iu.test(normalized);
  const asksNoNewNeed = inferProductIntent(text) === 'unknown' &&
    !parseDesiredPowerRange(text) &&
    !parseWeightNeedRangeKg(text) &&
    !parseDimensionNeedRangeMm(text) &&
    !parseBudgetMax(text);
  return referencesShownCards && asksToChoose && asksNoNewNeed;
}

function hasExplicitPowerText(text: string) {
  return Boolean(parseDesiredPowerRange(text) || text.match(powerRegex));
}

function explicitSinglePowerKwConstraint(text: string) {
  if (parseDesiredPowerRange(text)) return undefined;
  if (/(?:около|примерн|порядк|ориентир|плюс\s*-?\s*минус|~|\bдо\s+\d|\bот\s+\d|\bfrom\s+\d[\d,.]*\s+to\s+\d|\bbetween\s+\d[\d,.]*\s+and\s+\d)/iu.test(text)) return undefined;
  return singlePowerKwFromText(text);
}

function explicitGeneratorPowerRequestKw(text: string) {
  const after = text.match(/(?:генератор|бензогенератор|электростанц)[^.!?\n]{0,80}?(\d+(?:[,.]\d+)?)\s*(кВт|kw|kva|ква)/iu);
  const before = text.match(/(\d+(?:[,.]\d+)?)\s*(кВт|kw|kva|ква)[^.!?\n]{0,80}?(?:генератор|бензогенератор|электростанц)/iu);
  return parseLoadPowerAmount(after?.[1] ?? before?.[1], after?.[2] ?? before?.[2]);
}

function plannerPowerRangeBroadensExplicitSinglePower(userMessage: string, range?: GeneratorPowerProfile) {
  const exactKw = explicitSinglePowerKwConstraint(userMessage);
  if (!exactKw || !range) return undefined;
  const nominalMin = range.nominalMin;
  const nominalMax = range.nominalMax;
  if (!nominalMin || !nominalMax) return undefined;
  const width = Math.abs(nominalMax - nominalMin);
  if (width <= 0.3) return undefined;
  if (exactKw < Math.min(nominalMin, nominalMax) || exactKw > Math.max(nominalMin, nominalMax)) return undefined;
  return exactKw;
}

function plannerConventionalGeneratorConstraintHasEvidence(value: boolean, userMessage: string, plan: AssistantTurnPlan, currentHard: ProductSelectionCriteria) {
  if (currentHard.conventionalGenerator === value &&
    (currentHard.provenance?.conventionalGenerator === 'explicit_user' || currentHard.provenance?.conventionalGenerator === 'previous_selection')) {
    return true;
  }
  const evidenceText = [
    userMessage,
    plan.catalogSearchQuery,
    plan.selectionState.mustHaveTraits.join(' '),
    plan.selectionState.niceToHaveTraits.join(' '),
    plan.requiredProductTraits.powerReasoning
  ].filter(Boolean).join(' ');
  return value
    ? hasConventionalGeneratorSignal(evidenceText)
    : containsAny(evidenceText, inverterTerms) && !isTermExplanationQuestion(evidenceText);
}

function hasCompatibilityTargetContext(text: string) {
  return /(?:кот[её]л|boiler|baxi|насос|pump|холодильник|fridge|инструмент|tool|двигател|engine|артикул\s+\S+)/iu.test(text);
}

function isTermExplanationQuestion(text: string) {
  return /(?:что\s+это|что\s+такое|чем\s+отлича|объясн|расскаж|нужен\s+ли)/iu.test(text);
}

function hasConventionalGeneratorSignal(text: string) {
  return /(?:обычн\w*\s+(?:генератор|бензогенератор|электростанц)|(?:генератор|бензогенератор|электростанц)\s+обычн|не\s+инвертор|без\s+инвертор|conventional|not\s+inverter)/iu.test(text);
}

function hasHomeSinglePhaseLoadContext(text: string) {
  return /(?:дом|дач|квартир|кот[её]л|холодильник|свет|освещен|телевизор|роутер|насос|boiler|fridge|home|house)/iu.test(text) &&
    !/(?:380\s*(?:в|v)|тр[её]хфаз|3\s*фаз|three[-\s]?phase)/iu.test(text);
}

function compatibilityTargetFromText(text: string): ProductSelectionState['compatibilityTargetProduct'] | undefined {
  if (!hasCompatibilityTargetContext(text)) return undefined;
  const article = text.match(/(?:артикул|article|part\s*no\.?)\s*([A-Za-zА-Яа-я0-9-]{4,})/iu)?.[1];
  const baxi = text.match(/\b(Baxi\s+[A-Za-zА-Яа-я0-9\s-]{2,40})/iu)?.[1]?.trim();
  const boiler = /кот[её]л|boiler|baxi/iu.test(text);
  const pump = /насос|pump/iu.test(text) && !hasNegatedPumpLoad(text);
  if (!boiler && !pump && !article && !baxi) return undefined;
  return {
    name: baxi,
    article,
    kind: boiler ? 'boiler' : pump ? 'pump' : 'load',
    evidence: text
  };
}

function plannerBrandBelongsToCompatibilityTarget(
  brand: string,
  compatibilityTarget: ProductSelectionState['compatibilityTargetProduct'] | undefined,
  targetProductClass: ProductIntent
) {
  const brandKey = normalizeBrandKey(brand);
  if (brandKey.length < 3 || !compatibilityTarget || targetProductClass === 'unknown') return false;
  const targetText = compactModelText([
    compatibilityTarget.name,
    compatibilityTarget.article,
    compatibilityTarget.evidence,
    compatibilityTarget.kind
  ].filter(Boolean).join(' '));
  return targetText.includes(brandKey);
}

function userExplicitlyRequestedBrand(text: string, brand: string) {
  const brandKey = normalizeBrandKey(brand);
  if (brandKey.length < 3) return false;
  return compactModelText(text).includes(brandKey);
}

function mergeCompatibilityTarget(
  current: ProductSelectionState['compatibilityTargetProduct'] | undefined,
  update: ProductSelectionState['compatibilityTargetProduct'] | undefined
) {
  if (!update) return current;
  return {
    kind: update.kind ?? current?.kind,
    name: update.name ?? current?.name,
    article: update.article ?? current?.article,
    evidence: update.evidence ?? current?.evidence
  };
}

function roundPowerKw(value: number, step = 0.1) {
  return Math.round(value / step) * step;
}

function ceilPowerKw(value: number, step = 0.5) {
  return Math.ceil(value / step) * step;
}

function applianceCount(text: string, singular: RegExp, plural: RegExp) {
  const digit = text.match(new RegExp(String.raw`(\d+)\s*(?:${plural.source}|${singular.source})`, 'iu'));
  if (digit) return Number(digit[1]);
  if (/(?:два|две)\s+/iu.test(text) && (singular.test(text) || plural.test(text))) return 2;
  if (/(?:три)\s+/iu.test(text) && (singular.test(text) || plural.test(text))) return 3;
  return singular.test(text) || plural.test(text) ? 1 : 0;
}

function explicitKwNear(text: string, terms: RegExp) {
  const before = text.match(new RegExp(String.raw`(\d+(?:[,.]\d+)?)\s*(?:квт|kw)[^.!?\n]{0,80}${terms.source}`, 'iu'));
  const after = text.match(new RegExp(String.raw`${terms.source}[^.!?\n]{0,80}(\d+(?:[,.]\d+)?)\s*(?:квт|kw)`, 'iu'));
  const value = before?.[1] ?? after?.[1];
  if (!value) return undefined;
  const parsed = Number(value.replace(',', '.'));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function parseLoadPowerAmount(value: string | undefined, unit: string | undefined) {
  if (!value) return undefined;
  const parsed = Number(value.replace(',', '.'));
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  const normalizedUnit = compactModelText(unit ?? '');
  return normalizedUnit === 'w' || normalizedUnit === 'вт'
    ? roundPowerKw(parsed / 1000)
    : parsed;
}

function explicitAggregateLoadKwFromText(text: string) {
  const normalized = text.replace(/\s+/g, ' ');
  const loadContext = /(?:суммарн[\p{L}]*\s+(?:мощност|нагрузк)|общ[\p{L}]*\s+(?:мощност|нагрузк)|нагрузк[\p{L}]*|все\s+работающ[\p{L}]*\s+прибор|все\s+прибор[\p{L}]*|одновременно\s+работающ[\p{L}]*)/iu;
  const unit = String.raw`(?:кВт|kw|kva|ква|кВ)`;
  const after = normalized.match(new RegExp(String.raw`${loadContext.source}[^.!?\n]{0,90}?(\d+(?:[,.]\d+)?)\s*(${unit})`, 'iu'));
  const before = normalized.match(new RegExp(String.raw`(\d+(?:[,.]\d+)?)\s*(${unit})[^.!?\n]{0,90}?${loadContext.source}`, 'iu'));
  const value = parseLoadPowerAmount(after?.[1] ?? before?.[1], after?.[2] ?? before?.[2]);
  if (!value || value < 1) return undefined;
  return value;
}

function explicitLoadKwNear(text: string, terms: RegExp) {
  const after = text.match(new RegExp(String.raw`${terms.source}[^.!?,;\n]{0,50}?(\d+(?:[,.]\d+)?)\s*(кВт|kw|Вт|w)`, 'iu'));
  const afterValue = parseLoadPowerAmount(after?.[1], after?.[2]);
  if (afterValue) return afterValue;
  const before = text.match(new RegExp(String.raw`(\d+(?:[,.]\d+)?)\s*(кВт|kw|Вт|w)[^.!?,;\n]{0,25}${terms.source}`, 'iu'));
  return parseLoadPowerAmount(before?.[1], before?.[2]);
}

function explicitLoadKwNearOwnMention(text: string, terms: RegExp, competingTerms: RegExp) {
  const after = text.match(new RegExp(String.raw`${terms.source}([^.!?,;\n]{0,35}?)(\d+(?:[,.]\d+)?)\s*(кВт|kw|Вт|w)`, 'iu'));
  if (after && !competingTerms.test(after[1] ?? '')) return parseLoadPowerAmount(after[2], after[3]);
  const before = text.match(new RegExp(String.raw`(\d+(?:[,.]\d+)?)\s*(кВт|kw|Вт|w)([^.!?,;\n]{0,25})${terms.source}`, 'iu'));
  if (before && !competingTerms.test(before[3] ?? '')) return parseLoadPowerAmount(before[1], before[2]);
  return undefined;
}

function pumpRunningKwEstimate(text: string) {
  const type = pumpTypeFromText(text);
  if (type === 'borehole') return 1.1;
  if (type === 'circulation') return 0.12;
  if (type === 'drainage') return 0.75;
  return 0.8;
}

function ruChars(...codes: number[]) {
  return String.fromCharCode(...codes);
}

function hasTextTerm(text: string, terms: string[]) {
  const lower = text.toLowerCase();
  return terms.some((term) => lower.includes(term));
}

function pumpTypeFromText(text: string) {
  if (hasTextTerm(text, [
    ruChars(1089, 1082, 1074, 1072, 1078, 1080, 1085),
    ruChars(1075, 1083, 1091, 1073, 1080, 1085),
    ruChars(1087, 1086, 1075, 1088, 1091, 1078, 1085),
    'borehole',
    'well pump',
    'submersible'
  ])) return 'borehole';
  if (hasTextTerm(text, [
    ruChars(1087, 1086, 1074, 1077, 1088, 1093, 1085, 1086, 1089, 1090),
    ruChars(1085, 1072, 1089, 1086, 1089, 1085),
    'surface pump',
    'booster'
  ])) return 'surface';
  if (hasTextTerm(text, [
    ruChars(1094, 1080, 1088, 1082, 1091, 1083),
    ruChars(1086, 1090, 1086, 1087),
    'circulation'
  ])) return 'circulation';
  if (hasTextTerm(text, [
    ruChars(1076, 1088, 1077, 1085, 1072, 1078),
    ruChars(1092, 1077, 1082, 1072, 1083),
    'sewage',
    'drainage'
  ])) return 'drainage';
  return 'generic';
}

function pumpNameFromType(type: string) {
  if (type === 'borehole') return 'borehole pump';
  if (type === 'surface') return 'surface pump';
  if (type === 'circulation') return 'circulation pump';
  if (type === 'drainage') return 'drainage pump';
  return 'pump';
}

function pumpStartingKwEstimate(runningKw: number) {
  return roundPowerKw(Math.max(runningKw * 2.6, runningKw + 1.2));
}

function loadItemKey(item: ProductElectricalLoadItem) {
  return `${item.kind}:${item.name ?? ''}`;
}

function loadKindsForReferenceId(id: string, loadClass: string) {
  if (loadClass === 'handheld_tool_load') return ['handheld_tool', 'tool'];
  if (loadClass === 'heating_resistive_load') return ['heating_resistive'];
  if (id === 'submersible_pump' || id === 'surface_pump') return ['pump'];
  if (id === 'refrigerator') return ['refrigerator'];
  if (id === 'freezer') return ['freezer'];
  if (id === 'air_compressor') return ['compressor'];
  if (id === 'pressure_washer') return ['pressure_washer'];
  if (id === 'construction_vacuum') return ['vacuum'];
  if (id === 'concrete_mixer') return ['concrete_mixer'];
  return [];
}

function stagedLoadKindsFromText(text: string) {
  const stagedKinds = new Set<string>();
  for (const detection of classifyGeneratorLoadText(text)) {
    if (detection.role !== 'staged') continue;
    for (const kind of loadKindsForReferenceId(detection.reference.id, detection.reference.loadClass)) {
      stagedKinds.add(canonicalElectricalLoadKind(kind));
    }
  }
  if (hasOccasionalHandheldToolUse(text)) stagedKinds.add('handheld_tool');
  return stagedKinds;
}

function hasGeneratorLoadReferenceSignal(text: string) {
  return hasOccasionalHandheldToolUse(text) ||
    classifyGeneratorLoadText(text).some((item) => item.role === 'active' || item.role === 'staged');
}

function hasOccasionalHandheldToolUse(text: string) {
  return text.split(/[.!?;\n]+/).some((clause) =>
    /(?:иногда|периодически|время\s+от\s+времени|по\s+необходимости|occasionally|sometimes|from\s+time\s+to\s+time|as\s+needed)/iu.test(clause) &&
    /(?:инструмент|электроинструмент|болгарк|ушм|дрел|перфоратор|пил[ауые]?|tool|grinder|drill|saw)/iu.test(clause) &&
    !/(?:одновременно|вместе|разом|сразу|simultaneously|together)/iu.test(clause)
  );
}

function calculateGeneratorLoadProfile(
  items: ProductElectricalLoadItem[],
  simultaneousStarting = false,
  simultaneousStartingKinds: string[] = []
): ProductGeneratorLoadProfile | undefined {
  return calculateStructuredGeneratorLoadProfile(items, {
    simultaneousStarting,
    simultaneousStartingKinds
  });
}

function inferredLoadPowerWindow(requiredNominalKw: number) {
  const maxStep = requiredNominalKw <= 2.5
    ? 2
    : requiredNominalKw <= 4
      ? 1
      : requiredNominalKw <= 5.5
        ? 0.8
        : 1;
  return {
    min: requiredNominalKw,
    max: Math.round((requiredNominalKw + maxStep) * 10) / 10
  };
}

function hasAffirmativeSimultaneousStarting(text: string) {
  const simultaneous = /(?:одновременно|вместе|разом|сразу)/iu.test(text);
  if (!simultaneous) return false;
  const nonSimultaneous = /(?:не\s+(?:буду|планирую|собираюсь|нужно|надо)?[^.!?;\n]{0,90}(?:одновременно|вместе|разом|сразу)|(?:одновременно|вместе|разом|сразу)[^.!?;\n]{0,90}не\s+(?:буду|планирую|собираюсь|нужно|надо)?|(?:по\s+очереди|отдельно|не\s+в\s+один\s+момент))/iu.test(text);
  return !nonSimultaneous;
}

function generatorLoadProfileFromText(text: string, current?: ProductGeneratorLoadProfile, compatibilityTarget?: ProductSelectionState['compatibilityTargetProduct']) {
  const lower = text.toLowerCase();
  const aggregateLoadKw = explicitAggregateLoadKwFromText(text);
  const simultaneousStarting = hasAffirmativeSimultaneousStarting(text);
  if (aggregateLoadKw) {
    const profile = calculateGeneratorLoadProfile([{
      kind: 'aggregate_load',
      name: 'суммарная нагрузка',
      count: 1,
      runningKw: aggregateLoadKw,
      startingKw: aggregateLoadKw,
      source: 'explicit_user',
      evidence: text
    }], simultaneousStarting || current?.simultaneousStarting === true);
    if (profile) {
      profile.removedKinds = [...new Set((current?.items ?? []).map((item) => item.kind))];
      profile.confidence = 0.9;
      profile.calculation = `суммарная нагрузка: ${aggregateLoadKw} kW run / ${aggregateLoadKw} kW start`;
    }
    return profile;
  }
  const items = new Map<string, ProductElectricalLoadItem>();
  for (const item of current?.items ?? []) items.set(loadItemKey(item), item);
  for (const item of generatorReferenceLoadItemsFromText(text)) {
    const key = loadItemKey(item);
    if (!items.has(key)) items.set(key, item);
  }
  const stagedKinds = stagedLoadKindsFromText(text);
  if (stagedKinds.size) {
    for (const [key, item] of [...items.entries()]) {
      if (stagedKinds.has(canonicalElectricalLoadKind(item.kind))) items.delete(key);
    }
  }

  const detectedFridgeCount = applianceCount(lower, /холодильник|fridge/iu, /холодильник[а-я]*|fridges/iu);
  const previousFridge = items.get('refrigerator:холодильник') ?? [...items.values()].find((item) => item.kind === 'refrigerator');
  const pluralFridgeMention = /(?:холодильники|fridges)/iu.test(lower);
  const fridgeCount = detectedFridgeCount === 1 && previousFridge?.count
    ? previousFridge.count
    : detectedFridgeCount === 1 && pluralFridgeMention
      ? 2
      : detectedFridgeCount;
  if (fridgeCount) {
    const explicit = explicitLoadKwNearOwnMention(text, /(?:холодильник|fridge)/iu, /(?:свет|освещ|ламп|насос|pump|кот[её]л|boiler|инструмент|tool|чайник|kettle)/iu);
    const runningKw = explicit ?? 0.15;
    const item: ProductElectricalLoadItem = {
      kind: 'refrigerator',
      name: 'холодильник',
      count: fridgeCount,
      runningKw,
      startingKw: explicit ? Math.max(roundPowerKw(explicit * 3), roundPowerKw(explicit + 0.5)) : 1,
      source: explicit ? 'explicit_user' : 'estimated_average',
      evidence: text
    };
    items.set(loadItemKey(item), item);
  }

  if (/(?:свет|освещен|ламп)/iu.test(lower)) {
    const explicit = explicitLoadKwNear(text, /(?:свет|освещен|ламп)/iu);
    const item: ProductElectricalLoadItem = {
      kind: 'lighting',
      name: 'свет',
      count: 1,
      runningKw: explicit ?? 0.2,
      startingKw: explicit ?? 0.2,
      source: explicit ? 'explicit_user' : 'estimated_average',
      evidence: text
    };
    items.set(loadItemKey(item), item);
  }

  if (/(?:кот[её]л|boiler|baxi)/iu.test(lower) || compatibilityTarget?.kind === 'boiler') {
    const explicit = explicitLoadKwNear(text, /(?:кот[её]л|boiler|baxi)/iu) ?? (compatibilityTarget?.kind === 'boiler' ? singlePowerKwFromText(text) : undefined);
    const previous = [...items.values()].find((item) => item.kind === 'boiler');
    const item: ProductElectricalLoadItem = {
      kind: 'boiler',
      name: compatibilityTarget?.name ?? previous?.name ?? 'котел',
      count: 1,
      runningKw: explicit ?? previous?.runningKw,
      startingKw: explicit ?? previous?.startingKw ?? explicit,
      source: explicit ? 'explicit_user' : previous?.source ?? 'estimated_average',
      evidence: explicit ? text : previous?.evidence ?? text
    };
    items.set(loadItemKey(item), item);
  }

  const existingHandheldTool = [...items.values()].find((item) => item.kind === 'handheld_tool');
  if (existingHandheldTool) {
    const handheldToolTerms = new RegExp(`(?:${[
      ruChars(1073, 1086, 1083, 1075, 1072, 1088, 1082),
      ruChars(1091, 1096, 1084),
      ruChars(1076, 1088, 1077, 1083),
      ruChars(1087, 1077, 1088, 1092, 1086, 1088, 1072, 1090),
      ruChars(1087, 1080, 1083),
      ruChars(1087, 1080, 1083, 1072),
      ruChars(1080, 1085, 1089, 1090, 1088, 1091, 1084, 1077, 1085, 1090),
      'grinder',
      'drill',
      'saw',
      'tool'
    ].join('|')})`, 'iu');
    const toolCompetingLoadRe = new RegExp(`(?:${[
      ruChars(1085, 1072, 1089, 1086, 1089),
      ruChars(1093, 1086, 1083, 1086, 1076, 1080, 1083),
      ruChars(1089, 1074, 1077, 1090),
      ruChars(1083, 1072, 1084, 1087),
      ruChars(1086, 1089, 1074, 1077, 1097),
      'pump',
      'fridge',
      'refrigerator',
      'light',
      'led'
    ].join('|')})`, 'iu');
    const explicit = explicitLoadKwNearOwnMention(text, handheldToolTerms, toolCompetingLoadRe);
    if (explicit) {
      const item: ProductElectricalLoadItem = {
        ...existingHandheldTool,
        runningKw: explicit,
        startingKw: Math.max(roundPowerKw(explicit * 1.8), roundPowerKw(explicit + 0.6)),
        source: 'explicit_user',
        evidence: text
      };
      items.set(loadItemKey(existingHandheldTool), item);
    }
  }

  const negatedPumpLoad = hasNegatedPumpLoad(text);
  const removedKinds = negatedPumpLoad ? ['pump'] : [];
  if (negatedPumpLoad) {
    for (const [key, existing] of [...items.entries()]) {
      if (existing.kind === 'pump') items.delete(key);
    }
  }
  const pumpMentionRe = new RegExp(`(?:${ruChars(1085, 1072, 1089, 1086, 1089)}|pump)`, 'iu');
  if (!negatedPumpLoad && (pumpMentionRe.test(lower) || compatibilityTarget?.kind === 'pump')) {
    const pumpCompetingLoadRe = new RegExp(`(?:${[
      ruChars(1093, 1086, 1083, 1086, 1076, 1080, 1083),
      ruChars(1089, 1074, 1077, 1090),
      ruChars(1073, 1086, 1083, 1075, 1072, 1088, 1082),
      ruChars(1080, 1085, 1089, 1090, 1088, 1091, 1084, 1077, 1085, 1090),
      ruChars(1083, 1072, 1084, 1087),
      ruChars(1086, 1089, 1074, 1077, 1097),
      'fridge',
      'refrigerator',
      'light',
      'led',
      'grinder',
      'tool'
    ].join('|')})`, 'iu');
    const focusedCompatibilityPower = compatibilityTarget?.kind === 'pump' && !pumpCompetingLoadRe.test(text)
      ? singlePowerKwFromText(text)
      : undefined;
    const explicit = explicitLoadKwNearOwnMention(text, pumpMentionRe, pumpCompetingLoadRe) ?? focusedCompatibilityPower;
    const previous = [...items.values()].find((item) => item.kind === 'pump');
    const currentPumpType = pumpTypeFromText(lower);
    const previousPumpType = pumpTypeFromText([previous?.name, previous?.evidence].filter(Boolean).join(' '));
    const currentHasPumpType = currentPumpType !== 'generic';
    const runningKw = explicit ?? (currentHasPumpType ? pumpRunningKwEstimate(lower) : previous?.runningKw ?? pumpRunningKwEstimate(lower));
    const item: ProductElectricalLoadItem = {
      kind: 'pump',
      name: compatibilityTarget?.kind === 'pump'
        ? compatibilityTarget.name ?? pumpNameFromType(currentPumpType)
        : currentHasPumpType
          ? pumpNameFromType(currentPumpType)
          : previousPumpType !== 'generic'
            ? pumpNameFromType(previousPumpType)
            : previous?.name ?? 'pump',
      count: 1,
      runningKw,
      startingKw: explicit
        ? pumpStartingKwEstimate(explicit)
        : pumpStartingKwEstimate(runningKw),
      source: explicit ? 'explicit_user' : 'estimated_average',
      evidence: explicit || currentHasPumpType ? text : previous?.evidence ?? text
    };
    for (const [key, existing] of [...items.entries()]) {
      if (existing.kind === 'pump') items.delete(key);
    }
    items.set(loadItemKey(item), item);
  }

  const profile = calculateGeneratorLoadProfile([...items.values()], simultaneousStarting || current?.simultaneousStarting === true);
  if (profile && (removedKinds.length || stagedKinds.size)) {
    profile.removedKinds = [...new Set([...removedKinds, ...stagedKinds])];
  }
  return profile;
}

function tokenRolesForTurn(tokens: string[], userMessage: string, targetProductClass: ProductIntent): ProductSelectionToken[] {
  if (!tokens.length) return [];
  const compatibilityContext = hasCompatibilityTargetContext(userMessage);
  const comparisonContext = isCatalogAvailabilityQuestion(userMessage) ||
    /(?:почему\s+.*не\s+показ|сравн|а\s+что|разве|нет\s+таких|или\s+нет|compare|why.*not)/iu.test(userMessage);
  return tokens.map((value) => ({
    value,
    role: compatibilityContext && targetProductClass === 'generator'
      ? 'compatibilityTarget'
      : comparisonContext
        ? 'comparisonProduct'
        : 'targetProduct',
    evidence: userMessage
  }));
}

function activePowerFromLoadText(text: string) {
  const explicit = parseDesiredPowerRange(text);
  if (explicit) return { min: explicit.min, max: explicit.max, source: 'explicit_user' as const };
  const boilerKw = text.match(/(?:кот[её]л|boiler|baxi)[^.!?\n]{0,80}(\d+(?:[,.]\d+)?)\s*(?:квт|kw)/iu)
    ?? text.match(/(\d+(?:[,.]\d+)?)\s*(?:квт|kw)[^.!?\n]{0,80}(?:кот[её]л|boiler|baxi)/iu);
  if (boilerKw) {
    const kw = Number(boilerKw[1].replace(',', '.'));
    if (Number.isFinite(kw) && kw >= 3) {
      return {
        min: Math.max(kw, Math.round(kw * 1.0 * 10) / 10),
        max: Math.round((kw + 1) * 10) / 10,
        source: 'inferred_from_load' as const
      };
    }
  }
  return undefined;
}

function isGroundedPowerConstraintSource(source: unknown) {
  return source === 'explicit_user' || source === 'catalog_fact' || source === 'previous_selection';
}

function semanticPowerRequirementEvidence(requirement: SemanticRequirement) {
  const value = requirement.value ?? {};
  return [
    requirement.id,
    requirement.evidence,
    semanticText(value, 'text'),
    requirement.replacesRequirementIds?.join(' ')
  ].filter(Boolean).join(' ');
}

function semanticPowerRequirementLooksLikeLoad(requirement: SemanticRequirement) {
  if (requirement.kind !== 'powerKw') return false;
  const evidenceText = semanticPowerRequirementEvidence(requirement);
  if (!evidenceText.trim()) return false;
  if (hasExplicitGeneratorPowerRequest(evidenceText)) return false;
  return /(?:\u043d\u0430\u0441\u043e\u0441|pump|\u0445\u043e\u043b\u043e\u0434\u0438\u043b|fridge|refrigerator|\u043a\u043e\u0442[\u0435\u0451]\u043b|boiler|\u0441\u0432\u0435\u0442|\u043e\u0441\u0432\u0435\u0449|\u043b\u0430\u043c\u043f|\u0431\u043e\u043b\u0433\u0430\u0440\u043a|\u0438\u043d\u0441\u0442\u0440\u0443\u043c\u0435\u043d\u0442|tool|\u043a\u043e\u043c\u043f\u0440\u0435\u0441\u0441\u043e\u0440|compressor)/iu.test(evidenceText);
}

function semanticRequirementAppliesToSelection(requirement: SemanticRequirement, targetProductClass: ProductIntent) {
  if (requirement.kind === 'powerKw' && generatorOnlyIntent(targetProductClass) && semanticPowerRequirementLooksLikeLoad(requirement)) {
    return false;
  }
  return true;
}

function singlePowerKwFromText(text: string) {
  const match = text.match(powerRegex);
  if (!match) return undefined;
  const kw = normalizePowerValue(match[1]);
  return kw && Number.isFinite(kw) ? kw : undefined;
}

function hasMaterialHardConstraints(selection?: ProductSelectionState | null) {
  const hard = selection?.hardConstraints;
  if (!hard) return false;
  return Boolean(
    hard.budgetMax ||
    hard.nominalPowerKwMin ||
    hard.nominalPowerKwMax ||
    hard.maxPowerKwMin ||
    hard.maxPowerKwMax ||
    hard.weightKgMin ||
    hard.weightKgMax ||
    hard.diameterMmMin ||
    hard.diameterMmMax ||
    hard.fuel ||
    hard.startType ||
    hard.enclosure ||
    hard.brandConstraint
  );
}

function shouldPreserveSelectionForFollowUp(userMessage: string, previousSelection?: ProductSelectionState | null) {
  if (!hasMaterialHardConstraints(previousSelection)) return false;
  if (isProductCardSelectionFollowUp(userMessage)) return true;
  if (isRankingOnlyFollowUp(userMessage)) return true;
  const tokens = extractModelTokens(userMessage);
  if (!tokens.length) return false;
  return isCatalogAvailabilityQuestion(userMessage) ||
    /(?:почему|зачем|разве|а\s+что|нет\s+таких|не\s+показ|сравн|compare|why|what\s+about|instead)/iu.test(userMessage);
}

function explicitCriteriaFromTurn(
  current: ProductSelectionState,
  userMessage: string,
  activeText: string,
  plan: AssistantTurnPlan,
  profile: ProductFitProfile,
  conversationUserText = ''
) {
  const targetProductClass = productIntentFromSelection(current, plan, profile);
  const plannerTraits = plan.requiredProductTraits;
  const semanticSelectionReady = current.semanticSource === 'llm_need_extraction' ||
    current.semanticSource === 'planner' ||
    plannerHasSemanticSelection(plan);
  const allowLegacyTextFallback = !semanticSelectionReady;
  const explicitRankingPreference = allowLegacyTextFallback ? rankingPreferenceFromText(userMessage) : undefined;
  const rankingPreference = explicitRankingPreference ??
    (targetProductClass !== 'unknown' && !plannerTraits.budgetMax ? 'cheapest' : undefined);
  const rankingOnly = allowLegacyTextFallback ? isRankingOnlyFollowUp(userMessage) : plan.searchScope === 'broadenAlternatives';
  const currentHard = current.activeRequirement ?? current.hardConstraints;
  const plannerExactModelConstraint = shortText(plan.selectionState.exactModelConstraint, 160).trim();
  const semanticExactModelConstraint = isSemanticExactModelTargetToken(plannerExactModelConstraint, targetProductClass)
    ? plannerExactModelConstraint
    : '';
  const exactTokenSource = allowLegacyTextFallback
    ? userMessage
    : semanticExactModelConstraint;
  const exactTokensFromMessage = expandModelTokenAliases(extractModelTokens(exactTokenSource))
    .filter((token) => isSemanticExactModelTargetToken(token, targetProductClass));
  const exactTokenRoles = allowLegacyTextFallback
    ? tokenRolesForTurn(exactTokensFromMessage, userMessage, targetProductClass)
    : exactTokensFromMessage.map((value) => ({
        value,
        role: 'targetProduct' as const,
        evidence: plan.selectionState.exactModelConstraint
      }));
  const targetExactTokens = exactTokenRoles.filter((token) => token.role === 'targetProduct').map((token) => token.value);
  const hard: ProductSelectionCriteria = {
    productIntent: targetProductClass,
    productRole: plan.requiredProductTraits.productRole !== 'unknown'
      ? plan.requiredProductTraits.productRole
      : targetProductClass === 'unknown'
        ? 'unknown'
        : 'coreProduct',
    exactModelTokens: targetExactTokens,
    exactModelTokenRoles: exactTokenRoles,
    excludedClasses: removeActiveIntentExclusions(
      plan.selectionState.excludedClasses,
      new Set([targetProductClass].filter(knownProductIntent))
    ),
    mustHaveTraits: [],
    provenance: {}
  };
  const soft: ProductSelectionCriteria = {
    productIntent: targetProductClass,
    productRole: hard.productRole,
    mustHaveTraits: uniqueList([...plan.selectionState.mustHaveTraits, ...plan.selectionState.niceToHaveTraits], 24),
    exactModelTokens: [],
    excludedClasses: []
  };

  const latestExplicitWeightRange = intentAcceptsRequirementKind(targetProductClass, 'weightKg')
    ? parseWeightNeedRangeKg(userMessage)
    : undefined;
  const plannerHasWeightRange = Boolean(plannerTraits.weightKgMin || plannerTraits.weightKgMax);
  if (!rankingOnly && latestExplicitWeightRange) {
    hard.weightKgMin = latestExplicitWeightRange.min;
    hard.weightKgMax = latestExplicitWeightRange.max;
    hard.provenance!.weightKgMin = 'explicit_user';
    hard.provenance!.weightKgMax = 'explicit_user';
  } else if (!rankingOnly && plannerHasWeightRange) {
    hard.weightKgMin = plannerTraits.weightKgMin ?? undefined;
    hard.weightKgMax = plannerTraits.weightKgMax ?? undefined;
    if (plannerTraits.weightKgMin) hard.provenance!.weightKgMin = 'planner';
    if (plannerTraits.weightKgMax) hard.provenance!.weightKgMax = 'planner';
  } else if (allowLegacyTextFallback) {
    const weightRange = parseWeightNeedRangeKg(userMessage) ?? implicitPlateWeightRangeFromNeed(activeText, targetProductClass);
    if (!rankingOnly && weightRange) {
      hard.weightKgMin = weightRange.min;
      hard.weightKgMax = weightRange.max;
      const source = parseWeightNeedRangeKg(userMessage) ? 'explicit_user' : 'planner';
      hard.provenance!.weightKgMin = source;
      hard.provenance!.weightKgMax = source;
    }
  }
  const plannerHasDimensionRange = Boolean(plannerTraits.diameterMmMin || plannerTraits.diameterMmMax);
  if (!rankingOnly && plannerHasDimensionRange) {
    hard.diameterMmMin = plannerTraits.diameterMmMin ?? undefined;
    hard.diameterMmMax = plannerTraits.diameterMmMax ?? undefined;
    if (plannerTraits.diameterMmMin) hard.provenance!.diameterMmMin = 'planner';
    if (plannerTraits.diameterMmMax) hard.provenance!.diameterMmMax = 'planner';
  } else if (allowLegacyTextFallback) {
    const dimensionRange = parseDimensionNeedRangeMm(userMessage);
    if (!rankingOnly && dimensionRange) {
      hard.diameterMmMin = dimensionRange.min;
      hard.diameterMmMax = dimensionRange.max;
      hard.provenance!.diameterMmMin = 'explicit_user';
      hard.provenance!.diameterMmMax = 'explicit_user';
    }
  }
  if (!rankingOnly && plannerTraits.budgetMax && (!allowLegacyTextFallback || hasBudgetSignal(userMessage))) {
    hard.budgetMax = plannerTraits.budgetMax;
    hard.provenance!.budgetMax = 'planner';
  } else if (allowLegacyTextFallback) {
    const budgetMax = parseBudgetMax(userMessage);
    if (!rankingOnly && budgetMax) {
      hard.budgetMax = budgetMax;
      hard.provenance!.budgetMax = 'explicit_user';
    }
  }
  const plannerCompatibilityTarget = shortText(plan.selectionState.compatibilityTargetProduct, 160);
  const compatibilityUpdate = plannerCompatibilityTarget
    ? { name: plannerCompatibilityTarget, evidence: 'planner' }
    : allowLegacyTextFallback ? compatibilityTargetFromText(userMessage) : undefined;
  const compatibilityTarget = targetProductClass === 'generator'
    ? mergeCompatibilityTarget(current.compatibilityTargetProduct, compatibilityUpdate)
    : undefined;
  const shouldReconcileLoadProfileFromText = targetProductClass === 'generator' && (
    hasGeneratorLoadReferenceSignal(userMessage) ||
    hasNegatedPumpLoad(userMessage) ||
    Boolean(explicitAggregateLoadKwFromText(userMessage))
  );
  const loadProfile = targetProductClass === 'generator'
    ? semanticSelectionReady
      ? shouldReconcileLoadProfileFromText
        ? generatorLoadProfileFromText(userMessage, current.loadProfile, compatibilityTarget)
        : current.loadProfile
      : allowLegacyTextFallback
        ? generatorLoadProfileFromText(userMessage, current.loadProfile, compatibilityTarget)
        : current.loadProfile
    : undefined;
  const contextualGroundedPowerMin = targetProductClass === 'generator' && allowLegacyTextFallback
    ? explicitGeneratorPowerRequestKw(conversationUserText)
    : undefined;
  const currentGroundedPowerMin = currentHard.productIntent === 'generator' &&
    currentHard.nominalPowerKwMin &&
    isGroundedPowerConstraintSource(currentHard.provenance?.nominalPowerKwMin)
    ? currentHard.nominalPowerKwMin
    : undefined;
  const groundedPowerMin = Math.max(currentGroundedPowerMin ?? 0, contextualGroundedPowerMin ?? 0) || undefined;
  const loadProfileCanSetPower = isReliableGeneratorLoadProfile(loadProfile) &&
    (!groundedPowerMin || (loadProfile?.requiredNominalKw ?? 0) > groundedPowerMin);
  const loadProfileOverridesPlannerPower = Boolean(loadProfileCanSetPower && (semanticSelectionReady || !hasExplicitGeneratorPowerRequest(userMessage)));
  const latestExplicitPowerRange = targetProductClass === 'generator'
    ? parseDesiredPowerRange(userMessage)
    : undefined;
  const latestIsCatalogPowerLookup = isCatalogAvailabilityQuestion(userMessage) ||
    /\u043d\u0430\u043b\u0438\u0447/iu.test(userMessage) ||
    plan.agentDecision?.catalogAction === 'exact_model_lookup' ||
    plan.agentDecision?.catalogAction === 'verify_catalog_absence';
  const latestExplicitSinglePower = targetProductClass === 'generator' && !latestExplicitPowerRange
    && !loadProfileCanSetPower
    && !hasCompatibilityTargetContext(userMessage)
    && latestIsCatalogPowerLookup
    ? explicitSinglePowerKwConstraint(userMessage)
    : undefined;
  const latestPowerRange = latestExplicitPowerRange
    ? {
        nominalMin: latestExplicitPowerRange.min,
        nominalMax: latestExplicitPowerRange.max,
        source: 'explicit_text' as const
      }
    : latestExplicitSinglePower
      ? {
          nominalMin: latestExplicitSinglePower,
          nominalMax: latestExplicitSinglePower,
          source: 'explicit_text' as const
        }
    : undefined;
  const plannerPower = targetProductClass === 'generator' && !loadProfileOverridesPlannerPower && (
    plannerTraits.nominalPowerKwMin ||
    plannerTraits.nominalPowerKwMax ||
    plannerTraits.maxPowerKwMin ||
    plannerTraits.maxPowerKwMax
  )
    ? {
        nominalMin: plannerTraits.nominalPowerKwMin ?? undefined,
        nominalMax: plannerTraits.nominalPowerKwMax ?? undefined,
        maxMin: plannerTraits.maxPowerKwMin ?? undefined,
        maxMax: plannerTraits.maxPowerKwMax ?? undefined,
        source: 'planner' as const
      }
    : undefined;
  const exactPowerFromLatestUser = plannerPowerRangeBroadensExplicitSinglePower(userMessage, plannerPower);
  const effectivePlannerPower: GeneratorPowerProfile | undefined = exactPowerFromLatestUser
    ? latestPowerRange ?? {
        nominalMin: exactPowerFromLatestUser,
        nominalMax: exactPowerFromLatestUser,
        source: 'explicit_text' as const
      }
    : latestPowerRange ?? plannerPower;
  const contextualPower = targetProductClass === 'generator' && !plannerPower && contextualGroundedPowerMin && !loadProfileCanSetPower
    ? { min: contextualGroundedPowerMin, max: Math.round((contextualGroundedPowerMin + Math.max(1.5, contextualGroundedPowerMin * 0.08)) * 10) / 10, source: 'explicit_user' as const }
    : undefined;
  const desiredPower = targetProductClass === 'generator' && !plannerPower && !contextualPower && loadProfileCanSetPower && loadProfile?.requiredNominalKw
    ? { ...inferredLoadPowerWindow(loadProfile.requiredNominalKw), source: 'inferred_from_load' as const }
    : targetProductClass === 'generator' && !plannerPower && allowLegacyTextFallback ? activePowerFromLoadText(userMessage) ?? (
      current.compatibilityTargetProduct?.kind && hasExplicitPowerText(userMessage)
        ? (() => {
            const kw = singlePowerKwFromText(userMessage);
            return kw && kw >= 3
              ? { min: kw, max: Math.round((kw + 1) * 10) / 10, source: 'inferred_from_load' as const }
              : undefined;
          })()
        : undefined
    ) : undefined;
  if (!rankingOnly && effectivePlannerPower) {
    const powerSource = effectivePlannerPower.source === 'explicit_text' ? 'explicit_user' : 'planner';
    if (effectivePlannerPower.nominalMin) {
      hard.nominalPowerKwMin = effectivePlannerPower.nominalMin;
      hard.provenance!.nominalPowerKwMin = powerSource;
    }
    if (effectivePlannerPower.nominalMax) {
      hard.nominalPowerKwMax = effectivePlannerPower.nominalMax;
      hard.provenance!.nominalPowerKwMax = powerSource;
    }
    if (effectivePlannerPower.maxMin) {
      hard.maxPowerKwMin = effectivePlannerPower.maxMin;
      hard.provenance!.maxPowerKwMin = 'planner';
    }
    if (effectivePlannerPower.maxMax) {
      hard.maxPowerKwMax = effectivePlannerPower.maxMax;
      hard.provenance!.maxPowerKwMax = 'planner';
    }
  } else if (!rankingOnly && (contextualPower || desiredPower)) {
    const power = contextualPower ?? desiredPower!;
    hard.nominalPowerKwMin = power.min;
    hard.nominalPowerKwMax = power.max;
    hard.provenance!.nominalPowerKwMin = power.source;
    hard.provenance!.nominalPowerKwMax = power.source;
    if (power.source === 'inferred_from_load' && loadProfile?.requiredStartingKw) {
      hard.maxPowerKwMin = loadProfile.requiredStartingKw;
      hard.provenance!.maxPowerKwMin = 'inferred_from_load';
    }
  } else if (!rankingOnly && allowLegacyTextFallback && !currentHard.nominalPowerKwMin && !currentHard.nominalPowerKwMax && !currentHard.maxPowerKwMin && !currentHard.maxPowerKwMax) {
    if (hasExplicitPowerText(userMessage)) {
      if (plan.requiredProductTraits.nominalPowerKwMin) {
        hard.nominalPowerKwMin = plan.requiredProductTraits.nominalPowerKwMin;
        hard.provenance!.nominalPowerKwMin = 'explicit_user';
      }
      if (plan.requiredProductTraits.nominalPowerKwMax) {
        hard.nominalPowerKwMax = plan.requiredProductTraits.nominalPowerKwMax;
        hard.provenance!.nominalPowerKwMax = 'explicit_user';
      }
      if (plan.requiredProductTraits.maxPowerKwMin) {
        hard.maxPowerKwMin = plan.requiredProductTraits.maxPowerKwMin;
        hard.provenance!.maxPowerKwMin = 'explicit_user';
      }
      if (plan.requiredProductTraits.maxPowerKwMax) {
        hard.maxPowerKwMax = plan.requiredProductTraits.maxPowerKwMax;
        hard.provenance!.maxPowerKwMax = 'explicit_user';
      }
    }
  }

  if (generatorOnlyIntent(targetProductClass) && (plannerTraits.fuel === 'gasoline' || plannerTraits.fuel === 'diesel')) {
    hard.fuel = plannerTraits.fuel;
    hard.provenance!.fuel = 'planner';
  }
  const latestExplicitElectricStart = allowLegacyTextFallback ? hasExplicitGeneratorElectricStartNeed(userMessage) : false;
  if (generatorOnlyIntent(targetProductClass) && plannerTraits.startType === 'electric') {
    hard.startType = plannerTraits.startType;
    hard.provenance!.startType = 'planner';
  } else if (generatorOnlyIntent(targetProductClass) && plannerTraits.startType === 'manual' && (semanticSelectionReady || /(?:\u0440\u0443\u0447\u043d[\p{L}]*\s+\u0437\u0430\u043f\u0443\u0441\u043a|\u0440\u0443\u0447\u043d[\p{L}]*\s+\u0441\u0442\u0430\u0440\u0442\u0435\u0440|\u0434\u0435\u0440\u0433\u0430\u0442\u044c\s+\u0448\u043d\u0443\u0440|manual\s+start|recoil\s+start)/iu.test(userMessage))) {
    hard.startType = plannerTraits.startType;
    hard.provenance!.startType = 'planner';
  }
  if (generatorOnlyIntent(targetProductClass) && (plannerTraits.enclosure === 'enclosed' || plannerTraits.enclosure === 'open')) {
    hard.enclosure = plannerTraits.enclosure;
    hard.provenance!.enclosure = 'planner';
  }
  if (generatorOnlyIntent(targetProductClass) &&
    plannerTraits.conventionalGenerator !== null &&
    plannerConventionalGeneratorConstraintHasEvidence(plannerTraits.conventionalGenerator, userMessage, plan, currentHard)) {
    hard.conventionalGenerator = plannerTraits.conventionalGenerator;
    hard.provenance!.conventionalGenerator = 'planner';
  }
  const currentHasGroundedSinglePhase = currentHard.singlePhase220 !== undefined &&
    currentHard.singlePhase220 !== null &&
    (currentHard.provenance?.singlePhase220 === 'explicit_user' || currentHard.provenance?.singlePhase220 === 'previous_selection');
  if (generatorOnlyIntent(targetProductClass) && plannerTraits.singlePhase220 !== null) {
    hard.singlePhase220 = plannerTraits.singlePhase220;
    hard.provenance!.singlePhase220 = currentHasGroundedSinglePhase && currentHard.singlePhase220 === plannerTraits.singlePhase220
      ? currentHard.provenance?.singlePhase220 ?? 'explicit_user'
      : 'planner';
  }
  if (!hard.startType && latestExplicitElectricStart) {
    hard.startType = 'electric';
    hard.provenance!.startType = 'explicit_user';
  }
  if (!hard.enclosure && allowLegacyTextFallback && fallbackDetectGeneratorEnclosureSignal(userMessage)) {
    hard.enclosure = 'enclosed';
    hard.provenance!.enclosure = 'explicit_user';
  }
  if (hard.conventionalGenerator === undefined && allowLegacyTextFallback && containsAny(userMessage, inverterTerms) && !isTermExplanationQuestion(userMessage)) {
    hard.conventionalGenerator = false;
    hard.provenance!.conventionalGenerator = 'explicit_user';
  }
  if (hard.conventionalGenerator === undefined && allowLegacyTextFallback && hasConventionalGeneratorSignal(userMessage)) {
    hard.conventionalGenerator = true;
    hard.provenance!.conventionalGenerator = 'explicit_user';
  }
  if (hard.singlePhase220 === undefined && allowLegacyTextFallback && containsAny(userMessage, singlePhaseTerms)) {
    hard.singlePhase220 = true;
    hard.provenance!.singlePhase220 = 'explicit_user';
  } else if (hard.singlePhase220 === undefined && allowLegacyTextFallback && !currentHasGroundedSinglePhase && targetProductClass === 'generator' && hasHomeSinglePhaseLoadContext(userMessage)) {
    hard.singlePhase220 = true;
    hard.provenance!.singlePhase220 = 'inferred_from_load';
  }
  const plannerBrandConstraint = sanitizeBrandConstraintText(plan.selectionState.brandConstraint);
  if (
    plannerBrandConstraint &&
    !plannerBrandBelongsToCompatibilityTarget(plannerBrandConstraint, compatibilityTarget, targetProductClass)
  ) {
    hard.brandConstraint = plannerBrandConstraint;
    hard.provenance!.brandConstraint = 'planner';
  }
  if (semanticExactModelConstraint) {
    hard.exactModelConstraint = semanticExactModelConstraint;
    hard.provenance!.exactModelConstraint = allowLegacyTextFallback ? 'explicit_user' : 'planner';
  }
  const hasHardUpdate = Boolean(
    targetProductClass !== 'unknown' ||
    hard.productIntent !== 'unknown' ||
    hard.productRole !== 'unknown' ||
    hard.budgetMax ||
    hard.nominalPowerKwMin ||
    hard.nominalPowerKwMax ||
    hard.maxPowerKwMin ||
    hard.maxPowerKwMax ||
    hard.weightKgMin ||
    hard.weightKgMax ||
    hard.diameterMmMin ||
    hard.diameterMmMax ||
    hard.fuel ||
    hard.startType ||
    hard.enclosure ||
    hard.conventionalGenerator !== undefined ||
    hard.singlePhase220 !== undefined ||
    hard.brandConstraint ||
    hard.exactModelConstraint ||
    hard.exactModelTokens.length ||
    (hard.exactModelTokenRoles?.length ?? 0) > 0
  );

  return {
    semanticSource: current.semanticSource === 'llm_need_extraction'
      ? 'llm_need_extraction'
      : allowLegacyTextFallback ? 'legacy_text_fallback' : 'planner',
    currentProductClass: targetProductClass,
    targetProductClass,
    activeRequirement: hasHardUpdate ? hard : undefined,
    hardConstraints: hasHardUpdate ? hard : undefined,
    softPreferences: soft,
    unknowns: plan.missingInformation,
    selectedProductIds: plan.selectedProductIds,
    compatibilityTargetProduct: compatibilityTarget,
    loadProfile,
    rankingPreference,
    confidence: Math.max(plan.selectionState.selectionConfidence, targetProductClass === 'unknown' ? 0 : 0.55),
    updatedAt: new Date().toISOString()
  } satisfies Partial<ProductSelectionState>;
}

function powerCriteriaFromSelection(criteria: ProductSelectionCriteria): GeneratorPowerProfile | undefined {
  if (!criteria.nominalPowerKwMin && !criteria.nominalPowerKwMax && !criteria.maxPowerKwMin && !criteria.maxPowerKwMax) return undefined;
  const source = [
    criteria.provenance?.nominalPowerKwMin,
    criteria.provenance?.nominalPowerKwMax,
    criteria.provenance?.maxPowerKwMin,
    criteria.provenance?.maxPowerKwMax
  ].some((item) => item === 'inferred_from_load') ? 'estimated_load' : 'explicit_text';
  return normalizePowerRange(completeSingleTargetNominalPower({
    nominalMin: criteria.nominalPowerKwMin,
    nominalMax: criteria.nominalPowerKwMax,
    maxMin: criteria.maxPowerKwMin,
    maxMax: criteria.maxPowerKwMax,
    source
  }, criteria));
}

function productMeetsCalculatedLoad(product: Product, state: ProductSelectionState) {
  const required = state.loadProfile?.requiredNominalKw;
  if (
    !required ||
    state.hardConstraints.productIntent !== 'generator' ||
    (!isReliableGeneratorLoadProfile(state.loadProfile) && !hasPreliminaryGeneratorSelectionBasis(state))
  ) return true;
  const power = extractGeneratorPowerForHardSelection(product);
  if (power.nominalKw === undefined) return false;
  return power.nominalKw >= required - 0.2 || (power.maxKw !== undefined && power.maxKw >= required + 0.5 && power.nominalKw >= required - 0.7);
}

function hasEstimatedPumpLoadProfile(profile?: ProductGeneratorLoadProfile | null) {
  return (profile?.items ?? []).some((item) => item.kind === 'pump' && item.source === 'estimated_average');
}

function hasTypedEstimatedPumpLoadProfile(profile?: ProductGeneratorLoadProfile | null) {
  const pumpText = (profile?.items ?? [])
    .filter((item) => item.kind === 'pump' && item.source === 'estimated_average')
    .map((item) => [item.name, item.evidence].filter(Boolean).join(' '))
    .join(' ');
  return pumpText.trim() ? pumpTypeFromText(pumpText) !== 'generic' : false;
}

function hasPumpPowerEvidenceProfile(profile?: ProductGeneratorLoadProfile | null) {
  return (profile?.items ?? []).some((item) => {
    if (item.kind !== 'pump') return false;
    if (item.source === 'explicit_user') return true;
    const text = [item.name, item.evidence].filter(Boolean).join(' ');
    return /\d+(?:[,.]\d+)?\s*(?:\u043a\u0432\u0442|kw|kva|\u043a\u0432\u0430|\u0432\u0442|w)/iu.test(text);
  });
}

function hasPreliminaryGeneratorSelectionBasisFromProfile(profile?: ProductGeneratorLoadProfile | null) {
  if (!profile?.requiredNominalKw || !hasEstimatedPumpLoadProfile(profile)) return false;
  if (!hasTypedEstimatedPumpLoadProfile(profile)) return false;
  const hasOtherLoad = (profile.items ?? []).some((item) =>
    item.kind !== 'pump' &&
    item.kind !== 'aggregate_load' &&
    (item.runningKw ?? 0) > 0
  );
  return hasOtherLoad && (profile.requiredNominalKw >= 3.5 || hasPumpPowerEvidenceProfile(profile));
}

function hasPreliminaryGeneratorSelectionBasis(state: ProductSelectionState) {
  const hard = state.hardConstraints;
  if (hard.productIntent !== 'generator') return true;
  return hasPreliminaryGeneratorSelectionBasisFromProfile(state.loadProfile);
}

function hasReliableGeneratorSelectionBasis(state: ProductSelectionState) {
  const hard = state.hardConstraints;
  if (hard.productIntent !== 'generator') return true;
  if (hard.exactModelTokens.length || hard.exactModelConstraint) return true;
  if (isReliableGeneratorLoadProfile(state.loadProfile)) return true;
  if (hasPreliminaryGeneratorSelectionBasis(state)) return true;
  const powerSources = [
    hard.provenance?.nominalPowerKwMin,
    hard.provenance?.nominalPowerKwMax,
    hard.provenance?.maxPowerKwMin,
    hard.provenance?.maxPowerKwMax
  ];
  const hasOnlyInferredLoadPower = powerSources.some((source) => source === 'inferred_from_load') &&
    powerSources.every((source) => !source || source === 'inferred_from_load');
  if (hasOnlyInferredLoadPower && !isReliableGeneratorLoadProfile(state.loadProfile)) return false;
  return Boolean(hard.nominalPowerKwMin || hard.nominalPowerKwMax || hard.maxPowerKwMin || hard.maxPowerKwMax);
}

function isReliableGeneratorLoadProfile(profile?: ProductGeneratorLoadProfile | null) {
  if (!profile?.requiredNominalKw) return false;
  const items = profile.items ?? [];
  if (items.some((item) => item.kind === 'aggregate_load' && item.source === 'explicit_user')) return true;
  if (items.some((item) => item.source === 'explicit_user') && (profile.confidence ?? 0) >= 0.75) return true;
  const activeEstimatedItems = items.filter((item) => item.source === 'estimated_average' && item.runningKw && item.runningKw > 0);
  return activeEstimatedItems.length >= 2 && (profile.totalRunningKw ?? 0) >= 0.8;
}

function hasEstimatedPumpLoad(state: ProductSelectionState) {
  return state.hardConstraints.productIntent === 'generator' &&
    hasEstimatedPumpLoadProfile(state.loadProfile);
}

function shouldAllowPreliminaryCatalogCardsForEstimatedPump(
  contract: AgentTurnContract,
  result: ProductSelectionResult
) {
  const hard = result.state.hardConstraints;
  if (hard.productIntent !== 'generator') return false;
  if (!hasEstimatedPumpLoad(result.state)) return false;
  if (contract.catalogAction !== 'find_matching_products') return false;
  if (contract.cardsRole !== 'primary' || (contract.productCardsPolicy ?? 'none') === 'none') return false;
  if (!result.visibleProducts.length || !result.matchedProducts.length || result.confidence < 0.55) return false;
  return Boolean(
    hard.nominalPowerKwMin ||
    hard.nominalPowerKwMax ||
    hard.maxPowerKwMin ||
    hard.maxPowerKwMax ||
    result.state.loadProfile?.requiredNominalKw
  );
}

function hasTypedEstimatedPumpLoad(state: ProductSelectionState) {
  return hasTypedEstimatedPumpLoadProfile(state.loadProfile);
}

function shouldBlockGeneratorCardsForEstimatedPump(state: ProductSelectionState) {
  return hasEstimatedPumpLoad(state) && !hasPreliminaryGeneratorSelectionBasis(state);
}

function productSelectionHardViolation(product: Product, state: ProductSelectionState, profile: ProductFitProfile) {
  const hard = state.hardConstraints;
  const flags = classifyProduct(product);
  if (hard.productIntent !== 'unknown' && !productMatchesIntent(product, hard.productIntent as ProductIntent)) return `product class is not ${hard.productIntent}`;
  if (hard.productRole === 'coreProduct' && !isCoreEquipment(product)) return 'product is not core equipment';
  const excludedClass = effectiveExcludedClassesForState(state).find((intent) => productMatchesIntent(product, intent as ProductIntent));
  if (excludedClass) return `product belongs to excluded class ${excludedClass}`;
  if (hard.fuel === 'gasoline' && flags.isDiesel) return 'diesel product violates gasoline-only constraint';
  if (hard.fuel === 'diesel' && flags.isGasoline) return 'gasoline product violates diesel-only constraint';
  if (hard.startType === 'electric' && !flags.hasElectricStart) return 'product lacks required electric start';
  if (hard.enclosure === 'enclosed' && !flags.hasGeneratorEnclosureSignal) return 'product lacks required enclosed/noise-protected execution';
  if (hard.enclosure === 'open' && flags.hasGeneratorEnclosureSignal && !flags.hasOpenFrameSignal) return 'product is enclosed but open execution is required';
  if (hard.conventionalGenerator === true && flags.isInverter) return 'inverter product violates conventional-generator constraint';
  if (hard.conventionalGenerator === false && !flags.isInverter && flags.isGenerator) return 'conventional product violates inverter-generator constraint';
  if (hard.productIntent === 'generator' && hard.singlePhase220 === true) {
    const phase = generatorPhaseProfile(product);
    if (phase === 'mixed_220_380') return 'product is mixed 220/380 V, but buyer requested strict 220 V';
    if (phase === 'three_phase_380') return 'product is three-phase/380 V, but buyer requested strict 220 V';
  }
  if (hard.budgetMax) {
    const price = product.price;
    if (typeof price !== 'number') return `price is unknown under budget ${hard.budgetMax}`;
    if (price > hard.budgetMax * 1.02) return `price ${price} exceeds budget ${hard.budgetMax}`;
  }
  if (hard.brandConstraint) {
    const requested = new Set([normalizeBrandKey(hard.brandConstraint)].filter((item) => item.length >= 3));
    if (requested.size && !productMatchesRequestedBrand(product, requested)) return `brand does not match ${hard.brandConstraint}`;
  }
  if (hard.exactModelConstraint && !productMatchesExactModelConstraint(product, hard.exactModelConstraint, hard.exactModelTokens)) return `model does not match ${hard.exactModelConstraint}`;
  if (hard.exactModelTokens.length && !productHasExactModel(product, { ...profile, exactModelTokens: hard.exactModelTokens })) return 'product does not match exact model tokens';
  if (hard.weightKgMin || hard.weightKgMax) {
    const weight = extractWeightKg(product);
    const inferredWeightRange = hard.provenance?.weightKgMin === 'planner' || hard.provenance?.weightKgMax === 'planner';
    if (weight === undefined) {
      if (!inferredWeightRange) return 'weight is unknown';
    } else {
    if (hard.weightKgMin && weight < hard.weightKgMin) return `weight ${weight} kg is below ${hard.weightKgMin} kg`;
    if (hard.weightKgMax && weight > hard.weightKgMax) return `weight ${weight} kg is above ${hard.weightKgMax} kg`;
    }
  }
  if (hard.diameterMmMin || hard.diameterMmMax) {
    const dimension = extractDimensionMm(product);
    if (dimension === undefined) return 'diameter is unknown';
    if (hard.diameterMmMin && dimension < hard.diameterMmMin) return `diameter ${dimension} mm is below ${hard.diameterMmMin} mm`;
    if (hard.diameterMmMax && dimension > hard.diameterMmMax) return `diameter ${dimension} mm is above ${hard.diameterMmMax} mm`;
  }
  const powerRange = powerCriteriaFromSelection(hard);
  if (powerRange) {
    const power = extractGeneratorPowerForHardSelection(product);
    const nominalLowerTolerance = powerRange.source === 'estimated_load' ? 0.4 : 0;
    const nominalUpperTolerance = powerRange.source === 'estimated_load' ? 0.3 : 0;
    const maxLowerTolerance = powerRange.source === 'estimated_load' ? 0.5 : 0;
    const maxUpperTolerance = powerRange.source === 'estimated_load' ? 0.5 : 0;
    if ((powerRange.nominalMin || powerRange.nominalMax) && power.nominalKw === undefined) return 'nominal power is unknown';
    if ((powerRange.maxMin || powerRange.maxMax) && power.maxKw === undefined) return 'max power is unknown';
    if (powerRange.nominalMin && power.nominalKw !== undefined && power.nominalKw < powerRange.nominalMin - nominalLowerTolerance) return `nominal power ${power.nominalKw} kW is below ${powerRange.nominalMin} kW`;
    if (powerRange.nominalMax && power.nominalKw !== undefined && power.nominalKw > powerRange.nominalMax + nominalUpperTolerance) return `nominal power ${power.nominalKw} kW is above ${powerRange.nominalMax} kW`;
    if (powerRange.maxMin && power.maxKw !== undefined && power.maxKw < powerRange.maxMin - maxLowerTolerance) return `max power ${power.maxKw} kW is below ${powerRange.maxMin} kW`;
    if (powerRange.maxMax && power.maxKw !== undefined && power.maxKw > powerRange.maxMax + maxUpperTolerance) return `max power ${power.maxKw} kW is above ${powerRange.maxMax} kW`;
  }
  if (!productMeetsCalculatedLoad(product, state)) return `nominal power is below calculated load ${state.loadProfile?.requiredNominalKw} kW`;
  return null;
}

function productMatchesSelectionCriteria(product: Product, state: ProductSelectionState, profile: ProductFitProfile) {
  return !productSelectionHardViolation(product, state, profile);
}

function relaxedPlannerOnlyOptionalGeneratorTraits(state: ProductSelectionState): ProductSelectionState | null {
  const hard = state.hardConstraints;
  if (hard.productIntent !== 'generator') return null;
  const provenance = hard.provenance ?? {};
  const shouldRelaxStartType = provenance.startType === 'planner' && hard.startType !== undefined && hard.startType !== 'any';
  const shouldRelaxConventional = provenance.conventionalGenerator === 'planner' && hard.conventionalGenerator !== undefined && hard.conventionalGenerator !== null;
  const shouldRelaxEnclosure = provenance.enclosure === 'planner' && hard.enclosure !== undefined && hard.enclosure !== 'any';
  if (!shouldRelaxStartType && !shouldRelaxConventional && !shouldRelaxEnclosure) return null;

  const relaxedHard = {
    ...hard,
    provenance: { ...provenance }
  };
  if (shouldRelaxStartType) {
    delete relaxedHard.startType;
    delete relaxedHard.provenance.startType;
  }
  if (shouldRelaxConventional) {
    delete relaxedHard.conventionalGenerator;
    delete relaxedHard.provenance.conventionalGenerator;
  }
  if (shouldRelaxEnclosure) {
    delete relaxedHard.enclosure;
    delete relaxedHard.provenance.enclosure;
  }
  return {
    ...state,
    hardConstraints: relaxedHard,
    activeRequirement: relaxedHard
  };
}

function productRejectionReason(product: Product, state: ProductSelectionState, profile: ProductFitProfile) {
  const hardViolation = productSelectionHardViolation(product, state, profile);
  if (hardViolation) return hardViolation;
  const penalty = productFitPenalty(product, profile);
  if (penalty < 0) return `does not satisfy active fit constraints (${penalty})`;
  return 'does not satisfy active hard constraints';
}

function sortSelectionProducts(
  items: Array<{ product: Product; score: number }>,
  preference?: ProductRankingPreference,
  budgetMax?: number
) {
  return items.sort((a, b) => {
    if (budgetMax) {
      const aPrice = Number(a.product.price ?? -1);
      const bPrice = Number(b.product.price ?? -1);
      const aWithin = aPrice > 0 && aPrice <= budgetMax;
      const bWithin = bPrice > 0 && bPrice <= budgetMax;
      if (aWithin !== bWithin) return aWithin ? -1 : 1;
      if (aWithin && bWithin && aPrice !== bPrice && preference === 'cheapest') return aPrice - bPrice;
    }
    if (preference === 'cheapest') {
      const price = Number(a.product.price ?? Number.MAX_SAFE_INTEGER) - Number(b.product.price ?? Number.MAX_SAFE_INTEGER);
      if (price !== 0) return price;
    }
    if (preference === 'premium') {
      const price = Number(b.product.price ?? -1) - Number(a.product.price ?? -1);
      if (price !== 0) return price;
    }
    const score = b.score - a.score;
    if (score !== 0) return score;
    return Number(a.product.price ?? Number.MAX_SAFE_INTEGER) - Number(b.product.price ?? Number.MAX_SAFE_INTEGER);
  });
}

function catalogShortlistAlternativeScore(product: Product, state: ProductSelectionState, profile: ProductFitProfile) {
  const hard = state.hardConstraints;
  if (hard.productIntent !== 'unknown' && !productMatchesIntent(product, hard.productIntent as ProductIntent)) return null;
  if (hard.productRole === 'coreProduct' && !isCoreEquipment(product)) return null;
  if (effectiveExcludedClassesForState(state).some((intent) => productMatchesIntent(product, intent as ProductIntent))) return null;
  if (hard.brandConstraint) {
    const requested = new Set([normalizeBrandKey(hard.brandConstraint)].filter((item) => item.length >= 3));
    if (requested.size && !productMatchesRequestedBrand(product, requested)) return null;
  }
  if (hard.exactModelConstraint || hard.exactModelTokens.length) return null;

  const flags = classifyProduct(product);
  if (hard.fuel === 'gasoline' && flags.isDiesel) return null;
  if (hard.fuel === 'diesel' && flags.isGasoline) return null;
  if (hard.productIntent === 'generator' && hard.singlePhase220 === true) {
    const phase = generatorPhaseProfile(product);
    if (phase === 'mixed_220_380' || phase === 'three_phase_380') return null;
  }

  let score = 0;
  if (hard.weightKgMin || hard.weightKgMax) {
    const weight = extractWeightKg(product);
    if (weight === undefined) {
      score += 140;
    } else {
      if (hard.weightKgMin && weight < hard.weightKgMin) {
        const deficit = hard.weightKgMin - weight;
        if (deficit > Math.max(40, hard.weightKgMin * 0.35)) return null;
        score += deficit * 18;
      }
      if (hard.weightKgMax && weight > hard.weightKgMax) {
        const excess = weight - hard.weightKgMax;
        if (excess > Math.max(40, hard.weightKgMax * 0.6)) return null;
        score += excess * 10;
      }
    }
  }
  if (hard.diameterMmMin || hard.diameterMmMax) {
    const dimension = extractDimensionMm(product);
    if (dimension === undefined) {
      score += 140;
    } else {
      if (hard.diameterMmMin && dimension < hard.diameterMmMin) score += (hard.diameterMmMin - dimension) * 1.2;
      if (hard.diameterMmMax && dimension > hard.diameterMmMax) score += (dimension - hard.diameterMmMax) * 1.2;
    }
  }

  if (hard.startType === 'electric' && !flags.hasElectricStart) score += 280;
  if (hard.enclosure === 'enclosed' && !flags.hasGeneratorEnclosureSignal) score += 360;
  if (hard.enclosure === 'open' && flags.hasGeneratorEnclosureSignal && !flags.hasOpenFrameSignal) score += 240;
  if (hard.conventionalGenerator === true && flags.isInverter) score += 160;
  if (hard.conventionalGenerator === false && !flags.isInverter && flags.isGenerator) score += 180;

  if (hard.budgetMax) {
    const price = product.price;
    if (typeof price !== 'number') {
      score += 240;
    } else if (price > hard.budgetMax * 1.02) {
      const over = price - hard.budgetMax;
      const ceiling = hard.budgetMax + Math.max(10_000, hard.budgetMax * 0.35);
      if (price > ceiling) return null;
      score += 40 + over / 100;
    }
  }

  const powerRange = powerCriteriaFromSelection(hard);
  if (powerRange) {
    const power = extractGeneratorPowerForHardSelection(product);
    if ((powerRange.nominalMin || powerRange.nominalMax) && power.nominalKw === undefined) {
      score += 260;
    } else if (power.nominalKw !== undefined) {
      if (powerRange.nominalMin && power.nominalKw < powerRange.nominalMin - 0.4) {
        const deficit = powerRange.nominalMin - power.nominalKw;
        if (deficit > Math.max(1, powerRange.nominalMin * 0.45)) return null;
        score += 70 + deficit * 160;
      } else if (powerRange.nominalMin && power.nominalKw < powerRange.nominalMin) {
        score += (powerRange.nominalMin - power.nominalKw) * 80;
      }
      if (powerRange.nominalMax && power.nominalKw > powerRange.nominalMax + 0.8) {
        const excess = power.nominalKw - powerRange.nominalMax;
        if (excess > Math.max(2, powerRange.nominalMax * 0.9)) return null;
        score += 60 + excess * 45;
      }
    }
    if (powerRange.maxMin && power.maxKw !== undefined && power.maxKw < powerRange.maxMin - 0.5) {
      score += 70 + (powerRange.maxMin - power.maxKw) * 120;
    }
  }

  if (!productMeetsCalculatedLoad(product, state)) score += 420;
  const penalty = productFitPenalty(product, profile);
  if (penalty <= -260) return null;
  if (penalty < 0) score += Math.abs(penalty) * 0.35;
  return score;
}

function nearestCatalogShortlistAlternatives(
  products: Product[],
  matchedProducts: Product[],
  state: ProductSelectionState,
  profile: ProductFitProfile,
  limit: number,
  excludedProductIds = new Set<string>()
) {
  if (limit <= 0) return [];
  const matchedIds = new Set(matchedProducts.map((product) => product.id));
  const scored = products
    .filter((product) => !matchedIds.has(product.id))
    .filter((product) => !excludedProductIds.has(product.id))
    .map((product) => {
      const score = catalogShortlistAlternativeScore(product, state, profile);
      return score === null ? null : { product, score };
    })
    .filter((item): item is { product: Product; score: number } => Boolean(item))
    .sort((a, b) => {
      const score = a.score - b.score;
      if (score !== 0) return score;
      return Number(a.product.price ?? Number.MAX_SAFE_INTEGER) - Number(b.product.price ?? Number.MAX_SAFE_INTEGER);
    });
  const nearest = scored.filter((item) => item.score < 300);
  return (nearest.length ? nearest : scored)
    .slice(0, limit)
    .map((item) => item.product);
}

function nearestHeavyPlateTargetProducts(
  products: Product[],
  matchedProducts: Product[],
  state: ProductSelectionState,
  profile: ProductFitProfile,
  targetKg: number,
  limit: number
) {
  const hard = state.hardConstraints;
  if (limit <= 0 || hard.productIntent !== 'plate' || targetKg < 600) return [];
  if (hard.exactModelConstraint || hard.exactModelTokens.length) return [];
  const matchedIds = new Set(matchedProducts.map((product) => product.id));
  const requestedBrand = new Set([normalizeBrandKey(hard.brandConstraint)].filter((item) => item.length >= 3));
  const lower = Math.max(500, Math.floor(targetKg * 0.65));
  const upper = Math.ceil(targetKg * 1.35);
  const scored = products
    .filter((product) => !matchedIds.has(product.id))
    .filter((product) => productMatchesIntent(product, 'plate'))
    .filter((product) => hard.productRole !== 'coreProduct' || isCoreEquipment(product))
    .filter((product) => !effectiveExcludedClassesForState(state).some((intent) => productMatchesIntent(product, intent as ProductIntent)))
    .filter((product) => requestedBrand.size === 0 || productMatchesRequestedBrand(product, requestedBrand))
    .map((product) => {
      const weight = extractWeightKg(product);
      if (weight === undefined || weight < lower || weight > upper) return null;
      const flags = classifyProduct(product);
      if (hard.fuel === 'gasoline' && flags.isDiesel) return null;
      if (hard.fuel === 'diesel' && flags.isGasoline) return null;
      const penalty = productFitPenalty(product, profile);
      if (penalty <= -260) return null;
      return {
        product,
        score: Math.abs(weight - targetKg) + (weight < targetKg ? 20 : 0) + Math.max(0, -penalty) * 0.25
      };
    })
    .filter((item): item is { product: Product; score: number } => Boolean(item))
    .sort((a, b) => {
      const score = a.score - b.score;
      if (score !== 0) return score;
      return Number(a.product.price ?? Number.MAX_SAFE_INTEGER) - Number(b.product.price ?? Number.MAX_SAFE_INTEGER);
    });
  return scored.slice(0, limit).map((item) => item.product);
}

function missingQuestionsForSelection(state: ProductSelectionState, totalMatched: number) {
  const hard = state.hardConstraints;
  const uncertainties = [...state.unknowns];
  if (hard.productIntent === 'generator' && !hasReliableGeneratorSelectionBasis(state)) {
    return uniqueList([
      ...uncertainties,
      'catalog_uncertainty:generator_load_or_power_basis_missing'
    ], 4).slice(0, 2);
  }
  if (totalMatched <= LARGE_SLICE_VISIBLE_CARDS) return state.unknowns.slice(0, 2);
  const questions = [...uncertainties];
  if (hard.productIntent === 'generator') {
    if (!hard.nominalPowerKwMin && !hard.nominalPowerKwMax) questions.push('catalog_uncertainty:generator_nominal_power_unspecified');
    if (!hard.startType) questions.push('catalog_uncertainty:generator_start_type_unspecified');
  }
  if (['plate', 'rammer', 'roller'].includes(hard.productIntent)) {
    if (!hard.weightKgMin && !hard.weightKgMax) questions.push('catalog_uncertainty:compaction_weight_class_unspecified');
    questions.push('catalog_uncertainty:compaction_material_unspecified');
  }
  if (['diamondBlade', 'diamondCore', 'cutter'].includes(hard.productIntent)) {
    if (!hard.diameterMmMin && !hard.diameterMmMax) questions.push('catalog_uncertainty:tooling_diameter_unspecified');
    questions.push('catalog_uncertainty:cutting_material_unspecified');
  }
  return uniqueList(questions, 3);
}

function selectionMetadata(result: ProductSelectionResult): ProductSelectionMetadata {
  return {
    matchedProductIds: result.matchedProducts.map((product) => product.id),
    visibleProductIds: result.visibleProducts.map((product) => product.id),
    hiddenProductIds: result.hiddenProducts.map((product) => product.id),
    comparisonProductIds: result.comparisonProducts.map((product) => product.id),
    rejectedProducts: result.rejectedProducts,
    totalMatched: result.matchedProducts.length,
    selectionConfidence: result.confidence,
    missingQuestions: result.missingQuestions,
    loadProfile: result.state.loadProfile,
    rankingPreference: result.state.rankingPreference,
    activeHardConstraints: result.state.hardConstraints,
    selectionTrace: result.trace
  };
}

function productMatchesMemoryToken(product: Product, token: string) {
  const needle = compactModelText(token);
  return Boolean(needle && compactModelText(productFullText(product)).includes(needle));
}

function reconcileSemanticMemoryWithSelection(memory: SemanticMemory | undefined, result: ProductSelectionResult): SemanticMemory {
  const current = memory ?? emptySemanticMemory();
  if (!current.mentionedProducts.length) return current;
  const products = mergeProductsById([], [
    ...result.matchedProducts,
    ...result.visibleProducts,
    ...result.hiddenProducts,
    ...result.comparisonProducts
  ]);
  const rejectedIds = new Set(result.rejectedProducts.map((item) => item.productId));
  return {
    ...current,
    mentionedProducts: current.mentionedProducts.map((item) => {
      const matches = products.filter((product) => productMatchesMemoryToken(product, item.token));
      if (!matches.length) return item;
      return {
        ...item,
        productIds: uniqueList([...item.productIds, ...matches.map((product) => product.id)], 24),
        status: matches.some((product) => rejectedIds.has(product.id)) ? 'notMatchingRequirement' : 'foundInCatalog',
        updatedAt: new Date().toISOString()
      };
    })
  };
}

function memoryDecisionSummary(before: SemanticMemory | undefined, after: SemanticMemory | undefined) {
  return {
    activeRequirementIdsBefore: before?.activeRequirementIds ?? [],
    activeRequirementIdsAfter: after?.activeRequirementIds ?? [],
    mentionedProducts: (after?.mentionedProducts ?? []).map((item) => ({
      token: item.token,
      role: item.role,
      status: item.status,
      productIds: item.productIds
    })),
    selectionPolicy: after?.selectionPolicy
  };
}

function initialVisibleCardCountForCards(cards: ProductCard[], selectionResult: ProductSelectionResult, visibleCardLimit?: number) {
  if (!cards.length) return 0;
  const fallback = Math.min(cards.length, LARGE_SLICE_VISIBLE_CARDS);
  const selectionVisible = selectionResult.visibleProducts.length
    ? Math.min(selectionResult.visibleProducts.length, fallback)
    : fallback;
  const requested = visibleCardLimit ?? selectionVisible;
  return Math.max(1, Math.min(cards.length, requested));
}

function cardDisplayOptions(initialVisibleCount: number, cards: ProductCard[]): CardDisplayOptions | undefined {
  if (!cards.length || initialVisibleCount >= cards.length) return undefined;
  return { initialVisibleCount };
}

function finalCardsDecisionFromCards(cards: ProductCard[], selectionResult: ProductSelectionResult, plan: AssistantTurnPlan, initialVisibleCount = LARGE_SLICE_VISIBLE_CARDS): FinalCardsDecision {
  const visibleProductIds = cards.slice(0, initialVisibleCount).map((card) => card.id);
  const hiddenProductIds = [
    ...cards.slice(initialVisibleCount).map((card) => card.id),
    ...selectionResult.hiddenProducts.map((product) => product.id)
  ].filter((id, index, all) => !visibleProductIds.includes(id) && all.indexOf(id) === index);
  const source: FinalCardsDecision['source'] = isLeadPlan(plan)
    ? 'leadSelection'
    : !cards.length
      ? 'textOnly'
      : plan.selectedProductIds.length || selectionResult.visibleProducts.length
        ? 'selection'
        : 'turnContract';
  return {
    visibleProducts: cards.slice(0, initialVisibleCount).map(productFromCard),
    hiddenProducts: [
      ...cards.slice(initialVisibleCount).map(productFromCard),
      ...selectionResult.hiddenProducts
    ].filter((product, index, all) => product.id && all.findIndex((item) => item.id === product.id) === index),
    cards,
    initialVisibleCount,
    visibleProductIds,
    hiddenProductIds,
    source
  };
}

function exactAvailabilityInitialVisibleCount(
  baseCount: number,
  cards: ProductCard[],
  selectionResult: ProductSelectionResult,
  contract: AgentTurnContract
) {
  if (cards.length <= 3 || (contract.productCardsPolicy ?? 'none') === 'none') return baseCount;
  const hard = selectionResult.state.hardConstraints;
  const nominalMin = hard.nominalPowerKwMin;
  const nominalMax = hard.nominalPowerKwMax;
  if (!nominalMin || (nominalMax && Math.abs(nominalMax - nominalMin) > 0.2)) return baseCount;
  const leadingExactCards = cards.findIndex((card) => {
    const nominalKw = generatorPowerFromCard(card).nominalKw;
    return nominalKw === undefined || Math.abs(nominalKw - nominalMin) > 0.2;
  });
  const exactPrefixCount = leadingExactCards === -1 ? cards.length : leadingExactCards;
  if (exactPrefixCount <= 0 || exactPrefixCount >= cards.length) return baseCount;
  return Math.max(1, Math.min(baseCount, exactPrefixCount, 3));
}

function emptyCardContractDiagnostics(): CardContractDiagnostics {
  return {
    mentionedProductIds: [],
    addedCardIds: [],
    outsideFinalCardIds: [],
    reordered: false,
    firstCardAligned: true
  };
}

function detectAnswerCardContractViolation(
  answer: string,
  cards: ProductCard[],
  products: Product[],
  state: CustomerNeedState,
  userMessage: string,
  plan: AssistantTurnPlan
) {
  const emptyDiagnostics = emptyCardContractDiagnostics();
  if (!answer.trim()) return emptyDiagnostics;
  if (isLeadPlan(plan)) return emptyDiagnostics;
  if (plan.cardPolicy === 'textOnly' && plan.action !== 'recommend_products') return emptyDiagnostics;

  const profile = buildProductFitProfile(state, userMessage, plan.catalogSearchQuery, plan.requiredProductTraits);
  const byId = new Map<string, Product>();
  for (const card of cards) byId.set(card.id, productFromCard(card));
  for (const product of products) byId.set(product.id, product);

  const mentioned = [...byId.values()]
    .map((product) => ({ product, index: strongProductMentionIndex(product, answer) }))
    .filter((item) => item.index >= 0)
    .filter((item) => {
      const score = recommendationScore(item.product, state, userMessage, profile);
      return productMatchesSelectionCriteria(item.product, state.selectionState ?? emptyProductSelectionState(), profile) &&
        isCardWorthy(item.product, profile, score);
    })
    .sort((a, b) => a.index - b.index)
    .map((item) => item.product);

  if (!mentioned.length) return emptyDiagnostics;

  const currentIds = new Set(cards.map((card) => card.id));
  const mentionedIds = new Set(mentioned.map((product) => product.id));
  const outsideFinalCardIds = [...mentionedIds].filter((id) => !currentIds.has(id));

  return {
    mentionedProductIds: [...mentionedIds],
    addedCardIds: [],
    outsideFinalCardIds,
    reordered: false,
    firstCardAligned: cards[0] ? cards[0].id === mentioned[0]?.id : true
  };
}

function enforceAnswerCardContract(
  answer: string,
  cards: ProductCard[],
  products: Product[],
  state: CustomerNeedState,
  userMessage: string,
  plan: AssistantTurnPlan
) {
  return {
    cards,
    diagnostics: detectAnswerCardContractViolation(answer, cards, products, state, userMessage, plan)
  };
}

function repairAnswerCardText(answer: string, cards: ProductCard[], plan: AssistantTurnPlan) {
  let clean = answer.trim();
  if (!clean) return clean;
  if (!cards.length) {
    return clean;
  }
  const firstProduct = productFromCard(cards[0]);
  clean = clean.split(/(?<=[.!?\n])\s+/u).map((sentence) => {
    const hasFirstCardOrderClaim = /(?:перв(?:ой|ая|ую|ым)\s+карточк|first\s+card)/iu.test(sentence);
    if (!hasFirstCardOrderClaim) return sentence;
    if (strongProductMentionIndex(firstProduct, sentence) >= 0) return sentence;
    const mentionsOtherVisibleCard = cards.slice(1).some((card) => strongProductMentionIndex(productFromCard(card), sentence) >= 0);
    if (!mentionsOtherVisibleCard) return sentence;
    return sentence
      .replace(/показан[ао]?\s+перв(?:ой|ая|ую|ым)\s+карточк(?:ой|а|у|и)?/giu, 'есть среди карточек')
      .replace(/перв(?:ой|ая|ую|ым)\s+карточк(?:ой|а|у|и)?/giu, 'среди карточек')
      .replace(/first\s+card/giu, 'visible cards');
  }).join(' ');
  const firstMentioned = strongProductMentionIndex(firstProduct, clean) >= 0;
  const startsWithDanglingReference = /^(?:[-–—]\s*)?(?:это|он|она|они|такой|такая|вариант)/iu.test(clean) ||
    /(?:самый|лучший|главный|удобный|бюджетный)[^.!?\n]{0,80}[—-]\s*$/iu.test(clean);
  if (firstMentioned && !startsWithDanglingReference) return clean;
  const priceText = typeof cards[0].price === 'number'
    ? ` за ${Math.round(cards[0].price).toLocaleString('ru-RU')} ${cards[0].currency ?? 'RUB'}`
    : '';
  const prefix = `Основной вариант по текущим критериям — ${cards[0].name}${priceText}.`;
  if (startsWithDanglingReference) {
    return `${prefix}\n\n${clean.replace(/^(?:[-–—]\s*)?(?:это|он|она|они)\s*/iu, '')}`;
  }
  if (plan.answerMode === 'productRecommendation' || plan.action === 'recommend_products') {
    return `${prefix}\n\n${clean}`;
  }
  return clean;
}

function repairCardPhaseFactContradictions(answer: string, cards: ProductCard[]) {
  if (!cards.length) return answer;
  const singlePhaseProducts = cards
    .map(productFromCard)
    .filter((product) => generatorPhaseProfile(product) === 'single_220');
  if (!singlePhaseProducts.length) return answer;

  let lastMentionedSinglePhase: Product | null = null;
  return answer.split(/(?<=[.!?\n])\s+/u).map((sentence) => {
    const mentioned = singlePhaseProducts.find((product) => strongProductMentionIndex(product, sentence) >= 0);
    if (mentioned) lastMentionedSinglePhase = mentioned;
    const refersToPrevious = Boolean(lastMentionedSinglePhase && /^(?:но\s+)?он(?=$|[^\p{L}\p{N}_])/iu.test(sentence.trim()));
    const target = mentioned ?? (refersToPrevious ? lastMentionedSinglePhase : null);
    if (!target) return sentence;

    const claimsThreePhase = /(?:тр[её]х\s*фаз|тр[её]хфаз|3\s*фаз|230\s*\/\s*400|220\s*\/\s*380|380\s*\/\s*220|380\s*в|400\s*в)/iu.test(sentence);
    const deniesSinglePhase = /не\s+строго\s+однофазн|не\s+однофазн/iu.test(sentence);
    if (!claimsThreePhase && !deniesSinglePhase) return sentence;

    if (deniesSinglePhase || /^(?:но\s+)?он(?=$|[^\p{L}\p{N}_])/iu.test(sentence.trim())) {
      return 'Он однофазный 230 В (рабочий класс 220 В).';
    }
    return sentence
      .replace(/тр[её]х\s*фазн(?:ый|ая|ые)?|тр[её]хфазн(?:ый|ая|ые)?|3\s*фазн(?:ый|ая|ые)?/giu, 'однофазный')
      .replace(/(?:230\s*\/\s*400|220\s*\/\s*380|380\s*\/\s*220|380|400)\s*В?/giu, '230 В');
  }).join(' ');
}

function formatKwValue(value?: number | null) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '';
  const rounded = Math.round(value * 10) / 10;
  return (Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1)).replace('.', ',');
}

function isExplicitCommercialQuestion(message: string) {
  return /(?:\u0434\u043e\u0441\u0442\u0430\u0432|\u043b\u043e\u0433\u0438\u0441\u0442|\u0441\u043a\u0438\u0434|\u0443\u0441\u043b\u043e\u0432|\u043d\u0430\u043b\u0438\u0447|\u0441\u043a\u043b\u0430\u0434|\u043e\u0442\u0433\u0440\u0443\u0437|\u0441\u0443\u043c\u043c|\u0441\u0442\u043e\u0438\u043c|\u0446\u0435\u043d|\u043e\u0444\u043e\u0440\u043c|\u0437\u0430\u043a\u0430\u0437|delivery|shipping|discount|price|cost|stock|order|terms)/iu.test(message);
}

function isMixedCatalogAndCommercialQuestion(message: string, contract?: AgentTurnContract | null) {
  const asksCatalogSelection = contract?.catalogAction === 'find_matching_products' ||
    contract?.cardsRole === 'primary' ||
    contract?.productCardsPolicy === 'show_matching_products' ||
    /(?:\u043f\u043e\u043a\u0430\u0436|\u043f\u043e\u0434\u0431\u0435\u0440|\u043a\u0430\u043a\u0438\u0435\s+[^.!?\n]{0,80}(?:\u0435\u0441\u0442\u044c|\u043c\u043e\u0434\u0435\u043b|\u0432\u0430\u0440\u0438\u0430\u043d\u0442)|\u0447\u0442\u043e\s+[^.!?\n]{0,80}\u0435\u0441\u0442\u044c|show|which\s+models|what\s+.*available)/iu.test(message);
  if (!asksCatalogSelection) return false;
  const hasProductNeed = inferProductIntent(message) !== 'unknown' ||
    (contract?.activeNeeds ?? []).some((need) => coerceProductIntent(need.productClass) !== 'unknown');
  return hasProductNeed && isExplicitCommercialQuestion(message);
}

function isCommercialQuestionAboutShownProducts(message: string) {
  return isExplicitCommercialQuestion(message) &&
    /(?:из\s+этих|из\s+этого|по\s+этим|этих\s+модел|эти\s+модел|этих\s+вариант|эти\s+вариант|показанн|выбранн|из\s+карточек|по\s+карточкам|по\s+ним|по\s+позициям)/iu.test(message);
}

function isDeliveryDiscountPriceQuestion(message: string) {
  return /(?:\u0434\u043e\u0441\u0442\u0430\u0432|\u043b\u043e\u0433\u0438\u0441\u0442|\u0441\u043a\u0438\u0434|\u0441\u0443\u043c\u043c|\u0441\u0442\u043e\u0438\u043c|\u0446\u0435\u043d|\u0443\u0441\u043b\u043e\u0432|\u043e\u0444\u043e\u0440\u043c|\u0437\u0430\u043a\u0430\u0437|delivery|shipping|discount|price|cost|order|terms)/iu.test(message);
}

function isContactRefusalTechnicalSummaryRequest(message: string) {
  return /(?:\u0431\u0435\u0437\s+\u0437\u0432\u043e\u043d|\u043d\u0435\s+\u0437\u0432\u043e\u043d|\u043f\u043e\u043a\u0430\s+\u0431\u0435\u0437|\u043d\u0435\s+\u043e\u0441\u0442\u0430\u0432)/iu.test(message) &&
    /(?:\u0442\u0435\u0445\u043d\u0438\u043a|\u0447\u0442\u043e\s+\u0441\u0435\u0439\u0447\u0430\u0441\s+\u0431\u0440\u0430\u0442|\u0433\u0435\u043d\u0435\u0440\u0430\u0442|\u0432\u0438\u0431\u0440\u043e\u043f\u043b\u0438\u0442|\u0443\u0442\u043e\u0447\u043d)/iu.test(message);
}

function shouldUseCommercialDeterministicFallback(contract: AgentTurnContract | undefined, message: string) {
  if (isShownProductChoiceOrComparisonQuestion(message)) return false;
  if (contract?.commercialAction !== 'explain_manager_required') return false;
  if (contract.answerTask === 'lead_handoff') return true;
  if (contract.currentFocus === 'commercial') return true;
  if (contract.taskType === 'pure_delivery' || contract.taskType === 'pure_availability') return true;
  if (contract.taskType === 'product_selection_with_delivery' && isExplicitCommercialQuestion(message)) return true;
  return isExplicitCommercialQuestion(message);
}

function shouldUseProactiveCommercialDeterministicAnswer(contract: AgentTurnContract | undefined, message: string) {
  if (isShownProductChoiceOrComparisonQuestion(message)) return false;
  if (contract?.commercialAction !== 'explain_manager_required') return false;
  if (contract.answerTask === 'lead_handoff') return true;
  if (contract.currentFocus === 'commercial') return true;
  if (contract.taskType === 'pure_delivery') return true;
  if (contract.taskType === 'product_selection_with_delivery' && isDeliveryDiscountPriceQuestion(message)) return true;
  return contract.catalogAction === 'none' && isDeliveryDiscountPriceQuestion(message);
}

function commercialFallbackCandidates(input: {
  cards: ProductCard[];
  selectionResult: ProductSelectionResult;
}) {
  const byId = new Map<string, Product>();
  const addProduct = (product: Product | ProductCard | undefined) => {
    if (!product?.id || !product.name) return;
    const normalized = 'reasons' in product ? productFromCard(product) : product;
    byId.set(normalized.id, normalized);
  };
  input.cards.forEach(addProduct);
  input.selectionResult.visibleProducts.forEach(addProduct);
  input.selectionResult.matchedProducts.forEach(addProduct);
  return [...byId.values()].filter((product) => typeof product.price === 'number' && Number.isFinite(product.price));
}

function cheapestProduct(products: Product[]) {
  return [...products].sort((a, b) => (a.price ?? Number.MAX_SAFE_INTEGER) - (b.price ?? Number.MAX_SAFE_INTEGER))[0];
}

function deterministicCommercialHandoffFallback(input: {
  cards: ProductCard[];
  selectionResult: ProductSelectionResult;
  contract?: AgentTurnContract;
  latestUserMessage?: string;
  leadContact?: ExtractedLeadContact;
}) {
  const message = input.latestUserMessage ?? '';
  if (!shouldUseCommercialDeterministicFallback(input.contract, message)) return '';

  const candidates = commercialFallbackCandidates(input);
  const generators = candidates.filter((product) => {
    const flags = classifyProduct(product);
    return flags.isGenerator || flags.isWeldingGenerator;
  });
  const plates = candidates.filter((product) => classifyProduct(product).isPlate);
  const generator = cheapestProduct(generators);
  const plate = cheapestProduct(plates);

  const lines = [
    'Доставка есть, но точную стоимость, сроки и условия посчитаю по адресу через логистику. Скидку и финальные коммерческие условия заранее не обещаю: их нужно сверить по выбранному комплекту перед оформлением.'
  ];

  if (generator && plate && typeof generator.price === 'number' && typeof plate.price === 'number') {
    lines.push(`По видимым карточкам нижний ориентир комплекта: ${generator.name} (${rubPrice(generator.price)}) плюс ${plate.name} (${rubPrice(plate.price)}), вместе примерно от ${rubPrice(generator.price + plate.price)} как предварительный ориентир по товарам.`);
  } else if (candidates.length) {
    const sorted = [...candidates].sort((a, b) => (a.price ?? 0) - (b.price ?? 0));
    const min = sorted[0]?.price;
    const max = sorted[sorted.length - 1]?.price;
    if (typeof min === 'number' && typeof max === 'number' && min !== max) {
      lines.push(`По текущим карточкам ценовой ориентир по отдельным позициям: от ${rubPrice(min)} до ${rubPrice(max)}. Общую сумму честно сложу после фиксации конкретного генератора и конкретной виброплиты.`);
    } else if (typeof min === 'number') {
      lines.push(`По текущей карточке ориентир по позиции: ${rubPrice(min)}. Общую сумму честно сложу после фиксации конкретного генератора и конкретной виброплиты.`);
    }
  } else {
    lines.push('Порядок суммы честно назову после фиксации двух карточек: генератора и виброплиты. Без цен из выбранных карточек не буду придумывать итоговую сумму.');
  }

  if (input.contract?.leadAllowed) {
    const hasLeadContact = Boolean(input.leadContact?.phone || input.leadContact?.email);
    const hasLeadName = Boolean(input.leadContact?.name);
    if (!hasLeadContact) {
      lines.push('Если хотите, оставьте имя и телефон: я передам выбранные позиции на проверку наличия, доставки и финальных условий, чтобы вернуться уже с точным ответом.');
    } else if (!hasLeadName) {
      lines.push('Телефон вижу. Напишите, пожалуйста, имя: тогда передам выбранные позиции на проверку наличия, доставки и финальных условий.');
    }
  } else {
    lines.push('Пока можно продолжать без звонка: сначала доведем подбор до конкретной пары моделей, затем уже сверю коммерческую часть.');
  }

  return lines.join('\n\n');
}

function deterministicTechnicalSummaryRecovery(input: {
  cards: ProductCard[];
  state: ProductSelectionState;
  latestUserMessage?: string;
}) {
  const products = input.cards.map(productFromCard);
  const generator = products.find((product) => {
    const flags = classifyProduct(product);
    return flags.isGenerator || flags.isWeldingGenerator;
  });
  const plate = products.find((product) => classifyProduct(product).isPlate);
  const load = input.state.loadProfile;
  const nominal = formatKwValue(load?.requiredNominalKw);
  const starting = formatKwValue(load?.requiredStartingKw);
  const generatorLoadNotes = generatorTechnicalLoadNotes(load, input.latestUserMessage);
  const generatorLine = generator
    ? `По генератору сейчас держал бы ориентир на класс ${nominal || '5-6'} кВт по номиналу${starting ? `, пусковая нагрузка около ${starting} кВт` : ''}. ${generatorLoadNotes}Из уже показанных вариантов можно смотреть ${generator.name}, но финально надо сверить мощность или модель скважинного насоса на шильдике.`
    : `По генератору сейчас держал бы ориентир на класс ${nominal || '5-6'} кВт по номиналу${starting ? `, пусковая нагрузка около ${starting} кВт` : ''}. ${generatorLoadNotes}Финально надо сверить мощность или модель скважинного насоса на шильдике.`;
  const plateLine = plate
    ? `По виброплите под дорожки, песок и плитку логичен легкий класс около 50-60 кг: ${plate.name} остается нормальной отправной точкой, потому что ее проще грузить и переносить одному.`
    : 'По виброплите под дорожки, песок и плитку логичен легкий класс около 50-60 кг: тяжелее брать стоит только если щебня будет больше и переноска уже не главный фактор.';
  const targetClass = input.state.targetProductClass;
  const hardIntent = input.state.hardConstraints?.productIntent;
  const hasGeneratorContext = Boolean(
    generator ||
    input.state.loadProfile ||
    targetClass === 'generator' ||
    hardIntent === 'generator'
  );
  const hasPlateContext = Boolean(
    plate ||
    targetClass === 'plate' ||
    hardIntent === 'plate'
  );
  const lines = ['Без звонка, продолжаем по технике.'];
  if (hasGeneratorContext || !hasPlateContext) lines.push(generatorLine);
  if (hasPlateContext) lines.push(plateLine);
  if (hasGeneratorContext && hasPlateContext) {
    lines.push('Что еще уточнить для точного выбора: мощность/модель насоса, будет ли болгарка работать одновременно с насосом, и какой вес виброплиты вам комфортно грузить одному.');
  } else if (hasGeneratorContext || !hasPlateContext) {
    lines.push('Что еще уточнить для точного выбора генератора: мощность или модель насоса на шильдике и будут ли насос, холодильник и котел стартовать одновременно.');
  } else {
    lines.push('Что еще уточнить для точного выбора виброплиты: основание, толщину слоя щебня и какой вес вам реально удобно грузить одному.');
  }
  return lines.join('\n\n');
}

function generatorTechnicalLoadNotes(load?: ProductGeneratorLoadProfile | null, latestUserMessage = '') {
  const context = [
    latestUserMessage,
    ...(load?.items ?? []).map((item) => `${item.kind} ${item.name ?? ''} ${item.evidence ?? ''}`)
  ].join(' ').toLowerCase();
  const notes: string[] = [];
  if (/(?:компрессор|compressor)/iu.test(context)) {
    notes.push('компрессор 2,2 кВт лучше считать отдельным пусковым сценарием, а не включать вместе с чайником');
  }
  if (/(?:скважин|borehole|well pump)/iu.test(context)) {
    notes.push('скважинный насос остается главным пусковым риском');
  }
  if (/(?:кот[её]л|boiler|холодильник|морозил|fridge|freezer|роутер|камер|router|camera)/iu.test(context)) {
    notes.push('котел, холодильник/морозилка и связь идут как постоянная базовая нагрузка');
  }
  if (/(?:дизель\s+не|не\s+хочу\s+дизел|лучше\s+бензин|gasoline|бензинов)/iu.test(context)) {
    notes.push('смотрел бы бензиновый 220 В, без дизеля');
  }
  return notes.length ? `Учитываю так: ${notes.slice(0, 4).join('; ')}. ` : '';
}

function isPlateWeightTechnicalQuestion(text: string) {
  const normalized = text.toLowerCase();
  const asksCatalogOrCommercial = /(?:покаж|вариант|модел|карточ|каталог|налич|склад|достав|скид|заказ|оформ)/iu.test(normalized);
  if (asksCatalogOrCommercial || isExplicitCommercialQuestion(text) || isMixedCatalogAndCommercialQuestion(text)) return false;
  const hasPlate = /(?:вибро\s*плит|виброплит|plate\s*compactor)/iu.test(normalized);
  const asksWeightOrUse =
    /(?:вес|кг|килограмм|груз|перевоз|тащить|сам|одному|песок|щеб|основан|трамб|уплотн)/iu.test(normalized);
  return hasPlate && asksWeightOrUse;
}

function deterministicPlateWeightOrientation(userMessage: string) {
  if (!isPlateWeightTechnicalQuestion(userMessage)) return '';
  const normalized = userMessage.toLowerCase();
  const selfLoad = /(?:сам|одному|груз|перевоз|багаж|прицеп|тащить)/iu.test(normalized);
  const heavyDuty = isHeavyDutyPlateNeed(userMessage);
  if (heavyDuty) {
    const lines = [
      'Для такой бизнес-задачи легкий класс 60-80 кг я бы не ставил основным: щебень 20-40, слой 15-20 см и площади 200-400 м2 требуют уже профессионального уплотнения.',
      'Практичный ориентир - реверсивная виброплита примерно 150-300 кг: ближе к 150-200 кг, если важна мобильность бригады, и ближе к 250-300 кг, если катка часто нет и нужно увереннее работать по щебеночному основанию.',
      'Смотреть нужно не только вес, но и центробежную силу, размер подошвы, реверс, ресурс двигателя и насколько реально грузить машину в вашу Газель/на аппарели.',
      'Если основание ответственное или слой идет за один проход, каток все равно лучше планировать как основной инструмент, а виброплиту использовать для зон, куда каток не проходит.'
    ];
    return lines.join('\n\n');
  }
  const smallPaving = isSmallSitePlateNeed(userMessage) || /(?:плитк|въезд|песок|щеб|двор|дорож)/iu.test(normalized);
  const lines = [
    smallPaving
      ? 'Для небольшого въезда под плитку по песку и щебню я бы сначала смотрел прямоходную бензиновую виброплиту примерно 60-80 кг, а не самый тяжелый класс.'
      : 'По виброплите сначала держал бы ориентир на прямоходный бензиновый класс примерно 60-80 кг, если это не дорожные работы и не большой слой щебня.'
  ];

  if (selfLoad) {
    lines.push('Если грузить будете один, ближе к 60-70 кг будет заметно спокойнее по погрузке и переноске. 70-80 кг уже плотнее работает по основанию, но ее сложнее регулярно поднимать без помощника или нормальной рампы.');
  } else {
    lines.push('Если есть помощник, рампа или прицеп, можно смотреть ближе к 70-80 кг: по основанию запас лучше, но это все еще не чрезмерно тяжелый класс для частного участка.');
  }

  lines.push('90 кг и тяжелее имеет смысл брать только если уплотнение щебня важнее удобной погрузки, либо есть чем спокойно грузить и возить плиту.');
  lines.push('Если будете проходить уже уложенную тротуарную плитку, нужна полиуретановая или резиновая накладка, иначе можно побить поверхность.');
  lines.push('Следующим шагом логично смотреть в каталоге прямоходные бензиновые плиты примерно 60-80 кг; тяжелее я бы рассматривал только если готовы решать погрузку.');
  return lines.join('\n\n');
}

function isTechnicalUnknownModelStatement(text: string) {
  const normalized = text.toLowerCase();
  return /(?:модел[ьи]|марку|артикул)[^.!?\n]{0,40}(?:не\s+(?:знаю|помню|скажу|известн)|неизвестн|нет)|(?:не\s+(?:знаю|помню|скажу)[^.!?\n]{0,40}(?:модел[ьи]|марку|артикул))/iu.test(normalized);
}

function isCatalogSelectionRequestText(text: string) {
  const normalized = text.toLowerCase();
  const explicitCatalogAction = /(?:покаж|подбер[иите]|подбор|вариант|карточ|каталог|что\s+есть|какие\s+есть|из\s+каталог|в\s+каталог|налич|склад|достав|скид|заказ|оформ)/iu.test(normalized);
  const modelSelectionAction = /(?:какие\s+модел|модел[ьи][^.!?\n]{0,50}(?:есть|покаж|подход|вариант|из\s+каталог|в\s+каталог|посовет|предлож)|модель[^.!?\n]{0,50}(?:подойдет|выбрать|посовет|предлож))/iu.test(normalized);
  const unknownModelOnly = isTechnicalUnknownModelStatement(normalized) && !explicitCatalogAction && !modelSelectionAction;
  return !unknownModelOnly && (explicitCatalogAction || modelSelectionAction);
}

function shouldUseFastTechnicalOrientation(input: {
  userMessage: string;
  needState: CustomerNeedState;
  history: Message[];
}) {
  const plateWeightQuestion = isPlateWeightTechnicalQuestion(input.userMessage);
  if (allShownProductCards(input.history).length && !plateWeightQuestion) return false;
  if (isExplicitCommercialQuestion(input.userMessage) || isMixedCatalogAndCommercialQuestion(input.userMessage)) return false;
  if (isCatalogSelectionRequestText(input.userMessage)) return false;

  const activeClasses = new Set(
    (input.needState.activeNeeds ?? [])
      .map((need) => need.productClass)
      .filter(Boolean)
  );
  const hardIntent = input.needState.selectionState?.hardConstraints?.productIntent;
  const targetClass = input.needState.selectionState?.targetProductClass;
  const messageIntent = inferProductIntent(input.userMessage);
  const hasTechnicalProductContext =
    activeClasses.has('generator') ||
    activeClasses.has('plate') ||
    hardIntent === 'generator' ||
    hardIntent === 'plate' ||
    targetClass === 'generator' ||
    targetClass === 'plate' ||
    messageIntent === 'generator' ||
    messageIntent === 'plate';
  if (!hasTechnicalProductContext) return false;

  return plateWeightQuestion ||
    /(?:подскаж|какой|какая|какую|лучше|подойдет|хватит|мощн|ориентир|подбор|взять|тянул|тянуть|для\s+дома)/iu.test(input.userMessage);
}

function shouldUseFastCatalogSelection(input: {
  userMessage: string;
  needState: CustomerNeedState;
  history: Message[];
}) {
  if (!isCatalogSelectionRequestText(input.userMessage)) return false;
  if (isExplicitCommercialQuestion(input.userMessage) || isMixedCatalogAndCommercialQuestion(input.userMessage)) return false;
  if (isShownProductChoiceOrComparisonQuestion(input.userMessage) && allShownProductCards(input.history).length > 0) return false;

  const selection = input.needState.selectionState;
  if (!selection) return false;
  const targetProductClass = selection.targetProductClass !== 'unknown'
    ? selection.targetProductClass
    : selection.hardConstraints.productIntent;
  if (targetProductClass === 'unknown') return false;

  const activeNeedMatches = (input.needState.activeNeeds ?? []).some((need) => need.productClass === targetProductClass);
  const hasSelectionBasis = hasMaterialHardConstraints(selection) ||
    Boolean(selection.loadProfile?.requiredNominalKw) ||
    Boolean(selection.loadProfile?.items?.length) ||
    Boolean(selection.activeRequirement);
  return hasSelectionBasis && (activeNeedMatches || selection.confidence >= 0.55);
}

function deterministicEstimatedPumpClarificationQuestion(_missingQuestion?: string) {
  return 'Уточните, пожалуйста: какой насос стоит и какая у него мощность или модель на шильдике?';
}

function deterministicAnswerGenerationFallback(input: {
  cards: ProductCard[];
  selectionResult: ProductSelectionResult;
  structuredCatalogSlice: StructuredCatalogSlice | null;
  finalCards: FinalCardsDecision;
  contract?: AgentTurnContract;
  latestUserMessage?: string;
}) {
  const commercialFallback = deterministicCommercialHandoffFallback(input);
  if (commercialFallback) return commercialFallback;

  if (input.contract?.answerTask === 'comparison' && input.selectionResult.state.hardConstraints.productIntent === 'plate') {
    const range = parseWeightNeedRangeKg(input.latestUserMessage ?? '');
    const rangeText = range ? `${range.min}-${range.max} кг` : 'более тяжелая плита';
    return `Да, ${rangeText} обычно уплотняет заметно увереннее, чем 80-90 кг: по песку и небольшому щебню основание получается плотнее, меньше проходов и лучше подготовка под плитку.\n\nКомпромисс в погрузке: 80-90 кг проще возить одному, а 100-120 кг уже лучше по работе, но тяжелее для самостоятельной загрузки. Для финишной проходки по уложенной плитке нужна резиновая или полиуретановая накладка.`;
  }

  if (shouldBlockGeneratorCardsForEstimatedPump(input.selectionResult.state)) {
    return deterministicEstimatedPumpClarificationQuestion(input.selectionResult.missingQuestions[0]);
  }

  const catalogAnswer = input.structuredCatalogSlice
    ? deterministicCatalogSliceAnswer(input.structuredCatalogSlice, input.cards)
    : '';
  if (catalogAnswer.trim()) return catalogAnswer;

  const lines: string[] = [];
  const load = input.selectionResult.state.loadProfile;
  if (load?.requiredNominalKw) {
    const nominal = formatKwValue(load.requiredNominalKw);
    const starting = formatKwValue(load.requiredStartingKw);
    lines.push(starting
      ? `По указанной нагрузке ориентир для генератора: от ${nominal} кВт номинальной мощности, пусковая нагрузка около ${starting} кВт.`
      : `По указанной нагрузке ориентир для генератора: от ${nominal} кВт номинальной мощности.`);
  }

  if (input.cards.length) {
    const first = input.cards[0];
    const priceText = typeof first.price === 'number'
      ? ` за ${Math.round(first.price).toLocaleString('ru-RU')} ${first.currency ?? 'RUB'}`
      : '';
    lines.push(`Основной вариант по текущим критериям — ${first.name}${priceText}.`);

    const visibleAlternativeCount = Math.max(2, input.finalCards.initialVisibleCount);
    const alternatives = input.cards.slice(1, visibleAlternativeCount).map((card) => card.name).filter(Boolean);
    if (alternatives.length) lines.push(`Запасной вариант: ${alternatives[0]}.`);

    const hiddenCount = Math.max(0, input.finalCards.hiddenProductIds.length);
    if (hiddenCount) lines.push(`Еще ${hiddenCount} подходящ${hiddenCount === 1 ? 'ий вариант' : 'их вариантов'} оставил под кнопкой "Показать еще".`);

    const question = input.selectionResult.missingQuestions[0];
    if (question) lines.push(`Чтобы точнее сузить выбор, уточните: ${question}`);
    return lines.filter(Boolean).join('\n\n');
  }

  const question = input.selectionResult.missingQuestions[0];
  if (question) {
    return `По текущим данным пока не вижу надежной карточки, которую можно честно рекомендовать. Уточните: ${question}`;
  }
  return 'По текущим данным пока не вижу надежной карточки, которую можно честно рекомендовать. Опишите задачу, условия работы и важные ограничения — подберу вариант по каталогу.';
}

function deterministicFinalCardsAnswer(cards: ProductCard[]) {
  if (!cards.length) return 'По текущему запросу не вижу надежной карточки, которую можно честно рекомендовать. Лучше уточнить задачу и ограничения, чтобы не подставить неподходящий товар.';
  const first = cards[0];
  const priceText = typeof first.price === 'number'
    ? ` за ${Math.round(first.price).toLocaleString('ru-RU')} ${first.currency ?? 'RUB'}`
    : '';
  const alternatives = cards.slice(1, 3).map((card) => card.name).filter(Boolean);
  const tail = alternatives.length
    ? ` Из альтернатив в текущей подборке: ${alternatives.join('; ')}.`
    : '';
  return `Основной вариант по текущим критериям — ${first.name}${priceText}.${tail}`;
}

function repairAnswerForFinalCards(
  answer: string,
  cards: ProductCard[],
  products: Product[],
  state: CustomerNeedState,
  userMessage: string,
  plan: AssistantTurnPlan
) {
  let clean = repairAnswerCardText(repairCardPhaseFactContradictions(answer, cards), cards, plan);
  if (!cards.length && (plan.action === 'recommend_products' || plan.answerMode === 'productRecommendation')) {
    const mentionedWithoutCards = products.some((product) => strongProductMentionIndex(product, clean) >= 0);
    if (mentionedWithoutCards) return deterministicFinalCardsAnswer([]);
  }
  const firstDiagnostics = detectAnswerCardContractViolation(clean, cards, products, state, userMessage, plan);
  if (!firstDiagnostics.outsideFinalCardIds.length) return clean;

  const outsideProducts = products.filter((product) => firstDiagnostics.outsideFinalCardIds.includes(product.id));
  const sentences = clean
    .split(/(?<=[.!?\n])\s+/u)
    .map((sentence) => sentence.trim())
    .filter(Boolean)
    .filter((sentence) => !outsideProducts.some((product) => strongProductMentionIndex(product, sentence) >= 0));
  clean = repairAnswerCardText(sentences.join(' '), cards, plan);
  const secondDiagnostics = detectAnswerCardContractViolation(clean, cards, products, state, userMessage, plan);
  if (secondDiagnostics.outsideFinalCardIds.length || !clean.trim()) {
    return deterministicFinalCardsAnswer(cards);
  }
  return clean;
}

type GeneratorSizingPolicy = {
  calculatedMinimumNominalKw: number;
  calculatedStartingKw?: number;
  minimallySufficientNominalRangeKw: { min: number; max: number };
  visibleCardNominalKw: number[];
  visibleCardMaxKw: number[];
  allowedMentionedPowerKwMax: number;
};

function generatorPowerFromCard(card: ProductCard) {
  return extractGeneratorPowerForHardSelection(productFromCard(card));
}

function generatorSizingPolicyForAnswer(loadProfile?: ProductGeneratorLoadProfile | null, cards: ProductCard[] = []): GeneratorSizingPolicy | null {
  const required = loadProfile?.requiredNominalKw;
  if (!required || !Number.isFinite(required)) return null;
  const window = inferredLoadPowerWindow(required);
  const cardPowers = cards
    .map(generatorPowerFromCard)
    .filter((power) => power.nominalKw !== undefined || power.maxKw !== undefined);
  const visibleCardNominalKw = cardPowers
    .map((power) => power.nominalKw)
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  const visibleCardMaxKw = cardPowers
    .map((power) => power.maxKw)
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  return {
    calculatedMinimumNominalKw: required,
    calculatedStartingKw: loadProfile?.requiredStartingKw,
    minimallySufficientNominalRangeKw: window,
    visibleCardNominalKw,
    visibleCardMaxKw,
    allowedMentionedPowerKwMax: Math.max(window.max, ...visibleCardNominalKw, ...visibleCardMaxKw, required)
  };
}

function extractKwMentions(text: string) {
  return [...text.matchAll(/(\d+(?:[,.]\d+)?)\s*(?:[–—-]\s*(\d+(?:[,.]\d+)?))?\s*(?:кВт|kw)/giu)]
    .map((match) => {
      const first = Number(String(match[1]).replace(',', '.'));
      const second = match[2] ? Number(String(match[2]).replace(',', '.')) : first;
      if (!Number.isFinite(first) || !Number.isFinite(second)) return null;
      return {
        raw: match[0],
        min: Math.min(first, second),
        max: Math.max(first, second)
      };
    })
    .filter((item): item is { raw: string; min: number; max: number } => Boolean(item));
}

function containsCalculatedMinimumMention(mentions: { min: number; max: number }[], required: number) {
  return mentions.some((mention) => required >= mention.min - 0.25 && required <= mention.max + 0.25);
}

function deterministicGeneratorSizingAnswer(
  loadProfile: ProductGeneratorLoadProfile,
  cards: ProductCard[] = [],
  options: { blockEstimatedPumpCards?: boolean; missingQuestion?: string } = {}
) {
  if (options.blockEstimatedPumpCards) {
    return deterministicEstimatedPumpClarificationQuestion(options.missingQuestion);
  }
  const nominal = formatKwValue(loadProfile.requiredNominalKw);
  const starting = formatKwValue(loadProfile.requiredStartingKw);
  const lines = [
    starting
      ? `Расчетный минимум по указанной нагрузке: ${nominal} кВт по номиналу, пусковая нагрузка около ${starting} кВт.`
      : `Расчетный минимум по указанной нагрузке: ${nominal} кВт по номиналу.`
  ];
  const cardLines = cards
    .slice(0, 3)
    .map((card) => {
      const power = generatorPowerFromCard(card);
      const nominalPower = formatKwValue(power.nominalKw);
      const maxPower = formatKwValue(power.maxKw);
      const powerText = nominalPower
        ? `, ${nominalPower} кВт номинал${maxPower ? ` / ${maxPower} кВт максимум` : ''}`
        : '';
      const priceText = typeof card.price === 'number'
        ? `, ${Math.round(card.price).toLocaleString('ru-RU')} ${card.currency ?? 'RUB'}`
        : '';
      return `${card.name}${powerText}${priceText}`;
    });
  if (cardLines.length) {
    lines.push(`По карточкам можно смотреть: ${cardLines.join('; ')}. Если мощность карточки выше расчета, это доступный вариант с запасом, а не новый расчетный минимум.`);
  }
  return lines.join('\n\n');
}

function repairGeneratorLoadMinimumText(
  answer: string,
  loadProfile?: ProductGeneratorLoadProfile,
  options: { cards?: ProductCard[]; strictMinimumStatement?: boolean; blockEstimatedPumpCards?: boolean; missingQuestion?: string } = {}
) {
  const required = loadProfile?.requiredNominalKw;
  if (!required || !Number.isFinite(required)) return answer;
  if (loadProfile && options.blockEstimatedPumpCards) {
    return sanitizeVisibleAnswerNumbers(deterministicGeneratorSizingAnswer(loadProfile, [], {
      blockEstimatedPumpCards: true,
      missingQuestion: options.missingQuestion
    }));
  }
  const formatted = Number.isInteger(required) ? String(required) : String(required).replace('.', ',');
  const policy = generatorSizingPolicyForAnswer(loadProfile, options.cards ?? []);
  const mentions = extractKwMentions(answer);
  const unsupportedHigherPower = Boolean(policy && mentions.some((mention) => mention.max > policy.allowedMentionedPowerKwMax + 0.55));
  const strictMinimumMissing = Boolean(
    options.strictMinimumStatement &&
    mentions.some((mention) => mention.max > required + 0.35) &&
    !containsCalculatedMinimumMention(mentions, required)
  );
  if (loadProfile && (unsupportedHigherPower || strictMinimumMissing)) {
    return sanitizeVisibleAnswerNumbers(deterministicGeneratorSizingAnswer(loadProfile, options.cards ?? []));
  }
  let repaired = answer.replace(
    /((?:\u043c\u0438\u043d\u0438\u043c\u0443\u043c|\u043d\u0435\s+\u043d\u0438\u0436\u0435)[^.?!\n]{0,80}?)(\d+(?:[,.]\d+)?)\s*((?:\u043a\u0412\u0442|kw))/giu,
    (match, prefix: string, value: string, unit: string) => {
      const parsed = Number(String(value).replace(',', '.'));
      if (!Number.isFinite(parsed) || parsed <= required + 0.4) return match;
      return `${prefix}${formatted} ${unit}`;
    }
  );
  repaired = repaired.replace(
    /((?:\u043c\u0438\u043d\u0438\u043c\u0443\u043c|\u043d\u0435\s+\u043d\u0438\u0436\u0435|\u043e\u0440\u0438\u0435\u043d\u0442\u0438\u0440(?:\s+\u043f\u043e\s+\u0433\u0435\u043d\u0435\u0440\u0430\u0442\u043e\u0440\u0443)?|\u043d\u0443\u0436\u0435\u043d(?:\s+\u0433\u0435\u043d\u0435\u0440\u0430\u0442\u043e\u0440)?(?:\s+\u043e\u043a\u043e\u043b\u043e)?)\s*[:\u2014-]?\s*)(\d+(?:[,.]\d+)?)\s*(?:\u043a\u0412\u0442|kw)/giu,
    (match, prefix: string, value: string) => {
      const parsed = Number(String(value).replace(',', '.'));
      if (!Number.isFinite(parsed) || parsed <= required + 0.4) return match;
      return `${prefix}${formatted} кВт`;
    }
  );
  if (required <= 4) {
    repaired = repaired.replace(
      /5\s*(?:\u043a\u0412\u0442|kw)\s+\u043d\u043e\u043c\u0438\u043d\u0430\u043b\w*\s*\/\s*6\+?\s*(?:\u043a\u0412\u0442|kw)\s+\u043c\u0430\u043a\u0441\u0438\u043c\u0443\u043c/giu,
      `${formatted} кВт как расчетный минимум; 5 кВт - с дополнительным запасом`
    );
    repaired = repaired.replace(
      /\u043a\u043b\u0430\u0441\u0441\s+5\s*(?:\u043a\u0412\u0442|kw)\s+\u043d\u043e\u043c\u0438\u043d\u0430\u043b\w*/giu,
      `класс ${formatted} кВт как расчетный минимум`
    );
    repaired = repaired.replace(
      /от\s+5\s*(?:\u043a\u0412\u0442|kw)\s+\u043d\u043e\u043c\u0438\u043d\u0430\u043b\w*/giu,
      `${formatted} кВт номинала как расчетный минимум`
    );
    repaired = repaired.replace(
      /(?:(?:\u043c\u043e\u0434\u0435\u043b[ьи]\s+\u043d\u0430\s+)?4[-\s]?(?:\u043a\u0438\u043b\u043e\u0432\u0430\u0442\u0442\w*|\u043a\u0412\u0442)[^.?!]{0,120}(?:\u043d\u0430\s+\u0433\u0440\u0430\u043d\u0438|\u0432\s*\u043f\u0440\u0438\u0442\u044b\u043a|\u043a\u043e\u043c\u043f\u0440\u043e\u043c\u0438\u0441\u0441|\u043d\u0435\s+\u0443\u0432\u0435\u0440\u0435\u043d\w*)[^.?!]*[.?!]?)/giu,
      '4 кВт по номиналу здесь является расчетным минимумом; 5 кВт дает дополнительный спокойный запас, если цена устраивает.'
    );
  }
  return sanitizeVisibleAnswerNumbers(repaired);
}

function hasExplicitSinglePhase220Constraint(state?: ProductSelectionState | null) {
  const hard = state?.hardConstraints;
  if (!hard || hard.productIntent !== 'generator' || hard.singlePhase220 !== true) return false;
  const source = hard.provenance?.singlePhase220;
  return source === 'explicit_user' || source === 'previous_selection' || source === 'planner' || source === undefined;
}

function isExplicitPhaseReconfirmationSentence(sentence: string) {
  const normalized = sentence.toLowerCase();
  if (/(?:без|исключа|не\s+(?:беру|смотрю|рассматриваю|добавляю|включаю|предлагаю))/iu.test(normalized) && !normalized.includes('?')) {
    return false;
  }
  if (/(?:тр[её]х\s*фаз|тр[её]хфаз|3\s*фаз|230\s*\/\s*400|220\s*\/\s*380|380\s*\/\s*220|380\s*в|400\s*в|\b380\b|\b400\b)/iu.test(normalized)) {
    return true;
  }
  if (!/(?:220\s*\/\s*380|220\s*-\s*380|380\s*в|\b380\b)/iu.test(normalized)) return false;
  if (!/(?:220\s*в|230\s*в|\b220\b|\b230\b|однофаз)/iu.test(normalized)) return false;
  return /[?]/u.test(sentence) ||
    /(?:уточн|подтверд|нужн|строго|подойд|допустим|или|можно|рассматрива)/iu.test(normalized);
}

function repairExplicitPhaseReconfirmation(answer: string, state?: ProductSelectionState | null) {
  if (!hasExplicitSinglePhase220Constraint(state)) return answer;
  const segments = answer.split(/(\n+|(?<=[.!?])\s+)/u);
  let removed = false;
  const kept = segments.filter((segment) => {
    if (!segment.trim() || /^\s+$/u.test(segment) || /^\n+$/u.test(segment)) return true;
    if (!isExplicitPhaseReconfirmationSentence(segment)) return true;
    removed = true;
    return false;
  });
  if (!removed) return answer;
  const repaired = kept.join('').replace(/\n{3,}/gu, '\n\n').trim();
  const phaseAnchor = 'Фазность уже зафиксировал: показываю однофазные 220 В.';
  return repaired ? `${phaseAnchor}\n\n${repaired}` : phaseAnchor;
}

function repairAvailabilityAnswerWithCatalogModels(
  answer: string,
  contract: AgentTurnContract | undefined,
  selectionResult: ProductSelectionResult,
  options: { blockProductCards?: boolean } = {}
) {
  const availabilityTurn = contract?.taskType === 'pure_availability' ||
    contract?.taskType === 'product_selection_with_availability';
  if (!availabilityTurn) return answer;
  if (options.blockProductCards) return answer;
  if (shouldBlockGeneratorCardsForEstimatedPump(selectionResult.state)) return answer;
  const products = (selectionResult.visibleProducts.length
    ? selectionResult.visibleProducts
    : selectionResult.matchedProducts
  ).filter((product, index, all) => all.findIndex((item) => item.id === product.id) === index);
  if (!products.length) return answer;
  if (products.some((product) => strongProductMentionIndex(product, answer) >= 0)) return answer;

  const modelLine = products
    .slice(0, 3)
    .map((product) => typeof product.price === 'number'
      ? `${product.name} (${rubPrice(product.price)})`
      : product.name)
    .join('; ');
  const catalogLine = `Конкретно в каталоге вижу: ${modelLine}.`;
  return answer.trim() ? `${answer.trim()}\n\n${catalogLine}` : catalogLine;
}

function requestedVisibleCardLimitFromText(text: string): number | undefined {
  const normalized = text.toLowerCase().replace(/ё/g, 'е');
  if (/(?:сравн|отлич)/iu.test(normalized) &&
    !/(?:покажи|показать|дай|подбери|выбери|карточ|вариант|позиц)/iu.test(normalized)) {
    return undefined;
  }
  const explicitTwo = /(?:один|1)\s+(?:основн|главн|перв)[^.!?\n]{0,80}(?:и|\+|,)[^.!?\n]{0,80}(?:один|1)\s+(?:запасн|альтернатив)/iu.test(normalized) ||
    /(?:пару|два|две|2)\s+(?:вариант|модел|позици)/iu.test(normalized) ||
    /(?:вариант|модел|позици)[^.!?\n]{0,40}(?:пару|два|две|2)\b/iu.test(normalized) ||
    /(?:какой|что)\s+(?:вариант|модел|позици|генератор)[^.!?\n]{0,120}(?:перв|главн|основн|взял|брал)[^.!?\n]{0,120}(?:альтернатив|запасн)/iu.test(normalized);
  if (explicitTwo) return 2;

  const explicitOne = /(?:один|1)\s+(?:вариант|модель|позици|генератор|товар)\b/iu.test(normalized) ||
    /(?:выбери|покажи|дай|подбери|посоветуй)[^.!?\n]{0,50}(?:лучший|один)\s+(?:вариант|модель|генератор|товар)/iu.test(normalized);
  if (explicitOne) return 1;

  const numeric = normalized.match(/(?:покажи|дай|подбери|выбери|посоветуй)[^.!?\n]{0,50}\b([1-4])\s*(?:вариант|модел|позици|товар)/iu);
  if (numeric?.[1]) return Math.max(1, Math.min(4, Number(numeric[1])));

  return undefined;
}

function effectiveVisibleCardLimitFromConversation(userMessage: string, history: Message[], maxMessages = 8): number | undefined {
  const current = requestedVisibleCardLimitFromText(userMessage);
  if (current) return current;
  for (const message of [...history].slice(-maxMessages).reverse()) {
    if (message.role !== 'user') continue;
    const limit = requestedVisibleCardLimitFromText(message.content);
    if (limit) return limit;
  }
  return undefined;
}

function selectedPurchaseProductIds(products: Product[], history: Message[], state: CustomerNeedState, userMessage: string, plan: AssistantTurnPlan) {
  const allProducts = mergeProductsById(products, lastShownProductCards(history));
  const byId = new Map(allProducts.map((product) => [product.id, product]));
  const selected = plan.selectedProductIds.map((id) => byId.get(id)).filter((product): product is Product => Boolean(product));
  const previousCards = lastShownProductCards(history);
  const activeText = [userMessage, plan.catalogSearchQuery, state.lastSummary, recentConversationText(history)].filter(Boolean).join(' ');
  const wantsOil = containsAny(activeText, oilTerms);
  const liters = requestedLiters(activeText);
  const exactModelTokens = extractModelTokens(activeText);
  const exactCoreProduct = allProducts.find((product) => {
    if (!isCoreEquipment(product)) return false;
    const productCompact = compactModelText(productFullText(product));
    return exactModelTokens.some((token) => productCompact.includes(compactModelText(token)));
  });
  const output: Product[] = [];
  const push = (product?: Product) => {
    if (product && !output.some((item) => item.id === product.id)) output.push(product);
  };

  push(selected.find((product) => isCoreEquipment(product) && productMentionedInText(product, activeText)) ?? previousCards.find(isCoreEquipment) ?? exactCoreProduct ?? selected.find(isCoreEquipment));

  if (wantsOil) {
    const profile = buildProductFitProfile(state, userMessage, plan.catalogSearchQuery, { ...plan.requiredProductTraits, productIntent: 'engineOil' });
    const matchingPreviousOil = previousCards.find((product) => isOilCard(product) && (!liters || productLiters(product) === liters));
    const explicitlyMentionedOil = selected.find((product) => isOilCard(product) && (!liters || productLiters(product) === liters) && productMentionedInText(product, userMessage));
    const oilOptions = allProducts
      .filter(isOilCard)
      .filter((product) => !liters || productLiters(product) === liters)
      .map((product) => ({ product, score: recommendationScore(product, state, userMessage, profile) }))
      .filter((item) => productFitPenalty(item.product, profile) >= 0)
      .sort((a, b) => b.score - a.score);
    push(explicitlyMentionedOil ?? matchingPreviousOil ?? selected.find((product) => isOilCard(product) && (!liters || productLiters(product) === liters)) ?? oilOptions[0]?.product);
  }

  if (output.length < 2) {
    for (const product of selected) {
      if (output.length >= 4) break;
      push(product);
    }
  }

  return output.map((product) => product.id);
}

function purchasePlanIfNeeded(plan: AssistantTurnPlan, products: Product[], history: Message[], state: CustomerNeedState, userMessage: string) {
  if (plan.agentDecision?.leadAllowed === false) {
    return {
      leadRequested: false,
      plan: {
        ...plan,
        action: 'answer_question' as AssistantTurnAction,
        answerMode: plan.answerMode === 'leadCollection' ? 'short' as AnswerMode : plan.answerMode,
        followUpPolicy: 'answerNowNoDeferredOffer' as FollowUpPolicy,
        selectionState: {
          ...plan.selectionState,
          shouldShowCards: false,
          cardDisplayMode: 'none' as CardDisplayMode
        },
        answerGuidance: [
          plan.answerGuidance,
          'LLM planner determined that the buyer does not want a call/contact handoff now. Do not pressure the contact form; give the useful technical/commercial summary and say final commercial terms can be checked later.'
        ].filter(Boolean).join('\n')
      }
    };
  }
  if (isLeadPlan(plan) && isTechnicalConsultationContinuation(userMessage)) {
    return {
      leadRequested: false,
      plan: {
        ...plan,
        action: 'ask_clarifying_question' as AssistantTurnAction,
        answerMode: 'short' as AnswerMode,
        followUpPolicy: 'askClarifyingQuestion' as FollowUpPolicy,
        cardPolicy: 'textOnly' as CardPolicy,
        selectionState: {
          ...plan.selectionState,
          shouldShowCards: false,
          cardDisplayMode: 'none' as CardDisplayMode
        },
        answerGuidance: [
          plan.answerGuidance,
          'Покупатель продолжает технический подбор, а не оформляет заявку. Не проси контакты только из-за упоминания электрика. Проверь расчет нагрузки, фазы, пусковые токи и задай следующий уточняющий вопрос.'
        ].filter(Boolean).join('\n')
      }
    };
  }
  const leadRequested = isLeadPlan(plan);
  if (!leadRequested) return { plan, leadRequested };

  const selectedProductIds = selectedPurchaseProductIds(products, history, state, userMessage, plan);
  return {
    leadRequested,
    plan: {
      ...plan,
      action: 'collect_lead' as AssistantTurnAction,
      answerMode: 'leadCollection' as AnswerMode,
      followUpPolicy: 'collectLead' as FollowUpPolicy,
      contextScope: 'previousSelection' as ContextScope,
      searchScope: 'previousSelectionOnly' as SearchScope,
      selectedProductIds: selectedProductIds.length ? selectedProductIds : plan.selectedProductIds,
      selectionState: {
        ...plan.selectionState,
        shouldShowCards: true,
        cardDisplayMode: 'exact_matches' as CardDisplayMode
      },
      answerGuidance: [
        plan.answerGuidance,
        'Покупатель перешел к оформлению. Не говори, что заявка уже создана или что ты уже взял товар в заявку. Коротко подтверди комплект по карточкам, попроси оставить имя и телефон в форме. Не продолжай подбор альтернатив, если покупатель их не просил.'
      ].filter(Boolean).join('\n')
    }
  };
}

function formatLeadPrice(value?: number | null, currency = 'RUB') {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '';
  const rounded = Math.round(value).toLocaleString('ru-RU');
  return currency === 'RUB' ? `${rounded} ₽` : `${rounded} ${currency}`;
}

function requestedBundleClasses(text: string, state?: CustomerNeedState): Set<ProductSelectionClass> {
  const classes = new Set<ProductSelectionClass>();
  const stateText = [
    state?.lastSummary,
    ...(state?.activeNeeds ?? []).map((need) => `${need.productClass} ${need.summary} ${need.constraints.join(' ')}`),
    ...(state?.explicitNeeds ?? []).map((need) => `${need.value} ${need.evidence}`),
    ...(state?.implicitNeeds ?? []).map((need) => `${need.value} ${need.evidence}`),
    ...(state?.constraints ?? []).map((need) => `${need.value} ${need.evidence}`),
    ...(state?.importantCriteria ?? []).map((need) => `${need.value} ${need.evidence}`)
  ].filter(Boolean).join(' ');
  const normalized = `${text} ${stateText}`.toLowerCase();
  if (/(?:\u0433\u0435\u043d\u0435\u0440\u0430\u0442\u043e\u0440|\u044d\u043b\u0435\u043a\u0442\u0440\u043e\u0441\u0442\u0430\u043d\u0446)/iu.test(normalized)) classes.add('generator');
  if (/(?:\u0432\u0438\u0431\u0440\u043e\u043f\u043b\u0438\u0442|\u043f\u043b\u0438\u0442\u0443)/iu.test(normalized)) classes.add('plate');
  for (const need of state?.activeNeeds ?? []) {
    if (need.status !== 'closed' && need.productClass !== 'commercial') classes.add(need.productClass as ProductSelectionClass);
  }
  return classes;
}

function cardProductClass(card: ProductCard): ProductSelectionClass {
  const text = `${card.name} ${card.category ?? ''}`.toLowerCase();
  if (/(?:\u0433\u0435\u043d\u0435\u0440\u0430\u0442\u043e\u0440|\u044d\u043b\u0435\u043a\u0442\u0440\u043e\u0441\u0442\u0430\u043d\u0446)/iu.test(text)) return 'generator';
  if (/(?:\u0432\u0438\u0431\u0440\u043e\u043f\u043b\u0438\u0442)/iu.test(text)) return 'plate';
  if (/(?:\u0442\u0440\u0430\u043c\u0431\u043e\u0432|\u0432\u0438\u0431\u0440\u043e\u043d\u043e\u0433)/iu.test(text)) return 'rammer';
  if (/(?:\u0440\u0435\u0437\u0447\u0438\u043a|\u0448\u0432\u043e\u043d\u0430\u0440\u0435\u0437)/iu.test(text)) return 'cutter';
  return 'unknown';
}

function reliableBundleTotal(cards: ProductCard[], userMessage: string, state?: CustomerNeedState) {
  if (!cards.length || !cards.every((card) => typeof card.price === 'number')) return null;
  const requested = requestedBundleClasses(userMessage, state);
  if (requested.size > 1) {
    const covered = new Set(cards.map(cardProductClass));
    for (const productClass of requested) {
      if (!covered.has(productClass)) return null;
    }
  }
  return cards.reduce((total, card) => total + (card.price ?? 0), 0);
}

type LeadContactContext = {
  hasProvidedContact: boolean;
  asksContactHandling: boolean;
  autoLead?: AutoLeadResult | null;
};

type ExtractedLeadContact = {
  name?: string;
  phone?: string;
  email?: string;
};

type AutoLeadResult = {
  created: boolean;
  lead?: Lead;
  emailStatus?: 'sent_email' | 'email_failed';
  missing?: 'name' | 'contact';
  error?: string;
};

function extractLeadContactDetails(text: string): ExtractedLeadContact {
  const normalized = text.replace(/\s+/g, ' ').trim();
  const email = normalized.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/iu)?.[0];
  const phone = normalized.match(/(?:\+?\d[\d\s().-]{8,}\d)/u)?.[0]?.replace(/\s+/g, ' ').trim();
  const explicitName = normalized.match(/(?:меня\s+зовут|зовут|имя|я)\s+([А-ЯЁA-Z][А-ЯЁA-Zа-яёa-z-]{1,30}(?:\s+[А-ЯЁA-Z][А-ЯЁA-Zа-яёa-z-]{1,30})?)/iu)?.[1];
  const contactIndex = [phone ? normalized.indexOf(phone) : -1, email ? normalized.indexOf(email) : -1]
    .filter((index) => index >= 0)
    .sort((a, b) => a - b)[0];
  const prefixName = contactIndex !== undefined
    ? normalized.slice(0, contactIndex).match(/([А-ЯЁA-Z][А-ЯЁA-Zа-яёa-z-]{1,30}(?:\s+[А-ЯЁA-Z][А-ЯЁA-Zа-яёa-z-]{1,30})?)\s*(?:[,;:—-])?\s*$/u)?.[1]
    : undefined;
  const name = (explicitName ?? prefixName)?.trim();
  return {
    name: name && name.length >= 2 ? name : undefined,
    phone,
    email
  };
}

function hasLikelyContactText(text: string) {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return false;
  const hasEmail = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/iu.test(normalized);
  const digits = normalized.replace(/\D+/g, '');
  const hasPhone = digits.length >= 10 && /(?:\+?\d[\d\s().-]{8,}\d)/u.test(normalized);
  return hasEmail || hasPhone;
}

function asksContactHandlingQuestion(text: string) {
  const normalized = text.toLowerCase();
  return /(?:контакт|телефон|номер|имя|форма|заявк|менеджер|специалист)/iu.test(normalized) &&
    /(?:уже|видит|увидит|нужно|надо|обязательно|заполн|отдельно|достаточно|попад)/iu.test(normalized);
}

function leadContactContext(userMessage: string, history: Message[]): LeadContactContext {
  const recentUserText = [
    userMessage,
    ...history
      .filter((message) => message.role === 'user')
      .slice(-4)
      .map((message) => message.content)
  ];
  return {
    hasProvidedContact: recentUserText.some(hasLikelyContactText),
    asksContactHandling: asksContactHandlingQuestion(userMessage)
  };
}

function leadContactContextWithAutoLead(userMessage: string, history: Message[], autoLead?: AutoLeadResult | null): LeadContactContext {
  return {
    ...leadContactContext(userMessage, history),
    autoLead
  };
}

function deterministicLeadCollectionAnswer(
  cards: ProductCard[],
  totalPrice?: number | null,
  contactContext: LeadContactContext = { hasProvidedContact: false, asksContactHandling: false },
  userMessage = ''
) {
  const visibleCards = cards.slice(0, Math.max(1, Math.min(2, cards.length)));
  const names = visibleCards.map((card) => card.name).filter(Boolean);
  const itemsText = names.length
    ? names.length === 1
      ? names[0]
      : `${names.slice(0, -1).join(', ')} и ${names[names.length - 1]}`
    : 'выбранный вариант';
  const totalText = formatLeadPrice(totalPrice, cards.find((card) => card.currency)?.currency ?? 'RUB');
  const priceText = totalText ? ` Ориентир по сумме: ${totalText}.` : '';
  const handoffContext = operationalHandoffContext(userMessage, itemsText);
  const contactText = contactContext.autoLead?.created
    ? 'Контакт получил, заявку сформировал вместе с кратким содержанием диалога. Наличие, актуальную цену и доставку сверю перед подтверждением.'
    : contactContext.autoLead?.missing === 'name'
      ? 'Контакт в сообщении вижу, но для заявки не хватает имени. Напишите имя или заполните форму, чтобы я корректно взял запрос в работу.'
      : contactContext.hasProvidedContact
    ? contactContext.asksContactHandling
      ? 'Контакт в сообщении вижу, но отдельная заявка автоматически не создана. Чтобы контакт точно попал в обработку, заполните форму; вопрос сверю по этому диалогу.'
      : 'Контакт в сообщении вижу, но для надежной обработки оставьте его в форме.'
    : 'Оставьте контакты в форме. Напишите имя и телефон — перезвоню уже с готовым ответом.';
  const leadStatusText = contactContext.autoLead?.created
    ? 'Заявку создал; финальные условия сверю после проверки.'
    : '';

  return [
    `Здравствуйте, сейчас ${handoffContext.verb} ${handoffContext.responsible} ${handoffContext.summary}.`,
    `${priceText}${contactText}`,
    leadStatusText
  ].filter(Boolean).join(' ');
}

function leadCreatedConfirmationAnswer(input: {
  cards: ProductCard[];
  userMessage: string;
  autoLead?: AutoLeadResult | null;
}) {
  const normalized = input.userMessage.replace(/\s+/g, ' ').trim();
  const lower = normalized.toLowerCase();
  const topics = [
    /доставк|логист/iu.test(lower) ? 'доставку' : '',
    /налич|склад/iu.test(lower) ? 'наличие' : '',
    /скидк|спецуслов|услови/iu.test(lower) ? 'финальные условия' : '',
    /цен|стоимост/iu.test(lower) ? 'актуальную цену' : '',
    /срок/iu.test(lower) ? 'сроки' : ''
  ].filter(Boolean);
  const uniqueTopics = [...new Set(topics)];
  const topicText = uniqueTopics.length ? uniqueTopics.join(', ') : 'детали по запросу';
  const selectedNames = input.cards
    .slice(0, 2)
    .map((card) => card.name.trim())
    .filter(Boolean);
  const itemText = selectedNames.length
    ? 'по выбранным позициям'
    : /(?:этим|выбран|позици|модел)/iu.test(lower)
      ? 'по выбранным позициям'
      : 'по вашему запросу';
  const specialistPath = /доставк|логист/iu.test(lower)
    ? /налич|склад/iu.test(lower)
      ? 'через логистику и склад'
      : 'через логистику'
    : /налич|склад/iu.test(lower)
      ? 'по складу'
      : 'у профильного специалиста';
  const leadName = input.autoLead?.lead?.name?.trim();
  const hasPhone = Boolean(input.autoLead?.lead?.phone);
  const greeting = leadName ? `${leadName}, контакт получил.` : 'Контакт получил.';
  const returnText = hasPhone ? 'перезвоню с точным ответом' : 'вернусь с точным ответом';

  return `${greeting} Проверю ${topicText} ${itemText} ${specialistPath} и ${returnText}.`;
}

function operationalHandoffContext(userMessage: string, fallbackItemsText: string) {
  const normalized = userMessage.replace(/\s+/g, ' ').trim();
  const lower = normalized.toLowerCase();
  const asksDelivery = /доставк|логист/iu.test(lower);
  const asksStock = /налич|в\s+наличии|на\s+складе/iu.test(lower);
  const asksPrice = /актуальн\w*\s+цен|финальн\w*\s+цен|точн\w*\s+цен/iu.test(lower);
  const asksDiscount = /скидк|спецуслов/iu.test(lower);
  const asksTiming = /срок/iu.test(lower);
  const destination = extractDeliveryDestination(normalized);
  const itemText = fallbackItemsText === 'выбранный вариант' ? '' : fallbackItemsText;
  const topics = [
    asksDelivery ? `стоимость доставки${destination ? ` в ${destination}` : ''} и саму доставку` : '',
    asksStock ? 'наличие' : '',
    asksPrice ? 'актуальную цену' : '',
    asksDiscount ? 'возможные условия по скидке' : '',
    asksTiming ? 'сроки' : ''
  ].filter(Boolean);
  const summary = topics.length
    ? `${topics.join(', ')}${itemText ? ` по ${itemText}` : ''}`
    : itemText
      ? `детали по ${itemText}`
      : 'детали по вашему запросу';
  const responsible = asksDelivery && (asksStock || asksPrice || asksDiscount)
    ? 'через логистику и по складу'
    : asksDelivery
      ? 'через логистику'
      : 'по складу';
  return {
    responsible,
    verb: asksDelivery ? 'уточню' : 'проверю',
    summary
  };
}

function extractDeliveryDestination(text: string) {
  const regionMatch = text.match(/(?:^|\s)(?:в|во|до)\s+([А-ЯЁA-Z][А-ЯЁA-Zа-яёa-z\s-]{1,80}?(?:край|область|республик[ауи]|район|округ|город|г\.\s*[А-ЯЁA-Z][А-ЯЁA-Zа-яёa-z\s-]{1,40}))(?:[,.!?;:]|\s|$)/u);
  if (regionMatch?.[1]) return regionMatch[1].replace(/\s+/g, ' ').trim();

  const cityMatch = text.match(/(?:доставк\w*|логист\w*)[\s\S]{0,120}?(?:в|во|до)\s+([А-ЯЁA-Z][А-ЯЁA-Zа-яёa-z-]{2,40})(?:[,.!?;:]|\s|$)/u);
  return cityMatch?.[1]?.replace(/\s+/g, ' ').trim();
}

function resolveTurnContractForPlan(
  plan: AssistantTurnPlan,
  options: { forceTextOnlyReason?: string; forceCards?: ResolvedTurnContract['render']['cards']; forceWebRequired?: boolean } = {}
) {
  return resolveTurnContract({ plan, ...options });
}

function applyResolvedTurnContractToPlan(plan: AssistantTurnPlan, contract: ResolvedTurnContract): AssistantTurnPlan {
  const cardPolicy = contract.render.cards === 'none'
    ? 'textOnly'
    : contract.render.cards === 'showProducts' || contract.render.cards === 'selectedOnly'
      ? 'showProducts'
      : contract.render.cards === 'showAccessories'
        ? 'showAccessories'
        : plan.cardPolicy;
  return {
    ...plan,
    action: contract.action.primary,
    answerMode: contract.action.answerMode,
    followUpPolicy: contract.action.followUpPolicy,
    contextScope: contract.scope.context,
    searchScope: contract.scope.search,
    catalogSearchQuery: contract.scope.catalogSearchQuery,
    needsWebSearch: contract.knowledge.webRequired,
    missingInformation: contract.knowledge.missingInformation,
    selectedProductIds: contract.selection.selectedProductIds,
    requiredProductTraits: (contract.selection.requiredProductTraits ?? plan.requiredProductTraits) as AssistantTurnPlan['requiredProductTraits'],
    selectionState: (contract.selection.selectionState ?? plan.selectionState) as AssistantTurnPlan['selectionState'],
    cardPolicy,
    answerGuidance: contract.guidance
  };
}

function selectCardsFromPlan(products: Product[], state: CustomerNeedState, userMessage: string, plan: AssistantTurnPlan, options: { cardLimit?: number; respectRequestedCardLimit?: boolean } = {}) {
  const requestedCardLimit = requestedVisibleCardLimitFromText(userMessage);
  const baseCardLimit = options.cardLimit ?? MAX_PRODUCT_CARDS;
  const cardLimit = Math.max(1, Math.min(baseCardLimit, options.respectRequestedCardLimit === false ? baseCardLimit : requestedCardLimit ?? baseCardLimit));
  const baseProfile = buildProductFitProfile(state, userMessage, plan.catalogSearchQuery, plan.requiredProductTraits);
  const requestedBrandSet = ['generatorOil', 'engineOil', 'generatorAccessory', 'plateAccessory'].includes(baseProfile.intent)
    ? new Set<string>()
    : plan.searchScope === 'broadenAlternatives'
      ? new Set<string>()
    : requestedBrandKeysFromProducts(products, baseProfile.activeNeedText);
  const profile: ProductFitProfile = { ...baseProfile, requestedBrands: [...requestedBrandSet] };
  const policyTextOnly = plan.cardPolicy === 'textOnly';
  const policyServiceComparison = policyTextOnly &&
    (plan.answerMode === 'serviceCostComparison' || plan.answerMode === 'detailedFact');
  const policyCurrentLineup = policyTextOnly && plan.answerMode === 'currentLineup';
  const leadRequested = isLeadPlan(plan);
  const structuredSelectionAuthoritative = plan.selectionState?.cardDisplayMode === 'structured_selection' &&
    plan.action === 'recommend_products' &&
    plan.cardPolicy === 'showProducts';
  const suppressCardsForFactualComparison = (policyServiceComparison || shouldUseDetailedFactStyle(userMessage, plan, 0)) &&
    !leadRequested &&
    plan.action !== 'recommend_products';
  const suppressCardsForCurrentLineupQuestion = (policyCurrentLineup || shouldUseCurrentLineupStyle(userMessage, plan)) &&
    !leadRequested &&
    plan.action !== 'recommend_products';
  const byId = new Map(products.map((product) => [product.id, product]));
  const selected = plan.selectedProductIds
    .map((id) => byId.get(id))
    .filter((product): product is Product => Boolean(product));
  const previousSelectionOnly = plan.searchScope === 'previousSelectionOnly';
  const matchesRequestedBrand = (product: Product) => productMatchesRequestedBrand(product, requestedBrandSet);
  const selectionState = state.selectionState ?? emptyProductSelectionState();
  const cardFollowUpWithoutSelection = isProductCardSelectionFollowUp(userMessage) &&
    !hasMaterialHardConstraints(selectionState) &&
    !plan.selectedProductIds.length;
  const currentNeedAllowsProduct = (product: Product) =>
    productMatchesSelectionCriteria(product, selectionState, profile) &&
    productFitPenalty(product, profile) >= 0;
  const structuredSelectionMatchedIds = new Set(selectionState.matchedProductIds ?? []);
  const structuredSelectionAllowsSelectedProduct = (product: Product) =>
    structuredSelectionAuthoritative &&
    structuredSelectionMatchedIds.has(product.id) &&
    isCoreEquipment(product) &&
    (selectionState.targetProductClass === 'unknown' || productMatchesIntent(product, selectionState.targetProductClass as ProductIntent)) &&
    productFitPenalty(product, profile) > -260;
  const exactLookupSelectedIds = new Set(
    plan.agentDecision?.catalogAction === 'exact_model_lookup' || plan.agentDecision?.catalogAction === 'verify_catalog_absence'
      ? plan.selectedProductIds
      : []
  );
  const relaxedExactLookupState = exactLookupRelaxedSelectionState(selectionState);
  const relaxedExactLookupProfile = buildProductFitProfile(
    { ...state, selectionState: relaxedExactLookupState },
    userMessage,
    plan.catalogSearchQuery,
    exactLookupRelaxedTraits(plan.requiredProductTraits)
  );
  const exactLookupSelectedAlternative = (product: Product) =>
    exactLookupSelectedIds.has(product.id) &&
    productMatchesSelectionCriteria(product, relaxedExactLookupState, relaxedExactLookupProfile) &&
    productFitPenalty(product, relaxedExactLookupProfile) >= 0;

  const isBroadenComparisonAnchor = (product: Product) =>
    plan.searchScope === 'broadenAlternatives' && productHasExactModel(product, profile);
  const score = (product: Product) => recommendationScore(product, state, userMessage, profile);
  const rankingScore = (product: Product) => score(product) - (isBroadenComparisonAnchor(product) ? 260 : 0);
  const preserveSelectedOrder = plan.selectedProductIds.length > 0 &&
    plan.action === 'recommend_products' &&
    plan.cardPolicy === 'showProducts';
  const rankedItems = products
    .map((product) => ({ product, score: rankingScore(product) }))
    .filter((item) => matchesRequestedBrand(item.product))
    .filter((item) => currentNeedAllowsProduct(item.product) && isCardWorthy(item.product, profile, item.score))
    .sort((a, b) => b.score - a.score);
  const ranked = diversifyRankedProducts(rankedItems, cardLimit);
  const selectedCards = selected
    .filter((product) => previousSelectionOnly || matchesRequestedBrand(product))
    .filter((product) => previousSelectionOnly
      ? true
      : leadRequested || structuredSelectionAuthoritative
      ? productMatchesSelectionCriteria(product, selectionState, profile) || structuredSelectionAllowsSelectedProduct(product) || exactLookupSelectedAlternative(product)
      : currentNeedAllowsProduct(product) || exactLookupSelectedAlternative(product));
  if (!leadRequested && !preserveSelectedOrder) selectedCards.sort((a, b) => rankingScore(b) - rankingScore(a));
  const selectedRejectedCount = selected.length - selectedCards.length;

  if (suppressCardsForFactualComparison) {
    return {
      cards: [],
      diagnostics: cardDiagnostics(profile, selected.length, selectedRejectedCount, ranked.length, false, 'suppressed_for_factual_comparison')
    };
  }

  if (suppressCardsForCurrentLineupQuestion) {
    return {
      cards: [],
      diagnostics: cardDiagnostics(profile, selected.length, selectedRejectedCount, ranked.length, false, 'suppressed_for_current_lineup_question')
    };
  }

  if (policyTextOnly && !leadRequested) {
    return {
      cards: [],
      diagnostics: cardDiagnostics(profile, selected.length, selectedRejectedCount, ranked.length, false, 'suppressed_by_card_policy')
    };
  }

  if (cardFollowUpWithoutSelection) {
    return {
      cards: [],
      diagnostics: cardDiagnostics(profile, selected.length, selectedRejectedCount, ranked.length, true, 'card_followup_without_previous_selection')
    };
  }

  if (structuredSelectionAuthoritative) {
    const selectedIds = new Set(selectedCards.map((product) => product.id));
    const structuredProducts = [
      ...selectedCards,
      ...products
        .filter((product) => !selectedIds.has(product.id))
        .filter((product) => matchesRequestedBrand(product))
        .filter((product) => productMatchesSelectionCriteria(product, selectionState, profile) || structuredSelectionAllowsSelectedProduct(product))
    ];
    const cards = productCards(mergeProductsById([], structuredProducts), state, userMessage, exactLookupSelectedIds.size ? relaxedExactLookupProfile : profile, cardLimit);
    return {
      cards,
      diagnostics: cardDiagnostics(
        profile,
        selected.length,
        selectedRejectedCount,
        structuredProducts.length,
        cards.length === 0,
        cards.length === 0 ? 'structured_selection_had_no_cardable_products' : undefined
      )
    };
  }

  if (selected.length) {
    const selectedIds = new Set(selectedCards.map((product) => product.id));
    const shouldAppendRanked = !leadRequested && plan.action !== 'ask_clarifying_question';
    const plannerSelectionIsAuthoritative = plan.action === 'recommend_products' &&
      plan.cardPolicy === 'showProducts' &&
      plan.searchScope !== 'broadenAlternatives' &&
      plan.selectedProductIds.length > 0;
    if (plannerSelectionIsAuthoritative) {
      const fallbackRanked = selectedCards.length ? [] : ranked;
      const cards = productCards(selectedCards.length ? selectedCards : fallbackRanked, state, userMessage, exactLookupSelectedIds.size ? relaxedExactLookupProfile : profile, cardLimit);
      return {
        cards,
        diagnostics: cardDiagnostics(
          profile,
          selected.length,
          selectedRejectedCount,
          selectedCards.length ? ranked.length : fallbackRanked.length,
          cards.length === 0,
          selectedCards.length === 0
            ? cards.length === 0
              ? 'planner_selected_products_but_all_were_rejected_by_current_need'
              : 'planner_selected_products_rejected_catalog_executor_used_ranked_matches'
            : undefined
        )
      };
    }
    const rankedIds = new Set(ranked.map((product) => product.id));
    const combinedRaw = plan.searchScope === 'broadenAlternatives' && shouldAppendRanked
      ? [
          ...ranked,
          ...selectedCards.filter((product) => !rankedIds.has(product.id))
        ]
      : [
          ...selectedCards,
          ...(shouldAppendRanked ? ranked.filter((product) => !selectedIds.has(product.id)) : [])
        ];
    const combined = preserveSelectedOrder
      ? combinedRaw.slice(0, cardLimit)
      : !leadRequested && shouldAppendRanked
      ? diversifyRankedProducts(combinedRaw.map((product) => ({ product, score: rankingScore(product) })).sort((a, b) => b.score - a.score), cardLimit)
      : combinedRaw;
    const cards = productCards(combined, state, userMessage, exactLookupSelectedIds.size ? relaxedExactLookupProfile : profile, cardLimit);
    return {
      cards,
      diagnostics: cardDiagnostics(
        profile,
        selected.length,
        selectedRejectedCount,
        ranked.length,
        cards.length === 0,
        cards.length === 0 ? 'planner_selected_products_but_all_were_rejected_by_current_need' : undefined
      )
    };
  }

  const exactMatches = products
    .map((product) => ({ product, score: score(product) }))
    .filter((item) => matchesRequestedBrand(item.product))
    .filter((item) => currentNeedAllowsProduct(item.product) && productHasExactModel(item.product, profile) && isCardWorthy(item.product, profile, item.score))
    .map((item) => item.product);
  if (exactMatches.length && plan.action !== 'ask_clarifying_question' && plan.searchScope !== 'broadenAlternatives') {
    const cards = productCards(exactMatches, state, userMessage, profile, cardLimit);
    return {
      cards,
      diagnostics: cardDiagnostics(profile, selected.length, selectedRejectedCount, ranked.length, false)
    };
  }

  if (plan.action !== 'recommend_products') {
    return {
      cards: [],
      diagnostics: cardDiagnostics(profile, selected.length, selectedRejectedCount, ranked.length, false)
    };
  }

  const confidentPlannerChoseNoCards = (plan.selectionState?.selectionConfidence ?? 0) >= 0.55 &&
    plan.selectionState?.shouldShowCards === false;
  if (!plan.selectedProductIds.length && confidentPlannerChoseNoCards) {
    return {
      cards: [],
      diagnostics: cardDiagnostics(profile, selected.length, selectedRejectedCount, ranked.length, true, 'planner_did_not_select_products')
    };
  }

  const cards = productCards(ranked, state, userMessage, profile, cardLimit);
  return {
    cards,
    diagnostics: cardDiagnostics(
      profile,
      selected.length,
      selectedRejectedCount,
      ranked.length,
      cards.length === 0,
      cards.length === 0 ? 'no_relevant_cards_after_current_need_filters' : undefined
    )
  };
}

function selectCardsFromTurnContract(products: Product[], state: CustomerNeedState, userMessage: string, plan: AssistantTurnPlan, contract: ResolvedTurnContract, options: { cardLimit?: number; respectRequestedCardLimit?: boolean } = {}) {
  if (contract.render.cards === 'none') {
    return {
      cards: [],
      diagnostics: {
        ...cardDiagnostics(buildProductFitProfile(state, userMessage, plan.catalogSearchQuery, plan.requiredProductTraits), contract.selection.selectedProductIds.length, 0, 0, false, 'contract_text_only'),
        reason: contract.render.textOnlyReason ? `contract_text_only_${contract.render.textOnlyReason}` : 'contract_text_only'
      }
    };
  }
  return selectCardsFromPlan(products, state, userMessage, plan, options);
}

function cardsFromPlan(products: Product[], state: CustomerNeedState, userMessage: string, plan: AssistantTurnPlan) {
  return selectCardsFromPlan(products, state, userMessage, plan).cards;
}
function responseUsedWebSearch(value: unknown) {
  if (!value) return false;
  if (extractUrlCitations(value).length > 0) return true;
  return hasResponseNode(value, (object) => {
    const type = typeof object.type === 'string' ? object.type : '';
    return /web_search|search_result|url_citation/i.test(type);
  });
}

function extractResponseText(value: unknown, depth = 0): string {
  if (!value || depth > 8) return '';
  if (typeof value === 'string') return '';
  if (Array.isArray(value)) {
    return value.map((item) => extractResponseText(item, depth + 1)).filter(Boolean).join('\n').trim();
  }
  if (typeof value !== 'object') return '';

  const object = value as Record<string, unknown>;
  const objectType = typeof object.type === 'string' ? object.type : '';
  if (typeof object.output_text === 'string' && object.output_text.trim()) return object.output_text.trim();
  if (
    typeof object.text === 'string'
    && object.text.trim()
    && (!objectType || /output_text|message|text/i.test(objectType))
  ) {
    return object.text.trim();
  }

  const contentText = extractResponseText(object.content, depth + 1);
  if (contentText) return contentText;
  const outputText = extractResponseText(object.output, depth + 1);
  if (outputText) return outputText;
  const messageText = extractResponseText(object.message, depth + 1);
  if (messageText) return messageText;
  return '';
}

function normalizeEvidenceUrl(value?: string | null) {
  if (!value) return '';
  try {
    const url = new URL(value);
    url.hash = '';
    url.searchParams.delete('utm_source');
    url.searchParams.delete('utm_medium');
    url.searchParams.delete('utm_campaign');
    return url.toString().replace(/\/$/, '');
  } catch {
    return value.replace(/\/$/, '');
  }
}

function visibleLinkLabel(label: string) {
  const trimmed = label.trim();
  if (!trimmed) return '';
  if (/^https?:\/\//i.test(trimmed)) return '';
  if (/(?:^|\s)[\w-]+(?:\.[\w-]+)+(?:\/|\s|$)/i.test(trimmed)) return '';
  return trimmed;
}

function stripDeferredOfferTail(answer: string) {
  return answer
    .replace(/\n{1,2}Если\s+(?:хотите|хочешь),?\s+(?:(?:я\s+)?(?:дальше\s+)?(?:могу\s+)?(?:сразу\s+)?(?:уже\s+)?)?(?:разложить|разложу|сравнить|сравню|подобрать|подберу|посмотреть|посмотрю|проверить|проверю)[\s\S]{0,500}$/iu, '')
    .replace(/\n{1,2}(?:Я\s+)?(?:могу|могу\s+дальше|дальше\s+могу)\s+(?:разложить|сравнить|подобрать|посмотреть|проверить)[\s\S]{0,500}$/iu, '')
    .replace(/(?:^|(?<=[.!?])\s+)(?:Если\s+[^.!?\n]{0,180},?\s+)?(?:я\s+)?(?:дальше\s+)?могу\s+(?:быстро\s+)?(?:собрать|разложить|сравнить|подобрать|посмотреть|проверить|дать)[\s\S]{0,500}$/iu, '')
    .replace(/(?:^|(?<=[.!?])\s+)Если\s+(?:хотите|хочешь),?\s+(?:следующим\s+сообщением\s+)?(?:я\s+)?могу\s+(?:сразу\s+)?(?:собрать|разложить|сравнить|подобрать|посмотреть|проверить|дать)[\s\S]{0,500}$/iu, '')
    .replace(/(?:^|(?<=[.!?])\s+)Если\s+(?:хотите|хочешь),?\s+(?:я\s+)?могу\s+(?:дальше\s+)?помочь[\s\S]{0,500}$/iu, '')
    .replace(/(?:^|(?<=[.!?])\s+)Если\s+(?:хотите|хочешь),?\s+дальше\s+помогу[\s\S]{0,500}$/iu, '')
    .replace(/(?:^|(?<=[.!?])\s+)Если\s+(?:хотите|хочешь),?\s+дальше\s+(?:лучше\s+)?(?:смотреть|подбирать|сравнивать|проверять|искать)[\s\S]{0,500}$/iu, '');
}

function shouldSuppressLeadRequestFromContract(contract: AgentTurnContract, userMessage = '') {
  if (!contract.leadAllowed) return true;
  if (contract.answerTask === 'lead_handoff' && hasLikelyContactText(userMessage)) return false;
  return contract.taskType === 'contact_refusal_continue_selection' &&
    contract.commercialAction === 'explain_manager_required';
}

function shouldRequestLeadFormForAnswer(input: {
  leadDraft: LeadDraft | null;
  suppressLeadRequest: boolean;
  purchaseLeadRequested: boolean;
  leadPlan: boolean;
  leadPolicy: AgentTurnContractV2['leadPolicy'];
  commercialAction?: AgentTurnContractV2['commercialAction'];
}) {
  if (!input.leadDraft || input.suppressLeadRequest) return false;
  return input.purchaseLeadRequested ||
    input.leadPlan ||
    input.leadPolicy === 'required_now' ||
    input.leadPolicy === 'optional_after_answer' ||
    input.commercialAction === 'offer_contact_after_answer';
}

function isCurrentLevelTechnicalTurn(contract: AgentTurnContract) {
  return contract.answerTask === 'technical_explanation' ||
    contract.answerTask === 'comparison' ||
    contract.taskType === 'technical_answer' ||
    contract.taskType === 'comparison';
}

function shouldFreezeSelectionContextForNonCatalogTurn(contract: AgentTurnContract) {
  return isCurrentLevelTechnicalTurn(contract) &&
    (contract.catalogAction ?? 'none') === 'none' &&
    (contract.productCardsPolicy ?? 'none') === 'none' &&
    contract.cardsRole === 'none';
}

function freezeSelectionContextForNonCatalogTurn(
  current: CustomerNeedState,
  previous: CustomerNeedState,
  contract: AgentTurnContract
) {
  if (!shouldFreezeSelectionContextForNonCatalogTurn(contract)) return current;
  return {
    ...current,
    selectionState: previous.selectionState,
    semanticMemory: previous.semanticMemory
  };
}

function technicalCurrentLevelAnswerGuidance(contract: AgentTurnContract) {
  if (!isCurrentLevelTechnicalTurn(contract)) return '';
  return 'For this technical/comparison turn, do not answer only by asking for exact model, power, duty cycle, or other missing inputs. First answer the buyer question at the highest truthful specificity available: general engineering comparison, typical tradeoffs, fit by use case, or bounded practical conclusion. Clearly mark what is general and what depends on exact model/data. Ask at most two precise clarifying questions only after the direct answer.';
}

function buildCompactAnswerSystemPrompt() {
  return [
    'You are the BAKAUT AI sales consultant for construction and power equipment.',
    'The upstream LLM planner and agentTurnContract are the semantic brain for the turn. Follow their task, catalogAction, cardsRole, leadAllowed, and mustAnswerNow exactly.',
    'Answer in Russian, directly and naturally. Do not output JSON.',
    'Use only the provided answerContext for concrete product names, prices, specs, and catalog facts. If productCardsShown is present, those cards are the authoritative visible recommendations.',
    'For product-card turns, keep the text short: a practical conclusion, one main model if needed, and one brief tradeoff. Let the cards carry the full catalog list.',
    'Do not claim live warehouse availability, delivery cost, discounts, special terms, or deadlines as final. Speak as the BAKAUT AI manager: separate catalog presence from your own stock/logistics verification wording, not from a third-person manager.',
    'Do not ask for name, phone, callback, or a form unless agentTurnContract.leadAllowed is true and the current task actually requires specialist follow-up.',
    'For technical or comparison turns, answer the buyer question first at the truthful general level, then mention what depends on exact model or conditions.',
    'If catalog matches are shown, do not say there are no matching products. If no trustworthy catalog product is provided, do not invent model names.'
  ].join('\n');
}

function commercialManagerVerificationGuidance(contract: AgentTurnContract) {
  if (contract.commercialAction !== 'explain_manager_required') return '';
  return 'This turn includes a commercial fact that cannot be promised as final from catalog data alone. If the answer mentions live stock, warehouse availability, delivery price, delivery terms, discounts, order timing, or special conditions, explicitly say it in first person as the BAKAUT AI manager: "актуальный склад сверю перед оформлением" or "доставку посчитаю по адресу через логистику". Do not write that a third-person manager must confirm it. Do not replace the useful answer with a vague refusal; keep the product/technical answer moving, and only ask for contact when the semantic contract allows it.';
}

function stripLeadPressureTail(answer: string) {
  const leadAskRe = /(?:^|(?<=[.!?])\s+)(?:[^.!?\n]{0,120}(?:\u043d\u0430\u043f\u0438\u0448\u0438\u0442\u0435|\u043e\u0441\u0442\u0430\u0432\u044c\u0442\u0435|\u043e\u0441\u0442\u0430\u0432\u0438\u0442\u044c|\u0443\u043a\u0430\u0436\u0438\u0442\u0435|\u043f\u0440\u0438\u0448\u043b\u0438\u0442\u0435|\u0437\u0430\u043f\u043e\u043b\u043d\u0438\u0442\u0435)[^.!?\n]{0,180}(?:\u0438\u043c\u044f|\u0442\u0435\u043b\u0435\u0444\u043e\u043d|\u043d\u043e\u043c\u0435\u0440|\u043a\u043e\u043d\u0442\u0430\u043a\u0442)[^.!?\n]*[.!?]?)/giu;
  const leadSetupRe = /(?:^|(?<=[.!?])\s+)(?:\u0415\u0441\u043b\u0438\s+\u0445\u043e\u0442\u0438\u0442\u0435,\s+)?(?:\u044f\s+)?(?:\u043f\u0435\u0440\u0435\u0434\u0430\u043c|\u043e\u0442\u043f\u0440\u0430\u0432\u043b\u044e|\u043e\u0444\u043e\u0440\u043c\u0438\u043c|\u043f\u043e\u0434\u0433\u043e\u0442\u043e\u0432\u0438\u043c)[^.!?\n]{0,180}(?:\u0437\u0430\u044f\u0432|\u0440\u0430\u0441\u0447\u0435\u0442|\u043e\u0444\u043e\u0440\u043c)[^.!?\n]*[.!?]?/giu;
  const cleaned = answer
    .replace(leadAskRe, '')
    .replace(leadSetupRe, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return cleaned || answer.trim();
}

function ensureCommercialManagerVerification(answer: string, contract: AgentTurnContract) {
  if (contract.commercialAction !== 'explain_manager_required') return answer;
  answer = sanitizeThirdPersonManagerRole(answer);
  const commercialTextPresent = /(?:\u043d\u0430\u043b\u0438\u0447|\u0441\u043a\u043b\u0430\u0434|\u043e\u0442\u0433\u0440\u0443\u0437|\u0434\u043e\u0441\u0442\u0430\u0432|\u043b\u043e\u0433\u0438\u0441\u0442|\u0441\u043a\u0438\u0434|\u0443\u0441\u043b\u043e\u0432|\u043a\u043e\u043c\u043c\u0435\u0440\u0447|in\s+stock|delivery|shipping|discount|terms)/iu.test(answer);
  const pureCommercialTask = contract.taskType === 'pure_delivery' ||
    contract.taskType === 'pure_availability' ||
    contract.answerTask === 'lead_handoff' ||
    contract.currentFocus === 'commercial';
  if (!pureCommercialTask && !commercialTextPresent) return answer;
  const hasFirstPersonCheck = /(сверю|уточню|проверю|посчитаю|согласую|перед\s+оформлением)/iu.test(answer);
  const alreadyHasSpecialistVerification = (contract.taskType === 'pure_delivery' || contract.taskType === 'product_selection_with_delivery')
    ? ((hasFirstPersonCheck || /(логист)/iu.test(answer)) && /(доставк|стоимост|услов|срок|адрес|отправк)/iu.test(answer))
    : (contract.taskType === 'pure_availability' || contract.taskType === 'product_selection_with_availability')
      ? (hasFirstPersonCheck && /(налич|склад|отгруз|остат)/iu.test(answer))
      : hasFirstPersonCheck || /(логист)/iu.test(answer);
  if (alreadyHasSpecialistVerification) return answer;
  const sentence = contract.taskType === 'pure_delivery' || contract.taskType === 'product_selection_with_delivery'
    ? ' Точную стоимость и условия доставки посчитаю по адресу и способу отправки через логистику.'
    : contract.taskType === 'pure_availability' || contract.taskType === 'product_selection_with_availability'
      ? ' Актуальный склад и возможность отгрузки сверю перед оформлением.'
      : ' Точные коммерческие условия сверю перед оформлением.';
  const trimmed = answer.trim();
  if (!trimmed) return sentence.trim();
  const hasTerminalPunctuation = trimmed.endsWith('.') || trimmed.endsWith('!') || trimmed.endsWith('?');
  return `${trimmed}${hasTerminalPunctuation ? '' : '.'}${sentence}`;
}

function commercialFirstPersonReplacement(match: string) {
  const lower = match.toLocaleLowerCase('ru');
  if (/(достав|логист|срок|адрес|отправк)/iu.test(lower)) {
    return 'Доставку и условия посчитаю по адресу через логистику.';
  }
  if (/(налич|склад|отгруз|остат)/iu.test(lower)) {
    return 'Актуальный склад и возможность отгрузки сверю перед оформлением.';
  }
  if (/(скид|цен|услов|коммер)/iu.test(lower)) {
    return 'Коммерческие условия сверю перед оформлением.';
  }
  if (/(оформ|заказ|покуп|беру|возьму)/iu.test(lower)) {
    return 'Дальше оформим заказ.';
  }
  return 'Детали сверю перед оформлением.';
}

function sanitizeThirdPersonManagerRole(answer: string) {
  return answer
    .replace(/дальше\s+уже\s+оформляем\s+через\s+менеджера/giu, 'дальше оформляем заказ')
    .replace(/(?:^|(?<=[.!?])\s+)(?:[^.!?\n]{0,180}(?:менеджер[^.!?\n]{0,120}(?:подтверд|провер|уточн|посчит|свер)|(?:подтверд|провер|уточн|посчит|свер)[^.!?\n]{0,120}менеджер)[^.!?\n]*[.!?]?)/giu, commercialFirstPersonReplacement)
    .replace(/(?:^|(?<=[.!?])\s+)(?:[^.!?\n]{0,180}должен[^.!?\n]{0,120}менеджер[^.!?\n]*[.!?]?)/giu, commercialFirstPersonReplacement)
    .replace(/(?:^|(?<=[.!?])\s+)(?:[^.!?\n]{0,180}передам[^.!?\n]{0,120}менеджер[^.!?\n]*[.!?]?)/giu, commercialFirstPersonReplacement)
    .replace(/(?:^|(?<=[.!?])\s+)(?:[^.!?\n]{0,180}через\s+менеджер[а-я]*[^.!?\n]*[.!?]?)/giu, commercialFirstPersonReplacement)
    .replace(/\s+([,.!?])/g, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function sanitizeVisibleAnswer(answer: string, plan?: AssistantTurnPlan) {
  let cleaned = answer
    .replace(/[^]*/g, '')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/gi, (_match, label: string) => visibleLinkLabel(label))
    .replace(/https?:\/\/\S+/gi, '')
    .replace(/\b(?:[\w-]+\.)+(?:ru|com|net|org|рф|su|io|dev|shop|site)\b(?:\/\S*)?/gi, '')
    .replace(/Живое\s+складское\s+наличие\s+и\s+условия\s+проверяет\s+менеджер\.?/giu, 'Актуальный склад и условия отгрузки сверю перед оформлением.')
    .replace(/Точное\s+наличие\s+и\s+возможность\s+отгрузки\s+должен\s+подтвердить\s+менеджер\s+по\s+актуальному\s+складу\.?/giu, 'Актуальный склад и возможность отгрузки сверю перед оформлением.')
    .replace(/Точную\s+стоимость\s+и\s+условия\s+доставки\s+должен\s+подтвердить\s+менеджер\s+или\s+логистика\s+по\s+адресу\s+и\s+способу\s+отправки\.?/giu, 'Точную стоимость и условия доставки посчитаю по адресу и способу отправки через логистику.')
    .replace(/Точные\s+коммерческие\s+условия\s+должен\s+подтвердить\s+менеджер\.?/giu, 'Точные коммерческие условия сверю перед оформлением.')
    .replace(/Актуальный склад и условия отгрузки сверю перед оформлением\.\s*Актуальный склад и возможность отгрузки сверю перед оформлением\./giu, 'Актуальный склад и возможность отгрузки сверю перед оформлением.')
    .replace(/из\s+наличия/giu, 'из каталога')
    .replace(/(?:^|\n)\s*отлично,\s*беру\s+комплект:?/giu, '\nОк, комплект понятен:')
    .replace(/(?:^|\n)\s*беру\s+комплект:?/giu, '\nКомплект понятен:')
    .replace(/\s*\(\s*\)/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
  if (plan?.followUpPolicy === 'answerNowNoDeferredOffer') {
    cleaned = stripDeferredOfferTail(cleaned);
  }
  cleaned = sanitizeThirdPersonManagerRole(cleaned);
  return sanitizeVisibleAnswerNumbers(cleaned).trim();
}

function ensureLargeSliceShowMoreNote(answer: string, slice: StructuredCatalogSlice | null | undefined, cards: ProductCard[], initialVisibleCount = LARGE_SLICE_VISIBLE_CARDS) {
  if (cards.length <= initialVisibleCount) return answer;
  const mentionsShowMore = /(?:\u043f\u043e\u043a\u0430\u0437\u0430\u0442\u044c\s+\u0435\u0449|\u043f\u043e\u043a\u0430\u0437\u0430\u0442\u044c\s+\u0435\u0449\u0435|show\s*more|\u043e\u0441\u0442\u0430\u043b\u044c\u043d)/iu.test(answer);
  if (mentionsShowMore) {
    const hiddenCards = cards.slice(initialVisibleCount, Math.min(cards.length, initialVisibleCount + 3));
    const mentionsHiddenCard = hiddenCards.some((card) => strongProductMentionIndex(productFromCard(card), answer) >= 0);
    if (!hiddenCards.length || mentionsHiddenCard) return answer;
    const hiddenNames = hiddenCards.map((card) => card.name).filter(Boolean).join('; ');
    return hiddenNames ? `${answer.trim()}\n\nПод "Показать еще": ${hiddenNames}.` : answer;
  }
  const visible = Math.min(slice?.visibleLimit ?? initialVisibleCount, initialVisibleCount, cards.length);
  const note = `Показываю первые ${visible} карточек, остальные подходящие варианты будут в "Показать еще".`;
  const paragraphs = answer.split(/\n{2,}/).map((item) => item.trim()).filter(Boolean);
  if (!paragraphs.length) return note;
  const last = paragraphs[paragraphs.length - 1] ?? '';
  if (/[?？]\s*$/.test(last) && paragraphs.length > 1) {
    paragraphs.splice(paragraphs.length - 1, 0, note);
    return paragraphs.join('\n\n');
  }
  return `${answer.trim()}\n\n${note}`;
}

function leadQuestionSummary(userMessage: string, history: Message[], state: CustomerNeedState, cards: ProductCard[]) {
  const recentDialogue = history
    .filter((message) => message.role === 'user' || message.role === 'assistant')
    .slice(-8)
    .map((message) => `${message.role}: ${message.content}`)
    .join('\n');
  const selectedProducts = cards.slice(0, 6).map((card) => {
    const price = typeof card.price === 'number' ? ` - ${formatLeadPrice(card.price, card.currency ?? 'RUB')}` : '';
    return `${card.name}${price}`;
  }).join('; ');
  return [
    `Контакт оставлен покупателем прямо в чате.`,
    `Последняя реплика: ${userMessage}`,
    state.lastSummary ? `Сводка потребности: ${state.lastSummary}` : '',
    selectedProducts ? `Показанные/выбранные позиции: ${selectedProducts}` : '',
    recentDialogue ? `Последние сообщения:\n${recentDialogue}` : ''
  ].filter(Boolean).join('\n\n').slice(0, 3500);
}

export class AssistantService {
  constructor(
    private readonly conversations = new ConversationRepository(),
    private readonly products = new ProductRepository(),
    private readonly leads = new LeadRepository()
  ) {}

  private async createLeadFromChatContact(
    session: ConversationSession,
    history: Message[],
    cards: ProductCard[],
    userMessage: string,
    state: CustomerNeedState
  ): Promise<AutoLeadResult | null> {
    if (!hasLikelyContactText(userMessage)) return null;
    const contact = extractLeadContactDetails(userMessage);
    if (!contact.phone && !contact.email) return { created: false, missing: 'contact' };
    if (!contact.name) return { created: false, missing: 'name' };
    try {
      const lead = await this.leads.createLead({
        sessionId: session.id,
        name: contact.name,
        phone: contact.phone,
        email: contact.email,
        question: leadQuestionSummary(userMessage, history, state, cards)
      });
      const messages = await this.conversations.listMessages(session.id, 80).catch(() => history);
      const emailResult = await sendLeadEmail(lead, { session, messages });
      const updated = await this.leads.markEmailResult(
        lead.id,
        emailResult.ok ? 'sent_email' : 'email_failed',
        emailResult as unknown as Record<string, unknown>
      );
      return {
        created: true,
        lead: updated,
        emailStatus: emailResult.ok ? 'sent_email' : 'email_failed'
      };
    } catch (error) {
      console.warn('Auto lead creation from chat failed', safeError(error));
      return { created: false, error: safeError(error).message };
    }
  }

  private buildCommercialFastRenderContract(contract: AgentTurnContract, state: CustomerNeedState, selectedProductIds: string[]): ResolvedTurnContract {
    return {
      action: {
        primary: contract.leadAllowed ? 'collect_lead' : 'answer_question',
        answerMode: contract.leadAllowed ? 'leadCollection' : 'short',
        followUpPolicy: contract.leadAllowed ? 'collectLead' : 'answerNowNoDeferredOffer'
      },
      scope: {
        context: 'fullSession',
        search: 'previousSelectionOnly',
        catalogSearchQuery: ''
      },
      knowledge: {
        webRequired: false,
        missingInformation: []
      },
      selection: {
        selectedProductIds,
        requiredProductTraits: state.selectionState.hardConstraints,
        selectionState: state.selectionState
      },
      render: {
        cards: 'none',
        leadForm: false
      },
      guidance: 'Deterministic commercial handoff for delivery, stock, discount, and final terms.',
      diagnostics: {
        sourcePlan: {
          action: contract.leadAllowed ? 'collect_lead' : 'answer_question',
          answerMode: contract.leadAllowed ? 'leadCollection' : 'short',
          cardPolicy: 'textOnly',
          followUpPolicy: contract.leadAllowed ? 'collectLead' : 'answerNowNoDeferredOffer',
          contextScope: 'fullSession',
          searchScope: 'previousSelectionOnly',
          catalogSearchQuery: '',
          selectedProductIds,
          needsWebSearch: false,
          missingInformation: [],
          answerGuidance: 'Answer commercial boundaries from policy and prior visible cards; do not promise live stock, delivery price, discounts, or exact terms.'
        },
        overrides: ['fast_commercial_handoff']
      }
    };
  }

  private buildTechnicalFastRenderContract(contract: AgentTurnContract, state: CustomerNeedState): ResolvedTurnContract {
    return {
      action: {
        primary: 'answer_question',
        answerMode: 'short',
        followUpPolicy: 'askClarifyingQuestion'
      },
      scope: {
        context: 'fullSession',
        search: 'previousSelectionOnly',
        catalogSearchQuery: ''
      },
      knowledge: {
        webRequired: false,
        missingInformation: state.selectionState.unknowns ?? []
      },
      selection: {
        selectedProductIds: [],
        requiredProductTraits: state.selectionState.hardConstraints,
        selectionState: state.selectionState
      },
      render: {
        cards: 'none',
        leadForm: false
      },
      guidance: 'Fast technical orientation from extracted need state; no catalog cards or commercial promises.',
      diagnostics: {
        sourcePlan: {
          action: 'answer_question',
          answerMode: 'short',
          cardPolicy: 'textOnly',
          followUpPolicy: 'askClarifyingQuestion',
          contextScope: 'fullSession',
          searchScope: 'previousSelectionOnly',
          catalogSearchQuery: '',
          selectedProductIds: [],
          needsWebSearch: false,
          missingInformation: state.selectionState.unknowns ?? [],
          answerGuidance: 'Answer the current technical level and ask for the missing pump/model/weight details before catalog selection.'
        },
        overrides: ['fast_technical_orientation']
      }
    };
  }

  private buildCatalogFastRenderContract(contract: AgentTurnContract, state: CustomerNeedState, selectedProductIds: string[], catalogSearchQuery: string): ResolvedTurnContract {
    return {
      action: {
        primary: 'recommend_products',
        answerMode: 'productRecommendation',
        followUpPolicy: 'askClarifyingQuestion'
      },
      scope: {
        context: 'activeNeed',
        search: 'focusedNeed',
        catalogSearchQuery
      },
      knowledge: {
        webRequired: false,
        missingInformation: state.selectionState.unknowns ?? []
      },
      selection: {
        selectedProductIds,
        requiredProductTraits: state.selectionState.hardConstraints,
        selectionState: state.selectionState
      },
      render: {
        cards: 'showProducts',
        leadForm: false
      },
      guidance: 'Fast catalog selection from LLM-extracted need state; show grounded catalog cards and keep uncertainty separate from product facts.',
      diagnostics: {
        sourcePlan: {
          action: 'recommend_products',
          answerMode: 'productRecommendation',
          cardPolicy: 'showProducts',
          followUpPolicy: 'askClarifyingQuestion',
          contextScope: 'activeNeed',
          searchScope: 'focusedNeed',
          catalogSearchQuery,
          selectedProductIds,
          needsWebSearch: false,
          missingInformation: state.selectionState.unknowns ?? [],
          answerGuidance: 'Select products from the structured need state and answer with visible catalog cards; do not wait for the heavyweight planner when the buyer explicitly asks to show catalog options.'
        },
        overrides: ['fast_catalog_selection']
      }
    };
  }

  private fastCatalogSelectionPlan(input: GenerateAnswerInput, needState: CustomerNeedState, catalogSearchQuery: string): AssistantTurnPlan {
    const selection = needState.selectionState ?? emptyProductSelectionState();
    const hard = selection.hardConstraints;
    const intent = selection.targetProductClass !== 'unknown'
      ? selection.targetProductClass
      : hard.productIntent;
    return {
      action: 'recommend_products',
      answerMode: 'productRecommendation',
      cardPolicy: 'showProducts',
      followUpPolicy: 'askClarifyingQuestion',
      contextScope: 'activeNeed',
      searchScope: 'focusedNeed',
      catalogSearchQuery,
      selectedProductIds: [],
      requiredProductTraits: {
        ...emptyRequiredProductTraits(),
        productIntent: intent,
        productRole: hard.productRole !== 'unknown' ? hard.productRole : 'coreProduct',
        fuel: hard.fuel ?? 'unknown',
        startType: hard.startType ?? 'unknown',
        enclosure: hard.enclosure ?? 'unknown',
        conventionalGenerator: hard.conventionalGenerator ?? null,
        singlePhase220: hard.singlePhase220 ?? null,
        budgetMax: hard.budgetMax ?? null,
        weightKgMin: hard.weightKgMin ?? null,
        weightKgMax: hard.weightKgMax ?? null,
        diameterMmMin: hard.diameterMmMin ?? null,
        diameterMmMax: hard.diameterMmMax ?? null,
        nominalPowerKwMin: hard.nominalPowerKwMin ?? null,
        nominalPowerKwMax: hard.nominalPowerKwMax ?? null,
        maxPowerKwMin: hard.maxPowerKwMin ?? null,
        maxPowerKwMax: hard.maxPowerKwMax ?? null,
        powerReasoning: selection.loadProfile?.calculation ?? '',
        provenance: hard.provenance
      },
      selectionState: {
        currentProductClass: intent,
        targetProductClass: intent,
        compatibilityTargetProduct: selection.compatibilityTargetProduct?.name ?? '',
        mustHaveTraits: hard.mustHaveTraits ?? [],
        niceToHaveTraits: selection.softPreferences?.mustHaveTraits ?? [],
        excludedClasses: hard.excludedClasses as ProductIntent[],
        brandConstraint: hard.brandConstraint ?? '',
        exactModelConstraint: hard.exactModelConstraint ?? '',
        isAccessoryFollowUp: false,
        selectionConfidence: selection.confidence,
        shouldShowCards: true,
        cardDisplayMode: 'structured_selection'
      },
      agentDecision: {
        answerTask: 'product_selection',
        taskType: 'product_selection',
        catalogAction: 'find_matching_products',
        commercialAction: 'none',
        productCardsPolicy: 'show_matching_products',
        cardsRole: 'primary',
        leadAllowed: false,
        leadAllowedReason: 'catalog selection turn; buyer has not asked for delivery, stock, discount, or final commercial terms',
        currentFocus: 'catalog_selection',
        mustAnswerNow: ['show grounded catalog options from current structured need state'],
        errorRecoveryPriority: 'If product cards can be selected from catalog, answer with the cards instead of timing out in planning.',
        confidence: Math.max(0.65, selection.confidence)
      },
      needsWebSearch: false,
      missingInformation: selection.unknowns ?? [],
      answerGuidance: 'Fast catalog selection from validated structured need state.'
    };
  }

  private async tryFastCatalogSelection(
    input: GenerateAnswerInput,
    needState: CustomerNeedState,
    history: Message[],
    aiDiagnostics: AiGenerationDiagnostics
  ): Promise<ChatResponsePayload | null> {
    if (!shouldUseFastCatalogSelection({
      userMessage: input.userMessage,
      needState,
      history
    })) return null;

    const catalogSearchQuery = productSearchText(input.userMessage, needState);
    const plan = this.fastCatalogSelectionPlan(input, needState, catalogSearchQuery);
    const contract: AgentTurnContract = {
      answerTask: 'product_selection',
      taskType: 'product_selection',
      catalogAction: 'find_matching_products',
      commercialAction: 'none',
      productCardsPolicy: 'show_matching_products',
      mustAnswerNow: ['show grounded catalog options from current structured need state'],
      activeNeeds: (needState.activeNeeds ?? []).map((need) => ({
        id: need.id,
        productClass: need.productClass,
        summary: need.summary
      })),
      currentFocus: 'catalog_selection',
      cardsRole: 'primary',
      leadAllowed: false,
      leadAllowedReason: 'catalog selection turn; buyer has not asked for delivery, stock, discount, or final commercial terms',
      errorRecoveryPriority: 'Select products from catalog and answer with visible cards without waiting for the heavyweight planner.',
      validatorWarnings: ['fast_catalog_selection_contract']
    };

    const provisionalRenderContract = this.buildCatalogFastRenderContract(contract, needState, [], catalogSearchQuery);
    let selectionResult = await this.selectProductsForTurn(
      input.userMessage,
      needState,
      plan,
      [],
      provisionalRenderContract,
      LARGE_SLICE_VISIBLE_CARDS,
      recentUserConversationText(history),
      { forceCatalogVerification: true }
    );
    const requiredGeneratorNominalKw = needState.selectionState?.hardConstraints.productIntent === 'generator'
      ? needState.selectionState.loadProfile?.requiredNominalKw
      : undefined;
    if (!selectionResult.matchedProducts.length && requiredGeneratorNominalKw) {
      const loadAnchoredHard = {
        ...selectionResult.state.hardConstraints,
        productIntent: 'generator' as const,
        productRole: selectionResult.state.hardConstraints.productRole !== 'unknown'
          ? selectionResult.state.hardConstraints.productRole
          : 'coreProduct' as const,
        nominalPowerKwMin: requiredGeneratorNominalKw,
        nominalPowerKwMax: undefined,
        maxPowerKwMin: undefined,
        maxPowerKwMax: undefined,
        provenance: {
          ...(selectionResult.state.hardConstraints.provenance ?? {}),
          nominalPowerKwMin: 'inferred_from_load' as const
        }
      };
      const loadAnchoredState: ProductSelectionState = {
        ...selectionResult.state,
        hardConstraints: loadAnchoredHard,
        activeRequirement: loadAnchoredHard,
        loadProfile: needState.selectionState.loadProfile,
        confidence: Math.max(selectionResult.state.confidence, needState.selectionState.confidence, 0.72)
      };
      const loadAnchoredNeedState = { ...needState, selectionState: loadAnchoredState };
      const loadAnchoredProfile = buildProductFitProfile(loadAnchoredNeedState, input.userMessage, plan.catalogSearchQuery, plan.requiredProductTraits);
      const catalog = await this.products.listProducts(5000).catch(() => []);
      const ranked = sortSelectionProducts(catalog
        .filter((product) => productMatchesSelectionCriteria(product, loadAnchoredState, loadAnchoredProfile))
        .map((product) => ({
          product,
          score: recommendationScore(product, loadAnchoredNeedState, input.userMessage, loadAnchoredProfile)
        })), loadAnchoredState.rankingPreference, loadAnchoredState.hardConstraints.budgetMax)
        .slice(0, FULL_SLICE_PRODUCT_CARDS)
        .map((item) => item.product);
      if (ranked.length) {
        const visibleProducts = ranked.slice(0, LARGE_SLICE_VISIBLE_CARDS);
        const hiddenProducts = ranked.slice(LARGE_SLICE_VISIBLE_CARDS);
        const missingQuestions = missingQuestionsForSelection(loadAnchoredState, ranked.length);
        selectionResult = {
          ...selectionResult,
          state: {
            ...loadAnchoredState,
            selectedProductIds: visibleProducts.map((product) => product.id),
            matchedProductIds: ranked.map((product) => product.id),
            previousCandidateProductIds: ranked.map((product) => product.id),
            unknowns: missingQuestions,
            updatedAt: new Date().toISOString()
          },
          matchedProducts: ranked,
          visibleProducts,
          hiddenProducts,
          missingQuestions,
          confidence: Math.max(selectionResult.confidence, 0.72),
          trace: {
            ...selectionResult.trace,
            source: 'fast_catalog_load_anchored_catalog_filter',
            anchoredRequiredNominalKw: requiredGeneratorNominalKw
          }
        };
      }
    }
    const selectedProducts = (selectionResult.matchedProducts.length
      ? selectionResult.matchedProducts
      : selectionResult.visibleProducts
    ).slice(0, FULL_SLICE_PRODUCT_CARDS);
    if (!selectedProducts.length) return null;

    const semanticMemoryAfterSelection = reconcileSemanticMemoryWithSelection(needState.semanticMemory, selectionResult);
    const updatedNeedState = {
      ...needState,
      selectionState: selectionResult.state,
      semanticMemory: semanticMemoryAfterSelection
    };
    await this.conversations.updateNeedState(input.sessionId, updatedNeedState);

    const cards = productCards(selectedProducts, updatedNeedState, input.userMessage, buildProductFitProfile(updatedNeedState, input.userMessage, plan.catalogSearchQuery, plan.requiredProductTraits), FULL_SLICE_PRODUCT_CARDS);
    const initialVisibleCount = initialVisibleCardCountForCards(cards, selectionResult, LARGE_SLICE_VISIBLE_CARDS);
    const finalCards = finalCardsDecisionFromCards(cards, selectionResult, plan, initialVisibleCount);
    const cardDisplay = cardDisplayOptions(finalCards.initialVisibleCount, finalCards.cards);
    const selectedProductIds = finalCards.visibleProductIds;
    let answer = deterministicAnswerGenerationFallback({
      cards: finalCards.cards,
      selectionResult,
      structuredCatalogSlice: null,
      finalCards,
      contract,
      latestUserMessage: input.userMessage
    }).trim();
    if (!answer) return null;

    const renderContract = this.buildCatalogFastRenderContract(contract, updatedNeedState, selectedProductIds, catalogSearchQuery);
    const requirementLedger = buildRequirementLedger({
      needState: updatedNeedState,
      selectionState: selectionResult.state
    });
    const executionContract = buildExecutionContract({
      agentContract: contract,
      renderContract,
      selectionState: selectionResult.state,
      webRequired: false,
      activeRequirementIds: requirementLedger.activeRequirementIds
    });
    const cardManifest = buildCardManifest({
      executionContract,
      cards: finalCards.cards,
      visibleProductIds: finalCards.visibleProductIds,
      hiddenProductIds: finalCards.hiddenProductIds
    });
    const agentContractV2 = deriveAgentTurnContractV2({
      userMessage: input.userMessage,
      legacyContract: contract,
      needState: updatedNeedState,
      webRequired: false,
      selectedProductIds
    });
    const productEvidenceRegistry = buildProductEvidenceRegistry({
      executionContract,
      cardManifest,
      cards: finalCards.cards,
      catalogProducts: selectedProducts
    });
    const factClaimPlanner = buildFactClaimPlanner({
      executionContract,
      requirementLedger,
      cardManifest,
      usedWebSearch: false
    });
    const leadDraft = buildLeadDraft({
      contract: agentContractV2,
      registry: productEvidenceRegistry,
      buyerQuestion: input.userMessage
    });
    const leadStateMachine = buildLeadStateMachine({
      executionContract,
      hasContactInTurn: false,
      leadRequested: false,
      leadCreated: false
    });
    const policyGate = runPolicyGate({
      contract: agentContractV2,
      requirementLedger,
      productEvidenceRegistry,
      executionContract,
      factClaimPlanner,
      leadStateMachine,
      webSearchPlanned: false
    });
    const toolRegistry = new AgentToolRegistry(createRuntimeArtifactToolHandlers({
      contract: agentContractV2,
      selection: {
        matchedProducts: selectionResult.matchedProducts,
        rejectedProducts: selectionResult.rejectedProducts
      },
      productEvidenceRegistry,
      leadDraft,
      autoLeadResult: null,
      webSearchEnabled: false
    }));
    const toolResults = await toolRegistry.executePlan(agentContractV2.toolPlan, {
      sessionId: input.sessionId,
      userMessage: input.userMessage,
      history,
      needState: updatedNeedState,
      signal: input.signal,
      policy: {
        leadAllowed: false,
        webAllowed: !agentContractV2.sourcePolicy.forbidden.includes('web'),
        webPurpose: agentContractV2.sourcePolicy.webPurpose
      }
    });
    const toolTrace = toolResults.map((result, index) => toolResultToTrace(agentContractV2.toolPlan[index]!, result));
    const policyGateEnforcement = enforcePolicyGateBeforeAnswer({
      policyGate,
      toolTrace
    });
    if (policyGateEnforcement.mode === 'hard_block') {
      markAiFallback(
        aiDiagnostics,
        'answerGenerationFallback',
        `fast_catalog_policy_gate_blocked:${policyGateEnforcement.hardBlockReasons.join(',')}`,
        'fast_catalog_policy_gate_blocked'
      );
      throw aiStageFailure('answer generation', aiDiagnostics.answerGenerationFallback);
    }

    const postAnswerCheck = applyPostAnswerVerificationPolicy({
      answer,
      factClaimPlanner,
      leadStateMachine,
      cardManifest,
      productEvidenceRegistry
    });
    answer = postAnswerCheck.answer;
    const factClaimAudit = postAnswerCheck.factClaimAudit;
    const postAnswerVerification = postAnswerCheck.postAnswerVerification;
    const postAnswerVerificationRecovery = postAnswerCheck.postAnswerVerificationRecovery;
    if (postAnswerVerification.status === 'error') {
      throw new Error(`Fast catalog answer violates post-answer verification: ${postAnswerVerification.issues.map((issue) => issue.code).join(', ')}`);
    }

    const contractWarnings = [
      ...contract.validatorWarnings,
      ...agentContractV2.warnings,
      ...requirementLedger.warnings,
      ...executionContract.warnings,
      ...cardManifest.warnings,
      ...productEvidenceRegistry.warnings,
      ...policyGate.warnings,
      ...policyGate.blockedReasons,
      ...policyGateEnforcement.warnings,
      ...policyGateEnforcement.hardBlockReasons,
      ...policyGateEnforcement.repairedReasons,
      ...factClaimPlanner.warnings,
      ...factClaimAudit.warnings,
      ...leadStateMachine.warnings,
      ...postAnswerVerification.issues.map((issue) => issue.code)
    ];
    const selection = selectionMetadata(selectionResult);
    const metadata = {
      turnId: input.turnId,
      turnContract: contract,
      agentContractV2,
      sourcePolicy: agentContractV2.sourcePolicy,
      toolTrace,
      answerMode: 'fast_catalog_selection',
      cardPolicy: 'showProducts',
      cardsRole: contract.cardsRole,
      leadAllowed: contract.leadAllowed,
      leadDraft: leadDraft ?? undefined,
      selection,
      cardDisplay,
      productEvidenceRegistry,
      policyGate,
      policyGateEnforcement,
      executionContract,
      requirementLedger,
      cardManifest,
      factClaimPlanner,
      factClaimAudit,
      leadStateMachine,
      postAnswerVerification,
      postAnswerVerificationRecovery,
      aiDiagnostics,
      productCards: finalCards.cards,
      activeNeedsAfter: updatedNeedState.activeNeeds ?? [],
      warnings: contractWarnings,
      contractWarnings
    };

    await input.onDelta?.(answer);
    const assistantMessage = await this.conversations.addMessage({
      sessionId: input.sessionId,
      role: 'assistant',
      content: answer,
      metadata
    });
    if (input.turnId) {
      await this.conversations.updateTurn({
        sessionId: input.sessionId,
        turnId: input.turnId,
        status: 'completed',
        stage: 'completed',
        assistantMessageId: assistantMessage.id,
        plannerContract: contract,
        activeNeedsAfter: updatedNeedState.activeNeeds ?? []
      }).catch((error) => console.warn('Conversation turn fast catalog update failed', safeError(error)));
    }

    return {
      turnId: input.turnId,
      answer,
      needState: updatedNeedState,
      productCards: finalCards.cards,
      cardDisplay,
      usedWebSearch: false,
      leadRequested: false,
      leadCreated: false,
      assistantMessageId: assistantMessage.id,
      metadata
    };
  }

  private async tryFastTechnicalOrientation(
    input: GenerateAnswerInput,
    needState: CustomerNeedState,
    history: Message[],
    aiDiagnostics: AiGenerationDiagnostics
  ): Promise<ChatResponsePayload | null> {
    if (!shouldUseFastTechnicalOrientation({
      userMessage: input.userMessage,
      needState,
      history
    })) return null;

    const contract: AgentTurnContract = {
      answerTask: 'technical_explanation',
      taskType: 'technical_answer',
      catalogAction: 'none',
      commercialAction: 'none',
      productCardsPolicy: 'none',
      mustAnswerNow: ['give a conservative technical orientation from extracted buyer needs before catalog selection'],
      activeNeeds: (needState.activeNeeds ?? []).map((need) => ({
        id: need.id,
        productClass: need.productClass,
        summary: need.summary
      })),
      currentFocus: 'technical_orientation',
      cardsRole: 'none',
      leadAllowed: false,
      leadAllowedReason: 'technical orientation only; no commercial or specialist handoff requested',
      errorRecoveryPriority: 'Answer the current technical level from extracted need state, do not invent catalog facts, and ask the next missing technical input.',
      validatorWarnings: ['fast_technical_orientation_contract']
    };
    let answer = (deterministicPlateWeightOrientation(input.userMessage) || deterministicTechnicalSummaryRecovery({
      cards: allShownProductCards(history),
      state: needState.selectionState,
      latestUserMessage: input.userMessage
    })).trim();
    if (!answer) return null;

    const renderContract = this.buildTechnicalFastRenderContract(contract, needState);
    const requirementLedger = buildRequirementLedger({
      needState,
      selectionState: needState.selectionState
    });
    const executionContract = buildExecutionContract({
      agentContract: contract,
      renderContract,
      selectionState: needState.selectionState,
      webRequired: false,
      activeRequirementIds: requirementLedger.activeRequirementIds
    });
    const cardManifest = buildCardManifest({
      executionContract,
      cards: [],
      visibleProductIds: [],
      hiddenProductIds: []
    });
    const agentContractV2 = deriveAgentTurnContractV2({
      userMessage: input.userMessage,
      legacyContract: contract,
      needState,
      webRequired: false,
      selectedProductIds: []
    });
    const productEvidenceRegistry = buildProductEvidenceRegistry({
      executionContract,
      cardManifest,
      cards: [],
      catalogProducts: []
    });
    const factClaimPlanner = buildFactClaimPlanner({
      executionContract,
      requirementLedger,
      cardManifest,
      usedWebSearch: false
    });
    const leadDraft = buildLeadDraft({
      contract: agentContractV2,
      registry: productEvidenceRegistry,
      buyerQuestion: input.userMessage
    });
    const leadStateMachine = buildLeadStateMachine({
      executionContract,
      hasContactInTurn: false,
      leadRequested: false,
      leadCreated: false
    });
    const policyGate = runPolicyGate({
      contract: agentContractV2,
      requirementLedger,
      productEvidenceRegistry,
      executionContract,
      factClaimPlanner,
      leadStateMachine,
      webSearchPlanned: false
    });
    const toolRegistry = new AgentToolRegistry(createRuntimeArtifactToolHandlers({
      contract: agentContractV2,
      selection: {
        matchedProducts: [],
        rejectedProducts: []
      },
      productEvidenceRegistry,
      leadDraft,
      autoLeadResult: null,
      webSearchEnabled: false
    }));
    const toolResults = await toolRegistry.executePlan(agentContractV2.toolPlan, {
      sessionId: input.sessionId,
      userMessage: input.userMessage,
      history,
      needState,
      signal: input.signal,
      policy: {
        leadAllowed: agentContractV2.leadPolicy !== 'forbidden',
        webAllowed: !agentContractV2.sourcePolicy.forbidden.includes('web'),
        webPurpose: agentContractV2.sourcePolicy.webPurpose
      }
    });
    const toolTrace = toolResults.map((result, index) => toolResultToTrace(agentContractV2.toolPlan[index]!, result));
    const policyGateEnforcement = enforcePolicyGateBeforeAnswer({
      policyGate,
      toolTrace
    });
    if (policyGateEnforcement.mode === 'hard_block') {
      markAiFallback(
        aiDiagnostics,
        'answerGenerationFallback',
        `fast_technical_policy_gate_blocked:${policyGateEnforcement.hardBlockReasons.join(',')}`,
        'fast_technical_policy_gate_blocked'
      );
      throw aiStageFailure('answer generation', aiDiagnostics.answerGenerationFallback);
    }

    const postAnswerCheck = applyPostAnswerVerificationPolicy({
      answer,
      factClaimPlanner,
      leadStateMachine,
      cardManifest,
      productEvidenceRegistry
    });
    answer = postAnswerCheck.answer;
    const factClaimAudit = postAnswerCheck.factClaimAudit;
    const postAnswerVerification = postAnswerCheck.postAnswerVerification;
    const postAnswerVerificationRecovery = postAnswerCheck.postAnswerVerificationRecovery;
    if (postAnswerVerification.status === 'error') {
      throw new Error(`Fast technical answer violates post-answer verification: ${postAnswerVerification.issues.map((issue) => issue.code).join(', ')}`);
    }

    const contractWarnings = [
      ...contract.validatorWarnings,
      ...agentContractV2.warnings,
      ...requirementLedger.warnings,
      ...executionContract.warnings,
      ...cardManifest.warnings,
      ...productEvidenceRegistry.warnings,
      ...policyGate.warnings,
      ...policyGate.blockedReasons,
      ...policyGateEnforcement.warnings,
      ...policyGateEnforcement.hardBlockReasons,
      ...policyGateEnforcement.repairedReasons,
      ...factClaimPlanner.warnings,
      ...factClaimAudit.warnings,
      ...leadStateMachine.warnings,
      ...postAnswerVerification.issues.map((issue) => issue.code)
    ];
    const metadata = {
      turnId: input.turnId,
      turnContract: contract,
      agentContractV2,
      sourcePolicy: agentContractV2.sourcePolicy,
      toolTrace,
      answerMode: 'fast_technical_orientation',
      cardPolicy: 'textOnly',
      cardsRole: contract.cardsRole,
      leadAllowed: contract.leadAllowed,
      leadDraft: leadDraft ?? undefined,
      productEvidenceRegistry,
      policyGate,
      policyGateEnforcement,
      executionContract,
      requirementLedger,
      cardManifest,
      factClaimPlanner,
      factClaimAudit,
      leadStateMachine,
      postAnswerVerification,
      postAnswerVerificationRecovery,
      aiDiagnostics,
      productCards: [] as ProductCard[],
      activeNeedsAfter: needState.activeNeeds ?? [],
      warnings: contractWarnings,
      contractWarnings
    };

    await input.onDelta?.(answer);
    const assistantMessage = await this.conversations.addMessage({
      sessionId: input.sessionId,
      role: 'assistant',
      content: answer,
      metadata
    });
    if (input.turnId) {
      await this.conversations.updateTurn({
        sessionId: input.sessionId,
        turnId: input.turnId,
        status: 'completed',
        stage: 'completed',
        assistantMessageId: assistantMessage.id,
        plannerContract: contract,
        activeNeedsAfter: needState.activeNeeds ?? []
      }).catch((error) => console.warn('Conversation turn fast technical update failed', safeError(error)));
    }

    return {
      turnId: input.turnId,
      answer,
      needState,
      productCards: [],
      usedWebSearch: false,
      leadRequested: false,
      leadCreated: false,
      assistantMessageId: assistantMessage.id,
      metadata
    };
  }

  private async tryFastCommercialHandoff(input: GenerateAnswerInput, session: ConversationSession, history: Message[], aiDiagnostics: AiGenerationDiagnostics): Promise<ChatResponsePayload | null> {
    const latestUserMessage = input.userMessage;
    if (!isExplicitCommercialQuestion(latestUserMessage)) return null;
    if (isShownProductChoiceOrComparisonQuestion(latestUserMessage)) return null;

    const contactRefusal = isContactRefusalTechnicalSummaryRequest(latestUserMessage);
    const commercialCards = allShownProductCards(history);
    const hasPriorProductContext = commercialCards.length > 0 || (session.needState.activeNeeds ?? []).length > 0;
    const commercialQuestionAboutShownProducts = commercialCards.length > 0 && isCommercialQuestionAboutShownProducts(latestUserMessage);
    if (isMixedCatalogAndCommercialQuestion(latestUserMessage) && !commercialQuestionAboutShownProducts) return null;
    const asksNewCatalogWork = /(?:покаж|подбер|выбер|вариант|модел|какие\s+[^.!?\n]{0,80}есть|show|select|recommend)/iu.test(latestUserMessage);
    const asksSpecificCatalogItem = inferProductIntent(latestUserMessage) !== 'unknown' ||
      extractModelTokens(latestUserMessage).length > 0;
    if (!hasPriorProductContext && asksNewCatalogWork) return null;
    if (!hasPriorProductContext && asksSpecificCatalogItem) return null;

    const selectedProductIds = commercialCards.map((card) => card.id).slice(0, 24);
    const extractedLeadContact = hasLikelyContactText(latestUserMessage)
      ? extractLeadContactDetails(latestUserMessage)
      : undefined;
    const contract: AgentTurnContract = {
      answerTask: 'lead_handoff',
      taskType: /(?:налич|склад|stock)/iu.test(latestUserMessage) && !/(?:достав|логист|delivery|shipping)/iu.test(latestUserMessage)
        ? 'pure_availability'
        : 'pure_delivery',
      catalogAction: 'none',
      commercialAction: 'explain_manager_required',
      productCardsPolicy: 'none',
      mustAnswerNow: ['answer delivery, stock, discount, and final terms safely from business policy and prior shown cards'],
      activeNeeds: (session.needState.activeNeeds ?? []).map((need) => ({
        id: need.id,
        productClass: need.productClass,
        summary: need.summary
      })),
      currentFocus: 'commercial',
      cardsRole: 'none',
      leadAllowed: !contactRefusal,
      leadAllowedReason: contactRefusal
        ? 'buyer explicitly asked to continue without a call or contact pressure'
        : 'delivery, stock, discount, and final commercial terms require specialist/logistics verification',
      errorRecoveryPriority: 'Give a safe commercial answer without promising final stock, delivery, discount, or exact terms.',
      validatorWarnings: ['fast_commercial_handoff_contract']
    };

    const selectionResult: ProductSelectionResult = {
      state: session.needState.selectionState,
      matchedProducts: commercialCards.map(productFromCard),
      visibleProducts: commercialCards.map(productFromCard),
      hiddenProducts: [],
      comparisonProducts: [],
      rejectedProducts: [],
      missingQuestions: [],
      confidence: commercialCards.length ? 0.72 : 0.55,
      trace: { source: 'fast_commercial_handoff_prior_cards' }
    };
    let answer = deterministicCommercialHandoffFallback({
      cards: commercialCards,
      selectionResult,
      contract,
      latestUserMessage,
      leadContact: extractedLeadContact
    }).trim();
    if (!answer) return null;

    const renderContract = this.buildCommercialFastRenderContract(contract, session.needState, selectedProductIds);
    const requirementLedger = buildRequirementLedger({
      needState: session.needState,
      selectionState: session.needState.selectionState
    });
    const executionContract = buildExecutionContract({
      agentContract: contract,
      renderContract,
      selectionState: session.needState.selectionState,
      webRequired: false,
      activeRequirementIds: requirementLedger.activeRequirementIds
    });
    const cardManifest = buildCardManifest({
      executionContract,
      cards: commercialCards,
      visibleProductIds: selectedProductIds,
      hiddenProductIds: []
    });
    const agentContractV2 = deriveAgentTurnContractV2({
      userMessage: latestUserMessage,
      legacyContract: contract,
      needState: session.needState,
      webRequired: false,
      selectedProductIds
    });
    const productEvidenceRegistry = buildProductEvidenceRegistry({
      executionContract,
      cardManifest,
      cards: commercialCards,
      catalogProducts: commercialCards.map(productFromCard)
    });
    const factClaimPlanner = buildFactClaimPlanner({
      executionContract,
      requirementLedger,
      cardManifest,
      usedWebSearch: false
    });
    const leadDraft = buildLeadDraft({
      contract: agentContractV2,
      registry: productEvidenceRegistry,
      buyerQuestion: latestUserMessage,
      contact: extractedLeadContact
    });
    const leadRequestedForAnswer = Boolean(leadDraft) && contract.leadAllowed && !shouldSuppressLeadRequestFromContract(contract, latestUserMessage);
    const shouldCreateLead = shouldCommitLeadFromDraft({
      draft: leadDraft,
      leadRequested: leadRequestedForAnswer,
      executionLeadPolicy: executionContract.leadPolicy,
      contact: extractedLeadContact
    });
    const autoLeadResult = shouldCreateLead
      ? await this.createLeadFromChatContact(session, history, commercialCards, latestUserMessage, session.needState)
      : null;
    const leadStateMachine = buildLeadStateMachine({
      executionContract,
      hasContactInTurn: Boolean(extractedLeadContact),
      leadRequested: leadRequestedForAnswer,
      leadCreated: autoLeadResult?.created ?? false,
      missing: autoLeadResult?.missing,
      error: autoLeadResult?.error
    });
    if (autoLeadResult?.created) {
      answer = leadCreatedConfirmationAnswer({
        cards: commercialCards,
        userMessage: latestUserMessage,
        autoLead: autoLeadResult
      });
    }

    const policyGate = runPolicyGate({
      contract: agentContractV2,
      requirementLedger,
      productEvidenceRegistry,
      executionContract,
      factClaimPlanner,
      leadStateMachine,
      webSearchPlanned: false
    });
    const toolRegistry = new AgentToolRegistry(createRuntimeArtifactToolHandlers({
      contract: agentContractV2,
      selection: {
        matchedProducts: commercialCards.map(productFromCard),
        rejectedProducts: []
      },
      productEvidenceRegistry,
      leadDraft,
      autoLeadResult,
      webSearchEnabled: false
    }));
    const toolResults = await toolRegistry.executePlan(agentContractV2.toolPlan, {
      sessionId: input.sessionId,
      userMessage: latestUserMessage,
      history,
      needState: session.needState,
      signal: input.signal,
      policy: {
        leadAllowed: agentContractV2.leadPolicy !== 'forbidden',
        webAllowed: !agentContractV2.sourcePolicy.forbidden.includes('web'),
        webPurpose: agentContractV2.sourcePolicy.webPurpose
      }
    });
    const toolTrace = toolResults.map((result, index) => toolResultToTrace(agentContractV2.toolPlan[index]!, result));
    const policyGateEnforcement = enforcePolicyGateBeforeAnswer({
      policyGate,
      toolTrace
    });
    if (policyGateEnforcement.mode === 'hard_block') {
      markAiFallback(
        aiDiagnostics,
        'answerGenerationFallback',
        `fast_commercial_policy_gate_blocked:${policyGateEnforcement.hardBlockReasons.join(',')}`,
        'fast_commercial_policy_gate_blocked'
      );
      throw aiStageFailure('answer generation', aiDiagnostics.answerGenerationFallback);
    }

    const postAnswerCheck = applyPostAnswerVerificationPolicy({
      answer,
      factClaimPlanner,
      leadStateMachine,
      cardManifest,
      productEvidenceRegistry
    });
    answer = postAnswerCheck.answer;
    const factClaimAudit = postAnswerCheck.factClaimAudit;
    const postAnswerVerification = postAnswerCheck.postAnswerVerification;
    const postAnswerVerificationRecovery = postAnswerCheck.postAnswerVerificationRecovery;
    if (postAnswerVerification.status === 'error') {
      throw new Error(`Fast commercial answer violates post-answer verification: ${postAnswerVerification.issues.map((issue) => issue.code).join(', ')}`);
    }

    const contractWarnings = [
      ...contract.validatorWarnings,
      ...agentContractV2.warnings,
      ...requirementLedger.warnings,
      ...executionContract.warnings,
      ...cardManifest.warnings,
      ...productEvidenceRegistry.warnings,
      ...policyGate.warnings,
      ...policyGate.blockedReasons,
      ...policyGateEnforcement.warnings,
      ...policyGateEnforcement.hardBlockReasons,
      ...policyGateEnforcement.repairedReasons,
      ...factClaimPlanner.warnings,
      ...factClaimAudit.warnings,
      ...leadStateMachine.warnings,
      ...postAnswerVerification.issues.map((issue) => issue.code)
    ];
    const metadata = {
      turnId: input.turnId,
      turnContract: contract,
      agentContractV2,
      sourcePolicy: agentContractV2.sourcePolicy,
      toolTrace,
      answerMode: 'fast_commercial_handoff',
      cardPolicy: 'textOnly',
      cardsRole: contract.cardsRole,
      leadAllowed: contract.leadAllowed,
      leadDraft: leadDraft ?? undefined,
      productEvidenceRegistry,
      policyGate,
      policyGateEnforcement,
      executionContract,
      requirementLedger,
      cardManifest,
      factClaimPlanner,
      factClaimAudit,
      leadStateMachine,
      postAnswerVerification,
      postAnswerVerificationRecovery,
      aiDiagnostics,
      productCards: [] as ProductCard[],
      autoLead: autoLeadResult ? {
        created: autoLeadResult.created,
        leadId: autoLeadResult.lead?.id,
        emailStatus: autoLeadResult.emailStatus,
        missing: autoLeadResult.missing,
        error: autoLeadResult.error
      } : undefined,
      activeNeedsAfter: session.needState.activeNeeds ?? [],
      warnings: contractWarnings,
      contractWarnings
    };

    await input.onDelta?.(answer);
    const assistantMessage = await this.conversations.addMessage({
      sessionId: input.sessionId,
      role: 'assistant',
      content: answer,
      metadata
    });
    if (input.turnId) {
      await this.conversations.updateTurn({
        sessionId: input.sessionId,
        turnId: input.turnId,
        status: 'completed',
        stage: 'completed',
        assistantMessageId: assistantMessage.id,
        plannerContract: contract,
        activeNeedsAfter: session.needState.activeNeeds ?? []
      }).catch((error) => console.warn('Conversation turn fast commercial update failed', safeError(error)));
    }

    return {
      turnId: input.turnId,
      answer,
      needState: session.needState,
      productCards: [],
      usedWebSearch: false,
      leadRequested: leadRequestedForAnswer && !autoLeadResult?.created,
      leadCreated: autoLeadResult?.created ?? false,
      assistantMessageId: assistantMessage.id,
      metadata
    };
  }

  private async productCardsFromRecoveredSelection(state: CustomerNeedState, userMessage: string) {
    if (state.selectionState?.targetProductClass === 'generator' && shouldBlockGeneratorCardsForEstimatedPump(state.selectionState)) {
      return { cards: [] as ProductCard[], cardDisplay: undefined as CardDisplayOptions | undefined };
    }
    const ids = uniqueList(state.selectionState?.selectedProductIds ?? [], FULL_SLICE_PRODUCT_CARDS);
    const idSet = new Set(ids);
    const catalog = await this.products.listProducts(5000).catch(() => []);
    const byId = new Map(catalog.filter((product) => idSet.has(product.id)).map((product) => [product.id, product]));
    let selectedProducts = ids.map((id) => byId.get(id)).filter((product): product is Product => Boolean(product));
    let recoveredInitialVisibleCount: number | undefined;
    const profile = buildProductFitProfile(state, userMessage);
    const selectionState = state.selectionState ?? emptyProductSelectionState();
    selectedProducts = selectedProducts.filter((product) => productMatchesSelectionCriteria(product, selectionState, profile));
    const shouldRefreshFromCatalog = Boolean(state.selectionState && state.selectionState.targetProductClass !== 'unknown') &&
      hasMaterialHardConstraints(selectionState) &&
      (
        !selectedProducts.length ||
        Boolean(selectionState.hardConstraints.nominalPowerKwMin || selectionState.hardConstraints.nominalPowerKwMax) ||
        (selectionState.matchedProductIds?.length ?? 0) > selectedProducts.length
      );
    if (shouldRefreshFromCatalog && state.selectionState) {
      const hard = state.selectionState.hardConstraints;
      const intent = state.selectionState.targetProductClass as ProductIntent;
      const recoveryPlan: AssistantTurnPlan = {
        action: 'recommend_products',
        answerMode: 'productRecommendation',
        cardPolicy: 'showProducts',
        followUpPolicy: 'askClarifyingQuestion',
        contextScope: 'activeNeed',
        searchScope: 'focusedNeed',
        catalogSearchQuery: userMessage,
        selectedProductIds: [],
        requiredProductTraits: {
          ...emptyRequiredProductTraits(),
          productIntent: intent,
          productRole: hard.productRole !== 'unknown' ? hard.productRole : 'coreProduct',
          fuel: hard.fuel ?? 'unknown',
          startType: hard.startType ?? 'unknown',
          enclosure: hard.enclosure ?? 'unknown',
          conventionalGenerator: hard.conventionalGenerator ?? null,
          singlePhase220: hard.singlePhase220 ?? null,
          budgetMax: hard.budgetMax ?? null,
          weightKgMin: hard.weightKgMin ?? null,
          weightKgMax: hard.weightKgMax ?? null,
          diameterMmMin: hard.diameterMmMin ?? null,
          diameterMmMax: hard.diameterMmMax ?? null,
          nominalPowerKwMin: hard.nominalPowerKwMin ?? null,
          nominalPowerKwMax: hard.nominalPowerKwMax ?? null,
          maxPowerKwMin: hard.maxPowerKwMin ?? null,
          maxPowerKwMax: hard.maxPowerKwMax ?? null,
          provenance: hard.provenance
        },
        selectionState: {
          currentProductClass: intent,
          targetProductClass: intent,
          compatibilityTargetProduct: state.selectionState.compatibilityTargetProduct?.name ?? '',
          mustHaveTraits: hard.mustHaveTraits ?? [],
          niceToHaveTraits: state.selectionState.softPreferences?.mustHaveTraits ?? [],
          excludedClasses: hard.excludedClasses as ProductIntent[],
          brandConstraint: hard.brandConstraint ?? '',
          exactModelConstraint: hard.exactModelConstraint ?? '',
          isAccessoryFollowUp: false,
          selectionConfidence: state.selectionState.confidence,
          shouldShowCards: true,
          cardDisplayMode: 'structured_selection'
        },
        needsWebSearch: false,
        missingInformation: state.selectionState.unknowns ?? [],
        answerGuidance: 'Recovery catalog selection from validated structured need state.'
      };
      const selection = await this.selectProductsForTurn(userMessage, state, recoveryPlan, catalog, undefined, LARGE_SLICE_VISIBLE_CARDS);
      selectedProducts = (selection.matchedProducts.length
        ? selection.matchedProducts
        : selection.visibleProducts
      ).slice(0, FULL_SLICE_PRODUCT_CARDS);
      recoveredInitialVisibleCount = Math.min(
        selectedProducts.length,
        selection.visibleProducts.length || LARGE_SLICE_VISIBLE_CARDS
      );
    }
    if (!selectedProducts.length) return { cards: [] as ProductCard[], cardDisplay: undefined as CardDisplayOptions | undefined };
    const cards = productCards(selectedProducts, state, userMessage, profile, FULL_SLICE_PRODUCT_CARDS);
    const initialVisibleCount = Math.min(cards.length, recoveredInitialVisibleCount ?? LARGE_SLICE_VISIBLE_CARDS);
    return {
      cards,
      cardDisplay: cardDisplayOptions(initialVisibleCount, cards)
    };
  }

  async updateNeedState(
    current: CustomerNeedState,
    historySummary: string | null | undefined,
    userMessage: string,
    history: Message[],
    signal?: AbortSignal,
    diagnostics?: AiGenerationDiagnostics
  ) {
    const client = createOpenAIClient();
    const fallbackNeedState = (reason: unknown) => {
      markAiFallback(diagnostics, 'needExtractionFallback', reason, 'need_extraction_failed');
      const fallback = {
        ...current,
        lastSummary: current.lastSummary || summarizeNeedState(current)
      };
      return fallback;
    };
    if (!client) return fallbackNeedState('no_openai_client');

    try {
      const needExtractionRequest = {
        model: config.OPENAI_PLANNER_MODEL,
        input: [
          { role: 'system', content: buildNeedExtractorPrompt() },
          {
            role: 'user',
            content: yaml.dump(cleanEmpty({
              currentNeedState: current,
              historySummary: historySummary || undefined,
              recentHistory: compactHistoryForAI(history, 4, 700),
              latestUserMessage: userMessage
            }))
          }
        ],
        text: {
          format: {
            type: 'json_schema' as const,
            name: 'need_state_update',
            strict: true,
            schema: {
              type: 'object',
              additionalProperties: false,
              properties: {
                activeNeeds: { type: 'array', items: activeNeedSchema(), maxItems: 8 },
                explicitNeeds: { type: 'array', items: needItemSchema() },
                implicitNeeds: { type: 'array', items: needItemSchema() },
                constraints: { type: 'array', items: needItemSchema() },
                importantCriteria: { type: 'array', items: needItemSchema() },
                confirmedFacts: { type: 'array', items: needItemSchema() },
                uncertainInferences: { type: 'array', items: needItemSchema() },
                contradictions: { type: 'array', items: needItemSchema() },
                featureSignals: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    portable: { type: 'number', minimum: 0, maximum: 1 },
                    homeUse: { type: 'number', minimum: 0, maximum: 1 },
                    compact: { type: 'number', minimum: 0, maximum: 1 },
                    lowNoise: { type: 'number', minimum: 0, maximum: 1 },
                    coldStart: { type: 'number', minimum: 0, maximum: 1 },
                    professionalDuty: { type: 'number', minimum: 0, maximum: 1 },
                    budgetSensitive: { type: 'number', minimum: 0, maximum: 1 }
                  },
                  required: [
                    'portable',
                    'homeUse',
                    'compact',
                    'lowNoise',
                    'coldStart',
                    'professionalDuty',
                    'budgetSensitive'
                  ]
                },
                selectionState: needExtractionSelectionStateSchema(),
                semanticMemory: semanticMemorySchema(),
                lastSummary: { type: 'string' }
              },
              required: [
                'activeNeeds',
                'explicitNeeds',
                'implicitNeeds',
                'constraints',
                'importantCriteria',
                'confirmedFacts',
                'uncertainInferences',
                'contradictions',
                'featureSignals',
                'selectionState',
                'semanticMemory',
                'lastSummary'
              ]
            }
          }
        },
        max_output_tokens: Math.max(jsonOutputTokenLimit(config.OPENAI_NEED_MAX_OUTPUT_TOKENS), 8000)
      };
      const { response, parsed } = await createStructuredJsonResponse(
        client,
        needExtractionRequest,
        'need_extraction',
        signal
      );
      logOpenAIUsage('need_extraction', config.OPENAI_PLANNER_MODEL, response);
      const aiUpdate = coerceNeedUpdate(parsed);
      const merged = mergeNeedState(current, mergeNeedState(emptyNeedState(), aiUpdate));
      merged.lastSummary = parsed.lastSummary || summarizeNeedState(merged);
      return merged;
    } catch (error) {
      if (signal?.aborted) throw new Error('AI need extraction aborted');
      console.warn('OpenAI need extraction failed', safeError(error));
      return fallbackNeedState(error);
    }
  }

  async planAssistantTurn(input: {
    userMessage: string;
    needState: CustomerNeedState;
    products: Product[];
    knowledgePages: Awaited<ReturnType<ProductRepository['searchCatalogPages']>>;
    troubleshootingCases?: TroubleshootingCase[];
    conflicts: Awaited<ReturnType<ProductRepository['getOpenConflictsForProducts']>>;
    history: Message[];
    historySummary?: string | null;
    baseQuery: string;
    signal?: AbortSignal;
    diagnostics?: AiGenerationDiagnostics;
  }) {
    const client = createOpenAIClient();
    if (!client) {
      markAiFallback(input.diagnostics, 'turnPlanningFallback', 'no_openai_client', 'turn_planning_failed');
      return fallbackTurnPlan(input);
    }

    const deepPlanningReasoning = shouldUseDeepReasoningForPlanning(input.userMessage, input.conflicts);
    const planningProfile = resolveReasoningProfile(
      config.OPENAI_PLANNER_MODEL,
      config.OPENAI_PLANNER_REASONING_EFFORT,
      deepPlanningReasoning,
      input.conflicts.filter((conflict) => conflict.status === 'open').length
    );
    const plannerInput = [
      { role: 'system', content: buildTurnPlannerPrompt() },
      {
        role: 'user',
        content: yaml.dump(cleanEmpty({
          latestUserMessage: input.userMessage,
          currentNeedState: input.needState,
          historySummary: input.historySummary || undefined,
          recentHistory: compactHistoryForAI(input.history, 4, PLANNER_HISTORY_CONTENT_LIMIT),
          preliminaryCatalogCandidates: input.products.slice(0, PLANNER_CANDIDATE_LIMIT).map((product) => ({
            id: product.id,
            name: product.name,
            brand: product.brand,
            category: product.category,
            price: product.price,
            currency: product.currency,
            sourceUrl: product.sourceUrl,
            description: truncateForAI(product.description, PLANNER_PRODUCT_DESCRIPTION_LIMIT),
            specs: product.specs
          })),
          knowledgePages: input.knowledgePages.slice(0, 6).map((page) => ({
            title: page.title,
            pageType: page.pageType,
            sourceUrl: page.sourceUrl,
            summary: truncateForAI(page.summary, PLANNER_PAGE_SUMMARY_LIMIT),
            contentExcerpt: truncateForAI(page.content, PLANNER_PAGE_CONTENT_LIMIT)
          })),
          troubleshootingMemory: (input.troubleshootingCases ?? []).slice(0, 3).map((item) => ({
            model: item.model,
            faultCodes: item.faultCodes,
            problemSummary: truncateForAI(item.problemSummary, 500),
            verifiedAnswer: truncateForAI(item.answer, 1200),
            confidence: item.confidence,
            sourceCount: item.sourceUrls.length,
            semanticScore: item.semanticScore ?? undefined
          })),
          openDataConflicts: input.conflicts
        }))
      }
    ];
    const plannerRequest = {
      model: planningProfile.model,
      reasoning: { effort: planningProfile.effort },
      input: plannerInput,
      text: {
        format: {
          type: 'json_schema',
          name: 'assistant_turn_plan',
          strict: true,
          schema: turnPlanSchema()
        }
      },
      max_output_tokens: Math.max(jsonOutputTokenLimit(config.OPENAI_PLANNER_MAX_OUTPUT_TOKENS), PLANNER_JSON_OUTPUT_TOKEN_MIN)
    };

    try {
      const { response, parsed } = await createStructuredJsonResponse(
        client,
        plannerRequest,
        'turn_planner',
        input.signal
      );
      logOpenAIUsage('turn_planner', planningProfile.model, response);
      return coerceTurnPlan(parsed, input.baseQuery, input.userMessage);
    } catch (error) {
      let finalError: unknown = error;
      if (planningProfile.model !== config.OPENAI_PLANNER_MODEL) {
        try {
          const { response: fallbackResponse, parsed } = await createStructuredJsonResponse(
            client,
            {
              ...plannerRequest,
              model: config.OPENAI_PLANNER_MODEL,
              reasoning: { effort: config.OPENAI_PLANNER_REASONING_EFFORT }
            },
            'turn_planner',
            input.signal
          );
          logOpenAIUsage('turn_planner_fallback', config.OPENAI_PLANNER_MODEL, fallbackResponse);
          return coerceTurnPlan(parsed, input.baseQuery, input.userMessage);
        } catch (fallbackError) {
          finalError = fallbackError;
          console.warn('Deep planner fallback failed', safeError(fallbackError));
        }
      }
      if (input.signal?.aborted) throw new Error('AI turn planning aborted');
      console.warn('OpenAI turn planning failed', safeError(error));
      markAiFallback(input.diagnostics, 'turnPlanningFallback', finalError, 'turn_planning_failed');
      return fallbackTurnPlan(input);
    }
  }

  async findTroubleshootingMemory(userMessage: string, retrievalQuery?: string, signal?: AbortSignal): Promise<TroubleshootingMemoryResult> {
    const text = [userMessage, retrievalQuery].filter(Boolean).join(' ');
    const query = buildTroubleshootingSearchQuery(text);
    if (!query.modelKeys.length) return { cases: [], guidance: '', confidence: 0 };
    const embedding = await createEmbedding(text, signal).catch(() => null);
    const matches = await this.products.searchTroubleshootingCases({
      query: text,
      modelKeys: query.modelKeys,
      faultCodes: query.faultCodes,
      embedding,
      limit: 4
    }).catch(() => []);
    if (!matches.length) return { cases: [], guidance: '', confidence: 0 };
    const decision = await this.decideTroubleshootingMemoryUse(userMessage, matches, signal);
    if (!decision.usable || decision.confidence < 0.72) return { cases: [], guidance: '', confidence: decision.confidence };
    const selectedIds = new Set(decision.selectedCaseIds);
    return {
      cases: matches.filter((item) => selectedIds.has(item.id)).slice(0, 3),
      guidance: decision.answerGuidance,
      confidence: decision.confidence
    };
  }

  async decideTroubleshootingMemoryUse(userMessage: string, candidates: TroubleshootingCase[], signal?: AbortSignal): Promise<TroubleshootingMemoryDecision> {
    const client = createOpenAIClient();
    if (!client || !candidates.length) {
      return { usable: false, selectedCaseIds: [], confidence: 0, answerGuidance: '' };
    }

    try {
      const response: any = await withRetry(() => client.responses.create({
        model: config.OPENAI_PLANNER_MODEL,
        reasoning: { effort: config.OPENAI_PLANNER_REASONING_EFFORT },
        input: [
          {
            role: 'system',
            content: [
              'You are a semantic memory router for a sales/support assistant.',
              'Decide whether one or more stored troubleshooting cases answer the buyer latest question by meaning.',
              'Retrieval already found candidates by model/text; do not accept a case just because words, model tokens, or an error code overlap.',
              'Accept only when the equipment/model identity and the actual problem/symptom are the same or directly equivalent.',
              'Reject when the same model is mentioned but the fault, symptom, operating condition, or buyer need differs.',
              'If accepted, provide short answerGuidance telling the final assistant to use the stored verified case as internal checked memory and not repeat web search.'
            ].join(' ')
          },
          {
            role: 'user',
            content: yaml.dump(cleanEmpty({
              latestUserMessage: userMessage,
              candidates: candidates.map((item) => ({
                id: item.id,
                model: item.model,
                faultCodes: item.faultCodes,
                problemSummary: truncateForAI(item.problemSummary, 700),
                verifiedAnswer: truncateForAI(item.answer, 1200),
                confidence: item.confidence,
                semanticScore: item.semanticScore ?? undefined,
                sourceCount: item.sourceUrls.length
              }))
            }))
          }
        ],
        text: {
          format: {
            type: 'json_schema',
            name: 'troubleshooting_memory_decision',
            strict: true,
            schema: {
              type: 'object',
              additionalProperties: false,
              properties: {
                usable: { type: 'boolean' },
                selectedCaseIds: { type: 'array', items: { type: 'string' } },
                confidence: { type: 'number', minimum: 0, maximum: 1 },
                answerGuidance: { type: 'string' }
              },
              required: ['usable', 'selectedCaseIds', 'confidence', 'answerGuidance']
            }
          }
        },
        max_output_tokens: 900
      }, signal ? { signal } : undefined), 2, signal);
      logOpenAIUsage('troubleshooting_memory_router', config.OPENAI_PLANNER_MODEL, response);
      const parsed = parseJsonObject(responseTextForJson(response), 'troubleshooting_memory_router');
      const allowedIds = new Set(candidates.map((item) => item.id));
      const selectedCaseIds = Array.isArray(parsed.selectedCaseIds)
        ? parsed.selectedCaseIds.filter((id: unknown): id is string => typeof id === 'string' && allowedIds.has(id))
        : [];
      return {
        usable: Boolean(parsed.usable) && selectedCaseIds.length > 0,
        selectedCaseIds,
        confidence: typeof parsed.confidence === 'number' ? Math.max(0, Math.min(1, parsed.confidence)) : 0,
        answerGuidance: typeof parsed.answerGuidance === 'string' ? parsed.answerGuidance.trim().slice(0, 1200) : ''
      };
    } catch (error) {
      if (signal?.aborted) throw new Error('Troubleshooting memory routing aborted');
      console.warn('Troubleshooting memory routing failed', safeError(error));
      return { usable: false, selectedCaseIds: [], confidence: 0, answerGuidance: '' };
    }
  }

  async findProducts(userMessage: string, state: CustomerNeedState, retrievalQuery?: string, traits?: RequiredProductTraits, signal?: AbortSignal) {
    const query = retrievalQuery?.trim() || productSearchText(userMessage, state);
    const profile = buildProductFitProfile(state, userMessage, query, traits);
    const modelTokens = extractModelTokens(query);
    const exactResults = modelTokens.length ? await this.products.searchProductsByModelTokens(modelTokens, 30).catch(() => []) : [];
    const textResults = await this.products.searchProducts(query, 200);
    const supplementalLimit = profile.intent === 'generator' ? 360 : 120;
    const supplementalResults = (await Promise.all(
      supplementalCatalogQueries(profile).map((item) => this.products.searchProducts(item, supplementalLimit).catch(() => []))
    )).flat();
    const embedding = await createEmbedding(query, signal).catch(() => null);
    const vectorResults = embedding ? await this.products.vectorSearch(embedding, 50).catch(() => []) : [];
    const byId = new Map<string, Product>();
    for (const product of [...exactResults, ...textResults, ...supplementalResults, ...vectorResults]) byId.set(product.id, product);
    const scored = [...byId.values()]
      .map((product) => ({ product, score: recommendationScore(product, state, userMessage, profile) }))
      .sort((a, b) => b.score - a.score);
    const hasExactModelMatch = scored.some((item) => item.score >= 200);
    const filtered = scored
      .filter((item) => !hasExactModelMatch || item.score >= 120)
      .filter((item) => profile.intent === 'unknown' || productFitPenalty(item.product, profile) >= 0 || (exactModelCanBypassFit(profile) && productHasExactModel(item.product, profile)))
      .reduce<Array<{ product: Product; score: number }>>((items, item) => {
        if (items.length < PLANNER_CANDIDATE_LIMIT * 2) items.push(item);
        return items;
      }, [])
      .sort((a, b) => b.score - a.score);
    return diversifyRankedProducts(filtered).slice(0, PLANNER_CANDIDATE_LIMIT);
  }

  async findPlannerContextProducts(userMessage: string, state: CustomerNeedState, retrievalQuery?: string, signal?: AbortSignal) {
    const query = retrievalQuery?.trim() || productSearchText(userMessage, state);
    const modelTokens = extractModelTokens(query);
    const exactResults = modelTokens.length ? await this.products.searchProductsByModelTokens(modelTokens, 40).catch(() => []) : [];
    const textResults = await this.products.searchProducts(query, 240).catch(() => []);
    const supplementalResults = (await Promise.all(
      plannerContextSupplementalQueries(query).map((item) => this.products.searchProducts(item, 80).catch(() => []))
    )).flat();
    const embedding = await createEmbedding(query, signal).catch(() => null);
    const vectorResults = embedding ? await this.products.vectorSearch(embedding, 80).catch(() => []) : [];
    const byId = new Map<string, Product>();
    for (const product of [...exactResults, ...textResults, ...supplementalResults, ...vectorResults]) byId.set(product.id, product);
    const queryTokens = new Set(query.toLowerCase().match(/[a-zа-яё0-9]{3,}/giu) ?? []);
    const scored = [...byId.values()]
      .map((product) => {
        const text = productFullText(product);
        let score = modelTokens.some((token) => compactModelText(text).includes(compactModelText(token))) ? 180 : 0;
        for (const token of queryTokens) if (text.includes(token)) score += 8;
        if (isCoreEquipment(product)) score += 10;
        return { product, score };
      })
      .sort((a, b) => b.score - a.score);
    return scored.slice(0, PLANNER_CANDIDATE_LIMIT).map((item) => item.product);
  }

  async findKnowledgePages(userMessage: string, state: CustomerNeedState, retrievalQuery?: string, signal?: AbortSignal) {
    const query = retrievalQuery?.trim() || productSearchText(userMessage, state);
    const textResults = await this.products.searchCatalogPages(query, 6).catch(() => []);
    const embedding = await createEmbedding(query, signal).catch(() => null);
    const vectorResults = embedding ? await this.products.vectorSearchCatalogPages(embedding, 4).catch(() => []) : [];
    const byUrl = new Map<string, (typeof textResults)[number]>();
    for (const page of [...textResults, ...vectorResults]) byUrl.set(page.sourceUrl, page);
    return [...byUrl.values()].slice(0, 6);
  }

  async findCatalogLineupAlternatives(userMessage: string, state: CustomerNeedState, candidates: Product[]) {
    const anchor = findLineupAnchorProduct(userMessage, state, candidates);
    if (!anchor?.brand || !anchor.category) return [];

    const brandKey = normalizeBrandKey(anchor.brand);
    if (brandKey.length < 3) return [];

    const query = `${anchor.brand} ${anchor.category}`;
    const results = await this.products.searchProducts(query, 160).catch(() => []);
    const profile = buildProductFitProfile(state, userMessage);
    const seen = new Set<string>();
    return results
      .filter((product) => {
        if (seen.has(product.id)) return false;
        seen.add(product.id);
        if (product.id === anchor.id) return false;
        if (!isCoreLineupProduct(product)) return false;
        if (!isSameLineupClass(anchor, product)) return false;
        if (!normalizeBrandKey(product.brand).includes(brandKey) && !brandKey.includes(normalizeBrandKey(product.brand))) return false;
        if (productHasExactModel(product, profile)) return false;
        return true;
      })
      .sort((a, b) => (Number(a.price ?? Number.MAX_SAFE_INTEGER) - Number(b.price ?? Number.MAX_SAFE_INTEGER)))
      .slice(0, 12);
  }

  async selectProductsForTurn(
    userMessage: string,
    state: CustomerNeedState,
    plan: AssistantTurnPlan,
    baseCandidates: Product[],
    contract?: ResolvedTurnContract,
    visibleLimitOverride?: number,
    conversationUserText = '',
    options: { forceCatalogVerification?: boolean; restrictToBaseCandidates?: boolean } = {}
  ): Promise<ProductSelectionResult> {
    const currentSelection = state.selectionState ?? emptyProductSelectionState();
    const activeText = [userMessage, plan.catalogSearchQuery, conversationUserText, stateText(state, '')].filter(Boolean).join(' ');
    const profile = buildProductFitProfile(state, userMessage, plan.catalogSearchQuery, plan.requiredProductTraits);
    const selectionUpdate = explicitCriteriaFromTurn(currentSelection, userMessage, activeText, plan, profile, conversationUserText);
    let selectionState = mergeProductSelectionState(currentSelection, selectionUpdate);
    selectionState = applySemanticMemoryToSelectionState(
      selectionState,
      state.semanticMemory,
      [userMessage, plan.selectionState.exactModelConstraint, plan.catalogSearchQuery].filter(Boolean).join(' ')
    );
    selectionState = applyPlannerSelectionContract(selectionState, plan);
    selectionState = applyCurrentTurnExplicitNumericCriteria(selectionState, userMessage);
    selectionState = clearUngroundedExactModelSelectionState(
      selectionState,
      [userMessage, plan.selectionState.exactModelConstraint, plan.catalogSearchQuery].filter(Boolean).join(' ')
    );
    selectionState = applyCurrentTurnGeneratorPhase(
      selectionState,
      userMessage,
      plan.requiredProductTraits.singlePhase220
    );
    selectionState = clearStaleLoadSizingForExplicitCatalogPower(selectionState, userMessage, plan);
    selectionState = clearGeneratorOnlyCriteriaForNonGeneratorState(selectionState);
    selectionState = clearUngroundedGeneratorElectricStart(
      selectionState,
      [userMessage, conversationUserText, needEvidenceText(state)].filter(Boolean).join(' ')
    );
    if (selectionState.targetProductClass === 'plate' &&
      isSmallSitePlateNeed(activeText) &&
      !selectionState.hardConstraints.weightKgMin &&
      !selectionState.hardConstraints.weightKgMax) {
      const hardConstraints = {
        ...selectionState.hardConstraints,
        weightKgMin: 0,
        weightKgMax: 120,
        provenance: {
          ...(selectionState.hardConstraints.provenance ?? {}),
          weightKgMin: 'planner' as const,
          weightKgMax: 'planner' as const
        }
      };
      selectionState = {
        ...selectionState,
        hardConstraints,
        activeRequirement: {
          ...(selectionState.activeRequirement ?? hardConstraints),
          weightKgMin: 0,
          weightKgMax: 120,
          provenance: hardConstraints.provenance
        },
        rankingPreference: selectionState.rankingPreference ?? 'cheapest'
      };
    }
    selectionState = sanitizeSelfExcludingSelectionState(selectionState);
    const selectionProfile = buildProductFitProfile({ ...state, selectionState }, userMessage, plan.catalogSearchQuery, plan.requiredProductTraits);
    let effectiveSelectionState = selectionState;
    let effectiveSelectionProfile = selectionProfile;
    const canListProducts = typeof (this.products as { listProducts?: unknown }).listProducts === 'function';
    const catalogShortlistTurn = isCatalogShortlistTurn(userMessage, plan);
    const shouldUseCatalog = canListProducts &&
      !options.restrictToBaseCandidates &&
      selectionState.targetProductClass !== 'unknown' &&
      (!isLeadPlan(plan) || options.forceCatalogVerification) &&
      !shouldUseCurrentLineupStyle(userMessage, plan) &&
      (plan.cardPolicy !== 'textOnly' || catalogShortlistTurn || options.forceCatalogVerification) &&
      (contract?.render.cards !== 'none' || catalogShortlistTurn || options.forceCatalogVerification);
    const tokenRoles = selectionState.hardConstraints.exactModelTokenRoles ?? [];
    const memoryComparisonTokens = semanticMentionTokens(state.semanticMemory, ['availabilityCheck', 'comparison']);
    const memoryTargetTokens = semanticMentionTokens(state.semanticMemory, ['targetProduct']);
    const comparisonTokens = uniqueList([
      ...tokenRoles.filter((token) => token.role === 'comparisonProduct').map((token) => token.value),
      ...memoryComparisonTokens
    ], 32);
    const targetTokens = uniqueList([...selectionState.hardConstraints.exactModelTokens, ...memoryTargetTokens], 32);
    const lookupTokens = uniqueList([...targetTokens, ...comparisonTokens], 32);
    const exactProducts = lookupTokens.length
      ? await this.products.searchProductsByModelTokens(lookupTokens, 80).catch(() => [])
      : [];
    const exactTargetProducts = targetTokens.length
      ? exactProducts.filter((product) => productHasExactModel(product, { ...selectionProfile, exactModelTokens: targetTokens }))
      : [];
    const exactComparisonProducts = comparisonTokens.length
      ? exactProducts.filter((product) => productHasExactModel(product, { ...selectionProfile, exactModelTokens: comparisonTokens }))
      : [];
    const catalogPatterns = intentTextPatterns(selectionState.targetProductClass);
    const canFilterByText = catalogPatterns.length > 0 && typeof (this.products as { listProductsByTextFilter?: unknown }).listProductsByTextFilter === 'function';
    const allProducts = shouldUseCatalog
      ? (canFilterByText
          ? await (this.products as ProductRepository).listProductsByTextFilter(catalogPatterns, 5000).catch(() => [])
          : await this.products.listProducts(5000).catch(() => []))
      : [];
    const unscopedSourceProducts = shouldUseCatalog ? mergeProductsById(allProducts, [...baseCandidates, ...exactTargetProducts]) : mergeProductsById(baseCandidates, exactTargetProducts);
    const latestRangeOrLimit = Boolean(
      parseDesiredPowerRange(userMessage) ||
      parseWeightNeedRangeKg(userMessage) ||
      parseDimensionNeedRangeMm(userMessage) ||
      parseBudgetMax(userMessage)
    );
    const stalePreviousSelectionCage = plan.searchScope === 'previousSelectionOnly' &&
      latestRangeOrLimit &&
      plan.action === 'recommend_products' &&
      plan.cardPolicy === 'showProducts' &&
      plan.agentDecision?.catalogAction === 'find_matching_products' &&
      !plan.selectedProductIds.length;
    const previousSelectionOnly = plan.searchScope === 'previousSelectionOnly' && !stalePreviousSelectionCage;
    const currentVisibleSelectionIds = uniqueList([
      ...(contract?.selection.selectedProductIds ?? []),
      ...selectionState.selectedProductIds
    ].filter(Boolean), 64);
    const previousSelectionIds = previousSelectionOnly
      ? (currentVisibleSelectionIds.length
          ? currentVisibleSelectionIds
          : uniqueList([
              ...(selectionState.matchedProductIds ?? []),
              ...(selectionState.previousCandidateProductIds ?? [])
            ].filter(Boolean), 64))
      : [];
    const previousSelectionOrder = new Map(previousSelectionIds.map((id, index) => [id, index]));
    const sourceProducts = previousSelectionIds.length
      ? unscopedSourceProducts
        .filter((product) => previousSelectionOrder.has(product.id))
        .sort((a, b) => (previousSelectionOrder.get(a.id) ?? 9999) - (previousSelectionOrder.get(b.id) ?? 9999))
      : unscopedSourceProducts;
    const selectedIds = new Set(contract
      ? contract.selection.selectedProductIds
      : [...plan.selectedProductIds, ...selectionState.selectedProductIds]);
    let canRecommendFromSelection = hasReliableGeneratorSelectionBasis(effectiveSelectionState);
    const scoreProducts = (candidateState: ProductSelectionState, candidateProfile: ProductFitProfile) => canRecommendFromSelection
      ? sortSelectionProducts(sourceProducts
        .filter((product) => productMatchesSelectionCriteria(product, candidateState, candidateProfile))
        .map((product) => ({
          product,
          score: recommendationScore(product, { ...state, selectionState: candidateState }, userMessage, candidateProfile) + (selectedIds.has(product.id) ? 120 : 0)
        })), candidateState.rankingPreference, candidateState.hardConstraints.budgetMax)
      : [];
    let scored = scoreProducts(effectiveSelectionState, effectiveSelectionProfile);
    if (!scored.length) {
      const relaxedState = relaxedPlannerOnlyOptionalGeneratorTraits(selectionState);
      if (relaxedState) {
        const relaxedProfile = buildProductFitProfile({ ...state, selectionState: relaxedState }, userMessage, plan.catalogSearchQuery, plan.requiredProductTraits);
        const relaxedCanRecommend = hasReliableGeneratorSelectionBasis(relaxedState);
        const relaxedScored = relaxedCanRecommend
          ? sortSelectionProducts(sourceProducts
            .filter((product) => productMatchesSelectionCriteria(product, relaxedState, relaxedProfile))
            .map((product) => ({
              product,
              score: recommendationScore(product, { ...state, selectionState: relaxedState }, userMessage, relaxedProfile) + (selectedIds.has(product.id) ? 120 : 0)
            })), relaxedState.rankingPreference, relaxedState.hardConstraints.budgetMax)
          : [];
        if (relaxedScored.length) {
          effectiveSelectionState = relaxedState;
          effectiveSelectionProfile = relaxedProfile;
          canRecommendFromSelection = relaxedCanRecommend;
          scored = relaxedScored;
        }
      }
    }
    let matchedProducts = effectiveSelectionState.rankingPreference === 'cheapest'
      ? scored.slice(0, Math.max(50, FULL_SLICE_PRODUCT_CARDS)).map((item) => item.product)
      : effectiveSelectionState.rankingPreference === 'premium' || effectiveSelectionState.rankingPreference === 'balanced'
        ? diversifyRankedProducts(scored, Math.max(50, FULL_SLICE_PRODUCT_CARDS))
        : scored.slice(0, Math.max(50, FULL_SLICE_PRODUCT_CARDS)).map((item) => item.product);
    const exactLookupWantsCloseAlternative = !matchedProducts.length &&
      lookupTokens.length > 0 &&
      (plan.agentDecision?.catalogAction === 'exact_model_lookup' || plan.agentDecision?.catalogAction === 'verify_catalog_absence');
    const relaxedExactLookupState = exactLookupRelaxedSelectionState(effectiveSelectionState);
    const relaxedExactLookupProfile = exactLookupWantsCloseAlternative
      ? buildProductFitProfile({ ...state, selectionState: relaxedExactLookupState }, userMessage, plan.catalogSearchQuery, exactLookupRelaxedTraits(plan.requiredProductTraits))
      : effectiveSelectionProfile;
    const exactLookupAlternativeBrands = requestedBrandKeysFromProducts(
      mergeProductsById(exactProducts, sourceProducts),
      [
        activeText,
        effectiveSelectionState.hardConstraints.brandConstraint,
        plan.selectionState?.brandConstraint ?? ''
      ].join(' ')
    );
    const closeExactLookupAlternatives = exactLookupWantsCloseAlternative
      ? sortSelectionProducts(
          mergeProductsById(exactProducts, sourceProducts)
            .filter((product) => isCoreEquipment(product))
            .filter((product) => exactLookupAlternativeBrands.size === 0 || productMatchesRequestedBrand(product, exactLookupAlternativeBrands))
            .filter((product) => productMatchesSelectionCriteria(product, relaxedExactLookupState, relaxedExactLookupProfile))
            .filter((product) => productFitPenalty(product, relaxedExactLookupProfile) >= 0)
            .filter((product) => {
              const compact = compactModelText(productFullText(product));
              return lookupTokens.some((token) => productTextLooselyMatchesModelToken(compact, token));
            })
            .map((product) => ({
              product,
              score: recommendationScore(product, { ...state, selectionState: relaxedExactLookupState }, userMessage, relaxedExactLookupProfile)
            })),
          effectiveSelectionState.rankingPreference,
          effectiveSelectionState.hardConstraints.budgetMax
        )
        .slice(0, Math.max(1, Math.min(MAX_PRODUCT_CARDS, LARGE_SLICE_VISIBLE_CARDS)))
        .map((item) => item.product)
      : [];
    const exactLookupAlternative = !matchedProducts.length && closeExactLookupAlternatives.length > 0;
    if (exactLookupAlternative) {
      matchedProducts = closeExactLookupAlternatives;
      canRecommendFromSelection = true;
    }
    const heavyPlateTargetKg = !matchedProducts.length
      ? parseSingleWeightTargetKg([userMessage, plan.catalogSearchQuery].filter(Boolean).join(' '))
      : undefined;
    const heavyPlateTargetProducts = heavyPlateTargetKg !== undefined
      ? nearestHeavyPlateTargetProducts(
          sourceProducts,
          matchedProducts,
          effectiveSelectionState,
          effectiveSelectionProfile,
          heavyPlateTargetKg,
          Math.max(50, FULL_SLICE_PRODUCT_CARDS)
        )
      : [];
    if (heavyPlateTargetProducts.length) {
      matchedProducts = heavyPlateTargetProducts;
      canRecommendFromSelection = true;
    }
    const requestedVisibleLimit = visibleLimitOverride ?? requestedVisibleCardLimitFromText(userMessage);
    const shouldPinCurrentVisibleSelection = Boolean(
      requestedVisibleLimit &&
      currentVisibleSelectionIds.length >= requestedVisibleLimit &&
      plan.searchScope !== 'broadenAlternatives' &&
      !comparisonTokens.length &&
      !targetTokens.length
    );
    if (shouldPinCurrentVisibleSelection) {
      const pinnedOrder = new Map(currentVisibleSelectionIds.map((id, index) => [id, index]));
      const pinnedProducts = sourceProducts
        .filter((product) => pinnedOrder.has(product.id))
        .sort((a, b) => (pinnedOrder.get(a.id) ?? 9999) - (pinnedOrder.get(b.id) ?? 9999));
      const pinnedIds = new Set(pinnedProducts.map((product) => product.id));
      matchedProducts = [
        ...pinnedProducts,
        ...matchedProducts.filter((product) => !pinnedIds.has(product.id))
      ];
    }
    if (!matchedProducts.length && selectionState.rankingPreference && isRankingOnlyFollowUp(userMessage)) {
      const priorIds = new Set(
        (selectionState.matchedProductIds?.length ? selectionState.matchedProductIds : selectionState.previousCandidateProductIds) ?? []
      );
      if (priorIds.size) {
        matchedProducts = sortSelectionProducts(sourceProducts
          .filter((product) => priorIds.has(product.id))
          .filter((product) => isCoreEquipment(product))
          .map((product) => ({
            product,
            score: recommendationScore(product, { ...state, selectionState }, userMessage, selectionProfile)
          })), selectionState.rankingPreference, selectionState.hardConstraints.budgetMax)
          .slice(0, Math.max(50, FULL_SLICE_PRODUCT_CARDS))
          .map((item) => item.product);
      }
    }
    if (effectiveSelectionState.targetProductClass === 'plate' &&
      isSmallSitePlateNeed(activeText) &&
      !effectiveSelectionState.hardConstraints.budgetMax) {
      matchedProducts = [...matchedProducts].sort((a, b) => Number(a.price ?? Number.MAX_SAFE_INTEGER) - Number(b.price ?? Number.MAX_SAFE_INTEGER));
    }
    const rangeFallbackTurn = !matchedProducts.length && Boolean(
      effectiveSelectionState.hardConstraints.weightKgMin ||
      effectiveSelectionState.hardConstraints.weightKgMax ||
      effectiveSelectionState.hardConstraints.diameterMmMin ||
      effectiveSelectionState.hardConstraints.diameterMmMax
    );
    const semanticAlternatives = semanticAlternativeMode(state.semanticMemory, effectiveSelectionState.targetProductClass);
    const semanticShouldAddAlternatives = semanticAlternatives.mode === 'afterPrimary' ||
      (semanticAlternatives.mode === 'fallbackOnly' && !matchedProducts.length);
    const semanticBlocksAlternatives = semanticAlternatives.hasNumeric && semanticAlternatives.strictOnly;
    const catalogShortlistAlternativeLimit = !semanticBlocksAlternatives && (rangeFallbackTurn || semanticShouldAddAlternatives)
      ? Math.max(0, LARGE_SLICE_VISIBLE_CARDS - matchedProducts.length)
      : 0;
    const catalogShortlistAlternatives = catalogShortlistAlternativeLimit
      ? nearestCatalogShortlistAlternatives(
          sourceProducts,
          matchedProducts,
          effectiveSelectionState,
          effectiveSelectionProfile,
          catalogShortlistAlternativeLimit,
          new Set(exactComparisonProducts.map((product) => product.id))
        )
      : [];
    if (catalogShortlistAlternatives.length) {
      matchedProducts = mergeProductsById([], [...matchedProducts, ...catalogShortlistAlternatives]);
    }
    const matchedIds = new Set(matchedProducts.map((product) => product.id));
    const comparisonProducts = exactComparisonProducts
      .filter((product) => !matchedIds.has(product.id))
      .filter((product) => isCoreEquipment(product))
      .filter((product, index, all) => all.findIndex((candidate) => candidate.id === product.id) === index);
    const durableRejectedProducts = comparisonProducts.map((product) => ({
      productId: product.id,
      reason: productRejectionReason(product, effectiveSelectionState, effectiveSelectionProfile)
    }));
    const diagnosticRejectedProducts = [
      ...comparisonProducts.map((product) => ({
        productId: product.id,
        reason: productRejectionReason(product, effectiveSelectionState, effectiveSelectionProfile)
      })),
      ...sourceProducts
        .filter((product) => !matchedIds.has(product.id))
        .filter((product) => !comparisonProducts.some((candidate) => candidate.id === product.id))
        .map((product) => ({
          productId: product.id,
          reason: productRejectionReason(product, effectiveSelectionState, effectiveSelectionProfile)
        }))
        .filter((item) => item.reason !== 'does not satisfy active hard constraints')
        .slice(0, 80)
    ];
    const defaultVisibleLimit = matchedProducts.length > MAX_PRODUCT_CARDS ? LARGE_SLICE_VISIBLE_CARDS : MAX_PRODUCT_CARDS;
    const visibleLimit = Math.max(1, Math.min(defaultVisibleLimit, requestedVisibleLimit ?? defaultVisibleLimit));
    const visibleProducts = matchedProducts.slice(0, visibleLimit);
    const hiddenProducts = matchedProducts.slice(visibleLimit);
    const confidence = Math.max(effectiveSelectionState.confidence, matchedProducts.length ? 0.78 : effectiveSelectionState.targetProductClass === 'unknown' ? 0.2 : 0.45);
    const missingQuestions = missingQuestionsForSelection(effectiveSelectionState, matchedProducts.length);
    return {
      state: {
        ...effectiveSelectionState,
        selectedProductIds: visibleProducts.map((product) => product.id),
        matchedProductIds: matchedProducts.map((product) => product.id),
        comparisonProductIds: comparisonProducts.map((product) => product.id),
        rejectedProducts: durableRejectedProducts,
        previousCandidateProductIds: uniqueList([...matchedProducts, ...comparisonProducts].map((product) => product.id), 64),
        confidence,
        unknowns: missingQuestions,
        updatedAt: new Date().toISOString()
      },
      matchedProducts,
      visibleProducts,
      hiddenProducts,
      comparisonProducts,
      rejectedProducts: durableRejectedProducts,
      missingQuestions,
      confidence,
      trace: {
        source: shouldUseCatalog ? 'full_catalog_selection_engine' : 'candidate_selection_engine',
        targetProductClass: effectiveSelectionState.targetProductClass,
        hardConstraints: effectiveSelectionState.hardConstraints,
        comparisonTokens,
        semanticMemory: {
          activeRequirementIds: state.semanticMemory?.activeRequirementIds ?? [],
          selectionPolicy: state.semanticMemory?.selectionPolicy,
          alternativeMode: semanticAlternatives.mode,
          strictOnly: semanticAlternatives.strictOnly
        },
        rankingPreference: effectiveSelectionState.rankingPreference,
        totalSourceProducts: sourceProducts.length,
        totalMatched: matchedProducts.length,
        totalComparison: comparisonProducts.length,
        exactLookupAlternative,
        exactLookupAlternativeIds: exactLookupAlternative ? matchedProducts.map((product) => product.id) : [],
        stalePreviousSelectionCageRepaired: stalePreviousSelectionCage,
        diagnosticRejectedProducts,
        canRecommendFromSelection,
        catalogShortlistTurn,
        catalogShortlistAlternativeIds: catalogShortlistAlternatives.map((product) => product.id),
        visibleLimit
      }
    };
  }

  async findStructuredCatalogSlice(userMessage: string, state: CustomerNeedState, plan: AssistantTurnPlan, contract?: ResolvedTurnContract): Promise<StructuredCatalogSlice | null> {
    const activeText = [
      userMessage,
      plan.catalogSearchQuery,
      stateText(state, '')
    ].filter(Boolean).join(' ');
    const profile = buildProductFitProfile(state, userMessage, plan.catalogSearchQuery, plan.requiredProductTraits);
    const hasPlateText = /(?:\u0432\u0438\u0431\u0440\u043e\s*\u043f\u043b\u0438\u0442|\u0432\u0438\u0431\u0440\u043e\u043f\u043b\u0438\u0442|plate\s*compactor)/iu.test(activeText);
    const selectionState = plan.selectionState ?? emptySelectionState(plan.requiredProductTraits.productIntent);
    const targetIntent = selectionState.targetProductClass !== 'unknown'
      ? selectionState.targetProductClass
      : plan.requiredProductTraits.productIntent !== 'unknown'
        ? plan.requiredProductTraits.productIntent
        : profile.intent === 'unknown' && hasPlateText
          ? 'plate'
          : profile.intent;
    const exactModelConstraint = selectionState.exactModelConstraint.trim();
    const exactTokens = expandModelTokenAliases(extractModelTokens([userMessage, exactModelConstraint].filter(Boolean).join(' ')));
    const catalogOnlyExactLookup = exactTokens.length > 0 && isCatalogAvailabilityQuestion(userMessage) && !isManufacturingStatusQuestion(userMessage);
    const exactCatalogMatches = exactTokens.length && (catalogOnlyExactLookup || exactModelConstraint)
      ? await this.products.searchProductsByModelTokens(exactTokens, 80).catch(() => [])
      : [];
    const productIntent: ProductIntent = targetIntent;
    const sliceProfile: ProductFitProfile = productIntent === profile.intent ? profile : { ...profile, intent: productIntent };
    const weightRange = ['plate', 'rammer', 'roller', 'trowel'].includes(productIntent)
      ? parseWeightNeedRangeKg(activeText) ?? implicitPlateWeightRangeFromNeed(activeText, productIntent)
      : undefined;
    const dimensionRange = ['diamondCore', 'diamondBlade', 'cutter', 'trowel'].includes(productIntent)
      ? parseDimensionNeedRangeMm(activeText)
      : undefined;
    const powerRange = ['generator', 'weldingGenerator'].includes(productIntent)
      ? (sliceProfile.generatorPower ?? (sliceProfile.desiredPowerRange
          ? { nominalMin: sliceProfile.desiredPowerRange.min, nominalMax: sliceProfile.desiredPowerRange.max, source: 'explicit_text' as const }
          : undefined))
      : undefined;
    const budgetMax = sliceProfile.budgetMax;
    const canListProducts = typeof (this.products as { listProducts?: unknown }).listProducts === 'function';
    const catalogShortlistTurn = isCatalogShortlistTurn(userMessage, plan);
    const hasStructuredCriteria = Boolean(
      weightRange ||
      dimensionRange ||
      powerRange ||
      budgetMax ||
      selectionState.brandConstraint.trim() ||
      selectionState.mustHaveTraits.length ||
      exactModelConstraint
    );
    const shouldBuildFullSlice = canListProducts &&
      productIntent !== 'unknown' &&
      !isLeadPlan(plan) &&
      !shouldUseCurrentLineupStyle(userMessage, plan) &&
      (contract?.render.cards !== 'none' || catalogShortlistTurn) &&
      (hasStructuredCriteria ||
        (plan.action === 'recommend_products' &&
          (plan.cardPolicy !== 'textOnly' || catalogShortlistTurn) &&
          (selectionState.shouldShowCards || selectionState.selectionConfidence >= 0.55 || plan.selectedProductIds.length > 0)));

    if (!shouldBuildFullSlice && !catalogOnlyExactLookup) return null;
    if (!canListProducts && !exactCatalogMatches.length) return null;

    const slicePatterns = intentTextPatterns(productIntent);
    const canFilterSlice = slicePatterns.length > 0 && typeof (this.products as { listProductsByTextFilter?: unknown }).listProductsByTextFilter === 'function';
    const allProducts = canListProducts
      ? (canFilterSlice
          ? await (this.products as ProductRepository).listProductsByTextFilter(slicePatterns, 5000).catch(() => [])
          : await this.products.listProducts(5000).catch(() => []))
      : [];
    const explicitBrand = normalizeBrandKey(selectionState.brandConstraint);
    const requestedBrandSet = requestedBrandKeysFromProducts(allProducts, [activeText, selectionState.brandConstraint].join(' '));
    if (explicitBrand.length >= 3) requestedBrandSet.add(explicitBrand);
    const hasRequestedBrand = requestedBrandSet.size > 0;
    const powerMatches = (product: Product) => {
      if (!powerRange) return true;
      const power = extractGeneratorPower(product);
      const nominal = power.nominalKw;
      const max = power.maxKw;
      const nominalUpperTolerance = powerRange.source === 'estimated_load' ? 0.3 : 0.8;
      const maxUpperTolerance = powerRange.source === 'estimated_load' ? 0.5 : 1.0;
      if ((powerRange.nominalMin || powerRange.nominalMax) && nominal === undefined) return false;
      if ((powerRange.maxMin || powerRange.maxMax) && max === undefined) return false;
      if (powerRange.nominalMin && nominal !== undefined && nominal < powerRange.nominalMin - 0.4) return false;
      if (powerRange.nominalMax && nominal !== undefined && nominal > powerRange.nominalMax + nominalUpperTolerance) return false;
      if (powerRange.maxMin && max !== undefined && max < powerRange.maxMin - 0.5) return false;
      if (powerRange.maxMax && max !== undefined && max > powerRange.maxMax + maxUpperTolerance) return false;
      return true;
    };
    const rankDistance = (product: Product) => {
      let distance = 0;
      if (weightRange) {
        const weight = extractWeightKg(product);
        const center = (weightRange.min + weightRange.max) / 2;
        distance += weight === undefined ? 10_000 : Math.abs(weight - center);
      }
      if (dimensionRange) {
        const diameter = extractDimensionMm(product);
        const center = (dimensionRange.min + dimensionRange.max) / 2;
        distance += diameter === undefined ? 10_000 : Math.abs(diameter - center) * 0.25;
      }
      if (powerRange) {
        const nominal = extractGeneratorPower(product).nominalKw;
        const min = powerRange.nominalMin ?? powerRange.maxMin ?? 0;
        const max = powerRange.nominalMax ?? powerRange.maxMax ?? min;
        const center = (min + max) / 2;
        distance += nominal === undefined ? 10_000 : Math.abs(nominal - center) * 8;
      }
      return distance;
    };
    const matchedByConstraints = shouldBuildFullSlice
      ? allProducts
          .filter((product) => productMatchesIntent(product, productIntent))
          .filter((product) => !hasRequestedBrand || productMatchesRequestedBrand(product, requestedBrandSet))
          .filter((product) => !exactModelConstraint || productMatchesExactModelConstraint(product, exactModelConstraint, exactTokens))
          .filter((product) => productFitPenalty(product, sliceProfile) >= 0 || (exactModelCanBypassFit(sliceProfile) && productHasExactModel(product, { ...sliceProfile, exactModelTokens: exactTokens })))
          .filter((product) => {
            if (!weightRange) return true;
            const weight = extractWeightKg(product);
            return weight !== undefined && weight >= weightRange.min && weight <= weightRange.max;
          })
          .filter((product) => {
            if (!dimensionRange) return true;
            const dimension = extractDimensionMm(product);
            return dimension !== undefined && dimension >= dimensionRange.min && dimension <= dimensionRange.max;
          })
          .filter(powerMatches)
          .sort((a, b) => {
            if (budgetMax) {
              const aPrice = Number(a.price ?? -1);
              const bPrice = Number(b.price ?? -1);
              const aWithin = aPrice > 0 && aPrice <= budgetMax;
              const bWithin = bPrice > 0 && bPrice <= budgetMax;
              if (aWithin !== bWithin) return aWithin ? -1 : 1;
              if (aWithin && bWithin && aPrice !== bPrice) return aPrice - bPrice;
            }
            const distance = rankDistance(a) - rankDistance(b);
            if (distance !== 0) return distance;
            const score = recommendationScore(b, state, userMessage, sliceProfile) - recommendationScore(a, state, userMessage, sliceProfile);
            if (score !== 0) return score;
            return Number(a.price ?? Number.MAX_SAFE_INTEGER) - Number(b.price ?? Number.MAX_SAFE_INTEGER);
          })
      : [];

    if (matchedByConstraints.length) {
      return {
        source: productIntent === 'plate' && weightRange ? 'structured_constraints' : 'full_catalog_slice',
        products: matchedByConstraints,
        totalMatched: matchedByConstraints.length,
        visibleLimit: matchedByConstraints.length > MAX_PRODUCT_CARDS ? LARGE_SLICE_VISIBLE_CARDS : matchedByConstraints.length,
        constraints: {
          productIntent,
          weightKgMin: weightRange?.min,
          weightKgMax: weightRange?.max,
          diameterMmMin: dimensionRange?.min,
          diameterMmMax: dimensionRange?.max,
          nominalPowerKwMin: powerRange?.nominalMin,
          nominalPowerKwMax: powerRange?.nominalMax,
          maxPowerKwMin: powerRange?.maxMin,
          maxPowerKwMax: powerRange?.maxMax,
          budgetMax,
          brandConstraint: selectionState.brandConstraint || undefined,
          exactModelConstraint: exactModelConstraint || undefined,
          mustHaveTraits: selectionState.mustHaveTraits.length ? selectionState.mustHaveTraits : undefined,
          exactModelTokens: exactTokens.length ? exactTokens : undefined
        },
        exactCatalogMatches
      };
    }

    if (exactCatalogMatches.length) {
      return {
        source: 'exact_model_lookup',
        products: exactCatalogMatches,
        totalMatched: exactCatalogMatches.length,
        visibleLimit: exactCatalogMatches.length > MAX_PRODUCT_CARDS ? LARGE_SLICE_VISIBLE_CARDS : exactCatalogMatches.length,
        constraints: {
          productIntent,
          weightKgMin: weightRange?.min,
          weightKgMax: weightRange?.max,
          exactModelTokens: exactTokens
        },
        exactCatalogMatches
      };
    }

    return null;
  }

  async generateAnswer(input: GenerateAnswerInput): Promise<ChatResponsePayload> {
    const session = await this.conversations.getSession(input.sessionId);
    if (!session || session.status !== 'active') throw new Error('Conversation session is not active');
    const consistencyGuard = getSessionGuard(input.sessionId);
    const traceTotal = traceTimer('generateAnswer', input.sessionId);
    const aiDiagnostics = emptyAiGenerationDiagnostics();
    const activeNeedsBefore = session.needState.activeNeeds ?? [];
    const semanticMemoryBefore = session.needState.semanticMemory;
    const needStateBeforeTurn = session.needState;

    const userMessage = input.skipUserMessage
      ? null
      : await this.conversations.addMessage({ sessionId: input.sessionId, role: 'user', content: input.userMessage });
    if (input.turnId && userMessage) {
      await this.conversations.updateTurn({
        sessionId: input.sessionId,
        turnId: input.turnId,
        status: 'received',
        stage: 'received',
        userMessageId: userMessage.id,
        activeNeedsBefore
      }).catch((error) => console.warn('Conversation turn receive update failed', safeError(error)));
    }
    const client = createOpenAIClient();

    const history = await this.conversations.listMessages(input.sessionId, 80);
    const previousSelectionState = session.needState.selectionState;
    let needState = await this.updateNeedState(session.needState, session.historySummary, input.userMessage, history, input.signal, aiDiagnostics);
    if (aiDiagnostics.needExtractionFallback.used) {
      throw aiStageFailure('need extraction', aiDiagnostics.needExtractionFallback);
    }
    if (shouldPreserveSelectionForFollowUp(input.userMessage, previousSelectionState)) {
      needState = {
        ...needState,
        selectionState: {
          ...previousSelectionState,
          softPreferences: needState.selectionState?.softPreferences ?? previousSelectionState.softPreferences,
          unknowns: needState.selectionState?.unknowns?.length ? needState.selectionState.unknowns : previousSelectionState.unknowns,
          conflicts: needState.selectionState?.conflicts?.length ? needState.selectionState.conflicts : previousSelectionState.conflicts
        }
      };
    }
    await this.conversations.updateNeedState(input.sessionId, needState);
    if (input.turnId) {
      await this.conversations.updateTurn({
        sessionId: input.sessionId,
        turnId: input.turnId,
        status: 'need_extracted',
        stage: 'need_extracted',
        activeNeedsAfter: needState.activeNeeds ?? []
      }).catch((error) => console.warn('Conversation turn need update failed', safeError(error)));
    }
    await this.conversations.updateSessionTopic(input.sessionId, deriveConversationTopic(input.userMessage, needState))
      .catch((error) => console.warn('Conversation topic update failed', safeError(error)));

    const hasPriorShownCardsForFastLead = allShownProductCards(history).length > 0;
    const fastCommercialContactConfirmation = hasPriorShownCardsForFastLead && hasLikelyContactText(input.userMessage) && fallbackDetectLeadHandoffIntent(input.userMessage)
      ? await this.tryFastCommercialHandoff(input, { ...session, needState }, history, aiDiagnostics)
      : null;
    if (fastCommercialContactConfirmation) return fastCommercialContactConfirmation;

    const fastCatalogSelection = await this.tryFastCatalogSelection(input, needState, history, aiDiagnostics);
    if (fastCatalogSelection) return fastCatalogSelection;

    const fastTechnicalOrientation = await this.tryFastTechnicalOrientation(input, needState, history, aiDiagnostics);
    if (fastTechnicalOrientation) return fastTechnicalOrientation;

    const baseQuery = productSearchText(input.userMessage, needState);
    const preliminaryCandidates = await this.findPlannerContextProducts(input.userMessage, needState, baseQuery, input.signal);
    const preliminaryKnowledgePages = await this.findKnowledgePages(input.userMessage, needState, baseQuery, input.signal);
    const troubleshootingMemoryResult = await this.findTroubleshootingMemory(input.userMessage, baseQuery, input.signal);
    const troubleshootingMemory = troubleshootingMemoryResult.cases;
    const preliminaryConflicts = await this.products.getOpenConflictsForProducts(preliminaryCandidates.map((product) => product.id));
    const plan = await this.planAssistantTurn({
      userMessage: input.userMessage,
      needState,
      products: preliminaryCandidates,
      knowledgePages: preliminaryKnowledgePages,
      troubleshootingCases: troubleshootingMemory,
      conflicts: preliminaryConflicts,
      history,
      historySummary: session.historySummary,
      baseQuery,
      signal: input.signal,
      diagnostics: aiDiagnostics
    });
    if (aiDiagnostics.turnPlanningFallback.used) {
      throw aiStageFailure('turn planning', aiDiagnostics.turnPlanningFallback);
    }
    if (!plan.agentContractV2 && !plan.agentDecision) {
      const diagnostic = markAiFallback(
        aiDiagnostics,
        'turnPlanningFallback',
        'missing_agent_contract_v2',
        'missing_agent_contract_v2'
      );
      throw aiStageFailure('turn planning', diagnostic);
    }

    const preliminaryLegacyAgentTurnContract = deriveAgentTurnContract({
      userMessage: input.userMessage,
      plan,
      needState
    });
    const preliminaryAgentContractV2 = deriveAgentTurnContractV2({
      userMessage: input.userMessage,
      legacyContract: preliminaryLegacyAgentTurnContract,
      plan,
      needState,
      selectedProductIds: plan.selectedProductIds
    });
    const preliminaryAgentTurnContract = contractV2ToLegacyAgentContract(preliminaryAgentContractV2);
    const skipRefinedCatalogLookup = shouldFreezeSelectionContextForNonCatalogTurn(preliminaryAgentTurnContract) &&
      preliminaryAgentTurnContract.catalogAction === 'none' &&
      preliminaryAgentTurnContract.cardsRole === 'none';
    const refinedCatalogToolTrace: AgentToolTraceItem[] = [];
    const refinedCatalogSearchNeeded = plan.catalogSearchQuery !== baseQuery && !skipRefinedCatalogLookup;
    let refinedCandidates: Product[] = [];
    if (refinedCatalogSearchNeeded) {
      const refinedSearchToolStep = preliminaryAgentContractV2.toolPlan.find((step) => step.tool === 'searchCatalog') ?? {
        tool: 'searchCatalog' as const,
        reason: 'Runtime refined catalog search after planner query selection.',
        required: preliminaryAgentTurnContract.catalogAction !== 'none',
        inputHint: {
          baseQuery,
          catalogSearchQuery: plan.catalogSearchQuery
        }
      };
      const refinedSearchExecution: { products?: Product[] } = {};
      const refinedSearchRegistry = new AgentToolRegistry({
        searchCatalog: async (step) => {
          const products = await this.findProducts(input.userMessage, needState, plan.catalogSearchQuery, plan.requiredProductTraits, input.signal);
          refinedSearchExecution.products = products;
          return {
            tool: step.tool,
            ok: true,
            risk: 'safe',
            result: {
              mode: 'runtime_catalog_refined_search_execution',
              query: plan.catalogSearchQuery,
              matchedProducts: products.length,
              productIds: products.map((product) => product.id).slice(0, 20)
            },
            warnings: products.length ? [] : ['catalog_refined_search_returned_no_matches'],
            durationMs: 0
          };
        }
      });
      const [refinedSearchToolResult] = await refinedSearchRegistry.executePlan([refinedSearchToolStep], {
        sessionId: input.sessionId,
        userMessage: input.userMessage,
        history,
        needState,
        signal: input.signal,
        policy: {
          leadAllowed: preliminaryAgentTurnContract.leadAllowed,
          webAllowed: !preliminaryAgentContractV2.sourcePolicy.forbidden.includes('web'),
          webPurpose: preliminaryAgentContractV2.sourcePolicy.webPurpose
        }
      });
      if (refinedSearchToolResult) {
        refinedCatalogToolTrace.push(toolResultToTrace(refinedSearchToolStep, refinedSearchToolResult));
      }
      refinedCandidates = refinedSearchToolResult?.ok ? refinedSearchExecution.products ?? [] : [];
    }
    const byId = new Map<string, Product>();
    for (const product of [...refinedCandidates, ...preliminaryCandidates]) byId.set(product.id, product);
    const leadRequestedBeforeCards = isLeadPlan(plan);
    const shownProductChoiceTurn = isShownProductChoiceOrComparisonQuestion(input.userMessage);
    const visibleShownProductsForChoice = shownProductChoiceTurn ? lastVisibleShownProductCards(history) : [];
    if (leadRequestedBeforeCards) {
      for (const product of lastShownProductCards(history)) byId.set(product.id, product);
    }
    if (visibleShownProductsForChoice.length) {
      byId.clear();
      for (const product of visibleShownProductsForChoice) byId.set(product.id, product);
    }
    if (leadRequestedBeforeCards) {
      const purchaseContextText = [
        input.userMessage,
        plan.catalogSearchQuery,
        needState.lastSummary,
        stateText(needState, ''),
        recentConversationText(history),
        lastShownProductCards(history).map((product) => product.name).join(' ')
      ].filter(Boolean).join(' ');
      const modelProducts = await this.products.searchProductsByModelTokens(extractModelTokens(purchaseContextText), 40).catch(() => []);
      for (const product of modelProducts) byId.set(product.id, product);
      if (containsAny(purchaseContextText, oilTerms)) {
        const oilProducts = await this.findProducts(input.userMessage, needState, purchaseContextText, {
          ...plan.requiredProductTraits,
          productIntent: 'engineOil'
        }, input.signal).catch(() => []);
        for (const product of oilProducts) byId.set(product.id, product);
      }
    }
    let allCandidates = [...byId.values()];
    const purchasePlan = purchasePlanIfNeeded(plan, allCandidates, history, needState, input.userMessage);
    let effectivePlan = purchasePlan.plan;
    const legacyAgentTurnContract = deriveAgentTurnContract({
      userMessage: input.userMessage,
      plan: effectivePlan,
      needState
    });
    const initialAgentContractV2 = deriveAgentTurnContractV2({
      userMessage: input.userMessage,
      legacyContract: legacyAgentTurnContract,
      plan: effectivePlan,
      needState,
      selectedProductIds: effectivePlan.selectedProductIds
    });
    const agentTurnContract = contractV2ToLegacyAgentContract(initialAgentContractV2);
    effectivePlan = { ...effectivePlan, agentContractV2: initialAgentContractV2 };
    const needStateBeforeContractDelta = needState;
    needState = applyContractNeedDelta({
      needState,
      needDelta: initialAgentContractV2.needDelta
    });
    if (needState !== needStateBeforeContractDelta) {
      await this.conversations.updateNeedState(input.sessionId, needState);
    }
    effectivePlan = applyAgentTurnContractToPlan(effectivePlan, agentTurnContract);
    const freezeSelectionPersistence = shouldFreezeSelectionContextForNonCatalogTurn(agentTurnContract);
    const needStateBeforeFreeze = needState;
    needState = freezeSelectionContextForNonCatalogTurn(needState, needStateBeforeTurn, agentTurnContract);
    if (needState !== needStateBeforeFreeze) {
      await this.conversations.updateNeedState(input.sessionId, needState);
    }
    if (input.turnId) {
      await this.conversations.updateTurn({
        sessionId: input.sessionId,
        turnId: input.turnId,
        status: 'planned',
        stage: 'planned',
        plannerContract: agentTurnContract,
        activeNeedsAfter: needState.activeNeeds ?? []
      }).catch((error) => console.warn('Conversation turn plan update failed', safeError(error)));
    }
    if (client && shouldEnrichGeneratorLoadReference(input.userMessage)) {
      await enrichGeneratorLoadReferenceFromWeb(client, input.userMessage, input.signal)
        .catch((error) => console.warn('Generator load reference enrichment failed', safeError(error)));
    }
    const visibleCardLimit = effectiveVisibleCardLimitFromConversation(input.userMessage, history);
    let turnContract = resolveTurnContractForPlan(effectivePlan);
    const selectionStateBeforeProductSelection = needState.selectionState;
    const selectionToolStep = initialAgentContractV2.toolPlan.find((step) => step.tool === 'selectProducts') ?? {
      tool: 'selectProducts' as const,
      reason: 'Runtime product selection and card preparation before final answer generation.',
      required: agentTurnContract.cardsRole !== 'none' || agentTurnContract.catalogAction === 'find_matching_products',
      inputHint: {
        catalogAction: agentTurnContract.catalogAction,
        cardsRole: agentTurnContract.cardsRole
      }
    };
    const selectionExecution: { result?: ProductSelectionResult } = {};
    const selectionToolRegistry = new AgentToolRegistry({
      selectProducts: async (step) => {
        const result = await this.selectProductsForTurn(
          input.userMessage,
          needState,
          effectivePlan,
          allCandidates,
          turnContract,
          visibleCardLimit,
          recentUserConversationText(history),
          {
            forceCatalogVerification: agentTurnContract.catalogAction !== undefined && agentTurnContract.catalogAction !== 'none',
            restrictToBaseCandidates: shownProductChoiceTurn && visibleShownProductsForChoice.length > 0
          }
        );
        selectionExecution.result = result;
        return {
          tool: step.tool,
          ok: true,
          risk: 'safe',
          result: {
            mode: 'runtime_product_selection_execution',
            matchedProducts: result.matchedProducts.length,
            visibleProducts: result.visibleProducts.length,
            hiddenProducts: result.hiddenProducts.length,
            rejectedProductIds: result.rejectedProducts.map((item) => item.productId).slice(0, 20),
            missingQuestions: result.missingQuestions.slice(0, 5),
            traceSource: result.trace?.source
          },
          warnings: [],
          durationMs: 0
        };
      }
    });
    const [selectionToolResult] = await selectionToolRegistry.executePlan([selectionToolStep], {
      sessionId: input.sessionId,
      userMessage: input.userMessage,
      history,
      needState,
      signal: input.signal,
      policy: {
        leadAllowed: agentTurnContract.leadAllowed,
        webAllowed: !initialAgentContractV2.sourcePolicy.forbidden.includes('web'),
        webPurpose: initialAgentContractV2.sourcePolicy.webPurpose
      }
    });
    const selectionResult = selectionExecution.result;
    if (!selectionResult || !selectionToolResult?.ok) {
      const error = selectionToolResult?.error ?? 'selection_tool_failed_without_result';
      markAiFallback(aiDiagnostics, 'answerGenerationFallback', error, 'selection_tool_failed');
      throw aiStageFailure('answer generation', aiDiagnostics.answerGenerationFallback);
    }
    const selectionToolTrace = [toolResultToTrace(selectionToolStep, selectionToolResult)];
    const preAnswerToolTrace = [...refinedCatalogToolTrace, ...selectionToolTrace];
    for (const product of selectionResult.comparisonProducts) byId.set(product.id, product);
    const semanticMemoryAfterSelection = freezeSelectionPersistence
      ? needState.semanticMemory
      : reconcileSemanticMemoryWithSelection(needState.semanticMemory, selectionResult);
    if (!freezeSelectionPersistence) {
      if (
        JSON.stringify(selectionResult.state) !== JSON.stringify(needState.selectionState) ||
        JSON.stringify(semanticMemoryAfterSelection) !== JSON.stringify(needState.semanticMemory)
      ) {
        needState = { ...needState, selectionState: selectionResult.state, semanticMemory: semanticMemoryAfterSelection };
        await this.conversations.updateNeedState(input.sessionId, needState);
      }
    }
    const memoryDecisions = memoryDecisionSummary(semanticMemoryBefore, needState.semanticMemory);
    const selectionHard = selectionResult.state.hardConstraints;
    const allowPreliminaryEstimatedPumpCatalogCards = shouldAllowPreliminaryCatalogCardsForEstimatedPump(
      agentTurnContract,
      selectionResult
    );
    const selectionCanRecommend = hasReliableGeneratorSelectionBasis(selectionResult.state) ||
      allowPreliminaryEstimatedPumpCatalogCards;
    const selectionHasEstimatedPump = hasEstimatedPumpLoad(selectionResult.state);
    const currentTurnCanBlockForEstimatedPump = selectionHard.productIntent === 'generator' &&
      agentTurnContract.catalogAction !== 'exact_model_lookup' &&
      agentTurnContract.catalogAction !== 'verify_catalog_absence' &&
      agentTurnContract.taskType !== 'comparison' &&
      agentTurnContract.taskType !== 'technical_answer';
    const selectionBlocksEstimatedPumpCards = shouldBlockGeneratorCardsForEstimatedPump(selectionResult.state);
    const latestLoadProfileForPumpBlock = selectionStateBeforeProductSelection.loadProfile ?? selectionResult.state.loadProfile;
    const latestTurnBlocksEstimatedPumpCards = currentTurnCanBlockForEstimatedPump && Boolean(
      selectionBlocksEstimatedPumpCards &&
      latestLoadProfileForPumpBlock &&
      hasEstimatedPumpLoadProfile(latestLoadProfileForPumpBlock) &&
      !hasPreliminaryGeneratorSelectionBasisFromProfile(latestLoadProfileForPumpBlock)
    );
    const currentTurnExplicitCatalogPowerSelection = selectionHard.productIntent === 'generator' &&
      agentTurnContract.catalogAction === 'find_matching_products' &&
      agentTurnContract.productCardsPolicy !== 'none' &&
      Boolean(parseDesiredPowerRange(input.userMessage) || hasExplicitGeneratorPowerRequest(input.userMessage));
    const blockEstimatedPumpCards = currentTurnCanBlockForEstimatedPump &&
      !allowPreliminaryEstimatedPumpCatalogCards &&
      !currentTurnExplicitCatalogPowerSelection &&
      (selectionBlocksEstimatedPumpCards || latestTurnBlocksEstimatedPumpCards);
    const structuredCatalogSlice: StructuredCatalogSlice | null = selectionResult.matchedProducts.length
      ? {
          source: selectionResult.trace.source === 'full_catalog_selection_engine' ? 'full_catalog_slice' : 'structured_constraints',
          products: selectionResult.matchedProducts,
          totalMatched: selectionResult.matchedProducts.length,
          visibleLimit: selectionResult.visibleProducts.length,
          constraints: {
            productIntent: selectionHard.productIntent as ProductIntent,
            weightKgMin: selectionHard.weightKgMin,
            weightKgMax: selectionHard.weightKgMax,
            diameterMmMin: selectionHard.diameterMmMin,
            diameterMmMax: selectionHard.diameterMmMax,
            nominalPowerKwMin: selectionHard.nominalPowerKwMin,
            nominalPowerKwMax: selectionHard.nominalPowerKwMax,
            maxPowerKwMin: selectionHard.maxPowerKwMin,
            maxPowerKwMax: selectionHard.maxPowerKwMax,
            budgetMax: selectionHard.budgetMax,
            brandConstraint: selectionHard.brandConstraint,
            exactModelConstraint: selectionHard.exactModelConstraint,
            mustHaveTraits: selectionHard.mustHaveTraits.length ? selectionHard.mustHaveTraits : undefined,
            exactModelTokens: selectionHard.exactModelTokens.length ? selectionHard.exactModelTokens : undefined
          },
          exactCatalogMatches: selectionHard.exactModelTokens.length ? selectionResult.matchedProducts : undefined
        }
      : null;
    let catalogFactCheckRequestsCards = false;
    if (structuredCatalogSlice?.products.length) {
      for (const product of structuredCatalogSlice.products) byId.set(product.id, product);
      for (const product of structuredCatalogSlice.exactCatalogMatches ?? []) byId.set(product.id, product);
      const selectionEngineRequestsCards = shouldForceStructuredSelectionCards(input.userMessage, effectivePlan, selectionResult);
      const primarySelectionRequestsCards = shouldPromotePrimarySelectionCards(agentTurnContract, effectivePlan, selectionResult, blockEstimatedPumpCards);
      catalogFactCheckRequestsCards = shouldPromoteCatalogFactCheckedCards(agentTurnContract, effectivePlan, selectionResult, blockEstimatedPumpCards);
      const supportingSelectionRequestsCards = shouldPromoteSupportingSelectionCards(agentTurnContract, effectivePlan, selectionResult, blockEstimatedPumpCards);
      const generatorSizingRequestsCards = agentTurnContract.cardsRole !== 'none' &&
        shouldPromoteGeneratorSizingCardsForContract(agentTurnContract, selectionResult, blockEstimatedPumpCards);
      if ((agentTurnContract.cardsRole === 'primary' || (agentTurnContract.cardsRole === 'supporting' && (generatorSizingRequestsCards || supportingSelectionRequestsCards)) || catalogFactCheckRequestsCards) &&
        (planAllowsCatalogSelectionOverride(effectivePlan) || selectionEngineRequestsCards || primarySelectionRequestsCards || allowPreliminaryEstimatedPumpCatalogCards || generatorSizingRequestsCards || supportingSelectionRequestsCards || catalogFactCheckRequestsCards) &&
        (structuredCatalogSlice.source === 'structured_constraints' || structuredCatalogSlice.source === 'full_catalog_slice')) {
        effectivePlan = promotePlanToSelectionCatalogCards(
          effectivePlan,
          selectionResult,
          allowPreliminaryEstimatedPumpCatalogCards
            ? 'The buyer explicitly asked for catalog generator options and productSelection found visible matches from the current load estimate. Show those cards as preliminary options, state that pump model/power can still change the final recommendation, and ask for pump data after the cards instead of blocking the catalog request.'
            : generatorSizingRequestsCards
            ? 'The buyer has supplied enough generator load context for a preliminary product selection. First answer the sizing calculation, then show visible generator cards as preliminary suitable options. Do not keep the turn text-only.'
            : supportingSelectionRequestsCards
              ? 'The buyer asked for catalog options or close alternatives and productSelection found reliable matching products. Show those products as supporting cards, explain the fit or compromise against the stated constraints, and do not answer as if the catalog has no usable options.'
            : catalogFactCheckRequestsCards
              ? selectionResult.trace?.exactLookupAlternative === true
                ? 'Catalog fact-check did not prove the exact spelling, but found close same-brand/model-token catalog alternatives. Show those cards as supporting alternatives, say the exact card is not visible, and ask whether the buyer meant the close model. Separate catalog presence from first-person stock verification.'
                : 'Catalog fact-check found products that satisfy the structured hard constraints, so do not answer as if the catalog has no matching product. Use productSelection as authoritative, show matching cards, and separate catalog presence from first-person stock/logistics verification.'
              : 'Use productSelection as the authoritative catalog selection for the current hard constraints. Name only visible cards as recommendations. If hiddenProductIds is not empty, mention show-more and ask one narrowing question from missingQuestions.'
        );
      }
      if (!isLeadPlan(effectivePlan) && structuredCatalogSlice.source === 'exact_model_lookup') {
        const hasCoreExact = structuredCatalogSlice.products.some((product) => isCoreEquipment(product));
        effectivePlan = {
          ...effectivePlan,
          action: 'answer_question',
          answerMode: 'short',
          cardPolicy: hasCoreExact ? 'showProducts' : 'textOnly',
          followUpPolicy: 'answerNowNoDeferredOffer',
          needsWebSearch: false,
          answerGuidance: [
            effectivePlan.answerGuidance,
            'The buyer asked whether named models exist in the catalog. Answer from exactCatalogMatches first. Explain whether each found item is a core product or only an accessory/consumable, and compare found core products against the current hard constraints.'
          ].filter(Boolean).join('\n')
        };
      }
      allCandidates = [...byId.values()];
    }
    if (!selectionCanRecommend && selectionHard.productIntent === 'generator') {
      effectivePlan = {
        ...effectivePlan,
        action: 'ask_clarifying_question',
        answerMode: 'short',
        cardPolicy: 'textOnly',
        followUpPolicy: 'askClarifyingQuestion',
        selectedProductIds: [],
        answerGuidance: [
          effectivePlan.answerGuidance,
          'Do not recommend generator models yet. The current request lacks a reliable load or power basis. Ask for connected consumers and their kW/W loads, including motor startup loads if known.'
        ].filter(Boolean).join('\n')
      };
    }
    if (blockEstimatedPumpCards) {
      effectivePlan = {
        ...effectivePlan,
        action: 'ask_clarifying_question',
        answerMode: 'short',
        cardPolicy: 'textOnly',
        followUpPolicy: 'askClarifyingQuestion',
        selectedProductIds: [],
        answerGuidance: [
          effectivePlan.answerGuidance,
          'A pump is present but its power/model/type is still unknown, so productSelection is only a load-risk estimate, not a recommendation. Do not name generator models or show catalog cards yet. Ask for pump power, model, or at least pump type, and explain that motor startup current controls the final generator class.'
        ].filter(Boolean).join('\n')
      };
    }
    if (selectionHasEstimatedPump && !blockEstimatedPumpCards && agentTurnContract.cardsRole !== 'none') {
      effectivePlan = {
        ...effectivePlan,
        answerGuidance: [
          effectivePlan.answerGuidance,
          'Pump power is still unknown, but the dialogue already has enough context for a preliminary generator shortlist. Show suitable generator cards as preliminary options, mark the recommendation as not final until pump model/power is known, and prefer the lower-priced models that satisfy the calculated kW class instead of asking only another clarifying question.'
        ].filter(Boolean).join('\n')
      };
    }
    if (!blockEstimatedPumpCards && currentTurnCanBlockForEstimatedPump && selectionHard.productIntent === 'generator' && selectionResult.state.loadProfile?.requiredNominalKw) {
      effectivePlan = {
        ...effectivePlan,
        answerGuidance: [
          effectivePlan.answerGuidance,
          `Calculated generator load from current dialogue: minimum nominal power ${selectionResult.state.loadProfile.requiredNominalKw} kW, starting demand ${selectionResult.state.loadProfile.requiredStartingKw} kW. Use the calculated load as the minimum and treat catalog powers above it only as options when they are present in the selected cards or inside the structured sizing policy.`
        ].filter(Boolean).join('\n')
      };
    }
    turnContract = resolveTurnContractForPlan(effectivePlan);
    effectivePlan = applyResolvedTurnContractToPlan(effectivePlan, turnContract);
    effectivePlan = applyAgentTurnContractToPlan(effectivePlan, agentTurnContract);
    turnContract = resolveTurnContractForPlan(effectivePlan);
    effectivePlan = applyResolvedTurnContractToPlan(effectivePlan, turnContract);
    if (catalogFactCheckRequestsCards && effectivePlan.cardPolicy === 'textOnly') {
      effectivePlan = promotePlanToSelectionCatalogCards(
        effectivePlan,
        selectionResult,
        'Catalog fact-check found matching products after the semantic contract marked the turn text-only. Keep the answer grounded in those catalog matches and show cards instead of claiming absence.'
      );
      turnContract = resolveTurnContractForPlan(effectivePlan);
      effectivePlan = applyResolvedTurnContractToPlan(effectivePlan, turnContract);
    }
    const answerAgentTurnContract: AgentTurnContract = catalogFactCheckRequestsCards && selectionResult.trace?.exactLookupAlternative === true
      ? {
          ...agentTurnContract,
          cardsRole: 'supporting',
          productCardsPolicy: 'supporting_only',
          validatorWarnings: uniqueList([
            ...(agentTurnContract.validatorWarnings ?? []),
            'exact_lookup_cards_policy_repaired_after_catalog_fact_check'
          ], 12)
        }
      : agentTurnContract;
    const baseSelectionMetadata = selectionMetadata(selectionResult);
    const loadProfileSupportsCurrentPower = selectionHard.provenance?.nominalPowerKwMin === 'inferred_from_load' ||
      selectionHard.provenance?.nominalPowerKwMax === 'inferred_from_load' ||
      selectionHard.provenance?.maxPowerKwMin === 'inferred_from_load' ||
      selectionHard.provenance?.maxPowerKwMax === 'inferred_from_load';
    const exposeLoadProfileToAnswer = blockEstimatedPumpCards ||
      (currentTurnCanBlockForEstimatedPump && !currentTurnExplicitCatalogPowerSelection && loadProfileSupportsCurrentPower);
    const loadProfileForAnswer = exposeLoadProfileToAnswer ? selectionResult.state.loadProfile : undefined;
    const productSelectionForAnswer: ProductSelectionMetadata = !exposeLoadProfileToAnswer && baseSelectionMetadata.loadProfile
      ? {
          ...baseSelectionMetadata,
          loadProfile: undefined,
          selectionTrace: {
            ...(baseSelectionMetadata.selectionTrace ?? {}),
            loadProfileSuppressedForCurrentTurn: true
          }
        }
      : baseSelectionMetadata;
    const exactLookupAlternativeGuidance = selectionResult.trace?.exactLookupAlternative === true
      ? 'For exact model lookup with close catalog alternatives, answer as a BAKAUT AI manager: say the exact model is not visible in the current catalog, show the closest in-catalog alternative from productCardsVisibleFirst, and ask whether this is the model the buyer meant. Do not stop at "not found" when close alternatives are available.'
      : '';
    const currentLineupStyle = shouldUseCurrentLineupStyle(input.userMessage, effectivePlan);
    const catalogLineupAlternatives = currentLineupStyle
      ? await this.findCatalogLineupAlternatives(input.userMessage, needState, allCandidates)
      : [];
    for (const product of catalogLineupAlternatives) byId.set(product.id, product);
    allCandidates = [...byId.values()];
    const selectedCandidateIds = new Set(effectivePlan.selectedProductIds);
    const candidatePool = structuredCatalogSlice?.products.length
      ? mergeProductsById(structuredCatalogSlice.products, allCandidates)
      : allCandidates;
    const candidates = [
      ...candidatePool.filter((product) => selectedCandidateIds.has(product.id)),
      ...candidatePool.filter((product) => !selectedCandidateIds.has(product.id))
    ].slice(0, PLANNER_CANDIDATE_LIMIT);
    const knowledgePages = plan.catalogSearchQuery !== baseQuery
      ? await this.findKnowledgePages(input.userMessage, needState, plan.catalogSearchQuery, input.signal)
      : preliminaryKnowledgePages;
    const conflicts = await this.products.getOpenConflictsForProducts(candidates.map((product) => product.id));
    const productsForCardSelection = structuredCatalogSlice?.products.length
      ? structuredCatalogSlice.products
      : candidates;
    const cardPayloadLimit = structuredCatalogSlice?.products.length || selectionResult.hiddenProducts.length
      ? FULL_SLICE_PRODUCT_CARDS
      : MAX_PRODUCT_CARDS;
    const cardSelection = selectCardsFromTurnContract(productsForCardSelection, needState, input.userMessage, effectivePlan, turnContract, {
      cardLimit: cardPayloadLimit,
      respectRequestedCardLimit: false
    });
    const initialVisibleCount = exactAvailabilityInitialVisibleCount(
      initialVisibleCardCountForCards(cardSelection.cards, selectionResult, visibleCardLimit),
      cardSelection.cards,
      selectionResult,
      answerAgentTurnContract
    );
    let finalCards = finalCardsDecisionFromCards(cardSelection.cards, selectionResult, effectivePlan, initialVisibleCount);
    let cards: ProductCard[] = finalCards.cards;
    const requirementLedger = buildRequirementLedger({
      needState,
      selectionState: selectionResult.state
    });
    const preliminaryExecutionContract = buildExecutionContract({
      agentContract: answerAgentTurnContract,
      renderContract: turnContract,
      selectionState: selectionResult.state,
      webRequired: false,
      activeRequirementIds: requirementLedger.activeRequirementIds
    });
    let cardManifest = buildCardManifest({
      executionContract: preliminaryExecutionContract,
      cards,
      visibleProductIds: finalCards.visibleProductIds,
      hiddenProductIds: finalCards.hiddenProductIds
    });
    const cardEnforcement = enforceVisibleCardConstraints({ manifest: cardManifest, cards });
    if (cardEnforcement.enforced) {
      finalCards = finalCardsDecisionFromCards(
        cardEnforcement.cards,
        selectionResult,
        effectivePlan,
        exactAvailabilityInitialVisibleCount(
          initialVisibleCardCountForCards(cardEnforcement.cards, selectionResult, visibleCardLimit),
          cardEnforcement.cards,
          selectionResult,
          answerAgentTurnContract
        )
      );
      cards = finalCards.cards;
    }
    const productCardsAnswer = !isLeadPlan(effectivePlan) &&
      cards.length > 0 &&
      (answerAgentTurnContract.cardsRole !== 'none' ||
        effectivePlan.action === 'recommend_products' ||
        effectivePlan.cardPolicy === 'showProducts' ||
        effectivePlan.answerMode === 'productRecommendation');
    const textOnlyTechnicalAnswer = freezeSelectionPersistence;
    const answerCurrentLineupStyle = productCardsAnswer ? false : currentLineupStyle;
    const detailedFactStyle = productCardsAnswer || textOnlyTechnicalAnswer
      ? false
      : shouldUseDetailedFactStyle(input.userMessage, effectivePlan, cards.length);
    const serviceCostStyle = shouldUseServiceCostStyle(input.userMessage, effectivePlan, detailedFactStyle);
    const troubleshootingMemoryCanAnswer = troubleshootingMemory.length > 0;
    const contractV2RequiresWeb = effectivePlan.agentContractV2
      ? sourcePolicyRequiresWeb(effectivePlan.agentContractV2.sourcePolicy)
      : false;
    const mustUseWebSearch = troubleshootingMemoryCanAnswer
      ? false
      : contractV2RequiresWeb
        ? true
        : productCardsAnswer || textOnlyTechnicalAnswer
          ? false
          : shouldUseWebSearch(input.userMessage, effectivePlan);
    const agentContractV2: AgentTurnContractV2 = deriveAgentTurnContractV2({
      userMessage: input.userMessage,
      legacyContract: answerAgentTurnContract,
      plan: effectivePlan,
      needState,
      webRequired: mustUseWebSearch,
      selectedProductIds: finalCards.visibleProductIds,
      rejectedProductIds: selectionResult.rejectedProducts.map((item) => item.productId)
    });
    const executionContract = buildExecutionContract({
      agentContract: answerAgentTurnContract,
      renderContract: turnContract,
      selectionState: selectionResult.state,
      webRequired: mustUseWebSearch,
      activeRequirementIds: requirementLedger.activeRequirementIds
    });
    cardManifest = buildCardManifest({
      executionContract,
      cards,
      visibleProductIds: finalCards.visibleProductIds,
      hiddenProductIds: finalCards.hiddenProductIds
    });
    if (cardEnforcement.enforced) {
      cardManifest.warnings.push(`visible_card_constraint_violations_suppressed:${cardEnforcement.suppressedProductIds.join(',')}`);
    }
    const cardDisplay = cardDisplayOptions(finalCards.initialVisibleCount, cards);
    const bundleTotalPrice = reliableBundleTotal(cards, input.userMessage, needState);
    const factClaimPlanner = buildFactClaimPlanner({
      executionContract,
      requirementLedger,
      cardManifest,
      usedWebSearch: mustUseWebSearch
    });
    const productEvidenceRegistry: ProductEvidenceRegistry = buildProductEvidenceRegistry({
      executionContract,
      cardManifest,
      cards,
      catalogProducts: allCandidates,
      rejectedProducts: selectionResult.rejectedProducts
    });
    const suppressLeadRequestByContract = shouldSuppressLeadRequestFromContract(answerAgentTurnContract, input.userMessage);
    const extractedLeadContact = hasLikelyContactText(input.userMessage)
      ? extractLeadContactDetails(input.userMessage)
      : undefined;
    const leadDraft: LeadDraft | null = buildLeadDraft({
      contract: agentContractV2,
      registry: productEvidenceRegistry,
      buyerQuestion: input.userMessage,
      contact: extractedLeadContact
    });
    const leadRequestedForAnswer = shouldRequestLeadFormForAnswer({
      leadDraft,
      suppressLeadRequest: suppressLeadRequestByContract,
      purchaseLeadRequested: purchasePlan.leadRequested,
      leadPlan: isLeadPlan(effectivePlan),
      leadPolicy: agentContractV2.leadPolicy,
      commercialAction: agentContractV2.commercialAction
    });
    const shouldCreateLead = shouldCommitLeadFromDraft({
      draft: leadDraft,
      leadRequested: leadRequestedForAnswer,
      executionLeadPolicy: executionContract.leadPolicy,
      contact: extractedLeadContact
    });
    const autoLeadResult = shouldCreateLead
      ? await this.createLeadFromChatContact(session, history, cards, input.userMessage, needState)
      : null;
    const leadStateMachine = buildLeadStateMachine({
      executionContract,
      hasContactInTurn: Boolean(extractedLeadContact),
      leadRequested: leadRequestedForAnswer,
      leadCreated: autoLeadResult?.created ?? false,
      missing: autoLeadResult?.missing,
      error: autoLeadResult?.error
    });
    const policyGate: PolicyGateResult = runPolicyGate({
      contract: agentContractV2,
      requirementLedger,
      productEvidenceRegistry,
      executionContract,
      factClaimPlanner,
      leadStateMachine,
      webSearchPlanned: mustUseWebSearch
    });
    const toolRegistry = new AgentToolRegistry(createRuntimeArtifactToolHandlers({
      contract: agentContractV2,
      selection: {
        matchedProducts: selectionResult.matchedProducts,
        rejectedProducts: selectionResult.rejectedProducts
      },
      productEvidenceRegistry,
      leadDraft,
      autoLeadResult,
      webSearchEnabled: mustUseWebSearch
    }));
    const preExecutedToolNames = new Set(preAnswerToolTrace.map((item) => item.tool));
    const postSelectionToolPlan = agentContractV2.toolPlan.filter((step) => !preExecutedToolNames.has(step.tool));
    const toolResults = await toolRegistry.executePlan(postSelectionToolPlan, {
      sessionId: input.sessionId,
      userMessage: input.userMessage,
      history,
      needState,
      signal: input.signal,
      policy: {
        leadAllowed: agentContractV2.leadPolicy !== 'forbidden',
        webAllowed: !agentContractV2.sourcePolicy.forbidden.includes('web'),
        webPurpose: agentContractV2.sourcePolicy.webPurpose
      }
    });
    const postSelectionToolTrace = toolResults.map((result, index) => toolResultToTrace(postSelectionToolPlan[index]!, result));
    const pendingPreAnswerTrace = [...preAnswerToolTrace];
    const pendingPostSelectionTrace = [...postSelectionToolTrace];
    const plannedToolTrace = agentContractV2.toolPlan.flatMap((step) => {
      const preIndex = pendingPreAnswerTrace.findIndex((item) => item.tool === step.tool);
      if (preIndex >= 0) return [pendingPreAnswerTrace.splice(preIndex, 1)[0]!];
      const trace = pendingPostSelectionTrace.shift();
      return trace ? [trace] : [];
    });
    const toolTrace = [
      ...pendingPreAnswerTrace,
      ...plannedToolTrace,
      ...pendingPostSelectionTrace
    ];
    const policyGateEnforcement: PolicyGateEnforcement = enforcePolicyGateBeforeAnswer({
      policyGate,
      toolTrace
    });
    if (policyGateEnforcement.mode === 'hard_block') {
      markAiFallback(
        aiDiagnostics,
        'answerGenerationFallback',
        `policy_gate_blocked:${policyGateEnforcement.hardBlockReasons.join(',')}`,
        'policy_gate_blocked'
      );
      throw aiStageFailure('answer generation', aiDiagnostics.answerGenerationFallback);
    }
    const deepAnswerReasoning = shouldUseDeepReasoningForAnswer(
      effectivePlan,
      answerCurrentLineupStyle,
      detailedFactStyle,
      mustUseWebSearch,
      conflicts.length
    );
    const answerComplexityScore = [answerCurrentLineupStyle, detailedFactStyle, mustUseWebSearch, conflicts.length > 0].filter(Boolean).length;
    const answerProfile = {
      model: config.OPENAI_ANSWER_MODEL,
      effort: config.OPENAI_ANSWER_REASONING_EFFORT
    } as const;
    const comparativeAnswerGuidance = effectivePlan.searchScope === 'broadenAlternatives'
      ? 'When the buyer compares alternatives against a named model, use catalogComparisonDiagnostics as authoritative for comparative claims: say cheaper only when isCheaper is true, say more powerful only when isMorePowerful is true, and if no alternative is both cheaper and more powerful, say that directly before listing tradeoffs.'
      : '';
    const troubleshootingMemoryGuidance = troubleshootingMemory.length
      ? [
          'answerContext.troubleshootingCases contains previously verified troubleshooting answers selected by the LLM semantic memory router for the same model/problem. Use it as internal checked memory. Answer from that memory without claiming a new web check; do not show source URLs/domains.',
          troubleshootingMemoryResult.guidance
        ].filter(Boolean).join(' ')
      : '';
    const factualVerificationGuidance = answerCurrentLineupStyle
      ? 'For current-lineup/manufacturing-status questions, do a multi-source proof analysis. Check current manufacturer/catalog evidence, support/manuals/parts evidence, official distributor/current dealer evidence, and used/archive/discontinued/replacement evidence. Do not turn "not found in the current catalog" into a definitive discontinued claim by itself. If proof is incomplete, state the known facts and confidence level. Do not call an alternative a successor/replacement unless the source explicitly supports that; otherwise call it a current alternative in the same class and distinguish single-direction from reversible plates. Cross-check source-mentioned alternatives against catalogLineupAlternatives/catalogCandidates and mention concrete in-catalog alternatives with prices when available. Catalog-only alternatives prove sale/support presence, not current factory production. If a same-family catalog item near the questioned model is not supported by web evidence as current, call it "есть в нашем каталоге", not "актуальная замена". If mandatoryCatalogLineupAlternativeFacts is non-empty, use it as the compact catalog facts block and include its concrete RUB prices in the answer. If catalogLineupAlternatives has several items, name the best 1-3 by relevance and price and use catalogLineupAlternativeGroups for one compact sentence about other source-mentioned families and their RUB price floors, especially if they are higher-price, reversible, battery/electric, or only broadly same-class.'
      : detailedFactStyle || effectivePlan.action === 'verify_with_web'
        ? 'For factual technical questions, separate confirmed facts from inference. Use web evidence to verify missing or conflicting facts, and keep uncertain parts explicitly marked as not confirmed.'
        : '';
    const factualVerificationPolicy = buildFactualVerificationPolicy({
      userMessage: input.userMessage,
      plan: effectivePlan,
      currentLineupStyle: answerCurrentLineupStyle,
      detailedFactStyle
    });
    const searchContextSize = webSearchContextSize(answerCurrentLineupStyle, detailedFactStyle, answerComplexityScore);
    const responseStyle = answerCurrentLineupStyle
      ? {
          defaultLength: 'short',
          maxParagraphs: 3,
          maxBullets: 4,
          guidance: [
            factualVerificationGuidance,
            'Покупатель спрашивает, выпускается ли конкретная модель сейчас или есть ли она в текущей линейке.',
            'Ответь прямо с практическим выводом для покупателя: новая актуальная модель или, вероятнее, уже не текущая/не основная линейка. Не уходи в длинное сервисное сравнение, если последняя реплика его не просит.',
            'Разделяй факты: публичная текущая линейка производителя отдельно, товары и запчасти из нашего каталога отдельно. Если в catalogCandidates есть точная модель или запчасти к ней, упомяни это как факт каталога, но не называй это подтверждением производства у завода.',
            'Не подтягивай старые модели из предыдущего сравнения, если покупатель в последней реплике спрашивает только про одну модель.',
            'Не отправляй покупателя смотреть к дилеру как основной ответ: если нет заводского 100% подтверждения, скажи уровень уверенности и практический вывод.',
            'Не показывай товарные карточки и не заканчивай предложением продолжить потом в любых формулировках вроде "дальше сравню", "дальше могу собрать", "могу проверить"; лучше дай следующий полезный шаг: если нужна новая техника - смотреть актуальную замену, если уже есть эта модель - можно оценить ремонт/запчасти.'
          ].join(' ')
        }
      : serviceCostStyle
      ? {
          defaultLength: 'detailed',
          maxParagraphs: 6,
          maxBullets: 8,
          guidance: [
            'Покупатель спрашивает не просто карточку товара, а практическое сравнение по сервису, расходникам, запчастям или стоимости владения.',
            'Обязан закрыть вопрос в текущем ответе: дай сравнительный анализ, а не общий текст и не предложение продолжить потом.',
            'Структура обязательна: короткий вывод; затем список или таблица с позициями расходников/запчастей по каждой модели; затем итог по стоимости владения.',
            'В списке сравни минимум: воздушный фильтр, топливный фильтр/сетка, свеча, ремень, сервис-набор, режущие диски/круги, стартер, карбюратор/топливный узел, водяной узел или другие релевантные позиции.',
            'По каждой позиции дай цену в рублях: точную из каталога/поиска или рыночный диапазон/ориентир в ₽. Если точную цену найти нельзя, не пиши общий отказ; напиши ориентир или честно "не нашел уверенной цены" только для этой позиции.',
            'Не показывай карточки товаров для технического сравнения: карточки нужны для подбора/покупки, а здесь нужен только текстовый сравнительный ответ.',
            'Если точные цены зависят от региона, дилера или артикула, не уходи в отказ. Дай проверенные ориентиры, диапазоны или относительное сравнение и отдельно скажи от своего лица, что финальную смету сверишь перед заказом.',
            'Не подменяй стоимость расходников ценой самой машины. Если покупатель спрашивает про расходники и запчасти, сравни именно фильтры, свечи, ремни, диски, сервис-наборы, стартеры, карбюраторные/водяные узлы или другие релевантные позиции.',
            'При поиске цен на запчасти и расходники учитывай российские маркетплейсы, российские магазины запчастей и dyadko.ru, а не только зарубежные или официальные страницы.',
            'Если цена найдена в валюте на зарубежном источнике, переведи ее в рубли по актуальному или явно указанному курсу и пометь как ориентировочную.',
            'Не заканчивай предложением "могу дальше сравнить", если покупатель уже попросил сравнение: сделай это сравнение сразу.',
            'Не показывай URL, домены и markdown-ссылки; источники остаются внутренними.'
          ].join(' ')
        }
      : {
          defaultLength: 'short',
          maxParagraphs: 2,
          maxBullets: 3,
          guidance: leadRequestedForAnswer
            ? answerAgentTurnContract.answerTask === 'lead_handoff'
              ? 'The buyer is asking a commercial/specialist question, not necessarily buying now. Answer in 1-2 short sentences: delivery/discount/availability/final terms require first-person verification by the BAKAUT AI manager. Say the form is open for name and phone so you can check it and return with the answer. Do not show or re-list product cards unless cardsRole is primary. Do not treat this as a finalized order.'
              : 'Answer the product selection or technical part first. If the turn includes delivery, availability, discount, deadlines, order processing, or other individual terms, add one short sentence that the form is open for name and phone so you can verify those terms and return with the answer. Do not say the order/lead is already created. Do not continue selecting alternatives.'
            : [
                'Answer like a human sales consultant. If productCardsShown is not empty, the text must be only a short conclusion: max 3-4 short sentences, max 2 model names, no full list of all cards. The main/best recommendation in text must be productCardsVisibleFirst[0]. Mention other visible cards only as alternatives. Do not call a lower card or hidden show-more card the best option. Do not end with a generic deferred offer like "if you want, I can continue"; give a finished recommendation for the current request.',
                comparativeAnswerGuidance
              ].filter(Boolean).join(' ')
        };

    const visibleCardsForAnswer = cards.slice(0, finalCards.initialVisibleCount);
    const cardIdsForAnswer = new Set(cards.map((card) => card.id));
    const answerNeedsFullCatalogContext = answerCurrentLineupStyle ||
      detailedFactStyle ||
      mustUseWebSearch ||
      effectivePlan.action === 'verify_with_web';
    const recommendationAnswer = effectivePlan.action === 'recommend_products' || effectivePlan.answerMode === 'productRecommendation';
    const productsForAnswer = answerContextProductsForCards({
      answerNeedsFullCatalogContext,
      recommendationAnswer,
      blockEstimatedPumpCards,
      cards: recommendationAnswer ? visibleCardsForAnswer : cards,
      candidates,
      cardSourceProducts: productsForCardSelection
    });
    const priceRangeForAnswer = productCardPriceRange(cards);
    const visibleCardIdsForContext = new Set(visibleCardsForAnswer.map((card) => card.id));
    const shownCardIdsForContext = new Set(cards.map((card) => card.id));
    const suitableProductsForContext = blockEstimatedPumpCards
      ? []
      : selectionResult.matchedProducts.length
      ? selectionResult.matchedProducts
      : productsForCardSelection.filter((product) => cardIdsForAnswer.has(product.id));
    const generatorSizingPolicy = generatorSizingPolicyForAnswer(loadProfileForAnswer, visibleCardsForAnswer);
    const compactCommercialHandoffAnswer = answerAgentTurnContract.answerTask === 'lead_handoff' &&
      answerAgentTurnContract.commercialAction === 'explain_manager_required' &&
      answerAgentTurnContract.catalogAction === 'none' &&
      answerAgentTurnContract.cardsRole === 'none' &&
      answerAgentTurnContract.productCardsPolicy === 'none' &&
      !answerAgentTurnContract.leadAllowed &&
      cards.length === 0;
    const runtimeContractsForAnswer = compactRuntimeContractsForAnswer({
      requirementLedger,
      executionContract,
      cardManifest,
      factClaimPlanner,
      leadStateMachine
    });

    const context = {
      ...buildAssistantContext({
        needState,
        historySummary: session.historySummary,
        products: productsForAnswer,
        knowledgePages,
        troubleshootingCases: troubleshootingMemory,
        conflicts,
        messages: history
      }, {
        mode: answerNeedsFullCatalogContext ? 'expanded' : 'compact'
      }),
      productCardsShown: visibleCardsForAnswer.map((card) => ({
        id: card.id,
        name: card.name,
        category: card.category,
        price: card.price,
        reasons: card.reasons.slice(0, 2)
      })),
      productCardDisplay: {
        initialVisibleCount: finalCards.initialVisibleCount,
        hiddenCount: Math.max(0, cards.length - finalCards.initialVisibleCount)
      },
      productCardsVisibleFirst: visibleCardsForAnswer.map((card) => ({
        id: card.id,
        name: card.name,
        category: card.category,
        price: card.price,
        reasons: card.reasons.slice(0, 2)
      })),
      productCardsBehindShowMore: cards.slice(finalCards.initialVisibleCount, finalCards.initialVisibleCount + ANSWER_HIDDEN_CARD_PREVIEW_LIMIT).map((card) => ({
        id: card.id,
        category: card.category,
        price: card.price
      })),
      productCardPriceRange: priceRangeForAnswer,
      generatorSizingPolicy,
      allSuitableProductCount: undefined,
      allSuitableProductCountIsCapped: undefined,
      allSuitableProducts: compactSuitableProductsForAnswer(
        suitableProductsForContext,
        visibleCardIdsForContext,
        shownCardIdsForContext,
        ANSWER_SUITABLE_PRODUCT_CONTEXT_LIMIT
      ),
      productSelection: productSelectionForAnswer,
      comparisonProducts: selectionResult.comparisonProducts.slice(0, 12).map((product) => ({
        id: product.id,
        name: product.name,
        category: product.category,
        price: product.price,
        reason: selectionResult.rejectedProducts.find((item) => item.productId === product.id)?.reason,
        weightKg: extractWeightKg(product),
        powerKw: extractPowerKw(product)
      })),
      structuredCatalogSlice: !blockEstimatedPumpCards && structuredCatalogSlice
        ? {
            source: structuredCatalogSlice.source,
            visibleLimit: structuredCatalogSlice.visibleLimit,
            constraints: structuredCatalogSlice.constraints,
            exactCatalogMatches: (structuredCatalogSlice.exactCatalogMatches ?? []).slice(0, 20).map((product) => ({
              id: product.id,
              name: product.name,
              category: product.category,
              price: product.price,
              weightKg: extractWeightKg(product),
              isCoreProduct: isCoreEquipment(product)
            }))
          }
        : null,
      cardSelectionDiagnostics: cardSelection.diagnostics,
      agentTurnContract: answerAgentTurnContract,
      agentContractV2,
      sourcePolicy: agentContractV2.sourcePolicy,
      toolTrace,
      productEvidenceRegistry: compactProductEvidenceRegistry(productEvidenceRegistry),
      policyGate,
      policyGateEnforcement,
      leadDraft,
      runtimeContracts: runtimeContractsForAnswer,
      leadRequested: leadRequestedForAnswer && !autoLeadResult?.created,
      leadCreated: autoLeadResult?.created ?? false,
      selectedBundleForLead: leadRequestedForAnswer
        ? {
            items: cards.map((card) => ({
              name: card.name,
              price: card.price,
              currency: card.currency ?? 'RUB'
            })),
            totalPrice: bundleTotalPrice,
            currency: cards.find((card) => card.currency)?.currency ?? 'RUB'
          }
        : null,
      catalogComparisonDiagnostics: effectivePlan.searchScope === 'broadenAlternatives'
        ? buildCatalogComparisonDiagnostics(input.userMessage, candidates)
        : null,
      catalogLineupAlternatives: catalogLineupAlternativesContext(catalogLineupAlternatives),
      catalogLineupAlternativeGroups: catalogLineupAlternativeGroupsContext(catalogLineupAlternatives),
      mandatoryCatalogLineupAlternativeFacts: mandatoryCatalogLineupAlternativeFacts(input.userMessage, catalogLineupAlternatives),
      factualVerificationPolicy,
      troubleshootingMemoryDecision: troubleshootingMemory.length
        ? {
            confidence: troubleshootingMemoryResult.confidence,
            guidance: troubleshootingMemoryResult.guidance
          }
        : null,
      responseStyle
    };
    const answerInputPayload = {
      turnPlan: compactTurnPlanForAnswer(effectivePlan),
      agentTurnContract: answerAgentTurnContract,
      agentContractV2,
      sourcePolicy: agentContractV2.sourcePolicy,
      toolTrace,
      productEvidenceRegistry: compactProductEvidenceRegistry(productEvidenceRegistry),
      policyGate,
      policyGateEnforcement,
      leadDraft,
      answerContext: compactCommercialHandoffAnswer
        ? {
            responseStyle,
            leadRequested: false,
            leadCreated: false,
            activeNeeds: answerAgentTurnContract.activeNeeds,
            recentMessages: compactHistoryForAI(history, 8, 500),
            commercialGuidance: 'Answer only the commercial process requested in mustAnswerNow. No product cards are shown for this turn. Speak in first person as the BAKAUT AI manager. Do not ask for phone/contact because leadAllowed=false.'
          }
        : context,
      latestUserMessage: input.userMessage
    };

    let answer = '';
    let completedResponse: unknown;
    const baseAnswerStyleInstructions = answerCurrentLineupStyle
      ? 'Стиль ответа сейчас важен: покупатель спрашивает, выпускается ли конкретная модель сейчас. Ответь прямо и коротко: сначала вывод по текущей линейке/производству, затем отдельно что есть в нашем каталоге по самой модели или запчастям, если catalogCandidates это подтверждают. Если модель уже не текущая, но есть явный successor или актуальная замена, обязательно укажи это отдельной фразой. Не превращай ответ в сервисное сравнение и не подтягивай старые модели из предыдущей темы, если последняя реплика их не просит. Не отправляй покупателя смотреть к дилеру как основной ответ: если нет заводского 100% подтверждения, скажи уровень уверенности и практический вывод. Не показывай товарные карточки. Не заканчивай предложением продолжить потом в любых формулировках вроде "могу дальше сравнить", "дальше могу собрать", "могу проверить"; дай практический следующий шаг для покупателя: новая техника или обслуживание уже имеющейся модели. Не показывай внешние ссылки, URL, домены и markdown-ссылки: web search используется только внутренне.'
      : serviceCostStyle
        ? 'Стиль ответа сейчас важен: покупатель просит практическое сравнение по сервису, запчастям, расходникам или стоимости владения. Закрой вопрос в текущем ответе, без общего текста и без предложения продолжить потом. Дай только текстовый сравнительный ответ, без товарных карточек. Обязательная структура: короткий вывод; затем список или таблица расходников/запчастей по моделям; затем итог по стоимости владения. Сравни минимум воздушный фильтр, топливный фильтр/сетку, свечу, ремень, сервис-набор, режущие диски/круги, стартер, карбюратор/топливный узел, водяной узел или другие релевантные позиции. По каждой позиции дай цену в рублях: точную из каталога/поиска или рыночный диапазон/ориентир в ₽. Если точную цену найти нельзя, не пиши общий отказ; напиши ориентир или честно "не нашел уверенной цены" только для этой позиции. При поиске цен учитывай российские маркетплейсы, российские магазины запчастей и dyadko.ru. Если цена найдена в валюте на зарубежном источнике, переведи ее в рубли по актуальному или явно указанному курсу и пометь как ориентировочную. Не подменяй цены расходников ценой самой машины. Не показывай внешние ссылки, URL, домены и markdown-ссылки: web search используется только внутренне.'
        : 'Стиль ответа сейчас важен: пиши короче и проще. Если карточки товаров будут показаны под ответом, текст должен быть коротким выводом, а не вторым каталогом: 3-4 коротких предложения максимум, не больше двух моделей в тексте, без полного перечисления карточек. Главный/лучший вариант в тексте обязан быть первой видимой карточкой productCardsVisibleFirst[0]. Остальные видимые модели можно называть только как альтернативы; скрытые за кнопкой “Показать еще” можно упомянуть только как дополнительные варианты. Без длинных вступлений, без канцелярита, без роботизированных фраз. Говори как живой менеджер: спокойно, понятно, по делу. Не показывай внешние ссылки, URL, домены и markdown-ссылки: web search используется только внутренне.';
    const answerStyleInstructions = [
      baseAnswerStyleInstructions,
      'For gasoline-vs-diesel or generator reserve comparisons, answer by the buyer context and avoid exhaustive spare-parts tables unless the buyer explicitly asks for spare-part or consumable prices. Never list consumables irrelevant to the current product class; for portable generators do not include cutting discs, water nodes, or belts unless the concrete model actually uses them.',
      'For product recommendation turns, productCardsShown and productCardsVisibleFirst contain the buyer-visible cards before Show more. Name only productCardsVisibleFirst as direct recommendations. Do not name catalogCandidates, allSuitableProducts, or productCardsBehindShowMore items as found/recommended unless they are also in productCardsVisibleFirst; refer to hidden cards only as additional suitable options under Show more. If productCardsShown is empty, do not name any concrete model.',
      'When you say "selection" or "podborka", define the scope: "po tekushchim kriteriyam v kataloge". Do not mention allSuitableProductCount unless the buyer asks how many options there are or you must explain a broad catalog slice. If allSuitableProductCountIsCapped is true, never present the count as an exact total; say only that more options are available under Show more.',
      'Do not say an inverter generator is required while showing only conventional generator cards. If inverter is a hard requirement, conventional generators are not suitable; ask whether to broaden to conventional options. If inverter is only a preference, say explicitly that shown conventional cards are compromise options, not inverter models.',
      'Do not use the phrase "hidden options" or Russian equivalents like "скрытые варианты"; say "additional suitable options are under Show more" or "I can expand the catalog selection". If productCardPriceRange is present and several suitable cards are shown, mention the catalog price range for the requested product type and stated need. For ordinary product comparisons, prefer short bullets over markdown tables unless exact tabular data is necessary.',
      'If answerContext.productSelection.loadProfile contains a pump item with source estimated_average, do not call any generator a final/best/first choice and do not say it will fit. Treat visible generator cards only as preliminary candidates, explain that pump startup is the risk, and ask for pump model, type, or power before final selection.',
      'For generator recommendations with answerContext.productSelection.loadProfile, state the calculated minimum from requiredNominalKw/requiredStartingKw separately from the visible catalog cards. Do not turn the first visible card power into the required class; if cards are more powerful than the calculated minimum, say they are catalog options with reserve.',
      'For household generator load calculations, use answerContext.generatorSizingPolicy as the authority: calculatedMinimumNominalKw is the load result, minimallySufficientNominalRangeKw is the selection window, and visibleCardNominalKw/visibleCardMaxKw are the only higher powers grounded by shown cards. Do not introduce a higher power class unless it is supported by the policy.',
      'If calculated requiredNominalKw is 4 kW or lower, do not say 4 kW generators are "on the edge" or insufficient. Say 4 kW is the calculated minimum class; 5 kW is only additional comfort/reserve when the price and size are acceptable.',
      `AgentTurnContract: answerTask=${answerAgentTurnContract.answerTask}; cardsRole=${answerAgentTurnContract.cardsRole}; leadAllowed=${answerAgentTurnContract.leadAllowed}. Must answer now before any cards: ${answerAgentTurnContract.mustAnswerNow.join('; ') || answerAgentTurnContract.errorRecoveryPriority}.`,
      `AgentTurnContractV2: intent=${agentContractV2.intent}; leadPolicy=${agentContractV2.leadPolicy}; catalogAction=${agentContractV2.catalogAction}; commercialAction=${agentContractV2.commercialAction}; productCardsPolicy=${agentContractV2.productCardsPolicy}.`,
      `SourcePolicyV2: allowed=${agentContractV2.sourcePolicy.allowed.join(',') || 'none'}; required=${agentContractV2.sourcePolicy.required.join(',') || 'none'}; forbidden=${agentContractV2.sourcePolicy.forbidden.join(',') || 'none'}; webPurpose=${agentContractV2.sourcePolicy.webPurpose ?? 'none'}.`,
      `ProductEvidenceRegistry: visible=${productEvidenceRegistry.visibleProductIds.join(',') || 'none'}; allowedInText=${productEvidenceRegistry.allowedProductIdsForText.join(',') || 'none'}; rejected=${productEvidenceRegistry.rejectedProductIds.slice(0, 8).join(',') || 'none'}. Name only products allowedInText as recommendations.`,
      `PolicyGate: ok=${policyGate.ok}; blocked=${policyGate.blockedReasons.join(',') || 'none'}; answerConstraints=${policyGate.answerConstraints.join(',') || 'none'}.`,
      `PolicyGateEnforcement: mode=${policyGateEnforcement.mode}; hardBlockReasons=${policyGateEnforcement.hardBlockReasons.join(',') || 'none'}; repairedReasons=${policyGateEnforcement.repairedReasons.join(',') || 'none'}; failedRequiredTools=${policyGateEnforcement.failedRequiredTools.join(',') || 'none'}; answerConstraints=${policyGateEnforcement.answerConstraints.join(',') || 'none'}.`,
      `ExecutionContract: cardsPolicy=${executionContract.cardsPolicy}; leadPolicy=${executionContract.leadPolicy}; factPolicy=${executionContract.factPolicy}.`,
      `RequirementLedger: active=${requirementLedger.activeRequirementIds.join(',') || 'none'}; hardConstraints=${requirementLedger.hardConstraintKeys.join(',') || 'none'}; alternativeMode=${requirementLedger.alternativeMode}.`,
      `FactClaimPlanner: allowedSources=${factClaimPlanner.allowedSources.join(',')}; forbiddenClaims=${factClaimPlanner.forbiddenClaims.join(',')}; requiredDisclaimers=${factClaimPlanner.requiredDisclaimers.join(',') || 'none'}.`,
      `LeadStateMachine: state=${leadStateMachine.state}; nextAction=${leadStateMachine.nextAction}; missing=${leadStateMachine.missing ?? 'none'}.`,
      technicalCurrentLevelAnswerGuidance(answerAgentTurnContract),
      commercialManagerVerificationGuidance(answerAgentTurnContract),
      suppressLeadRequestByContract
        ? 'The semantic contract does not allow a contact handoff as the answer action for this turn. If final availability, delivery price, discount, or logistics terms are mentioned, state the check in first person as the BAKAUT AI manager, but do not ask the buyer for name, phone, contact, callback, or a form. Keep product selection moving from catalog cards.'
        : '',
      factualVerificationGuidance,
      exactLookupAlternativeGuidance,
      comparativeAnswerGuidance,
      troubleshootingMemoryGuidance,
      effectivePlan.followUpPolicy === 'answerNowNoDeferredOffer' && !answerCurrentLineupStyle && !detailedFactStyle
        ? 'Планировщик запретил отложенный хвост ответа: не заканчивай предложением "могу дальше проверить/сравнить/подобрать"; дай законченный ответ на текущий вопрос.'
        : ''
    ].filter(Boolean).join('\n');
    const useCompactAnswerRequest = productCardsAnswer ||
      textOnlyTechnicalAnswer ||
      (!answerCurrentLineupStyle &&
      !serviceCostStyle &&
      !detailedFactStyle &&
      !mustUseWebSearch);
    const buildAnswerRequest = (model: string, effort: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh') => ({
      model,
      reasoning: { effort: compactCommercialHandoffAnswer ? 'none' : effort },
      instructions: [
        useCompactAnswerRequest ? buildCompactAnswerSystemPrompt() : buildSystemPrompt(),
        buildOfftopicGuard(),
        consistencyGuard.buildConsistencyContext(),
        temperatureGuidance(assessLeadTemperature(input.userMessage, needState, history).level),
        answerStyleInstructions
      ].filter(Boolean).join('\n\n'),
      input: [
        {
          role: 'user',
          content: yaml.dump(cleanEmpty(answerInputPayload))
        }
      ],
      ...(useCompactAnswerRequest ? {} : { stream: true }),
      max_output_tokens: compactCommercialHandoffAnswer
        ? Math.min(config.OPENAI_MAX_OUTPUT_TOKENS, 700)
        : detailedFactStyle
          ? Math.max(config.OPENAI_MAX_OUTPUT_TOKENS, 5000)
          : mustUseWebSearch
            ? Math.max(config.OPENAI_MAX_OUTPUT_TOKENS, 2400)
            : config.OPENAI_MAX_OUTPUT_TOKENS
    });
    const executeAnswerRequest = async (request: Record<string, unknown>, logStage: string) => {
      if (!client) throw new Error('AI service is unavailable');
      let localAnswer = '';
      let localCompletedResponse: unknown;
      if (request.stream !== true) {
        const response: any = await client.responses.create(request, input.signal ? { signal: input.signal } : undefined);
        localCompletedResponse = response;
        localAnswer = extractResponseText(response);
        logOpenAIUsage(logStage, String(request.model ?? config.OPENAI_ANSWER_MODEL), response);
        return { answer: localAnswer, completedResponse: localCompletedResponse };
      }
      const stream = await client.responses.create(request, input.signal ? { signal: input.signal } : undefined);
      for await (const event of stream) {
        if (event.type === 'response.output_text.delta' && event.delta) {
          localAnswer += event.delta;
        }
        if (event.type === 'response.completed' && event.response?.output_text && !localAnswer) {
          localAnswer = event.response.output_text;
        }
        if (event.type === 'response.output_text.done' && (event as { text?: string }).text && !localAnswer) {
          localAnswer = (event as { text: string }).text;
        }
        if (event.type === 'response.completed') {
          localCompletedResponse = event.response;
          if (!localAnswer) localAnswer = extractResponseText(event.response);
          logOpenAIUsage(logStage, String(request.model ?? config.OPENAI_ANSWER_MODEL), event.response);
        }
        if (event.type === 'response.incomplete') {
          localCompletedResponse = event.response;
          if (!localAnswer) localAnswer = extractResponseText(event.response);
          logOpenAIUsage(`${logStage}_incomplete`, String(request.model ?? config.OPENAI_ANSWER_MODEL), event.response);
        }
        if (event.type === 'response.failed') {
          localCompletedResponse = event.response;
          throw new Error('AI answer generation failed');
        }
      }
      if (!localAnswer && localCompletedResponse) localAnswer = extractResponseText(localCompletedResponse);
      return { answer: localAnswer, completedResponse: localCompletedResponse };
    };
    const failAnswerGeneration = (error: unknown): void => {
      if (input.signal?.aborted) throw new Error('AI answer generation aborted');
      const details = safeError(error);
      markAiFallback(aiDiagnostics, 'answerGenerationFallback', error, 'answer_generation_failed');
      const deterministicFallback = deterministicAnswerGenerationFallback({
        cards,
        selectionResult,
        structuredCatalogSlice,
        finalCards,
        contract: answerAgentTurnContract,
        latestUserMessage: input.userMessage
      }).trim();
      if (deterministicFallback) {
        answer = deterministicFallback;
        completedResponse = undefined;
        console.warn('OpenAI answer generation failed; using deterministic catalog fallback for current turn', details);
        return;
      }
      console.warn('OpenAI answer generation failed; deferring to turn recovery', details);
      throw aiStageFailure('answer generation', aiDiagnostics.answerGenerationFallback);
    };

    if (input.turnId) {
      await this.conversations.updateTurn({
        sessionId: input.sessionId,
        turnId: input.turnId,
        status: 'answering',
        stage: 'answering',
        plannerContract: answerAgentTurnContract
      }).catch((error) => console.warn('Conversation turn answering update failed', safeError(error)));
    }

    const proactiveCommercialAnswer = deterministicCommercialHandoffFallback({
      cards,
      selectionResult,
      contract: answerAgentTurnContract,
      latestUserMessage: input.userMessage
    }).trim();
    const createdLeadConfirmationAnswer = autoLeadResult?.created
      ? leadCreatedConfirmationAnswer({
          cards,
          userMessage: input.userMessage,
          autoLead: autoLeadResult
        }).trim()
      : '';
    const proactiveCatalogSelectionAnswer = deterministicRecoveredSelectionAnswer({
      contract: answerAgentTurnContract,
      cards,
      state: needState,
      latestUserMessage: input.userMessage
    }).trim();
    const shouldUseProactiveCatalogSelectionAnswer = Boolean(
      proactiveCatalogSelectionAnswer &&
      cards.length > 0 &&
      !leadRequestedForAnswer &&
      !mustUseWebSearch &&
      !answerCurrentLineupStyle &&
      !serviceCostStyle &&
      !detailedFactStyle &&
      answerAgentTurnContract.catalogAction === 'find_matching_products' &&
      answerAgentTurnContract.productCardsPolicy !== 'none' &&
      answerAgentTurnContract.cardsRole !== 'none' &&
      ['product_selection', 'mixed'].includes(answerAgentTurnContract.answerTask)
    );

    if (createdLeadConfirmationAnswer) {
      answer = createdLeadConfirmationAnswer;
      completedResponse = undefined;
    } else if (proactiveCommercialAnswer && shouldUseProactiveCommercialDeterministicAnswer(answerAgentTurnContract, input.userMessage)) {
      answer = proactiveCommercialAnswer;
      completedResponse = undefined;
    } else if (shouldUseProactiveCatalogSelectionAnswer) {
      answer = proactiveCatalogSelectionAnswer;
      completedResponse = undefined;
    } else {
      const answerRequest: Record<string, unknown> = buildAnswerRequest(answerProfile.model, answerProfile.effort);
      if (mustUseWebSearch) {
        answerRequest.tools = [{
          type: 'web_search_preview',
          search_context_size: searchContextSize
        }];
        answerRequest.tool_choice = { type: 'web_search_preview' };
      }

      try {
        const result = await executeAnswerRequest(answerRequest, 'answer');
        answer = result.answer;
        completedResponse = result.completedResponse;
      } catch (error) {
        if (answerProfile.model !== config.OPENAI_ANSWER_MODEL) {
          try {
            const fallbackAnswerRequest: Record<string, unknown> = buildAnswerRequest(config.OPENAI_ANSWER_MODEL, config.OPENAI_ANSWER_REASONING_EFFORT);
            if (mustUseWebSearch) {
              fallbackAnswerRequest.tools = [{
                type: 'web_search_preview',
                search_context_size: searchContextSize
              }];
              fallbackAnswerRequest.tool_choice = { type: 'web_search_preview' };
            }
            const result = await executeAnswerRequest(fallbackAnswerRequest, 'answer_fallback');
            answer = result.answer;
            completedResponse = result.completedResponse;
          } catch (fallbackError) {
            console.warn('Deep answer fallback failed', safeError(fallbackError));
            failAnswerGeneration(fallbackError);
          }
        } else {
          failAnswerGeneration(error);
        }
      }
    }

    if (input.signal?.aborted) throw new Error('AI answer generation aborted');

    if (!answer.trim()) {
      console.warn('OpenAI answer generation completed without visible text', {
        answerMode: effectivePlan.answerMode,
        action: effectivePlan.action,
        mustUseWebSearch,
        currentLineupStyle: answerCurrentLineupStyle,
        detailedFactStyle
      });
      try {
        const recoveryAnswerRequest: Record<string, unknown> = buildAnswerRequest(
          config.OPENAI_ANSWER_MODEL,
          config.OPENAI_ANSWER_REASONING_EFFORT
        );
        delete recoveryAnswerRequest.stream;
        delete recoveryAnswerRequest.tools;
        delete recoveryAnswerRequest.tool_choice;
        recoveryAnswerRequest.max_output_tokens = Math.min(
          Number(recoveryAnswerRequest.max_output_tokens ?? config.OPENAI_MAX_OUTPUT_TOKENS),
          1200
        );
        const recoveryResponse = await client.responses.create(
          recoveryAnswerRequest,
          input.signal ? { signal: input.signal } : undefined
        );
        logOpenAIUsage('answer_empty_recovery', config.OPENAI_ANSWER_MODEL, recoveryResponse);
        answer = extractResponseText(recoveryResponse);
        completedResponse = completedResponse ?? recoveryResponse;
      } catch (recoveryError) {
        if (input.signal?.aborted) throw new Error('AI answer generation aborted');
        console.warn('Empty answer recovery failed', safeError(recoveryError));
      }
    }

    if (!answer.trim()) {
      if (structuredCatalogSlice) {
        console.warn('Structured catalog deterministic answer suppressed for empty AI answer; deferring to turn recovery', {
          totalMatched: structuredCatalogSlice.totalMatched,
          cards: cards.length
        });
      }
    }

    if (!answer.trim()) {
      markAiFallback(aiDiagnostics, 'answerGenerationFallback', 'empty_answer', 'answer_generation_empty');
      throw aiStageFailure('answer generation', aiDiagnostics.answerGenerationFallback);
    }

    const usedWebSearch = responseUsedWebSearch(completedResponse);
    const rawAnswer = answer;
    if (autoLeadResult?.created) {
      answer = createdLeadConfirmationAnswer || leadCreatedConfirmationAnswer({
        cards,
        userMessage: input.userMessage,
        autoLead: autoLeadResult
      });
    } else {
      answer = sanitizeVisibleAnswer(answer, effectivePlan);
      answer = repairAnswerForFinalCards(answer, cards, productsForCardSelection, needState, input.userMessage, effectivePlan);
      answer = repairGeneratorLoadMinimumText(answer, loadProfileForAnswer, {
        cards,
        strictMinimumStatement: recommendationAnswer || cards.length > 0,
        blockEstimatedPumpCards,
        missingQuestion: blockEstimatedPumpCards
          ? 'какой насос стоит: скважинный, поверхностный, дренажный или насосная станция, и какая у него мощность/модель'
          : selectionResult.missingQuestions[0]
      });
      answer = repairExplicitPhaseReconfirmation(answer, selectionResult.state);
      answer = repairAvailabilityAnswerWithCatalogModels(answer, answerAgentTurnContract, selectionResult, {
        blockProductCards: blockEstimatedPumpCards
      });
      if (suppressLeadRequestByContract) {
        answer = stripLeadPressureTail(answer);
      }
      answer = ensureCommercialManagerVerification(answer, answerAgentTurnContract);
      answer = ensureLargeSliceShowMoreNote(answer, structuredCatalogSlice, cards, finalCards.initialVisibleCount);
    }
    const cardContract = enforceAnswerCardContract(
      answer,
      cards,
      productsForCardSelection,
      needState,
      input.userMessage,
      effectivePlan
    );
    const postAnswerCheck = applyPostAnswerVerificationPolicy({
      answer,
      factClaimPlanner,
      leadStateMachine,
      cardManifest,
      productEvidenceRegistry
    });
    answer = postAnswerCheck.answer;
    const factClaimAudit = postAnswerCheck.factClaimAudit;
    const postAnswerVerification = postAnswerCheck.postAnswerVerification;
    const postAnswerVerificationRecovery = postAnswerCheck.postAnswerVerificationRecovery;
    if (postAnswerVerification.status === 'error') {
      markAiFallback(
        aiDiagnostics,
        'answerGenerationFallback',
        `post_answer_verification:${postAnswerVerification.issues.map((issue) => issue.code).join(',')}`,
        'post_answer_verification_failed'
      );
      throw new Error(`Answer violates post-answer verification: ${postAnswerVerification.issues.map((issue) => issue.code).join(', ')}`);
    }
    const finalSelectionMetadata: ProductSelectionMetadata = {
      ...baseSelectionMetadata,
      matchedProductIds: selectionResult.matchedProducts.length
        ? selectionResult.matchedProducts.map((product) => product.id)
        : finalCards.cards.map((card) => card.id),
      visibleProductIds: finalCards.visibleProductIds,
      hiddenProductIds: finalCards.hiddenProductIds,
      totalMatched: Math.max(selectionResult.matchedProducts.length, finalCards.cards.length),
      selectionTrace: {
        ...(baseSelectionMetadata.selectionTrace ?? {}),
        memoryDecisions,
        finalCardsSource: finalCards.source,
        initialVisibleCardCount: finalCards.initialVisibleCount
      }
    };
    if (input.turnId) {
      const latestTurn = await this.conversations.getTurn(input.sessionId, input.turnId).catch(() => null);
      if (latestTurn?.assistantMessageId && (latestTurn.status === 'completed' || latestTurn.status === 'recovered')) {
        const latestMessages = await this.conversations.listMessages(input.sessionId, 80).catch(() => []);
        const existingAssistant = latestMessages.find((message) => message.id === latestTurn.assistantMessageId && message.role === 'assistant');
        if (existingAssistant?.content?.trim()) {
          return {
            turnId: input.turnId,
            answer: existingAssistant.content,
            needState,
            productCards: (existingAssistant.metadata?.productCards as ProductCard[] | undefined) ?? [],
            cardDisplay: existingAssistant.metadata?.cardDisplay as CardDisplayOptions | undefined,
            usedWebSearch: Boolean(existingAssistant.metadata?.usedWebSearch),
            leadRequested: Boolean(existingAssistant.metadata?.leadRequested),
            leadCreated: Boolean(existingAssistant.metadata?.leadCreated),
            assistantMessageId: existingAssistant.id,
            metadata: {
              ...(existingAssistant.metadata ?? {}),
              turnId: input.turnId,
              supersededMainAnswer: true
            }
          };
        }
      }
    }
    if (answer) await input.onDelta?.(answer);
    if (usedWebSearch && completedResponse) {
      await this.storeVerifiedWebFindings({
        userMessage: input.userMessage,
        answer: rawAnswer,
        products: candidates,
        response: completedResponse,
        signal: input.signal
      }).catch((error) => console.warn('Verified web fact storage failed', safeError(error)));
    }
    if (troubleshootingMemoryCanAnswer) {
      await this.products.markTroubleshootingCasesUsed(troubleshootingMemory.map((item) => item.id))
        .catch((error) => console.warn('Troubleshooting memory usage update failed', safeError(error)));
    }
    const answerFallbackMetadata = aiDiagnostics.answerGenerationFallback;
    const answerProductCards = autoLeadResult?.created ? [] : cards;
    const answerCardDisplay = autoLeadResult?.created ? undefined : cardDisplay;

    const assistantMessage = await this.conversations.addMessage({
      sessionId: input.sessionId,
      role: 'assistant',
      content: answer,
      metadata: {
        productCards: answerProductCards,
        cardDisplay: answerCardDisplay,
        usedWebSearch,
        webSearchRequired: mustUseWebSearch,
        troubleshootingMemoryUsed: troubleshootingMemoryCanAnswer,
        troubleshootingMemoryIds: troubleshootingMemory.map((item) => item.id),
        troubleshootingMemoryConfidence: troubleshootingMemoryResult.confidence,
        responseStyle: answerCurrentLineupStyle ? 'current_lineup' : detailedFactStyle ? 'detailed_factual' : 'short',
        answerMode: effectivePlan.answerMode,
        cardPolicy: effectivePlan.cardPolicy,
        followUpPolicy: effectivePlan.followUpPolicy,
        contextScope: effectivePlan.contextScope,
        searchScope: effectivePlan.searchScope,
        internalSources: extractUrlCitations(completedResponse).slice(0, 12),
        turnPlan: effectivePlan,
        turnId: input.turnId,
        turnContract: answerAgentTurnContract,
        agentContractV2,
        sourcePolicy: agentContractV2.sourcePolicy,
        toolTrace,
        productEvidenceRegistry,
        policyGate,
        policyGateEnforcement,
        leadDraft: leadDraft ?? undefined,
        requirementLedger,
        executionContract,
        cardManifest,
        factClaimPlanner,
        factClaimAudit,
        leadStateMachine,
        postAnswerVerification,
        postAnswerVerificationRecovery,
        activeNeedsBefore,
        activeNeedsAfter: needState.activeNeeds ?? [],
        semanticMemoryBefore,
        semanticMemoryAfter: needState.semanticMemory,
        memoryDecisions,
        cardsRole: answerAgentTurnContract.cardsRole,
        leadAllowed: answerAgentTurnContract.leadAllowed,
        validatorWarnings: answerAgentTurnContract.validatorWarnings,
        contractWarnings: [
          ...requirementLedger.warnings,
          ...executionContract.warnings,
          ...cardManifest.warnings,
          ...factClaimPlanner.warnings,
          ...productEvidenceRegistry.warnings,
          ...policyGate.warnings,
          ...policyGate.blockedReasons,
          ...policyGateEnforcement.warnings,
          ...policyGateEnforcement.hardBlockReasons,
          ...policyGateEnforcement.repairedReasons,
          ...factClaimAudit.warnings,
          ...leadStateMachine.warnings,
          ...postAnswerVerification.issues.map((issue) => issue.code)
        ],
        aiDiagnostics,
        answerGenerationFallback: answerFallbackMetadata,
        cardSelection: cardSelection.diagnostics,
        cardContract: cardContract.diagnostics,
        productSelection: finalSelectionMetadata,
        autoLead: autoLeadResult ? {
          created: autoLeadResult.created,
          leadId: autoLeadResult.lead?.id,
          emailStatus: autoLeadResult.emailStatus,
          missing: autoLeadResult.missing,
          error: autoLeadResult.error
        } : undefined,
        structuredCatalogSlice: structuredCatalogSlice
          ? {
              source: structuredCatalogSlice.source,
              totalMatched: structuredCatalogSlice.totalMatched,
              visibleLimit: structuredCatalogSlice.visibleLimit,
              constraints: structuredCatalogSlice.constraints,
              exactCatalogMatchCount: structuredCatalogSlice.exactCatalogMatches?.length ?? 0
            }
          : null
      }
    });
    if (input.turnId) {
      await this.conversations.updateTurn({
        sessionId: input.sessionId,
        turnId: input.turnId,
        status: 'completed',
        stage: 'completed',
        assistantMessageId: assistantMessage.id,
        plannerContract: answerAgentTurnContract,
        activeNeedsAfter: needState.activeNeeds ?? []
      }).catch((error) => console.warn('Conversation turn completion update failed', safeError(error)));
    }

    this.maybeSummarizeHistory(input.sessionId, history.concat(assistantMessage), session.historySummary).catch(() => {});

    const cardProducts = cards.map((c) => allCandidates.find((p) => p.id === c.id)).filter((p): p is Product => !!p);
    const consistencyWarnings = consistencyGuard.checkAnswer(answer);
    consistencyGuard.recordFacts(cardProducts, answer);
    if (consistencyWarnings.length) {
      console.warn('[ConsistencyGuard]', input.sessionId, consistencyWarnings);
    }

    const leadTemp = assessLeadTemperature(input.userMessage, needState, history);
    const totalDuration = traceTotal({
      leadTemperature: leadTemp.level,
      leadScore: leadTemp.score,
      cardCount: cards.length,
      candidateCount: allCandidates.length,
      consistencyWarnings: consistencyWarnings.length,
      executionContract: {
        cardsPolicy: executionContract.cardsPolicy,
        leadPolicy: executionContract.leadPolicy,
        factPolicy: executionContract.factPolicy
      },
      requirementCount: requirementLedger.items.length,
      contractWarningCount: requirementLedger.warnings.length +
        executionContract.warnings.length +
        cardManifest.warnings.length +
        factClaimPlanner.warnings.length +
        factClaimAudit.warnings.length +
        leadStateMachine.warnings.length +
        postAnswerVerification.issues.length,
      factClaimRisk: factClaimPlanner.risk,
      factClaimCount: factClaimAudit.claims.length,
      leadState: leadStateMachine.state,
      agentContractV2: {
        intent: agentContractV2.intent,
        leadPolicy: agentContractV2.leadPolicy,
        sourceRequired: agentContractV2.sourcePolicy.required
      },
      policyGate: {
        ok: policyGate.ok,
        enforcementMode: policyGateEnforcement.mode,
        blockedReasons: policyGate.blockedReasons.length,
        warnings: policyGate.warnings.length
      },
      productEvidence: {
        visible: productEvidenceRegistry.visibleProductIds.length,
        allowedInText: productEvidenceRegistry.allowedProductIdsForText.length,
        rejected: productEvidenceRegistry.rejectedProductIds.length
      },
      postAnswerVerification: postAnswerVerification.status,
      postAnswerVerificationRecovered: postAnswerVerificationRecovery.recovered,
      usedWebSearch,
      aiFallbackStages: Object.entries(aiDiagnostics)
        .filter(([, diagnostic]) => diagnostic.used)
        .map(([stage]) => stage)
    });
    console.log(`[Turn] session=${input.sessionId} duration=${totalDuration}ms cards=${cards.length} lead=${leadTemp.level}(${leadTemp.score})`);

    return {
      turnId: input.turnId,
      answer,
      needState,
      productCards: answerProductCards,
      cardDisplay: answerCardDisplay,
      usedWebSearch,
      leadRequested: leadRequestedForAnswer && !autoLeadResult?.created,
      leadCreated: autoLeadResult?.created ?? false,
      assistantMessageId: assistantMessage.id,
      metadata: {
        turnId: input.turnId,
        selection: finalSelectionMetadata,
        cardDisplay,
        finalCardsSource: finalCards.source,
        turnPlan: compactTurnPlanForAnswer(effectivePlan),
        turnContract: answerAgentTurnContract,
        agentContractV2,
        sourcePolicy: agentContractV2.sourcePolicy,
        toolTrace,
        productEvidenceRegistry,
        policyGate,
        policyGateEnforcement,
        leadDraft: leadDraft ?? undefined,
        requirementLedger,
        executionContract,
        cardManifest,
        factClaimPlanner,
        factClaimAudit,
        leadStateMachine,
        postAnswerVerification,
        postAnswerVerificationRecovery,
        activeNeedsBefore,
        activeNeedsAfter: needState.activeNeeds ?? [],
        semanticMemoryBefore,
        semanticMemoryAfter: needState.semanticMemory,
        memoryDecisions,
        cardsRole: answerAgentTurnContract.cardsRole,
        leadAllowed: answerAgentTurnContract.leadAllowed,
        validatorWarnings: answerAgentTurnContract.validatorWarnings,
        contractWarnings: [
          ...requirementLedger.warnings,
          ...executionContract.warnings,
          ...cardManifest.warnings,
          ...factClaimPlanner.warnings,
          ...productEvidenceRegistry.warnings,
          ...policyGate.warnings,
          ...policyGate.blockedReasons,
          ...policyGateEnforcement.warnings,
          ...policyGateEnforcement.hardBlockReasons,
          ...policyGateEnforcement.repairedReasons,
          ...factClaimAudit.warnings,
          ...leadStateMachine.warnings,
          ...postAnswerVerification.issues.map((issue) => issue.code)
        ],
        cardSelection: cardSelection.diagnostics,
        cardContract: cardContract.diagnostics,
        aiDiagnostics,
        answerGenerationFallback: answerFallbackMetadata
      }
    };
  }

  async recoverTurn(input: { sessionId: string; turnId: string; onDelta?: (text: string) => void | Promise<void>; signal?: AbortSignal }): Promise<ChatResponsePayload> {
    const session = await this.conversations.getSession(input.sessionId);
    if (!session || session.status !== 'active') throw new Error('Conversation session is not active');
    let turn = await this.conversations.getTurn(input.sessionId, input.turnId);
    if (!turn) throw new Error('Conversation turn not found');
    const completedTurnPayload = async () => {
      const currentTurn = await this.conversations.getTurn(input.sessionId, input.turnId);
      if (!currentTurn || !['completed', 'recovered'].includes(currentTurn.status) || !currentTurn.assistantMessageId) return null;
      const currentHistory = await this.conversations.listMessages(input.sessionId, 80);
      const existingAssistant = currentHistory.find((message) =>
        message.id === currentTurn.assistantMessageId &&
        message.role === 'assistant' &&
        message.content?.trim()
      );
      if (!existingAssistant) return null;
      await input.onDelta?.(existingAssistant.content);
      return {
        turnId: input.turnId,
        answer: existingAssistant.content,
        needState: session.needState,
        productCards: (existingAssistant.metadata?.productCards as ProductCard[] | undefined) ?? [],
        cardDisplay: existingAssistant.metadata?.cardDisplay as CardDisplayOptions | undefined,
        usedWebSearch: Boolean(existingAssistant.metadata?.usedWebSearch),
        assistantMessageId: existingAssistant.id,
        metadata: {
          ...(existingAssistant.metadata ?? {}),
          turnId: input.turnId,
          recoveryAttempts: currentTurn.status === 'recovered' ? 1 : 0
        }
      };
    };
    const initialCompletedPayload = await completedTurnPayload();
    if (initialCompletedPayload) return initialCompletedPayload;

    const waitWhileOriginalTurnIsActive = async () => {
      const activeStatuses = new Set(['received', 'need_extracted', 'planned', 'answering']);
      const deadline = Date.now() + 35_000;
      while (activeStatuses.has(turn!.status) && Date.now() < deadline) {
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(resolve, 750);
          input.signal?.addEventListener('abort', () => {
            clearTimeout(timeout);
            reject(new Error('AI turn recovery aborted'));
          }, { once: true });
        });
        const completedPayload = await completedTurnPayload();
        if (completedPayload) return completedPayload;
        const refreshed = await this.conversations.getTurn(input.sessionId, input.turnId);
        if (!refreshed) return null;
        turn = refreshed;
        if (turn.status === 'failed') return null;
      }
      return null;
    };
    const originalTurnPayload = await waitWhileOriginalTurnIsActive();
    if (originalTurnPayload) return originalTurnPayload;

    if (!turn) throw new Error('Conversation turn not found');
    const recoveryTurn = turn;
    let history = await this.conversations.listMessages(input.sessionId, 80);
    const latestUser = recoveryTurn.userMessageId
      ? history.find((message) => message.id === recoveryTurn.userMessageId)
      : [...history].reverse().find((message) => message.role === 'user');
    const existingAssistant = recoveryTurn.assistantMessageId
      ? history.find((message) => message.id === recoveryTurn.assistantMessageId && message.role === 'assistant')
      : null;
    if (existingAssistant?.content?.trim() && (recoveryTurn.status === 'completed' || recoveryTurn.status === 'recovered')) {
      const completedPayload = await completedTurnPayload();
      if (completedPayload) return completedPayload;
    }

    const latestUserText = latestUser?.content ?? '';
    const storedContract = (recoveryTurn.plannerContract ?? null) as AgentTurnContract | null;
    const recoveryAiDiagnostics = emptyAiGenerationDiagnostics();
    const recoveryCurrentLineupStyle = shouldUseCurrentLineupStyle(latestUserText);
    const recoveryNeedState = latestMessageScopedRecoveryNeedState(session.needState, latestUserText);
    let recoveryCatalogProducts: Product[] = [];
    const buildRecoveryRenderContract = (contract: AgentTurnContract, cards: ProductCard[]): ResolvedTurnContract => ({
      action: {
        primary: contract.answerTask === 'lead_handoff' && contract.leadAllowed ? 'collect_lead' : 'answer_question',
        answerMode: contract.answerTask === 'lead_handoff' && contract.leadAllowed ? 'leadCollection' : 'short',
        followUpPolicy: contract.leadAllowed ? 'collectLead' : 'answerNowNoDeferredOffer'
      },
      scope: {
        context: 'fullSession',
        search: 'previousSelectionOnly',
        catalogSearchQuery: ''
      },
      knowledge: {
        webRequired: recoveryCurrentLineupStyle,
        missingInformation: recoveryCurrentLineupStyle ? ['current manufacturer status'] : []
      },
      selection: {
        selectedProductIds: cards.map((card) => card.id),
        requiredProductTraits: recoveryNeedState.selectionState.hardConstraints,
        selectionState: recoveryNeedState.selectionState
      },
      render: {
        cards: cards.length && contract.cardsRole !== 'none' ? 'showProducts' : 'none',
        leadForm: false
      },
      guidance: 'Deterministic recovery render contract.',
      diagnostics: {
        sourcePlan: {
          action: 'answer_question',
          answerMode: 'short',
          cardPolicy: cards.length ? 'showProducts' : 'textOnly',
          followUpPolicy: 'answerNowNoDeferredOffer',
          contextScope: 'fullSession',
          searchScope: 'previousSelectionOnly',
          catalogSearchQuery: '',
          selectedProductIds: cards.map((card) => card.id),
          needsWebSearch: recoveryCurrentLineupStyle,
          missingInformation: recoveryCurrentLineupStyle ? ['current manufacturer status'] : [],
          answerGuidance: 'Deterministic recovery render contract.'
        },
        overrides: ['recovery_render_contract']
      }
    });
    const completeRecoveredAnswer = async (inputAnswer: string, contract: AgentTurnContract, recoveredSelection: {
      cards: ProductCard[];
      cardDisplay?: CardDisplayOptions;
    }, openAiError?: unknown): Promise<ChatResponsePayload> => {
      const completedPayload = await completedTurnPayload();
      if (completedPayload) return completedPayload;
      let answer = inputAnswer.trim();
      const renderContract = buildRecoveryRenderContract(contract, recoveredSelection.cards);
      const requirementLedger = buildRequirementLedger({
        needState: recoveryNeedState,
        selectionState: recoveryNeedState.selectionState
      });
      const executionContract = buildExecutionContract({
        agentContract: contract,
        renderContract,
        selectionState: recoveryNeedState.selectionState,
        webRequired: recoveryCurrentLineupStyle,
        activeRequirementIds: requirementLedger.activeRequirementIds
      });
      const visibleCount = recoveredSelection.cardDisplay?.initialVisibleCount ?? Math.min(recoveredSelection.cards.length, LARGE_SLICE_VISIBLE_CARDS);
      const visibleProductIds = recoveredSelection.cards.slice(0, visibleCount).map((card) => card.id);
      const hiddenProductIds = recoveredSelection.cards.slice(visibleCount).map((card) => card.id);
      const cardManifest = buildCardManifest({
        executionContract,
        cards: recoveredSelection.cards,
        visibleProductIds,
        hiddenProductIds
      });
      const agentContractV2 = deriveAgentTurnContractV2({
        userMessage: latestUserText,
        legacyContract: contract,
        needState: recoveryNeedState,
        webRequired: recoveryCurrentLineupStyle,
        selectedProductIds: visibleProductIds
      });
      const productEvidenceRegistry = buildProductEvidenceRegistry({
        executionContract,
        cardManifest,
        cards: recoveredSelection.cards,
        catalogProducts: [
          ...recoveredSelection.cards.map(productFromCard),
          ...recoveryCatalogProducts
        ]
      });
      const factClaimPlanner = buildFactClaimPlanner({
        executionContract,
        requirementLedger,
        cardManifest,
        usedWebSearch: recoveryCurrentLineupStyle
      });
      const recoveredContact = hasLikelyContactText(latestUserText)
        ? extractLeadContactDetails(latestUserText)
        : undefined;
      const leadDraft = buildLeadDraft({
        contract: agentContractV2,
        registry: productEvidenceRegistry,
        buyerQuestion: latestUserText,
        contact: recoveredContact
      });
      const recoveredLeadRequested = Boolean(leadDraft) &&
        contract.leadAllowed &&
        !shouldSuppressLeadRequestFromContract(contract, latestUserText);
      const recoveredShouldCreateLead = shouldCommitLeadFromDraft({
        draft: leadDraft,
        leadRequested: recoveredLeadRequested,
        executionLeadPolicy: executionContract.leadPolicy,
        contact: recoveredContact
      });
      const recoveredAutoLeadResult = recoveredShouldCreateLead
        ? await this.createLeadFromChatContact(session, history, recoveredSelection.cards, latestUserText, recoveryNeedState)
        : null;
      const leadStateMachine = buildLeadStateMachine({
        executionContract,
        hasContactInTurn: Boolean(recoveredContact),
        leadRequested: recoveredLeadRequested,
        leadCreated: recoveredAutoLeadResult?.created ?? false,
        missing: recoveredAutoLeadResult?.missing,
        error: recoveredAutoLeadResult?.error
      });
      if (recoveredAutoLeadResult?.created) {
        answer = leadCreatedConfirmationAnswer({
          cards: recoveredSelection.cards,
          userMessage: latestUserText,
          autoLead: recoveredAutoLeadResult
        });
      }
      const policyGate = runPolicyGate({
        contract: agentContractV2,
        requirementLedger,
        productEvidenceRegistry,
        executionContract,
        factClaimPlanner,
        leadStateMachine,
        webSearchPlanned: recoveryCurrentLineupStyle
      });
      const toolRegistry = new AgentToolRegistry(createRuntimeArtifactToolHandlers({
        contract: agentContractV2,
        selection: {
          matchedProducts: recoveredSelection.cards.map(productFromCard),
          rejectedProducts: []
        },
        productEvidenceRegistry,
        leadDraft,
        autoLeadResult: recoveredAutoLeadResult,
        webSearchEnabled: recoveryCurrentLineupStyle
      }));
      const toolResults = await toolRegistry.executePlan(agentContractV2.toolPlan, {
        sessionId: input.sessionId,
        userMessage: latestUserText,
        history,
        needState: recoveryNeedState,
        signal: input.signal,
        policy: {
          leadAllowed: agentContractV2.leadPolicy !== 'forbidden',
          webAllowed: !agentContractV2.sourcePolicy.forbidden.includes('web'),
          webPurpose: agentContractV2.sourcePolicy.webPurpose
        }
      });
      const toolTrace = toolResults.map((result, index) => toolResultToTrace(agentContractV2.toolPlan[index]!, result));
      const policyGateEnforcement = enforcePolicyGateBeforeAnswer({
        policyGate,
        toolTrace
      });
      if (policyGateEnforcement.mode === 'hard_block') {
        throw new Error(`Recovered answer blocked by policy gate: ${policyGateEnforcement.hardBlockReasons.join(', ')}`);
      }
      const postAnswerCheck = applyPostAnswerVerificationPolicy({
        answer,
        factClaimPlanner,
        leadStateMachine,
        cardManifest,
        productEvidenceRegistry
      });
      answer = postAnswerCheck.answer;
      const factClaimAudit = postAnswerCheck.factClaimAudit;
      const postAnswerVerification = postAnswerCheck.postAnswerVerification;
      const postAnswerVerificationRecovery = postAnswerCheck.postAnswerVerificationRecovery;
      if (postAnswerVerification.status === 'error') {
        throw new Error(`Recovered answer violates post-answer verification: ${postAnswerVerification.issues.map((issue) => issue.code).join(', ')}`);
      }
      const contractWarnings = [
        ...(contract.validatorWarnings ?? []),
        ...requirementLedger.warnings,
        ...executionContract.warnings,
        ...cardManifest.warnings,
        ...productEvidenceRegistry.warnings,
        ...policyGate.warnings,
        ...policyGate.blockedReasons,
        ...policyGateEnforcement.warnings,
        ...policyGateEnforcement.hardBlockReasons,
        ...policyGateEnforcement.repairedReasons,
        ...factClaimPlanner.warnings,
        ...factClaimAudit.warnings,
        ...leadStateMachine.warnings,
        ...postAnswerVerification.issues.map((issue) => issue.code)
      ];
      const metadata = {
        turnId: input.turnId,
        recovered: true,
        recoveryAttempts: 1,
        turnContract: contract,
        agentContractV2,
        sourcePolicy: agentContractV2.sourcePolicy,
        toolTrace,
        productEvidenceRegistry,
        policyGate,
        policyGateEnforcement,
        leadDraft: leadDraft ?? undefined,
        executionContract,
        requirementLedger,
        cardManifest,
        factClaimPlanner,
        factClaimAudit,
        leadStateMachine,
        postAnswerVerification,
        postAnswerVerificationRecovery,
        aiDiagnostics: recoveryAiDiagnostics,
        productCards: recoveredSelection.cards,
        cardDisplay: recoveredSelection.cardDisplay,
        activeNeedsAfter: session.needState.activeNeeds ?? [],
        warnings: contractWarnings,
        contractWarnings,
        openAiError
      };
      await input.onDelta?.(answer);
      const assistantMessage = await this.conversations.addMessage({
        sessionId: input.sessionId,
        role: 'assistant',
        content: answer,
        metadata
      });
      await this.conversations.updateTurn({
        sessionId: input.sessionId,
        turnId: input.turnId,
        status: 'recovered',
        stage: 'recovered',
        assistantMessageId: assistantMessage.id,
        plannerContract: contract,
        errorCode: openAiError ? 'recovery_openai_failed' : null,
        errorMessage: openAiError ? JSON.stringify(openAiError).slice(0, 1000) : null,
        activeNeedsAfter: session.needState.activeNeeds ?? []
      }).catch((error) => console.warn('Conversation turn recovery update failed', safeError(error)));
      return {
        turnId: input.turnId,
        answer,
        needState: session.needState,
        productCards: recoveredSelection.cards,
        cardDisplay: recoveredSelection.cardDisplay,
        usedWebSearch: recoveryCurrentLineupStyle,
        leadRequested: recoveredLeadRequested && !recoveredAutoLeadResult?.created,
        leadCreated: recoveredAutoLeadResult?.created ?? false,
        assistantMessageId: assistantMessage.id,
        metadata
      };
    };
    if (
      latestUser &&
      isExplicitCommercialQuestion(latestUserText) &&
      !isMixedCatalogAndCommercialQuestion(latestUserText, storedContract) &&
      (!storedContract ||
        storedContract.commercialAction === 'explain_manager_required' ||
        shouldUseProactiveCommercialDeterministicAnswer(storedContract, latestUserText))
    ) {
      const commercialCards = allShownProductCards(history);
      const commercialRecoveryAllowsLead = !isContactRefusalTechnicalSummaryRequest(latestUserText);
      const commercialContract: AgentTurnContract = {
        answerTask: 'lead_handoff',
        taskType: 'pure_delivery',
        catalogAction: 'none',
        commercialAction: 'explain_manager_required',
        productCardsPolicy: 'none',
        mustAnswerNow: ['answer delivery, discount, and rough total safely from already shown cards'],
        activeNeeds: (session.needState.activeNeeds ?? []).map((need) => ({
          id: need.id,
          productClass: need.productClass,
          summary: need.summary
        })),
        currentFocus: 'commercial',
        cardsRole: 'none',
        leadAllowed: commercialRecoveryAllowsLead,
        leadAllowedReason: commercialRecoveryAllowsLead
          ? 'deterministic recovery for commercial terms with optional specialist/logistics handoff'
          : 'deterministic recovery for commercial terms without contact pressure',
        errorRecoveryPriority: 'Give a safe commercial answer without promising final stock, delivery, discount, or exact terms.',
        validatorWarnings: ['commercial_recovery_contract']
      };
      const effectiveCommercialContract = {
        ...commercialContract,
        activeNeeds: storedContract?.activeNeeds?.length ? storedContract.activeNeeds : commercialContract.activeNeeds,
        leadAllowed: storedContract?.leadAllowed === false ? false : commercialContract.leadAllowed,
        leadAllowedReason: storedContract?.leadAllowed === false
          ? storedContract.leadAllowedReason
          : commercialContract.leadAllowedReason
      };
      const answer = deterministicCommercialHandoffFallback({
        cards: commercialCards,
        selectionResult: {
          state: session.needState.selectionState,
          matchedProducts: commercialCards.map(productFromCard),
          visibleProducts: commercialCards.map(productFromCard),
          hiddenProducts: [],
          comparisonProducts: [],
          rejectedProducts: [],
          missingQuestions: [],
          confidence: 0.7,
          trace: { source: 'recovery_historical_cards' }
        } as ProductSelectionResult,
        contract: effectiveCommercialContract,
        latestUserMessage: latestUserText
      });
      if (answer) {
        return completeRecoveredAnswer(answer, effectiveCommercialContract, {
          cards: [],
          cardDisplay: undefined
        });
      }
    }
    if (!storedContract && latestUser && isContactRefusalTechnicalSummaryRequest(latestUserText)) {
      const summaryContract: AgentTurnContract = {
        answerTask: 'technical_explanation',
        taskType: 'contact_refusal_continue_selection',
        catalogAction: 'none',
        commercialAction: 'none',
        productCardsPolicy: 'none',
        mustAnswerNow: ['summarize current generator and plate technical choice without contact collection'],
        activeNeeds: (session.needState.activeNeeds ?? []).map((need) => ({
          id: need.id,
          productClass: need.productClass,
          summary: need.summary
        })),
        currentFocus: 'technical_summary',
        cardsRole: 'none',
        leadAllowed: false,
        leadAllowedReason: 'buyer explicitly refused a call and asked to continue technical selection',
        errorRecoveryPriority: 'Summarize current technical recommendation and missing inputs without asking for contact.',
        validatorWarnings: ['contact_refusal_summary_recovery_contract']
      };
      const answer = deterministicTechnicalSummaryRecovery({
        cards: allShownProductCards(history),
        state: session.needState.selectionState
      });
      return completeRecoveredAnswer(answer, summaryContract, {
        cards: [],
        cardDisplay: undefined
      });
    }
    const recoveryBaseQuery = productSearchText(latestUserText, recoveryNeedState);
    const recoveryPlan = !storedContract && latestUserText
      ? await this.planAssistantTurn({
          userMessage: latestUserText,
          needState: recoveryNeedState,
          products: [],
          knowledgePages: [],
          troubleshootingCases: [],
          conflicts: [],
          history,
          historySummary: session.historySummary,
          baseQuery: recoveryBaseQuery,
          signal: input.signal,
          diagnostics: recoveryAiDiagnostics
        }).catch((error) => {
          markAiFallback(recoveryAiDiagnostics, 'turnPlanningFallback', error, 'recovery_turn_planning_failed');
          console.warn('Recovery turn planning failed', safeError(error));
          return null;
        })
      : null;
    const derivedRecoveryContract = recoveryPlan?.agentDecision
      ? deriveAgentTurnContract({
          userMessage: latestUserText,
          plan: recoveryPlan,
          needState: recoveryNeedState
        })
      : null;
    const fallbackCurrentLineupContract: AgentTurnContract | null = recoveryCurrentLineupStyle
      ? currentLineupRecoveryContract({
          answerTask: 'technical_explanation',
          taskType: 'technical_answer',
          catalogAction: 'exact_model_lookup',
          commercialAction: isCatalogAvailabilityQuestion(latestUserText) ? 'offer_contact_after_answer' : 'none',
          productCardsPolicy: 'none',
          mustAnswerNow: ['answer latest current-lineup and catalog-presence question without stale product cards'],
          activeNeeds: (recoveryNeedState.activeNeeds ?? []).map((need) => ({
            id: need.id,
            productClass: need.productClass,
            summary: need.summary
          })),
          currentFocus: latestUserText.slice(0, 120) || 'current-lineup recovery',
          cardsRole: 'none',
          leadAllowed: isCatalogAvailabilityQuestion(latestUserText),
          leadAllowedReason: 'fallback current-lineup recovery contract',
          errorRecoveryPriority: 'Answer the current model-status question safely.',
          validatorWarnings: ['current_lineup_recovery_fallback_contract']
        }, latestUserText)
      : null;
    const rawContract = storedContract ?? derivedRecoveryContract ?? fallbackCurrentLineupContract;
    const contract = rawContract ? currentLineupRecoveryContract(rawContract, latestUserText) : null;
    if (!contract) {
      const diagnostic = recoveryAiDiagnostics.turnPlanningFallback.used
        ? recoveryAiDiagnostics.turnPlanningFallback
        : markAiFallback(
            recoveryAiDiagnostics,
            'turnPlanningFallback',
            recoveryPlan ? 'missing_agent_decision' : 'missing_turn_contract',
            'recovery_missing_turn_contract'
          );
      throw aiStageFailure('turn recovery planning', diagnostic);
    }
    if (recoveryCurrentLineupStyle) {
      const rawRecoveryCatalogProducts = await this.findProducts(
        latestUserText,
        recoveryNeedState,
        recoveryBaseQuery,
        undefined,
        input.signal
      ).catch((error) => {
        console.warn('Recovery current-lineup catalog lookup failed', safeError(error));
        return [];
      });
      recoveryCatalogProducts = currentLineupRecoveryCatalogProducts(latestUserText, rawRecoveryCatalogProducts);
    }
    const contractDisallowsRecoveryCards =
      recoveryCurrentLineupStyle ||
      contract.cardsRole === 'none' ||
      contract.catalogAction === 'none' ||
      contract.productCardsPolicy === 'none';
    const recoveredSelection = contractDisallowsRecoveryCards
      ? { cards: [] as ProductCard[], cardDisplay: undefined as CardDisplayOptions | undefined }
      : await this.productCardsFromRecoveredSelection(recoveryNeedState, latestUserText);
    const recoveryBlocksEstimatedPumpCards = Boolean(
      recoveryNeedState.selectionState?.targetProductClass === 'generator' &&
      shouldBlockGeneratorCardsForEstimatedPump(recoveryNeedState.selectionState)
    );
    const recoveredCardSummary = recoveredSelection.cards.slice(0, LARGE_SLICE_VISIBLE_CARDS).map((card) => ({
      id: card.id,
      name: card.name,
      price: card.price,
      category: card.category
    }));
    const recoveryGeneratorSizingPolicy = generatorSizingPolicyForAnswer(
      recoveryNeedState.selectionState?.loadProfile,
      recoveredSelection.cards
    );
    const deterministicRecoveryAnswer = deterministicRecoveredSelectionAnswer({
      contract,
      cards: recoveredSelection.cards,
      state: recoveryNeedState,
      latestUserMessage: latestUserText
    });
    if (deterministicRecoveryAnswer) {
      const safeRecoveryAnswer = ensureCommercialManagerVerification(
        shouldSuppressLeadRequestFromContract(contract)
          ? stripLeadPressureTail(sanitizeVisibleAnswer(deterministicRecoveryAnswer))
          : sanitizeVisibleAnswer(deterministicRecoveryAnswer),
        contract
      );
      return completeRecoveredAnswer(safeRecoveryAnswer, contract, recoveredSelection);
    }
    const client = createOpenAIClient();
    let answer = '';
    let openAiError: unknown;
    if (client && latestUser) {
      try {
        const recoveryAnswerRequest: Record<string, unknown> = {
          model: config.OPENAI_ANSWER_MODEL,
          reasoning: { effort: config.OPENAI_ANSWER_REASONING_EFFORT },
          instructions: [
            buildSystemPrompt(),
            'Recover an interrupted chat answer. Do not repeat the user message. Finish the answer from the saved turn contract. Be concise and human. Do not show technical error codes to the buyer.',
            recoveredSelection.cards.length
              ? 'Validated product cards are being returned with this recovery payload. Treat them as already shown under the answer: give a short selection conclusion, name only the first one or two visible cards, and do not say you will select cards later.'
              : '',
            recoveryBlocksEstimatedPumpCards
              ? 'The current generator selection is blocked because the pump is present but its type/model/power is still unknown. Do not show or promise product cards. Give only a preliminary load orientation and ask specifically for pump type, model, or power as the next critical question.'
              : '',
            recoveryGeneratorSizingPolicy
              ? 'For generator sizing recovery, answerContext.generatorSizingPolicy is authoritative: calculatedMinimumNominalKw is the load result, minimallySufficientNominalRangeKw is the selection window, and visible card powers are catalog options. Do not introduce a higher generator class unless it is supported by this policy.'
              : '',
            recoveryCurrentLineupStyle
              ? 'For current manufacturer-status/current-lineup recovery, use web search internally when available. Separate three things: BAKAUT catalog presence, live stock/order availability that requires specialist verification, and manufacturer current status. Do not show product cards. Do not reuse models from the previous topic unless the latest user message names them.'
              : '',
            contract
              ? `TurnContract: answerTask=${contract.answerTask}; cardsRole=${contract.cardsRole}; leadAllowed=${contract.leadAllowed}; mustAnswerNow=${contract.mustAnswerNow.join('; ') || contract.errorRecoveryPriority}.`
              : '',
            contract ? technicalCurrentLevelAnswerGuidance(contract) : '',
            contract ? commercialManagerVerificationGuidance(contract) : ''
          ].filter(Boolean).join('\n\n'),
          input: [{
            role: 'user',
            content: yaml.dump(cleanEmpty({
              latestUserMessage: latestUserText,
              conversationSummary: session.historySummary,
              activeNeeds: recoveryNeedState.activeNeeds,
              turnContract: contract,
              catalogMatches: recoveryCatalogProducts.slice(0, 8).map((product) => ({
                id: product.id,
                name: product.name,
                category: product.category,
                price: product.price,
                sourceUrl: product.sourceUrl
              })),
              productCardsShown: recoveredCardSummary,
              productCardDisplay: recoveredSelection.cardDisplay,
              generatorCardBlockReason: recoveryBlocksEstimatedPumpCards
                ? 'pump_present_but_type_model_power_unknown'
                : undefined,
              productSelection: selectionMetadata({
                state: recoveryNeedState.selectionState,
                matchedProducts: [],
                visibleProducts: [],
                hiddenProducts: [],
                comparisonProducts: [],
                rejectedProducts: [],
                confidence: recoveryNeedState.selectionState?.confidence ?? 0,
                missingQuestions: recoveryNeedState.selectionState?.unknowns ?? [],
                trace: { source: 'recovery_selection_state' }
              }),
              generatorSizingPolicy: recoveryGeneratorSizingPolicy,
              recentMessages: compactHistoryForAI(history, 10, 700)
            }))
          }],
          max_output_tokens: 1200
        };
        if (recoveryCurrentLineupStyle) {
          recoveryAnswerRequest.tools = [{
            type: 'web_search_preview',
            search_context_size: 'high'
          }];
          recoveryAnswerRequest.tool_choice = { type: 'web_search_preview' };
        }
        const response: any = await client.responses.create(recoveryAnswerRequest, input.signal ? { signal: input.signal } : undefined);
        logOpenAIUsage('answer_recovery', config.OPENAI_ANSWER_MODEL, response);
        answer = extractResponseText(response).trim();
      } catch (error) {
        openAiError = safeError(error);
        console.warn('Turn recovery failed', openAiError);
      }
    }
    if (!answer) {
      if (recoveryCurrentLineupStyle) {
        answer = deterministicCurrentLineupRecoveryFallback({
          latestUserMessage: latestUserText,
          catalogProducts: recoveryCatalogProducts,
          leadAllowed: contract.leadAllowed
        });
      }
    }
    if (!answer) {
      const diagnostic = markAiFallback(
        recoveryAiDiagnostics,
        'answerGenerationFallback',
        openAiError ?? 'empty_recovery_answer',
        'recovery_answer_generation_failed'
      );
      throw aiStageFailure('answer recovery', diagnostic);
    }
    answer = sanitizeVisibleAnswer(answer);
    answer = ensureCommercialManagerVerification(
      shouldSuppressLeadRequestFromContract(contract) ? stripLeadPressureTail(answer) : answer,
      contract
    );
    return completeRecoveredAnswer(answer, contract, recoveredSelection, openAiError);
  }

  private async maybeSummarizeHistory(sessionId: string, history: Message[], existingSummary?: string | null) {
    if (history.length < 6) return;
    const client = createOpenAIClient();
    if (!client) return;
    try {
      const messagesToSummarize = history.slice(0, -4);
      if (!messagesToSummarize.length) return;
      const response: any = await withRetry(() => client.responses.create({
        model: config.OPENAI_PLANNER_MODEL,
        input: [
          { role: 'system', content: 'Кратко опиши, что обсуждалось в этих сообщениях. Оставь только суть: что искали, что выбрали, какие условия важны. Если есть предыдущее резюме, объедини его с новыми сообщениями.' },
          { role: 'user', content: yaml.dump(cleanEmpty({
            previousSummary: existingSummary,
            newMessagesToSummarize: compactHistoryForAI(messagesToSummarize, 10, 700)
          })) }
        ]
      }), 2);
      const summary = (response.output_text ?? '').trim();
      if (summary) {
        await this.conversations.updateHistorySummary(sessionId, summary);
      }
    } catch (e) {
      const err = safeError(e);
      console.error('[HistorySummary] Failed for session', sessionId, err);
      if (existingSummary) {
        console.warn('[HistorySummary] Keeping existing summary as fallback');
      }
    }
  }

  private async storeVerifiedWebFindings(input: {
    userMessage: string;
    answer: string;
    products: Product[];
    response: unknown;
    signal?: AbortSignal;
  }) {
    const citations = extractUrlCitations(input.response);
    if (!citations.length) return;

    for (const citation of citations.slice(0, 12)) {
      const citationUrl = normalizeEvidenceUrl(citation.url);
      const product = input.products.find((item) => normalizeEvidenceUrl(item.sourceUrl) === citationUrl);
      await this.products.recordWebEvidence({
        productId: product?.id,
        query: input.userMessage,
        sourceUrl: citation.url,
        title: citation.title,
        snippet: citation.snippet,
        verdict: { answerExcerpt: input.answer.slice(0, 1200) }
      });
    }

    const troubleshootingCase = buildTroubleshootingCaseDraft({
      userMessage: input.userMessage,
      answer: input.answer,
      sourceUrls: citations.map((citation) => citation.url),
      sourceTitles: citations.map((citation) => citation.title ?? '').filter(Boolean)
    });
    if (troubleshootingCase) {
      const embedding = await createEmbedding([
        troubleshootingCase.model,
        (troubleshootingCase.faultCodes ?? []).join(' '),
        troubleshootingCase.problemSummary,
        troubleshootingCase.answer
      ].filter(Boolean).join('\n'), input.signal).catch(() => null);
      await this.products.upsertTroubleshootingCase(troubleshootingCase, embedding ?? undefined);
    }

    const client = createOpenAIClient();
    if (!client || !input.products.length) return;
    if (!config.OPENAI_ENABLE_WEB_FACT_EXTRACTION) return;

    const response: any = await withRetry(() => client.responses.create({
      model: config.OPENAI_FACT_MODEL,
      reasoning: { effort: config.OPENAI_FACT_REASONING_EFFORT },
      input: [
        {
          role: 'system',
          content: 'Extract only confirmed product technical facts from the assistant answer and cited sources. Do not extract delivery, stock, discount, price, or special condition claims. Return an empty facts array unless the attribute, value, product, and source URL are explicit.'
        },
        {
          role: 'user',
          content: yaml.dump(cleanEmpty({
            products: input.products.map((product) => ({
              id: product.id,
              name: product.name,
              sourceUrl: product.sourceUrl
            })),
            citations,
            answer: input.answer
          }))
        }
      ],
      text: {
        format: {
          type: 'json_schema',
          name: 'verified_web_facts',
          strict: true,
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              facts: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    productId: { type: 'string' },
                    attribute: { type: 'string' },
                    value: { type: 'string' },
                    unit: { type: ['string', 'null'] },
                    sourceUrl: { type: 'string' },
                    confidence: { type: 'number', minimum: 0, maximum: 1 }
                  },
                  required: ['productId', 'attribute', 'value', 'unit', 'sourceUrl', 'confidence']
                }
              }
            },
            required: ['facts']
          }
        }
      },
      max_output_tokens: config.OPENAI_FACT_MAX_OUTPUT_TOKENS
    }, input.signal ? { signal: input.signal } : undefined), 2, input.signal);
    logOpenAIUsage('web_fact_extraction', config.OPENAI_FACT_MODEL, response);

    const parsed = JSON.parse(response.output_text || '{"facts":[]}') as {
      facts?: Array<{ productId: string; attribute: string; value: string; unit?: string | null; sourceUrl?: string; confidence?: number }>;
    };

    const productIds = new Set(input.products.map((product) => product.id));
    const citationUrls = new Set(citations.map((citation) => normalizeEvidenceUrl(citation.url)));
    for (const fact of parsed.facts ?? []) {
      if (!productIds.has(fact.productId) || !fact.sourceUrl || !citationUrls.has(normalizeEvidenceUrl(fact.sourceUrl))) continue;
      if (!fact.attribute.trim() || !fact.value.trim()) continue;
      await this.products.upsertVerifiedWebFact({
        productId: fact.productId,
        attribute: fact.attribute.trim().toLowerCase(),
        value: fact.value.trim(),
        unit: fact.unit ?? null,
        sourceUrl: fact.sourceUrl,
        confidence: Math.max(0.6, Math.min(0.95, fact.confidence ?? 0.85))
      });
    }
  }
}

function needItemSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      value: { type: 'string' },
      evidence: { type: 'string' },
      confidence: { type: 'number', minimum: 0, maximum: 1 }
    },
    required: ['value', 'evidence', 'confidence']
  };
}

function productClassEnum(includeCommercial = false) {
  return includeCommercial
    ? [
        'generator',
        'weldingGenerator',
        'generatorOil',
        'engineOil',
        'generatorAccessory',
        'plateAccessory',
        'plate',
        'rammer',
        'roller',
        'cutter',
        'diamondBlade',
        'diamondCore',
        'trowel',
        'commercial',
        'unknown'
      ]
    : [
        'generator',
        'weldingGenerator',
        'generatorOil',
        'engineOil',
        'generatorAccessory',
        'plateAccessory',
        'plate',
        'rammer',
        'roller',
        'cutter',
        'diamondBlade',
        'diamondCore',
        'trowel',
        'unknown'
      ];
}

function activeNeedSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      id: { type: 'string' },
      productClass: { type: 'string', enum: productClassEnum(true) },
      summary: { type: 'string' },
      constraints: { type: 'array', items: { type: 'string' }, maxItems: 16 },
      openQuestions: { type: 'array', items: { type: 'string' }, maxItems: 12 },
      selectedProductIds: { type: 'array', items: { type: 'string' }, maxItems: 16 },
      status: { type: 'string', enum: ['open', 'selected', 'paused', 'closed'] }
    },
    required: ['id', 'productClass', 'summary', 'constraints', 'openQuestions', 'selectedProductIds', 'status']
  };
}

function needExtractionCriteriaSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      productIntent: { type: 'string', enum: productClassEnum() },
      productRole: { type: 'string', enum: ['coreProduct', 'accessory', 'consumable', 'unknown'] },
      fuel: { type: 'string', enum: ['gasoline', 'diesel', 'any', 'unknown'] },
      startType: { type: 'string', enum: ['electric', 'manual', 'any', 'unknown'] },
      enclosure: { type: 'string', enum: ['enclosed', 'open', 'any', 'unknown'] },
      conventionalGenerator: { type: ['boolean', 'null'] },
      singlePhase220: { type: ['boolean', 'null'] },
      budgetMax: { type: ['number', 'null'] },
      weightKgMin: { type: ['number', 'null'] },
      weightKgMax: { type: ['number', 'null'] },
      diameterMmMin: { type: ['number', 'null'] },
      diameterMmMax: { type: ['number', 'null'] },
      nominalPowerKwMin: { type: ['number', 'null'] },
      nominalPowerKwMax: { type: ['number', 'null'] },
      maxPowerKwMin: { type: ['number', 'null'] },
      maxPowerKwMax: { type: ['number', 'null'] },
      brandConstraint: { type: 'string' },
      exactModelConstraint: { type: 'string' },
      mustHaveTraits: { type: 'array', items: { type: 'string' }, maxItems: 16 },
      excludedClasses: { type: 'array', items: { type: 'string', enum: productClassEnum() }, maxItems: 16 },
      powerReasoning: { type: 'string' }
    },
    required: [
      'productIntent',
      'productRole',
      'fuel',
      'startType',
      'enclosure',
      'conventionalGenerator',
      'singlePhase220',
      'budgetMax',
      'weightKgMin',
      'weightKgMax',
      'diameterMmMin',
      'diameterMmMax',
      'nominalPowerKwMin',
      'nominalPowerKwMax',
      'maxPowerKwMin',
      'maxPowerKwMax',
      'brandConstraint',
      'exactModelConstraint',
      'mustHaveTraits',
      'excludedClasses',
      'powerReasoning'
    ]
  };
}

function loadProfileSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      items: {
        type: 'array',
        maxItems: 16,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            kind: { type: 'string' },
            name: { type: 'string' },
            count: { type: 'number' },
            runningKw: { type: ['number', 'null'] },
            startingKw: { type: ['number', 'null'] },
            source: { type: 'string', enum: ['explicit_user', 'estimated_average', 'web_average', 'catalog_fact'] },
            evidence: { type: 'string' }
          },
          required: ['kind', 'name', 'count', 'runningKw', 'startingKw', 'source', 'evidence']
        }
      },
      simultaneousStarting: { type: 'boolean' },
      simultaneousStartingKinds: { type: 'array', items: { type: 'string' }, maxItems: 8 },
      confidence: { type: 'number', minimum: 0, maximum: 1 },
      removedKinds: { type: 'array', items: { type: 'string' }, maxItems: 12 }
    },
    required: ['items', 'simultaneousStarting', 'simultaneousStartingKinds', 'confidence', 'removedKinds']
  };
}

function needExtractionSelectionStateSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      currentProductClass: { type: 'string', enum: productClassEnum() },
      targetProductClass: { type: 'string', enum: productClassEnum() },
      hardConstraints: needExtractionCriteriaSchema(),
      softPreferences: needExtractionCriteriaSchema(),
      unknowns: { type: 'array', items: { type: 'string' }, maxItems: 16 },
      conflicts: { type: 'array', items: { type: 'string' }, maxItems: 16 },
      selectedProductIds: { type: 'array', items: { type: 'string' }, maxItems: 16 },
      loadProfile: loadProfileSchema(),
      confidence: { type: 'number', minimum: 0, maximum: 1 }
    },
    required: [
      'currentProductClass',
      'targetProductClass',
      'hardConstraints',
      'softPreferences',
      'unknowns',
      'conflicts',
      'selectedProductIds',
      'loadProfile',
      'confidence'
    ]
  };
}

function semanticMemorySchema() {
  const semanticValueSchema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      text: { type: 'string' },
      min: { type: ['number', 'null'] },
      max: { type: ['number', 'null'] },
      unit: { type: 'string' },
      productClass: { type: 'string' },
      brand: { type: 'string' },
      amount: { type: ['number', 'null'] }
    },
    required: ['text', 'min', 'max', 'unit', 'productClass', 'brand', 'amount']
  };
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      version: { type: 'number', enum: [1] },
      activeRequirementIds: { type: 'array', items: { type: 'string' }, maxItems: 64 },
      requirements: {
        type: 'array',
        maxItems: 40,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string' },
            kind: { type: 'string', enum: ['productClass', 'task', 'weightKg', 'budgetRub', 'powerKw', 'diameterMm', 'brand', 'fuel', 'phase'] },
            value: semanticValueSchema,
            status: { type: 'string', enum: ['active', 'superseded', 'rejected', 'paused'] },
            strictness: { type: 'string', enum: ['strictOnly', 'targetRange', 'fallbackAllowed'] },
            evidence: { type: 'string' },
            source: { type: 'string', enum: ['explicit_user', 'llm_inference', 'catalog_fact'] },
            replacesRequirementIds: { type: 'array', items: { type: 'string' }, maxItems: 24 }
          },
          required: ['id', 'kind', 'value', 'status', 'strictness', 'evidence', 'source', 'replacesRequirementIds']
        }
      },
      mentionedProducts: {
        type: 'array',
        maxItems: 40,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            token: { type: 'string' },
            normalizedToken: { type: 'string' },
            role: { type: 'string', enum: ['targetProduct', 'availabilityCheck', 'comparison', 'example', 'compatibilityTarget'] },
            status: { type: 'string', enum: ['unresolved', 'foundInCatalog', 'notFound', 'notMatchingRequirement'] },
            productIds: { type: 'array', items: { type: 'string' }, maxItems: 24 },
            evidence: { type: 'string' }
          },
          required: ['token', 'normalizedToken', 'role', 'status', 'productIds', 'evidence']
        }
      },
      selectionPolicy: {
        type: 'object',
        additionalProperties: false,
        properties: {
          primaryRequirementIds: { type: 'array', items: { type: 'string' }, maxItems: 64 },
          alternativeMode: { type: 'string', enum: ['none', 'afterPrimary', 'fallbackOnly'] },
          explanationRequired: { type: 'boolean' }
        },
        required: ['primaryRequirementIds', 'alternativeMode', 'explanationRequired']
      },
      botCommitments: {
        type: 'array',
        maxItems: 30,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            kind: { type: 'string', enum: ['availability', 'recommendation', 'constraint', 'fact'] },
            text: { type: 'string' },
            productIds: { type: 'array', items: { type: 'string' }, maxItems: 16 },
            evidence: { type: 'string' }
          },
          required: ['kind', 'text', 'productIds', 'evidence']
        }
      }
    },
    required: ['version', 'activeRequirementIds', 'requirements', 'mentionedProducts', 'selectionPolicy', 'botCommitments']
  };
}

function agentContractV2Schema() {
  const agentSources = ['catalog', 'visible_cards', 'web', 'specialist', 'conversation_memory'];
  const stringArray = (maxItems: number) => ({ type: 'array', items: { type: 'string' }, maxItems });
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      version: { type: 'number', enum: [2] },
      intent: {
        type: 'string',
        enum: [
          'product_selection',
          'technical_answer',
          'comparison',
          'exact_model_lookup',
          'availability_check',
          'delivery_or_discount',
          'lead_handoff',
          'offtopic'
        ]
      },
      answerTask: {
        type: 'string',
        enum: ['technical_explanation', 'comparison', 'product_selection', 'mixed', 'lead_handoff']
      },
      taskType: {
        type: 'string',
        enum: [
          'pure_delivery',
          'pure_availability',
          'product_selection',
          'product_selection_with_delivery',
          'product_selection_with_availability',
          'technical_answer',
          'comparison',
          'contact_refusal_continue_selection'
        ]
      },
      catalogAction: {
        type: 'string',
        enum: ['none', 'exact_model_lookup', 'find_matching_products', 'verify_catalog_absence']
      },
      commercialAction: {
        type: 'string',
        enum: ['none', 'explain_manager_required', 'offer_contact_after_answer']
      },
      productCardsPolicy: {
        type: 'string',
        enum: ['none', 'show_exact_matches', 'show_matching_products', 'supporting_only']
      },
      cardsRole: {
        type: 'string',
        enum: ['none', 'supporting', 'primary']
      },
      leadPolicy: {
        type: 'string',
        enum: ['none', 'forbidden', 'optional_after_answer', 'required_now']
      },
      sourcePolicy: {
        type: 'object',
        additionalProperties: false,
        properties: {
          allowed: { type: 'array', items: { type: 'string', enum: agentSources }, maxItems: 5 },
          required: { type: 'array', items: { type: 'string', enum: agentSources }, maxItems: 5 },
          forbidden: { type: 'array', items: { type: 'string', enum: agentSources }, maxItems: 5 },
          webPurpose: { type: 'string', enum: ['technical_specs', 'manual_or_service', 'current_lineup', 'none'] }
        },
        required: ['allowed', 'required', 'forbidden', 'webPurpose']
      },
      needDelta: {
        type: 'object',
        additionalProperties: false,
        properties: {
          newRequirements: stringArray(16),
          confirmedRequirements: stringArray(16),
          changedRequirements: stringArray(16),
          supersededRequirementIds: stringArray(16),
          rejectedProductIds: stringArray(24)
        },
        required: [
          'newRequirements',
          'confirmedRequirements',
          'changedRequirements',
          'supersededRequirementIds',
          'rejectedProductIds'
        ]
      },
      missingFacts: stringArray(12),
      toolPlan: {
        type: 'array',
        maxItems: 8,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            tool: {
              type: 'string',
              enum: [
                'searchCatalog',
                'getProductDetails',
                'selectProducts',
                'compareProducts',
                'webFactSearch',
                'createLeadDraft',
                'createLead'
              ]
            },
            reason: { type: 'string' },
            required: { type: 'boolean' },
            inputHint: {
              type: 'object',
              additionalProperties: false,
              properties: {},
              required: []
            }
          },
          required: ['tool', 'reason', 'required', 'inputHint']
        }
      },
      selectedProductIds: stringArray(24),
      rejectedProductIds: stringArray(24),
      mustAnswerNow: stringArray(8),
      currentFocus: { type: 'string' },
      errorRecoveryPriority: { type: 'string' },
      confidence: { type: 'number', minimum: 0, maximum: 1 },
      warnings: stringArray(24)
    },
    required: [
      'version',
      'intent',
      'answerTask',
      'taskType',
      'catalogAction',
      'commercialAction',
      'productCardsPolicy',
      'cardsRole',
      'leadPolicy',
      'sourcePolicy',
      'needDelta',
      'missingFacts',
      'toolPlan',
      'selectedProductIds',
      'rejectedProductIds',
      'mustAnswerNow',
      'currentFocus',
      'errorRecoveryPriority',
      'confidence',
      'warnings'
    ]
  };
}

function turnPlanSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      action: {
        type: 'string',
        enum: [
          'answer_question',
          'recommend_products',
          'ask_clarifying_question',
          'verify_with_web',
          'collect_lead',
          'handoff_specialist'
        ]
      },
      answerMode: {
        type: 'string',
        enum: [
          'short',
          'productRecommendation',
          'detailedFact',
          'serviceCostComparison',
          'currentLineup',
          'leadCollection',
          'unknown'
        ]
      },
      cardPolicy: {
        type: 'string',
        enum: ['auto', 'showProducts', 'showAccessories', 'textOnly']
      },
      followUpPolicy: {
        type: 'string',
        enum: [
          'auto',
          'answerNowNoDeferredOffer',
          'askClarifyingQuestion',
          'offerNextStepAllowed',
          'collectLead'
        ]
      },
      contextScope: {
        type: 'string',
        enum: ['latestMessageOnly', 'activeNeed', 'previousSelection', 'fullSession']
      },
      searchScope: {
        type: 'string',
        enum: ['focusedNeed', 'broadenAlternatives', 'sameBrandOnly', 'previousSelectionOnly']
      },
      catalogSearchQuery: { type: 'string' },
      selectedProductIds: {
        type: 'array',
        items: { type: 'string' },
        maxItems: MAX_PRODUCT_CARDS
      },
      requiredProductTraits: {
        type: 'object',
        additionalProperties: false,
        properties: {
          productIntent: {
            type: 'string',
            enum: [
              'generator',
              'weldingGenerator',
              'generatorOil',
              'engineOil',
              'generatorAccessory',
              'plateAccessory',
              'plate',
              'rammer',
              'roller',
              'cutter',
              'diamondBlade',
              'diamondCore',
              'trowel',
              'unknown'
            ]
          },
          productRole: {
            type: 'string',
            enum: ['coreProduct', 'accessory', 'consumable', 'unknown']
          },
          fuel: {
            type: 'string',
            enum: ['gasoline', 'diesel', 'any', 'unknown']
          },
          startType: {
            type: 'string',
            enum: ['electric', 'manual', 'any', 'unknown']
          },
          enclosure: {
            type: 'string',
            enum: ['enclosed', 'open', 'any', 'unknown']
          },
          conventionalGenerator: { type: ['boolean', 'null'] },
          singlePhase220: { type: ['boolean', 'null'] },
          budgetMax: { type: ['number', 'null'] },
          weightKgMin: { type: ['number', 'null'] },
          weightKgMax: { type: ['number', 'null'] },
          diameterMmMin: { type: ['number', 'null'] },
          diameterMmMax: { type: ['number', 'null'] },
          nominalPowerKwMin: { type: ['number', 'null'] },
          nominalPowerKwMax: { type: ['number', 'null'] },
          maxPowerKwMin: { type: ['number', 'null'] },
          maxPowerKwMax: { type: ['number', 'null'] },
          powerReasoning: { type: 'string' }
        },
        required: [
          'productIntent',
          'productRole',
          'fuel',
          'startType',
          'enclosure',
          'conventionalGenerator',
          'singlePhase220',
          'budgetMax',
          'weightKgMin',
          'weightKgMax',
          'diameterMmMin',
          'diameterMmMax',
          'nominalPowerKwMin',
          'nominalPowerKwMax',
          'maxPowerKwMin',
          'maxPowerKwMax',
          'powerReasoning'
        ]
      },
      selectionState: {
        type: 'object',
        additionalProperties: false,
        properties: {
          currentProductClass: {
            type: 'string',
            enum: [
              'generator',
              'weldingGenerator',
              'generatorOil',
              'engineOil',
              'generatorAccessory',
              'plateAccessory',
              'plate',
              'rammer',
              'roller',
              'cutter',
              'diamondBlade',
              'diamondCore',
              'trowel',
              'unknown'
            ]
          },
          targetProductClass: {
            type: 'string',
            enum: [
              'generator',
              'weldingGenerator',
              'generatorOil',
              'engineOil',
              'generatorAccessory',
              'plateAccessory',
              'plate',
              'rammer',
              'roller',
              'cutter',
              'diamondBlade',
              'diamondCore',
              'trowel',
              'unknown'
            ]
          },
          compatibilityTargetProduct: { type: 'string' },
          mustHaveTraits: { type: 'array', items: { type: 'string' }, maxItems: 16 },
          niceToHaveTraits: { type: 'array', items: { type: 'string' }, maxItems: 16 },
          excludedClasses: {
            type: 'array',
            items: {
              type: 'string',
              enum: [
                'generator',
                'weldingGenerator',
                'generatorOil',
                'engineOil',
                'generatorAccessory',
                'plateAccessory',
                'plate',
                'rammer',
                'roller',
                'cutter',
                'diamondBlade',
                'diamondCore',
                'trowel',
                'unknown'
              ]
            },
            maxItems: 16
          },
          brandConstraint: { type: 'string' },
          exactModelConstraint: { type: 'string' },
          isAccessoryFollowUp: { type: 'boolean' },
          selectionConfidence: { type: 'number', minimum: 0, maximum: 1 },
          shouldShowCards: { type: 'boolean' },
          cardDisplayMode: {
            type: 'string',
            enum: ['exact_matches', 'compatible_accessories', 'alternatives', 'structured_selection', 'preliminary', 'none']
          }
        },
        required: [
          'currentProductClass',
          'targetProductClass',
          'compatibilityTargetProduct',
          'mustHaveTraits',
          'niceToHaveTraits',
          'excludedClasses',
          'brandConstraint',
          'exactModelConstraint',
          'isAccessoryFollowUp',
          'selectionConfidence',
          'shouldShowCards',
          'cardDisplayMode'
        ]
      },
      agentContractV2: agentContractV2Schema(),
      agentDecision: {
        type: 'object',
        additionalProperties: false,
        properties: {
          answerTask: {
            type: 'string',
            enum: ['technical_explanation', 'comparison', 'product_selection', 'mixed', 'lead_handoff']
          },
          taskType: {
            type: 'string',
            enum: [
              'pure_delivery',
              'pure_availability',
              'product_selection',
              'product_selection_with_delivery',
              'product_selection_with_availability',
              'technical_answer',
              'comparison',
              'contact_refusal_continue_selection'
            ]
          },
          catalogAction: {
            type: 'string',
            enum: ['none', 'exact_model_lookup', 'find_matching_products', 'verify_catalog_absence']
          },
          commercialAction: {
            type: 'string',
            enum: ['none', 'explain_manager_required', 'offer_contact_after_answer']
          },
          productCardsPolicy: {
            type: 'string',
            enum: ['none', 'show_exact_matches', 'show_matching_products', 'supporting_only']
          },
          mustAnswerNow: {
            type: 'array',
            items: { type: 'string' },
            maxItems: 8
          },
          currentFocus: { type: 'string' },
          cardsRole: {
            type: 'string',
            enum: ['none', 'supporting', 'primary']
          },
          leadAllowed: { type: 'boolean' },
          leadAllowedReason: { type: 'string' },
          errorRecoveryPriority: { type: 'string' },
          confidence: { type: 'number', minimum: 0, maximum: 1 }
        },
        required: [
          'answerTask',
          'taskType',
          'catalogAction',
          'commercialAction',
          'productCardsPolicy',
          'mustAnswerNow',
          'currentFocus',
          'cardsRole',
          'leadAllowed',
          'leadAllowedReason',
          'errorRecoveryPriority',
          'confidence'
        ]
      },
      needsWebSearch: { type: 'boolean' },
      missingInformation: {
        type: 'array',
        items: { type: 'string' }
      },
      answerGuidance: { type: 'string' }
    },
    required: [
      'action',
      'answerMode',
      'cardPolicy',
      'followUpPolicy',
      'contextScope',
      'searchScope',
      'catalogSearchQuery',
      'selectedProductIds',
      'requiredProductTraits',
      'selectionState',
      'agentContractV2',
      'agentDecision',
      'needsWebSearch',
      'missingInformation',
      'answerGuidance'
    ]
  };
}

function safeError(error: unknown) {
  if (!error || typeof error !== 'object') return { message: String(error) };
  const value = error as { name?: string; status?: number; code?: string; message?: string };
  return {
    name: value.name,
    status: value.status,
    code: value.code,
    message: value.message
  };
}

function logOpenAIUsage(stage: string, model: string, response: unknown) {
  if (!response || typeof response !== 'object') return;
  void recordOpenAIUsageOnce(stage, model, response);
  if (!config.DEBUG_OPENAI_USAGE) return;
  const usage = (response as { usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
    output_tokens_details?: { reasoning_tokens?: number };
  } }).usage;
  if (!usage) return;
  console.info('OpenAI usage', {
    stage,
    model,
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    reasoningTokens: usage.output_tokens_details?.reasoning_tokens,
    totalTokens: usage.total_tokens
  });
}

function hasResponseNode(value: unknown, predicate: (object: Record<string, unknown>) => boolean, depth = 0): boolean {
  if (!value || depth > 8) return false;
  if (Array.isArray(value)) return value.some((item) => hasResponseNode(item, predicate, depth + 1));
  if (typeof value !== 'object') return false;

  const object = value as Record<string, unknown>;
  if (predicate(object)) return true;
  return Object.values(object).some((item) => hasResponseNode(item, predicate, depth + 1));
}

function extractUrlCitations(value: unknown, depth = 0): WebCitation[] {
  if (!value || depth > 8) return [];
  if (Array.isArray(value)) return value.flatMap((item) => extractUrlCitations(item, depth + 1));
  if (typeof value !== 'object') return [];

  const object = value as Record<string, unknown>;
  const type = typeof object.type === 'string' ? object.type : '';
  const url = typeof object.url === 'string' ? object.url : undefined;
  const isCitation = Boolean(url && /url_citation|web_search|search_result|citation/i.test(type));
  const own: WebCitation[] = isCitation && url
    ? [{
        url,
        title: typeof object.title === 'string' ? object.title : undefined,
        snippet: typeof object.snippet === 'string' ? object.snippet : undefined
      }]
    : [];

  return [
    ...own,
    ...Object.values(object).flatMap((item) => extractUrlCitations(item, depth + 1))
  ].filter((citation, index, all) => all.findIndex((item) => item.url === citation.url) === index);
}

export const assistantTestHooks = {
  buildProductFitProfile,
  requestedVisibleCardLimitFromText,
  resolveTurnContractForPlan,
  selectCardsFromPlan,
  selectCardsFromTurnContract,
  initialVisibleCardCountForCards,
  exactAvailabilityInitialVisibleCount,
  answerContextProductsForCards,
  compactSuitableProductsForAnswer,
  compactRuntimeContractsForAnswer,
  selectionResultCanDriveCards,
  shouldForceStructuredSelectionCards,
  isCatalogShortlistTurn,
  hasExplicitGeneratorElectricStartNeed,
  enforceAnswerCardContract,
  detectAnswerCardContractViolation,
  repairAnswerForFinalCards,
  cardsFromPlan,
  sanitizeVisibleAnswer,
  applyPostAnswerVerificationPolicy,
  ensureLargeSliceShowMoreNote,
  recommendationScore,
  supplementalCatalogQueries,
  productFitPenalty,
  productSelectionHardViolation,
  relaxedPlannerOnlyOptionalGeneratorTraits,
  isCardWorthy,
  purchasePlanIfNeeded,
  shouldUseWebSearch,
  shouldUseDetailedFactStyle,
  shouldUseServiceCostStyle,
  shouldUseCurrentLineupStyle,
  isProductCardSelectionFollowUp,
  coerceNeedUpdate,
  shouldUseDeepReasoningForPlanning,
  shouldUseDeepReasoningForAnswer,
  resolveReasoningProfile,
  buildFactualVerificationPolicy,
  webSearchContextSize,
  parseWeightNeedRangeKg,
  parseDimensionNeedRangeMm,
  extractModelTokens,
  isHeavyDutyPlateNeed,
  isSmallSitePlateNeed,
  implicitPlateWeightRangeFromNeed,
  isCatalogSelectionRequestText,
  shouldUseFastTechnicalOrientation,
  deterministicPlateWeightOrientation,
  coerceTurnPlan,
  fallbackTurnPlan,
  lastVisibleShownProductCards,
  repairAnswerCardText,
  repairCardPhaseFactContradictions,
  repairGeneratorLoadMinimumText,
  repairExplicitPhaseReconfirmation,
  repairAvailabilityAnswerWithCatalogModels,
  shouldSuppressLeadRequestFromContract,
  shouldRequestLeadFormForAnswer,
  technicalCurrentLevelAnswerGuidance,
  shouldFreezeSelectionContextForNonCatalogTurn,
  freezeSelectionContextForNonCatalogTurn,
  commercialManagerVerificationGuidance,
  stripLeadPressureTail,
  ensureCommercialManagerVerification,
  sanitizeThirdPersonManagerRole,
  sanitizeSelfExcludingSelectionState,
  explicitCriteriaFromTurn,
  generatorSizingPolicyForAnswer,
  leadCreatedConfirmationAnswer,
  deterministicLeadCollectionAnswer,
  deterministicCommercialHandoffFallback,
  isMixedCatalogAndCommercialQuestion,
  isShownProductChoiceOrComparisonQuestion,
  shouldUseProactiveCommercialDeterministicAnswer,
  deterministicTechnicalSummaryRecovery,
  deterministicRecoveredSelectionAnswer,
  deterministicAnswerGenerationFallback,
  deriveAgentTurnContractV2,
  AgentToolRegistry,
  toolResultToTrace,
  buildProductEvidenceRegistry,
  compactProductEvidenceRegistry,
  runPolicyGate,
  buildLeadDraft,
  reliableBundleTotal,
  isCatalogAvailabilityQuestion,
  isManufacturingStatusQuestion,
  pumpTypeFromText,
  generatorLoadProfileFromText,
  shouldPromotePrimarySelectionCards,
  shouldPromoteCatalogFactCheckedCards,
  shouldPromoteSupportingSelectionCards,
  shouldAllowPreliminaryCatalogCardsForEstimatedPump,
  promotePlanToSelectionCatalogCards,
  shouldPromoteGeneratorSizingCards,
  shouldPromoteGeneratorSizingCardsForContract,
  shouldBlockGeneratorCardsForEstimatedPump
};
