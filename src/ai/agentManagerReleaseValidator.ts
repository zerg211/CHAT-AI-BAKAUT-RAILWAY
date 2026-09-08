import { AgentManagerModel, AgentManagerAnswerInput, activeScopedLedgerFacts, isDurableLeadCaptureResult, exactTargetProductMentionRoles, intentRequiresSearchBeforeSpecialist, technicalResearchStatus, hasProvenTechnicalHandoffContinuation, toolResultCanGroundFacts } from './agentManagerModelAdapter.js';
import type { ProductSelectionClass } from '../shared/types.js';
import { type AgentIntentContract, type AnswerContract, type PreSendReview, type ToolRequest, type ToolResult } from './agentManagerContracts.js';
import { safeError } from './responseUtils.js';
import { extractContact, hasLeadContact } from './contactExtraction.js';
import { leadCaptureMissingContact, leadCaptureMissingName } from './leadReviewGuards.js';
import { hasAdjudicationRisk, hasUnsupportedClaimRisk } from './riskReviewGuards.js';
import { gateStrictSelectionRequirements, productSelectionClasses, productCards, qualifiedNominalActivePowerKw, structuredSelectionRankingObjectives, uniqueStrings } from './agentManagerCardSelection.js';
import { isGeneratorProductClass } from './agentManagerGeneratorLoad.js';
import { AgentManagerTurnBudget, AgentManagerTurnBudgetExceededError } from './agentManagerTurnBudget.js';
import { guardCustomerOutput } from './agentManagerOutputGuard.js';
import { compactModelText, modelIdentifierTokens, modelTextTokens, normalizeModelText, textMatchesTargetName, tokenHasLetter } from './modelTextMatching.js';

export interface AgentManagerReviewInput extends AgentManagerAnswerInput {
  answer: AnswerContract;
}

/**
 * Deterministic contract-consistency guard: product cards selected while the
 * selection readiness contract does not allow showing them. Compares contract
 * fields only — no semantic judgment about the buyer request.
 */
export function selectedCardsContradictReadiness(answer: Pick<AnswerContract, 'selectionReadiness' | 'selectedProductIds'>): string | null {
  const allowsCards = answer.selectionReadiness?.canShowProductCards === true;
  const selectsProducts = (answer.selectedProductIds?.length ?? 0) > 0;
  if (!allowsCards && selectsProducts) return 'cards_selected_without_readiness';
  return null;
}

/**
 * Right-size guard (deterministic, no semantics): every selected generator is
 * more than double the calculated nominal need while the evidence pool holds a
 * closer fit (a nominal within [need, 2x need]). A bigger margin is a legitimate
 * alternative, never the whole shortlist when a minimal sufficient unit exists.
 * Returns the mechanical issue code or null.
 */
export function generatorSelectionOversizeIssue(input: {
  requiredNominalKw?: number;
  selectedNominals: (number | undefined)[];
  poolNominals?: (number | undefined)[];
}): string | null {
  const required = input.requiredNominalKw;
  if (typeof required !== 'number' || !Number.isFinite(required) || required <= 0) return null;
  if (!input.selectedNominals.length) return null;
  const known = input.selectedNominals.filter((nominal): nominal is number =>
    typeof nominal === 'number' && Number.isFinite(nominal) && nominal > 0
  );
  if (!known.length) return null;
  if (!known.every((nominal) => nominal > required * 2)) return null;
  if (input.poolNominals !== undefined) {
    const closerFitExists = input.poolNominals.some((nominal) =>
      typeof nominal === 'number' && Number.isFinite(nominal) &&
      nominal >= required && nominal <= required * 2
    );
    if (!closerFitExists) return null;
  }
  return 'generator_selection_grossly_oversized';
}

export function requestStringArray(value: unknown) {
  return Array.isArray(value)
    ? value.map((item) => typeof item === 'string' ? item.trim() : '').filter(Boolean)
    : [];
}

export function productMentionMatchesName(mentionName: string, targetName: string) {
  if (textMatchesTargetName(mentionName, targetName) || textMatchesTargetName(targetName, mentionName)) return true;
  const mentionTokens = new Set(modelIdentifierTokens(mentionName));
  return modelIdentifierTokens(targetName).some((token) => mentionTokens.has(token));
}

