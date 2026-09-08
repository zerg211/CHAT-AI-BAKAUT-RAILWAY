import { recordTurnTelemetry, runWithTurnStageEmitter, type AgentManagerStageEmitter } from './turnTelemetry.js';
import {AgentManagerToolExecutor,groundedBuyerQuestion,blockedLeadReplayResult,isBlockedLeadReplayResult,durableLeadOutboxStatus,typedProductClassKey,productMentionRoleForTargetName,productNameAllowedAsExactTarget,targetProductNamesForRequest,suppressedContextTargetProductNamesForRequest,comparisonAttributesForRequest,comparisonAttributeBindingsForRequest,productLookupText,productMatchesTargetName,productMatchesExactTargetIdentity,resolvedToolProductIntent,toolRequestTargetsPrimarySelectionClass,productsMatchingToolRequestIntent,resolvedToolPowerSource,WEB_ANSWER_RESERVE_MS,WEB_MIN_EXECUTION_MS,CATALOG_ANSWER_RESERVE_MS,CURRENT_PRICE_VERIFICATION_TOP_K,effectiveAgentToolTimeoutMs,productsFromPersistedToolResult,maximumToolResultItemCount,assertToolResultBounds,productMeetsStructuredPowerSource,hardSelectionNumber,resolvedEligibilityStatusForStrictKinds,passesNativeConstraintOrResolvedProof,filterProductsByStructuredSelectionPolicy,catalogCandidatesSatisfyingConditionalWebRequest,allowCatalogOnlyResearchForWebRequest,SelectionCandidateTier,visibleSelectionTier,structuredCatalogExpansionQuery,targetBrandCandidates,productHasTargetBrand,compactCatalogProduct,catalogPresenceForTargets,nearbyCatalogProductsForTargets,productForResearchFact,researchFactProductName,exactCoverageProductNamesMatch,mergeVerifiedMemoryWithResearch,productNamesFromToolRequest} from './agentManagerToolExecutor.js';
export {productMatchesExactTargetIdentity,productsMatchingToolRequestIntent,effectiveAgentToolTimeoutMs,filterProductsByStructuredSelectionPolicy,catalogCandidatesSatisfyingConditionalWebRequest,allowCatalogOnlyResearchForWebRequest} from './agentManagerToolExecutor.js';
import {validateAgentAnswer,AgentManagerReviewInput,selectedCardsContradictReadiness,generatorSelectionOversizeIssue,requestStringArray,productMentionMatchesName,productNameContainsExactComparisonMention,toolRequestEvidenceText,productClassFromIntentMention,canonicalProductClassFromIntent,coerceVisibleCardIntent,generatorLoadRequirementKw,normalizedTextIncludesAny,presentCatalogPresenceLine,presentCatalogPresenceRelevant,nonFactBearingToolResultIds,uniqueReviewIssues,factSourceIdsFromNonFactBearingTools,webResearchTargetsCurrentIntent,answerStatesExactCatalogAbsence,researchGuidanceSemanticallySatisfied,expectedResearchGuidanceText} from './agentManagerReleaseValidator.js';
export type {AgentManagerReviewInput} from './agentManagerReleaseValidator.js';
export {selectedCardsContradictReadiness,generatorSelectionOversizeIssue,webResearchTargetsCurrentIntent,researchGuidanceSemanticallySatisfied,expectedResearchGuidanceText} from './agentManagerReleaseValidator.js';
import {AgentManagerModel,PendingLeadCaptureDraftContext,AgentManagerAnswerInput,AnswerProductRejectionReason,AnswerProductEvidenceRole,priorProductTargetsFromHistory,RequiredResponseClause,activeScopedLedgerFacts,productMentionEvidenceGrounded,leadCaptureHash,buyerQuestionContainsContactPii,currentEvidencePlannerName,requestedPreferredContact,leadCaptureActionFingerprint,durableLeadActionFingerprint,pendingLeadCaptureDraftMatchesAuthorizationScope,isDurableLeadCaptureResult,exactTargetProductMentionRoles,intentRequiresSearchBeforeSpecialist,webResearchResultProvesSourceExhaustion,technicalResearchStatus,trustedPendingExhaustedTechnicalHandoffs,hasVerifiedBuyerRequestedTechnicalHandoff,hasProvenTechnicalHandoffContinuation,toolResultCanGroundFacts,ledgerDeltaFormat,observationDecisionFormat,intentContractFormat,semanticDecisionFormat,answerContractFormat,OpenAIAgentManagerModel} from './agentManagerModelAdapter.js';
export type {AgentManagerModel,AgentManagerModelInput,PendingLeadCaptureDraftContext,PendingExhaustedTechnicalHandoffContext,AgentManagerAnswerInput,AgentManagerObservationInput,AnswerProductRejectionReason,AnswerProductEvidenceRole} from './agentManagerModelAdapter.js';
export {priorVisibleProductsFromHistory,priorProductTargetsFromHistory,productMentionEvidenceGrounded,pendingLeadCaptureDraftMatchesAuthorizationScope,webResearchResultProvesSourceExhaustion,trustedPendingExhaustedTechnicalHandoffs,priorUnresolvedTechnicalResearch,hasVerifiedBuyerRequestedTechnicalHandoff,pendingBuyerRequestedTechnicalHandoffs,observationDecisionFormatForRequirements,answerContractFormatForEvidenceSources,OpenAIAgentManagerModel} from './agentManagerModelAdapter.js';
import { coordinateTurnRecovery, TurnExecutionInProgressError } from './recoveryCoordinator.js';
export {TurnExecutionInProgressError,RecoveryAttemptUnavailableError,MAX_TURN_RECOVERY_ATTEMPTS,RECOVERY_LEASE_WAIT_LIMIT_MS} from './recoveryCoordinator.js';
export type {AgentManagerStageEvent} from './turnTelemetry.js';
import { createHash, randomUUID } from 'node:crypto';
import { ZodError } from 'zod';
import { config } from '../config.js';
import { ConversationRepository, LeadRepository, ProductRepository } from '../db/repositories.js';
import type { AgentSourcePolicyV2, AgentTaskType, AgentTurnContract, ChatResponsePayload, ConversationSession, CustomerNeedState, LeadCaptureDraft, Message, Product, ProductCard, ProductSelectionClass, VerifiedProductFact } from '../shared/types.js';
import { AgentIntentContractSchema, AgentSemanticDecisionSchema, DialogueLedgerEventSchema, DEFAULT_AGENT_INTENT_GROUNDING_RATIONALE, LedgerStateDeltaSchema, PreSendReviewSchema, ToolResultSchema, createStableLedgerEventId, normalizeLedgerStateDeltaEvents, parseAnswerContractModelOutput, type AgentIntentContract, type AgentSemanticDecision, type AgentIntentGrounding, type AnswerContract, type DialogueLedgerEvent, type LedgerStateDelta, type PreSendReview, type SelectionRequirement, type ToolRequest, type ToolResult } from './agentManagerContracts.js';
import { deriveNeedStateSnapshotFromLedger, getActiveDialogueNeed, parseReducedDialogueLedgerState, reduceDialogueLedger, type ReducedDialogueLedgerState } from './dialogueLedgerReducer.js';
import { createEmbedding } from './openaiClient.js';
import { sanitizeVisibleAnswerNumbers } from './answerSanity.js';
import { CONTINUATION_MAX_ROUNDS, continuationValidationIssues, parseContinuationDecision, type ContinuationDecision, type ContinuationOutcome } from './agentManagerContinuation.js';
import { resolveProductsForEvidence } from './productFactResolution.js';
import { StructuredJsonDeadlineExceededError, StructuredJsonRetrySkippedError } from './openaiStructured.js';
import { extractCatalogProductComparisonFacts, researchProductComparisonFacts, researchResultCoversFactSlot, type ProductComparisonResearchFact, type ProductComparisonResearchResult, type ProductResearchDocumentReadContext, type ProductResearchTraceEvent } from './productComparisonResearch.js';
import { refreshExactCatalogProducts } from '../catalog/sitemapSync.js';
import { extractConfirmedGeneratorNominalPowerKw, extractWeightKg, fromEscaped, generatorAutoStartProfile, generatorPhaseProfile, generatorRemoteStartProfile, productMatchesIntent, productPowerSource } from './productClassifier.js';
import { emptyNeedState } from './needState.js';
import { safeError } from './responseUtils.js';
import { getAgentManagerRuntimeDecision } from './agentManagerRuntime.js';
import { extractContact, hasLeadContact } from './contactExtraction.js';
import { leadCaptureMissingContact, leadCaptureMissingName } from './leadReviewGuards.js';
import { hasAdjudicationRisk, hasUnsupportedClaimRisk } from './riskReviewGuards.js';
import { assessVisibleCardReadiness, budgetMaxFromNeedState, filterGeneratorProductsByLoadProfile, gateStrictSelectionRequirements, hasStructuredGeneratorRemoteStartPreference, productSelectionClasses, productCards, productMeetsSupportedStrictAutoStartRequirement, productMeetsSupportedStrictRemoteStartRequirement, productMeetsSupportedStrictFuelRequirement, productMeetsSupportedStrictPriceVisibilityRequirement, productMeetsSupportedStrictVoltageRequirement, qualifiedNominalActivePowerKw, rankCatalogProductsByStructuredPreferences, selectProductsForVisibleCards, strictSelectionRequirementShapeBlockers, structuredSelectionRankingObjectives, suppressVisibleCardsForReadiness, toolRequestProductIntent, toolRequestScopedQuery, uniqueStrings } from './agentManagerCardSelection.js';
import { buildGeneratorLoadToolPayload, hasUnconfirmedGeneratorLoadBasisResult, isGeneratorProductClass } from './agentManagerGeneratorLoad.js';
import { buildSalesManagerPolicyTrace, SALES_MANAGER_POLICY_PACK_HASH, SALES_MANAGER_POLICY_PACK_VERSION } from './salesManagerBehaviorPolicy.js';
import { agentManagerToolRegistry, toolResultByteLength, validateToolRequest, validateToolResultOutput } from './agentManagerToolRegistry.js';
import { AgentManagerTurnBudget, AgentManagerTurnBudgetExceededError, DEFAULT_AGENT_MANAGER_TURN_LIMITS, agentManagerTurnLimitsForProfile, runWithAgentManagerTurnBudget, selectAgentManagerBudgetProfile } from './agentManagerTurnBudget.js';
import { agentIntentRequiresCatalogEvidence, evaluateAgentManagerPolicyGate } from './agentManagerPolicyGate.js';
import { guardCustomerOutput } from './agentManagerOutputGuard.js';
import { buildDecisionArtifact } from './decisionArtifact.js';
import { admitReadContinuation } from './readContinuationController.js';
import { compactModelText, exactProductIdentity, modelIdentifierTokens, modelTextTokens, normalizeModelText, textMatchesTargetName, tokenHasDigit, tokenHasLetter } from './modelTextMatching.js';
import { matchingVerifiedFactsForRequest, reusableVerifiedFact, researchFactConfidenceNumber, researchFactMemoryCandidates, verifiedFactCoverageForRequest, verifiedFactsCoverRequest, verifiedFactsResearchResult } from './verifiedFactMemory.js';
import { canonicalFactAttribute, verifiedFactValueKey } from './verifiedFactNormalization.js';
import { knownTechnicalAnswerReady } from './knownTechnicalAnswer.js';
import { AI_MANAGER_RUNTIME_VERSION } from './aiManagerRuntimeManifest.js';
import { readCurrentSitePrice } from '../catalog/currentSitePrice.js';
import { verifyBudgetPrices } from '../catalog/verifyBudgetPrices.js';
import { buildRequirementProofs, combinedRequirementProofStatus, requirementUsesGenericReadProof, requirementProofsFor, resolvedRequirementEligibilityStatus, selectionRequirementAttributeMatches } from './requirementProofs.js';

export interface AgentManagerGenerateInput {
  sessionId: string;
  userMessage: string;
  turnId?: string;
  skipUserMessage?: boolean;
  onDelta?: (text: string) => void | Promise<void>;
  onStage?: AgentManagerStageEmitter;
  signal?: AbortSignal;
}

export interface AgentManagerRecoverInput {
  sessionId: string;
  turnId: string;
  onDelta?: (text: string) => void | Promise<void>;
  onStage?: AgentManagerStageEmitter;
  signal?: AbortSignal;
}



export type { AgentSemanticDecision } from './agentManagerContracts.js';














type DialogueLedgerRow = {
  session_id: string;
  turn_id: string;
  event_id: string;
  event_type: DialogueLedgerEvent['eventType'];
  scope: DialogueLedgerEvent['scope'];
  payload: Record<string, unknown>;
  evidence: string;
  source: DialogueLedgerEvent['source'];
  status: DialogueLedgerEvent['status'];
  event_seq?: string | number | null;
  created_at?: string | Date | null;
};


function createdAtText(value: unknown) {
  if (typeof value === 'string') return value;
  if (value instanceof Date) return value.toISOString();
  if (value && typeof value === 'object' && 'toISOString' in value && typeof value.toISOString === 'function') {
    return value.toISOString();
  }
  return undefined;
}

function mapLedgerRows(rows: DialogueLedgerRow[]): DialogueLedgerEvent[] {
  return rows.map((row) => ({
    sessionId: row.session_id,
    turnId: row.turn_id,
    eventId: row.event_id,
    eventType: row.event_type,
    scope: row.scope,
    payload: row.payload,
    evidence: row.evidence,
    source: row.source,
    status: row.status,
    createdAt: createdAtText(row.created_at)
  }));
}


function semanticRequirementValuesMatch(
  factKey: string, left: unknown, right: unknown, leftUnit?: string | null, rightUnit?: string | null
) {
  const normalizeScalar = (value: unknown) => typeof value === 'string'
    ? value.trim() && Number.isFinite(Number(value)) ? Number(value) : value.trim().toLocaleLowerCase('en-US')
    : value;
  const leftValue = normalizeScalar(left);
  const rightValue = normalizeScalar(right);
  const normalizedLeftUnit = leftUnit?.trim().toLocaleLowerCase('en-US');
  const normalizedRightUnit = rightUnit?.trim().toLocaleLowerCase('en-US');
  if (normalizedLeftUnit && normalizedRightUnit && normalizedLeftUnit !== normalizedRightUnit) return false;
  if (Object.is(leftValue, rightValue)) return true;
  if (factKey !== 'voltage_v') return false;

  const leftVoltage = typeof leftValue === 'number' ? leftValue : Number(leftValue);
  const rightVoltage = typeof rightValue === 'number' ? rightValue : Number(rightValue);
  if (!Number.isFinite(leftVoltage) || !Number.isFinite(rightVoltage)) return false;
  return (
    ([220, 230].includes(leftVoltage) && [220, 230].includes(rightVoltage)) ||
    ([380, 400].includes(leftVoltage) && [380, 400].includes(rightVoltage))
  );
}

function parallelIntentLedgerConflicts(input: {
  intent: AgentIntentContract;
  previousLedgerState: ReducedDialogueLedgerState;
  ledgerState: ReducedDialogueLedgerState;
  turnEvents: DialogueLedgerEvent[];
}) {
  const conflicts: string[] = [];
  const activeNeed = [...Object.values(input.ledgerState.needsById)]
    .reverse()
    .find((need) => need.status === 'open' || need.status === 'selected');
  const previousActiveNeed = [...Object.values(input.previousLedgerState.needsById)]
    .reverse()
    .find((need) => need.status === 'open' || need.status === 'selected');
  const relevantNeedId = activeNeed?.needId ?? previousActiveNeed?.needId;
  const ledgerClass = coerceVisibleCardIntent(activeNeed?.productClass);
  const intentClass = coerceVisibleCardIntent(
    input.intent.selectionPolicy?.canonicalProductClass ?? input.intent.selectionPolicy?.targetProductClass
  );
  if (ledgerClass !== 'unknown' && intentClass !== 'unknown' && ledgerClass !== intentClass) {
    conflicts.push(`active_product_class_mismatch:${ledgerClass}:${intentClass}`);
  }

  const activeNeedTurnEvents = activeNeed
    ? input.turnEvents.filter((event) => event.payload.needId === activeNeed.needId)
    : [];
  const openedNeed = activeNeedTurnEvents.some((event) => event.eventType === 'need.opened');
  const needAction = input.intent.selectionPolicy?.needAction;
  if (openedNeed && needAction !== 'open' && needAction !== 'switch') {
    conflicts.push(`opened_need_action_mismatch:${needAction ?? 'missing'}`);
  }

  const selectionWasReset = activeNeedTurnEvents.some((event) => {
    if (event.eventType !== 'need.opened' && event.eventType !== 'need.updated') return false;
    const mode = event.payload.selectionUpdateMode;
    return mode === 'replace' || mode === 'clear';
  });
  if (selectionWasReset && activeNeed?.selectedProductIds.length === 0 && input.intent.selectionPolicy?.reusePreviousCards) {
    conflicts.push('cleared_selection_cannot_reuse_previous_cards');
  }

  const explicitlyRemovedFactIds = new Set(input.turnEvents.flatMap((event) => [
    ...requestStringArray(event.payload.targetEventIds),
    ...requestStringArray(event.payload.negatesEventIds),
    ...requestStringArray(event.payload.supersedesEventIds)
  ]));
  if (explicitlyRemovedFactIds.size && relevantNeedId) {
    for (const previousFact of Object.values(input.previousLedgerState.factsByKey)) {
      if (
        previousFact.status !== 'active' ||
        previousFact.role !== 'hard_requirement' ||
        previousFact.needId !== relevantNeedId ||
        !explicitlyRemovedFactIds.has(previousFact.eventId)
      ) continue;
      const replacement = Object.values(input.ledgerState.factsByKey).find((fact) =>
        fact.status === 'active' &&
        fact.role === 'hard_requirement' &&
        fact.needId === previousFact.needId &&
        fact.factKey === previousFact.factKey
      );
      if (!replacement) conflicts.push(`active_requirement_removed:${previousFact.factKey}`);
    }
  }

  if (relevantNeedId) {
    const previousNeed = input.previousLedgerState.needsById[relevantNeedId];
    const currentNeed = input.ledgerState.needsById[relevantNeedId];
    const destructiveNeedUpdate = input.turnEvents.some((event) => {
      if (
        (event.eventType !== 'need.opened' && event.eventType !== 'need.updated' && event.eventType !== 'need.closed') ||
        event.payload.needId !== relevantNeedId
      ) return false;
      if (event.eventType === 'need.closed') return true;
      return [
        event.payload.constraintsUpdateMode,
        event.payload.openQuestionsUpdateMode,
        event.payload.rejectedProductIdsUpdateMode,
        event.payload.selectionUpdateMode
      ].some((mode) => mode === 'replace' || mode === 'clear') ||
        requestStringArray(event.payload.invalidatedProductIds).length > 0;
    });
    if (
      destructiveNeedUpdate &&
      previousNeed &&
      JSON.stringify({
        constraints: previousNeed.constraints,
        openQuestions: previousNeed.openQuestions,
        selectedProductIds: previousNeed.selectedProductIds,
        rejectedProductIds: previousNeed.rejectedProductIds,
        status: previousNeed.status
      }) !== JSON.stringify(currentNeed ? {
        constraints: currentNeed.constraints,
        openQuestions: currentNeed.openQuestions,
        selectedProductIds: currentNeed.selectedProductIds,
        rejectedProductIds: currentNeed.rejectedProductIds,
        status: currentNeed.status
      } : null)
    ) {
      conflicts.push(`active_need_state_replaced:${relevantNeedId}`);
    }
  }

  const turnFactEventIds = new Set(input.turnEvents
    .filter((event) => event.eventType === 'fact.observed' || event.eventType === 'fact.confirmed')
    .map((event) => event.eventId));
  const policy = input.intent.selectionPolicy;
  for (const fact of activeScopedLedgerFacts(input.ledgerState)) {
    if (
      fact.role !== 'hard_requirement' ||
      fact.status !== 'active' ||
      !turnFactEventIds.has(fact.eventId) ||
      !activeNeed ||
      fact.needId !== activeNeed.needId
    ) continue;
    const requirements = (policy?.requirements ?? []).filter((requirement) =>
      requirement.kind === fact.factKey &&
      requirement.role === 'hard_constraint' &&
      requirement.strictness === 'strict'
    );
    const matchingRequirement = requirements.some((requirement) =>
      semanticRequirementValuesMatch(fact.factKey, requirement.value, fact.value)
    );
    const hasStructuredField = fact.factKey === 'phase' || fact.factKey === 'power_source';
    const structuredFieldMatches = fact.factKey === 'phase'
      ? Object.is(policy?.phase, fact.value)
      : fact.factKey === 'power_source'
        ? Object.is(policy?.powerSource, fact.value)
        : false;
    const matchingRepresentation = matchingRequirement || structuredFieldMatches;
    const contradictoryRepresentation =
      (hasStructuredField && !structuredFieldMatches) ||
      (requirements.length > 0 && !matchingRequirement);
    if (
      !matchingRepresentation ||
      contradictoryRepresentation
    ) {
      conflicts.push(`active_requirement_mismatch:${fact.factKey}`);
    }
  }
  return uniqueStrings(conflicts);
}

export function reconcileNewActiveNeedProductClass(
  delta: LedgerStateDelta,
  intent: AgentIntentContract | undefined,
  options: { allowParallelContinue?: boolean } = {}
) {
  const canonicalProductClass = coerceVisibleCardIntent(intent?.selectionPolicy?.canonicalProductClass);
  const needAction = intent?.selectionPolicy?.needAction;
  const actionCanOpenNewNeed = needAction === 'open' || needAction === 'switch' ||
    (options.allowParallelContinue === true && needAction === 'continue');
  if (
    canonicalProductClass === 'unknown' ||
    !actionCanOpenNewNeed
  ) {
    return { delta, repairedNeedId: undefined as string | undefined };
  }

  const candidates = delta.events.filter((event) =>
    event.eventType === 'need.opened' &&
    event.payload.activate === true &&
    typeof event.payload.needId === 'string' &&
    event.payload.needId.trim().length > 0 &&
    coerceVisibleCardIntent(event.payload.productClass) === 'unknown'
  );
  if (candidates.length !== 1) {
    return { delta, repairedNeedId: undefined as string | undefined };
  }

  const repairedNeedId = String(candidates[0]!.payload.needId);
  const repairedDelta = LedgerStateDeltaSchema.parse({
    ...delta,
    events: delta.events.map((event) => {
      if (event.payload.needId !== repairedNeedId) return event;
      if (coerceVisibleCardIntent(event.payload.productClass) !== 'unknown') return event;
      return {
        ...event,
        payload: {
          ...event.payload,
          productClass: canonicalProductClass
        }
      };
    })
  });
  return { delta: repairedDelta, repairedNeedId };
}

