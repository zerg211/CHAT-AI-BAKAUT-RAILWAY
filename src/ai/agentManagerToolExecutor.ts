import { requestStringArray, productMentionMatchesName, canonicalProductClassFromIntent, coerceVisibleCardIntent, generatorLoadRequirementKw } from './agentManagerReleaseValidator.js';
import { AgentManagerModel, leadCaptureHash, buyerQuestionContainsContactPii, currentEvidencePlannerName, requestedPreferredContact, leadCaptureActionFingerprint, durableLeadActionFingerprint, pendingLeadCaptureDraftMatchesAuthorizationScope, isDurableLeadCaptureResult, exactTargetProductMentionRoles, intentRequiresSearchBeforeSpecialist, hasProvenTechnicalHandoffContinuation } from './agentManagerModelAdapter.js';
import { createHash } from 'node:crypto';
import { config } from '../config.js';
import { ConversationRepository, LeadRepository, ProductRepository } from '../db/repositories.js';
import type { ConversationSession, CustomerNeedState, LeadCaptureDraft, Message, Product, ProductSelectionClass, VerifiedProductFact } from '../shared/types.js';
import { DEFAULT_AGENT_INTENT_GROUNDING_RATIONALE, ToolResultSchema, type AgentIntentContract, type ToolRequest, type ToolResult } from './agentManagerContracts.js';
import { extractCatalogProductComparisonFacts, researchProductComparisonFacts, researchResultCoversFactSlot, type ProductComparisonResearchFact, type ProductComparisonResearchResult, type ProductResearchDocumentReadContext, type ProductResearchTraceEvent } from './productComparisonResearch.js';
import { refreshExactCatalogProducts } from '../catalog/sitemapSync.js';
import { extractWeightKg, fromEscaped, generatorAutoStartProfile, generatorPhaseProfile, generatorRemoteStartProfile, productMatchesIntent, productPowerSource } from './productClassifier.js';
import { safeError } from './responseUtils.js';
import { extractContact } from './contactExtraction.js';
import { budgetMaxFromNeedState, filterGeneratorProductsByLoadProfile, gateStrictSelectionRequirements, hasStructuredGeneratorRemoteStartPreference, productMeetsSupportedStrictAutoStartRequirement, productMeetsSupportedStrictRemoteStartRequirement, productMeetsSupportedStrictFuelRequirement, productMeetsSupportedStrictPriceVisibilityRequirement, productMeetsSupportedStrictVoltageRequirement, qualifiedNominalActivePowerKw, rankCatalogProductsByStructuredPreferences, structuredSelectionRankingObjectives, toolRequestProductIntent, toolRequestScopedQuery, uniqueStrings } from './agentManagerCardSelection.js';
import { buildGeneratorLoadToolPayload, isGeneratorProductClass } from './agentManagerGeneratorLoad.js';
import { agentManagerToolRegistry, toolResultByteLength, validateToolResultOutput } from './agentManagerToolRegistry.js';
import { AgentManagerTurnBudget, AgentManagerTurnBudgetExceededError } from './agentManagerTurnBudget.js';
import { compactModelText, exactProductIdentity, modelTextTokens, normalizeModelText, textMatchesTargetName, tokenHasDigit, tokenHasLetter } from './modelTextMatching.js';
import { matchingVerifiedFactsForRequest, reusableVerifiedFact, researchFactConfidenceNumber, researchFactMemoryCandidates, verifiedFactCoverageForRequest, verifiedFactsCoverRequest, verifiedFactsResearchResult } from './verifiedFactMemory.js';
import { canonicalFactAttribute, verifiedFactValueKey } from './verifiedFactNormalization.js';
import { readCurrentSitePrice } from '../catalog/currentSitePrice.js';
import { verifyBudgetPrices } from '../catalog/verifyBudgetPrices.js';
import { extractEvidenceInput } from './evidenceInput.js';
import { readFirstPartyPage } from './siteFirstParty.js';
import { bindEphemeralPageIdentity } from './productIdentityResolver.js';
import { classifyCompanyPath } from './companyKnowledge.js';
import { buildRequirementProofs, combinedRequirementProofStatus, requirementUsesGenericReadProof, requirementProofsFor, resolvedRequirementEligibilityStatus, selectionRequirementAttributeMatches } from './requirementProofs.js';

export function groundedBuyerQuestion(buyerQuestion: string | null | undefined, history: Message[]) {
  const question = buyerQuestion?.trim() ?? '';
  if (!question || question.length > 1_000 || buyerQuestionContainsContactPii(question)) return null;
  return history.some((message) => message.role === 'user' && message.content.includes(question))
    ? question
    : null;
}