export function productNameContainsExactComparisonMention(productName: string, mentionName: string) {
  const normalizedProductName = normalizeModelText(productName);
  const normalizedMentionName = normalizeModelText(mentionName);
  if (normalizedProductName === normalizedMentionName) return true;
  if (!modelIdentifierTokens(mentionName).length) return false;
  const productTokens = modelTextTokens(productName);
  const mentionTokens = modelTextTokens(mentionName);
  if (!mentionTokens.length || mentionTokens.length > productTokens.length) return false;
  for (let index = 0; index <= productTokens.length - mentionTokens.length; index += 1) {
    if (mentionTokens.every((token, offset) => productTokens[index + offset] === token)) return true;
  }
  return false;
}

export function toolRequestEvidenceText(request: ToolRequest) {
  return [
    request.args.query,
    request.args.semanticQuery,
    request.args.reason,
    request.args.notes,
    ...requestStringArray(request.args.productNames)
  ].filter(Boolean).join(' ');
}

export function productClassFromIntentMention(intent: AgentIntentContract) {
  const mention = (intent.productMentions ?? []).find((item) =>
    exactTargetProductMentionRoles.has(item.role) &&
    typeof item.productClass === 'string' &&
    coerceVisibleCardIntent(item.productClass) !== 'unknown'
  );
  return mention?.productClass ? coerceVisibleCardIntent(mention.productClass) : undefined;
}

export function canonicalProductClassFromIntent(intent: AgentIntentContract): ProductSelectionClass {
  const policyClass = coerceVisibleCardIntent(intent.selectionPolicy?.canonicalProductClass);
  if (policyClass !== 'unknown') return policyClass;
  return productClassFromIntentMention(intent) ?? 'unknown';
}

export function coerceVisibleCardIntent(value: unknown): ProductSelectionClass {
  if (typeof value !== 'string' || !value.trim()) return 'unknown';
  const trimmed = value.trim();
  if (productSelectionClasses.includes(trimmed as ProductSelectionClass)) return trimmed as ProductSelectionClass;
  return 'unknown';
}

export function generatorLoadRequirementKw(toolResults: ToolResult[]) {
  for (let index = toolResults.length - 1; index >= 0; index -= 1) {
    const result = toolResults[index];
    if (result?.tool !== 'calculator.generatorLoad' || result.status !== 'ok') continue;
    const profile = (result.payload as { profile?: { requiredNominalKw?: unknown } }).profile;
    const required = Number(profile?.requiredNominalKw);
    if (Number.isFinite(required) && required > 0) return required;
  }
  return undefined;
}

export function normalizedTextIncludesAny(normalizedText: string, fragments: string[]) {
  return fragments.some((fragment) => {
    const normalizedFragment = normalizeModelText(fragment);
    return normalizedFragment.length > 0 && normalizedText.includes(normalizedFragment);
  });
}

export function presentCatalogPresenceLine(productName: string, directAnswer: string) {
  if (textMatchesTargetName(directAnswer, productName)) {
    return 'У нас эта модель есть в каталоге.';
  }
  return `У нас ${productName} есть в каталоге.`;
}

export function presentCatalogPresenceRelevant(intent: AgentIntentContract) {
  return intent.riskFlags.includes('answer_policy_catalog_presence_relevant');
}

export function nonFactBearingToolResultIds(toolResults: ToolResult[]) {
  return new Set(toolResults
    .filter((result) => !toolResultCanGroundFacts(result))
    .map((result) => result.requestId));
}

export function uniqueReviewIssues(issues: PreSendReview['issues']) {
  const unique = new Map<string, PreSendReview['issues'][number]>();
  for (const issue of issues) unique.set(`${issue.code}:${issue.evidence}`, issue);
  return [...unique.values()];
}

export function factSourceIdsFromNonFactBearingTools(input: {
  answer: AnswerContract;
  toolResults: ToolResult[];
}) {
  const failedIds = nonFactBearingToolResultIds(input.toolResults);
  return uniqueStrings(input.answer.factsUsed.flatMap((fact) =>
    fact.sourceEventIds.filter((sourceId) => failedIds.has(sourceId))
  ));
}