function pendingLeadCaptureDraftContext(draft: LeadCaptureDraft | null): PendingLeadCaptureDraftContext | null {
  if (
    !draft ||
    buyerQuestionContainsContactPii(draft.buyerQuestion) ||
    buyerQuestionContainsContactPii(draft.purpose) ||
    draft.buyerQuestion.length > 1_000 ||
    draft.purpose.length > 1_000
  ) return null;
  const hasName = Boolean(draft.name?.trim());
  const hasPhone = Boolean(draft.phone?.trim());
  const hasEmail = Boolean(draft.email?.trim());
  return {
    id: draft.id,
    purpose: draft.purpose,
    buyerQuestion: draft.buyerQuestion,
    preferredContact: draft.preferredContact ?? null,
    hasName,
    hasPhone,
    hasEmail,
    missingFields: [
      ...(!hasName ? ['name' as const] : []),
      ...(!hasPhone && !hasEmail ? ['contact' as const] : [])
    ],
    expiresAt: draft.expiresAt
  };
}


function normalizeAnswerEvidenceSources(input: {
  answer: AnswerContract;
  ledgerState: ReducedDialogueLedgerState;
  toolResults: ToolResult[];
}): AnswerContract {
  return {
    ...input.answer,
    toolResultIds: [...new Set(input.answer.toolResultIds)],
    factsUsed: input.answer.factsUsed.map((fact) => ({
      ...fact,
      sourceEventIds: [...new Set(fact.sourceEventIds)]
    }))
  };
}

function failClosedRecoveredAnswerContract(answer: AnswerContract, intent: AgentIntentContract): AnswerContract {
  const missingSelectedIds = answer.selectedProductIds === undefined;
  const missingReadiness = answer.selectionReadiness === undefined;
  if (!missingSelectedIds && !missingReadiness) return answer;
  const productClass = intent.selectionPolicy?.canonicalProductClass
    ?? intent.selectionPolicy?.targetProductClass
    ?? 'unknown';
  return {
    ...answer,
    selectedProductIds: answer.selectedProductIds ?? [],
    selectionReadiness: answer.selectionReadiness ?? {
      productClass,
      status: 'needs_more_info',
      canShowProductCards: false,
      missingFacts: ['recovered_answer_contract_selection_metadata'],
      rationale: 'Recovered legacy answer omitted the explicit selection decision; product cards fail closed.'
    },
    riskFlags: uniqueStrings([...answer.riskFlags, 'recovered_legacy_answer_contract_fail_closed'])
  };
}

function assertUniqueToolRequestIds(requests: ToolRequest[]) {
  const seen = new Set<string>();
  for (const request of requests) {
    if (seen.has(request.id)) throw new Error(`duplicate_tool_request_id:${request.id}`);
    seen.add(request.id);
  }
  return requests;
}

export function orderToolRequestsForSelectionDependencies(
  requests: ToolRequest[],
  intent: AgentIntentContract
) {
  const proofRequestIds = new Set(
    (intent.selectionPolicy?.requirements ?? [])
      .map((requirement) => requirement.verification)
      .filter((verification): verification is Extract<NonNullable<typeof verification>, { mode: 'typed_tool' }> =>
        verification?.mode === 'typed_tool'
      )
      .map((verification) => verification.toolRequestId)
  );
  const hasCatalogSearchToWebDependency =
    requests.some((request) => request.tool === 'catalog.search') &&
    requests.some((request) => request.tool === 'web.researchProductFacts');
  const hasDetailsDependency =
    requests.some((request) => request.tool === 'catalog.getProductDetails') &&
    requests.some((request) => request.tool === 'catalog.search' || request.tool === 'web.researchProductFacts');
  if (!proofRequestIds.size && !hasCatalogSearchToWebDependency && !hasDetailsDependency) {
    return requests;
  }
  const priority = (request: ToolRequest) => {
    if (proofRequestIds.has(request.id) && !['catalog.search', 'catalog.getProductDetails', 'web.researchProductFacts'].includes(request.tool)) return 0;
    if (request.tool === 'catalog.search') return 1;
    if (request.tool === 'catalog.getProductDetails') return 2;
    if (request.tool === 'web.researchProductFacts') return 3;
    return 4;
  };
  return requests
    .map((request, index) => ({ request, index, priority: priority(request) }))
    .sort((left, right) => left.priority - right.priority || left.index - right.index)
    .map(({ request }) => request);
}

function semanticLoadIdentity(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  const kind = typeof item.kind === 'string' ? item.kind.trim().toLowerCase() : '';
  const name = typeof item.name === 'string' ? item.name.trim().toLowerCase() : '';
  return kind ? `${kind}:${name}` : null;
}

function executableSemanticLoadIdentity(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  const request: ToolRequest = {
    id: 'semantic-load-identity',
    tool: 'calculator.generatorLoad',
    args: { loads: [item] },
    rationale: 'normalize one semantic load for executable identity validation',
    required: true
  };
  const executable = buildGeneratorLoadToolPayload({ request, userMessage: '' }).loads[0];
  return executable ? semanticLoadIdentity(executable) : null;
}

function semanticLoadDeclaresPower(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return [item.runningKw, item.startingKw].some((candidate) =>
    typeof candidate === 'number' && Number.isFinite(candidate) && candidate > 0
  );
}

function semanticLoadExecutionFields(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  return {
    kind: item.kind ?? null,
    name: item.name ?? null,
    count: item.count ?? null,
    runningKw: item.runningKw ?? null,
    startingKw: item.startingKw ?? null,
    source: item.source ?? null,
    runningSource: item.runningSource ?? null,
    startingSource: item.startingSource ?? null,
    operationMode: item.operationMode ?? null,
    coRunningGroup: item.coRunningGroup ?? null,
    basisKind: item.basisKind ?? null,
    basisSignals: Array.isArray(item.basisSignals) ? item.basisSignals : []
  };
}

function generatorLoadSemanticFieldIssues(request: ToolRequest) {
  if (request.tool !== 'calculator.generatorLoad') return [] as string[];
  const loads = Array.isArray(request.args.loads) ? request.args.loads : [];
  const issues: string[] = [];
  if (!loads.length) issues.push('generator_load_items_missing');
  for (const [index, value] of loads.entries()) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      issues.push(`generator_load_item_invalid:${index}`);
      continue;
    }
    const item = value as Record<string, unknown>;
    if (typeof item.kind !== 'string' || !item.kind.trim()) issues.push(`generator_load_kind_missing:${index}`);
    if (typeof item.evidence !== 'string' || !item.evidence.trim()) issues.push(`generator_load_evidence_missing:${index}`);
    if (!['continuous', 'occasional', 'separate'].includes(String(item.operationMode))) {
      issues.push(`generator_load_operation_mode_missing:${index}`);
    }
    if (!['explicit_user', 'estimated_average', 'catalog_fact', 'web_average'].includes(String(item.source))) {
      issues.push(`generator_load_source_missing:${index}`);
    }
    if (!['explicit_user', 'estimated_average', 'catalog_fact', 'web_average', 'not_provided'].includes(String(item.runningSource))) {
      issues.push(`generator_load_running_source_missing:${index}`);
    }
    if (!['explicit_user', 'estimated_average', 'catalog_fact', 'web_average', 'not_provided'].includes(String(item.startingSource))) {
      issues.push(`generator_load_starting_source_missing:${index}`);
    }
    const hasRunning = typeof item.runningKw === 'number' && Number.isFinite(item.runningKw) && item.runningKw > 0;
    const hasStarting = typeof item.startingKw === 'number' && Number.isFinite(item.startingKw) && item.startingKw > 0;
    if (hasRunning === (item.runningSource === 'not_provided')) {
      issues.push(`generator_load_running_provenance_mismatch:${index}`);
    }
    if (hasStarting === (item.startingSource === 'not_provided')) {
      issues.push(`generator_load_starting_provenance_mismatch:${index}`);
    }
  }
  return issues;
}


function semanticAuthorityIssues(input: {
  decision: AgentSemanticDecision;
  events: DialogueLedgerEvent[];
  userMessage?: string;
  historicalToolResults?: ToolResult[];
  history?: Message[];
  provenExhaustedHandoffContinuation?: boolean;
}) {
  const intent = input.decision.intent;
  const policy = intent.selectionPolicy;
  const grounding = intent.grounding;
  const issues: string[] = [];
  const historicalTargets = priorProductTargetsFromHistory(input.history ?? []);
  if (!policy) issues.push('selection_policy_missing');
  if (!grounding || grounding.rationale === DEFAULT_AGENT_INTENT_GROUNDING_RATIONALE) {
    issues.push('grounding_policy_missing');
  }
  if (intent.requiresTools !== (intent.toolRequests.length > 0)) {
    issues.push('requires_tools_mismatch');
  }
  if (input.userMessage !== undefined) {
    for (const [index, mention] of (intent.productMentions ?? []).entries()) {
      if (!productMentionEvidenceGrounded(mention.evidence, input.userMessage)) {
        issues.push(`product_mention_evidence_not_in_current_message:${index}`);
      }
      const historicalReference = Boolean(mention.sourceMessageId) ||
        mention.sourceMessageId !== undefined && input.history !== undefined && exactTargetProductMentionRoles.has(mention.role) &&
        modelIdentifierTokens(mention.name).length > 0 && !textMatchesTargetName(input.userMessage, mention.name);
      if (historicalReference && !historicalTargets.some((target) =>
        target.messageId === mention.sourceMessageId &&
        compactModelText(target.name) === compactModelText(mention.name) &&
        (!target.productClass || typedProductClassKey(target.productClass, target.productClass) ===
          typedProductClassKey(mention.productClass, mention.productClass))
      )) {
        issues.push(`product_mention_history_reference_unverified:${index}`);
      }
    }
  }

  const openedNeeds = input.events.filter((event) =>
    event.eventType === 'need.opened' && event.payload.activate === true
  );
  if (openedNeeds.length) {
    if (policy?.needAction !== 'open' && policy?.needAction !== 'switch') {
      issues.push(`opened_need_action_mismatch:${policy?.needAction ?? 'missing'}`);
    }
    const policyClass = coerceVisibleCardIntent(policy?.canonicalProductClass);
    for (const event of openedNeeds) {
      const openedClass = coerceVisibleCardIntent(event.payload.productClass);
      if (policyClass !== 'unknown' && openedClass !== policyClass) {
        issues.push(`opened_need_product_class_mismatch:${openedClass}:${policyClass}`);
      }
    }
    const hasExactTarget = (intent.productMentions ?? []).some((mention) =>
      exactTargetProductMentionRoles.has(mention.role)
    );
    if (policy?.selectionGoal === 'final_fit' && !hasExactTarget && policy.reusePreviousCards !== true) {
      issues.push('new_need_final_fit_without_exact_target');
    }
  }

  const buyerRequestedHandoff = hasVerifiedBuyerRequestedTechnicalHandoff({
    intent, history: input.history ?? [], userMessage: input.userMessage ?? ''
  });
  if (intent.buyerRequestedTechnicalHandoff && !buyerRequestedHandoff) {
    issues.push('buyer_requested_technical_handoff_unverified');
  }
  const requiredRequests = intent.toolRequests.filter((request) => request.required);
  const policyProductClass = coerceVisibleCardIntent(policy?.canonicalProductClass);
  const policyProductClassKey = typedProductClassKey(
    policy?.canonicalProductClass,
    policy?.targetProductClass
  );
  const explicitlyTargetedProductClassKeys = new Set((intent.productMentions ?? [])
    .filter((mention) => exactTargetProductMentionRoles.has(mention.role))
    .map((mention) => typedProductClassKey(mention.productClass, mention.productClass))
    .filter((productClass): productClass is string => productClass !== null));
  if (policy) {
    for (const blocker of strictSelectionRequirementShapeBlockers(intent, policyProductClass)) {
      issues.push(`strict_requirement_shape_invalid:${blocker.id}:${blocker.reason}`);
    }
  }
  for (const requiredTool of grounding?.requiredToolKinds ?? []) {
    if (!requiredRequests.some((request) => request.tool === requiredTool)) {
      issues.push(`required_tool_request_missing:${requiredTool}`);
    }
  }
  const catalogRequests = requiredRequests.filter((request) =>
    request.tool === 'catalog.search' || request.tool === 'catalog.getProductDetails'
  );
  const webRequests = requiredRequests.filter((request) => request.tool === 'web.researchProductFacts');
  const catalogRequired = agentIntentRequiresCatalogEvidence(intent);
  if (catalogRequired && !catalogRequests.length && policy?.reusePreviousCards !== true) {
    issues.push('required_catalog_tool_missing');
  }
  if (
    catalogRequired &&
    policyProductClassKey !== null &&
    !catalogRequests.some((request) =>
      typedProductClassKey(request.args.canonicalProductIntent, request.args.productIntent) === policyProductClassKey
    ) &&
    policy?.reusePreviousCards !== true
  ) {
    issues.push(`required_primary_catalog_tool_missing:${policyProductClassKey}`);
  }
  const webRequired = grounding?.sourcePolicy === 'web_required' ||
    grounding?.webRequirement === 'buyer_requested' ||
    grounding?.webRequirement === 'conditional_on_catalog_gap' ||
    grounding?.webRequirement === 'independent_required';
  if (webRequired && !webRequests.length) issues.push('required_web_tool_missing');
  if (
    grounding?.sourcePolicy === 'specialist_required' &&
    (grounding.taskType === 'technical_answer' || grounding.taskType === 'product_selection' || grounding.taskType === 'comparison') &&
    input.provenExhaustedHandoffContinuation !== true && !buyerRequestedHandoff
  ) {
    issues.push('search_required_before_specialist');
  }
  if (
    requiredRequests.some((request) => request.tool === 'lead.capture') &&
    intentRequiresSearchBeforeSpecialist(intent) &&
    input.provenExhaustedHandoffContinuation !== true && !buyerRequestedHandoff
  ) {
    issues.push('search_required_before_specialist');
  }

  for (const request of intent.toolRequests) {
    if (request.tool === 'catalog.search' || request.tool === 'catalog.getProductDetails') {
      const requestClassKey = typedProductClassKey(
        request.args.canonicalProductIntent,
        request.args.productIntent
      );
      if (requestClassKey === null) issues.push(`catalog_tool_canonical_product_class_missing:${request.id}`);
      if (
        policyProductClassKey !== null &&
        requestClassKey !== null &&
        requestClassKey !== policyProductClassKey &&
        !explicitlyTargetedProductClassKeys.has(requestClassKey)
      ) {
        issues.push(`catalog_tool_product_class_mismatch:${request.id}:${requestClassKey}:${policyProductClassKey}`);
      }
      if (request.tool === 'catalog.search' && !request.args.query?.trim()) {
        issues.push(`catalog_search_query_missing:${request.id}`);
      }
      if (
        request.tool === 'catalog.getProductDetails' &&
        !request.args.query?.trim() &&
        !(request.args.productIds?.length) &&
        !(request.args.productNames?.length)
      ) {
        issues.push(`catalog_details_target_missing:${request.id}`);
      }
    }
    issues.push(...generatorLoadSemanticFieldIssues(request));
    if (request.tool === 'web.researchProductFacts') {
      const names = requestStringArray(request.args.productNames);
      if (policy?.alternativePolicy === 'exact_only' &&
        (grounding?.taskType === 'technical_answer' || grounding?.taskType === 'comparison') &&
        (historicalTargets.length > 0 || (intent.productMentions ?? []).some((mention) =>
          exactTargetProductMentionRoles.has(mention.role))) &&
        (!names.length || !(intent.productMentions ?? []).some((mention) => exactTargetProductMentionRoles.has(mention.role)))) {
        issues.push(`exact_product_research_target_missing:${request.id}`);
      }
      const requestClassKey = typedProductClassKey(
        request.args.canonicalProductIntent,
        request.args.productIntent
      );
      if (
        requestClassKey === null &&
        (names.length > 0 || catalogRequests.length > 0 ||
          grounding?.taskType === 'product_selection' || grounding?.taskType === 'comparison')
      ) {
        issues.push(`web_research_product_class_missing:${request.id}`);
      }
      if (!request.args.query?.trim() && !names.length) {
        issues.push(`web_research_query_or_targets_missing:${request.id}`);
      }
      if (
        requestClassKey !== null &&
        requestClassKey !== policyProductClassKey &&
        !explicitlyTargetedProductClassKeys.has(requestClassKey)
      ) {
        issues.push(`web_research_product_class_not_authorized:${request.id}:${requestClassKey}`);
      }
      // Match execution's typed-role suppression before checking every actual target.
      // Context devices are not research targets even if accidentally listed in args.
      const executableTargetNames = names.filter(name => productNameAllowedAsExactTarget({ intent, productName: name }));
      if (executableTargetNames.length && !webResearchTargetsCurrentIntent(executableTargetNames, intent)) {
        issues.push(`web_research_target_not_authorized_by_product_mentions:${request.id}`);
      }
      if (
        names.filter((name) => productNameAllowedAsExactTarget({ intent, productName: name }))
          .some((name) => !(intent.productMentions ?? []).some((mention) =>
          exactTargetProductMentionRoles.has(mention.role) &&
          productMentionMatchesName(mention.name, name) &&
          typedProductClassKey(mention.productClass, mention.productClass) === requestClassKey
          ))
      ) {
        issues.push(`web_research_target_product_class_mismatch:${request.id}`);
      }
    }
  }

  const requestsById = new Map(intent.toolRequests.map((request) => [request.id, request]));
  const historicalToolResultsById = new Map(
    (input.historicalToolResults ?? []).map((result) => [result.requestId, result])
  );
  const requirementsById = new Map((policy?.requirements ?? []).map((requirement) => [requirement.id, requirement]));
  for (const requirement of policy?.requirements ?? []) {
    const verification = requirement.verification;
    if (verification?.mode !== 'typed_tool') continue;
    const request = requestsById.get(verification.toolRequestId);
    const historicalResult = historicalToolResultsById.get(verification.toolRequestId);
    const currentRequestMatches = Boolean(request?.required && request.tool === verification.tool);
    const historicalResultMatches = Boolean(
      historicalResult?.status === 'ok' && historicalResult.tool === verification.tool
    );
    if (!currentRequestMatches && !historicalResultMatches) {
      issues.push(`typed_requirement_tool_mismatch:${requirement.id}`);
      continue;
    }
    if (request && !(request.coversRequirementIds ?? []).includes(requirement.id)) {
      issues.push(`typed_requirement_coverage_missing:${requirement.id}:${request.id}`);
    }
  }
  for (const request of intent.toolRequests) {
    for (const requirementId of request.coversRequirementIds ?? []) {
      if (!requirementsById.has(requirementId)) {
        issues.push(`tool_covers_unknown_requirement:${request.id}:${requirementId}`);
      }
    }
  }
  return uniqueStrings(issues);
}



/**
 * Buyer refined a ledger load device by naming its model ("насосная станция" →
 * "Aquario AJC-101"): same kind, new name grounded in the current message.
 * Returns the renamed actual load or null. Identity stays kind-based so a
 * grounded rename never reads as a dropped load.
 */
export function findGroundedLoadRename(input: {
  expectedLoad: unknown;
  actualLoads: unknown[];
  userMessage: string;
}): Record<string, unknown> | null {
  if (!input.expectedLoad || typeof input.expectedLoad !== 'object' || Array.isArray(input.expectedLoad)) return null;
  const expected = input.expectedLoad as Record<string, unknown>;
  const expectedKind = typeof expected.kind === 'string' ? expected.kind.trim().toLowerCase() : '';
  if (!expectedKind) return null;
  const message = (input.userMessage ?? '').toLowerCase();
  for (const actual of input.actualLoads ?? []) {
    if (!actual || typeof actual !== 'object' || Array.isArray(actual)) continue;
    const candidate = actual as Record<string, unknown>;
    if (typeof candidate.kind !== 'string' || candidate.kind.trim().toLowerCase() !== expectedKind) continue;
    if (semanticLoadIdentity(candidate) === semanticLoadIdentity(expected)) continue;
    const name = typeof candidate.name === 'string' ? candidate.name.trim() : '';
    if (name && message.includes(name.toLowerCase())) return candidate;
  }
  return null;
}