export function blockedLeadReplayResult(request: ToolRequest) {
  return ToolResultSchema.parse({
    requestId: request.id,
    tool: request.tool,
    status: 'denied',
    payload: { reason: 'unverifiable_persisted_lead_side_effect' },
    warnings: ['lead_capture_reexecution_blocked_unverifiable_side_effect']
  });
}

export function isBlockedLeadReplayResult(result: ToolResult) {
  return result.tool === 'lead.capture' &&
    result.status === 'denied' &&
    result.warnings.includes('lead_capture_reexecution_blocked_unverifiable_side_effect');
}

export function durableLeadOutboxStatus(row: unknown) {
  if (!row || typeof row !== 'object') return null;
  const status = (row as { status?: unknown }).status;
  return status === 'pending' || status === 'sending' || status === 'sent' || status === 'failed'
    ? status
    : null;
}

export function typedProductClassKey(canonicalValue: unknown, fallbackValue: unknown) {
  const canonicalClass = coerceVisibleCardIntent(canonicalValue);
  if (canonicalClass !== 'unknown') return canonicalClass;
  if (typeof fallbackValue !== 'string' || !fallbackValue.trim()) return null;
  const fallbackClass = fallbackValue.trim().toLocaleLowerCase('ru-RU');
  return fallbackClass === 'unknown' ? null : fallbackClass;
}

export function productMentionRoleForTargetName(intent: AgentIntentContract | undefined, targetName: string) {
  const mentions = intent?.productMentions ?? [];
  const matching = mentions.filter((mention) => productMentionMatchesName(mention.name, targetName));
  if (!matching.length) return undefined;
  const targetLike = matching.find((mention) => exactTargetProductMentionRoles.has(mention.role));
  return targetLike?.role ?? matching[0]?.role;
}

export function productNameAllowedAsExactTarget(input: {
  intent?: AgentIntentContract;
  productName: string;
}) {
  const role = productMentionRoleForTargetName(input.intent, input.productName);
  return role === undefined || exactTargetProductMentionRoles.has(role);
}

export function targetProductNamesForRequest(request: ToolRequest, intent?: AgentIntentContract) {
  return uniqueStrings(
    requestStringArray(request.args.productNames).filter((productName) =>
      productNameAllowedAsExactTarget({ intent, productName })
    )
  );
}

export function suppressedContextTargetProductNamesForRequest(request: ToolRequest, intent?: AgentIntentContract) {
  const targetNames = requestStringArray(request.args.productNames);
  if (!targetNames.length || !(intent?.productMentions?.length)) return [];
  return uniqueStrings(targetNames.filter((productName) =>
    !productNameAllowedAsExactTarget({ intent, productName })
  ));
}

export function comparisonAttributesForRequest(request: ToolRequest) {
  return uniqueStrings(requestStringArray(request.args.comparisonAttributes));
}