export function webResearchTargetsCurrentIntent(targetNames: string[], intent: AgentIntentContract) {
  if (!targetNames.length) return true;
  const taskType = intent.grounding?.taskType;
  const currentTargetNames = uniqueStrings((intent.productMentions ?? [])
    .filter((mention) => exactTargetProductMentionRoles.has(mention.role))
    .map((mention) => mention.name));
  if (!currentTargetNames.length) {
    if (intent.productMentions?.length) return false;
    const hasExplicitCatalogPlan = intent.toolRequests.some((request) =>
      request.tool === 'catalog.search' || request.tool === 'catalog.getProductDetails'
    );
    if (!hasExplicitCatalogPlan && taskType !== 'product_selection') return true;
    const currentIntentEvidence = [
      intent.userMessageSummary,
      ...intent.toolRequests
        .filter((request) => request.tool === 'catalog.search' || request.tool === 'catalog.getProductDetails')
        .map((request) => toolRequestEvidenceText(request))
    ].filter(Boolean);
    return targetNames.every((targetName) => currentIntentEvidence.some((evidence) => {
      if (productMentionMatchesName(evidence, targetName)) return true;
      const evidenceTokens = new Set(modelTextTokens(evidence));
      return modelTextTokens(targetName).some((token) =>
        token.length >= 4 && tokenHasLetter(token) && evidenceTokens.has(token)
      );
    }));
  }
  return targetNames.every((targetName) => currentTargetNames.some((currentTargetName) =>
    productNameContainsExactComparisonMention(targetName, currentTargetName) ||
    productNameContainsExactComparisonMention(currentTargetName, targetName)
  ));
}

export function answerStatesExactCatalogAbsence(answerText: string, productName: string) {
  if (!textMatchesTargetName(answerText, productName)) return false;
  const text = normalizeModelText(answerText);
  if (normalizedTextIncludesAny(text, [
    'нет в каталоге',
    'в каталоге нет',
    'отсутствует в каталоге',
    'в каталоге отсутствует',
    'не представлен в каталоге',
    'not in the catalog',
    'absent from the catalog'
  ])) return true;
  // Same-sentence pattern: "в нашем каталоге точной RD2910E нет" — catalog + model
  // + absence word within one sentence. The model may shorten the name (drop brand),
  // so any token of the target name counts as the model mention.
  const targetTokens = modelIdentifierTokens(productName)
    .map((token) => compactModelText(token))
    .filter((token) => token.length >= 4 && /\d/.test(token));
  for (const sentence of text.split(/[.!?;\n]/)) {
    const mentionsCatalog = normalizedTextIncludesAny(sentence, ['каталог', 'catalog']);
    if (!mentionsCatalog) continue;
    const statesAbsence = normalizedTextIncludesAny(sentence, ['нет', 'отсутствует', 'not available']);
    if (!statesAbsence) continue;
    const mentionsModel = targetTokens.length
      ? targetTokens.some((token) => sentence.includes(token))
      : sentence.includes(compactModelText(productName));
    if (mentionsModel) return true;
  }
  return false;
}

export function researchGuidanceSemanticallySatisfied(input: {
  answerText: string;
  toolResults: ToolResult[];
  intent: AgentIntentContract;
}) {
  // Keep the catalog-presence guard here. Product-fact meaning, polarity and
  // ownership are assessed by the source-bound semantic review and repair path.
  for (const result of input.toolResults) {
    if (result.tool !== 'web.researchProductFacts' || result.status !== 'ok') continue;
    const payload = result.payload as {
      targetProductNames?: unknown;
      catalogPresence?: Array<{ productName?: string; status?: string }>;
      researchOutcome?: 'answered' | 'partial' | 'exhausted';
      answerGuidance?: {
        directAnswer?: unknown;
        coverage?: unknown;
      };
    };
    if (payload.researchOutcome === 'exhausted') continue;
    const targetNames = Array.isArray(payload.targetProductNames)
      ? payload.targetProductNames.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      : [];
    if (!webResearchTargetsCurrentIntent(targetNames, input.intent) || targetNames.length !== 1) continue;

    // Never assert exact-catalog absence when research says unknown.
    for (const presence of payload.catalogPresence ?? []) {
      if (!presence.productName) continue;
      if (presence.status === 'unknown' && answerStatesExactCatalogAbsence(input.answerText, presence.productName)) {
        return false;
      }
    }
  }
  return true;
}