export function validateAgentSemanticDecision(input: {
  decision: AgentSemanticDecision;
  previousLedgerState: ReducedDialogueLedgerState;
  sessionId: string;
  turnId: string;
  userMessage?: string;
  historicalToolResults?: ToolResult[];
  history?: Message[];
  provenExhaustedHandoffContinuation?: boolean;
}) {
  const events = normalizeLedgerStateDeltaEvents({
    sessionId: input.sessionId,
    turnId: input.turnId,
    delta: input.decision.ledgerDelta
  });
  const ledgerState = reduceDialogueLedger(events, input.previousLedgerState);
  const issues: string[] = [];
  issues.push(...semanticAuthorityIssues({
    decision: input.decision,
    events,
    userMessage: input.userMessage,
    historicalToolResults: input.historicalToolResults,
    history: input.history,
    provenExhaustedHandoffContinuation: input.provenExhaustedHandoffContinuation
  }));
  const activeNeed = getActiveDialogueNeed(ledgerState);
  const policy = input.decision.intent.selectionPolicy;
  const ledgerClass = coerceVisibleCardIntent(activeNeed?.productClass);
  const intentClass = coerceVisibleCardIntent(policy?.canonicalProductClass ?? policy?.targetProductClass);
  if (ledgerClass !== 'unknown' && intentClass !== 'unknown' && ledgerClass !== intentClass) {
    issues.push(`active_product_class_mismatch:${ledgerClass}:${intentClass}`);
  }

  const turnFactEventIds = new Set(events
    .filter((event) => event.eventType === 'fact.observed' || event.eventType === 'fact.confirmed')
    .map((event) => event.eventId));
  const activeFacts = [
    ...activeScopedLedgerFacts(ledgerState),
    ...Object.values(ledgerState.factsByKey).filter((fact) =>
      fact.status === 'active' && fact.scope === 'need' && !fact.needId && turnFactEventIds.has(fact.eventId)
    )
  ];
  const executableRankingObjectives = new Set(structuredSelectionRankingObjectives(input.decision.intent));
  for (const objective of policy?.rankingObjectives ?? []) {
    if (!executableRankingObjectives.has(objective)) {
      issues.push(`ranking_objective_not_executable:${objective.requirementId}`);
      continue;
    }
    const requirement = policy!.requirements.find((item) => item.id === objective.requirementId)!;
    if (!activeFacts.some((fact) => fact.role === 'preference' && fact.eventType === 'fact.confirmed' &&
      fact.scope !== 'product' && !fact.productId &&
      fact.factKey.replaceAll('.', '_') === requirement.kind && fact.relation === 'preferred' &&
      fact.ranking?.attribute === objective.attribute && fact.ranking.direction === objective.direction &&
      semanticRequirementValuesMatch(requirement.kind, requirement.value, fact.value, requirement.unit, fact.unit))) {
      issues.push(`ranking_preference_memory_missing:${requirement.kind}`);
    }
  }
  const calculatorRequest = input.decision.intent.toolRequests.find((item) =>
    item.tool === 'calculator.generatorLoad'
  );
  const generatorScenarioFact = [...activeFacts]
    .reverse()
    .find((fact) => fact.role === 'hard_requirement' && fact.factKey === 'generator_load_scenario');
  if (calculatorRequest && !generatorScenarioFact) {
    issues.push('generator_load_scenario_fact_missing');
  }
  if (calculatorRequest && generatorScenarioFact) {
    const requirements = (policy?.requirements ?? []).filter((requirement) =>
      requirement.kind === generatorScenarioFact.factKey &&
      requirement.role === 'hard_constraint' &&
      requirement.strictness === 'strict'
    );
    const requirement = requirements.find((item) => item.verification?.mode === 'typed_tool');
    const verification = requirement?.verification;
    if (!requirement || verification?.mode !== 'typed_tool') {
      issues.push('active_requirement_mismatch:generator_load_scenario');
    } else if (verification.toolRequestId !== calculatorRequest.id) {
      issues.push('generator_load_scenario_missing_calculator');
    } else {
      const value = generatorScenarioFact.value &&
        typeof generatorScenarioFact.value === 'object' &&
        !Array.isArray(generatorScenarioFact.value)
        ? generatorScenarioFact.value as Record<string, unknown>
        : {};
      const expectedLoads = Array.isArray(value.loads) ? value.loads : [];
      const calculatorArgs = calculatorRequest.args as ToolRequest['args'] & {
        loads?: unknown[];
        simultaneousRunning?: boolean | null;
        simultaneousStarting?: boolean | null;
      };
      const actualLoadIds = new Set((calculatorArgs.loads ?? []).map(semanticLoadIdentity).filter(Boolean));
      const executableLoadIds = new Set(
        buildGeneratorLoadToolPayload({ request: calculatorRequest, userMessage: input.userMessage ?? '' })
          .loads
          .map(semanticLoadIdentity)
          .filter(Boolean)
      );
      for (const load of expectedLoads) {
        const identity = semanticLoadIdentity(load);
        const executableIdentity = executableSemanticLoadIdentity(load);
        const directActualLoad = (calculatorArgs.loads ?? []).find((candidate) =>
          semanticLoadIdentity(candidate) === identity
        );
        let actualLoad = directActualLoad;
        let renamedActual: Record<string, unknown> | null = null;
        if (identity && !actualLoadIds.has(identity)) {
          renamedActual = findGroundedLoadRename({
            expectedLoad: load,
            actualLoads: calculatorArgs.loads ?? [],
            userMessage: input.userMessage ?? ''
          });
          if (!renamedActual) {
            issues.push(`generator_load_scenario_missing_load:${identity}`);
          } else {
            actualLoad = renamedActual;
          }
        }
        if (identity && semanticLoadDeclaresPower(load)) {
          const effectiveExecutableIdentity = renamedActual
            ? executableSemanticLoadIdentity(renamedActual)
            : executableIdentity;
          if (!effectiveExecutableIdentity || !executableLoadIds.has(effectiveExecutableIdentity)) {
            issues.push(`generator_load_scenario_unexecutable_load:${identity}`);
          }
        }
        const expectedFields = semanticLoadExecutionFields(load);
        const actualFields = semanticLoadExecutionFields(actualLoad);
        if (renamedActual && expectedFields && actualFields) {
          // Buyer-refined device name is grounded new evidence, not a changed
          // load: kind and numbers must stay, the name may follow the message.
          actualFields.name = expectedFields.name;
        }
        if (identity && JSON.stringify(expectedFields) !== JSON.stringify(actualFields)) {
          const mismatchedFields = expectedFields && actualFields
            ? Object.entries(expectedFields)
                .filter(([key, value]) => JSON.stringify(value) !== JSON.stringify(
                  actualFields[key as keyof typeof actualFields]
                ))
                .map(([key]) => key)
            : ['load'];
          issues.push(`generator_load_scenario_load_semantics_mismatch:${identity}:${mismatchedFields.join('|')}`);
        }
      }
      if (
        typeof value.simultaneousRunning === 'boolean' &&
        calculatorArgs.simultaneousRunning !== value.simultaneousRunning
      ) issues.push('generator_load_scenario_simultaneous_running_mismatch');
      if (
        typeof value.simultaneousStarting === 'boolean' &&
        calculatorArgs.simultaneousStarting !== value.simultaneousStarting
      ) issues.push('generator_load_scenario_simultaneous_starting_mismatch');
    }
  }
  const selectsProductsThisTurn = input.decision.intent.grounding?.taskType === 'product_selection' ||
    input.decision.intent.grounding?.responseMode === 'recommend';
  const usesCatalogEvidenceThisTurn = (input.decision.intent.toolRequests ?? []).some((request) =>
    request.tool === 'catalog.search' || request.tool === 'catalog.getProductDetails'
  ) || policy?.reusePreviousCards === true;
  // Scope comes from the ledger event, never from a whitelist of requirement
  // names. Reusing cards must preserve the same constraints as a fresh search.
  for (const fact of activeFacts) {
    if (selectsProductsThisTurn && fact.role === 'preference' && fact.eventType === 'fact.confirmed' &&
      fact.scope !== 'product' && !fact.productId && (fact.scope === 'need' || fact.scope === 'dialogue')) {
      const kind = fact.factKey.replaceAll('.', '_');
      const matchingPreferences = (policy?.requirements ?? []).filter((requirement) =>
        requirement.kind === kind && requirement.role === 'preference' && requirement.strictness === 'preferred' &&
        (requirement.relation ?? 'preferred') === (fact.relation ?? 'preferred') &&
        semanticRequirementValuesMatch(kind, requirement.value, fact.value, requirement.unit, fact.unit));
      if (!matchingPreferences.length) issues.push(`active_preference_mismatch:${kind}`);
      if (fact.ranking === undefined) {
        // Old facts did not distinguish numeric ranking from other preferences.
        // Only a new semantic fact delta may resolve that missing information.
        issues.push(`active_preference_ranking_unresolved:${kind}`);
      } else if (fact.ranking && ![...executableRankingObjectives].some((objective) =>
        matchingPreferences.some((requirement) => requirement.id === objective.requirementId) &&
        objective.attribute === fact.ranking!.attribute && objective.direction === fact.ranking!.direction)) {
        issues.push(`active_preference_ranking_mismatch:${kind}`);
      }
    }
    if (
      (!usesCatalogEvidenceThisTurn && !turnFactEventIds.has(fact.eventId)) ||
      fact.role !== 'hard_requirement' ||
      fact.eventType !== 'fact.confirmed' ||
      fact.scope === 'product' || fact.productId ||
      (fact.scope !== 'need' && fact.scope !== 'dialogue') ||
      fact.factKey === 'generator_load_scenario'
    ) continue;
    const kind = fact.factKey.replaceAll('.', '_');
    const relation = fact.relation ?? 'must_have';
    const requirements = (policy?.requirements ?? []).filter((requirement) =>
      requirement.kind === kind &&
      requirement.role === 'hard_constraint' &&
      requirement.strictness === 'strict' &&
      (requirement.relation ?? 'must_have') === relation &&
      (relation === 'must_have' || relation === 'must_not_have')
    );
    const matchingRequirement = requirements.some((requirement) =>
      semanticRequirementValuesMatch(kind, requirement.value, fact.value, requirement.unit, fact.unit)
    );
    const structuredFieldMatches = relation !== 'must_have' ? false : kind === 'phase'
      ? semanticRequirementValuesMatch(kind, policy?.phase, fact.value)
      : kind === 'power_source'
        ? semanticRequirementValuesMatch(kind, policy?.powerSource, fact.value)
        : false;
    if (!matchingRequirement && !structuredFieldMatches) {
      issues.push(`active_requirement_mismatch:${kind}`);
    }
  }
  return { issues: uniqueStrings(issues), events, ledgerState };
}











function reusableSideEffectArtifactsAfterReplan(
  intent: AgentIntentContract,
  persistedResults: Map<string, ToolResult>,
  userMessage: string,
  sessionId: string,
  turnId: string
) {
  const results = new Map<string, ToolResult>();
  const rebound: ToolResult[] = [];
  const authorization = intent.leadCaptureAuthorization;
  const evidence = authorization?.evidence?.trim() ?? '';
  const evidenceIsCurrent = Boolean(evidence && userMessage.includes(evidence));
  const evidenceContact = evidenceIsCurrent ? extractContact(evidence) : {};
  const authorizedForReuse = Boolean(
    authorization?.authorized &&
    authorization.contactSource !== 'none' &&
    authorization.purpose?.trim() &&
    evidenceIsCurrent &&
    (authorization.contactSource !== 'current_message' || evidenceContact.phone || evidenceContact.email)
  );
  if (!authorizedForReuse) return { results, rebound };
  const successfulLeads = [...persistedResults.values()].filter(isDurableLeadCaptureResult);
  if (!successfulLeads.length) return { results, rebound };
  for (const request of intent.toolRequests) {
    if (request.tool !== 'lead.capture') continue;
    const expectedFingerprint = leadCaptureActionFingerprint({
      sessionId,
      turnId,
      userMessage,
      authorization,
      request
    });
    const matchingLeads = expectedFingerprint
      ? successfulLeads.filter((result) => durableLeadActionFingerprint(result) === expectedFingerprint)
      : [];
    if (matchingLeads.length !== 1) {
      const blockedResult = blockedLeadReplayResult(request);
      results.set(request.id, blockedResult);
      if (!persistedResults.has(request.id)) rebound.push(blockedResult);
      continue;
    }
    const successfulLead = matchingLeads[0]!;
    const reboundResult = ToolResultSchema.parse({
      ...successfulLead,
      requestId: request.id
    });
    results.set(request.id, reboundResult);
    if (request.id !== successfulLead.requestId) rebound.push(reboundResult);
  }
  return { results, rebound };
}




function leadActionAfterValidation(input: {
  answer: AnswerContract;
  finalText: string;
  review: PreSendReview;
  toolResults: ToolResult[];
}): AnswerContract['leadAction'] {
  const reviewRequiresOfferForm = input.review.issues.some((issue) =>
    issue.code === 'lead_capture_missing_contact_offer_form' || issue.code === 'lead_capture_missing_name'
  );
  if (reviewRequiresOfferForm) return 'offer_form';
  if (input.review.issues.some((issue) => issue.code === 'premature_handoff_before_web_exhausted')) {
    return 'none';
  }
  return input.answer.leadAction;
}



















function isCatalogAvailabilityOnlyIntent(intent: AgentIntentContract) {
  return intent.grounding?.taskType === 'availability_or_delivery' &&
    intent.grounding.sourcePolicy !== 'web_required' &&
    intent.grounding.webRequirement !== 'buyer_requested' &&
    intent.grounding.webPurpose === 'none' &&
    intent.grounding.technicalAttributes.length === 0;
}

function groundingRequiresWebSearch(grounding: AgentIntentGrounding | undefined) {
  return grounding?.sourcePolicy === 'web_required' ||
    grounding?.requiredToolKinds.includes('web.researchProductFacts') === true;
}

function intentHasWebResearchRequest(intent: AgentIntentContract) {
  return intent.toolRequests.some((request) => request.tool === 'web.researchProductFacts');
}







class AnswerValidationBlockedError extends Error {
  readonly code = 'answer_contract_blocked_by_validation';

  constructor(readonly issueCodes: string[]) {
    super(`Agent manager answer blocked: ${issueCodes.join(', ')}`);
    this.name = 'AnswerValidationBlockedError';
  }
}

const TURN_COMMIT_RESERVE_MS = 5_000;
const SEMANTIC_DECISION_ATTEMPT_TIMEOUT_MS = 45_000;
const SEMANTIC_DECISION_DOWNSTREAM_RESERVE_MS = 45_000;


function parseSavedChatResponsePayload(value: unknown): ChatResponsePayload | null {
  if (value === null || value === undefined) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('invalid_saved_response_payload');
  }
  const payload = value as Record<string, unknown>;
  if (
    typeof payload.answer !== 'string' ||
    !payload.answer.trim() ||
    !payload.needState ||
    typeof payload.needState !== 'object' ||
    Array.isArray(payload.needState) ||
    !Array.isArray(payload.productCards) ||
    typeof payload.usedWebSearch !== 'boolean'
  ) {
    throw new Error('invalid_saved_response_payload');
  }
  if (payload.metadata !== undefined && (
    !payload.metadata ||
    typeof payload.metadata !== 'object' ||
    Array.isArray(payload.metadata)
  )) {
    throw new Error('invalid_saved_response_payload_metadata');
  }
  return payload as unknown as ChatResponsePayload;
}

type PersistedTurnCheckpoint = {
  checkpoint?: unknown;
  status?: unknown;
  payload?: unknown;
  error_code?: unknown;
  errorCode?: unknown;
  error_message?: unknown;
  errorMessage?: unknown;
};


function latestCheckpoint(rows: unknown[], checkpoint: string) {
  return [...rows].reverse().find((candidate) => {
    if (!candidate || typeof candidate !== 'object') return false;
    const item = candidate as PersistedTurnCheckpoint;
    return item.checkpoint === checkpoint;
  }) as PersistedTurnCheckpoint | undefined;
}

function succeededCheckpoint(rows: unknown[], checkpoint: string) {
  const row = latestCheckpoint(rows, checkpoint);
  if (row?.status !== 'succeeded') return { found: false as const, payload: undefined };
  return row ? { found: true, payload: row.payload } : { found: false, payload: undefined };
}

function semanticCheckpointError(error: unknown) {
  const details = safeError(error);
  const retryReason = typeof details.retryReason === 'string' ? details.retryReason : undefined;
  return {
    details,
    retryReason,
    errorCode: retryReason === 'output_limit_exhausted'
      ? 'structured_json_output_limit_exhausted'
      : (details.code ?? details.message ?? 'semantic_stage_failed')
  };
}

function semanticRecoveryOutputTokenCap(rows: unknown[], checkpoint: string) {
  const row = latestCheckpoint(rows, checkpoint);
  if (row?.status !== 'failed') return undefined;
  const errorCode = String(row.error_code ?? row.errorCode ?? '');
  const payload = row.payload && typeof row.payload === 'object'
    ? row.payload as { retryReason?: unknown }
    : undefined;
  if (
    errorCode !== 'structured_json_output_limit_exhausted' &&
    payload?.retryReason !== 'output_limit_exhausted'
  ) return undefined;
  return Math.ceil(config.OPENAI_PLANNER_MAX_OUTPUT_TOKENS * 1.5);
}

function parsePersistedToolArtifact(value: unknown): ToolResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('invalid_saved_tool_artifact');
  }
  const row = value as Record<string, unknown>;
  return validateToolResultOutput(ToolResultSchema.parse({
    requestId: row.tool_request_id ?? row.toolRequestId,
    tool: row.tool_name ?? row.toolName,
    status: row.status,
    payload: row.payload,
    warnings: row.warnings ?? [],
    ...((row.error_code ?? row.errorCode)
      ? { errorCode: String(row.error_code ?? row.errorCode) }
      : {})
  }));
}















export function sourcePolicyMetadataFromIntent(
  intent: AgentIntentContract,
  toolResults: ToolResult[] = []
): AgentSourcePolicyV2 {
  const grounding = intent.grounding;
  if (grounding?.sourcePolicy === 'web_required') {
    const webResults = toolResults.filter((result) => result.tool === 'web.researchProductFacts');
    const catalogEvidenceMadeAllWebUnnecessary = webResults.length > 0 && webResults.every((result) => {
      const payload = result.payload as { searchDisposition?: unknown; facts?: unknown };
      return result.status === 'ok' &&
        payload.searchDisposition === 'not_needed' &&
        (!Array.isArray(payload.facts) || payload.facts.length === 0);
    });
    if (catalogEvidenceMadeAllWebUnnecessary) {
      return {
        allowed: ['conversation_memory', 'catalog'],
        required: ['catalog'],
        forbidden: ['specialist'],
        webPurpose: 'none'
      };
    }
    return {
      allowed: ['conversation_memory', 'catalog', 'web'],
      required: ['web'],
      forbidden: ['specialist'],
      webPurpose: grounding.webPurpose === 'none' ? 'technical_specs' : grounding.webPurpose
    };
  }
  if (grounding?.sourcePolicy === 'specialist_required') {
    return {
      allowed: ['conversation_memory', 'catalog', 'specialist'],
      required: ['specialist'],
      forbidden: ['web'],
      webPurpose: 'none'
    };
  }
  if (grounding?.sourcePolicy === 'catalog_required') {
    return {
      allowed: ['conversation_memory', 'catalog'],
      required: ['catalog'],
      forbidden: ['specialist'],
      webPurpose: 'none'
    };
  }
  return {
    allowed: ['conversation_memory'],
    required: [],
    forbidden: ['specialist'],
    webPurpose: 'none'
  };
}

function agentManagerTaskTypeFromGrounding(intent: AgentIntentContract): AgentTaskType | undefined {
  const groundingTaskType = intent.grounding?.taskType;
  if (groundingTaskType === 'availability_or_delivery') return 'pure_delivery';
  if (intent.grounding?.sourcePolicy === 'specialist_required') return 'pure_delivery';
  if (intent.toolRequests.some((request) => request.tool === 'lead.capture')) return 'pure_delivery';
  if (
    groundingTaskType === 'technical_answer' ||
    groundingTaskType === 'product_selection' ||
    groundingTaskType === 'comparison'
  ) {
    return groundingTaskType;
  }
  if (intentHasWebResearchRequest(intent)) return 'technical_answer';
  return undefined;
}

function turnContractMetadataFromIntent(intent: AgentIntentContract, cards: ProductCard[]): AgentTurnContract {
  const taskType = agentManagerTaskTypeFromGrounding(intent);
  const qualifiesNeed = intent.grounding?.responseMode === 'clarify';
  const showSelectionCards = cards.length > 0 && taskType === 'product_selection' && !qualifiesNeed;
  const showSupportingCards = cards.length > 0 && !showSelectionCards;
  const answerTask = qualifiesNeed
    ? 'technical_explanation'
    : taskType === 'product_selection'
    ? 'product_selection'
    : taskType === 'comparison'
      ? 'comparison'
      : taskType === 'pure_delivery'
        ? 'lead_handoff'
        : 'technical_explanation';
  return {
    answerTask,
    taskType,
    catalogAction: intent.toolRequests.some((request) => request.tool === 'catalog.search')
      ? 'find_matching_products'
      : 'none',
    commercialAction: intent.toolRequests.some((request) => request.tool === 'lead.capture')
      ? 'explain_manager_required'
      : 'none',
    productCardsPolicy: showSelectionCards ? 'show_matching_products' : showSupportingCards ? 'supporting_only' : 'none',
    mustAnswerNow: [intent.userMessageSummary],
    activeNeeds: [],
    currentFocus: intent.grounding?.taskType ?? 'agent_manager_turn',
    cardsRole: showSelectionCards ? 'primary' : showSupportingCards ? 'supporting' : 'none',
    leadAllowed: intent.toolRequests.some((request) => request.tool === 'lead.capture'),
    leadAllowedReason: intent.toolRequests.some((request) => request.tool === 'lead.capture')
      ? 'Agent manager intent planned lead capture.'
      : 'No lead capture planned for this turn.',
    errorRecoveryPriority: intent.nextStepRationale,
    validatorWarnings: ['agent_manager_grounding_contract']
  };
}



function structuredCandidateTierEvidence(toolResults: ToolResult[]) {
  return toolResults.flatMap((result) => {
    if (result.tool !== 'catalog.search') return [];
    const tiers = (result.payload as {
      retrieval?: { candidateTiers?: Array<{ productId?: unknown; tier?: unknown; tradeoffs?: unknown }> };
    }).retrieval?.candidateTiers ?? [];
    return tiers.flatMap((candidate) =>
      typeof candidate.productId === 'string' &&
      (candidate.tier === 'exact_match' || candidate.tier === 'preliminary_match' || candidate.tier === 'rejected')
        ? [{
            productId: candidate.productId,
            tier: candidate.tier,
            tradeoffs: Array.isArray(candidate.tradeoffs)
              ? candidate.tradeoffs.filter((item): item is string => typeof item === 'string')
              : []
          }]
        : []
    );
  });
}




function selectionRequirementNumericValue(requirement: SelectionRequirement) {
  const value = typeof requirement.value === 'number'
    ? requirement.value
    : typeof requirement.value === 'string'
      ? Number(requirement.value)
      : Number.NaN;
  return Number.isFinite(value) ? value : undefined;
}

