import { recordTurnTelemetry, runWithTurnStageEmitter, type AgentManagerStageEmitter } from './turnTelemetry.js';
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



function groundedBuyerQuestion(buyerQuestion: string | null | undefined, history: Message[]) {
  const question = buyerQuestion?.trim() ?? '';
  if (!question || question.length > 1_000 || buyerQuestionContainsContactPii(question)) return null;
  return history.some((message) => message.role === 'user' && message.content.includes(question))
    ? question
    : null;
}





function blockedLeadReplayResult(request: ToolRequest) {
  return ToolResultSchema.parse({
    requestId: request.id,
    tool: request.tool,
    status: 'denied',
    payload: { reason: 'unverifiable_persisted_lead_side_effect' },
    warnings: ['lead_capture_reexecution_blocked_unverifiable_side_effect']
  });
}


function isBlockedLeadReplayResult(result: ToolResult) {
  return result.tool === 'lead.capture' &&
    result.status === 'denied' &&
    result.warnings.includes('lead_capture_reexecution_blocked_unverifiable_side_effect');
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



function durableLeadOutboxStatus(row: unknown) {
  if (!row || typeof row !== 'object') return null;
  const status = (row as { status?: unknown }).status;
  return status === 'pending' || status === 'sending' || status === 'sent' || status === 'failed'
    ? status
    : null;
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


function typedProductClassKey(canonicalValue: unknown, fallbackValue: unknown) {
  const canonicalClass = coerceVisibleCardIntent(canonicalValue);
  if (canonicalClass !== 'unknown') return canonicalClass;
  if (typeof fallbackValue !== 'string' || !fallbackValue.trim()) return null;
  const fallbackClass = fallbackValue.trim().toLocaleLowerCase('ru-RU');
  return fallbackClass === 'unknown' ? null : fallbackClass;
}




function productMentionRoleForTargetName(intent: AgentIntentContract | undefined, targetName: string) {
  const mentions = intent?.productMentions ?? [];
  const matching = mentions.filter((mention) => productMentionMatchesName(mention.name, targetName));
  if (!matching.length) return undefined;
  const targetLike = matching.find((mention) => exactTargetProductMentionRoles.has(mention.role));
  return targetLike?.role ?? matching[0]?.role;
}

function productNameAllowedAsExactTarget(input: {
  intent?: AgentIntentContract;
  productName: string;
}) {
  const role = productMentionRoleForTargetName(input.intent, input.productName);
  return role === undefined || exactTargetProductMentionRoles.has(role);
}

function targetProductNamesForRequest(request: ToolRequest, intent?: AgentIntentContract) {
  return uniqueStrings(
    requestStringArray(request.args.productNames).filter((productName) =>
      productNameAllowedAsExactTarget({ intent, productName })
    )
  );
}

function suppressedContextTargetProductNamesForRequest(request: ToolRequest, intent?: AgentIntentContract) {
  const targetNames = requestStringArray(request.args.productNames);
  if (!targetNames.length || !(intent?.productMentions?.length)) return [];
  return uniqueStrings(targetNames.filter((productName) =>
    !productNameAllowedAsExactTarget({ intent, productName })
  ));
}

function comparisonAttributesForRequest(request: ToolRequest) {
  return uniqueStrings(requestStringArray(request.args.comparisonAttributes));
}

function comparisonAttributeBindingsForRequest(request: ToolRequest) {
  const bindings = (request.args as {
    comparisonAttributeBindings?: unknown;
  }).comparisonAttributeBindings;
  if (!Array.isArray(bindings)) return [];
  return bindings.flatMap((binding) => {
    if (!binding || typeof binding !== 'object') return [];
    const attribute = typeof (binding as { attribute?: unknown }).attribute === 'string'
      ? (binding as { attribute: string }).attribute.trim()
      : '';
    const requirementId = typeof (binding as { requirementId?: unknown }).requirementId === 'string'
      ? (binding as { requirementId: string }).requirementId.trim()
      : '';
    return attribute && requirementId ? [{ attribute, requirementId }] : [];
  });
}

function productLookupText(product: Product) {
  return [
    product.name,
    product.brand,
    product.externalId,
    product.slug,
    product.sourceUrl
  ].filter(Boolean).join(' ');
}



function productMatchesTargetName(product: Product, targetName: string) {
  return textMatchesTargetName(productLookupText(product), targetName);
}

export function productMatchesExactTargetIdentity(product: Product, targetName: string) {
  const identity = exactProductIdentity(targetName);
  return identity.decisiveParts.length > 0 && identity.matches(productLookupText(product));
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



function resolvedToolProductIntent(request: ToolRequest, intent: AgentIntentContract) {
  const requestClass = toolRequestProductIntent(request);
  if (requestClass !== 'unknown') return requestClass;
  if (typedProductClassKey(request.args.canonicalProductIntent, request.args.productIntent) !== null) {
    return 'unknown';
  }
  return canonicalProductClassFromIntent(intent);
}

function toolRequestTargetsPrimarySelectionClass(request: ToolRequest, intent: AgentIntentContract) {
  const requestClassKey = typedProductClassKey(
    request.args.canonicalProductIntent,
    request.args.productIntent
  );
  const policyClassKey = typedProductClassKey(
    intent.selectionPolicy?.canonicalProductClass,
    intent.selectionPolicy?.targetProductClass
  );
  return requestClassKey === null || policyClassKey === null || requestClassKey === policyClassKey;
}

export function productsMatchingToolRequestIntent(input: {
  products: Product[];
  request: ToolRequest;
  intent: AgentIntentContract;
}) {
  // Product class is semantic evidence for the writer, not a regex-owned hard
  // exclusion. The typed tool request already scopes retrieval; preserve every
  // returned candidate so the LLM can resolve uncertain or unfamiliar classes.
  return input.products;
}

function resolvedToolPowerSource(request: ToolRequest, intent: AgentIntentContract) {
  const value = request.args.powerSource ?? intent.selectionPolicy?.powerSource;
  return value === 'battery' || value === 'fuel' || value === 'mains' || value === 'any'
    ? value
    : undefined;
}

class AnswerValidationBlockedError extends Error {
  readonly code = 'answer_contract_blocked_by_validation';

  constructor(readonly issueCodes: string[]) {
    super(`Agent manager answer blocked: ${issueCodes.join(', ')}`);
    this.name = 'AnswerValidationBlockedError';
  }
}

const TURN_COMMIT_RESERVE_MS = 5_000;
const WEB_ANSWER_RESERVE_MS = 30_000;
const WEB_MIN_EXECUTION_MS = 6_000;
const CATALOG_ANSWER_RESERVE_MS = 8_000;
const CURRENT_PRICE_VERIFICATION_TOP_K = 6;
const SEMANTIC_DECISION_ATTEMPT_TIMEOUT_MS = 45_000;
const SEMANTIC_DECISION_DOWNSTREAM_RESERVE_MS = 45_000;

export function effectiveAgentToolTimeoutMs(input: {
  tool: ToolRequest['tool'];
  configuredTimeoutMs: number;
  remainingWallTimeMs: number;
}) {
  const reserveMs = input.tool === 'web.researchProductFacts'
    ? WEB_ANSWER_RESERVE_MS
    : input.tool === 'catalog.search' || input.tool === 'catalog.getProductDetails'
      ? CATALOG_ANSWER_RESERVE_MS
      : 0;
  return Math.min(input.configuredTimeoutMs, Math.max(1, input.remainingWallTimeMs - reserveMs));
}

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

function productsFromPersistedToolResult(result: ToolResult): Product[] {
  const products = (result.payload as { products?: unknown }).products;
  if (!Array.isArray(products)) return [];
  return products.filter((item): item is Product => Boolean(
    item &&
    typeof item === 'object' &&
    typeof (item as { id?: unknown }).id === 'string' &&
    typeof (item as { name?: unknown }).name === 'string'
  ));
}

function maximumToolResultItemCount(value: unknown): number {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 0;
  const payload = value as Record<string, unknown>;
  const retrieval = payload.retrieval && typeof payload.retrieval === 'object' && !Array.isArray(payload.retrieval)
    ? payload.retrieval as Record<string, unknown>
    : {};
  const boundedCollections = [
    payload.products,
    payload.productIds,
    payload.facts,
    payload.catalogPresence,
    payload.nearbyCatalogProducts,
    payload.loads,
    payload.coverage,
    retrieval.candidateTiers
  ];
  return Math.max(0, ...boundedCollections.map((item) => Array.isArray(item) ? item.length : 0));
}

function assertToolResultBounds(result: ToolResult) {
  const definition = agentManagerToolRegistry[result.tool];
  const bytes = toolResultByteLength(result);
  if (bytes > definition.maxResultBytes) {
    throw new Error(`tool_result_too_large:${result.requestId}:${bytes}`);
  }
  const maxItems = maximumToolResultItemCount(result.payload);
  if (maxItems > definition.maxResultItems) {
    throw new Error(`tool_result_too_many_items:${result.requestId}:${maxItems}`);
  }
  return bytes;
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

function productMeetsStructuredPowerSource(
  product: Product,
  required: 'battery' | 'fuel' | 'mains' | 'any' | null | undefined
) {
  if (!required || required === 'any') return true;
  const source = productPowerSource(product);
  if (source === 'unknown') return true;
  if (required === 'battery') return source === 'battery';
  if (required === 'fuel') return source === 'gasoline' || source === 'diesel';
  return false;
}

function hardSelectionNumber(intent: AgentIntentContract, kinds: string[]) {
  const accepted = new Set(kinds);
  for (const requirement of intent.selectionPolicy?.requirements ?? []) {
    if (
      requirement.role !== 'hard_constraint' ||
      requirement.strictness !== 'strict' ||
      !accepted.has(requirement.kind)
    ) continue;
    const value = typeof requirement.value === 'number'
      ? requirement.value
      : typeof requirement.value === 'string'
        ? Number(requirement.value)
        : Number.NaN;
    if (Number.isFinite(value) && value >= 0) return value;
  }
  return undefined;
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

function resolvedEligibilityStatusForStrictKinds(input: {
  proofs: ReturnType<typeof buildRequirementProofs>;
  productId: string;
  intent: AgentIntentContract;
  kinds: string[];
}) {
  const acceptedKinds = new Set(input.kinds);
  const requirementIds = (input.intent.selectionPolicy?.requirements ?? []).flatMap((requirement) =>
    requirement.role === 'hard_constraint' &&
    requirement.strictness === 'strict' &&
    acceptedKinds.has(requirement.kind)
      ? [requirement.id]
      : []
  );
  return resolvedRequirementEligibilityStatus(requirementProofsFor(
    input.proofs,
    input.productId,
    requirementIds
  ));
}

function passesNativeConstraintOrResolvedProof(input: {
  proofs: ReturnType<typeof buildRequirementProofs>;
  productId: string;
  intent: AgentIntentContract;
  kinds: string[];
  nativeMatch: boolean;
  finalFit: boolean;
  nativeKnown?: boolean;
}): 'ok' | 'conflict' | 'unconfirmed' {
  const proofStatus = resolvedEligibilityStatusForStrictKinds(input);
  const nativeKnown = input.nativeKnown ?? true;
  // The product card itself does not carry the attribute: evidence cannot be
  // checked natively, so an unsatisfied proof is a data gap, not a conflict.
  if (!nativeKnown) {
    if (proofStatus === 'violated') return 'conflict';
    if (proofStatus === 'satisfied') return 'ok';
    return input.finalFit ? 'unconfirmed' : 'ok';
  }
  if (proofStatus === 'satisfied') return 'ok';
  if (proofStatus === 'violated') return 'conflict';
  if (proofStatus === 'unknown') {
    if (input.nativeMatch) return 'ok';
    return input.finalFit ? 'conflict' : 'ok';
  }
  return input.nativeMatch ? 'ok' : 'conflict';
}

export function filterProductsByStructuredSelectionPolicy(input: {
  products: Product[];
  intent: AgentIntentContract;
  toolResults: ToolResult[];
}) {
  if (!input.intent.selectionPolicy) {
    return { products: input.products, droppedProductIds: [] as string[], warnings: [] as string[] };
  }
  const canonicalClass = canonicalProductClassFromIntent(input.intent);
  const budgetMax = hardSelectionNumber(input.intent, ['budget_max_rub', 'price_max_rub']);
  const weightMin = hardSelectionNumber(input.intent, ['weight_min_kg']);
  const weightMax = hardSelectionNumber(input.intent, ['weight_max_kg']);
  const explicitPowerMin = hardSelectionNumber(input.intent, ['nominal_power_min_kw', 'power_min_kw']);
  const powerMax = hardSelectionNumber(input.intent, ['nominal_power_max_kw', 'power_max_kw']);
  const policy = input.intent.selectionPolicy;
  const requirementProofs = buildRequirementProofs({
    intent: input.intent,
    products: input.products,
    toolResults: input.toolResults
  });
  const strictRequirementAssessment = gateStrictSelectionRequirements(
    input.intent,
    canonicalClass,
    input.toolResults,
    input.products
  );
  if (strictRequirementAssessment.blockers.length) {
    // Catalog-presence questions ("есть ли у вас X?") must be answered from the
    // exact card the details tool just returned. Wiping products here makes the
    // writer report a present model as absent. Keep class/exact-target matches
    // visible as preliminary evidence; strict-attribute fit stays unconfirmed.
    const presenceRelevant = input.intent.grounding?.taskType === 'availability_or_delivery' ||
      (input.intent.riskFlags ?? []).includes('answer_policy_catalog_presence_relevant');
    if (presenceRelevant) {
      const keptProducts = input.products;
      return {
        products: keptProducts,
        droppedProductIds: input.products
          .filter((product) => !keptProducts.some((kept) => kept.id === product.id))
          .map((product) => product.id),
        warnings: uniqueStrings([
          `answer_products_suppressed:unsupported_or_unverifiable_strict_hard_constraint:${strictRequirementAssessment.blockers.length}`,
          'answer_products_preliminary:presence_kept_despite_unverified_strict_attributes'
        ])
      };
    }
    return {
      products: [],
      droppedProductIds: input.products.map((product) => product.id),
      warnings: [`answer_products_suppressed:unsupported_or_unverifiable_strict_hard_constraint:${strictRequirementAssessment.blockers.length}`]
    };
  }
  const calculatorNominalPowerMin = generatorLoadRequirementKw(input.toolResults);
  const derivedNominalPowerMin = strictRequirementAssessment.generatorNominalPowerMinKw === undefined
    ? calculatorNominalPowerMin
    : calculatorNominalPowerMin === undefined
      ? strictRequirementAssessment.generatorNominalPowerMinKw
      : Math.max(strictRequirementAssessment.generatorNominalPowerMinKw, calculatorNominalPowerMin);
  const exactTargetNames = (input.intent.productMentions ?? [])
    .filter((mention) => exactTargetProductMentionRoles.has(mention.role))
    .map((mention) => mention.name);
  const strictRequirements = policy.requirements.filter((requirement) =>
    requirement.role === 'hard_constraint' && requirement.strictness === 'strict'
  );
  const proofBackedRequirementIds = new Set(requirementProofs.flatMap((proof) =>
    proof.sourceResultIds.length ? [proof.requirementId] : []
  ));
  const genericRequirementIds = strictRequirements.flatMap((requirement) => {
    return requirementUsesGenericReadProof(requirement) && proofBackedRequirementIds.has(requirement.id)
      ? [requirement.id]
      : [];
  });
  const phaseRequirementIds = strictRequirements.flatMap((requirement) =>
    requirement.kind === 'phase' || requirement.kind === 'voltage_v' ? [requirement.id] : []
  );
  const finalFit = (policy.selectionGoal ?? 'final_fit') === 'final_fit';
  const needsNativeCheck = (kinds: string[]) =>
    strictRequirements.some((requirement) => kinds.includes(requirement.kind));
  // Unknown evidence is not a proven conflict. Confirmed products rank first;
  // candidates whose only failure is a missing/unchecked attribute stay in the
  // pool as preliminary so the writer can show real alternatives instead of a
  // single "perfect card" model.
  const confirmedProducts: Product[] = [];
  const unconfirmedProducts: Array<{ product: Product; reasons: string[] }> = [];
  for (const product of input.products) {
    let unconfirmed = false;
    let dropped = false;
    const markUnconfirmed = () => { if (!dropped) unconfirmed = true; };
    if (
      !dropped &&
      policy.alternativePolicy === 'exact_only' &&
      exactTargetNames.length > 0 &&
      !exactTargetNames.some((targetName) => productMatchesTargetName(product, targetName))
    ) dropped = true;
    if (!dropped) {
      for (const requirementId of genericRequirementIds) {
        const proofStatus = resolvedRequirementEligibilityStatus(requirementProofsFor(
          requirementProofs,
          product.id,
          [requirementId]
        ));
        if (proofStatus === 'violated') {
          dropped = true;
          break;
        }
        if (proofStatus !== 'satisfied') markUnconfirmed();
      }
    }
    if (!dropped && budgetMax !== undefined) {
      if (typeof product.price === 'number' && Number.isFinite(product.price)) {
        if (product.price > budgetMax) dropped = true;
      } else {
        markUnconfirmed();
      }
    }
    if (!dropped) {
      const weightProofStatus = resolvedEligibilityStatusForStrictKinds({
        proofs: requirementProofs,
        productId: product.id,
        intent: input.intent,
        kinds: ['weight_min_kg', 'weight_max_kg']
      });
      if (weightProofStatus === 'violated') dropped = true;
      else if (
        weightProofStatus !== 'satisfied' &&
        (weightMin !== undefined || weightMax !== undefined)
      ) {
        const weight = extractWeightKg(product);
        if (weight === undefined) markUnconfirmed();
        else {
          if (weightMin !== undefined && weight < weightMin) dropped = true;
          if (!dropped && weightMax !== undefined && weight > weightMax) dropped = true;
        }
      }
    }
    if (!dropped) {
      const powerProofStatus = resolvedEligibilityStatusForStrictKinds({
        proofs: requirementProofs,
        productId: product.id,
        intent: input.intent,
        kinds: ['nominal_power_min_kw', 'power_min_kw', 'nominal_power_max_kw', 'power_max_kw']
      });
      if (powerProofStatus === 'violated') dropped = true;
      else if (
        powerProofStatus !== 'satisfied' &&
        (explicitPowerMin !== undefined || powerMax !== undefined)
      ) {
        const nominal = qualifiedNominalActivePowerKw(product);
        if (nominal === undefined) markUnconfirmed();
        else {
          if (explicitPowerMin !== undefined && nominal < explicitPowerMin) dropped = true;
          if (!dropped && powerMax !== undefined && nominal > powerMax) dropped = true;
        }
      }
      if (
        !dropped &&
        derivedNominalPowerMin !== undefined &&
        (calculatorNominalPowerMin !== undefined || powerProofStatus !== 'satisfied')
      ) {
        const nominal = qualifiedNominalActivePowerKw(product);
        if (nominal !== undefined && nominal < derivedNominalPowerMin) dropped = true;
        if (nominal === undefined) markUnconfirmed();
      }
    }
    if (!dropped && policy.powerSource && policy.powerSource !== 'any') {
      const source = productPowerSource(product);
      const nativeMatch = policy.powerSource === 'battery'
        ? source === 'battery'
        : policy.powerSource === 'fuel'
          ? source === 'gasoline' || source === 'diesel'
          : false;
      const outcome = passesNativeConstraintOrResolvedProof({
        proofs: requirementProofs,
        productId: product.id,
        intent: input.intent,
        kinds: ['power_source', 'fuel_type'],
        nativeMatch,
        finalFit,
        nativeKnown: source !== 'unknown'
      });
      if (outcome === 'conflict') dropped = true;
      if (outcome === 'unconfirmed') markUnconfirmed();
    }
    if (!dropped && policy.phase && policy.phase !== 'any') {
      const proofStatus = resolvedRequirementEligibilityStatus(requirementProofsFor(
        requirementProofs,
        product.id,
        phaseRequirementIds
      ));
      if (proofStatus === 'violated') dropped = true;
      else if (proofStatus !== 'satisfied') {
        const phase = generatorPhaseProfile(product);
        if (phase === 'unknown') markUnconfirmed();
        else {
          if (policy.phase === 'single_phase' && phase !== 'single_220') dropped = true;
          if (!dropped && policy.phase === 'three_phase' && phase !== 'three_phase_380' && phase !== 'mixed_220_380') dropped = true;
        }
      }
    }
    if (!dropped && needsNativeCheck(['auto_start_required', 'autostart_required'])) {
      const autoStartOutcome = passesNativeConstraintOrResolvedProof({
        proofs: requirementProofs,
        productId: product.id,
        intent: input.intent,
        kinds: ['auto_start_required', 'autostart_required'],
        nativeMatch: productMeetsSupportedStrictAutoStartRequirement(product, input.intent, canonicalClass),
        finalFit,
        nativeKnown: generatorAutoStartProfile(product) !== 'unknown'
      });
      if (autoStartOutcome === 'conflict') dropped = true;
      if (autoStartOutcome === 'unconfirmed') markUnconfirmed();
    }
    if (!dropped && needsNativeCheck(['remote_start', 'remote_start_required'])) {
      const remoteStartProfile = generatorRemoteStartProfile(product);
      const remoteStartOutcome = passesNativeConstraintOrResolvedProof({
        proofs: requirementProofs,
        productId: product.id,
        intent: input.intent,
        kinds: ['remote_start', 'remote_start_required'],
        nativeMatch: productMeetsSupportedStrictRemoteStartRequirement(product, input.intent, canonicalClass),
        finalFit,
        nativeKnown: remoteStartProfile !== 'unknown'
      });
      if (remoteStartOutcome === 'conflict') dropped = true;
      if (remoteStartOutcome === 'unconfirmed' || remoteStartProfile === 'unknown') markUnconfirmed();
    }
    if (!dropped && needsNativeCheck(['fuel_type', 'power_source'])) {
      const fuelOutcome = passesNativeConstraintOrResolvedProof({
        proofs: requirementProofs,
        productId: product.id,
        intent: input.intent,
        kinds: ['fuel_type', 'power_source'],
        nativeMatch: productMeetsSupportedStrictFuelRequirement(product, input.intent, canonicalClass),
        finalFit,
        nativeKnown: productPowerSource(product) !== 'unknown'
      });
      if (fuelOutcome === 'conflict') dropped = true;
      if (fuelOutcome === 'unconfirmed') markUnconfirmed();
    }
    if (!dropped && needsNativeCheck(['material'])) {
      const materialOutcome = resolvedEligibilityStatusForStrictKinds({
        proofs: requirementProofs,
        productId: product.id,
        intent: input.intent,
        kinds: ['material']
      });
      if (materialOutcome === 'violated') dropped = true;
      if (materialOutcome !== 'satisfied' && materialOutcome !== 'violated') markUnconfirmed();
    }
    if (!dropped && !productMeetsSupportedStrictPriceVisibilityRequirement(product, input.intent)) dropped = true;
    if (!dropped && needsNativeCheck(['voltage_v'])) {
      const voltageOutcome = passesNativeConstraintOrResolvedProof({
        proofs: requirementProofs,
        productId: product.id,
        intent: input.intent,
        kinds: ['voltage_v'],
        nativeMatch: productMeetsSupportedStrictVoltageRequirement(product, input.intent, canonicalClass),
        finalFit,
        nativeKnown: generatorPhaseProfile(product) !== 'unknown'
      });
      if (voltageOutcome === 'conflict') dropped = true;
      if (voltageOutcome === 'unconfirmed') markUnconfirmed();
    }
    if (dropped) continue;
    if (unconfirmed) unconfirmedProducts.push({ product, reasons: ['evidence_unconfirmed'] });
    else confirmedProducts.push(product);
  }
  const products = [...confirmedProducts, ...unconfirmedProducts.map((item) => item.product)];
  const kept = new Set(products.map((product) => product.id));
  const droppedProductIds = input.products.filter((product) => !kept.has(product.id)).map((product) => product.id);
  return {
    products,
    droppedProductIds,
    warnings: uniqueStrings([
      ...(strictRequirementAssessment.preliminaryUnverified.length
        ? [`answer_products_preliminary:unverified_web_covered_strict_requirements:${strictRequirementAssessment.preliminaryUnverified.length}`]
        : []),
      ...(input.products.length !== products.length
        ? [`answer_products_filtered_by_structured_hard_constraints:${input.products.length - products.length}`]
        : []),
      ...(unconfirmedProducts.length
        ? [`answer_products_preliminary:unknown_evidence_kept:${unconfirmedProducts.length}`]
        : [])
    ])
  };
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

export function catalogCandidatesSatisfyingConditionalWebRequest(input: {
  request: ToolRequest;
  intent: AgentIntentContract;
  toolResults: ToolResult[];
  products: Product[];
}) {
  if (
    input.request.tool !== 'web.researchProductFacts' ||
    input.intent.grounding?.taskType !== 'product_selection' ||
    input.intent.grounding?.webRequirement !== 'conditional_on_catalog_gap' ||
    input.intent.selectionPolicy?.selectionGoal !== 'preliminary_fit' ||
    productNamesFromToolRequest(input.request).length > 0 ||
    (input.intent.productMentions ?? []).some((mention) => exactTargetProductMentionRoles.has(mention.role))
  ) return [] as Product[];

  const coveredRequirementIds = uniqueStrings(input.request.coversRequirementIds ?? []);
  if (!coveredRequirementIds.length) return [] as Product[];
  const requirementsById = new Map(
    (input.intent.selectionPolicy?.requirements ?? []).map((requirement) => [requirement.id, requirement])
  );
  const coveredRequirements = coveredRequirementIds.map((id) => requirementsById.get(id));
  const comparisonAttributes = comparisonAttributesForRequest(input.request);
  const comparisonAttributeBindings = comparisonAttributeBindingsForRequest(input.request);
  const normalizedComparisonAttributes = comparisonAttributes.map((attribute) => normalizeModelText(attribute));
  const boundRequirementIds = uniqueStrings(comparisonAttributeBindings.map((binding) => binding.requirementId));
  const hasComparisonRequest = comparisonAttributes.length > 0 || comparisonAttributeBindings.length > 0;
  if (
    coveredRequirements.some((requirement) =>
      !requirement || requirement.verification?.mode !== 'product_attribute'
    ) ||
    (hasComparisonRequest && (
      comparisonAttributes.length === 0 ||
      comparisonAttributeBindings.length !== comparisonAttributes.length ||
      new Set(normalizedComparisonAttributes).size !== comparisonAttributes.length ||
      new Set(comparisonAttributeBindings.map((binding) => normalizeModelText(binding.attribute))).size !== comparisonAttributes.length ||
      comparisonAttributeBindings.some((binding) => {
        const comparisonAttributeIndex = normalizedComparisonAttributes.indexOf(normalizeModelText(binding.attribute));
        const requirement = requirementsById.get(binding.requirementId);
        return comparisonAttributeIndex < 0 ||
          !coveredRequirementIds.includes(binding.requirementId) ||
          requirement?.verification?.mode !== 'product_attribute' ||
          !selectionRequirementAttributeMatches(binding.attribute, requirement.kind);
      }) ||
      boundRequirementIds.length !== coveredRequirementIds.length ||
      coveredRequirementIds.some((requirementId) => !boundRequirementIds.includes(requirementId))
    )) ||
    !input.toolResults.some((result) => result.tool === 'catalog.search' && result.status === 'ok')
  ) return [] as Product[];

  const coveredRequirementIdSet = new Set(coveredRequirementIds);
  const otherwiseValidProducts = filterProductsByStructuredSelectionPolicy({
    products: input.products,
    intent: {
      ...input.intent,
      selectionPolicy: input.intent.selectionPolicy
        ? {
            ...input.intent.selectionPolicy,
            requirements: input.intent.selectionPolicy.requirements.filter((requirement) =>
              !coveredRequirementIdSet.has(requirement.id)
            )
          }
        : undefined
    },
    toolResults: input.toolResults
  }).products;
  if (!otherwiseValidProducts.length) return [] as Product[];
  const otherwiseValidProofs = buildRequirementProofs({
    intent: input.intent,
    products: otherwiseValidProducts,
    toolResults: input.toolResults
  });
  const hasPlausibleCandidateStillNeedingWeb = otherwiseValidProducts.some((product) =>
    coveredRequirementIds.some((requirementId) => {
      const status = combinedRequirementProofStatus(requirementProofsFor(
        otherwiseValidProofs,
        product.id,
        [requirementId]
      ));
      return status !== 'satisfied' && status !== 'violated';
    })
  );
  if (hasPlausibleCandidateStillNeedingWeb) return [] as Product[];

  const mechanicallyValid = filterProductsByStructuredSelectionPolicy({
    products: input.products,
    intent: input.intent,
    toolResults: input.toolResults
  }).products;
  if (!mechanicallyValid.length) return [] as Product[];
  const proofs = buildRequirementProofs({
    intent: input.intent,
    products: mechanicallyValid,
    toolResults: input.toolResults
  });
  return mechanicallyValid.filter((product) => coveredRequirementIds.every((requirementId) =>
    combinedRequirementProofStatus(requirementProofsFor(proofs, product.id, [requirementId])) === 'satisfied'
  ));
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

export function allowCatalogOnlyResearchForWebRequest(
  intent: AgentIntentContract,
  request: ToolRequest
) {
  const taskType = intent.grounding?.taskType;
  const requestIndex = intent.toolRequests.findIndex((candidate) =>
    candidate.id === request.id && candidate.tool === request.tool
  );
  const priorRequests = requestIndex > 0
    ? intent.toolRequests.slice(0, requestIndex)
    : [];
  const hasRequiredCatalogLookup = taskType === 'comparison'
    ? priorRequests.some((candidate) => candidate.tool === 'catalog.getProductDetails')
    : priorRequests.some((candidate) =>
        candidate.tool === 'catalog.search' || candidate.tool === 'catalog.getProductDetails'
      );
  return request.tool === 'web.researchProductFacts' &&
    (intent.grounding?.sourcePolicy === 'catalog_required' || intent.grounding?.sourcePolicy === 'web_required') &&
    intent.grounding.webRequirement === 'conditional_on_catalog_gap' &&
    intent.selectionPolicy?.selectionGoal === 'preliminary_fit' &&
    (taskType === 'product_selection' || taskType === 'comparison') &&
    hasRequiredCatalogLookup;
}

type SelectionCandidateTier = 'exact_match' | 'preliminary_match' | 'rejected';

function visibleSelectionTier(intent: AgentIntentContract): Exclude<SelectionCandidateTier, 'rejected'> {
  return intent.selectionPolicy?.selectionGoal === 'final_fit'
    ? 'exact_match'
    : 'preliminary_match';
}

function structuredCatalogExpansionQuery(
  productClass: ProductSelectionClass,
  targetProductClass?: string | null
) {
  const canonicalQueries: Partial<Record<ProductSelectionClass, string>> = {
    generator: 'генератор электростанция',
    weldingGenerator: 'сварочный генератор',
    plate: 'виброплита',
    plateAccessory: 'аксессуар для виброплиты',
    rammer: 'вибротрамбовка',
    roller: 'виброкаток',
    cutter: 'швонарезчик бензорез резчик',
    diamondBlade: 'алмазный диск',
    diamondCore: 'алмазная коронка',
    trowel: 'затирочная машина',
    generatorOil: 'масло для генератора',
    engineOil: 'моторное масло',
    generatorAccessory: 'аксессуар для генератора'
  };
  return [targetProductClass, canonicalQueries[productClass], productClass === 'unknown' ? undefined : productClass]
    .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    .join(' ');
}

function nonTargetMentionModelTokens(intent: AgentIntentContract) {
  return new Set((intent.productMentions ?? [])
    .filter((mention) => !exactTargetProductMentionRoles.has(mention.role))
    .flatMap((mention) => modelIdentifierTokens(mention.name)));
}
function targetBrandCandidates(targetNames: string[]) {
  const genericProductWords = new Set([
    'generator',
    'generators',
    'gasoline',
    'diesel',
    'electric',
    'benzinovyj',
    'dizelnyj',
    'генератор',
    'генераторы',
    'бензиновый',
    'дизельный',
    'электрический'
  ]);
  return uniqueStrings(
    targetNames.flatMap((name) =>
      modelTextTokens(name)
        .map((token) => token.trim())
        .filter((token) => token.length > 1 && tokenHasLetter(token) && !tokenHasDigit(token) && !genericProductWords.has(token))
        .slice(0, 1)
    )
  );
}

function productHasTargetBrand(product: Product, brandCandidates: string[]) {
  if (!brandCandidates.length) return false;
  const productText = compactModelText([product.brand, product.name, product.sourceUrl].filter(Boolean).join(' '));
  return brandCandidates.some((brand) => productText.includes(compactModelText(brand)));
}

function compactCatalogProduct(product: Product, relation: string) {
  return {
    productId: product.id,
    name: product.name,
    brand: product.brand ?? null,
    category: product.category ?? null,
    sourceUrl: product.sourceUrl ?? null,
    specs: product.specs ?? {},
    relation
  };
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

function catalogPresenceForTargets(
  targetNames: string[],
  products: Product[],
  options: { absenceVerified?: boolean } = {}
) {
  return targetNames.map((productName) => {
    const exactMatches = products.filter((product) => productMatchesTargetName(product, productName));
    return {
      productName,
      status: exactMatches.length ? 'present' : options.absenceVerified === true ? 'absent' : 'unknown',
      exactProductIds: exactMatches.map((product) => product.id)
    };
  });
}

function nearbyCatalogProductsForTargets(targetNames: string[], products: Product[]) {
  if (!targetNames.length) return [];
  const brandCandidates = targetBrandCandidates(targetNames);
  const candidates = products
    .filter((product) => !targetNames.some((targetName) => productMatchesTargetName(product, targetName)))
    .map((product) => ({
      product,
      sameBrand: productHasTargetBrand(product, brandCandidates)
    }));
  const sameBrandCandidates = candidates.filter((candidate) => candidate.sameBrand);
  return (sameBrandCandidates.length ? sameBrandCandidates : candidates)
    .sort((a, b) => Number(b.sameBrand) - Number(a.sameBrand))
    .slice(0, 4)
    .map(({ product, sameBrand }) => compactCatalogProduct(
      product,
      sameBrand ? 'same_brand_same_product_class' : 'same_product_class_comparable'
    ));
}

function productForResearchFact(input: {
  fact: ProductComparisonResearchFact;
  targetProductNames: string[];
  products: Product[];
}) {
  return input.products.find((product) => textMatchesTargetName(product.name, input.fact.productName)) ?? null;
}

function researchFactProductName(input: {
  fact: ProductComparisonResearchFact;
  targetProductNames: string[];
  product?: Product | null;
}) {
  const factName = input.fact.productName.trim();
  if (factName) return factName;
  const targetName = input.targetProductNames.find((name) => name.trim().length > 0);
  return targetName ?? input.product?.name ?? '';
}

function exactCoverageProductNamesMatch(left: string | null, right: string | null) {
  if (!left || !right) return left === right;
  if (compactModelText(left) === compactModelText(right)) return true;
  return textMatchesTargetName(left, right) && textMatchesTargetName(right, left);
}

function mergeVerifiedMemoryWithResearch(
  memory: ProductComparisonResearchResult,
  research: ProductComparisonResearchResult
): ProductComparisonResearchResult {
  const facts = [...new Map([...memory.facts, ...research.facts].map((fact) => [[
    fact.productName,
    fact.attribute,
    fact.value,
    fact.sourceUrl ?? ''
  ].join('|'), fact])).values()];
  const allCoverage = [
    ...memory.answerGuidance.coverage,
    ...research.answerGuidance.coverage
  ];
  const coverageProductNames = uniqueStrings(allCoverage
    .map((item) => item.productName?.trim() ?? '')
    .filter(Boolean));
  const canonicalCoverageProductName = (productName: string | null) => {
    if (!productName) return null;
    return coverageProductNames
      .filter((candidate) => exactCoverageProductNamesMatch(candidate, productName))
      .sort((left, right) => compactModelText(left).length - compactModelText(right).length)[0] ?? productName;
  };
  const mergedCoverage = [...new Map(allCoverage.map((item) => {
    const productName = canonicalCoverageProductName(item.productName);
    return [[
    productName ?? '',
    item.attribute,
    item.status,
    item.value,
    item.sourceUrl ?? ''
    ].join('|'), { ...item, productName }] as const;
  })).values()];
  const confirmedCoverageSlots = new Set(mergedCoverage
    .filter((item) => item.status === 'confirmed')
    .map((item) => [compactModelText(item.productName ?? ''), compactModelText(item.attribute)].join('|')));
  const coverage = mergedCoverage.filter((item) =>
    !(
      (item.status === 'not_confirmed' || item.status === 'not_found') &&
      confirmedCoverageSlots.has([
        compactModelText(item.productName ?? ''),
        compactModelText(item.attribute)
      ].join('|'))
    )
  );
  return {
    ...research,
    facts,
    answerGuidance: {
      ...research.answerGuidance,
      completeness: research.answerGuidance.completeness === 'answered'
        ? 'answered'
        : facts.length ? 'partially_answered' : 'not_answered',
      coverage
    },
    summaryForAnswer: uniqueStrings([memory.summaryForAnswer, research.summaryForAnswer]).join('\n'),
    warnings: uniqueStrings([...memory.warnings, ...research.warnings, 'verified_fact_memory_merged_with_gap_research'])
  };
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




function productNamesFromToolRequest(request: ToolRequest | undefined) {
  const productNames = request?.args.productNames;
  if (!Array.isArray(productNames)) return [];
  return productNames
    .map((item) => typeof item === 'string' ? item.trim() : '')
    .filter(Boolean);
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
  private readonly embeddingCoverageCache = new Map<string, { usable: boolean; expiresAt: number }>();
  private readonly queryEmbeddingCache = new Map<string, { value: number[]; expiresAt: number }>();

  constructor(
    private readonly conversations = new ConversationRepository(),
    private readonly products = new ProductRepository(),
    private readonly leads = new LeadRepository(),
    private readonly model: AgentManagerModel = new OpenAIAgentManagerModel(),
    private readonly embedQuery: (text: string, signal?: AbortSignal) => Promise<number[] | undefined | null> = createEmbedding,
    private readonly readSitePrice = readCurrentSitePrice
  ) {}

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
    const repo = this.products as ProductRepository & {
      searchVerifiedProductFacts?: ProductRepository['searchVerifiedProductFacts'];
      markVerifiedProductFactsUsed?: ProductRepository['markVerifiedProductFactsUsed'];
      upsertVerifiedProductFact?: ProductRepository['upsertVerifiedProductFact'];
      upsertVerifiedWebFact?: ProductRepository['upsertVerifiedWebFact'];
    };
    return repo;
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
    const repo = this.verifiedFactRepository();
    if (!products.length || typeof repo.searchVerifiedProductFacts !== 'function') {
      return { facts: [] as VerifiedProductFact[], conflicts: [] as VerifiedProductFact[] };
    }
    const facts = await repo.searchVerifiedProductFacts({
      productIds: uniqueStrings(products.map((product) => product.id)),
      sourceTypes: ['web', 'manual'],
      attributes,
      limit: 32
    });
    const productsById = new Map(products.map((product) => [product.id, product]));
    const now = new Date();
    const applicable = facts.filter((fact) => {
      const product = fact.productId ? productsById.get(fact.productId) : undefined;
      return product && reusableVerifiedFact(fact, now) &&
        (fact.sourceType === 'web' || fact.sourceType === 'manual') &&
        fact.attribute.trim() && fact.value.trim() &&
        textMatchesTargetName(fact.productName, product.name) &&
        textMatchesTargetName(product.name, fact.productName);
    });
    // Disagreement on the same canonical model attribute cannot authorize either
    // value. Attribute aliases remain visible to the semantic consumers unchanged.
    const valuesBySlot = new Map<string, Set<string>>();
    for (const fact of applicable) {
      const slot = `${fact.productId}|${canonicalFactAttribute(fact.attribute)}`;
      const values = valuesBySlot.get(slot) ?? new Set<string>();
      values.add(verifiedFactValueKey(fact));
      valuesBySlot.set(slot, values);
    }
    return {
      facts: applicable.filter((fact) =>
        valuesBySlot.get(`${fact.productId}|${canonicalFactAttribute(fact.attribute)}`)?.size === 1),
      conflicts: applicable.filter((fact) =>
        (valuesBySlot.get(`${fact.productId}|${canonicalFactAttribute(fact.attribute)}`)?.size ?? 0) > 1)
    };
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
    const repo = this.verifiedFactRepository();
    if (typeof repo.searchVerifiedProductFacts !== 'function') return null;
    const exactProductIds = input.targetProductNames.length
      ? input.selectedProducts
          .filter((product) => input.targetProductNames.some((targetName) => productMatchesTargetName(product, targetName)))
          .map((product) => product.id)
      : input.selectedProducts.map((product) => product.id);
    const productNames = input.targetProductNames.length
      ? input.targetProductNames
      : input.selectedProducts.map((product) => product.name);
    const facts = await repo.searchVerifiedProductFacts({
      productNames,
      productIds: exactProductIds,
      includeNameOnlyWithProductIds: true,
      sourceTypes: ['web', 'manual'],
      attributes: input.comparisonAttributes,
      limit: 32
    });
    const exactBoundFacts = (input.targetProductNames.length
      ? facts.filter((fact) => input.targetProductNames.some((targetName) => {
          if (!textMatchesTargetName(fact.productName, targetName)) return false;
          const targetProductIds = input.selectedProducts
            .filter((product) => productMatchesTargetName(product, targetName))
            .map((product) => product.id);
          return targetProductIds.length
            ? Boolean(fact.productId && targetProductIds.includes(fact.productId))
            : fact.productId === null || fact.productId === undefined;
        }))
      : exactProductIds.length
        ? facts.filter((fact) => Boolean(fact.productId && exactProductIds.includes(fact.productId)))
        : facts).filter(fact=>reusableVerifiedFact(fact,new Date()));
    const knownSourceCandidates = [...new Map(exactBoundFacts.filter(fact => reusableVerifiedFact(fact, new Date()) &&
      fact.sourceTier && fact.sourceAuthority && fact.sourceUrl).map(fact => [fact.sourceUrl!, {
        url: fact.sourceUrl!, title: fact.sourceTitle ?? undefined
      }])).values()].slice(0, 8);
    let matchingFacts = matchingVerifiedFactsForRequest({
      facts: exactBoundFacts,
      targetProductNames: input.targetProductNames,
      comparisonAttributes: input.comparisonAttributes
    });
    const requestedFactSlots = input.requestedFactSlots ?? input.targetProductNames.flatMap((productName) =>
      input.comparisonAttributes.map((attribute) => ({ productName, attribute }))
    );
    let coverage = verifiedFactCoverageForRequest({
      facts: matchingFacts,
      targetProductNames: input.targetProductNames,
      comparisonAttributes: input.comparisonAttributes,
      requestedFactSlots: input.requestedFactSlots
    });
    if (
      coverage.missingFactSlots.length &&
      exactBoundFacts.length &&
      requestedFactSlots.length &&
      typeof this.model.matchVerifiedFactMemory === 'function'
    ) {
      try {
        const matches = await this.model.matchVerifiedFactMemory({
          facts: exactBoundFacts,
          requestedFactSlots: coverage.missingFactSlots,
          signal: input.signal,
          deadlineAtMs: input.deadlineAtMs
        });
        const semanticFacts = matches.flatMap((match) => {
          const slot = coverage.missingFactSlots.find((candidate) =>
            compactModelText(candidate.attribute) === compactModelText(match.attribute) &&
            textMatchesTargetName(candidate.productName, match.productName) &&
            textMatchesTargetName(match.productName, candidate.productName)
          );
          const fact = exactBoundFacts.find((candidate) =>
            candidate.id === match.factId &&
            slot &&
            textMatchesTargetName(candidate.productName, slot.productName) &&
            textMatchesTargetName(slot.productName, candidate.productName)
          );
          return fact && slot ? [{ ...fact, attribute: slot.attribute }] : [];
        });
        matchingFacts = [...new Map([...matchingFacts, ...semanticFacts].map((fact) => [
          `${fact.id}|${compactModelText(fact.attribute)}`,
          fact
        ])).values()];
        coverage = verifiedFactCoverageForRequest({
          facts: matchingFacts,
          targetProductNames: input.targetProductNames,
          comparisonAttributes: input.comparisonAttributes,
          requestedFactSlots: input.requestedFactSlots
        });
        await this.trace(input.sessionId, input.turnId, 'tools', 'verified_fact_memory_semantic_match', {
          candidateCount: exactBoundFacts.length,
          requestedSlotCount: requestedFactSlots.length,
          matchedFactCount: semanticFacts.length,
          remainingMissingFactSlots: coverage.missingFactSlots
        });
      } catch (error) {
        await this.trace(input.sessionId, input.turnId, 'tools', 'verified_fact_memory_semantic_match_failed', {
          candidateCount: exactBoundFacts.length,
          requestedSlotCount: requestedFactSlots.length,
          error: safeError(error)
        });
      }
    }
    if (!matchingFacts.length) return knownSourceCandidates.length ? {
      research: null, knownSourceCandidates, attributesCovered: false,
      missingAttributes: coverage.missingAttributes, missingFactSlots: coverage.missingFactSlots
    } : null;
    const attributesCovered = verifiedFactsCoverRequest({
      facts: matchingFacts,
      targetProductNames: input.targetProductNames,
      comparisonAttributes: input.comparisonAttributes,
      requestedFactSlots: input.requestedFactSlots
    });
    if (typeof repo.markVerifiedProductFactsUsed === 'function') {
      await repo.markVerifiedProductFactsUsed(uniqueStrings(matchingFacts.map((fact) => fact.id)))
        .catch((error) => console.warn('Verified product fact usage write failed', safeError(error)));
    }
    await this.trace(input.sessionId, input.turnId, 'tools', 'verified_fact_memory_used', {
      factIds: uniqueStrings(matchingFacts.map((fact) => fact.id)),
      productNames: uniqueStrings(matchingFacts.map((fact) => fact.productName)),
      attributes: uniqueStrings(matchingFacts.map((fact) => fact.attribute)),
      attributesCovered,
      missingAttributes: coverage.missingAttributes,
      missingFactSlots: coverage.missingFactSlots
    });
    return {
      research: verifiedFactsResearchResult(matchingFacts, { attributesCovered }),
      knownSourceCandidates,
      attributesCovered,
      missingAttributes: coverage.missingAttributes,
      missingFactSlots: coverage.missingFactSlots
    };
  }

  private async persistVerifiedResearchFacts(input: {
    sessionId: string;
    turnId: string;
    requestId?: string;
    research: ProductComparisonResearchResult;
    targetProductNames: string[];
    selectedProducts: Product[];
  }) {
    const repo = this.verifiedFactRepository();
    if (typeof repo.upsertVerifiedProductFact !== 'function') return 0;
    const targetNames = input.targetProductNames.length
      ? input.targetProductNames
      : input.selectedProducts.map((product) => product.name);
    // A later skipped/timed-out discovery tier does not undo a completed
    // document read. Only its independently verified facts below can persist;
    // memory hits and unexecuted research still cannot refresh their TTL.
    const completedDocumentWithPartialSearch = input.research.usedDocumentRead === true &&
      (input.research.searchDisposition === 'skipped_budget' || input.research.searchDisposition === 'timed_out');
    if ((input.research.usedWebSearch !== true && input.research.usedDocumentRead !== true) ||
      (input.research.searchDisposition !== 'completed' && !completedDocumentWithPartialSearch)) {
      await this.trace(input.sessionId, input.turnId, 'tools', 'verified_fact_memory_persistence', {
        persistableCount: 0,
        savedCount: 0,
        targetProductNames: input.targetProductNames,
        searchDisposition: input.research.searchDisposition,
        skippedReason: 'research_execution_not_completed'
      });
      return 0;
    }
    let savedCount = 0;
    let persistableCount = 0;
    const queuedFacts: Parameters<ProductRepository['upsertVerifiedProductFact']>[0][] = [];
    for (const fact of researchFactMemoryCandidates(input.research)) {
      if (fact.sourceType !== 'web') continue;
      if (fact.confidence !== 'high' && fact.confidence !== 'medium') continue;
      if (targetNames.length && !targetNames.some((targetName) => textMatchesTargetName(fact.productName, targetName))) continue;
      const sourceUrl = typeof fact.sourceUrl === 'string' && fact.sourceUrl.trim() ? fact.sourceUrl.trim() : null;
      const sourceTitle = typeof fact.sourceTitle === 'string' && fact.sourceTitle.trim() ? fact.sourceTitle.trim() : null;
      const evidence = fact.evidence.trim();
      if (!evidence || !sourceUrl || !sourceTitle || !fact.sourceTier || !fact.sourceAuthority) continue;
      if (fact.evidenceVerifiedExact !== true) continue;
      const scopeQuote = fact.targetApplicability === 'exact_model' || fact.targetApplicability === 'shared_instruction' ? fact.scopeQuote : undefined;
      if (!textMatchesTargetName([sourceUrl, sourceTitle, evidence, scopeQuote].filter(Boolean).join(' '), fact.productName)) continue;
      const unresolvedConflict = input.research.conflicts.some((conflict) =>
        textMatchesTargetName(conflict.productName, fact.productName) &&
        compactModelText(conflict.attribute) === compactModelText(fact.attribute)
      );
      const unresolvedCoverage = input.research.answerGuidance.coverage.some((coverage) =>
        compactModelText(coverage.attribute) === compactModelText(fact.attribute) &&
        (!coverage.productName || textMatchesTargetName(coverage.productName, fact.productName)) &&
        (coverage.status === 'ambiguous' || coverage.status === 'contradicted')
      );
      if (unresolvedConflict || unresolvedCoverage) continue;
      const product = productForResearchFact({
        fact,
        targetProductNames: input.targetProductNames,
        products: input.selectedProducts
      });
      const productName = researchFactProductName({ fact, targetProductNames: input.targetProductNames, product });
      if (!productName) continue;
      persistableCount += 1;
      const factInput: Parameters<ProductRepository['upsertVerifiedProductFact']>[0] = {
        productId: product?.id ?? null,
        expectedTechnicalVersion: product?.technicalVersion ?? null,
        productName,
        attribute: fact.attribute,
        value: fact.value,
        sourceType: fact.sourceTier === 'official_manual' ? 'manual' : 'web',
        sourceUrl,
        sourceTitle,
        evidence,
        sourceTier: fact.sourceTier,
        sourceAuthority: fact.sourceAuthority,
        observedAt: new Date().toISOString(),
        confidence: fact.sourceAuthority === 'secondary' ? 'medium' : fact.confidence
      };
      if (typeof repo.enqueueVerifiedProductFacts === 'function') {
        queuedFacts.push(factInput);
        continue;
      }
      const saved = await repo.upsertVerifiedProductFact(factInput);
      if (!saved) continue;
      savedCount += 1;
      if (product?.id && typeof repo.upsertVerifiedWebFact === 'function') {
        await repo.upsertVerifiedWebFact({
          productId: product.id,
          attribute: fact.attribute,
          value: fact.value,
          sourceUrl,
          confidence: researchFactConfidenceNumber(fact.confidence)
        }).catch((error) => console.warn('Product web fact mirror write failed', safeError(error)));
      }
    }
    const queuedCount = queuedFacts.length
      ? await repo.enqueueVerifiedProductFacts(`${input.turnId}:${input.requestId ?? 'research'}`, queuedFacts)
      : 0;
    if (savedCount > 0) {
      await this.trace(input.sessionId, input.turnId, 'tools', 'verified_fact_memory_saved', {
        savedCount,
        targetProductNames: input.targetProductNames
      });
    }
    await this.trace(input.sessionId, input.turnId, 'tools', 'verified_fact_memory_persistence', {
      persistableCount,
      savedCount,
      queuedCount,
      targetProductNames: input.targetProductNames,
      searchDisposition: input.research.searchDisposition
    });
    return savedCount;
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
    const productsById = new Map<string, Product>((input.priorProducts ?? []).map((product) => [product.id, product]));
    const toolResults: ToolResult[] = [...(input.priorToolResults ?? [])];
    const catalogResearchCache = input.catalogResearchCache ?? new Map<string, ProductComparisonResearchResult>();
    const freshResearchResults = input.freshResearchResults ?? [];
    const technicalLeadRequiresExhaustionProof = intentRequiresSearchBeforeSpecialist(input.intent) &&
      input.intent.toolRequests.some((request) => request.tool === 'lead.capture');
    const technicalHandoffContinuationProven =
      !technicalLeadRequiresExhaustionProof ||
      hasProvenTechnicalHandoffContinuation({
        history: input.history,
        userMessage: input.userMessage,
        intent: input.intent,
        pendingLeadCaptureDraft: input.pendingLeadCaptureDraft
      });
    const budgetMax = input.intent.selectionPolicy
      ? hardSelectionNumber(input.intent, ['budget_max_rub', 'price_max_rub'])
      : budgetMaxFromNeedState(input.needState);
    const persistBudgetStoppedRemainder = async (
      startIndex: number,
      error: AgentManagerTurnBudgetExceededError
    ) => {
      for (const pendingRequest of input.toolRequests.slice(startIndex)) {
        if (input.persistedToolResults.has(pendingRequest.id)) continue;
        const pendingResult = ToolResultSchema.parse({
          requestId: pendingRequest.id,
          tool: pendingRequest.tool,
          status: 'error',
          payload: { error: { code: error.code, stopReason: error.stopReason } },
          warnings: ['tool_not_executed:turn_budget_exceeded'],
          errorCode: error.stopReason
        });
        validateToolResultOutput(pendingResult);
        await this.conversations.saveToolArtifact({
          sessionId: input.session.id,
          turnId: input.turnId,
          executionOwner: input.executionOwner,
          toolName: pendingRequest.tool,
          toolRequestId: pendingRequest.id,
          status: pendingResult.status,
          payload: pendingResult.payload,
          warnings: pendingResult.warnings,
          errorCode: pendingResult.errorCode
        });
      }
    };

    for (const [requestIndex, request] of input.toolRequests.entries()) {
      const baseDefinition = agentManagerToolRegistry[request.tool];
      const verifyBudget = budgetMax !== undefined && (request.tool === 'catalog.search' || request.tool === 'catalog.getProductDetails') &&
        typeof this.products.updateVerifiedSitePrice === 'function';
      const definition = verifyBudget ? { ...baseDefinition, timeoutMs: 30_000 }
        : request.tool === 'catalog.getProductDetails' && request.args.verifyCurrentPrice === true
        ? { ...baseDefinition, timeoutMs: 20_000 } : baseDefinition;
      const productIdsBeforeRequest = new Set(productsById.keys());
      const rollbackProductsAddedForRequest = () => {
        for (const productId of productsById.keys()) {
          if (!productIdsBeforeRequest.has(productId)) productsById.delete(productId);
        }
      };
      const persistedResult = input.persistedToolResults.get(request.id);
      const expectedLeadActionFingerprint = request.tool === 'lead.capture'
        ? leadCaptureActionFingerprint({
            sessionId: input.session.id,
            turnId: input.turnId,
            userMessage: input.userMessage,
            authorization: input.intent.leadCaptureAuthorization,
            request
          })
        : null;
      const persistedDurableLead = persistedResult?.tool === 'lead.capture' &&
        isDurableLeadCaptureResult(persistedResult);
      const persistedLeadReplayBlocked = persistedResult?.tool === 'lead.capture' && (
        isBlockedLeadReplayResult(persistedResult) ||
        (
          persistedDurableLead &&
          (
            !expectedLeadActionFingerprint ||
            durableLeadActionFingerprint(persistedResult) !== expectedLeadActionFingerprint
          )
        )
      );
      if (persistedLeadReplayBlocked) {
        const blockedResult = isBlockedLeadReplayResult(persistedResult)
          ? persistedResult
          : blockedLeadReplayResult(request);
        input.budget.consumeToolResult(assertToolResultBounds(blockedResult));
        toolResults.push(blockedResult);
        await this.trace(input.session.id, input.turnId, 'recovery', 'lead_capture_reexecution_blocked', {
          requestId: request.id,
          reason: 'unverifiable_or_mismatched_action_fingerprint'
        });
        continue;
      }
      const reusablePersistedResult = persistedResult && (
        request.tool !== 'lead.capture' || (
          persistedDurableLead &&
          expectedLeadActionFingerprint &&
          durableLeadActionFingerprint(persistedResult) === expectedLeadActionFingerprint
        )
      ) ? persistedResult : undefined;
      if (reusablePersistedResult) {
        if (reusablePersistedResult.tool !== request.tool) {
          throw new Error(`saved_tool_artifact_tool_mismatch:${request.id}`);
        }
        productsFromPersistedToolResult(reusablePersistedResult)
          .forEach((product) => productsById.set(product.id, product));
        try {
          input.budget.consumeToolResult(assertToolResultBounds(reusablePersistedResult));
        } catch (error) {
          if (error instanceof AgentManagerTurnBudgetExceededError) {
            await persistBudgetStoppedRemainder(requestIndex + 1, error);
          }
          throw error;
        }
        toolResults.push(reusablePersistedResult);
        await this.trace(input.session.id, input.turnId, 'recovery', 'tool_artifact_reused', {
          requestId: request.id,
          tool: request.tool,
          status: reusablePersistedResult.status,
          observationStatus: reusablePersistedResult.observationStatus ?? null
        });
        continue;
      }
      if (persistedResult?.tool === 'lead.capture') {
        await this.trace(input.session.id, input.turnId, 'recovery', 'non_durable_lead_artifact_ignored', {
          requestId: request.id,
          status: persistedResult.status,
          warnings: persistedResult.warnings
        });
      }
      const startedAt = Date.now();
      let effectiveTimeoutMs = effectiveAgentToolTimeoutMs({
        tool: request.tool,
        configuredTimeoutMs: definition.timeoutMs,
        remainingWallTimeMs: input.budget.remainingWallTimeMs()
      });
      let timeoutSignal: AbortSignal;
      let toolSignal: AbortSignal;
      let result: ToolResult | undefined;
      let attempt = 0;
      let budgetStopError: AgentManagerTurnBudgetExceededError | undefined;
      const catalogResolvedProducts = request.tool === 'web.researchProductFacts'
        ? catalogCandidatesSatisfyingConditionalWebRequest({
            request,
            intent: input.intent,
            toolResults,
            products: [...productsById.values()]
          })
        : [];
      if (request.tool === 'web.researchProductFacts' && catalogResolvedProducts.length) {
        const comparisonAttributes = comparisonAttributesForRequest(request);
        result = ToolResultSchema.parse({
          requestId: request.id,
          tool: request.tool,
          status: 'ok',
          payload: {
            usedWebSearch: false,
            searchDisposition: 'not_needed',
            researchOutcome: 'answered',
            sourcesExhausted: false,
            unconfirmedFacts: [],
            facts: [],
            conflicts: [],
            answerGuidance: {
              directAnswer: '',
              completeness: 'answered',
              coverage: []
            },
            targetProductNames: catalogResolvedProducts.slice(0, 4).map((product) => product.name),
            comparisonAttributes,
            catalogPresence: [],
            nearbyCatalogProducts: [],
            suppressedTargetProductNames: []
          },
          warnings: ['web_research_not_needed:catalog_requirements_satisfied']
        });
        await this.trace(input.session.id, input.turnId, 'tools', 'tool_short_circuited_by_catalog_evidence', {
          requestId: request.id,
          tool: request.tool,
          coveredRequirementIds: request.coversRequirementIds ?? [],
          productIds: catalogResolvedProducts.map((product) => product.id),
          attemptCount: 0,
          usedWebSearch: false,
          searchDisposition: 'not_needed',
          sourcesExhausted: false,
          remainingTurnMs: input.budget.remainingWallTimeMs()
        });
      }
      if (!result && request.tool === 'web.researchProductFacts' && effectiveTimeoutMs < WEB_MIN_EXECUTION_MS) {
        result = ToolResultSchema.parse({
          requestId: request.id,
          tool: request.tool,
          status: 'error',
          payload: {
            usedWebSearch: false,
            searchDisposition: 'skipped_budget',
            sourcesExhausted: false,
            researchOutcome: 'partial',
            unconfirmedFacts: [],
            error: { code: 'web_research_skipped_budget', effectiveTimeoutMs }
          },
          warnings: ['web_research_skipped:answer_reserve'],
          errorCode: 'web_research_skipped_budget'
        });
      }
      while (!result && attempt < definition.maxAttempts) {
        attempt += 1;
        const toolAttemptStartedAt = Date.now();
        effectiveTimeoutMs = Math.min(effectiveTimeoutMs, effectiveAgentToolTimeoutMs({
          tool: request.tool,
          configuredTimeoutMs: definition.timeoutMs,
          remainingWallTimeMs: input.budget.remainingWallTimeMs()
        }));
        timeoutSignal = AbortSignal.timeout(Math.max(1, effectiveTimeoutMs));
        toolSignal = input.signal
          ? AbortSignal.any([input.signal, timeoutSignal])
          : timeoutSignal;
        try {
        input.budget.consumeToolCall(definition);
        await this.trace(input.session.id, input.turnId, 'tools', 'tool_started', {
          requestId: request.id,
          tool: request.tool,
          attempt,
          timeoutMs: effectiveTimeoutMs,
          configuredTimeoutMs: definition.timeoutMs,
          postWebAnswerReserveMs: request.tool === 'web.researchProductFacts' ? WEB_ANSWER_RESERVE_MS : 0,
          remainingTurnMs: input.budget.remainingWallTimeMs()
        });
        if (request.tool === 'catalog.search') {
          const { query, semanticQuery } = toolRequestScopedQuery(request);
          const limit = Math.max(1, Math.min(12, Number(request.args.limit ?? 8)));
          const productIntent = resolvedToolProductIntent(request, input.intent);
          let search = await this.searchCatalogProducts({
              query,
              limit,
              signal: toolSignal,
              productIntent,
              powerSource: resolvedToolPowerSource(request, input.intent),
              embeddingQuery: semanticQuery,
              budgetMax,
              intent: toolRequestTargetsPrimarySelectionClass(request, input.intent) ? input.intent : undefined,
              toolResults
            });
            const loadRequirementKw = isGeneratorProductClass(productIntent)
              ? generatorLoadRequirementKw(toolResults)
              : undefined;
            const budgetPrices = verifyBudget ? await verifyBudgetPrices({products:search.products,
              read:this.readSitePrice, persist:price=>this.products.updateVerifiedSitePrice(price), signal:toolSignal,
              maxProducts: CURRENT_PRICE_VERIFICATION_TOP_K}) : undefined;
            const loadFit = filterGeneratorProductsByLoadProfile(budgetPrices?.products ?? search.products, loadRequirementKw);
            const loadAwareRetry = false;
            const products = loadFit.products;
            const warnings = [...search.warnings, ...loadFit.warnings,
              ...(budgetPrices?.proofs.filter(proof=>proof.status==='unavailable').map(proof=>`site_price_not_verified:${proof.productId}`) ?? [])];
            const catalogSearchGrounded = products.length > 0 || search.candidateTiers.length > 0;
            products.forEach((product) => productsById.set(product.id, product));
          result = ToolResultSchema.parse({
              requestId: request.id,
              tool: request.tool,
              status: catalogSearchGrounded ? 'ok' : 'not_found',
              payload: {
                query,
                productIds: products.map((product) => product.id),
                products,
                ...(budgetPrices ? { priceVerifications: budgetPrices.proofs } : {}),
                ...(loadRequirementKw === undefined ? {} : {
                  generatorLoadFit: {
                    requiredNominalKw: loadRequirementKw,
                    droppedProductIds: loadFit.droppedProductIds,
                    loadAwareRetry
                  }
                }),
                retrieval: {
                  intent: search.productIntent,
                  query: search.query,
                  embeddingQuery: search.embeddingQuery,
                  textCount: search.textCount,
                  vectorCount: search.vectorCount,
                  usedEmbeddings: search.vectorCount > 0,
                  candidateTiers: search.candidateTiers,
                  primaryExpansion: search.primaryExpansion ?? null
                }
              },
              warnings: catalogSearchGrounded ? warnings : [...warnings, 'catalog_search_no_matches']
          });
        } else if (request.tool === 'catalog.getProductDetails') {
          const requestedProductIds = Array.isArray(request.args.productIds)
            ? request.args.productIds.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
            : [];
          const names = Array.isArray(request.args.productNames)
            ? request.args.productNames.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
            : [];
          const queries = names.length
            ? names
            : [typeof request.args.query === 'string' ? request.args.query.trim() : ''].filter(Boolean);
          const productIntent = resolvedToolProductIntent(request, input.intent);
          const semanticQuery = toolRequestScopedQuery(request).semanticQuery;
          const requestProductsById = new Map<string, Product>();
            const getProductsByIds = (this.products as ProductRepository & {
              getProductsByIds?: ProductRepository['getProductsByIds'];
            }).getProductsByIds;
            if (requestedProductIds.length && typeof getProductsByIds === 'function') {
              const productsFromIds = await getProductsByIds.call(this.products, requestedProductIds);
              productsFromIds.forEach((product) => requestProductsById.set(product.id, product));
            }
            const exactModelSearch = (this.products as ProductRepository & {
              searchProductsByModelTokens?: ProductRepository['searchProductsByModelTokens'];
            }).searchProductsByModelTokens;
            if (!requestedProductIds.length && names.length && typeof exactModelSearch === 'function') {
              for (const name of names.slice(0, 4)) {
                const identity = exactProductIdentity(name);
                const tokens = identity.decisiveParts
                  .map((part) => compactModelText(part))
                  .filter(Boolean);
                if (!tokens.length) continue;
                const exactMatches = await exactModelSearch.call(this.products, tokens, 20, { signal: toolSignal })
                  .then((products) => products.filter((product) =>
                    productMatchesExactTargetIdentity(product, name)
                  ))
                  .catch(() => []);
                exactMatches.forEach((product) => requestProductsById.set(product.id, product));
              }
            }
            const shouldSearchByText = requestedProductIds.length === 0;
            for (const query of shouldSearchByText ? queries.slice(0, 4).filter(name =>
              ![...requestProductsById.values()].some(product => productMatchesExactTargetIdentity(product, name))
            ) : []) {
              const found = await this.searchCatalogProducts({
                query,
                limit: 4,
                signal: toolSignal,
                productIntent,
                powerSource: resolvedToolPowerSource(request, input.intent),
                embeddingQuery: semanticQuery,
                budgetMax,
                intent: toolRequestTargetsPrimarySelectionClass(request, input.intent) ? input.intent : undefined,
                toolResults,
                allowPrimaryExpansion: false
              });
              found.products.forEach((product) => requestProductsById.set(product.id, product));
            }
            const scopedProducts = productsMatchingToolRequestIntent({
              products: [...requestProductsById.values()],
              request,
              intent: input.intent
            });
            requestProductsById.clear();
            scopedProducts.forEach((product) => requestProductsById.set(product.id, product));
            const priceVerification = request.args.verifyCurrentPrice === true || verifyBudget
              ? await verifyBudgetPrices({
                products: scopedProducts,
                read: this.readSitePrice,
                persist: (price) => this.products.updateVerifiedSitePrice(price),
                signal: toolSignal,
                maxProducts: CURRENT_PRICE_VERIFICATION_TOP_K,
                preservePriceOnFailure: !verifyBudget,
                onFailure: async (product, errorCode, stage) => {
                  if (verifyBudget) requestProductsById.set(product.id, { ...product, price: null });
                  await this.trace(input.session.id, input.turnId, 'tools', 'site_price_verification_failed', {
                    productId: product.id,
                    errorCode,
                    stage,
                    remainingTurnMs: input.budget.remainingWallTimeMs()
                  });
                }
              })
              : { products: scopedProducts, proofs: [] };
            requestProductsById.clear();
            priceVerification.products.forEach((product) => requestProductsById.set(product.id, product));
            const priceVerifications = priceVerification.proofs;
            requestProductsById.forEach((product) => productsById.set(product.id, product));
          result = ToolResultSchema.parse({
              requestId: request.id,
              tool: request.tool,
              status: requestProductsById.size ? 'ok' : 'not_found',
              payload: {
                productIds: [...requestProductsById.keys()],
                products: [...requestProductsById.values()],
                ...(priceVerifications.length ? { priceVerifications } : {})
              },
              warnings: requestProductsById.size
                ? priceVerifications.filter(check => check.status === 'unavailable').map(check => `site_price_not_verified:${check.productId}`)
                : ['product_details_no_matches']
          });
        } else if (request.tool === 'calculator.generatorLoad') {
          const { loads, profile, estimateBasis, warnings } = buildGeneratorLoadToolPayload({
            request,
            userMessage: input.userMessage
          });
          result = ToolResultSchema.parse({
            requestId: request.id,
            tool: request.tool,
            status: profile ? 'ok' : 'not_found',
            payload: { loads, profile, estimateBasis },
            warnings: profile ? warnings : [...warnings, 'no_usable_loads_for_generator_calculation']
          });
        } else if (request.tool === 'web.researchProductFacts') {
          let targetProductNames = targetProductNamesForRequest(request, input.intent);
          const suppressedTargetProductNames = suppressedContextTargetProductNamesForRequest(request, input.intent);
          const comparisonAttributes = comparisonAttributesForRequest(request);
          const webProductClassKey = typedProductClassKey(
            request.args.canonicalProductIntent,
            request.args.productIntent
          );
          const webProductIntent = resolvedToolProductIntent(request, input.intent);
          const webLookupProductIds = new Set<string>();
          const requestMatchesWebIntent = (requestId: string) => {
            const sourceRequest = input.intent.toolRequests.find((candidate) => candidate.id === requestId);
            if (!sourceRequest) return false;
            const sourceProductClassKey = typedProductClassKey(
              sourceRequest.args.canonicalProductIntent,
              sourceRequest.args.productIntent
            );
            return webProductClassKey !== null && sourceProductClassKey === webProductClassKey;
          };
          const scopedProductsForWeb = () => {
            const products = productsMatchingToolRequestIntent({
              products: [...productsById.values()],
              request,
              intent: input.intent
            });
            if (webProductClassKey !== null) {
              const matchingCatalogProductIds = new Set(toolResults
                .filter((toolResult) =>
                  (toolResult.tool === 'catalog.search' || toolResult.tool === 'catalog.getProductDetails') &&
                  requestMatchesWebIntent(toolResult.requestId)
                )
                .flatMap((toolResult) => productsFromPersistedToolResult(toolResult).map((product) => product.id)));
              return products.filter((product) =>
                matchingCatalogProductIds.has(product.id) || webLookupProductIds.has(product.id)
              );
            }
            if (webProductIntent !== 'unknown') return products;
            return products.filter((product) => webLookupProductIds.has(product.id));
          };
          const catalogCandidatesBeforeWeb = scopedProductsForWeb();
          const precedingCatalogSucceeded = toolResults.some((result) =>
            (result.tool === 'catalog.search' || result.tool === 'catalog.getProductDetails') &&
            result.status === 'ok' &&
            requestMatchesWebIntent(result.requestId)
          );
          if (!targetProductNames.length && precedingCatalogSucceeded && catalogCandidatesBeforeWeb.length) {
            targetProductNames = catalogCandidatesBeforeWeb.slice(0, 4).map((product) => product.name);
          }
          const allExplicitTargetsPresent = targetProductNames.length > 0 && targetProductNames.every((targetName) =>
            catalogCandidatesBeforeWeb.some((product) => productMatchesTargetName(product, targetName))
          );
          // Exact model mentions must not depend on full-text ranking of the
          // buyer's long technical sentence. The repository has a model-token
          // lookup specifically for this boundary; use it before the broad
          // semantic search and keep only products that satisfy the typed
          // exact identity. This prevents a real catalog card from being
          // reported as absent merely because the request also names an
          // engine, maintenance facts, or several attributes.
          const exactModelTokenSearch = (this.products as ProductRepository & {
            searchProductsByModelTokens?: ProductRepository['searchProductsByModelTokens'];
          }).searchProductsByModelTokens;
          if (targetProductNames.length && typeof exactModelTokenSearch === 'function') {
            for (const targetName of targetProductNames.slice(0, 4)) {
              const identity = exactProductIdentity(targetName);
              const tokens = identity.decisiveParts
                .map((part) => compactModelText(part))
                .filter(Boolean);
              if (!tokens.length) continue;
              const exactMatches = await exactModelTokenSearch.call(this.products, tokens, 20, { signal: toolSignal })
                .then((products) => products.filter((product) =>
                  productMatchesExactTargetIdentity(product, targetName)
                ))
                .catch(() => []);
              exactMatches.forEach((product) => {
                productsById.set(product.id, product);
                webLookupProductIds.add(product.id);
              });
            }
          }
          let exactCatalogRefreshWarnings: string[] = [];
          // A missing match is not proof of catalog absence. It is only safe to
          // say "absent" after a complete, non-empty sitemap inventory was
          // fetched and contained no exact candidate URL. Any skipped refresh,
          // empty inventory, or failed crawl remains explicitly unknown.
          let exactCatalogAbsenceVerified = false;
          let catalogCandidatesAfterExactModelLookup = scopedProductsForWeb();
          let exactTargetsPresentAfterModelLookup = targetProductNames.length > 0 && targetProductNames.every((targetName) =>
            catalogCandidatesAfterExactModelLookup.some((product) => productMatchesExactTargetIdentity(product, targetName))
          );
          if (
            targetProductNames.length &&
            !exactTargetsPresentAfterModelLookup &&
            typeof (this.products as ProductRepository & { startCatalogSource?: unknown }).startCatalogSource === 'function'
          ) {
            try {
              const refreshed = await refreshExactCatalogProducts(targetProductNames, this.products, { signal: toolSignal });
              exactCatalogRefreshWarnings = refreshed.warnings;
              exactCatalogAbsenceVerified = refreshed.coverageComplete &&
                refreshed.failedProducts === 0 &&
                refreshed.candidateUrls.length === 0;
              if (typeof exactModelTokenSearch === 'function') {
                for (const targetName of targetProductNames.slice(0, 4)) {
                  const identity = exactProductIdentity(targetName);
                  const tokens = identity.decisiveParts.map((part) => compactModelText(part)).filter(Boolean);
                  if (!tokens.length) continue;
                  const refreshedMatches = await exactModelTokenSearch.call(this.products, tokens, 20, { signal: toolSignal })
                    .then((products) => products.filter((product) => productMatchesExactTargetIdentity(product, targetName)))
                    .catch(() => []);
                  refreshedMatches.forEach((product) => {
                    productsById.set(product.id, product);
                    webLookupProductIds.add(product.id);
                  });
                }
              }
              catalogCandidatesAfterExactModelLookup = scopedProductsForWeb();
              exactTargetsPresentAfterModelLookup = targetProductNames.every((targetName) =>
                catalogCandidatesAfterExactModelLookup.some((product) => productMatchesExactTargetIdentity(product, targetName))
              );
            } catch (error) {
              exactCatalogRefreshWarnings = [`exact_catalog_refresh_failed:${safeError(error).message}`];
              exactCatalogAbsenceVerified = false;
            }
          }
          const priorCatalogLookupCompleted = toolResults.some((toolResult) => {
            if (toolResult.tool === 'catalog.search' || toolResult.tool === 'catalog.getProductDetails') {
              return requestMatchesWebIntent(toolResult.requestId) &&
                (toolResult.status === 'ok' || toolResult.status === 'not_found');
            }
            if (
              toolResult.tool !== 'web.researchProductFacts' ||
              toolResult.status !== 'ok' ||
              !requestMatchesWebIntent(toolResult.requestId)
            ) return false;
            const sourceAttempts = (toolResult.payload as { sourceAttempts?: unknown }).sourceAttempts;
            return Array.isArray(sourceAttempts) && sourceAttempts.some((attempt) => {
              if (!attempt || typeof attempt !== 'object') return false;
              const sourceAttempt = attempt as { tier?: unknown; outcome?: unknown };
              return sourceAttempt.tier === 'catalog' &&
                (sourceAttempt.outcome === 'confirmed' || sourceAttempt.outcome === 'not_found');
            });
          });
          const needsCatalogLookup = !priorCatalogLookupCompleted || catalogCandidatesAfterExactModelLookup.length === 0 || (
            targetProductNames.length > 0
              ? !(allExplicitTargetsPresent || exactTargetsPresentAfterModelLookup)
              : catalogCandidatesAfterExactModelLookup.length < 2
          );
          let currentWebCatalogLookupCompleted = false;
          if (needsCatalogLookup) {
            const scopedQuery = toolRequestScopedQuery(request);
            const lookupQuery = targetProductNames.length
              ? targetProductNames.join(' ')
              : scopedQuery.query;
            const found = await this.searchCatalogProducts({
              query: lookupQuery,
              limit: 4,
              signal: toolSignal,
              productIntent: resolvedToolProductIntent(request, input.intent),
              powerSource: resolvedToolPowerSource(request, input.intent),
              embeddingQuery: scopedQuery.semanticQuery,
              budgetMax
            });
            currentWebCatalogLookupCompleted = true;
            found.products.forEach((product) => {
              productsById.set(product.id, product);
              webLookupProductIds.add(product.id);
            });
          }
          const allSelectedProducts = scopedProductsForWeb();
          const exactTargetProducts = targetProductNames.length
            ? allSelectedProducts.filter((product) =>
                targetProductNames.some((targetName) => productMatchesTargetName(product, targetName))
              )
            : [];
          const selectedProducts = (exactTargetProducts.length ? exactTargetProducts : allSelectedProducts).slice(0, 4);
          const allRequestedFactSlots = targetProductNames.flatMap((productName) =>
            comparisonAttributes.map((attribute) => ({ productName, attribute }))
          );
          const researchDeadlineAtMs = Math.min(
            toolAttemptStartedAt + effectiveTimeoutMs,
            Date.now() + input.budget.remainingWallTimeMs() - WEB_ANSWER_RESERVE_MS
          );
          const researchTrace = (event: ProductResearchTraceEvent) => this.trace(
            input.session.id,
            input.turnId,
            'tools',
            'product_research_stage',
            { requestId: request.id, ...event }
          );
          const freshRequested = input.intent.grounding?.webRequirement === 'buyer_requested' ||
            input.intent.grounding?.webRequirement === 'independent_required';
          const memoryCheckedFirst = !freshRequested && allRequestedFactSlots.length > 0;
          const priorMemory = memoryCheckedFirst ? await this.researchFromVerifiedFactMemory({
            sessionId:input.session.id,turnId:input.turnId,targetProductNames,comparisonAttributes,
            requestedFactSlots:allRequestedFactSlots,selectedProducts,signal:toolSignal,
            deadlineAtMs:Math.min(researchDeadlineAtMs,Date.now()+8_000)
          }) : null;
          await this.trace(input.session.id,input.turnId,'tools','evidence_broker_lookup',{
            requestId:request.id,sourcePolicy:input.intent.grounding?.sourcePolicy,
            products:selectedProducts.map(product=>({id:product.id,technicalVersion:product.technicalVersion??null})),
            requestedSlots:allRequestedFactSlots.length,hit:priorMemory?.attributesCovered===true,freshRequested
          });
          // Reuse only the same completed reading inside this buyer turn. The
          // full card content is part of the key; changed facts cannot hit it.
          const catalogResearchKey = createHash('sha256').update(JSON.stringify([
            input.userMessage, [...targetProductNames].sort(), [...comparisonAttributes].sort(),
            [...selectedProducts].sort((left, right) => left.id.localeCompare(right.id)),
            priorCatalogLookupCompleted || currentWebCatalogLookupCompleted
          ])).digest('hex');
          const cachedCatalogResearch = catalogResearchCache.get(catalogResearchKey);
          const catalogResearch = priorMemory?.attributesCovered ? null : cachedCatalogResearch ? structuredClone(cachedCatalogResearch) : await extractCatalogProductComparisonFacts({
            userMessage: input.userMessage,
            products: selectedProducts,
            targetProductNames,
            comparisonAttributes,
            compact: true,
            catalogSearchAttempted: priorCatalogLookupCompleted || currentWebCatalogLookupCompleted,
            catalogProductsFound: selectedProducts.length > 0,
            signal: toolSignal,
            deadlineAtMs: researchDeadlineAtMs,
            onTrace: researchTrace
          });
          if (cachedCatalogResearch) {
            await this.trace(input.session.id, input.turnId, 'tools', 'catalog_fact_extraction_reused', {
              requestId: request.id, productIds: selectedProducts.map((product) => product.id), comparisonAttributes
            });
          } else if (catalogResearch && (catalogResearch.searchDisposition === 'completed' ||
            catalogResearch.searchDisposition === 'not_needed')) {
            catalogResearchCache.set(catalogResearchKey, structuredClone(catalogResearch));
          }
          const catalogMissingFactSlots = allRequestedFactSlots.filter((slot) =>
            !catalogResearch || !researchResultCoversFactSlot({
              result: catalogResearch,
              productName: slot.productName,
              attribute: slot.attribute,
              sourceTypes: ['catalog']
            })
          );
          const catalogCoversRequest = allRequestedFactSlots.length > 0 && catalogMissingFactSlots.length === 0;
          const memoryTargetProductNames = catalogMissingFactSlots.length
            ? uniqueStrings(catalogMissingFactSlots.map((slot) => slot.productName))
            : targetProductNames;
          const memoryComparisonAttributes = catalogMissingFactSlots.length
            ? uniqueStrings(catalogMissingFactSlots.map((slot) => slot.attribute))
            : comparisonAttributes;
          const priorMemoryResearch = priorMemory?.research;
          const memory = catalogCoversRequest
            ? null
            : memoryCheckedFirst ? (priorMemory ? {...priorMemory,attributesCovered:Boolean(priorMemoryResearch && catalogMissingFactSlots.every(slot=>
                researchResultCoversFactSlot({result:priorMemoryResearch,productName:slot.productName,attribute:slot.attribute,sourceTypes:['web']})))} : null)
            : await this.researchFromVerifiedFactMemory({
                sessionId: input.session.id,
                turnId: input.turnId,
                targetProductNames: memoryTargetProductNames,
                comparisonAttributes: memoryComparisonAttributes,
                requestedFactSlots: catalogMissingFactSlots.length ? catalogMissingFactSlots : undefined,
                selectedProducts,
                signal: toolSignal,
                deadlineAtMs: Math.min(researchDeadlineAtMs, Date.now() + 8_000)
              });
          const catalogAndMemory = catalogResearch && memory?.research
            ? mergeVerifiedMemoryWithResearch(catalogResearch, memory.research)
            : catalogResearch ?? memory?.research ?? null;
          const freshEvidence = freshResearchResults.length ? freshResearchResults.reduce((previous, next) => ({
            ...mergeVerifiedMemoryWithResearch(previous, next), conflicts: [...previous.conflicts, ...next.conflicts]
          })) : null;
          const freshWebMissingSlots = allRequestedFactSlots.filter((slot) => !freshEvidence ||
            freshResearchResults.some((result) => result.answerGuidance.coverage.some((item) =>
              (item.status === 'ambiguous' || item.status === 'contradicted') &&
              (!item.productName || exactCoverageProductNamesMatch(item.productName, slot.productName)) &&
              compactModelText(item.attribute) === compactModelText(slot.attribute))) ||
            !researchResultCoversFactSlot({ result: freshEvidence, ...slot, sourceTypes: ['web'] }));
          const freshWebRequested = input.intent.grounding?.webRequirement === 'buyer_requested' ||
            input.intent.grounding?.webRequirement === 'independent_required';
          const requiresFreshWeb = freshWebRequested && freshWebMissingSlots.length > 0;
          const allowCatalogOnlyAnswer = allowCatalogOnlyResearchForWebRequest(input.intent, request);
          let research = !requiresFreshWeb && ((catalogCoversRequest && allowCatalogOnlyAnswer) || memory?.attributesCovered)
            ? catalogAndMemory
            : null;
          if (!research && freshEvidence && allRequestedFactSlots.length > 0 && freshWebMissingSlots.length === 0) {
            research = { ...(catalogAndMemory ? mergeVerifiedMemoryWithResearch(catalogAndMemory, freshEvidence) : freshEvidence),
              usedWebSearch: false, usedDocumentRead: false, searchDisposition: 'memory_hit',
              warnings: [...freshEvidence.warnings, 'current_turn_verified_research_reused'] };
          }
          if (!research) {
            const missingFactSlots = requiresFreshWeb
              ? freshWebMissingSlots
              : memory?.missingFactSlots ?? catalogMissingFactSlots;
            const gapTargetProductNames = missingFactSlots.length
              ? uniqueStrings(missingFactSlots.map((slot) => slot.productName))
              : targetProductNames;
            const gapAttributes = missingFactSlots.length
              ? uniqueStrings(missingFactSlots.map((slot) => slot.attribute))
              : memory?.missingAttributes ?? comparisonAttributes;
            const researchedGaps = await researchProductComparisonFacts({
              documentReadContext: input.documentReadContext,
              userMessage: input.userMessage,
              researchGoal: {
                query: typeof request.args.query === 'string' ? request.args.query : undefined,
                semanticQuery: typeof request.args.semanticQuery === 'string' ? request.args.semanticQuery : undefined,
                reason: typeof request.args.reason === 'string' ? request.args.reason : request.rationale,
                notes: typeof request.args.notes === 'string' ? request.args.notes : undefined
              },
              previousResearch: toolResults
                .filter((result) => result.tool === 'web.researchProductFacts')
                .map((result) => ({
                  requestId: result.requestId,
                  status: result.status,
                  payload: result.payload,
                  warnings: result.warnings
                })),
              knownSourceCandidates: [...(memory?.knownSourceCandidates ?? []), ...(catalogAndMemory?.facts ?? []).flatMap((fact) =>
                fact.sourceType === 'web' && fact.sourceUrl
                  ? [{ url: fact.sourceUrl, title: fact.sourceTitle }] : [])],
              products: selectedProducts,
              targetProductNames: gapTargetProductNames,
              comparisonAttributes: gapAttributes,
              missingFactSlots,
              precomputedCatalogResult: catalogResearch,
              allowCatalogOnlyAnswer,
              catalogSearchAttempted: priorCatalogLookupCompleted || currentWebCatalogLookupCompleted,
              catalogProductsFound: selectedProducts.length > 0,
              signal: toolSignal,
              deadlineAtMs: researchDeadlineAtMs,
              onTrace: researchTrace
            });
            // Capture fresh source-validated evidence before old memory is merged.
            // Partial later tiers cannot undo a completed document read; an old
            // memory hit or an unexecuted tool cannot satisfy fresh verification.
            if ((researchedGaps.usedWebSearch && researchedGaps.searchDisposition === 'completed') ||
              (researchedGaps.usedDocumentRead && ['completed', 'skipped_budget', 'timed_out'].includes(researchedGaps.searchDisposition ?? ''))) {
              freshResearchResults.push({ ...structuredClone(researchedGaps),
                facts: researchFactMemoryCandidates(researchedGaps).filter((fact) => fact.evidenceVerifiedExact === true) });
            }
            await this.persistVerifiedResearchFacts({
              sessionId: input.session.id,
              turnId: input.turnId,
              requestId: request.id,
              research: researchedGaps,
              targetProductNames,
              selectedProducts
            }).catch((error) => console.warn('Verified product fact memory write failed', safeError(error)));
            research = catalogAndMemory
              ? mergeVerifiedMemoryWithResearch(catalogAndMemory, researchedGaps)
              : researchedGaps;
            if (requiresFreshWeb) {
              research.warnings = research.warnings.filter((warning) => warning !== 'web_search_skipped_verified_fact_memory');
            }
          }
          const catalogPresence = catalogPresenceForTargets(targetProductNames, selectedProducts, {
            absenceVerified: exactCatalogAbsenceVerified
          });
          const nearbyCatalogProducts = nearbyCatalogProductsForTargets(targetProductNames, selectedProducts);
          for (const conflict of research.conflicts) {
            const product = selectedProducts.find((item) => item.name === conflict.productName);
            await this.products.recordDataQualityIssue({
              productId: product?.id ?? null,
              issueType: 'web_catalog_conflict',
              fieldName: conflict.attribute,
              conflictingValues: [conflict.catalogValue, ...conflict.webValues].filter(Boolean),
              evidence: [conflict.resolution]
            }).catch((error) => console.warn('Data quality issue write failed', safeError(error)));
          }
          // The production research contract always contains answerGuidance,
          // but persisted/legacy tool artifacts and test doubles may predate it.
          // Only an explicit `not_answered` result is treated as exhausted;
          // missing legacy guidance must not erase otherwise useful facts.
          const answerGuidance = research.answerGuidance ?? {
            directAnswer: '',
            completeness: research.facts.length ? 'answered' as const : 'partially_answered' as const,
            coverage: []
          };
          const researchOutcome = answerGuidance.completeness === 'answered'
            ? 'answered' as const
            : research.sourcesExhausted
              ? 'exhausted' as const
              : 'partial' as const;
          const unconfirmedFacts = answerGuidance.coverage
            .filter((coverage) => coverage.status !== 'confirmed')
            .map((coverage) => ({
              requirementIds: request.coversRequirementIds ?? [],
              productName: coverage.productName ?? (targetProductNames.length === 1 ? targetProductNames[0] : null),
              attribute: coverage.attribute,
              status: coverage.status,
              reason: coverage.evidence
            }));
          result = ToolResultSchema.parse({
            requestId: request.id,
            tool: request.tool,
            status: research.warnings.includes('not_enough_products_for_comparison') &&
              !targetProductNames.length &&
              researchOutcome === 'exhausted'
              ? 'not_found'
              : 'ok',
            payload: {
              ...research,
              products: selectedProducts,
              answerGuidance,
              researchOutcome,
              searchDisposition: research.searchDisposition,
              sourcesExhausted: research.sourcesExhausted,
              unconfirmedFacts,
              targetProductNames,
              comparisonAttributes,
              catalogPresence,
              nearbyCatalogProducts,
              suppressedTargetProductNames
            },
            warnings: [
              ...research.warnings,
              ...exactCatalogRefreshWarnings,
              ...suppressedTargetProductNames.map((productName) => `exact_target_suppressed_by_product_role:${productName}`),
              ...catalogPresence
                .filter((item) => item.status === 'absent')
                .map((item) => `exact_catalog_product_absent:${item.productName}`)
            ]
          });
        } else if (request.tool === 'lead.capture') {
          const authorization = input.intent.leadCaptureAuthorization;
          if (!technicalHandoffContinuationProven) {
            result = ToolResultSchema.parse({
              requestId: request.id,
              tool: request.tool,
              status: 'denied',
              payload: { reason: 'technical_handoff_requires_prior_exhausted_research' },
              warnings: ['lead_capture_denied:technical_search_not_proven_exhausted']
            });
          } else {
          const authorizationEvidence = authorization?.evidence?.trim() ?? '';
          const evidenceIsCurrent = Boolean(
            authorizationEvidence && input.userMessage.includes(authorizationEvidence)
          );
          const extractedContact = evidenceIsCurrent
            ? extractContact(authorizationEvidence)
            : {};
          const plannerName = evidenceIsCurrent
            ? currentEvidencePlannerName(request, authorizationEvidence)
            : undefined;
          const preferredContact = evidenceIsCurrent
            ? requestedPreferredContact(request)
            : undefined;
          const pendingDraftAuthorized = authorization?.contactSource === 'pending_draft';
          const pendingDraft = pendingDraftAuthorized &&
            authorization.pendingDraftId === input.pendingLeadCaptureDraft?.id
            ? input.pendingLeadCaptureDraft
            : null;
          const pendingDraftQuestionSafe = Boolean(
            pendingDraft &&
            pendingDraft.buyerQuestion.length <= 1_000 &&
            !buyerQuestionContainsContactPii(pendingDraft.buyerQuestion)
          );
          const pendingDraftAuthorizationMatchesScope = !pendingDraftAuthorized || Boolean(
            pendingDraft &&
            pendingLeadCaptureDraftMatchesAuthorizationScope(pendingDraft, authorization)
          );
          const groundedQuestion = pendingDraft
            ? pendingDraftQuestionSafe ? pendingDraft.buyerQuestion : null
            : groundedBuyerQuestion(authorization?.buyerQuestion, input.history);
          const purpose = pendingDraft
            ? pendingDraft.purpose
            : authorization?.purpose?.trim();
          const contact = {
            name: plannerName ?? extractedContact.name ?? pendingDraft?.name ?? undefined,
            phone: extractedContact.phone ?? pendingDraft?.phone ?? undefined,
            email: extractedContact.email ?? pendingDraft?.email ?? undefined
          };
          const currentTurnHasContact = Boolean(extractedContact.phone || extractedContact.email);
          const currentTurnContributesToPendingDraft = Boolean(
            plannerName || currentTurnHasContact || preferredContact
          );
          const actionFingerprint = leadCaptureActionFingerprint({
            sessionId: input.session.id,
            turnId: input.turnId,
            userMessage: input.userMessage,
            authorization,
            request
          });
          const authorizationDenied = (
            !authorization?.authorized ||
            input.intent.grounding?.rationale === DEFAULT_AGENT_INTENT_GROUNDING_RATIONALE ||
            authorization.contactSource === 'none' ||
            !purpose ||
            !groundedQuestion ||
            !actionFingerprint ||
            !evidenceIsCurrent ||
            (authorization.contactSource === 'current_message' && !currentTurnHasContact) ||
            (pendingDraftAuthorized && (
              !pendingDraft ||
              !pendingDraftQuestionSafe ||
              !pendingDraftAuthorizationMatchesScope ||
              !currentTurnContributesToPendingDraft
            )) ||
            (!pendingDraftAuthorized && authorization.pendingDraftId != null)
          );
          if (authorizationDenied) {
            result = ToolResultSchema.parse({
              requestId: request.id,
              tool: request.tool,
              status: 'denied',
              payload: {
                reason: authorization?.authorized
                  ? 'authorized_contact_source_missing'
                  : 'lead_capture_not_authorized_by_current_intent'
              },
              warnings: ['lead_capture_denied:current_intent_or_contact_not_authorized']
            });
          } else {
            const leadPurpose = purpose as string;
            const leadBuyerQuestion = groundedQuestion as string;
            const latestLeadForSession = (this.leads as unknown as {
              latestLeadForSession?: (sessionId: string) => Promise<{
                id: string;
                name?: string | null;
                phone?: string | null;
                email?: string | null;
              } | null>;
            }).latestLeadForSession;
            const existingLead = latestLeadForSession
              ? await latestLeadForSession.call(this.leads, input.session.id)
              : null;
            const existingContactAuthorized = authorization.contactSource === 'existing_session';
            if (existingLead && existingContactAuthorized && !currentTurnHasContact) {
              contact.name ??= existingLead.name ?? undefined;
              contact.phone ??= existingLead.phone ?? undefined;
              contact.email ??= existingLead.email ?? undefined;
            }
            if (!contact.phone && !contact.email) {
              result = ToolResultSchema.parse({
                requestId: request.id,
                tool: request.tool,
                status: 'not_found',
                payload: { missing: 'contact', missingFields: ['contact'] },
                warnings: ['lead_contact_missing']
              });
            } else if (!contact.name) {
              const draft = pendingDraft ?? await this.leads.upsertLeadCaptureDraft({
                sessionId: input.session.id,
                originTurnId: input.turnId,
                originToolRequestId: request.id,
                purpose: leadPurpose,
                buyerQuestion: leadBuyerQuestion,
                preferredContact,
                phone: contact.phone,
                email: contact.email,
                consentEvidenceHash: leadCaptureHash([input.session.id, authorizationEvidence]),
                scopeHash: authorization.handoffKind === 'technical_followup' && authorization.handoffOfferMessageId
                  ? leadCaptureHash([
                      input.session.id,
                      leadPurpose,
                      leadBuyerQuestion,
                      `technical_handoff_offer:${authorization.handoffOfferMessageId}`
                    ])
                  : leadCaptureHash([input.session.id, leadPurpose, leadBuyerQuestion])
              });
              if (!draft) throw new Error('lead_capture_draft_not_persisted');
              if (!pendingDraft) {
                await this.trace(input.session.id, input.turnId, 'lead', 'lead_capture_draft_saved', {
                  draftId: draft.id,
                  scopeHash: draft.scopeHash,
                  hasPhone: Boolean(draft.phone),
                  hasEmail: Boolean(draft.email),
                  preferredContact: draft.preferredContact ?? null,
                  expiresAt: draft.expiresAt
                });
              }
              result = ToolResultSchema.parse({
                requestId: request.id,
                tool: request.tool,
                status: 'not_found',
                payload: {
                  missing: 'name',
                  missingFields: ['name'],
                  draftId: draft.id,
                  draftSaved: true,
                  contactStored: true,
                  ...(draft.preferredContact ? { preferredContact: draft.preferredContact } : {}),
                  originalQuestionPreserved: true
                },
                warnings: ['lead_name_missing', 'lead_capture_partial_contact_persisted']
              });
            } else {
              let lead: { id: string };
              let outbox: unknown;
              const warnings: string[] = [];
              if (pendingDraft) {
                const completion = await this.leads.completeLeadCaptureDraft({
                  draftId: pendingDraft.id,
                  sessionId: input.session.id,
                  turnId: input.turnId,
                  name: String(contact.name),
                  phone: extractedContact.phone,
                  email: extractedContact.email,
                  preferredContact
                });
                if (!completion) throw new Error('lead_capture_draft_completion_failed');
                lead = completion.lead;
                outbox = completion.outbox;
                warnings.push('lead_capture_pending_draft_consumed');
                await this.trace(input.session.id, input.turnId, 'lead', 'lead_capture_draft_consumed', {
                  draftId: pendingDraft.id,
                  leadId: completion.lead.id,
                  outboxId: completion.outbox.id,
                  dispatchStatus: completion.outbox.status,
                  scopeHash: pendingDraft.scopeHash
                });
              } else {
                lead = await this.leads.createLead({
                  sessionId: input.session.id,
                  originTurnId: input.turnId,
                  originToolRequestId: request.id,
                  name: String(contact.name),
                  phone: typeof contact.phone === 'string' ? contact.phone : undefined,
                  email: typeof contact.email === 'string' ? contact.email : undefined,
                  question: leadBuyerQuestion
                });
                outbox = await this.conversations.enqueueLeadOutbox({
                  leadId: lead.id,
                  sessionId: input.session.id,
                  turnId: input.turnId,
                  destination: 'lead_email',
                  payload: {
                    leadId: lead.id,
                    purpose: leadPurpose,
                    question: leadBuyerQuestion,
                    preferredContact: preferredContact ?? null,
                    source: 'agent_manager'
                  }
                });
                if (existingLead && existingContactAuthorized && !currentTurnHasContact) {
                  warnings.push('lead_existing_session_contact_used');
                }
              }
              const outboxId = typeof (outbox as { id?: unknown } | null)?.id === 'string' &&
                String((outbox as { id: string }).id).trim()
                ? String((outbox as { id: string }).id)
                : undefined;
              const dispatchStatus = durableLeadOutboxStatus(outbox);
              if (!outboxId || !dispatchStatus) {
                throw new Error(`lead_outbox_not_dispatchable:${String((outbox as { status?: unknown } | null)?.status ?? 'missing')}`);
              }
              result = ToolResultSchema.parse({
                requestId: request.id,
                tool: request.tool,
                status: 'ok',
                payload: {
                  leadId: lead.id,
                  outbox: true,
                  outboxId,
                  status: 'queued',
                  dispatchStatus,
                  actionFingerprint,
                  ...(preferredContact || pendingDraft?.preferredContact
                    ? { preferredContact: preferredContact ?? pendingDraft?.preferredContact ?? undefined }
                    : {}),
                  originalQuestionPreserved: true
                },
                warnings
              });
            }
          }
          }
        } else {
          result = ToolResultSchema.parse({
            requestId: request.id,
            tool: request.tool,
            status: 'denied',
            payload: {},
            warnings: ['tool_not_implemented']
          });
        }
        } catch (error) {
          rollbackProductsAddedForRequest();
          if (error instanceof AgentManagerTurnBudgetExceededError) {
            budgetStopError = error;
            result = ToolResultSchema.parse({
              requestId: request.id,
              tool: request.tool,
              status: 'error',
              payload: { error: { code: error.code, stopReason: error.stopReason } },
              warnings: ['tool_not_executed:turn_budget_exceeded'],
              errorCode: error.stopReason
            });
            continue;
          }
          const retryable = attempt < definition.maxAttempts &&
            !timeoutSignal.aborted &&
            !input.signal?.aborted;
          if (retryable) {
            await this.trace(input.session.id, input.turnId, 'recovery', 'tool_attempt_retry', {
              requestId: request.id,
              tool: request.tool,
              attempt,
              attemptDurationMs: Date.now() - toolAttemptStartedAt,
              disposition: 'failed_retryable',
              remainingTurnMs: input.budget.remainingWallTimeMs()
            });
            continue;
          }
          const timedOut = timeoutSignal.aborted && !input.signal?.aborted;
          // Web research must exhaust the turn budget before giving up (AGENTS.md):
          // a single timeout is often a network flap. If the remaining wall time
          // still fits one shortened attempt plus the writer reserve, retry once.
          const webTimeoutRetryable = timedOut &&
            request.tool === 'web.researchProductFacts' &&
            attempt < definition.maxAttempts;
          const retryBudgetMs = input.budget.remainingWallTimeMs() - WEB_ANSWER_RESERVE_MS - 1_000;
          if (webTimeoutRetryable && retryBudgetMs >= 12_000) {
            effectiveTimeoutMs = Math.min(effectiveTimeoutMs, retryBudgetMs);
            await this.trace(input.session.id, input.turnId, 'recovery', 'web_research_retry_after_timeout', {
              requestId: request.id,
              attempt,
              attemptDurationMs: Date.now() - toolAttemptStartedAt,
              disposition: 'timed_out_retryable',
              retryTimeoutMs: effectiveTimeoutMs,
              remainingTurnMs: input.budget.remainingWallTimeMs()
            });
            continue;
          }
          const webFailurePayload = request.tool === 'web.researchProductFacts'
            ? {
                usedWebSearch: false,
                searchDisposition: timedOut ? 'timed_out' : input.signal?.aborted ? 'aborted' : 'failed',
                sourcesExhausted: false,
                researchOutcome: 'partial',
                unconfirmedFacts: [],
                error: safeError(error)
              }
            : { error: safeError(error) };
          result = ToolResultSchema.parse({
            requestId: request.id,
            tool: request.tool,
            status: timedOut ? 'timeout' : 'error',
            payload: webFailurePayload,
            warnings: ['tool_execution_error'],
            errorCode: safeError(error).code ?? safeError(error).message
          });
        }
      }
      if (!result) throw new Error(`tool_execution_missing_result:${request.id}`);
      if (result.status !== 'ok') rollbackProductsAddedForRequest();
      try {
        result = validateToolResultOutput(result);
        assertToolResultBounds(result);
      } catch (error) {
        rollbackProductsAddedForRequest();
        result = ToolResultSchema.parse({
          requestId: request.id,
          tool: request.tool,
          status: 'error',
          payload: { error: safeError(error) },
          warnings: ['tool_result_rejected_by_local_bounds'],
          errorCode: safeError(error).code ?? safeError(error).message
        });
      }
      result = validateToolResultOutput({
        ...result,
        warnings: uniqueStrings([
          ...result.warnings,
          `attempts:${attempt}`,
          `duration_ms:${Date.now() - startedAt}`
        ])
      });
      await this.conversations.saveToolArtifact({
        sessionId: input.session.id,
        turnId: input.turnId,
        executionOwner: input.executionOwner,
        toolName: request.tool,
        toolRequestId: request.id,
        status: result.status,
        payload: result.payload,
        warnings: result.warnings,
        errorCode: result.errorCode
      });
      await this.trace(input.session.id, input.turnId, 'tools', 'tool_completed', {
        requestId: request.id,
        tool: request.tool,
        status: result.status,
        observationStatus: result.observationStatus ?? null,
        attemptCount: attempt,
        durationMs: Date.now() - startedAt,
        timeoutMs: effectiveTimeoutMs,
        configuredTimeoutMs: definition.timeoutMs,
        remainingTurnMs: input.budget.remainingWallTimeMs(),
        retryDecisionWarnings: result.warnings.filter((warning) => warning.includes('retry_')),
        errorCode: result.errorCode ?? null
      });
      if (budgetStopError) {
        toolResults.push(result);
        await persistBudgetStoppedRemainder(requestIndex + 1, budgetStopError);
        throw budgetStopError;
      }
      try {
        input.budget.consumeToolResult(assertToolResultBounds(result));
        toolResults.push(result);
      } catch (error) {
        if (error instanceof AgentManagerTurnBudgetExceededError) {
          toolResults.push(result);
          await persistBudgetStoppedRemainder(requestIndex + 1, error);
        }
        throw error;
      }
    }

    return { toolResults, products: [...productsById.values()] };
  }

  private async canUseProductEmbeddings(signal?: AbortSignal) {
    const coverageFn = (this.products as unknown as {
      getEmbeddingCoverage?: ProductRepository['getEmbeddingCoverage'];
    }).getEmbeddingCoverage;
    if (!coverageFn) return false;

    const key = `products:${config.OPENAI_EMBEDDING_MODEL}`;
    const cached = this.embeddingCoverageCache.get(key);
    const now = Date.now();
    if (cached && cached.expiresAt > now) return cached.usable;

    try {
      const coverage = await coverageFn.call(this.products, 'products', config.OPENAI_EMBEDDING_MODEL, { signal });
      const usable = coverage.total > 0 && coverage.coverage >= config.EMBEDDING_MIN_COVERAGE;
      this.embeddingCoverageCache.set(key, { usable, expiresAt: now + 60_000 });
      return usable;
    } catch (error) {
      console.warn('Agent manager embedding coverage check failed', safeError(error));
      this.embeddingCoverageCache.set(key, { usable: false, expiresAt: now + 15_000 });
      return false;
    }
  }

  private async createCachedQueryEmbedding(text: string, signal?: AbortSignal) {
    const key = `${config.OPENAI_EMBEDDING_MODEL}:${text.slice(0, 8000)}`;
    const cached = this.queryEmbeddingCache.get(key);
    const now = Date.now();
    if (cached && cached.expiresAt > now) return cached.value;

    const embedding = await this.embedQuery(text, signal).catch(() => null);
    if (!embedding?.length) return null;

    if (this.queryEmbeddingCache.size >= 200) {
      const oldest = this.queryEmbeddingCache.keys().next().value;
      if (oldest) this.queryEmbeddingCache.delete(oldest);
    }
    this.queryEmbeddingCache.set(key, { value: embedding, expiresAt: now + 10 * 60_000 });
    return embedding;
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
    const query = input.query;
    const limit = input.limit;
    const productIntent = input.productIntent ?? 'unknown';
    const embeddingQuery = input.embeddingQuery?.trim() || query;
    const warnings: string[] = [];
    let firstError: unknown = null;
    let textProducts: Product[] = [];
    let vectorProducts: Product[] = [];
    const structuredCatalogSelection = Boolean(input.intent?.selectionPolicy && productIntent !== 'unknown');
    const retrievalLimit = structuredCatalogSelection
      ? Math.max(limit * 25, 200)
      : Math.max(limit, limit * 3);

    // The planner selects exact-only consultation versus alternative discovery.
    // Once every named identity is found, unrelated candidates cannot improve it.
    const exactTargets = input.intent?.selectionPolicy?.alternativePolicy === 'exact_only'
      ? uniqueStrings((input.intent.productMentions ?? [])
        .filter((mention) => exactTargetProductMentionRoles.has(mention.role))
        .map((mention) => mention.name))
      : [];
    const preciseTargets = exactTargets.length > 0 && exactTargets.every((name) =>
      exactProductIdentity(name).decisiveParts.some(tokenHasDigit)
    );
    // Model-code matching intentionally tolerates brand/name layout. A shortcut
    // needs stronger evidence: the complete requested name (or exact catalog SKU).
    const matchesCompleteTarget = (product: Product, name: string) =>
      productMatchesExactTargetIdentity(product, name) && (
        compactModelText([product.brand, product.name].filter(Boolean).join(' ')).includes(compactModelText(name)) ||
        compactModelText(product.externalId) === compactModelText(name)
      );
    let exactLookupSaturated = false;
    const exactTargetsResolved = (products: Product[]) => preciseTargets && !exactLookupSaturated && exactTargets.every((name) =>
      products.filter((product) => matchesCompleteTarget(product, name)).length === 1
    );
    const exactModelSearch = this.products.searchProductsByModelTokens;
    if (preciseTargets && exactTargets.length <= 4 && typeof exactModelSearch === 'function') {
      for (const name of exactTargets) {
        try {
          const tokens = exactProductIdentity(name).decisiveParts.map(compactModelText).filter(Boolean);
          const candidates = await exactModelSearch.call(this.products, tokens, 20, { signal: input.signal });
          if (candidates.length >= 20) exactLookupSaturated = true;
          textProducts.push(...candidates.filter((product) => matchesCompleteTarget(product, name)));
        } catch (error) {
          warnings.push(`catalog_exact_search_error:${safeError(error).code ?? safeError(error).message}`);
        }
      }
      textProducts = [...new Map(textProducts.map((product) => [product.id, product])).values()];
    }

    if (!exactTargetsResolved(textProducts)) {
      try {
        const found = await this.products.searchProducts(query, retrievalLimit, { signal: input.signal });
        textProducts = [...new Map([...textProducts, ...found].map((product) => [product.id, product])).values()];
      } catch (error) {
        firstError = error;
        warnings.push(`catalog_text_search_error:${safeError(error).code ?? safeError(error).message}`);
      }
    }

    const vectorSearchFn = (this.products as unknown as {
      vectorSearch?: ProductRepository['vectorSearch'];
    }).vectorSearch;
    if (!exactTargetsResolved(textProducts) && vectorSearchFn && await this.canUseProductEmbeddings(input.signal)) {
      const embedding = await this.createCachedQueryEmbedding(embeddingQuery, input.signal);
      if (embedding) {
        try {
          vectorProducts = await vectorSearchFn.call(this.products, embedding, retrievalLimit, { signal: input.signal });
        } catch (error) {
          firstError ??= error;
          warnings.push(`catalog_vector_search_error:${safeError(error).code ?? safeError(error).message}`);
        }
      }
    }

    const byId = new Map<string, Product>();
    for (const product of [...textProducts, ...vectorProducts]) byId.set(product.id, product);
    const exactIdentityComplete = exactTargetsResolved([...byId.values()]);
    const shouldBroadenForBudget = !exactIdentityComplete && input.budgetMax !== undefined &&
      Number.isFinite(input.budgetMax) &&
      input.budgetMax > 0 &&
      productIntent !== 'unknown';
    if (shouldBroadenForBudget) {
      const currentMatching = [...byId.values()].filter((product) => productMatchesIntent(product, productIntent));
      const hasWithinBudget = currentMatching.some((product) =>
        typeof product.price === 'number' &&
        Number.isFinite(product.price) &&
        product.price <= input.budgetMax!
      );
      if (!hasWithinBudget) {
        try {
          const broadProducts = await this.products.searchProducts(
            structuredCatalogExpansionQuery(productIntent, input.intent?.selectionPolicy?.targetProductClass),
            500,
            { signal: input.signal }
          );
          let added = 0;
          for (const product of broadProducts) {
            if (!productMatchesIntent(product, productIntent)) continue;
            if (typeof product.price !== 'number' || !Number.isFinite(product.price) || product.price > input.budgetMax!) continue;
            if (!byId.has(product.id)) added += 1;
            byId.set(product.id, product);
          }
          if (added > 0) warnings.push(`catalog_budget_expansion_pool:${added}`);
        } catch (error) {
          firstError ??= error;
          warnings.push(`catalog_budget_expansion_error:${safeError(error).code ?? safeError(error).message}`);
        }
      }
    }
    const mergedProducts = [...byId.values()];
    const matchingProducts = productIntent === 'unknown'
      ? mergedProducts
      : [
          ...mergedProducts.filter((product) => productMatchesIntent(product, productIntent)),
          ...mergedProducts.filter((product) => !productMatchesIntent(product, productIntent))
        ];
    if (productIntent !== 'unknown') {
      const unresolvedClassCount = matchingProducts.filter((product) => !productMatchesIntent(product, productIntent)).length;
      if (unresolvedClassCount) {
        warnings.push(`catalog_products_semantic_class_unconfirmed:${productIntent}:${unresolvedClassCount}`);
      }
    }
    const batteryPowerRequired = isGeneratorProductClass(productIntent) && input.powerSource === 'battery';
    let sourceFilteredProducts = batteryPowerRequired
      ? matchingProducts.filter((product) => {
          const source = productPowerSource(product);
          return source === 'battery' || source === 'unknown';
        })
      : matchingProducts;
    if (sourceFilteredProducts.length !== matchingProducts.length) {
      warnings.push(`catalog_products_filtered_by_power_source:battery:${matchingProducts.length - sourceFilteredProducts.length}`);
      if (!sourceFilteredProducts.length && !exactIdentityComplete) {
        try {
          const expandedBatteryProducts = await this.products.searchProducts(
            fromEscaped('\\u0430\\u043a\\u043a\\u0443\\u043c\\u0443\\u043b\\u044f\\u0442\\u043e\\u0440\\u043d\\u0430\\u044f \\u044d\\u043b\\u0435\\u043a\\u0442\\u0440\\u043e\\u0441\\u0442\\u0430\\u043d\\u0446\\u0438\\u044f'),
            Math.max(limit * 6, 80),
            { signal: input.signal }
          );
          sourceFilteredProducts = expandedBatteryProducts
            .filter((product) => productMatchesIntent(product, productIntent))
            .filter((product) => {
              const source = productPowerSource(product);
              return source === 'battery' || source === 'unknown';
            });
          if (sourceFilteredProducts.length) {
            warnings.push(`catalog_battery_power_station_expansion_pool:${sourceFilteredProducts.length}`);
          } else {
            warnings.push('catalog_search_no_power_source_fit:battery');
          }
        } catch (error) {
          firstError ??= error;
          warnings.push(`catalog_battery_power_station_expansion_error:${safeError(error).code ?? safeError(error).message}`);
          warnings.push('catalog_search_no_power_source_fit:battery');
        }
      }
    }
    let structuredEvidence = input.intent
      ? filterProductsByStructuredSelectionPolicy({
          products: sourceFilteredProducts,
          intent: input.intent,
          toolResults: input.toolResults ?? []
        })
      : { products: sourceFilteredProducts, droppedProductIds: [] as string[], warnings: [] as string[] };
    let primaryExpansion: {
      attempted: boolean;
      query: string;
      scannedCount: number;
      matchedCount: number;
    } | undefined;
    let candidateTier: Exclude<SelectionCandidateTier, 'rejected'> = input.intent
      ? visibleSelectionTier(input.intent)
      : 'preliminary_match';
    const candidateTradeoffs = new Map<string, string[]>();
    const desiredStructuredCandidateCount = Math.max(
      1,
      Math.min(limit, input.intent?.selectionPolicy?.maxCards ?? Math.min(limit, 3))
    );
    const structuredRankingObjectives = input.intent
      ? structuredSelectionRankingObjectives(input.intent)
      : [];
    const remoteStartPreference = input.intent
      ? hasStructuredGeneratorRemoteStartPreference(input.intent)
      : false;
    if (
      structuredCatalogSelection &&
      (
        structuredEvidence.products.length < desiredStructuredCandidateCount ||
        structuredRankingObjectives.length > 0 ||
        remoteStartPreference
      ) &&
      !firstError &&
      !exactIdentityComplete &&
      input.allowPrimaryExpansion !== false
    ) {
      const expansionQuery = structuredCatalogExpansionQuery(
        productIntent,
        input.intent?.selectionPolicy?.targetProductClass
      );
      try {
        const initialStructuredEvidence = structuredEvidence;
        const expansionPool = await this.products.searchProducts(expansionQuery, 1_000, { signal: input.signal });
        const matchingExpansionPool = expansionPool
          .filter((product) => productMatchesIntent(product, productIntent))
          .filter((product) => productMeetsStructuredPowerSource(
            product,
            input.intent?.selectionPolicy?.powerSource
          ));
        const expandedEvidence = filterProductsByStructuredSelectionPolicy({
          products: matchingExpansionPool,
          intent: input.intent!,
          toolResults: input.toolResults ?? []
        });
        const mergedEvidence = filterProductsByStructuredSelectionPolicy({
          products: [...new Map(
            [...initialStructuredEvidence.products, ...expandedEvidence.products]
              .map((product) => [product.id, product])
          ).values()],
          intent: input.intent!,
          toolResults: input.toolResults ?? []
        });
        structuredEvidence = {
          products: mergedEvidence.products,
          droppedProductIds: uniqueStrings([
            ...initialStructuredEvidence.droppedProductIds,
            ...expandedEvidence.droppedProductIds,
            ...mergedEvidence.droppedProductIds
          ]),
          warnings: uniqueStrings([
            ...initialStructuredEvidence.warnings,
            ...expandedEvidence.warnings,
            ...mergedEvidence.warnings
          ])
        };
        primaryExpansion = {
          attempted: true,
          query: expansionQuery,
          scannedCount: expansionPool.length,
          matchedCount: structuredEvidence.products.length
        };
        warnings.push(`catalog_primary_expansion_attempted:${expansionPool.length}:${structuredEvidence.products.length}`);
        if (structuredRankingObjectives.length) {
          warnings.push(`catalog_structured_preference_expansion:${structuredRankingObjectives.length}`);
        }
        if (remoteStartPreference) warnings.push('catalog_structured_remote_start_preference_expansion');
      } catch (error) {
        firstError ??= error;
        primaryExpansion = { attempted: true, query: expansionQuery, scannedCount: 0, matchedCount: 0 };
        warnings.push(`catalog_primary_expansion_error:${safeError(error).code ?? safeError(error).message}`);
      }
    }
    warnings.push(...structuredEvidence.warnings);
    const preferenceRankedProducts = input.intent
      ? rankCatalogProductsByStructuredPreferences({
          products: structuredEvidence.products,
          intent: input.intent
        })
      : structuredEvidence.products;
    const products = preferenceRankedProducts.slice(0, limit);
    if (!products.length && firstError) throw firstError;
    return {
      query,
      embeddingQuery,
      productIntent,
      products,
      textCount: textProducts.length,
      vectorCount: vectorProducts.length,
      candidateTiers: [
        ...products.map((product) => ({
          productId: product.id,
          tier: candidateTier,
          tradeoffs: candidateTradeoffs.get(product.id) ?? []
        })),
        ...structuredEvidence.droppedProductIds
          .filter((productId) => !products.some((product) => product.id === productId))
          .slice(0, Math.max(0, 12 - products.length))
          .map((productId) => ({
            productId,
            tier: 'rejected' as const,
            tradeoffs: [] as string[]
          }))
      ],
      primaryExpansion,
      warnings
    };
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