export function expectedResearchGuidanceText(input: {
  toolResults: ToolResult[];
  intent: AgentIntentContract;
}) {
  const lines: string[] = [];
  const mentionPresentCatalogPresence = presentCatalogPresenceRelevant(input.intent);
  for (const result of input.toolResults) {
    if (result.tool !== 'web.researchProductFacts' || result.status !== 'ok') continue;
    const payload = result.payload as {
      targetProductNames?: unknown;
      catalogPresence?: Array<{ productName?: string; status?: string }>;
      nearbyCatalogProducts?: Array<{ name?: string }>;
      researchOutcome?: 'answered' | 'partial' | 'exhausted';
      answerGuidance?: {
        directAnswer?: unknown;
        coverage?: unknown;
      };
    };
    if (payload.researchOutcome === 'exhausted') continue;
    const targetNames = Array.isArray(payload.targetProductNames)
      ? payload.targetProductNames.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      : [];
    if (!webResearchTargetsCurrentIntent(targetNames, input.intent)) continue;
    if (targetNames.length !== 1) continue;
    const directAnswer = typeof payload.answerGuidance?.directAnswer === 'string'
      ? payload.answerGuidance.directAnswer.trim()
      : '';
    if (!directAnswer) continue;
    const coverage = Array.isArray(payload.answerGuidance?.coverage)
      ? payload.answerGuidance.coverage
      : [];
    const hasCheckedCoverage = coverage.some((item) => {
      if (!item || typeof item !== 'object') return false;
      const status = (item as { status?: unknown }).status;
      return status === 'confirmed' || status === 'not_confirmed' || status === 'ambiguous' || status === 'not_found';
    });
    if (!hasCheckedCoverage) continue;
    lines.push(directAnswer);
    let hasAbsentTarget = false;
    for (const presence of payload.catalogPresence ?? []) {
      if (!presence.productName) continue;
      if (presence.status === 'absent') {
        hasAbsentTarget = true;
        lines.push(`У нас точной модели ${presence.productName} в каталоге нет.`);
      } else if (presence.status === 'present' && mentionPresentCatalogPresence) {
        lines.push(presentCatalogPresenceLine(presence.productName, directAnswer));
      }
    }
    const nearbyNames = uniqueStrings((payload.nearbyCatalogProducts ?? [])
      .map((product) => typeof product.name === 'string' ? product.name.trim() : '')
      .filter(Boolean))
      .slice(0, 4);
    if (hasAbsentTarget && nearbyNames.length) {
      lines.push(`Рядом по каталогу есть: ${nearbyNames.join('; ')}.`);
    }
  }
  return uniqueStrings(lines).join(' ').trim();
}