function structuredSelectionRejectionReasons(
  product: Product,
  intent: AgentIntentContract,
  toolResults: ToolResult[] = []
): AnswerProductRejectionReason[] {
  const proofs = toolResults.length
    ? buildRequirementProofs({ intent, products: [product], toolResults })
    : [];
  return (intent.selectionPolicy?.requirements ?? []).flatMap((requirement) => {
    if (
      requirement.role !== 'hard_constraint' ||
      requirement.strictness !== 'strict'
    ) return [];
    // Price visibility is a presence check, not a numeric threshold. The
    // generic proof normalizer represents the requirement as `true` while a
    // catalog candidate carries a numeric price, so treating that comparison
    // as a violated hard constraint would resurrect stale cards as
    // comparison-only evidence. Only emit rejection evidence for actual
    // constraint failures.
    if (requirement.kind === 'price_visibility') return [];
    const requiredValue = selectionRequirementNumericValue(requirement);
    const directPriceViolation =
      (requirement.kind === 'budget_max_rub' || requirement.kind === 'price_max_rub') &&
      requiredValue !== undefined &&
      typeof product.price === 'number' &&
      Number.isFinite(product.price) &&
      product.price > requiredValue;
    const proof = proofs.find((candidate) =>
      candidate.requirementId === requirement.id &&
      candidate.eligibilityStatus === 'violated' &&
      candidate.sourceResultIds.length > 0
    );
    if (!directPriceViolation && !proof) return [];
    return [{
      source: 'structured_selection_requirement' as const,
      requirementId: requirement.id,
      kind: requirement.kind,
      requiredValue: proof?.normalizedRequirementValue ?? requiredValue ?? null,
      actualValue: proof?.normalizedValue ?? product.price ?? null,
      unit: proof?.normalizedUnit ?? requirement.unit,
      evidence: requirement.evidence,
      ...(proof ? {
        sourceResultIds: proof.sourceResultIds,
        sourceAuthority: proof.sourceAuthority
      } : {})
    }];
  });
}

function answerProductEvidenceWithComparisonReferences(input: {
  intent: AgentIntentContract;
  rawProducts: Product[];
  recommendationProducts: Product[];
  explicitComparisonReferents: Product[];
  toolResults?: ToolResult[];
}) {
  const rawById = new Map(input.rawProducts.map((product) => [product.id, product]));
  const recommendationIds = new Set(input.recommendationProducts.map((product) => product.id));
  const comparisonNames = uniqueStrings((input.intent.productMentions ?? [])
    .filter((mention) => mention.role === 'comparison_subject')
    .map((mention) => mention.name));
  const comparisonProducts = [...new Map([
    ...input.explicitComparisonReferents.map((product) => rawById.get(product.id) ?? product),
    ...input.rawProducts.filter((product) => comparisonNames.some((name) =>
      productNameContainsExactComparisonMention(product.name, name)
    ))
  ].filter((product) =>
    !recommendationIds.has(product.id) &&
    structuredSelectionRejectionReasons(product, input.intent, input.toolResults).length > 0
  ).map((product) => [product.id, product])).values()];
  const products = [...new Map(
    [...input.recommendationProducts, ...comparisonProducts].map((product) => [product.id, product])
  ).values()];
  const comparisonIds = new Set(comparisonProducts.map((product) => product.id));
  const productEvidenceRoles: AnswerProductEvidenceRole[] = products.map((product) => {
    const eligibleForRecommendation = recommendationIds.has(product.id);
    return {
      productId: product.id,
      role: eligibleForRecommendation || !comparisonIds.has(product.id)
        ? 'recommendation_candidate'
        : 'comparison_reference_only',
      eligibleForRecommendation,
      rejectionReasons: eligibleForRecommendation
        ? []
        : structuredSelectionRejectionReasons(product, input.intent, input.toolResults)
    };
  });
  return { products, productEvidenceRoles };
}

function requiredResponseClausesForRejectedComparisonReferences(input: {
  products: Product[];
  productEvidenceRoles: AnswerProductEvidenceRole[];
}): RequiredResponseClause[] {
  const productsById = new Map(input.products.map((product) => [product.id, product]));
  const rejected = input.productEvidenceRoles.flatMap((role) => {
    if (role.role !== 'comparison_reference_only' || !role.rejectionReasons.length) return [];
    const product = productsById.get(role.productId);
    return product ? [{
      id: product.id,
      name: product.name,
      price: product.price ?? null,
      rejectionReasons: role.rejectionReasons
    }] : [];
  });
  if (!rejected.length) return [];
  return [{
    code: 'comparison_reference_rejected_by_hard_constraint',
    sourceRequestId: 'structured_selection_policy',
    instruction: `Compare these exact products using their factual evidence, but explicitly state that each is rejected by the grounded hard constraint and must not be selected, recommended as fitting, or emitted as a card: ${JSON.stringify(rejected)}`,
    catalogProductNames: rejected.map((item) => item.name)
  }];
}


export function reconcileParallelIntentNeedAction(
  delta: LedgerStateDelta,
  intent: AgentIntentContract
) {
  if (intent.selectionPolicy?.needAction !== 'continue') {
    return { intent, repairedNeedId: undefined as string | undefined };
  }
  const activeOpenedNeeds = delta.events.filter((event) =>
    event.eventType === 'need.opened' &&
    event.payload.activate === true &&
    typeof event.payload.needId === 'string' &&
    event.payload.needId.trim().length > 0
  );
  if (activeOpenedNeeds.length !== 1) {
    return { intent, repairedNeedId: undefined as string | undefined };
  }
  const openedNeed = activeOpenedNeeds[0]!;
  const openedClass = coerceVisibleCardIntent(openedNeed.payload.productClass);
  const intentClass = coerceVisibleCardIntent(
    intent.selectionPolicy.canonicalProductClass ?? intent.selectionPolicy.targetProductClass
  );
  if (openedClass === 'unknown' || intentClass === 'unknown' || openedClass !== intentClass) {
    return { intent, repairedNeedId: undefined as string | undefined };
  }
  return {
    intent: {
      ...intent,
      selectionPolicy: {
        ...intent.selectionPolicy,
        needAction: 'open' as const
      },
      riskFlags: uniqueStrings([
        ...intent.riskFlags,
        'parallel_need_action_reconciled_from_reducer'
      ])
    },
    repairedNeedId: String(openedNeed.payload.needId)
  };
}





function nonTargetMentionModelTokens(intent: AgentIntentContract) {
  return new Set((intent.productMentions ?? [])
    .filter((mention) => !exactTargetProductMentionRoles.has(mention.role))
    .flatMap((mention) => modelIdentifierTokens(mention.name)));
}



function productFromVisibleCard(card: ProductCard): Product {
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
    retrievalSource: 'unknown'
  };
}

function visibleCardProducts(message: Message) {
  if (message.role !== 'assistant') return [] as Product[];
  const metadata = message.metadata as { productCards?: unknown } | undefined;
  if (!Array.isArray(metadata?.productCards)) return [] as Product[];
  return metadata.productCards
    .filter((card): card is ProductCard =>
      Boolean(
        card &&
        typeof card === 'object' &&
        typeof (card as { id?: unknown }).id === 'string' &&
        typeof (card as { name?: unknown }).name === 'string'
      )
    )
    .map(productFromVisibleCard);
}


function previousVisibleCardProducts(input: {
  history: Message[];
  allowedProductIds?: Set<string>;
}) {
  const productsById = new Map<string, Product>();
  for (let index = input.history.length - 1; index >= 0; index -= 1) {
    const products = visibleCardProducts(input.history[index]!)
      .filter((product) => !input.allowedProductIds || input.allowedProductIds.has(product.id));
    for (const product of products) {
      if (!productsById.has(product.id)) productsById.set(product.id, product);
    }
    if (productsById.size >= 8) break;
  }
  return [...productsById.values()].slice(0, 8);
}

function previousProductReferents(input: {
  history: Message[];
  intent: AgentIntentContract;
  selectedProductIds: Set<string>;
}) {
  if (
    input.intent.selectionPolicy?.reusePreviousCards !== true ||
    (
      input.intent.grounding?.taskType !== 'comparison' &&
      input.intent.grounding?.taskType !== 'product_selection'
    )
  ) return [] as Product[];

  const visibleProducts = previousVisibleCardProducts({
    history: input.history
  });
  const maxReferents = Math.max(1, Math.min(8, input.intent.selectionPolicy.maxCards || 8));
  const selectedReferents = visibleProducts.filter((product) => input.selectedProductIds.has(product.id));
  if (selectedReferents.length) return selectedReferents.slice(0, maxReferents);

  const mentionedNames = uniqueStrings((input.intent.productMentions ?? [])
    .filter((mention) => exactTargetProductMentionRoles.has(mention.role))
    .map((mention) => mention.name));
  const mentionedReferents = visibleProducts.filter((product) =>
    mentionedNames.some((name) => productMatchesTargetName(product, name))
  );
  if (mentionedReferents.length) return mentionedReferents.slice(0, maxReferents);
  return [] as Product[];
}

function previousExplicitComparisonSubjectProducts(input: {
  history: Message[];
  intent: AgentIntentContract;
}) {
  if (
    input.intent.selectionPolicy?.reusePreviousCards !== true ||
    input.intent.grounding?.taskType !== 'comparison'
  ) return [] as Product[];
  const comparisonNames = uniqueStrings((input.intent.productMentions ?? [])
    .filter((mention) => mention.role === 'comparison_subject')
    .map((mention) => mention.name));
  if (!comparisonNames.length) return [] as Product[];
  const visibleProducts = previousVisibleCardProducts({
    history: input.history
  });
  return visibleProducts.filter((product) =>
    comparisonNames.some((name) => productNameContainsExactComparisonMention(product.name, name))
  );
}

const reusableSelectionEvidenceTools = new Set<ToolResult['tool']>([
  'catalog.search',
  'catalog.getProductDetails',
  'calculator.generatorLoad'
]);

function calculatorRequirementSignature(intent: AgentIntentContract) {
  return (intent.selectionPolicy?.requirements ?? [])
    .filter((requirement) =>
      requirement.verification?.mode === 'typed_tool' &&
      requirement.verification.tool === 'calculator.generatorLoad' &&
      requirement.verification.verifier === 'generator_load_profile'
    )
    .map((requirement) => JSON.stringify({
      kind: requirement.kind,
      value: requirement.value,
      unit: requirement.unit,
      evidence: compactModelText(requirement.evidence)
    }))
    .sort();
}

function calculatorEvidenceCompatibleWithCurrentIntent(
  currentIntent: AgentIntentContract,
  previousIntent: AgentIntentContract
) {
  const currentSignature = calculatorRequirementSignature(currentIntent);
  const previousSignature = calculatorRequirementSignature(previousIntent);
  return currentSignature.length > 0 &&
    currentSignature.length === previousSignature.length &&
    currentSignature.every((item, index) => item === previousSignature[index]);
}

function previousSelectionToolResults(input: {
  history: Message[];
  intent: AgentIntentContract;
}) {
  const policy = input.intent.selectionPolicy;
  if (!policy?.reusePreviousCards) return [] as ToolResult[];
  if (
    input.intent.grounding?.taskType !== 'comparison' &&
    input.intent.grounding?.taskType !== 'product_selection'
  ) return [] as ToolResult[];

  const currentClass = canonicalProductClassFromIntent(input.intent);
  if (currentClass === 'unknown') return [] as ToolResult[];
  const resultsByKey = new Map<string, ToolResult>();
  for (const message of input.history) {
    if (message.role !== 'assistant') continue;
    const metadata = message.metadata as {
      intentContract?: unknown;
      effectiveIntentContract?: unknown;
      toolResults?: unknown;
    };
    const previousIntent = AgentIntentContractSchema.safeParse(
      metadata.effectiveIntentContract ?? metadata.intentContract
    );
    if (!previousIntent.success) continue;
    if (canonicalProductClassFromIntent(previousIntent.data) !== currentClass) continue;
    if (!Array.isArray(metadata.toolResults)) continue;
    for (const rawResult of metadata.toolResults) {
      const parsed = ToolResultSchema.safeParse(rawResult);
      if (!parsed.success || parsed.data.status !== 'ok') continue;
      if (!reusableSelectionEvidenceTools.has(parsed.data.tool)) continue;
      if (
        parsed.data.tool === 'calculator.generatorLoad' &&
        (
          !isGeneratorProductClass(currentClass) ||
          !calculatorEvidenceCompatibleWithCurrentIntent(input.intent, previousIntent.data)
        )
      ) continue;
      if (parsed.data.tool === 'catalog.search' || parsed.data.tool === 'catalog.getProductDetails') {
        const products = (parsed.data.payload as { products?: unknown }).products;
        if (!Array.isArray(products)) continue;
      }
      resultsByKey.set(`${parsed.data.tool}:${parsed.data.requestId}`, parsed.data);
    }
  }
  return [...resultsByKey.values()].slice(-16);
}

function mergeSelectionToolResults(historical: ToolResult[], current: ToolResult[]) {
  const resultsByKey = new Map<string, ToolResult>();
  for (const result of [...historical, ...current]) {
    resultsByKey.set(`${result.tool}:${result.requestId}`, result);
  }
  return [...resultsByKey.values()];
}

function currentNeedSelectedProductIds(needState: CustomerNeedState) {
  const currentNeed = [...(needState.activeNeeds ?? [])].reverse().find((need) =>
    need.status === 'open' || need.status === 'selected'
  );
  return new Set(currentNeed?.selectedProductIds ?? []);
}

function continuityProductClassFromCurrentTurn(input: {
  intent: AgentIntentContract;
}) {
  const policyIntent = coerceVisibleCardIntent(input.intent.selectionPolicy?.canonicalProductClass);
  if (policyIntent !== 'unknown') return policyIntent;
  const targetMention = (input.intent.productMentions ?? []).find((mention) =>
    exactTargetProductMentionRoles.has(mention.role)
  );
  const mentionIntent = coerceVisibleCardIntent(targetMention?.productClass);
  if (mentionIntent !== 'unknown') return mentionIntent;

  return 'unknown';
}








function generatorLoadProfileNumbers(result: ToolResult) {
  const profile = (result.payload as {
    profile?: {
      requiredNominalKw?: unknown;
      requiredStartingKw?: unknown;
      confidence?: unknown;
    };
  }).profile;
  const requiredNominalKw = Number(profile?.requiredNominalKw);
  const requiredStartingKw = Number(profile?.requiredStartingKw);
  const confidence = Number(profile?.confidence);
  return {
    requiredNominalKw: Number.isFinite(requiredNominalKw) && requiredNominalKw > 0 ? requiredNominalKw : undefined,
    requiredStartingKw: Number.isFinite(requiredStartingKw) && requiredStartingKw > 0 ? requiredStartingKw : undefined,
    confidence: Number.isFinite(confidence) && confidence >= 0 ? confidence : undefined
  };
}

export function requiredResponseClausesForToolResults(
  toolResults: ToolResult[],
  intent?: AgentIntentContract
): RequiredResponseClause[] {
  const clauses: RequiredResponseClause[] = [];
  const plannedRequestIds = intent
    ? new Set(intent.toolRequests.map((request) => request.id))
    : null;
  for (const result of toolResults) {
    if (plannedRequestIds && !plannedRequestIds.has(result.requestId)) continue;
    if (
      result.tool === 'calculator.generatorLoad' &&
      result.status === 'ok' &&
      hasUnconfirmedGeneratorLoadBasisResult([result])
    ) {
      const profile = generatorLoadProfileNumbers(result);
      const profileInstruction = profile.requiredNominalKw !== undefined
        ? `Do not ignore payload.profile.requiredNominalKw=${profile.requiredNominalKw}: either use it as a rough or partial orientation with an explicit caveat about the missing load basis, or explain that it covers only the counted loads and is not enough for final generator selection.`
        : 'Do not invent a kW number when payload.profile.requiredNominalKw is absent.';
      clauses.push({
        code: 'generator_unconfirmed_load_stage_aware_selection',
        sourceRequestId: result.requestId,
        instruction: `This generator load calculation has an unconfirmed or incomplete load basis. ${profileInstruction} Do not present the number as a confirmed recommendation, confirmed minimum, or purchase-safe final selection. Product cards and prices may still be shown for browse_catalog, or for a clearly labelled preliminary_fit when the available basis supports it. Name the missing load power/model/type and ask for the smallest fact needed before final_fit. If payload.profile.missingStartingLoads is nonempty, totalRunningKw and runningOnlyNominalFloorKw describe running loads only, never a sufficient generator minimum or startup capacity. Preserve that distinction; use a justified explicit startup estimate for preliminary selection or obtain the missing startup data before final suitability.`
      });
    }
    if (
      result.tool === 'calculator.generatorLoad' &&
      result.status === 'ok' &&
      (result.payload as { estimateBasis?: unknown }).estimateBasis === 'bounded_assumption'
    ) {
      const profile = generatorLoadProfileNumbers(result);
      const profileInstruction = profile.requiredNominalKw !== undefined
        ? `If answerText mentions ${profile.requiredNominalKw} kW, it must label that number as a preliminary calculated orientation under assumptions.`
        : 'If answerText mentions any kW value, it must be clearly tied to the available tool profile or omitted.';
      clauses.push({
        code: 'generator_bounded_assumption_preliminary_orientation',
        sourceRequestId: result.requestId,
        instruction: `This generator load calculation used estimateBasis=bounded_assumption. ${profileInstruction} Preserve the missing exact fact such as pump nameplate power/model in the answer. Do not phrase the estimate as confirmed nameplate data, exact sizing, or final purchase-safe selection.`
      });
    }
    if (result.tool !== 'web.researchProductFacts') continue;
    if (intent && isCatalogAvailabilityOnlyIntent(intent)) continue;
    const payload = result.payload as {
      researchOutcome?: 'answered' | 'partial' | 'exhausted';
      sourcesExhausted?: boolean;
      unconfirmedFacts?: Array<{
        requirementIds?: string[];
        productName?: string | null;
        attribute?: string;
        status?: string;
        reason?: string;
      }>;
      catalogPresence?: Array<{ productName?: string; status?: string }>;
      nearbyCatalogProducts?: Array<{ name?: string }>;
      facts?: Array<{ productName?: string; sourceType?: string; confidence?: string }>;
      answerGuidance?: { directAnswer?: string; completeness?: string };
      comparisonAttributes?: string[];
      searchDisposition?: 'completed' | 'memory_hit' | 'not_needed' | 'skipped_budget' | 'timed_out' | 'failed' | 'aborted';
    };
    const plannedRequest = intent?.toolRequests.find((request) => request.id === result.requestId);
    const requestedProductNames = requestStringArray(plannedRequest?.args.productNames);
    const requestedAttributes = requestStringArray(plannedRequest?.args.comparisonAttributes);
    const unresolvedFacts = (payload.unconfirmedFacts ?? [])
      .filter((fact) => typeof fact.attribute === 'string' && fact.attribute.trim())
      .map((fact) => ({
        requirementIds: fact.requirementIds ?? [],
        productName: typeof fact.productName === 'string' ? fact.productName : null,
        attribute: fact.attribute!.trim(),
        status: fact.status ?? 'not_confirmed',
        reason: fact.reason ?? ''
      }));
    if (payload.searchDisposition === 'not_needed') {
      clauses.push({
        code: 'web_not_needed_catalog_grounding',
        sourceRequestId: result.requestId,
        instruction: 'The planned conditional web check was not executed because the successful catalog result already confirmed every covered per-product requirement for the remaining suitable candidates. Use the catalog and calculator evidence directly. Do not claim that external sources were searched, checked, or exhausted; do not cite this web tool result as factual evidence; and do not offer specialist escalation merely because a web request existed in the plan.'
      });
      continue;
    }
    if (webResearchResultProvesSourceExhaustion(result)) {
      clauses.push({
        code: 'web_research_exhausted_grounding',
        sourceRequestId: result.requestId,
        instruction: `The requested web fact check exhausted the available search attempt without confirming the decisive fact. Do not use the unresolved attributes as factual evidence and do not turn missing confirmation into incompatibility. Confirmed facts with exact source evidence remain usable as preliminary evidence. Preserve any useful preliminary product conclusion supported by those confirmed facts, the dialogue, ledger, or successful catalog results; name the exact fact that remains unconfirmed; say that final confirmation still requires a technical check. Unconfirmed facts: ${JSON.stringify(unresolvedFacts.length ? unresolvedFacts : (payload.comparisonAttributes ?? []).map((attribute) => ({ attribute, status: 'not_confirmed' })))}. Offer to obtain that concrete result from a technical specialist, ask the buyer to leave a phone number, and ask whether they prefer the result by message or by phone call. Set leadAction="offer_form". Do not claim that the request was already transferred or that the specialist is already checking it until lead.capture succeeds.`
      });
      continue;
    }
    if (result.status !== 'ok') {
      clauses.push({
        code: 'web_research_incomplete_grounding',
        sourceRequestId: result.requestId,
        instruction: `The requested facts remain unconfirmed and the available sources are not exhausted. Internal execution diagnostics are admin-only: do not mention tools, web/external search, retries, timeout, failures, pipelines, or whether a check completed. Speak as a live sales manager. Preserve useful conclusions supported by dialogue, ledger, catalog results, or other confirmed facts; name the concrete product or option when known; state the exact customer-facing fact still needed and what product document, article, dimension, or specification would settle it. Do not offer specialist handoff solely because of this incomplete attempt and do not use this failed result as factual evidence. Typed targets: ${JSON.stringify(requestedProductNames)}. Requested facts: ${JSON.stringify(requestedAttributes)}.`
      });
      continue;
    }
    const directAnswer = typeof payload.answerGuidance?.directAnswer === 'string'
      ? payload.answerGuidance.directAnswer.trim()
      : '';
    if (directAnswer && payload.answerGuidance?.completeness !== 'not_answered') {
      clauses.push({
        code: 'answer_checked_research_guidance',
        sourceRequestId: result.requestId,
        instruction: `Use this checked research guidance to answer the buyer's direct question in simple words, without turning unverified choices into false negatives: ${directAnswer}`
      });
    }
    if (payload.researchOutcome === 'partial' && unresolvedFacts.length) {
      clauses.push({
        code: 'web_research_partial_grounding',
        sourceRequestId: result.requestId,
        instruction: `Preserve the confirmed part of the checked answer, but do not silently treat unresolved attributes as confirmed or contradicted. Name the exact remaining gap when it affects the decision. Unconfirmed facts: ${JSON.stringify(unresolvedFacts)}. If that gap is decisive and the available research has been exhausted, offer a technical follow-up, ask for a phone number, and offer the result by message or phone without claiming that a request was already transferred.`
      });
    }
    if (result.warnings.includes('verified_product_fact_memory_used')) {
      clauses.push({
        code: 'answer_verified_fact_memory_naturally',
        sourceRequestId: result.requestId,
        instruction: 'This tool result came from verified local product fact memory. Use payload.facts and answer the buyer in normal plain language. Do not copy internal attribute/value labels or answer as a raw technical list.'
      });
    }
    const nearbyNames = uniqueStrings((payload.nearbyCatalogProducts ?? [])
      .map((product) => typeof product.name === 'string' ? product.name.trim() : '')
      .filter(Boolean))
      .slice(0, 4);
    for (const presence of payload.catalogPresence ?? []) {
      if (presence.status === 'unknown' && presence.productName) {
        clauses.push({
          code: 'catalog_presence_unverified',
          sourceRequestId: result.requestId,
          productName: presence.productName,
          instruction: `Do not say that ${presence.productName} is absent from the BAKAUT catalog. The exact catalog refresh did not complete, so describe the catalog status as unverified and preserve any confirmed product or web facts without inventing a negative.`
        });
        continue;
      }
      if (presence.status !== 'absent' || !presence.productName) continue;
      const targetProductName = presence.productName;
      const targetFacts = (payload.facts ?? []).filter((fact) =>
        fact.sourceType === 'web' &&
        typeof fact.productName === 'string' &&
        ['high', 'medium'].includes(String(fact.confidence ?? '')) &&
        textMatchesTargetName(fact.productName, targetProductName)
      );
      if (targetFacts.length) {
        clauses.push({
          code: 'answer_direct_checked_external_fact',
          sourceRequestId: result.requestId,
          productName: targetProductName,
          instruction: `Use checked external web facts to answer the buyer's direct technical question about ${targetProductName}.`
        });
      }
      clauses.push({
        code: 'state_exact_catalog_absence',
        sourceRequestId: result.requestId,
        productName: targetProductName,
        instruction: `Say plainly that the exact model ${targetProductName} is not in the BAKAUT catalog.`
      });
      if (nearbyNames.length) {
        clauses.push({
          code: 'mention_nearby_catalog_models',
          sourceRequestId: result.requestId,
          productName: targetProductName,
          catalogProductNames: nearbyNames,
          instruction: `Mention these nearby BAKAUT catalog models only as catalog orientation, not as proof about ${targetProductName}: ${nearbyNames.join('; ')}.`
        });
      }
    }
  }
  return clauses;
}