export function comparisonAttributeBindingsForRequest(request: ToolRequest) {
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

export function productLookupText(product: Product) {
  return [
    product.name,
    product.brand,
    product.externalId,
    product.slug,
    product.sourceUrl
  ].filter(Boolean).join(' ');
}

export function productMatchesTargetName(product: Product, targetName: string) {
  return textMatchesTargetName(productLookupText(product), targetName);
}

export function productMatchesExactTargetIdentity(product: Product, targetName: string) {
  const identity = exactProductIdentity(targetName);
  return identity.decisiveParts.length > 0 && identity.matches(productLookupText(product));
}

export function resolvedToolProductIntent(request: ToolRequest, intent: AgentIntentContract) {
  const requestClass = toolRequestProductIntent(request);
  if (requestClass !== 'unknown') return requestClass;
  if (typedProductClassKey(request.args.canonicalProductIntent, request.args.productIntent) !== null) {
    return 'unknown';
  }
  return canonicalProductClassFromIntent(intent);
}

export function toolRequestTargetsPrimarySelectionClass(request: ToolRequest, intent: AgentIntentContract) {
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

export function resolvedToolPowerSource(request: ToolRequest, intent: AgentIntentContract) {
  const value = request.args.powerSource ?? intent.selectionPolicy?.powerSource;
  return value === 'battery' || value === 'fuel' || value === 'mains' || value === 'any'
    ? value
    : undefined;
}

export const WEB_ANSWER_RESERVE_MS = 30_000;

export const WEB_MIN_EXECUTION_MS = 6_000;

export const CATALOG_ANSWER_RESERVE_MS = 8_000;

export const CURRENT_PRICE_VERIFICATION_TOP_K = 6;

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

export function productsFromPersistedToolResult(result: ToolResult): Product[] {
  const products = (result.payload as { products?: unknown }).products;
  if (!Array.isArray(products)) return [];
  return products.filter((item): item is Product => Boolean(
    item &&
    typeof item === 'object' &&
    typeof (item as { id?: unknown }).id === 'string' &&
    typeof (item as { name?: unknown }).name === 'string'
  ));
}

export function maximumToolResultItemCount(value: unknown): number {
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

export function assertToolResultBounds(result: ToolResult) {
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

export function productMeetsStructuredPowerSource(
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

export function hardSelectionNumber(intent: AgentIntentContract, kinds: string[]) {
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

export function resolvedEligibilityStatusForStrictKinds(input: {
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

export function passesNativeConstraintOrResolvedProof(input: {
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

export type SelectionCandidateTier = 'exact_match' | 'preliminary_match' | 'rejected';

export function visibleSelectionTier(intent: AgentIntentContract): Exclude<SelectionCandidateTier, 'rejected'> {
  return intent.selectionPolicy?.selectionGoal === 'final_fit'
    ? 'exact_match'
    : 'preliminary_match';
}

export function structuredCatalogExpansionQuery(
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

export function targetBrandCandidates(targetNames: string[]) {
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

export function productHasTargetBrand(product: Product, brandCandidates: string[]) {
  if (!brandCandidates.length) return false;
  const productText = compactModelText([product.brand, product.name, product.sourceUrl].filter(Boolean).join(' '));
  return brandCandidates.some((brand) => productText.includes(compactModelText(brand)));
}

export function compactCatalogProduct(product: Product, relation: string) {
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

export function catalogPresenceForTargets(
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

export function nearbyCatalogProductsForTargets(targetNames: string[], products: Product[]) {
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

export function productForResearchFact(input: {
  fact: ProductComparisonResearchFact;
  targetProductNames: string[];
  products: Product[];
}) {
  return input.products.find((product) => textMatchesTargetName(product.name, input.fact.productName)) ?? null;
}

export function researchFactProductName(input: {
  fact: ProductComparisonResearchFact;
  targetProductNames: string[];
  product?: Product | null;
}) {
  const factName = input.fact.productName.trim();
  if (factName) return factName;
  const targetName = input.targetProductNames.find((name) => name.trim().length > 0);
  return targetName ?? input.product?.name ?? '';
}

export function exactCoverageProductNamesMatch(left: string | null, right: string | null) {
  if (!left || !right) return left === right;
  if (compactModelText(left) === compactModelText(right)) return true;
  return textMatchesTargetName(left, right) && textMatchesTargetName(right, left);
}

export function mergeVerifiedMemoryWithResearch(
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

export function productNamesFromToolRequest(request: ToolRequest | undefined) {
  const productNames = request?.args.productNames;
  if (!Array.isArray(productNames)) return [];
  return productNames
    .map((item) => typeof item === 'string' ? item.trim() : '')
    .filter(Boolean);
}

export class AgentManagerToolExecutor {
private readonly embeddingCoverageCache = new Map<string, { usable: boolean; expiresAt: number }>();
private readonly queryEmbeddingCache = new Map<string, { value: number[]; expiresAt: number }>();
constructor(
    private readonly conversations: ConversationRepository,
    private readonly products: ProductRepository,
    private readonly leads: LeadRepository,
    private readonly model: AgentManagerModel,
    private readonly embedQuery: (text: string, signal?: AbortSignal) => Promise<number[] | undefined | null>,
    private readonly readSitePrice: typeof readCurrentSitePrice,
    private readonly trace: (sessionId: string, turnId: string, phase: string, eventType: string, payload: Record<string, unknown>) => Promise<void>
  ) {}
verifiedFactRepository() {
    const repo = this.products as ProductRepository & {
      searchVerifiedProductFacts?: ProductRepository['searchVerifiedProductFacts'];
      markVerifiedProductFactsUsed?: ProductRepository['markVerifiedProductFactsUsed'];
      upsertVerifiedProductFact?: ProductRepository['upsertVerifiedProductFact'];
      upsertVerifiedWebFact?: ProductRepository['upsertVerifiedWebFact'];
    };
    return repo;
  }

async loadVerifiedProductEvidence(products: Product[], attributes: string[] = []) {
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

async researchFromVerifiedFactMemory(input: {
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

async persistVerifiedResearchFacts(input: {
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

async executeTools(input: {
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
        } else if (request.tool === 'site.readFirstPartyPage') {
          const pageUrl = typeof request.args.url === 'string' ? request.args.url.trim() : '';
          if (!pageUrl) {
            result = ToolResultSchema.parse({
              requestId: request.id,
              tool: request.tool,
              status: 'error',
              payload: { canonicalUrl: '', error: { code: 'first_party_url_missing' } },
              warnings: ['first_party_url_missing'],
              errorCode: 'first_party_url_missing'
            });
          } else {
            const read = await readFirstPartyPage(pageUrl, { baseUrl: config.CATALOG_BASE_URL });
            if (read.ok) {
              const page = read.page;
              // F13 reconciliation: bind the verified page to the local catalog when
              // possible. An absent match stays an ephemeral verified page identity —
              // the answer may use it without requiring full catalog ingestion.
              let catalogProductId: string | undefined;
              let catalogMatch: 'matched' | 'absent' | undefined;
              if (page.pageKind === 'product') {
                try {
                  const exactLookup = this.products as ProductRepository & {
                    getProductByExactArticle?: (article: string) => Promise<Product | null>;
                    getProductByExactExternalId?: (externalId: string) => Promise<Product | null>;
                    getProductBySourceUrl?: (sourceUrl: string) => Promise<Product | null>;
                  };
                  const candidates: Array<Promise<Product | null>> = [];
                  if (page.productIdentity?.article && typeof exactLookup.getProductByExactArticle === 'function') {
                    candidates.push(exactLookup.getProductByExactArticle(page.productIdentity.article));
                  }
                  if (typeof exactLookup.getProductBySourceUrl === 'function') {
                    candidates.push(exactLookup.getProductBySourceUrl(page.canonicalUrl));
                  }
                  for (const candidate of candidates) {
                    const hit = await candidate;
                    if (hit) {
                      catalogProductId = hit.id;
                      catalogMatch = 'matched';
                      productsById.set(hit.id, hit);
                      break;
                    }
                  }
                  if (!catalogProductId) catalogMatch = 'absent';
                } catch (error) {
                  catalogMatch = 'absent';
                }
              }
              // Single ownership (F13): the ephemeral verified-page identity is built
              // by the product identity resolver, never assembled inline here.
              const ephemeralPageIdentity = page.pageKind === 'product' && !catalogProductId
                ? bindEphemeralPageIdentity({
                  canonicalUrl: page.canonicalUrl,
                  pageVerified: true,
                  title: page.title,
                  article: page.productIdentity?.article
                })
                : null;
              result = ToolResultSchema.parse({
                requestId: request.id,
                tool: request.tool,
                status: 'ok',
                payload: {
                  canonicalUrl: page.canonicalUrl,
                  pageKind: page.pageKind,
                  title: page.title,
                  text: page.text.slice(0, 4000),
                  ...(page.productIdentity ? { productIdentity: page.productIdentity } : {}),
                  ...(page.companyInfo ? { companyInfo: page.companyInfo } : {}),
                  ...(catalogProductId ? { catalogProductId } : {}),
                  ...(catalogMatch ? { catalogMatch } : {}),
                  ...(ephemeralPageIdentity ? { ephemeralPageIdentity } : {}),
                  sourceFingerprint: page.sourceFingerprint,
                  observedAt: page.observedAt
                },
                warnings: catalogMatch === 'absent' ? ['first_party_page_without_catalog_match'] : []
              });
            } else {
              const failure = read.failure;
              const legacyStatus = failure.code === 'denied'
                ? 'denied' as const
                : failure.code === 'timeout'
                  ? 'timeout' as const
                  : failure.code === 'http_status' && failure.status === 404
                    ? 'not_found' as const
                    : 'error' as const;
              const observationStatus = failure.code === 'http_status' && failure.status === 404
                ? 'not_found' as const
                : failure.code === 'http_status'
                  ? 'unavailable' as const
                  : failure.code === 'unsupported'
                    ? 'unsupported' as const
                    : failure.code === 'unreadable'
                      ? 'malformed' as const
                      : undefined;
              result = ToolResultSchema.parse({
                requestId: request.id,
                tool: request.tool,
                status: legacyStatus,
                ...(observationStatus ? { observationStatus } : {}),
                payload: {
                  canonicalUrl: failure.canonicalUrl,
                  failureCode: failure.code,
                  ...(failure.status !== undefined ? { status: failure.status } : {}),
                  observedAt: failure.observedAt,
                  error: { code: `first_party_unread:${failure.code}` }
                },
                warnings: [`first_party_unread:${failure.code}`],
                errorCode: `first_party_unread:${failure.code}`
              });
            }
          }
        } else if (request.tool === 'site.searchCompanyKnowledge') {
          const companyQuery = typeof request.args.query === 'string' ? request.args.query.trim() : '';
          const companyLimit = Math.max(1, Math.min(6, Number(request.args.limit ?? 4)));
          if (!companyQuery) {
            result = ToolResultSchema.parse({
              requestId: request.id,
              tool: request.tool,
              status: 'error',
              payload: { query: '', error: { code: 'company_knowledge_query_missing' } },
              warnings: ['company_knowledge_query_missing'],
              errorCode: 'company_knowledge_query_missing'
            });
          } else {
            let companyPages: Array<{ url: string; title: string; pageKind: string; volatility?: 'STABLE' | 'SEMI_VOLATILE'; snippet: string }> = [];
            let companyError: unknown = null;
            try {
              const rows = await this.products.searchCatalogPages(companyQuery, companyLimit);
              companyPages = rows.map((row) => {
                let pathname = '';
                try {
                  pathname = new URL(row.sourceUrl).pathname;
                } catch {
                  pathname = row.sourceUrl;
                }
                const classified = classifyCompanyPath(pathname);
                const snippet = (row.summary ?? row.content ?? '').slice(0, 1200);
                return {
                  url: row.sourceUrl,
                  title: row.title,
                  pageKind: classified?.kind ?? row.pageType,
                  ...(classified ? { volatility: classified.volatility } : {}),
                  snippet
                };
              });
            } catch (error) {
              companyError = error;
            }
            if (companyError) {
              result = ToolResultSchema.parse({
                requestId: request.id,
                tool: request.tool,
                status: 'error',
                payload: { query: companyQuery, error: { code: 'company_knowledge_search_failed' } },
                warnings: ['company_knowledge_search_failed'],
                errorCode: 'company_knowledge_search_failed'
              });
            } else {
              result = ToolResultSchema.parse({
                requestId: request.id,
                tool: request.tool,
                status: companyPages.length > 0 ? 'ok' : 'not_found',
                payload: {
                  query: companyQuery,
                  pages: companyPages,
                  ...(companyPages.length > 0 ? {} : { reason: 'no_company_pages_matched' })
                },
                warnings: companyPages.length > 0 ? [] : ['company_knowledge_no_matches']
              });
            }
          }
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

async canUseProductEmbeddings(signal?: AbortSignal) {
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

async createCachedQueryEmbedding(text: string, signal?: AbortSignal) {
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

async searchCatalogProducts(input: {
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
    // Deterministic exact-identifier pass (F12): numeric articles and catalog ids from
    // the request text resolve via exact DB selectors with no embeddings. A miss only
    // means "not proven by this selector" — broad retrieval still runs for it.
    const evidenceIdentifiers = extractEvidenceInput(`${query} ${embeddingQuery}`).identifiers
      .filter((identifier) => identifier.kind === 'numeric_article' || identifier.kind === 'catalog_id');
    const resolvedIdentifierKeys = new Set<string>();
    const exactIdentifierSearch = this.products as ProductRepository & {
      getProductByExactArticle?: (article: string) => Promise<Product | null>;
      getProductByExactExternalId?: (externalId: string) => Promise<Product | null>;
    };
    for (const identifier of evidenceIdentifiers) {
      try {
        const lookup = identifier.kind === 'numeric_article'
          ? exactIdentifierSearch.getProductByExactArticle
          : exactIdentifierSearch.getProductByExactExternalId;
        if (typeof lookup !== 'function') continue;
        const hit = identifier.kind === 'numeric_article'
          ? await exactIdentifierSearch.getProductByExactArticle!(identifier.normalized)
          : await exactIdentifierSearch.getProductByExactExternalId!(identifier.normalized);
        if (hit) {
          textProducts.push(hit);
          resolvedIdentifierKeys.add(identifier.kind + ':' + identifier.normalized);
        }
      } catch (error) {
        warnings.push(`catalog_exact_identifier_error:${safeError(error).code ?? safeError(error).message}`);
      }
    }
    if (textProducts.length > 1) {
      textProducts = [...new Map(textProducts.map((product) => [product.id, product])).values()];
    }
    for (const key of resolvedIdentifierKeys) warnings.push(`catalog_exact_identifier_match:${key}`);
    const exactEvidenceSaturated = evidenceIdentifiers.length > 0 &&
      evidenceIdentifiers.every((identifier) => resolvedIdentifierKeys.has(identifier.kind + ':' + identifier.normalized));
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

    if (!exactTargetsResolved(textProducts) && !exactEvidenceSaturated) {
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
    if (!exactTargetsResolved(textProducts) && !exactEvidenceSaturated && vectorSearchFn && await this.canUseProductEmbeddings(input.signal)) {
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
}