export async function validateAgentAnswer(model: AgentManagerModel,
    input: AgentManagerReviewInput,
    budget?: AgentManagerTurnBudget
  ): Promise<PreSendReview> {
    const mechanicalIssues: PreSendReview['issues'] = [];
    if ((input.continuation?.status === 'clarify' || input.intent.grounding?.responseMode === 'clarify') && (
      input.answer.questionsAsked.length === 0 ||
      input.answer.selectionReadiness?.status === 'ready_for_exact_cards'
    )) {
      mechanicalIssues.push({
        code: 'observation_clarification_not_respected', severity: 'high',
        message: 'The current decision requires a buyer clarification. Ask the missing buyer condition and do not declare final suitability before the answer. Preliminary candidates may accompany the question.',
        evidence: input.continuation?.missingFacts.join(', ') || input.continuation?.rationale || input.intent.nextStepRationale
      });
    }
    const customerVisibleText = [input.answer.answerText,
      (input.answer.selectedProductIds?.length ?? 0) > 0 ? input.answer.selectionRationale : null
    ].filter(Boolean).join('\n');
    const customerLanguageReview = guardCustomerOutput({
      answerText: customerVisibleText,
      productCards: []
    });
    for (const issue of customerLanguageReview.issues) {
      mechanicalIssues.push({
        code: issue.code,
        severity: 'high',
        message: issue.message,
        evidence: issue.evidence
      });
    }
    if (typeof model.reviewCustomerLanguage === 'function') {
      try {
        budget?.consumeModelCall();
        const semanticLanguageReview = await model.reviewCustomerLanguage({
          technicalHandoffRequestedAndVerified: hasProvenTechnicalHandoffContinuation({ history: input.history, intent: input.intent, userMessage: input.userMessage, pendingLeadCaptureDraft: input.pendingLeadCaptureDraft }),
          userMessage: input.userMessage,
          intent: input.intent,
          answerText: customerVisibleText,
          products: input.products,
          toolResults: input.toolResults,
          verifiedProductFacts: input.verifiedProductFacts,
          conflictingVerifiedProductFacts: input.conflictingVerifiedProductFacts,
          signal: input.signal,
          deadlineAtMs: budget?.snapshot().usage.deadlineAtMs ?? input.structuredDeadlineAtMs
        });
        if (!semanticLanguageReview || typeof semanticLanguageReview.processDisclosure !== 'boolean' ||
          typeof semanticLanguageReview.evidence !== 'string' || typeof semanticLanguageReview.rationale !== 'string' ||
          (semanticLanguageReview.factualIssues !== undefined && !Array.isArray(semanticLanguageReview.factualIssues))) {
          throw new Error('semantic_language_review_invalid_contract');
        }
        if (semanticLanguageReview.processDisclosure) {
          mechanicalIssues.push({
            code: 'customer_output_research_process_disclosure',
            severity: 'high',
            message: 'Customer answer describes the internal research or verification process; state only concrete known facts and the exact unconfirmed customer fact.',
            evidence: semanticLanguageReview.evidence || semanticLanguageReview.rationale
          });
        }
        for (const issue of semanticLanguageReview.factualIssues ?? []) {
          if (!issue || typeof issue.claim !== 'string' || !issue.claim.trim() ||
            !customerVisibleText.includes(issue.claim) ||
            typeof issue.reason !== 'string' || !issue.reason.trim() ||
            (!input.toolResults.some((result) => result.requestId === issue.sourceResultId) &&
              ![...(input.verifiedProductFacts ?? []), ...(input.conflictingVerifiedProductFacts ?? [])]
                .some((fact) => `verified_fact:${fact.id}` === issue.sourceResultId))) {
            throw new Error('semantic_factual_review_unbound_evidence');
          }
          mechanicalIssues.push({
            code: 'research_guidance_uncertainty_mismatch',
            severity: 'high',
            message: `Grounded factual review rejected the claim "${issue.claim}" using ${issue.sourceResultId}: ${issue.reason}`,
            evidence: issue.claim
          });
        }
        for (const issue of semanticLanguageReview.ownershipIssues ?? []) {
          if (!issue.claim?.trim() || !customerVisibleText.includes(issue.claim) ||
            !issue.reason?.trim() || !issue.managerAction?.trim()) {
            throw new Error('semantic_ownership_review_unbound_evidence');
          }
          mechanicalIssues.push({
            code: 'manager_task_delegated_to_buyer', severity: 'medium',
            message: `Manager responsibility violation: ${issue.reason}. Required manager action: ${issue.managerAction}`,
            evidence: issue.claim
          });
        }
      } catch (error) {
        if (input.signal?.aborted) throw error;
        mechanicalIssues.push({
          code: 'customer_output_semantic_review_unavailable',
          severity: 'high',
          message: 'Semantic customer-language review did not complete, so the answer cannot be sent safely.',
          evidence: error instanceof AgentManagerTurnBudgetExceededError
            ? error.stopReason
            : safeError(error).code ?? safeError(error).message ?? 'semantic_language_review_failed'
        });
      }
    } else {
      mechanicalIssues.push({
        code: 'customer_output_semantic_review_unavailable',
        severity: 'high',
        message: 'Semantic customer-language review is unavailable, so the answer cannot be sent safely.',
        evidence: 'semantic_language_reviewer_not_configured'
      });
    }
    const contactInTurn = extractContact(input.userMessage);
    const strictRequirementGate = gateStrictSelectionRequirements(
      input.intent,
      canonicalProductClassFromIntent(input.intent),
      input.toolResults,
      input.products
    );
    const strictRequirementBlockers = strictRequirementGate.blockers;
    const answerAttemptsConcreteSelection = (
      (input.answer.selectedProductIds?.length ?? 0) > 0 ||
      input.answer.selectionReadiness?.canShowProductCards === true
    );
    if (strictRequirementBlockers.length && answerAttemptsConcreteSelection) {
      mechanicalIssues.push({
        code: 'unverifiable_strict_hard_constraint',
        severity: 'high',
        message: 'A strict buyer requirement has no deterministic verifier for the current product evidence, so no concrete model may be recommended.',
        evidence: strictRequirementBlockers.map((blocker) => `${blocker.id}:${blocker.kind}:${blocker.reason}`).join(', ')
      });
    }
    // Contract consistency (deterministic, no semantics): cards selected while
    // the readiness contract forbids showing them means the answer must narrow
    // down with a question instead of showing cards.
    if (selectedCardsContradictReadiness(input.answer)) {
      mechanicalIssues.push({
        code: 'cards_selected_without_readiness',
        severity: 'high',
        message: 'Product cards were selected while the selection readiness contract does not allow showing them; narrow down with a question instead of showing cards.',
        evidence: `selectionReadiness:${input.answer.selectionReadiness?.status ?? 'missing'}`
      });
    }
    // This checks the planner's ranking policy, not electrical compatibility.
    // Explicit price/weight priorities must not be overwritten by a size default.
    const primaryRanking = structuredSelectionRankingObjectives(input.intent)[0];
    const prioritizesMinimalNominal = !primaryRanking ||
      (primaryRanking.attribute === 'nominal_power_kw' && primaryRanking.direction === 'minimize');
    if (
      answerAttemptsConcreteSelection &&
      isGeneratorProductClass(canonicalProductClassFromIntent(input.intent)) &&
      prioritizesMinimalNominal
    ) {
      const requiredNominalKw = generatorLoadRequirementKw(input.toolResults);
      const productsById = new Map(input.products.map((product) => [product.id, product]));
      const selectedNominals = (input.answer.selectedProductIds ?? []).map((productId) => {
        const product = productsById.get(productId);
        return product ? qualifiedNominalActivePowerKw(product) : undefined;
      });
      const poolNominals = input.products.map((product) => qualifiedNominalActivePowerKw(product));
      if (generatorSelectionOversizeIssue({ requiredNominalKw, selectedNominals, poolNominals })) {
        mechanicalIssues.push({
          code: 'generator_selection_grossly_oversized',
          severity: 'high',
          message: `Every selected generator nominal (${selectedNominals.filter((nominal) => nominal !== undefined).join(', ')} kW) is more than double the calculated need (${requiredNominalKw} kW). Reselect minimal-sufficient-first: the closest nominal at or above the calculated need leads; a much bigger margin is only an alternative with an explicit price/fuel tradeoff, never the whole shortlist.`,
          evidence: (input.answer.selectedProductIds ?? []).join(',')
        });
      }
    }
    // Contact-request appropriateness is a semantic judgment over the typed leadAction
    // contract, not a regex over prose. Deterministic business rule: when the buyer
    // already gave phone/email in this message, the writer may confirm receipt only
    // after durable lead capture succeeded, and must never ask again for the data
    // already provided (asking for a still-missing field like the name is fine).
    const contactAlreadyComplete = Boolean(contactInTurn.phone || contactInTurn.email);
    const leadCaptureOkEarly = input.toolResults.some(isDurableLeadCaptureResult);
    if (
      contactAlreadyComplete &&
      !leadCaptureOkEarly &&
      (input.answer.leadAction === 'capture_contact' || input.answer.leadAction === 'confirm_contact_received')
    ) {
      mechanicalIssues.push({
        code: 'asks_contact_already_provided',
        severity: 'high',
        message: 'Buyer contact details are present but durable lead capture did not succeed; do not ask again and do not confirm receipt yet.',
        evidence: input.userMessage
      });
    }
    for (const question of input.answer.questionsAsked) {
      const existing = input.ledgerState.questionsById[question.questionId];
      if (existing && existing.status !== 'open') {
        mechanicalIssues.push({
          code: 'asks_closed_question',
          severity: 'high',
          message: `Question ${question.questionId} was already ${existing.status}.`,
          evidence: existing.text
        });
      }
    }
    const trustedFactSourceIds = new Set<string>([
      ...activeScopedLedgerFacts(input.ledgerState).map((fact) => fact.eventId),
      ...input.toolResults.filter(toolResultCanGroundFacts).map((result) => result.requestId),
      ...(input.verifiedProductFacts ?? []).map((fact) => `verified_fact:${fact.id}`)
    ]);
    const knownToolResultIds = new Set(input.toolResults.map((result) => result.requestId));
    for (const fact of input.answer.factsUsed) {
      const unknownSourceIds = fact.sourceEventIds.filter((sourceId) =>
        !trustedFactSourceIds.has(sourceId) && !knownToolResultIds.has(sourceId)
      );
      if (unknownSourceIds.length) {
        mechanicalIssues.push({
          code: 'unsupported_fact_source',
          severity: 'high',
          message: `Answer fact ${fact.factKey} references sources that are absent from ledger/tool artifacts and verified product evidence.`,
          evidence: unknownSourceIds.join(', ')
        });
      }
    }
    const failedFactSourceIds = factSourceIdsFromNonFactBearingTools({
      answer: input.answer,
      toolResults: input.toolResults
    });
    if (failedFactSourceIds.length) {
      mechanicalIssues.push({
        code: 'failed_tool_result_used_as_fact_source',
        severity: 'high',
        message: 'A failed, denied, timed out, not-found, or explicitly non-fact-bearing tool result was used as evidence for a factual claim.',
        evidence: failedFactSourceIds.join(', ')
      });
    }
    const unknownToolResultIds = input.answer.toolResultIds.filter((toolResultId) => !knownToolResultIds.has(toolResultId));
    if (unknownToolResultIds.length) {
      mechanicalIssues.push({
        code: 'unknown_tool_result_reference',
        severity: 'high',
        message: 'Answer references tool results that were not executed for this turn.',
        evidence: unknownToolResultIds.join(', ')
      });
    }
    const productEvidenceIds = new Set(
      input.productEvidenceRoles
        ? input.productEvidenceRoles
            .filter((role) => role.eligibleForRecommendation)
            .map((role) => role.productId)
        : input.products.map((product) => product.id)
    );
    const unknownSelectedProductIds = (input.answer.selectedProductIds ?? []).filter((productId) =>
      !productEvidenceIds.has(productId)
    );
    if (unknownSelectedProductIds.length) {
      mechanicalIssues.push({
        code: 'selected_product_without_evidence',
        severity: 'high',
        message: 'Answer selects product IDs that are absent from the recommendation-eligible product evidence passed to the writer.',
        evidence: unknownSelectedProductIds.join(', ')
      });
    }
    if ((input.answer.selectedProductIds ?? []).length > 0 && !input.answer.selectionRationale?.trim()) {
      mechanicalIssues.push({
        code: 'selected_products_without_llm_rationale',
        severity: 'high',
        message: 'Selected product cards require a customer-visible rationale from the answer contract.',
        evidence: (input.answer.selectedProductIds ?? []).join(', ')
      });
    }
    const leadCaptureOk = input.toolResults.some(isDurableLeadCaptureResult);
    const leadCaptureFailed = input.toolResults.some((result) => result.tool === 'lead.capture' && result.status !== 'ok');
    if ((input.answer.leadAction === 'capture_contact' || input.answer.leadAction === 'confirm_contact_received') && !leadCaptureOk) {
      const contactMissing = leadCaptureMissingContact(input.toolResults);
      if ((contactMissing || leadCaptureFailed) && !hasLeadContact(contactInTurn)) {
        mechanicalIssues.push({
          code: 'lead_capture_missing_contact_offer_form',
          severity: 'medium',
          message: 'The answer tried to confirm a lead before the buyer provided contact data; rewrite to offer the contact form.',
          evidence: JSON.stringify(input.toolResults.filter((result) => result.tool === 'lead.capture'))
        });
      } else if (contactMissing && hasLeadContact(contactInTurn) && leadCaptureMissingName(input.toolResults)) {
        mechanicalIssues.push({
          code: 'lead_capture_missing_name',
          severity: 'medium',
          message: 'The answer tried to confirm a lead before the buyer provided a name; rewrite to acknowledge the phone and ask for the missing name.',
          evidence: JSON.stringify(input.toolResults.filter((result) => result.tool === 'lead.capture'))
        });
      } else {
        mechanicalIssues.push({
          code: 'lead_confirmation_without_local_capture',
          severity: 'high',
          message: 'The bot may confirm a contact only after local lead and outbox capture succeeded.',
          evidence: JSON.stringify(input.toolResults.filter((result) => result.tool === 'lead.capture'))
        });
      }
    }
    if (hasAdjudicationRisk({ answerRiskFlags: input.answer.riskFlags, toolResults: input.toolResults })) {
      mechanicalIssues.push({
        code: 'requires_adjudication',
        severity: 'high',
        message: 'High-risk source disagreement must be adjudicated before a buyer-visible factual answer.',
        evidence: JSON.stringify({ answerRiskFlags: input.answer.riskFlags, toolWarnings: input.toolResults.flatMap((result) => result.warnings) })
      });
    }
    if (hasUnsupportedClaimRisk(input.answer.riskFlags)) {
      mechanicalIssues.push({
        code: 'unsupported_claim_risk_flag',
        severity: 'high',
        message: 'Answer contract marks a factual claim as unsupported or unverified.',
        evidence: input.answer.riskFlags.join(', ')
      });
    }
    const expectedResearchGuidance = expectedResearchGuidanceText({
      toolResults: input.toolResults,
      intent: input.intent
    });
    if (expectedResearchGuidance && !researchGuidanceSemanticallySatisfied({
      answerText: input.answer.answerText,
      toolResults: input.toolResults,
      intent: input.intent
    })) {
      mechanicalIssues.push({
        code: 'research_guidance_uncertainty_mismatch',
        severity: 'high',
        message: 'Exact-model research has unconfirmed or ambiguous coverage; use checked answerGuidance instead of a broader generated claim.',
        evidence: expectedResearchGuidance
      });
    }
    const researchStatus = technicalResearchStatus(input.toolResults, input.intent);
    const incompleteWebWithoutExhaustion = researchStatus.incompleteResultIds.length > 0;
    const authorizedLeadContinuation = hasProvenTechnicalHandoffContinuation({
      history: input.history,
      userMessage: input.userMessage,
      intent: input.intent,
      pendingLeadCaptureDraft: input.pendingLeadCaptureDraft
    });
    const technicalOrSelectionTask = !authorizedLeadContinuation &&
      intentRequiresSearchBeforeSpecialist(input.intent);
    const webResearchActuallyExhausted = researchStatus.sourcesExhausted;
    const answerOffersTechnicalHandoff = input.answer.leadAction === 'offer_form' ||
      input.answer.leadAction === 'capture_contact';
    if (
      answerOffersTechnicalHandoff &&
      (
        (technicalOrSelectionTask && !webResearchActuallyExhausted) ||
        incompleteWebWithoutExhaustion
      )
    ) {
      mechanicalIssues.push({
        code: 'premature_handoff_before_web_exhausted',
        severity: 'high',
        message: 'A technical, product-selection, or comparison handoff is allowed only after web research actually exhausts the available sources; a missing, successful, failed, partial, timed-out, aborted, or budget-skipped check is not exhaustion.',
        evidence: JSON.stringify(input.toolResults.filter((result) => result.tool === 'web.researchProductFacts'))
      });
    }
    if (mechanicalIssues.length) {
      // Responsibility shortcomings trigger bounded repair, not an empty chat
      // response. Keep the unresolved quality finding visible independently of
      // factual/business delivery gates.
      return { verdict: mechanicalIssues.every(issue => issue.code === 'manager_task_delegated_to_buyer') ? 'pass' : 'block',
        issues: uniqueReviewIssues(mechanicalIssues) };
    }
    return { verdict: 'pass', issues: [] };
  }