export class AgentSemanticDecisionIncoherentError extends Error {
  constructor(readonly issues: string[]) {
    super(`semantic_decision_incoherent:${issues.join(',')}`);
    this.name = 'AgentSemanticDecisionIncoherentError';
  }
}


































export const agentManagerStructuredFormats = {
  observationDecisionFormat,
  semanticDecisionFormat,
  ledgerDeltaFormat,
  intentContractFormat,
  answerContractFormat
} as const;




export class AgentManagerOrchestrator {
private readonly toolExecutor: AgentManagerToolExecutor;

constructor(
    private readonly conversations = new ConversationRepository(),
    private readonly products = new ProductRepository(),
    private readonly leads = new LeadRepository(),
    private readonly model: AgentManagerModel = new OpenAIAgentManagerModel(),
    private readonly embedQuery: (text: string, signal?: AbortSignal) => Promise<number[] | undefined | null> = createEmbedding,
    private readonly readSitePrice = readCurrentSitePrice
  ) {
    this.toolExecutor = new AgentManagerToolExecutor(this.conversations, this.products, this.leads, this.model, this.embedQuery, this.readSitePrice, (...args) => this.trace(...args));
  }

  async generateAnswer(input: AgentManagerGenerateInput): Promise<ChatResponsePayload> {
    const session = await this.conversations.getSession(input.sessionId);
    if (!session || session.status !== 'active') throw new Error('Conversation session is not active');
    if (!input.turnId) throw new Error('Agent manager harness requires a turn id');
    return this.executeTurn({ ...input, session, turnId: input.turnId, recovered: false });
  }

  async recoverTurn(input: AgentManagerRecoverInput): Promise<ChatResponsePayload> {
    return coordinateTurnRecovery({
      sessionId:input.sessionId,turnId:input.turnId,signal:input.signal,conversations:this.conversations,
      completed:session=>this.completedPayload(session,input.turnId,input.onDelta),
      execute:session=>this.executeTurn({...input,userMessage:'',skipUserMessage:true,session,recovered:true})
    });
  }

  private async loadPersistedTurnExecution(sessionId: string, turnId: string) {
    const repository = this.conversations as ConversationRepository & {
      listTurnCheckpoints?: ConversationRepository['listTurnCheckpoints'];
      listToolArtifacts?: ConversationRepository['listToolArtifacts'];
    };
    const checkpoints = typeof repository.listTurnCheckpoints === 'function'
      ? await repository.listTurnCheckpoints.call(this.conversations, sessionId, turnId)
      : [];
    const artifactRows = typeof repository.listToolArtifacts === 'function'
      ? await repository.listToolArtifacts.call(this.conversations, sessionId, turnId)
      : [];
    const toolResults = new Map<string, ToolResult>();
    for (const artifact of artifactRows) {
      const result = parsePersistedToolArtifact(artifact);
      const previous = toolResults.get(result.requestId);
      if (previous && (previous.tool !== result.tool || JSON.stringify(previous.payload) !== JSON.stringify(result.payload))) {
        throw new Error(`conflicting_saved_tool_artifact:${result.requestId}`);
      }
      toolResults.set(result.requestId, result);
    }
    return { checkpoints, toolResults };
  }

  private async loadDialogueLedgerContext(sessionId: string) {
    const repository = this.conversations as ConversationRepository & {
      getDialogueLedgerSnapshot?: ConversationRepository['getDialogueLedgerSnapshot'];
      listDialogueLedgerEventsAfter?: ConversationRepository['listDialogueLedgerEventsAfter'];
    };
    const snapshot = typeof repository.getDialogueLedgerSnapshot === 'function'
      ? await repository.getDialogueLedgerSnapshot.call(this.conversations, sessionId)
      : null;
    let snapshotReplayRequired = false;
    if (snapshot && typeof repository.listDialogueLedgerEventsAfter === 'function') {
      const throughEventSeq = Number(snapshot.through_event_seq ?? 0);
      if (!Number.isSafeInteger(throughEventSeq) || throughEventSeq < 0) {
        throw new Error('invalid_dialogue_ledger_snapshot_cursor');
      }
      let parsedSnapshot: {
        initialState: ReducedDialogueLedgerState;
        recentEvents: DialogueLedgerEvent[];
      } | undefined;
      try {
        const initialState = parseReducedDialogueLedgerState(snapshot.state);
        const recentRows: unknown[] = Array.isArray(snapshot.recent_events) ? snapshot.recent_events : [];
        const recentEvents = recentRows.map((event) => DialogueLedgerEventSchema.parse(event));
        parsedSnapshot = { initialState, recentEvents };
      } catch {
        parsedSnapshot = undefined;
        snapshotReplayRequired = true;
      }
      if (parsedSnapshot) {
        const tailRows = await repository.listDialogueLedgerEventsAfter.call(this.conversations, sessionId, throughEventSeq, 2_000);
        if (tailRows.length >= 2_000) throw new Error('dialogue_ledger_snapshot_tail_limit_exceeded');
        const tailEvents = mapLedgerRows(tailRows as DialogueLedgerRow[]);
        const state = reduceDialogueLedger(tailEvents, parsedSnapshot.initialState);
        return {
          events: [...new Map([...parsedSnapshot.recentEvents, ...tailEvents].map((event) => [event.eventId, event])).values()].slice(-160),
          state
        };
      }
    }

    const rows = typeof repository.listDialogueLedgerEventsAfter === 'function'
      ? await repository.listDialogueLedgerEventsAfter.call(this.conversations, sessionId, 0, 10_000)
      : await this.conversations.listDialogueLedgerEvents(sessionId, 2_000);
    if (rows.length >= 10_000) throw new Error('dialogue_ledger_initial_replay_limit_exceeded');
    const events = mapLedgerRows(rows as DialogueLedgerRow[]);
    const state = reduceDialogueLedger(events);
    if (snapshotReplayRequired) {
      state.warnings = Array.from(new Set([...state.warnings, 'invalid_snapshot_replayed_from_events']));
    }
    return { events: events.slice(-160), state };
  }

  private async persistDialogueLedgerState(input: {
    sessionId: string;
    turnId: string;
    executionOwner: string;
    state: ReducedDialogueLedgerState;
    recentEvents: DialogueLedgerEvent[];
    needState: CustomerNeedState;
  }) {
    const repository = this.conversations as ConversationRepository & {
      updateNeedState?: ConversationRepository['updateNeedState'];
      latestDialogueLedgerEventSeq?: ConversationRepository['latestDialogueLedgerEventSeq'];
      saveDialogueLedgerSnapshot?: ConversationRepository['saveDialogueLedgerSnapshot'];
    };
    if (typeof repository.updateNeedState === 'function') {
      await repository.updateNeedState.call(this.conversations, input.sessionId, input.needState, {
        turnId: input.turnId,
        executionOwner: input.executionOwner
      });
    }
    if (
      typeof repository.latestDialogueLedgerEventSeq !== 'function' ||
      typeof repository.saveDialogueLedgerSnapshot !== 'function'
    ) return;
    const cursor = await repository.latestDialogueLedgerEventSeq.call(this.conversations, input.sessionId);
    if (!Number.isSafeInteger(cursor.eventSeq) || cursor.eventSeq <= 0) return;
    await repository.saveDialogueLedgerSnapshot.call(this.conversations, {
      sessionId: input.sessionId,
      turnId: input.turnId,
      executionOwner: input.executionOwner,
      throughEventSeq: cursor.eventSeq,
      eventCount: cursor.eventCount,
      state: input.state,
      recentEvents: input.recentEvents.slice(-120)
    });
  }

private verifiedFactRepository() {
    return this.toolExecutor.verifiedFactRepository();
  }

  private async loadPendingLeadCaptureDraft(sessionId: string) {
    const repository = this.leads as LeadRepository & {
      getPendingLeadCaptureDraft?: LeadRepository['getPendingLeadCaptureDraft'];
    };
    return typeof repository.getPendingLeadCaptureDraft === 'function'
      ? repository.getPendingLeadCaptureDraft.call(this.leads, sessionId)
      : null;
  }

private async loadVerifiedProductEvidence(products: Product[], attributes: string[] = []) {
    return this.toolExecutor.loadVerifiedProductEvidence(products, attributes);
  }

private async researchFromVerifiedFactMemory(input: {
    sessionId: string;
    turnId: string;
    targetProductNames: string[];
    comparisonAttributes: string[];
    requestedFactSlots?: Array<{ productName: string; attribute: string }>;
    selectedProducts: Product[];
    signal?: AbortSignal;
    deadlineAtMs?: number;
  }) {
    return this.toolExecutor.researchFromVerifiedFactMemory(input);
  }

private async persistVerifiedResearchFacts(input: {
    sessionId: string;
    turnId: string;
    requestId?: string;
    research: ProductComparisonResearchResult;
    targetProductNames: string[];
    selectedProducts: Product[];
  }) {
    return this.toolExecutor.persistVerifiedResearchFacts(input);
  }

  private async executeTurn(input: AgentManagerGenerateInput & {
    session: ConversationSession;
    turnId: string;
    recovered: boolean;
  }): Promise<ChatResponsePayload> {
    const completed = await this.completedPayload(input.session, input.turnId, input.onDelta);
    if (completed) return completed;

    const ownerId = randomUUID();
    const persistedTurn = await this.conversations.getTurn(input.sessionId, input.turnId);
    if (!persistedTurn) throw new Error('Conversation turn not found');
    const persistedDeadlineAtMs = persistedTurn.deadlineAt ? Date.parse(persistedTurn.deadlineAt) : Number.NaN;
    const leaseMs = Number.isFinite(persistedDeadlineAtMs)
      ? Math.max(1_000, persistedDeadlineAtMs - Date.now())
      : DEFAULT_AGENT_MANAGER_TURN_LIMITS.maxWallTimeMs + TURN_COMMIT_RESERVE_MS;
    const leaseRepository = this.conversations as ConversationRepository & {
      claimTurnExecution?: ConversationRepository['claimTurnExecution'];
      releaseTurnExecution?: ConversationRepository['releaseTurnExecution'];
    };
    const leaseClaimed = typeof leaseRepository.claimTurnExecution !== 'function'
      ? true
      : Boolean(await leaseRepository.claimTurnExecution.call(this.conversations, {
          sessionId: input.sessionId,
          turnId: input.turnId,
          ownerId,
          leaseMs
        }));
    if (!leaseClaimed) {
      const completedAfterCollision = await this.completedPayload(input.session, input.turnId, input.onDelta);
      if (completedAfterCollision) return completedAfterCollision;
      throw new TurnExecutionInProgressError();
    }

    try {
      const completedFromAnswerContract = await this.completedFromFinalAnswerContract(
        input.session,
        input.turnId,
        input.recovered,
        ownerId,
        input.onDelta
      );
      if (completedFromAnswerContract) return completedFromAnswerContract;
      return await this.executeClaimedTurn({ ...input, executionOwner: ownerId });
    } catch (error) {
      if (error instanceof AgentManagerTurnBudgetExceededError) {
        await this.conversations.updateTurn({
          sessionId: input.sessionId,
          turnId: input.turnId,
          status: 'failed',
          stage: 'budget_stopped',
          errorCode: error.stopReason,
          errorMessage: error.message,
          executionOwner: ownerId
        });
        await this.trace(input.sessionId, input.turnId, 'turn', 'budget_stopped', {
          stopReason: error.stopReason
        });
      }
      throw error;
    } finally {
      if (typeof leaseRepository.releaseTurnExecution === 'function') {
        await leaseRepository.releaseTurnExecution.call(this.conversations, {
          sessionId: input.sessionId,
          turnId: input.turnId,
          ownerId
        }).catch((error) => console.warn('Agent manager turn lease release failed', safeError(error)));
      }
    }
  }

  private async executeClaimedTurn(input: AgentManagerGenerateInput & {
    session: ConversationSession;
    turnId: string;
    recovered: boolean;
    executionOwner: string;
  }): Promise<ChatResponsePayload> {
    const persistedTurn = await this.conversations.getTurn(input.sessionId, input.turnId);
    const persistedDeadlineAtMs = persistedTurn?.deadlineAt ? Date.parse(persistedTurn.deadlineAt) : Number.NaN;
    const absoluteWorkDeadlineAtMs = Number.isFinite(persistedDeadlineAtMs)
      ? persistedDeadlineAtMs - TURN_COMMIT_RESERVE_MS
      : undefined;
    const budgetProfile = selectAgentManagerBudgetProfile({
      recovered: input.recovered,
      userMessage: input.userMessage,
      needState: input.session.needState
    });
    const turnBudget = new AgentManagerTurnBudget(
      agentManagerTurnLimitsForProfile(budgetProfile),
      Date.now,
      absoluteWorkDeadlineAtMs,
      budgetProfile
    );
    let wallTimeSignal: AbortSignal;
    try {
      wallTimeSignal = turnBudget.createWallTimeAbortSignal();
    } catch (error) {
      throw error;
    }
    const signal = input.signal
      ? AbortSignal.any([input.signal, wallTimeSignal])
      : wallTimeSignal;
    try {
      const payload = await runWithTurnStageEmitter(input.onStage, () => runWithAgentManagerTurnBudget(
        turnBudget,
        () => this.executeClaimedTurnWithinBudget({ ...input, signal }, turnBudget)
      ));
      return payload;
    } catch (error) {
      if (
        wallTimeSignal.aborted ||
        (error instanceof AgentManagerTurnBudgetExceededError && error.stopReason === 'wall_time_budget_exceeded')
      ) {
        // The fenced terminal repository write is the durable commit point. If
        // delivery/checkpointing fails afterwards, recover the already completed
        // turn instead of marking it as budget-stopped.
        const committed = await this.completedFromFinalAnswerContract(
          input.session,
          input.turnId,
          input.recovered,
          input.executionOwner,
          undefined
        ).catch((recoveryError) => {
          console.warn('Committed turn recovery after wall deadline failed', safeError(recoveryError));
          return null;
        });
        if (committed) return committed;
        throw new AgentManagerTurnBudgetExceededError('wall_time_budget_exceeded');
      }
      if (error instanceof AgentManagerTurnBudgetExceededError && error.stopReason !== 'wall_time_budget_exceeded') {
        throw error;
      }
      if (error instanceof AgentSemanticDecisionIncoherentError) {
        await this.trace(input.sessionId, input.turnId, 'intent', 'semantic_decision_failed', {
          issues: error.issues
        });
        throw error;
      }
      throw error;
    }
  }

  private async executeClaimedTurnWithinBudget(input: AgentManagerGenerateInput & {
    session: ConversationSession;
    turnId: string;
    recovered: boolean;
    executionOwner: string;
  }, turnBudget: AgentManagerTurnBudget): Promise<ChatResponsePayload> {
    await this.trace(input.sessionId, input.turnId, 'turn', 'started', { recovered: input.recovered });

    let history = await this.conversations.listMessages(input.sessionId, 80);
    let turn = await this.conversations.getTurn(input.sessionId, input.turnId);
    if (!turn) throw new Error('Conversation turn not found');
    const persistedExecution = await this.loadPersistedTurnExecution(input.sessionId, input.turnId);

    let userMessage = input.userMessage;
    if (!turn.userMessageId && !input.skipUserMessage) {
      const user = await this.conversations.addUserMessageForTurn({
        sessionId: input.sessionId,
        turnId: input.turnId,
        executionOwner: input.executionOwner,
        content: input.userMessage,
        activeNeedsBefore: input.session.needState.activeNeeds ?? []
      });
      await this.conversations.upsertTurnCheckpoint({
        sessionId: input.sessionId,
        turnId: input.turnId,
        executionOwner: input.executionOwner,
        checkpoint: 'user_message_saved',
        status: 'succeeded',
        artifactRef: user.id,
        payload: { source: 'agent_manager' }
      });
      history = await this.conversations.listMessages(input.sessionId, 80);
      turn = await this.conversations.getTurn(input.sessionId, input.turnId);
    }

    if (!userMessage.trim()) {
      const user = turn?.userMessageId
        ? history.find((message) => message.id === turn?.userMessageId)
        : [...history].reverse().find((message) => message.role === 'user');
      userMessage = user?.content ?? '';
    }
    if (!userMessage.trim()) throw new Error('Cannot recover turn without saved user message');

    const pendingExhaustedTechnicalHandoffs = trustedPendingExhaustedTechnicalHandoffs(history);
    const pendingLeadCaptureDraft = await this.loadPendingLeadCaptureDraft(input.sessionId);
    const pendingLeadDraftContext = pendingLeadCaptureDraftContext(pendingLeadCaptureDraft);
    if (pendingLeadCaptureDraft) {
      await this.trace(input.sessionId, input.turnId, 'lead', 'lead_capture_draft_loaded', {
        draftId: pendingLeadCaptureDraft.id,
        scopeHash: pendingLeadCaptureDraft.scopeHash,
        hasName: Boolean(pendingLeadCaptureDraft.name),
        hasPhone: Boolean(pendingLeadCaptureDraft.phone),
        hasEmail: Boolean(pendingLeadCaptureDraft.email),
        preferredContact: pendingLeadCaptureDraft.preferredContact ?? null,
        expiresAt: pendingLeadCaptureDraft.expiresAt
      });
    }

    const ledgerContext = await this.loadDialogueLedgerContext(input.sessionId);
    const ledgerEvents = ledgerContext.events;

    const savedDelta = succeededCheckpoint(persistedExecution.checkpoints, 'ledger_delta_proposed');
    const semanticDecisionCheckpoint = succeededCheckpoint(persistedExecution.checkpoints, 'semantic_decision_proposed');
    const parsedSemanticDecisionCheckpoint = semanticDecisionCheckpoint.found
      ? AgentSemanticDecisionSchema.safeParse(semanticDecisionCheckpoint.payload)
      : undefined;
    const recoveredSemanticDecision = parsedSemanticDecisionCheckpoint?.success
      ? parsedSemanticDecisionCheckpoint.data
      : undefined;
    const intentCheckpoint = succeededCheckpoint(persistedExecution.checkpoints, 'intent_contract_created');
    const intentProposalCheckpoint = succeededCheckpoint(persistedExecution.checkpoints, 'intent_contract_proposed');
    const turnPlannerIntent = turn?.plannerContract
      ? { found: true as const, payload: turn.plannerContract }
      : { found: false as const, payload: undefined };
    const savedIntent = intentCheckpoint.found
      ? intentCheckpoint
      : turnPlannerIntent.found
        ? turnPlannerIntent
        : intentProposalCheckpoint.found
          ? intentProposalCheckpoint
          : recoveredSemanticDecision
            ? { found: true as const, payload: recoveredSemanticDecision.intent }
            : intentProposalCheckpoint;
    if (!recoveredSemanticDecision && (savedDelta.found || savedIntent.found)) {
      throw new Error('legacy_split_semantic_checkpoint_not_supported');
    }
    let parallelDelta: LedgerStateDelta | undefined;
    let parallelIntent: AgentIntentContract | undefined;
    let parallelDeltaCheckpointed = false;
    let combinedSemanticDecision = Boolean(recoveredSemanticDecision);
    if (recoveredSemanticDecision) {
      parallelDelta = recoveredSemanticDecision.ledgerDelta;
      parallelIntent = recoveredSemanticDecision.intent;
      await this.trace(input.sessionId, input.turnId, 'recovery', 'semantic_decision_checkpoint_reused', {
        remainingTurnMs: turnBudget.remainingWallTimeMs()
      });
    }
    if (!savedDelta.found && !savedIntent.found) {
      const semanticStartedAt = Date.now();
      // Hard per-attempt cap: OpenAI latency at high effort occasionally spikes to
      // 60-100s, which silently ate the whole turn budget and broke the writer.
      // Each attempt gets a fresh min(turn deadline, now + cap) deadline instead.
      const plannerAttemptDeadlineMs = () => turnBudget.deadlineForStage(
        SEMANTIC_DECISION_ATTEMPT_TIMEOUT_MS,
        SEMANTIC_DECISION_DOWNSTREAM_RESERVE_MS
      );
      let structuredDeadlineAtMs = plannerAttemptDeadlineMs();
      if (!this.model.decideTurn) {
        throw new Error('combined_semantic_decision_required');
      }
        const sharedModelInput = {
          session: input.session,
          history,
          userMessage,
          ledgerEvents,
          ledgerState: ledgerContext.state,
          pendingLeadCaptureDraft: pendingLeadDraftContext,
          pendingExhaustedTechnicalHandoffs,
          structuredDeadlineAtMs,
          structuredOutputTokenCap: Math.max(config.OPENAI_PLANNER_MAX_OUTPUT_TOKENS, 3_200),
          signal: input.signal
        };
        await this.trace(input.sessionId, input.turnId, 'intent', 'semantic_decision_started', {
          pendingLeadCaptureDraft: Boolean(pendingLeadDraftContext),
          outputTokenCap: sharedModelInput.structuredOutputTokenCap,
          remainingTurnMs: turnBudget.remainingWallTimeMs()
        });
        let validationIssues: string[] = [];
        let validationIssueHistory: string[] = [];
        let decision: AgentSemanticDecision | undefined;
        let rejectedSemanticDecision: AgentSemanticDecision | undefined;
        for (let attempt = 1; attempt <= 3; attempt += 1) {
          structuredDeadlineAtMs = plannerAttemptDeadlineMs();
          turnBudget.consumeModelCall();
          let candidate: AgentSemanticDecision;
          try {
            candidate = await this.model.decideTurn({
              ...sharedModelInput,
              structuredDeadlineAtMs,
              semanticValidationIssues: validationIssues,
              semanticValidationIssueHistory: validationIssueHistory,
              rejectedSemanticDecision
            });
          } catch (error) {
            if (error instanceof ZodError) {
              validationIssues = error.issues.map((issue) =>
                `semantic_contract_schema_invalid:${issue.path.join('.') || 'root'}:${issue.message}`
              );
              validationIssueHistory = uniqueStrings([...validationIssueHistory, ...validationIssues]);
              await this.trace(input.sessionId, input.turnId, 'intent', 'semantic_decision_schema_invalid', {
                attempt,
                issues: validationIssues,
                remainingTurnMs: turnBudget.remainingWallTimeMs()
              });
              if (attempt >= 3) break;
              continue;
            }
            const attemptTimedOut = error instanceof StructuredJsonDeadlineExceededError ||
              (error instanceof StructuredJsonRetrySkippedError && error.retryReason === 'insufficient_time_budget');
            if (!attemptTimedOut) throw error;
            await this.trace(input.sessionId, input.turnId, 'intent', 'semantic_decision_attempt_timed_out', {
              attempt,
              deadlineAtMs: structuredDeadlineAtMs,
              remainingTurnMs: turnBudget.remainingWallTimeMs()
            });
            if (attempt >= 3) {
              throw new AgentManagerTurnBudgetExceededError('wall_time_budget_exceeded');
            }
            continue;
          }
          const validation = validateAgentSemanticDecision({
            decision: candidate,
            previousLedgerState: ledgerContext.state,
            sessionId: input.sessionId,
            turnId: input.turnId,
            userMessage,
            history,
            historicalToolResults: previousSelectionToolResults({ history, intent: candidate.intent }),
            provenExhaustedHandoffContinuation: hasProvenTechnicalHandoffContinuation({
              history,
              userMessage,
              intent: candidate.intent,
              pendingLeadCaptureDraft
            })
          });
          validationIssues = validation.issues;
          await this.trace(input.sessionId, input.turnId, 'intent', 'semantic_decision_validated', {
            attempt,
            valid: validationIssues.length === 0,
            issues: validationIssues,
            durationMs: Date.now() - semanticStartedAt,
            remainingTurnMs: turnBudget.remainingWallTimeMs()
          });
          if (!validationIssues.length) {
            decision = candidate;
            break;
          }
          validationIssueHistory = uniqueStrings([...validationIssueHistory, ...validationIssues]);
          rejectedSemanticDecision = candidate;
        }
        if (!decision) {
          await this.conversations.upsertTurnCheckpoint({
            sessionId: input.sessionId,
            turnId: input.turnId,
            executionOwner: input.executionOwner,
            checkpoint: 'semantic_decision_proposed',
            status: 'failed',
            payload: { issues: validationIssues },
            errorCode: 'semantic_decision_incoherent',
            errorMessage: validationIssues.join(',')
          });
          throw new AgentSemanticDecisionIncoherentError(validationIssues);
        }
        parallelDelta = decision.ledgerDelta;
        parallelIntent = decision.intent;
        combinedSemanticDecision = true;
        await this.conversations.upsertTurnCheckpoint({
          sessionId: input.sessionId,
          turnId: input.turnId,
          executionOwner: input.executionOwner,
          checkpoint: 'semantic_decision_proposed',
          status: 'succeeded',
          payload: decision
        });
        await this.conversations.upsertTurnCheckpoint({
          sessionId: input.sessionId,
          turnId: input.turnId,
          executionOwner: input.executionOwner,
          checkpoint: 'ledger_delta_proposed',
          status: 'succeeded',
          payload: decision.ledgerDelta
        });
        await this.conversations.upsertTurnCheckpoint({
          sessionId: input.sessionId,
          turnId: input.turnId,
          executionOwner: input.executionOwner,
          checkpoint: 'intent_contract_proposed',
          status: 'succeeded',
          payload: decision.intent
        });
        parallelDeltaCheckpointed = true;
        await this.trace(input.sessionId, input.turnId, 'intent', 'semantic_decision_completed', {
          durationMs: Date.now() - semanticStartedAt,
          remainingTurnMs: turnBudget.remainingWallTimeMs()
        });
    }
    let delta: LedgerStateDelta;
    if (savedDelta.found) {
      delta = LedgerStateDeltaSchema.parse(savedDelta.payload);
    } else if (recoveredSemanticDecision) {
      delta = recoveredSemanticDecision.ledgerDelta;
    } else if (parallelDelta) {
      delta = parallelDelta;
    } else {
      throw new Error('combined_semantic_decision_missing_ledger_delta');
    }
    if (!savedDelta.found && !parallelDeltaCheckpointed) {
      await this.conversations.upsertTurnCheckpoint({
        sessionId: input.sessionId,
        turnId: input.turnId,
        executionOwner: input.executionOwner,
        checkpoint: 'ledger_delta_proposed',
        status: 'succeeded',
        payload: delta
      });
    } else {
      await this.trace(input.sessionId, input.turnId, 'recovery', 'checkpoint_reused', { checkpoint: 'ledger_delta_proposed' });
    }
    const savedAppliedDelta = succeededCheckpoint(persistedExecution.checkpoints, 'ledger_delta_applied');
    const newEvents = normalizeLedgerStateDeltaEvents({
      sessionId: input.sessionId,
      turnId: input.turnId,
      delta
    });
    if (savedAppliedDelta.found) {
      const persistedEventIds = new Set(ledgerEvents.map((event) => event.eventId));
      const missingEventIds = newEvents
        .map((event) => event.eventId)
        .filter((eventId) => !persistedEventIds.has(eventId));
      if (missingEventIds.length) throw new Error(`incomplete_saved_ledger_delta:${missingEventIds.join(',')}`);
    } else {
      for (const event of newEvents) {
        await this.conversations.upsertDialogueLedgerEvent({
          sessionId: event.sessionId,
          turnId: event.turnId,
          executionOwner: input.executionOwner,
          eventId: event.eventId,
          eventType: event.eventType,
          scope: event.scope,
          payload: event.payload,
          evidence: event.evidence,
          source: event.source,
          status: event.status
        });
      }
      await this.conversations.upsertTurnCheckpoint({
        sessionId: input.sessionId,
        turnId: input.turnId,
        executionOwner: input.executionOwner,
        checkpoint: 'ledger_delta_applied',
        status: 'succeeded',
        payload: { eventIds: newEvents.map((event) => event.eventId) }
      });
    }
    await this.trace(input.sessionId, input.turnId, 'ledger', 'delta_applied', { eventIds: newEvents.map((event) => event.eventId) });

    let effectiveLedgerEvents = [
      ...new Map([...ledgerEvents, ...newEvents].map((event) => [event.eventId, event])).values()
    ];
    let ledgerState = reduceDialogueLedger(newEvents, ledgerContext.state);
    let needStateSnapshot = deriveNeedStateSnapshotFromLedger(ledgerState, input.session.needState ?? emptyNeedState());
    const turnLedgerEvents = [...newEvents];
    await this.persistDialogueLedgerState({
      sessionId: input.sessionId,
      turnId: input.turnId,
      executionOwner: input.executionOwner,
      state: ledgerState,
      recentEvents: effectiveLedgerEvents,
      needState: needStateSnapshot
    });
    const savedIntentParse = savedIntent.found
      ? AgentIntentContractSchema.safeParse(savedIntent.payload)
      : undefined;
    const parsedSavedIntent = savedIntentParse?.success ? savedIntentParse.data : undefined;
    const legacyIntentUpgraded = Boolean(savedIntent.found && (
      savedIntentParse?.success === false || !parsedSavedIntent?.selectionPolicy
    ));
    let intentWasReplanned = !parsedSavedIntent || legacyIntentUpgraded;
    let plannedIntent: AgentIntentContract;
    if (parsedSavedIntent && !legacyIntentUpgraded) {
      plannedIntent = parsedSavedIntent;
    } else if (parallelIntent) {
      plannedIntent = parallelIntent;
    } else {
      throw new Error('combined_semantic_decision_missing_intent');
    }
    const revalidatedSemanticDecision = AgentSemanticDecisionSchema.parse({
      ledgerDelta: delta,
      intent: plannedIntent
    });
    const recoveredAuthorityValidation = validateAgentSemanticDecision({
      decision: revalidatedSemanticDecision,
      previousLedgerState: ledgerContext.state,
      sessionId: input.sessionId,
      turnId: input.turnId,
      userMessage,
      history,
      historicalToolResults: previousSelectionToolResults({ history, intent: plannedIntent }),
      provenExhaustedHandoffContinuation: hasProvenTechnicalHandoffContinuation({
        history,
        userMessage,
        intent: plannedIntent,
        pendingLeadCaptureDraft
      })
    });
    if (recoveredAuthorityValidation.issues.length) {
      throw new AgentSemanticDecisionIncoherentError(recoveredAuthorityValidation.issues);
    }
    const validatedToolRequests = assertUniqueToolRequestIds(
      plannedIntent.toolRequests.map(validateToolRequest)
    );
    const intentWithoutOrderedTools: AgentIntentContract = {
      ...plannedIntent,
      toolRequests: validatedToolRequests
    };
    const intent: AgentIntentContract = {
      ...intentWithoutOrderedTools,
      toolRequests: orderToolRequestsForSelectionDependencies(validatedToolRequests, intentWithoutOrderedTools)
    };
    turnBudget.applySemanticProfile(selectAgentManagerBudgetProfile({recovered:input.recovered,intent}), 'validated_current_turn_intent');
    await this.trace(input.sessionId,input.turnId,'intent','task_budget_classified',{
      taskType:intent.grounding?.taskType,profile:turnBudget.profile,transitions:turnBudget.snapshot().profileTransitions
    });
    const initialPolicyGate = evaluateAgentManagerPolicyGate({ intent, toolResults: [] });
    await this.trace(input.sessionId, input.turnId, 'intent', 'policy_gate_evaluated', {
      ok: initialPolicyGate.ok,
      blockedReasons: initialPolicyGate.blockedReasons,
      requiredActions: initialPolicyGate.requiredActions,
      warnings: initialPolicyGate.warnings,
      catalogFirst: initialPolicyGate.catalogFirst,
      webDeferredUntilCatalogGap: initialPolicyGate.webDeferredUntilCatalogGap
    });
    const answerPolicyTrace = buildSalesManagerPolicyTrace({
      target: 'answer',
      semanticRuleIds: intent.policyRuleIds ?? [],
      riskFlags: intent.riskFlags,
      enabled: true,
      shadowMode: false
    });
    const plannedTurn = await this.conversations.updateTurn({
      sessionId: input.sessionId,
      turnId: input.turnId,
      status: 'planned',
      stage: 'intent_contract_created',
      plannerContract: intent,
      activeNeedsAfter: needStateSnapshot.activeNeeds,
      executionOwner: input.executionOwner
    });
    if (!plannedTurn) throw new TurnExecutionInProgressError();
    if (
      !intentCheckpoint.found ||
      legacyIntentUpgraded
    ) {
      await this.conversations.upsertTurnCheckpoint({
        sessionId: input.sessionId,
        turnId: input.turnId,
        executionOwner: input.executionOwner,
        checkpoint: 'intent_contract_created',
        status: 'succeeded',
        payload: intent
      });
      if (legacyIntentUpgraded) {
        await this.trace(input.sessionId, input.turnId, 'recovery', 'legacy_intent_contract_upgraded', {
          checkpoint: 'intent_contract_created',
          reason: savedIntentParse?.success === false
            ? 'saved_intent_failed_current_strict_schema'
            : 'saved_intent_missing_selection_policy'
        });
      }
    } else {
      await this.trace(input.sessionId, input.turnId, 'recovery', 'checkpoint_reused', { checkpoint: 'intent_contract_created' });
    }
    const semanticDecisionValidated = combinedSemanticDecision || Boolean(recoveredSemanticDecision);
    await this.trace(input.sessionId, input.turnId, 'intent', 'contract_created', {
      requiresTools: intent.requiresTools,
      toolRequests: intent.toolRequests.map((tool) => ({
        id: tool.id,
        tool: tool.tool,
        required: tool.required,
        coversRequirementIds: tool.coversRequirementIds ?? []
      })),
      productMentions: intent.productMentions ?? [],
      policyPackVersion: SALES_MANAGER_POLICY_PACK_VERSION,
      policyPackHash: SALES_MANAGER_POLICY_PACK_HASH,
      policyRuleIds: intent.policyRuleIds ?? []
    });

    const replannedArtifactReuse = intentWasReplanned
      ? reusableSideEffectArtifactsAfterReplan(
          intent,
          persistedExecution.toolResults,
          userMessage,
          input.session.id,
          input.turnId
        )
      : { results: persistedExecution.toolResults, rebound: [] as ToolResult[] };
    const reusablePersistedToolResults = replannedArtifactReuse.results;
    for (const reboundResult of replannedArtifactReuse.rebound) {
      await this.conversations.saveToolArtifact({
        sessionId: input.session.id,
        turnId: input.turnId,
        executionOwner: input.executionOwner,
        toolName: reboundResult.tool,
        toolRequestId: reboundResult.requestId,
        status: reboundResult.status,
        payload: reboundResult.payload,
        warnings: [...reboundResult.warnings, 'rebound_after_intent_replan'],
        errorCode: reboundResult.errorCode
      });
    }
    if (intentWasReplanned && persistedExecution.toolResults.size) {
      const reusedOriginalRequestIds = new Set(
        [...reusablePersistedToolResults.values()].map((result) => result.requestId)
      );
      await this.trace(input.sessionId, input.turnId, 'recovery', 'stale_tool_artifacts_ignored_after_replan', {
        requestIds: [...persistedExecution.toolResults.keys()].filter((id) => !reusedOriginalRequestIds.has(id)),
        preservedSideEffectRequestIds: [...reusablePersistedToolResults.keys()]
      });
    }
    const documentReadContext: ProductResearchDocumentReadContext = {};
    const catalogResearchCache = new Map<string, ProductComparisonResearchResult>();
    const freshResearchResults: ProductComparisonResearchResult[] = [];
    let { toolResults, products } = await this.executeTools({
      session: input.session,
      turnId: input.turnId,
      executionOwner: input.executionOwner,
      userMessage,
      history,
      intent,
      needState: needStateSnapshot,
      pendingLeadCaptureDraft,
      toolRequests: intent.toolRequests,
      persistedToolResults: reusablePersistedToolResults,
      documentReadContext,
      catalogResearchCache,
      freshResearchResults,
      budget: turnBudget,
      signal: input.signal
    });

    // Cache per observed product/source set for this execution. A continuation
    // that discovers a model or saves new web evidence refreshes this read.
    const verifiedEvidenceReads = new Map<string, ReturnType<AgentManagerOrchestrator['loadVerifiedProductEvidence']>>();
    const verifiedEvidenceFor = (evidenceProducts: Product[]) => {
      const key = JSON.stringify([
        evidenceProducts.map((product) => `${product.id}:${product.name}`).sort(),
        toolResults.filter((result) => result.tool === 'web.researchProductFacts')
          .map((result) => result.requestId).sort()
      ]);
      let read = verifiedEvidenceReads.get(key);
      if (!read) {
        read = this.loadVerifiedProductEvidence(evidenceProducts,
          [...(intent.grounding?.technicalAttributes ?? []), ...intent.toolRequests.flatMap(request => comparisonAttributesForRequest(request))]
        ).catch(async (error) => {
          await this.trace(input.sessionId, input.turnId, 'tools', 'verified_product_evidence_read_failed', { error: safeError(error) });
          return { facts: [], conflicts: [] };
        });
        verifiedEvidenceReads.set(key, read);
      }
      return read;
    };
    let continuation: ContinuationOutcome | undefined;
    const knownEvidence = await verifiedEvidenceFor(products);
    const knownFactShortPath = toolResults.length > 0 && toolResults.every(result => result.status === 'ok') &&
      knownTechnicalAnswerReady({ intent, products, facts: knownEvidence.facts, conflicts: knownEvidence.conflicts, toolResults });
    if (knownFactShortPath) {
      continuation = { status: 'answer', rounds: 0, missingFacts: [], candidateProductIds: products.map(product => product.id),
        rationale: 'Every planner-requested technical slot is present in current evidence; proceed to writer and factual review.' };
      await this.trace(input.sessionId, input.turnId, 'tools', 'known_fact_short_path', {
        productIds: products.map(product => product.id), attributes: intent.grounding?.technicalAttributes
      });
    }
    if (!knownFactShortPath && this.model.assessObservations && intent.grounding?.taskType !== 'lead_handoff' &&
      (toolResults.length > 0 || intent.selectionPolicy?.reusePreviousCards)) {
      for (let round = 1; round <= CONTINUATION_MAX_ROUNDS + 1; round += 1) {
        const checkpoint = `observation_decision_${round}`;
        const savedObservation = latestCheckpoint(persistedExecution.checkpoints, checkpoint);
        const stopCheckpoint = `observation_stopped_${round}`;
        const savedStop = succeededCheckpoint(persistedExecution.checkpoints, stopCheckpoint);
        if (savedStop.found) {
          continuation = savedStop.payload as ContinuationOutcome;
          await this.trace(input.sessionId, input.turnId, 'recovery', 'checkpoint_reused', { checkpoint: stopCheckpoint });
          break;
        }
        const stop = async (reason: string, decision?: ContinuationDecision) => {
          continuation = {
            status: 'stopped', rounds: round - 1, stopReason: reason,
            rationale: decision?.rationale ?? 'The observation cycle stopped before readiness was established.',
            missingFacts: decision?.missingFacts ?? continuation?.missingFacts ?? [],
            candidateProductIds: decision?.candidateProductIds ?? continuation?.candidateProductIds ?? []
          };
          await this.conversations.upsertTurnCheckpoint({
            sessionId: input.sessionId, turnId: input.turnId, executionOwner: input.executionOwner,
            checkpoint: stopCheckpoint, status: 'succeeded', payload: continuation
          });
          await this.trace(input.sessionId, input.turnId, 'tools', 'observation_cycle_stopped', { ...continuation });
        };
        if (savedObservation?.status === 'failed') {
          await stop(String(savedObservation.errorCode ?? savedObservation.error_code ?? 'observation_failed'));
          break;
        }
        // Replaying a saved answer must replay its observations, never invent a
        // new investigation after an already committed evidence/answer boundary.
        if (!savedObservation && succeededCheckpoint(persistedExecution.checkpoints, 'answer_contract_created').found) break;
        const historicalProducts = intent.selectionPolicy?.reusePreviousCards
          ? previousProductReferents({ history, intent, selectedProductIds: currentNeedSelectedProductIds(needStateSnapshot) })
          : [];
        const observationProducts = [...new Map([...historicalProducts, ...products].map((product) => [product.id, product])).values()];
        const { facts: verifiedProductFacts, conflicts: conflictingVerifiedProductFacts } = await verifiedEvidenceFor(observationProducts);
        let decision: ContinuationDecision;
        try {
          if (!savedObservation && turnBudget.remainingWallTimeMs() < 40_000) {
            await stop('answer_time_reserve');
            break;
          }
          if (savedObservation?.status === 'succeeded') {
            decision = parseContinuationDecision(savedObservation.payload);
          } else {
            turnBudget.consumeModelCall();
            decision = parseContinuationDecision(await this.model.assessObservations({
              session: input.session, history, userMessage,
              ledgerEvents: effectiveLedgerEvents, ledgerState,
              intent, products: observationProducts, toolResults, verifiedProductFacts, conflictingVerifiedProductFacts,
              pendingLeadCaptureDraft: pendingLeadDraftContext,
              round, remainingBudget: turnBudget.snapshot(),
              structuredDeadlineAtMs: turnBudget.deadlineForStage(20_000, 30_000),
              signal: input.signal
            }));
          }
          const issues = continuationValidationIssues({ decision, intent, products: observationProducts });
          if (issues.length) {
            await this.trace(input.sessionId, input.turnId, 'tools', 'observation_validation_failed', { round, issues, replayed: Boolean(savedObservation) });
            await this.conversations.upsertTurnCheckpoint({
              sessionId: input.sessionId, turnId: input.turnId, executionOwner: input.executionOwner,
              checkpoint, status: 'failed', payload: { issues, decision }, errorCode: 'invalid_continuation'
            });
            // Keep rejected model output in diagnostic evidence only. In particular,
            // invented candidate identities must never become writer context.
            await stop('invalid_continuation');
            break;
          }
          if (!savedObservation) {
            await this.conversations.upsertTurnCheckpoint({
              sessionId: input.sessionId, turnId: input.turnId, executionOwner: input.executionOwner,
              checkpoint, status: 'succeeded', payload: decision
            });
          }
        } catch (error) {
          if (input.signal?.aborted) throw error;
          const reason = error instanceof AgentManagerTurnBudgetExceededError ? error.stopReason : 'observation_failed';
          await this.conversations.upsertTurnCheckpoint({
            sessionId: input.sessionId, turnId: input.turnId, executionOwner: input.executionOwner,
            checkpoint, status: 'failed', payload: { error: safeError(error) }, errorCode: reason
          });
          await stop(reason);
          break;
        }
        await this.trace(input.sessionId, input.turnId, 'tools', 'observations_assessed', {
          round, action: decision.action, rationale: decision.rationale,
          missingFacts: decision.missingFacts, candidateProductIds: decision.candidateProductIds,
          requestIds: decision.toolRequests.map((request) => request.id),
          replayed: Boolean(savedObservation), remainingTurnMs: turnBudget.remainingWallTimeMs()
        });
        if (decision.toolRequests.some(request=>request.tool === 'web.researchProductFacts')) {
          turnBudget.applySemanticProfile('RESEARCH','validated_observation_requires_research');
        }
        const usage = turnBudget.snapshot().usage;
        // Replayed artifacts still count as completed logical requests. A new
        // execution attempt must not grant another tool allowance to this turn.
        const completedToolCalls = Math.max(usage.toolCalls, toolResults.length);
        const completedWebCalls = Math.max(usage.webCalls, toolResults.filter((result) =>
          result.tool === 'web.researchProductFacts' && result.payload.searchDisposition !== 'not_needed'
        ).length);
        const allReadsAlreadyPersisted = Boolean(savedObservation) && decision.toolRequests.every((request) =>
          reusablePersistedToolResults.get(request.id)?.tool === request.tool
        );
        const admission=admitReadContinuation({intent,decision,results:toolResults,round,
          completedToolCalls,completedWebCalls,maxToolCalls:turnBudget.limits.maxToolCalls,
          maxWebCalls:turnBudget.limits.maxWebCalls,remainingMs:turnBudget.remainingWallTimeMs(),allReadsAlreadyPersisted});
        await this.trace(input.sessionId,input.turnId,'tools','autonomy_decision',admission.state);
        if (admission.action === 'stop') {
          await stop(admission.stopReason!, decision);
          break;
        }
        if (decision.action !== 'continue') {
          continuation = { status: decision.action, rounds: round - 1,
            rationale: decision.rationale, missingFacts: decision.missingFacts, candidateProductIds: decision.candidateProductIds };
          break;
        }
        const requests = orderToolRequestsForSelectionDependencies(decision.toolRequests.map(validateToolRequest), intent);
        intent.toolRequests = [...intent.toolRequests, ...requests];
        // Keep the original intent checkpoint immutable. Numbered observation
        // checkpoints reconstruct these appended reads during exact-turn replay.
        ({ toolResults, products } = await this.executeTools({
          session: input.session, turnId: input.turnId, executionOwner: input.executionOwner,
          userMessage, history, intent, needState: needStateSnapshot, pendingLeadCaptureDraft,
          toolRequests: requests, persistedToolResults: reusablePersistedToolResults,
          priorProducts: observationProducts, priorToolResults: toolResults,
          documentReadContext,
          catalogResearchCache,
          freshResearchResults,
          budget: turnBudget, signal: input.signal
        }));
        continuation = { status: 'stopped', rounds: round, rationale: decision.rationale,
          missingFacts: decision.missingFacts, candidateProductIds: decision.candidateProductIds };
      }
    }

    await this.conversations.upsertTurnCheckpoint({
      sessionId: input.sessionId,
      turnId: input.turnId,
      executionOwner: input.executionOwner,
      checkpoint: 'tool_artifacts_saved',
      status: 'succeeded',
      payload: { resultCount: toolResults.length }
    });
    await this.trace(input.sessionId, input.turnId, 'tools', 'artifacts_saved', {
      statuses: toolResults.map((result) => ({
        requestId: result.requestId,
        tool: result.tool,
        status: result.status,
        observationStatus: result.observationStatus ?? null
      }))
    });

    const continuityIntent = continuityProductClassFromCurrentTurn({
      intent
    });
    const selectionTurnMayUseHistory = intent.selectionPolicy?.reusePreviousCards === true;
    const currentProductReferents = selectionTurnMayUseHistory
      ? previousProductReferents({
          history,
          intent,
          selectedProductIds: currentNeedSelectedProductIds(needStateSnapshot)
        })
      : [];
    const explicitComparisonReferents = selectionTurnMayUseHistory
      ? previousExplicitComparisonSubjectProducts({ history, intent })
          .filter((product) => structuredSelectionRejectionReasons(product, intent).length > 0)
      : [];
    const baseHistoricalProducts = currentProductReferents;
    const historicalProducts = [...new Map(
      [...baseHistoricalProducts, ...explicitComparisonReferents].map((product) => [product.id, product])
    ).values()];
    const historicalSelectionTools = selectionTurnMayUseHistory
      ? previousSelectionToolResults({ history, intent })
      : [];
    let selectionToolResults = mergeSelectionToolResults(historicalSelectionTools, toolResults);
    const rawAnswerProducts = [...new Map(
      [...historicalProducts, ...products].map((product) => [product.id, product])
    ).values()];
    const structuredPolicyEvidence = filterProductsByStructuredSelectionPolicy({
      products: rawAnswerProducts,
      intent,
      toolResults: selectionToolResults
    });
    const budgetAnswerProductEvidence = {
      products: structuredPolicyEvidence.products,
      droppedProductIds: [] as string[],
      warnings: [] as string[]
    };
    const plateAnswerProductEvidence = {
      products: budgetAnswerProductEvidence.products,
      droppedProductIds: [] as string[],
      warnings: [] as string[],
      policy: undefined
    };
    const effectiveIntent = intent;
    const currentCandidateTiers = structuredCandidateTierEvidence(selectionToolResults);
    const currentCandidateTierIds = new Set(currentCandidateTiers.map((candidate) => candidate.productId));
    const candidateTiers = [
      ...currentCandidateTiers,
      ...plateAnswerProductEvidence.products
        .filter((product) => !currentCandidateTierIds.has(product.id))
        .map((product) => ({
          productId: product.id,
          tier: visibleSelectionTier(intent),
          tradeoffs: [] as string[]
        }))
    ];
    let answerProductEvidence = {
      products: plateAnswerProductEvidence.products,
      droppedProductIds: uniqueStrings([
        ...structuredPolicyEvidence.droppedProductIds,
        ...budgetAnswerProductEvidence.droppedProductIds,
        ...plateAnswerProductEvidence.droppedProductIds,
        ...candidateTiers.filter((candidate) => candidate.tier === 'rejected').map((candidate) => candidate.productId)
      ]),
      warnings: uniqueStrings([
        ...structuredPolicyEvidence.warnings,
        ...budgetAnswerProductEvidence.warnings,
        ...plateAnswerProductEvidence.warnings
      ]),
      candidateTiers,
      plateTaskPolicy: plateAnswerProductEvidence.policy,
      originalProductIds: rawAnswerProducts.map((product) => product.id),
      replacementProductIds: [] as string[]
    };
    const answerProducts = answerProductEvidence.products;
    const answerModelEvidence = answerProductEvidenceWithComparisonReferences({
      intent: effectiveIntent,
      rawProducts: rawAnswerProducts,
      recommendationProducts: answerProducts,
      explicitComparisonReferents,
      toolResults: selectionToolResults
    });
    const answerEvidenceProducts = answerModelEvidence.products;
    const productEvidenceRoles = answerModelEvidence.productEvidenceRoles;
    const answerEvidenceResolution = resolveProductsForEvidence({
      products: answerEvidenceProducts,
      toolResults: selectionToolResults
    });
    const answerEvidenceProductsForWriter = answerEvidenceResolution.products;
    const { facts: verifiedProductFacts, conflicts: conflictingVerifiedProductFacts } = await verifiedEvidenceFor(answerEvidenceProducts);
    if (verifiedProductFacts.length || conflictingVerifiedProductFacts.length) {
      await this.trace(input.sessionId, input.turnId, 'answer', 'verified_product_evidence_loaded', {
        factIds: verifiedProductFacts.map((fact) => fact.id),
        productIds: uniqueStrings(verifiedProductFacts.flatMap((fact) => fact.productId ? [fact.productId] : [])),
        sourceIds: verifiedProductFacts.map((fact) => `verified_fact:${fact.id}`),
        conflictingFactIds: conflictingVerifiedProductFacts.map((fact) => fact.id)
      });
    }

    const historicalProductIds = new Set(historicalProducts.map((product) => product.id));
    const usingHistoricalProducts = answerProducts.some((product) => historicalProductIds.has(product.id));
    const requiredResponseClauses = [
      ...(usingHistoricalProducts ? [{
        code: 'revalidated_historical_products_are_current_evidence',
        sourceRequestId: 'dialogue_history',
        instruction: `Every model in the top-level products array has been revalidated against the current structured constraints, including products carried from earlier visible cards. They are all authoritative current recommendation evidence. Do not treat only the newest catalog.search payload as valid, and do not remove a closer or cheaper revalidated product merely because it came from an earlier turn. Current product evidence: ${JSON.stringify(answerProducts.map((product) => ({ id: product.id, name: product.name, price: product.price ?? null, nominalKw: extractConfirmedGeneratorNominalPowerKw(product) ?? null })))}`,
        catalogProductNames: answerProducts.map((product) => product.name)
      } satisfies RequiredResponseClause] : []),
      ...requiredResponseClausesForRejectedComparisonReferences({
        products: answerEvidenceProductsForWriter,
        productEvidenceRoles
      }),
      ...requiredResponseClausesForToolResults(toolResults, effectiveIntent)
    ];
    const savedAnswer = legacyIntentUpgraded
      ? { found: false as const, payload: undefined }
      : succeededCheckpoint(persistedExecution.checkpoints, 'answer_contract_created');
    if (turnBudget.remainingWallTimeMs() < WEB_ANSWER_RESERVE_MS) {
      turnBudget.applySemanticProfile('RESEARCH','finalization_reserve_after_reads');
    }
    let answer: AnswerContract;
    if (savedAnswer.found) {
      answer = failClosedRecoveredAnswerContract(
        parseAnswerContractModelOutput(savedAnswer.payload),
        effectiveIntent
      );
    } else {
      turnBudget.consumeModelCall();
      answer = normalizeAnswerEvidenceSources({
        answer: await this.model.composeAnswer({
          session: input.session,
          history,
          userMessage,
          ledgerEvents: effectiveLedgerEvents,
          ledgerState,
          pendingLeadCaptureDraft: pendingLeadDraftContext,
          intent: effectiveIntent,
          toolResults: selectionToolResults,
          products: answerEvidenceProductsForWriter,
          verifiedProductFacts,
          conflictingVerifiedProductFacts,
          productEvidenceRoles,
          requiredResponseClauses,
          continuation,
          semanticDecisionValidated,
          structuredDeadlineAtMs: turnBudget.deadlineForStage(45_000, 15_000),
          signal: input.signal
        }),
        ledgerState,
        toolResults: selectionToolResults
      });
    }
    if (!savedAnswer.found) {
      await this.conversations.saveAnswerContract({
        sessionId: input.sessionId,
        turnId: input.turnId,
        executionOwner: input.executionOwner,
        answerText: answer.answerText,
        contract: answer,
        status: 'draft'
      });
      await this.conversations.upsertTurnCheckpoint({
        sessionId: input.sessionId,
        turnId: input.turnId,
        executionOwner: input.executionOwner,
        checkpoint: 'answer_contract_created',
        status: 'succeeded',
        payload: answer
      });
    } else {
      await this.trace(input.sessionId, input.turnId, 'recovery', 'checkpoint_reused', { checkpoint: 'answer_contract_created' });
    }
    await this.trace(input.sessionId, input.turnId, 'answer', 'contract_created', {
      leadAction: answer.leadAction,
      questionsAsked: answer.questionsAsked.map((question) => question.questionId),
      factsUsed: answer.factsUsed.map((fact) => fact.factKey)
    });

    // Saved product facts are reloaded under current identity/freshness rules.
    // A previously reviewed draft must be checked against that current evidence
    // before recovery sends it, including when its former source is now absent.
    const usesReloadedProductEvidence = verifiedProductFacts.length > 0 || conflictingVerifiedProductFacts.length > 0 ||
      answer.factsUsed.some((fact) => fact.sourceEventIds.some((sourceId) => sourceId.startsWith('verified_fact:')));
    const savedReview = legacyIntentUpgraded || !savedAnswer.found || usesReloadedProductEvidence
      ? { found: false as const, payload: undefined }
      : succeededCheckpoint(persistedExecution.checkpoints, 'review_completed');
    let review: PreSendReview;
    if (savedReview.found) {
      review = PreSendReviewSchema.parse(savedReview.payload);
    } else {
      review = await this.review({
          session: input.session,
          history,
          userMessage,
          ledgerEvents: effectiveLedgerEvents,
          ledgerState,
          pendingLeadCaptureDraft: pendingLeadDraftContext,
          intent: effectiveIntent,
          toolResults: selectionToolResults,
          products: answerEvidenceProductsForWriter,
          verifiedProductFacts,
          conflictingVerifiedProductFacts,
          productEvidenceRoles,
          requiredResponseClauses,
          semanticDecisionValidated,
          continuation,
          answer,
          signal: input.signal
        }, turnBudget);
      // All factual/business gates have completed. Do not spend the last answer
      // reserve rewriting an otherwise accepted draft for an editorial issue.
      if (review.verdict === 'block' && review.issues.length > 0 &&
        review.issues.every((issue) => issue.code === 'customer_output_research_process_disclosure') &&
        !input.signal?.aborted && turnBudget.remainingWallTimeMs() > 0 &&
        turnBudget.remainingWallTimeMs() < WEB_ANSWER_RESERVE_MS) {
        await this.trace(input.sessionId, input.turnId, 'recovery', 'editorial_repair_deferred_budget', {
          issueCodes: review.issues.map((issue) => issue.code), remainingTurnMs: turnBudget.remainingWallTimeMs()
        });
        review = { ...review, verdict: 'pass', issues: review.issues.map((issue) => ({ ...issue, severity: 'low' as const })) };
      }
      if (review.verdict !== 'pass' || review.issues.some(issue => issue.code === 'manager_task_delegated_to_buyer')) {
        // LLM repair round: re-run the writer with issue feedback instead of killing
        // the whole turn. Deterministic gates stay as validators; the fix is semantic.
        const issueCodes = review.issues.map((issue) => issue.code);
        const repairable = review.issues.every((issue) => issue.code !== 'requires_adjudication');
        if (repairable) turnBudget.applySemanticProfile('RESEARCH','validated_review_requires_repair');
        const canAffordRepair = turnBudget.remainingWallTimeMs() > 30_000;
        if (repairable && canAffordRepair) {
          try {
          await this.trace(input.sessionId, input.turnId, 'recovery', 'answer_review_repair_started', {
            issueCodes,
            remainingTurnMs: turnBudget.remainingWallTimeMs()
          });
          turnBudget.consumeModelCall();
          const repairedAnswer = normalizeAnswerEvidenceSources({
            answer: await this.model.composeAnswer({
              session: input.session,
              history,
              userMessage,
              ledgerEvents: effectiveLedgerEvents,
              ledgerState,
              pendingLeadCaptureDraft: pendingLeadDraftContext,
              intent: effectiveIntent,
              toolResults: selectionToolResults,
              products: answerEvidenceProductsForWriter,
              verifiedProductFacts,
              conflictingVerifiedProductFacts,
              productEvidenceRoles,
              requiredResponseClauses,
              semanticDecisionValidated,
              reviewIssuesFeedback: review.issues.map((issue) => `${issue.code}: ${issue.message}`),
              continuation,
              structuredDeadlineAtMs: turnBudget.deadlineForStage(30_000, 12_000),
              signal: input.signal
            }),
            ledgerState,
            toolResults: selectionToolResults
          });
          const repairReview = await this.review({
            session: input.session,
            history,
            userMessage,
            ledgerEvents: effectiveLedgerEvents,
            ledgerState,
            pendingLeadCaptureDraft: pendingLeadDraftContext,
            intent: effectiveIntent,
            toolResults: selectionToolResults,
            products: answerEvidenceProductsForWriter,
            verifiedProductFacts,
            conflictingVerifiedProductFacts,
            productEvidenceRoles,
            requiredResponseClauses,
            semanticDecisionValidated,
            continuation,
            answer: repairedAnswer,
            signal: input.signal
          }, turnBudget);
          await this.trace(input.sessionId, input.turnId, 'recovery', 'answer_review_repair_completed', {
            issueCodes,
            repaired: repairReview.verdict === 'pass',
            remainingIssues: repairReview.issues.map((issue) => issue.code)
          });
          if (repairReview.verdict === 'pass') {
            answer = repairedAnswer;
            review = repairReview;
            await this.conversations.saveAnswerContract({
              sessionId: input.sessionId,
              turnId: input.turnId,
              executionOwner: input.executionOwner,
              answerText: answer.answerText,
              contract: answer,
              review,
              status: 'reviewed'
            });
            await this.conversations.upsertTurnCheckpoint({
              sessionId: input.sessionId, turnId: input.turnId, executionOwner: input.executionOwner,
              checkpoint: 'answer_contract_created', status: 'succeeded', payload: answer
            });
          } else {
            // A review must remain bound to the exact draft it judged.
            // Preserve the original if only its wording needs improvement.
            if (!review.issues.every(issue => ['customer_output_research_process_disclosure', 'manager_task_delegated_to_buyer'].includes(issue.code))) {
              answer = repairedAnswer;
              review = repairReview;
            }
          }
          } catch (error) {
            if (input.signal?.aborted || !review.issues.every(issue => ['customer_output_research_process_disclosure', 'manager_task_delegated_to_buyer'].includes(issue.code))) throw error;
            await this.trace(input.sessionId, input.turnId, 'recovery', 'editorial_repair_failed_keep_verified_original', {
              issueCodes: review.issues.map(issue => issue.code)
            });
          }
        }
      }
    }
    if (review.verdict === 'block' && review.issues.length &&
      review.issues.every(issue => issue.code === 'customer_output_research_process_disclosure')) {
      await this.trace(input.sessionId, input.turnId, 'recovery', 'editorial_issue_nonblocking', {
        issueCodes: review.issues.map(issue => issue.code)
      });
      review = { verdict: 'pass', issues: review.issues.map(issue => ({ ...issue, severity: 'low' as const })) };
    }
    const finalText = sanitizeVisibleAnswerNumbers(answer.answerText.trim());
    const finalLeadAction = leadActionAfterValidation({ answer, finalText, review, toolResults });
    if (review.verdict !== 'pass') {
      const reviewIssueCodes = review.issues.map((issue) => issue.code);
      const reviewErrorMessage = reviewIssueCodes.join(', ');
      await this.conversations.upsertTurnCheckpoint({
        sessionId: input.sessionId,
        turnId: input.turnId,
        executionOwner: input.executionOwner,
        checkpoint: 'answer_contract_created',
        status: 'failed',
        payload: answer,
        errorCode: 'answer_contract_blocked_by_validation',
        errorMessage: reviewErrorMessage
      });
      await this.conversations.upsertTurnCheckpoint({
        sessionId: input.sessionId,
        turnId: input.turnId,
        executionOwner: input.executionOwner,
        checkpoint: 'review_completed',
        status: 'failed',
        payload: review,
        errorCode: 'answer_contract_blocked_by_validation',
        errorMessage: reviewErrorMessage
      });
      await this.conversations.saveAnswerContract({
        sessionId: input.sessionId,
        turnId: input.turnId,
        executionOwner: input.executionOwner,
        answerText: answer.answerText,
        contract: answer,
        review,
        status: 'rejected'
      });
      await this.trace(input.sessionId, input.turnId, 'recovery', 'blocked_answer_checkpoint_invalidated', {
        issueCodes: reviewIssueCodes
      });
      throw new AnswerValidationBlockedError(reviewIssueCodes);
    }
    // The writer may introduce a needed clarification. Persist only questions
    // from the accepted answer, including a repaired answer, after review.
    const unregisteredQuestions = answer.questionsAsked.filter((question) => {
      const existing = ledgerState.questionsById[question.questionId];
      return !existing || existing.status === 'closed';
    });
    if (unregisteredQuestions.length) {
      const syntheticEvents = unregisteredQuestions.map((question) => DialogueLedgerEventSchema.parse({
        sessionId: input.sessionId,
        turnId: input.turnId,
        eventId: createStableLedgerEventId({
          sessionId: input.sessionId,
          turnId: input.turnId,
          eventType: 'question.asked',
          scope: 'dialogue',
          payload: { questionId: question.questionId, text: question.text, reason: question.reason },
          evidence: `Writer asked: ${question.text}`,
          source: 'system_reducer',
          status: 'active'
        }),
        eventType: 'question.asked' as const,
        scope: 'dialogue' as const,
        payload: { questionId: question.questionId, text: question.text, reason: question.reason },
        evidence: `Writer asked: ${question.text}`,
        source: 'system_reducer' as const,
        status: 'active' as const
      }));
      for (const event of syntheticEvents) {
        await this.conversations.upsertDialogueLedgerEvent({
          sessionId: event.sessionId,
          turnId: event.turnId,
          executionOwner: input.executionOwner,
          eventId: event.eventId,
          eventType: event.eventType,
          scope: event.scope,
          payload: event.payload,
          evidence: event.evidence,
          source: event.source,
          status: event.status
        });
      }
      effectiveLedgerEvents = [
        ...new Map([...effectiveLedgerEvents, ...syntheticEvents].map((event) => [event.eventId, event])).values()
      ];
      ledgerState = reduceDialogueLedger(syntheticEvents, ledgerState);
      needStateSnapshot = deriveNeedStateSnapshotFromLedger(ledgerState, needStateSnapshot);
      turnLedgerEvents.push(...syntheticEvents);
      await this.persistDialogueLedgerState({
        sessionId: input.sessionId,
        turnId: input.turnId,
        executionOwner: input.executionOwner,
        state: ledgerState,
        recentEvents: effectiveLedgerEvents,
        needState: needStateSnapshot
      });
      await this.trace(input.sessionId, input.turnId, 'ledger', 'writer_questions_registered', {
        questionIds: syntheticEvents.map((event) => event.payload.questionId)
      });
    }
    const finalToolResultIds = answer.toolResultIds;
    const finalFactsUsed = answer.factsUsed;
    const finalQuestionsAsked = answer.questionsAsked.filter((question) => {
      const existing = ledgerState.questionsById[question.questionId];
      return !existing || existing.status === 'open';
    });
    if (!savedReview.found) {
      await this.conversations.upsertTurnCheckpoint({
        sessionId: input.sessionId,
        turnId: input.turnId,
        executionOwner: input.executionOwner,
        checkpoint: 'review_completed',
        status: 'succeeded',
        payload: review
      });
    } else {
      await this.trace(input.sessionId, input.turnId, 'recovery', 'checkpoint_reused', { checkpoint: 'review_completed' });
    }
    await this.trace(input.sessionId, input.turnId, 'validation', 'completed', {
      verdict: review.verdict,
      issues: review.issues.map((issue) => issue.code)
    });
    const answerProductIds = new Set(answerProducts.map((product) => product.id));
    const finalSelectedProductIds = answer.selectedProductIds?.filter((productId) =>
      answerProductIds.has(productId)
    );
    const initialAnswerContract: AnswerContract = {
      ...answer,
      factsUsed: finalFactsUsed,
      questionsAsked: finalQuestionsAsked,
      answerText: finalText,
      toolResultIds: finalToolResultIds,
      selectedProductIds: finalSelectedProductIds,
      leadAction: finalLeadAction
    };
    let initialCardSelection = selectProductsForVisibleCards({
      products: answerProducts,
      userMessage,
      history,
      intent: effectiveIntent,
      answerText: finalText,
      selectedProductIds: initialAnswerContract.selectedProductIds,
      needState: needStateSnapshot,
      toolResults: selectionToolResults,
      allowHistoricalProducts: usingHistoricalProducts
    });
    if (usingHistoricalProducts && initialCardSelection.products.length) {
      initialCardSelection = {
        ...initialCardSelection,
        warnings: uniqueStrings([
          ...initialCardSelection.warnings,
          'product_cards_reused_from_previous_turn'
        ])
      };
    }
    const selectionReadiness = assessVisibleCardReadiness({
      cardSelection: initialCardSelection,
      answer: initialAnswerContract,
      toolResults: selectionToolResults,
      userMessage,
      intent: effectiveIntent
    });
    const cardSelection = suppressVisibleCardsForReadiness({
      cardSelection: initialCardSelection,
      readiness: selectionReadiness
    });

    // This is the last deadline gate before any state can say that cards were
    // selected for the buyer. Past this point finalization is allowed to finish.
    turnBudget.assertWallTime();
    if (cardSelection.products.length > 0) {
      const currentLedgerNeed = [...Object.values(ledgerState.needsById)].reverse().find((need) =>
        need.status === 'open' || need.status === 'selected'
      );
      const currentSnapshotNeed = [...(needStateSnapshot.activeNeeds ?? [])].reverse().find((need) =>
        need.status === 'open' || need.status === 'selected'
      );
      const currentNeedId = currentLedgerNeed?.needId ?? currentSnapshotNeed?.id;
      if (currentNeedId) {
        const visiblySelectedProductIds = cardSelection.products.map((product) => product.id);
        const previousSelectedProductIds = currentLedgerNeed?.selectedProductIds ?? currentSnapshotNeed?.selectedProductIds ?? [];
        const selectedProductIds = uniqueStrings(visiblySelectedProductIds).slice(0, 24);
        const invalidatedProductIds = uniqueStrings([
          ...answerProductEvidence.droppedProductIds,
          ...previousSelectedProductIds.filter((productId) => !selectedProductIds.includes(productId))
        ]);
        const eventWithoutId = {
          sessionId: input.sessionId,
          turnId: input.turnId,
          eventType: 'need.updated' as const,
          scope: 'need' as const,
          payload: {
            needId: currentNeedId,
            productClass: currentLedgerNeed?.productClass ?? currentSnapshotNeed?.productClass ??
              intent.selectionPolicy?.targetProductClass ?? 'unknown',
            summary: currentLedgerNeed?.summary ?? currentSnapshotNeed?.summary ?? currentNeedId,
            constraints: currentLedgerNeed?.constraints ?? currentSnapshotNeed?.constraints ?? [],
            openQuestions: currentLedgerNeed?.openQuestions ?? currentSnapshotNeed?.openQuestions ?? [],
            selectedProductIds,
            selectionUpdateMode: 'replace',
            invalidatedProductIds,
            status: selectedProductIds.length ? 'selected' : 'open',
            activate: true
          },
          evidence: selectedProductIds.length
            ? `validated_visible_product_selection:${selectedProductIds.join(',')}`
            : 'validated_visible_product_selection:none',
          source: 'system_reducer' as const,
          status: 'active' as const
        };
        const selectionEvent = DialogueLedgerEventSchema.parse({
          ...eventWithoutId,
          eventId: createStableLedgerEventId(eventWithoutId)
        });
        await this.conversations.upsertDialogueLedgerEvent({
          sessionId: selectionEvent.sessionId,
          turnId: selectionEvent.turnId,
          executionOwner: input.executionOwner,
          eventId: selectionEvent.eventId,
          eventType: selectionEvent.eventType,
          scope: selectionEvent.scope,
          payload: selectionEvent.payload,
          evidence: selectionEvent.evidence,
          source: selectionEvent.source,
          status: selectionEvent.status
        });
        effectiveLedgerEvents = [
          ...new Map([...effectiveLedgerEvents, selectionEvent].map((event) => [event.eventId, event])).values()
        ];
        turnLedgerEvents.push(selectionEvent);
        ledgerState = reduceDialogueLedger([selectionEvent], ledgerState);
        needStateSnapshot = deriveNeedStateSnapshotFromLedger(
          ledgerState,
          input.session.needState ?? emptyNeedState()
        );
        await this.persistDialogueLedgerState({
          sessionId: input.sessionId,
          turnId: input.turnId,
          executionOwner: input.executionOwner,
          state: ledgerState,
          recentEvents: effectiveLedgerEvents,
          needState: needStateSnapshot
        });
        await this.trace(input.sessionId, input.turnId, 'ledger', 'validated_product_selection_persisted', {
          needId: currentNeedId,
          selectedProductIds,
          visiblySelectedProductIds,
          deterministicallyInvalidatedProductIds: invalidatedProductIds,
          eventId: selectionEvent.eventId
        });
      }
    }

    const visibleSelectedProductIds = cardSelection.products.map((product) => product.id);
    const finalAnswerContract: AnswerContract = {
      ...answer,
      factsUsed: finalFactsUsed,
      questionsAsked: finalQuestionsAsked,
      answerText: finalText,
      toolResultIds: finalToolResultIds,
      selectedProductIds: visibleSelectedProductIds,
      leadAction: finalLeadAction,
      riskFlags: selectionReadiness.status !== 'ready_for_cards'
        ? uniqueStrings([...answer.riskFlags, 'selection_readiness_blocked_cards'])
        : answer.riskFlags
    };
    const cardEvidenceResolution = resolveProductsForEvidence({
      products: cardSelection.products,
      toolResults: selectionToolResults
    });
    const cardCaveatsByProductId: Record<string, string[]> = {
      ...(cardSelection.productCaveatsById ?? {})
    };
    for (const [productId, caveats] of Object.entries(cardEvidenceResolution.caveatsByProductId)) {
      cardCaveatsByProductId[productId] = uniqueStrings([
        ...(cardCaveatsByProductId[productId] ?? []),
        ...caveats
      ]);
    }
    const cards = productCards(
      cardEvidenceResolution.products,
      finalAnswerContract.selectionRationale?.trim()
        ? [finalAnswerContract.selectionRationale.trim()]
        : [],
      cardCaveatsByProductId
    );
    const customerOutputValidation = guardCustomerOutput({
      answerText: finalText,
      productCards: cards
    });
    if (!customerOutputValidation.ok) {
      const issueCodes = customerOutputValidation.issues.map((issue) => issue.code);
      await this.trace(input.sessionId, input.turnId, 'validation', 'customer_output_blocked', {
        issueCodes,
        evidence: customerOutputValidation.issues.map((issue) => issue.evidence)
      });
      throw new AnswerValidationBlockedError(issueCodes);
    }
    const policyGate = evaluateAgentManagerPolicyGate({
      intent: effectiveIntent,
      toolResults: selectionToolResults
    });
    const decisionArtifact = buildDecisionArtifact({
      intent: effectiveIntent,
      toolResults: selectionToolResults,
      answer: finalAnswerContract,
      policyGate,
      review
    });
    await this.trace(input.sessionId, input.turnId, 'intent', 'decision_artifact_created', {
      version: decisionArtifact.version,
      loop: decisionArtifact.loop,
      goal: decisionArtifact.goal,
      knownFacts: decisionArtifact.knownFacts,
      unknowns: decisionArtifact.unknowns,
      blockingUnknowns: decisionArtifact.blockingUnknowns,
      possibleActions: decisionArtifact.possibleActions,
      selectedAction: decisionArtifact.selectedAction,
      risk: decisionArtifact.risk,
      requiredConsent: decisionArtifact.requiredConsent,
      stopCondition: decisionArtifact.stopCondition,
      fallback: decisionArtifact.fallback,
      rationale: decisionArtifact.rationale
    });
    const failedRequiredTools = policyGate.requiredActions.filter((tool) =>
      !selectionToolResults.some((result) => result.tool === tool && result.status === 'ok')
    );
    const repairedPolicyReasons = initialPolicyGate.blockedReasons.filter((reason) =>
      !policyGate.blockedReasons.includes(reason)
    );
    const policyGateEnforcement = {
      version: 1 as const,
      mode: policyGate.ok
        ? (repairedPolicyReasons.length ? 'repair' as const : 'pass' as const)
        : 'hard_block' as const,
      hardBlockReasons: policyGate.blockedReasons,
      repairedReasons: repairedPolicyReasons,
      requiredActions: policyGate.requiredActions,
      answerConstraints: policyGate.answerConstraints,
      failedRequiredTools,
      warnings: policyGate.warnings
    };
    const runtimeDecision = getAgentManagerRuntimeDecision();
    const metadata = {
      agentManager: true,
      build: {commitSha:process.env.RAILWAY_GIT_COMMIT_SHA??process.env.GIT_COMMIT_SHA??null,version:AI_MANAGER_RUNTIME_VERSION},
      runtimeMode: runtimeDecision.runtimeMode,
      runtimeModeReason: runtimeDecision.reason,
      agentManagerRuntime: runtimeDecision,
      recovered: input.recovered,
      turnId: input.turnId,
      ledgerState,
      ledgerEventIds: turnLedgerEvents.map((event) => event.eventId),
      intentContract: intent,
      effectiveIntentContract: effectiveIntent === intent ? undefined : effectiveIntent,
      turnContract: turnContractMetadataFromIntent(intent, cards),
      policyGate,
      policyGateEnforcement,
      sourcePolicy: sourcePolicyMetadataFromIntent(effectiveIntent, selectionToolResults),
      managerPolicy: {
        packVersion: SALES_MANAGER_POLICY_PACK_VERSION,
        packHash: SALES_MANAGER_POLICY_PACK_HASH,
        selectedByPlanner: intent.policyRuleIds ?? [],
        validationMode: 'deterministic',
        answer: answerPolicyTrace
      },
      models: {
        planner: config.OPENAI_PLANNER_MODEL,
        answer: config.OPENAI_ANSWER_MODEL,
        fact: config.OPENAI_FACT_MODEL,
        deepReasoning: config.OPENAI_DEEP_REASONING_MODEL
      },
      budgetProfile: turnBudget.profile,
      turnBudget: turnBudget.snapshot(),
      decisionArtifact,
      continuation,
      verifiedProductFacts,
      conflictingVerifiedProductFacts,
      answerContract: finalAnswerContract,
      preSendValidation: review,
      consultationQuality: {
        ownership: review.issues.some(issue => issue.code === 'manager_task_delegated_to_buyer') ? 'needs_improvement' : 'not_flagged'
      },
      toolResults,
      historicalSelectionEvidence: {
        reused: historicalSelectionTools.length > 0,
        toolResultIds: historicalSelectionTools.map((result) => result.requestId),
        tools: historicalSelectionTools.map((result) => result.tool)
      },
      previousProductReferents: {
        productIds: currentProductReferents.map((product) => product.id),
        source: currentProductReferents.length ? 'visible_product_cards' : 'none'
      },
      productEvidenceRoles,
      cardSelection,
      selectionReadiness,
      answerProductEvidence,
      answerEvidenceResolution: {
        conflictsByProductId: answerEvidenceResolution.conflictsByProductId,
        warnings: answerEvidenceResolution.warnings
      },
      cardEvidenceResolution: {
        conflictsByProductId: cardEvidenceResolution.conflictsByProductId,
        warnings: cardEvidenceResolution.warnings
      },
      productCards: cards,
      needStateSnapshot,
      warnings: [
        ...ledgerState.warnings,
        ...toolResults.flatMap((result) => result.warnings),
        ...(historicalSelectionTools.length ? ['historical_selection_evidence_reused'] : []),
        ...answerProductEvidence.warnings,
        ...cardSelection.warnings,
        ...selectionReadiness.warnings
      ]
    };

    const responsePayload: ChatResponsePayload = {
      turnId: input.turnId,
      answer: finalText,
      needState: needStateSnapshot,
      productCards: cards,
      usedWebSearch: toolResults.some((result) =>
        result.tool === 'web.researchProductFacts' &&
        result.status === 'ok' &&
        (result.payload as { usedWebSearch?: unknown }).usedWebSearch === true
      ),
      leadRequested: finalLeadAction === 'offer_form',
      leadCreated: toolResults.some(isDurableLeadCaptureResult),
      metadata
    };
    const assistantMessage = await this.conversations.addAssistantMessageForTurn({
      sessionId: input.sessionId,
      turnId: input.turnId,
      content: finalText,
      metadata,
      recovered: input.recovered,
      executionOwner: input.executionOwner,
      answerContract: finalAnswerContract,
      review,
      responsePayload,
      checkpointPayload: { recovered: input.recovered }
    });
    if (!assistantMessage) {
      const completed = await this.completedPayload(input.session, input.turnId, input.onDelta);
      if (completed) return completed;
      throw new TurnExecutionInProgressError();
    }
    await input.onDelta?.(finalText);
    await this.trace(input.sessionId, input.turnId, 'turn', 'first_useful_content_emitted', {
      elapsedMs: turnBudget.snapshot().usage.wallTimeMs,
      definition: 'server emitted accepted persisted answer; excludes status events and client rendering latency',
      knownFactShortPath
    });
    await this.trace(input.sessionId, input.turnId, 'turn', 'assistant_message_saved', {
      assistantMessageId: assistantMessage.id,
      recovered: input.recovered
    });

    return {
      ...responsePayload,
      assistantMessageId: assistantMessage.id,
    };
  }

private async executeTools(input: {
    session: ConversationSession;
    turnId: string;
    executionOwner: string;
    userMessage: string;
    history: Message[];
    intent: AgentIntentContract;
    toolRequests: ToolRequest[];
    needState: CustomerNeedState;
    pendingLeadCaptureDraft: LeadCaptureDraft | null;
    persistedToolResults: Map<string, ToolResult>;
    priorProducts?: Product[];
    priorToolResults?: ToolResult[];
    documentReadContext?: ProductResearchDocumentReadContext;
    catalogResearchCache?: Map<string, ProductComparisonResearchResult>;
    freshResearchResults?: ProductComparisonResearchResult[];
    budget: AgentManagerTurnBudget;
    signal?: AbortSignal;
  }) {
    return this.toolExecutor.executeTools(input);
  }

private async canUseProductEmbeddings(signal?: AbortSignal) {
    return this.toolExecutor.canUseProductEmbeddings(signal);
  }

private async createCachedQueryEmbedding(text: string, signal?: AbortSignal) {
    return this.toolExecutor.createCachedQueryEmbedding(text, signal);
  }

private async searchCatalogProducts(input: {
    query: string;
    limit: number;
    signal?: AbortSignal;
    productIntent?: ProductSelectionClass;
    powerSource?: 'battery' | 'fuel' | 'mains' | 'any';
    embeddingQuery?: string;
    budgetMax?: number;
    intent?: AgentIntentContract;
    toolResults?: ToolResult[];
    allowPrimaryExpansion?: boolean;
  }) {
    return this.toolExecutor.searchCatalogProducts(input);
  }

private async review(
    input: AgentManagerReviewInput,
    budget?: AgentManagerTurnBudget
  ): Promise<PreSendReview> {
    return validateAgentAnswer(this.model,input,budget);
  }

  private async completedPayload(
    session: ConversationSession,
    turnId: string,
    onDelta?: (text: string) => void | Promise<void>
  ): Promise<ChatResponsePayload | null> {
    const turn = await this.conversations.getTurn(session.id, turnId);
    if (!turn?.assistantMessageId || !['completed', 'recovered'].includes(turn.status)) return null;
    const history = await this.conversations.listMessages(session.id, 80);
    const message = history.find((item) => item.id === turn.assistantMessageId && item.role === 'assistant');
    if (!message?.content?.trim()) return null;
    await onDelta?.(message.content);
    const needState = (message.metadata?.needStateSnapshot as CustomerNeedState | undefined) ?? session.needState ?? emptyNeedState();
    const runtimeDecision = getAgentManagerRuntimeDecision();
    return {
      turnId,
      answer: message.content,
      needState,
      productCards: (message.metadata?.productCards as ProductCard[] | undefined) ?? [],
      usedWebSearch: Boolean(message.metadata?.usedWebSearch),
      assistantMessageId: message.id,
      metadata: {
        ...(message.metadata ?? {}),
        agentManager: true,
        runtimeMode: runtimeDecision.runtimeMode,
        runtimeModeReason: runtimeDecision.reason,
        agentManagerRuntime: runtimeDecision,
        recoveredFromExistingTurn: true
      }
    };
  }

  private async completedFromFinalAnswerContract(
    session: ConversationSession,
    turnId: string,
    recovered: boolean,
    executionOwner: string,
    onDelta?: (text: string) => void | Promise<void>
  ): Promise<ChatResponsePayload | null> {
    const row = await this.conversations.getFinalAnswerContract(session.id, turnId);
    const savedPayload = parseSavedChatResponsePayload(row?.response_payload);
    const answerText = savedPayload?.answer.trim() ?? (typeof row?.answer_text === 'string' ? row.answer_text.trim() : '');
    if (!answerText) return null;
    if (savedPayload && typeof row?.answer_text === 'string' && row.answer_text.trim() !== answerText) {
      throw new Error('saved_response_payload_answer_mismatch');
    }
    const needStateSnapshot = savedPayload?.needState ?? deriveNeedStateSnapshotFromLedger(
      (await this.loadDialogueLedgerContext(session.id)).state,
      session.needState ?? emptyNeedState()
    );
    const runtimeDecision = getAgentManagerRuntimeDecision();
    const metadata = savedPayload?.metadata ?? {
      agentManager: true,
      runtimeMode: runtimeDecision.runtimeMode,
      runtimeModeReason: runtimeDecision.reason,
      agentManagerRuntime: runtimeDecision,
      recovered,
      recoveredFromAnswerContract: true,
      turnId,
      answerContract: row.contract,
      preSendValidation: row.review,
      needStateSnapshot
    };
    const assistantMessage = await this.conversations.addAssistantMessageForTurn({
      sessionId: session.id,
      turnId,
      content: answerText,
      metadata,
      recovered,
      executionOwner,
      answerContract: row.contract,
      review: row.review,
      responsePayload: savedPayload ?? {
        turnId,
        answer: answerText,
        needState: needStateSnapshot,
        productCards: [],
        usedWebSearch: false,
        leadRequested: false,
        leadCreated: false,
        metadata
      },
      checkpointPayload: { recoveredFromAnswerContract: true }
    });
    if (!assistantMessage) {
      const completed = await this.completedPayload(session, turnId, onDelta);
      if (completed) return completed;
      throw new TurnExecutionInProgressError();
    }
    await onDelta?.(answerText);
    await this.trace(session.id, turnId, 'turn', 'assistant_message_saved_from_answer_contract', {
      assistantMessageId: assistantMessage.id,
      recovered
    });
    if (savedPayload) {
      return { ...savedPayload, assistantMessageId: assistantMessage.id };
    }
    return {
      turnId,
      answer: answerText,
      needState: needStateSnapshot,
      productCards: [],
      usedWebSearch: false,
      assistantMessageId: assistantMessage.id,
      metadata
    };
  }

  private async trace(sessionId: string, turnId: string, phase: string, eventType: string, payload: Record<string, unknown>) {
    return recordTurnTelemetry(this.conversations,sessionId,turnId,phase,eventType,payload);
  }
}
