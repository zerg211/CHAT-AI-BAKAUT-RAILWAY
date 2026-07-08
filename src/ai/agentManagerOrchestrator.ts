import { config } from '../config.js';
import { ConversationRepository, LeadRepository, ProductRepository } from '../db/repositories.js';
import type { AgentSourcePolicyV2, AgentTaskType, AgentTurnContract, ChatResponsePayload, ConversationSession, CustomerNeedState, Message, Product, ProductCard, ProductSelectionClass } from '../shared/types.js';
import {
  AgentIntentContractSchema,
  AnswerContractSchema,
  LedgerStateDeltaSchema,
  PreSendReviewSchema,
  ToolResultSchema,
  normalizeLedgerStateDeltaEvents,
  type AgentIntentContract,
  type AgentIntentGrounding,
  type AnswerContract,
  type DialogueLedgerEvent,
  type LedgerStateDelta,
  type PreSendReview,
  type ProductMentionRole,
  type ToolRequest,
  type ToolResult
} from './agentManagerContracts.js';
import { deriveNeedStateSnapshotFromLedger, reduceDialogueLedger, type ReducedDialogueLedgerState } from './dialogueLedgerReducer.js';
import { createEmbedding } from './openaiClient.js';
import { createStructuredJsonResponse } from './openaiStructured.js';
import { researchProductComparisonFacts, type ProductComparisonResearchFact, type ProductComparisonResearchResult } from './productComparisonResearch.js';
import {
  extractWeightKg,
  fromEscaped,
  inferProductIntent,
  isBatteryPowerStation,
  parseWeightNeedRangeKg,
  productMatchesIntent,
  requiresBatteryPowerStationFromText
} from './productClassifier.js';
import { emptyNeedState } from './needState.js';
import { safeError } from './responseUtils.js';
import { getAgentManagerRuntimeDecision } from './agentManagerRuntime.js';
import { extractContact, hasLeadContact } from './contactExtraction.js';
import {
  answerRequestsContactData,
  leadCaptureMissingContact,
  leadCaptureMissingName,
  leadCaptureRepairText,
  stripContactRequestSentence
} from './leadReviewGuards.js';
import { hasAdjudicationRisk, hasUnsupportedClaimRisk } from './riskReviewGuards.js';
import {
  ambiguousCutterRequestNeedsMaterialClarification,
  assessVisibleCardReadiness,
  budgetMaxFromNeedState,
  filterGeneratorProductsByLoadProfile,
  filterPlateProductsByCurrentTask,
  productSelectionClasses,
  productCards,
  rankCatalogProductsByNumericFit,
  selectProductsForVisibleCards,
  suppressVisibleCardsForReadiness,
  toolRequestProductIntent,
  toolRequestScopedQuery,
  uniqueStrings
} from './agentManagerCardSelection.js';
import {
  buildGeneratorLoadToolPayload,
  hasUnconfirmedGeneratorLoadBasisResult,
  isGeneratorProductClass
} from './agentManagerGeneratorLoad.js';
import { approvedAnswerStyleExamplesPromptBlock } from './answerStyleExamples.js';
import {
  compactModelText,
  isModelTokenChar,
  modelIdentifierDisplayTokens,
  modelIdentifierTokens,
  modelTextTokens,
  normalizeModelText,
  textMatchesTargetName,
  tokenHasDigit,
  tokenHasLetter
} from './modelTextMatching.js';
import {
  matchingVerifiedFactsForRequest,
  researchFactConfidenceNumber,
  verifiedFactsCoverRequest,
  verifiedFactsResearchResult
} from './verifiedFactMemory.js';

export interface AgentManagerGenerateInput {
  sessionId: string;
  userMessage: string;
  turnId?: string;
  skipUserMessage?: boolean;
  onDelta?: (text: string) => void | Promise<void>;
  signal?: AbortSignal;
}

export interface AgentManagerRecoverInput {
  sessionId: string;
  turnId: string;
  onDelta?: (text: string) => void | Promise<void>;
  signal?: AbortSignal;
}

export interface AgentManagerModel {
  proposeLedgerDelta(input: AgentManagerModelInput): Promise<LedgerStateDelta>;
  planTurn(input: AgentManagerModelInput & { ledgerState: ReducedDialogueLedgerState }): Promise<AgentIntentContract>;
  composeAnswer(input: AgentManagerAnswerInput): Promise<AnswerContract>;
  reviewAnswer(input: AgentManagerReviewInput): Promise<PreSendReview>;
}

export interface AgentManagerModelInput {
  session: ConversationSession;
  history: Message[];
  userMessage: string;
  ledgerEvents: DialogueLedgerEvent[];
  signal?: AbortSignal;
}

export interface AgentManagerAnswerInput extends AgentManagerModelInput {
  ledgerState: ReducedDialogueLedgerState;
  intent: AgentIntentContract;
  toolResults: ToolResult[];
  products: Product[];
  requiredResponseClauses?: RequiredResponseClause[];
}

export interface AgentManagerReviewInput extends AgentManagerAnswerInput {
  answer: AnswerContract;
}

function compactHistory(history: Message[]) {
  return history.slice(-12).map((message) => ({
    role: message.role,
    content: message.content,
    createdAt: message.createdAt
  }));
}

function compactLedger(state: ReducedDialogueLedgerState) {
  return {
    facts: Object.values(state.factsByKey).map((fact) => ({
      key: fact.factKey,
      value: fact.value,
      status: fact.status,
      evidence: fact.evidence,
      eventId: fact.eventId
    })),
    openQuestions: state.openQuestions.map((question) => ({
      questionId: question.questionId,
      text: question.text,
      status: question.status
    })),
    questions: Object.values(state.questionsById).map((question) => ({
      questionId: question.questionId,
      text: question.text,
      status: question.status,
      answer: question.answer
    }))
  };
}

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
  created_at?: string | Date | null;
};

type RequiredResponseClause = {
  code: string;
  sourceRequestId: string;
  instruction: string;
  productName?: string;
  catalogProductNames?: string[];
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

function answerEvidenceSourceHints(input: {
  ledgerState: ReducedDialogueLedgerState;
  toolResults: ToolResult[];
}) {
  const ledgerFacts = Object.values(input.ledgerState.factsByKey).map((fact) => ({
    id: fact.eventId,
    factKey: fact.factKey,
    value: fact.value,
    evidence: fact.evidence,
    status: fact.status
  }));
  const toolResults = input.toolResults.map((result) => ({
    id: result.requestId,
    tool: result.tool,
    status: result.status,
    warnings: result.warnings
  }));
  const factSourceToolIds = toolResults
    .filter((result) => result.status === 'ok')
    .map((result) => result.id);
  return {
    allowedSourceIds: [
      ...ledgerFacts.map((fact) => fact.id),
      ...factSourceToolIds
    ],
    ledgerFacts,
    toolResults
  };
}

function normalizeAnswerEvidenceSources(input: {
  answer: AnswerContract;
  ledgerState: ReducedDialogueLedgerState;
  toolResults: ToolResult[];
}): AnswerContract {
  const trustedFactSourceIds = new Set<string>([
    ...input.ledgerState.eventIds,
    ...input.toolResults
      .filter((result) => result.status === 'ok')
      .map((result) => result.requestId)
  ]);
  const toolResultIds = new Set(input.toolResults.map((result) => result.requestId));
  const validAnswerToolResultIds = input.answer.toolResultIds.filter((toolResultId) => toolResultIds.has(toolResultId));
  const okToolResultIds = input.toolResults
    .filter((result) => result.status === 'ok')
    .map((result) => result.requestId);
  const fallbackOkToolResultIds = validAnswerToolResultIds.length || okToolResultIds.length !== 1
    ? []
    : okToolResultIds;

  const factsUsed = input.answer.factsUsed.map((fact) => {
    const exactSourceIds = fact.sourceEventIds.filter((sourceId) => trustedFactSourceIds.has(sourceId));
    if (exactSourceIds.length) {
      return { ...fact, sourceEventIds: [...new Set(exactSourceIds)] };
    }

    const ledgerFact = input.ledgerState.factsByKey[fact.factKey];
    const repairedSourceIds = [
      ledgerFact?.eventId,
      ...validAnswerToolResultIds,
      ...fallbackOkToolResultIds
    ].filter((sourceId): sourceId is string => Boolean(sourceId && trustedFactSourceIds.has(sourceId)));

    return repairedSourceIds.length
      ? { ...fact, sourceEventIds: [...new Set(repairedSourceIds)] }
      : fact;
  });

  return {
    ...input.answer,
    toolResultIds: validAnswerToolResultIds,
    factsUsed
  };
}

function leadActionAfterReview(input: {
  answer: AnswerContract;
  finalText: string;
  review: PreSendReview;
  toolResults: ToolResult[];
}): AnswerContract['leadAction'] {
  const reviewRequiresOfferForm = input.review.issues.some((issue) =>
    issue.code === 'lead_capture_missing_contact_offer_form' || issue.code === 'lead_capture_missing_name'
  );
  if (reviewRequiresOfferForm) return 'offer_form';
  if (leadCaptureMissingContact(input.toolResults) && answerRequestsContactData(input.finalText)) return 'offer_form';
  return input.answer.leadAction;
}

function requestStringArray(value: unknown) {
  return Array.isArray(value)
    ? value.map((item) => typeof item === 'string' ? item.trim() : '').filter(Boolean)
    : [];
}

const exactTargetProductMentionRoles = new Set<ProductMentionRole>([
  'target_product',
  'catalog_candidate',
  'comparison_subject'
]);

const agentManagerToolNames = [
  'catalog.search',
  'catalog.getProductDetails',
  'calculator.generatorLoad',
  'web.researchProductFacts',
  'lead.capture'
] as const;

function productMentionMatchesName(mentionName: string, targetName: string) {
  if (textMatchesTargetName(mentionName, targetName) || textMatchesTargetName(targetName, mentionName)) return true;
  const mentionTokens = new Set(modelIdentifierTokens(mentionName));
  return modelIdentifierTokens(targetName).some((token) => mentionTokens.has(token));
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

function productLookupText(product: Product) {
  return [
    product.name,
    product.brand,
    product.category,
    product.externalId,
    product.slug,
    product.sourceUrl,
    JSON.stringify(product.specs ?? {})
  ].filter(Boolean).join(' ');
}

function compactProductDescription(value: unknown, limit = 1200) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return null;
  return text.length > limit ? `${text.slice(0, limit)}...` : text;
}

function answerProductContext(product: Product) {
  return {
    id: product.id,
    name: product.name,
    brand: product.brand,
    category: product.category,
    price: product.price,
    currency: product.currency,
    specs: product.specs,
    description: compactProductDescription(product.description),
    sourceUrl: product.sourceUrl
  };
}

function productMatchesTargetName(product: Product, targetName: string) {
  return textMatchesTargetName(productLookupText(product), targetName);
}

function toolRequestEvidenceText(request: ToolRequest) {
  return [
    request.args.query,
    request.args.semanticQuery,
    request.args.reason,
    request.args.notes,
    ...requestStringArray(request.args.productNames)
  ].filter(Boolean).join(' ');
}

function exactModelEvidenceToolCoversToken(request: ToolRequest, token: string) {
  if (request.tool !== 'web.researchProductFacts') return false;
  return modelIdentifierTokens(toolRequestEvidenceText(request)).includes(token);
}

function repairIntentForExactModelEvidence(intent: AgentIntentContract, userMessage: string): AgentIntentContract {
  const targetMentionNames = (intent.productMentions ?? [])
    .filter((mention) => exactTargetProductMentionRoles.has(mention.role))
    .map((mention) => mention.name)
    .filter((name) => modelIdentifierTokens(name).some((token) => modelIdentifierTokens(userMessage).includes(token)));
  if (!targetMentionNames.length) return intent;
  const targetTokens = modelIdentifierTokens(userMessage);
  if (!targetTokens.length) return intent;
  const eligibleTokens = new Set(targetMentionNames.flatMap((name) => modelIdentifierTokens(name)));
  const uncoveredTokens = targetTokens.filter((token) =>
    eligibleTokens.has(token) &&
    !intent.toolRequests.some((request) => exactModelEvidenceToolCoversToken(request, token))
  );
  if (!uncoveredTokens.length) return intent;
  const displayTargets = targetMentionNames
    .filter((name) => modelIdentifierTokens(name).some((token) => uncoveredTokens.includes(token)));
  const idBase = `auto:exact-model:${uncoveredTokens.map(compactModelText).join('-')}`;
  const existingIds = new Set(intent.toolRequests.map((request) => request.id));
  const requestId = existingIds.has(idBase) ? `${idBase}:${intent.toolRequests.length + 1}` : idBase;
  const repairRequest: ToolRequest = {
    id: requestId,
    tool: 'web.researchProductFacts',
    args: {
      query: userMessage,
      semanticQuery: `Current turn exact-model evidence check. Verify only the named model identifiers in this buyer message: ${userMessage}`,
      productIntent: inferProductIntent(userMessage),
      limit: 4,
      productIds: [],
      productNames: displayTargets.length ? displayTargets : uncoveredTokens,
      comparisonAttributes: ['current buyer question'],
      loads: [],
      simultaneousStarting: null,
      simultaneousStartingKinds: [],
      estimateBasis: null,
      contact: { name: null, phone: null, email: null, preferredContact: null, comment: null },
      reason: 'Current turn names an exact model but the planner did not request same-turn evidence for that model.',
      notes: 'Do not reuse technical or catalog facts from a different model identifier. Verify the current exact model before answering.'
    },
    rationale: 'Exact model facts are scoped by model identifier; previous model facts are not evidence for a newly named model.',
    required: true
  };
  return {
    ...intent,
    requiresTools: true,
    toolRequests: [...intent.toolRequests, repairRequest],
    riskFlags: uniqueStrings([...intent.riskFlags, 'planner_repaired_exact_model_evidence'])
  };
}

function groundingRequiresWebSearch(grounding: AgentIntentGrounding | undefined) {
  return grounding?.sourcePolicy === 'web_required' ||
    grounding?.requiredToolKinds.includes('web.researchProductFacts') === true;
}

function intentHasWebResearchRequest(intent: AgentIntentContract) {
  return intent.toolRequests.some((request) => request.tool === 'web.researchProductFacts');
}

function productClassFromIntentMention(intent: AgentIntentContract) {
  const mention = (intent.productMentions ?? []).find((item) =>
    exactTargetProductMentionRoles.has(item.role) &&
    typeof item.productClass === 'string' &&
    coerceVisibleCardIntent(item.productClass) !== 'unknown'
  );
  return mention?.productClass ? coerceVisibleCardIntent(mention.productClass) : undefined;
}

function exactProductNamesFromIntent(intent: AgentIntentContract, userMessage: string) {
  const userTokens = new Set(modelIdentifierTokens(userMessage));
  return uniqueStrings((intent.productMentions ?? [])
    .filter((mention) => exactTargetProductMentionRoles.has(mention.role))
    .filter((mention) => modelIdentifierTokens(mention.name).some((token) => userTokens.has(token)))
    .map((mention) => mention.name));
}

function uniqueToolRequestId(intent: AgentIntentContract, idBase: string) {
  const existingIds = new Set(intent.toolRequests.map((request) => request.id));
  return existingIds.has(idBase) ? `${idBase}:${intent.toolRequests.length + 1}` : idBase;
}

function repairIntentForGroundingPolicy(intent: AgentIntentContract, userMessage: string): AgentIntentContract {
  if (!groundingRequiresWebSearch(intent.grounding)) return intent;
  if (intentHasWebResearchRequest(intent)) {
    return {
      ...intent,
      requiresTools: true,
      riskFlags: uniqueStrings([...intent.riskFlags, 'grounding_policy_web_required'])
    };
  }
  const grounding = intent.grounding;
  const targetProductNames = exactProductNamesFromIntent(intent, userMessage);
  const productIntent = productClassFromIntentMention(intent) ?? toolRequestProductIntent({
    id: 'grounding-policy',
    tool: 'web.researchProductFacts',
    args: {
      query: userMessage,
      semanticQuery: intent.userMessageSummary,
      productIntent: null,
      limit: 4,
      productIds: [],
      productNames: targetProductNames,
      comparisonAttributes: grounding?.technicalAttributes ?? [],
      loads: [],
      simultaneousStarting: null,
      simultaneousStartingKinds: [],
      estimateBasis: null,
      contact: { name: null, phone: null, email: null, preferredContact: null, comment: null },
      reason: grounding?.rationale ?? 'The semantic grounding policy requires web verification.',
      notes: 'Synthetic request for semantic grounding repair.'
    },
    rationale: grounding?.rationale ?? 'The semantic grounding policy requires web verification.',
    required: true
  }, userMessage);
  const repairRequest: ToolRequest = {
    id: uniqueToolRequestId(intent, 'auto:web-grounding'),
    tool: 'web.researchProductFacts',
    args: {
      query: userMessage,
      semanticQuery: [
        intent.userMessageSummary,
        intent.dialogueUnderstanding,
        intent.nextStepRationale
      ].filter(Boolean).join('\n'),
      productIntent,
      limit: 4,
      productIds: [],
      productNames: targetProductNames,
      comparisonAttributes: grounding?.technicalAttributes.length
        ? grounding.technicalAttributes
        : ['current buyer technical question'],
      loads: [],
      simultaneousStarting: null,
      simultaneousStartingKinds: [],
      estimateBasis: null,
      contact: { name: null, phone: null, email: null, preferredContact: null, comment: null },
      reason: grounding?.rationale ?? 'The semantic grounding policy requires external technical verification.',
      notes: 'The planner grounding policy requires web evidence; productNames may be empty for a general technical fact question.'
    },
    rationale: grounding?.rationale ?? 'The semantic grounding policy requires web evidence before answering.',
    required: true
  };
  return {
    ...intent,
    requiresTools: true,
    toolRequests: [...intent.toolRequests, repairRequest],
    riskFlags: uniqueStrings([
      ...intent.riskFlags,
      'grounding_policy_web_required',
      'planner_repaired_grounding_web_tool'
    ])
  };
}

function groundingRequiresCatalogSearch(grounding: AgentIntentGrounding | undefined) {
  return grounding?.sourcePolicy === 'catalog_required' ||
    grounding?.requiredToolKinds.includes('catalog.search') === true ||
    grounding?.taskType === 'product_selection';
}

function intentHasCatalogSearchRequest(intent: AgentIntentContract) {
  return intent.toolRequests.some((request) => request.tool === 'catalog.search');
}

function repairIntentForCatalogGrounding(intent: AgentIntentContract, userMessage: string): AgentIntentContract {
  if (!groundingRequiresCatalogSearch(intent.grounding)) return intent;
  if (intentHasCatalogSearchRequest(intent)) {
    return {
      ...intent,
      requiresTools: true,
      riskFlags: uniqueStrings([...intent.riskFlags, 'grounding_policy_catalog_required'])
    };
  }
  const productIntent = productClassFromIntentMention(intent) ?? inferProductIntent([
    userMessage,
    intent.userMessageSummary,
    intent.dialogueUnderstanding,
    intent.nextStepRationale
  ].filter(Boolean).join('\n'));
  if (productIntent === 'unknown') return intent;
  const grounding = intent.grounding;
  const repairRequest: ToolRequest = {
    id: uniqueToolRequestId(intent, 'auto:catalog-grounding'),
    tool: 'catalog.search',
    args: {
      query: userMessage,
      semanticQuery: [
        intent.userMessageSummary,
        intent.dialogueUnderstanding,
        intent.nextStepRationale,
        grounding?.rationale
      ].filter(Boolean).join('\n'),
      productIntent,
      limit: 8,
      productIds: [],
      productNames: [],
      comparisonAttributes: grounding?.technicalAttributes ?? [],
      loads: [],
      simultaneousStarting: null,
      simultaneousStartingKinds: [],
      estimateBasis: null,
      contact: { name: null, phone: null, email: null, preferredContact: null, comment: null },
      reason: grounding?.rationale ?? 'The semantic grounding policy requires catalog products for this selection.',
      notes: 'Synthetic catalog request added because the planner grounding contract required catalog search but omitted toolRequests.'
    },
    rationale: grounding?.rationale ?? 'The semantic grounding policy requires catalog products for this selection.',
    required: true
  };
  return {
    ...intent,
    requiresTools: true,
    toolRequests: [...intent.toolRequests, repairRequest],
    riskFlags: uniqueStrings([
      ...intent.riskFlags,
      'grounding_policy_catalog_required',
      'planner_repaired_grounding_catalog_tool'
    ])
  };
}

function sourcePolicyMetadataFromIntent(intent: AgentIntentContract): AgentSourcePolicyV2 {
  const grounding = intent.grounding;
  if (grounding?.sourcePolicy === 'web_required') {
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

function turnContractMetadataFromIntent(intent: AgentIntentContract): AgentTurnContract {
  const taskType = agentManagerTaskTypeFromGrounding(intent);
  const answerTask = taskType === 'product_selection'
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
    productCardsPolicy: taskType === 'product_selection' ? 'show_matching_products' : 'none',
    mustAnswerNow: [intent.userMessageSummary],
    activeNeeds: [],
    currentFocus: intent.grounding?.taskType ?? 'agent_manager_turn',
    cardsRole: taskType === 'product_selection' ? 'primary' : 'none',
    leadAllowed: intent.toolRequests.some((request) => request.tool === 'lead.capture'),
    leadAllowedReason: intent.toolRequests.some((request) => request.tool === 'lead.capture')
      ? 'Agent manager intent planned lead capture.'
      : 'No lead capture planned for this turn.',
    errorRecoveryPriority: intent.nextStepRationale,
    validatorWarnings: ['agent_manager_grounding_contract']
  };
}

function priceWithinBudget(product: Product, budgetMax: number) {
  return typeof product.price === 'number' &&
    Number.isFinite(product.price) &&
    product.price <= budgetMax;
}

function excludedAroundSeventyBudgetMax(userMessage: string) {
  const normalized = normalizeModelText(userMessage);
  const excludesExpensive = normalizedTextIncludesAny(normalized, ['без', 'не надо', 'исключ', 'дорог', 'строго без']);
  const mentionsSeventy = normalizedTextIncludesAny(normalized, ['70 тысяч', '70 тыс', '70000', '70 000', 'около 70']);
  return excludesExpensive && mentionsSeventy ? 69_999 : undefined;
}

function effectiveBudgetMax(input: { needState: CustomerNeedState; userMessage?: string }) {
  const structuredBudget = budgetMaxFromNeedState(input.needState);
  const excludedBudget = input.userMessage ? excludedAroundSeventyBudgetMax(input.userMessage) : undefined;
  if (structuredBudget === undefined) return excludedBudget;
  if (excludedBudget === undefined) return structuredBudget;
  return Math.min(structuredBudget, excludedBudget);
}

function filterAnswerProductsForBudget(input: {
  products: Product[];
  needState: CustomerNeedState;
  productClass: ProductSelectionClass;
  userMessage?: string;
}) {
  const budgetMax = effectiveBudgetMax({ needState: input.needState, userMessage: input.userMessage });
  if (budgetMax === undefined || !input.products.length || input.productClass === 'unknown') {
    return {
      products: input.products,
      droppedProductIds: [] as string[],
      warnings: [] as string[]
    };
  }

  const sameClassProducts = input.products.filter((product) =>
    productMatchesIntent(product, input.productClass)
  );
  const sameClassWithinBudget = sameClassProducts.filter((product) =>
    priceWithinBudget(product, budgetMax)
  );
  if (!sameClassWithinBudget.length) {
    return {
      products: input.products,
      droppedProductIds: [] as string[],
      warnings: [] as string[]
    };
  }

  const allowedSameClassIds = new Set(sameClassWithinBudget.map((product) => product.id));
  const filteredProducts = input.products.filter((product) =>
    !productMatchesIntent(product, input.productClass) || allowedSameClassIds.has(product.id)
  );
  const filteredIds = new Set(filteredProducts.map((product) => product.id));
  const droppedProductIds = input.products
    .filter((product) => !filteredIds.has(product.id))
    .map((product) => product.id);

  return {
    products: filteredProducts,
    droppedProductIds,
    warnings: droppedProductIds.length ? [`answer_products_filtered_by_budget:${droppedProductIds.length}`] : []
  };
}

function previousProductsRejectedByCurrentBudget(input: {
  products: Product[];
  needState: CustomerNeedState;
  productClass: ProductSelectionClass;
  userMessage?: string;
}) {
  const budgetMax = effectiveBudgetMax({ needState: input.needState, userMessage: input.userMessage });
  if (budgetMax === undefined || input.productClass === 'unknown') {
    return { droppedProductIds: [] as string[], reason: undefined as string | undefined };
  }
  const sameClassProducts = input.products.filter((product) =>
    productMatchesIntent(product, input.productClass)
  );
  if (!sameClassProducts.length) return { droppedProductIds: [] as string[], reason: undefined };
  const overBudgetProducts = sameClassProducts.filter((product) =>
    typeof product.price === 'number' &&
    Number.isFinite(product.price) &&
    product.price > budgetMax
  );
  if (overBudgetProducts.length !== sameClassProducts.length) {
    return { droppedProductIds: [] as string[], reason: undefined };
  }
  return {
    droppedProductIds: overBudgetProducts.map((product) => product.id),
    reason: `current budget limit is ${budgetMax} RUB and all previous same-class cards are above it`
  };
}

function answerProductSemanticContext(intent: AgentIntentContract) {
  return [
    intent.userMessageSummary,
    intent.dialogueUnderstanding,
    intent.nextStepRationale,
    ...intent.toolRequests.map((request) => [
      typeof request.args.query === 'string' ? request.args.query : '',
      typeof request.args.semanticQuery === 'string' ? request.args.semanticQuery : '',
      request.rationale,
      JSON.stringify(request.args ?? {})
    ].filter(Boolean).join(' '))
  ].filter(Boolean).join('\n');
}

type ReplacementProductEvidence = {
  query: string;
  productIds: string[];
  droppedPreviousProductIds: string[];
  warnings: string[];
  sourceRequestId: string;
  productIntent: ProductSelectionClass;
  reason: string;
  policy?: { reason: string; maxPracticalWeightKg: number };
};

function requiredResponseClausesForNarrowedProductReplacement(input: {
  originalProducts: Product[];
  droppedProductIds: string[];
  replacementProductIds?: string[];
  sourceRequestId?: string;
  reason?: string;
  productIntent: ProductSelectionClass;
}): RequiredResponseClause[] {
  if (
    input.productIntent === 'unknown' ||
    input.productIntent === 'plate' ||
    !input.originalProducts.length ||
    !input.droppedProductIds.length ||
    !input.reason
  ) return [];

  const droppedIds = new Set(input.droppedProductIds);
  const blockedProductNames = input.originalProducts
    .filter((product) => droppedIds.has(product.id))
    .map((product) => product.name);
  if (!blockedProductNames.length) return [];

  const hasReplacementProducts = Boolean(input.replacementProductIds?.length);
  return [{
    code: hasReplacementProducts
      ? 'previous_cards_unsuitable_replaced_by_narrowed_search'
      : 'previous_cards_unsuitable_for_narrowed_need',
    sourceRequestId: input.sourceRequestId ?? 'current_user_need',
    catalogProductNames: uniqueStrings(blockedProductNames),
    instruction: hasReplacementProducts
      ? `The buyer narrowed or corrected the need, so the previous visible ${input.productIntent} cards no longer match: ${input.reason}. Do not recommend those previous products as suitable for the current need. Explain the mismatch briefly, then use only the replacement catalog products passed in products as the suitable alternatives for the narrowed need. Product cards may be shown only for those replacement products.`
      : `The buyer narrowed or corrected the need, so the previous visible ${input.productIntent} cards no longer match: ${input.reason}. Do not recommend those previous products as suitable for the current need. Explain the mismatch briefly and say that a fresh selection is needed for the narrowed requirement.`
  }];
}

function explicitHeavyPlateRequestConflictsWithTask(input: {
  userMessage: string;
  intent: AgentIntentContract;
  policy?: { reason: string; maxPracticalWeightKg: number };
}) {
  if (!input.policy) return false;
  const plateMentionText = (input.intent.productMentions ?? [])
    .filter((mention) => mention.productClass === 'plate' || mention.productClass === 'unknown')
    .map((mention) => [mention.name, mention.evidence, mention.role].filter(Boolean).join(' '))
    .join('\n');
  const plateToolText = input.intent.toolRequests
    .filter((request) => request.args?.productIntent === 'plate' || request.tool === 'catalog.search')
    .map((request) => [
      typeof request.args?.query === 'string' ? request.args.query : '',
      typeof request.args?.semanticQuery === 'string' ? request.args.semanticQuery : '',
      request.rationale
    ].filter(Boolean).join(' '))
    .join('\n');
  const semanticText = [
    input.userMessage,
    input.intent.userMessageSummary,
    input.intent.dialogueUnderstanding,
    input.intent.nextStepRationale,
    plateMentionText,
    plateToolText
  ].filter(Boolean).join('\n');
  const explicitRange = parseWeightNeedRangeKg(semanticText);
  if (explicitRange && explicitRange.min > input.policy.maxPracticalWeightKg) return true;

  const normalized = normalizeModelText(semanticText);
  return normalizedTextIncludesAny(normalized, [
    'heavy plate',
    'heavy vibroplate',
    'reversible plate',
    'reversible vibroplate',
    '\u0442\u044f\u0436\u0435\u043b',
    '\u0440\u0435\u0432\u0435\u0440\u0441\u0438\u0432'
  ]);
}

function requiredResponseClausesForExplicitHeavyPlateTaskConflict(input: {
  userMessage: string;
  intent: AgentIntentContract;
  policy?: { reason: string; maxPracticalWeightKg: number };
  products: Product[];
  droppedProductIds: string[];
}): RequiredResponseClause[] {
  if (
    input.droppedProductIds.length > 0 ||
    !explicitHeavyPlateRequestConflictsWithTask({
      userMessage: input.userMessage,
      intent: input.intent,
      policy: input.policy
    })
  ) return [];

  const hasProducts = input.products.length > 0;
  return [{
    code: 'plate_explicit_heavy_request_conflicts_with_small_site_task',
    sourceRequestId: 'current_user_task',
    instruction: hasProducts
      ? `The buyer explicitly asked about a heavy plate class around 300-400 kg, but the stated task requires a small-site plate policy: ${input.policy?.reason}. Do not answer only that 400 kg was not found or only that "lighter" products are available. Say directly that the requested 300-400/400 kg class is excessive and not recommended as the primary choice for private yard/paving tile work. State the concrete practical target weight range: roughly 60-120 kg, usually around 60-90/100 kg for a private yard/paving tile job depending on base and area. Because suitable products are already passed in products, do not make the buyer ask again for options; use those products now as suitable alternatives and mention their weights.`
      : `The buyer explicitly asked about a heavy plate class around 300-400 kg, but the stated task requires a small-site plate policy: ${input.policy?.reason}. Do not answer only that 400 kg was not found and do not say only "lighter class". Say directly that the requested 300-400/400 kg class is excessive and not recommended as the primary choice for private yard/paving tile work. State the concrete practical target weight range: roughly 60-120 kg, usually around 60-90/100 kg for a private yard/paving tile job depending on base and area. Since no suitable products are available in products, offer to select/show catalog options in that range as the next step.`
  }];
}

function requiredResponseClausesForPlateTaskProductMismatch(input: {
  originalProducts: Product[];
  filteredProductIds: string[];
  droppedProductIds: string[];
  policy?: { reason: string; maxPracticalWeightKg: number };
  replacementProductIds?: string[];
}): RequiredResponseClause[] {
  const hasReplacementProducts = Boolean(input.replacementProductIds?.length);
  if (!input.policy || !input.originalProducts.length || (input.filteredProductIds.length && !hasReplacementProducts)) return [];
  const droppedIds = new Set(input.droppedProductIds);
  const blockedProductNames = input.originalProducts
    .filter((product) => droppedIds.has(product.id))
    .map((product) => product.name);
  if (!blockedProductNames.length) return [];
  if (hasReplacementProducts) {
    return [{
      code: 'plate_previous_cards_unsuitable_replaced_by_task_search',
      sourceRequestId: 'catalog-search:plate-replacement',
      catalogProductNames: uniqueStrings(blockedProductNames),
      instruction: `The current buyer task conflicts with the previous heavy plate options: ${input.policy.reason}. Do not recommend the previous heavy options as the best choice. Explain that the shown 380-400 kg class is not the right primary choice for home paving/tile. State the concrete practical target weight range for this task: roughly 60-120 kg, and usually around 60-90/100 kg for a private yard/paving tile job depending on base and area. Because replacement products are already passed in products, do not make the buyer ask again for options; use those products now as suitable alternatives for the corrected task and mention their weights. Product cards may be shown only for those replacement products.`
    }];
  }
  return [{
    code: 'plate_previous_cards_unsuitable_for_current_task',
    sourceRequestId: 'current_user_task',
    catalogProductNames: uniqueStrings(blockedProductNames),
    instruction: `The current buyer task conflicts with the previous heavy plate options: ${input.policy.reason}. The available previous options are outside the practical task range above ${input.policy.maxPracticalWeightKg} kg. Do not recommend any of these products as the best choice. State that none of the shown heavy options is a good primary choice for the current home paving/tile task. Do not use vague wording like "lighter class" by itself: state the concrete practical target weight range, roughly 60-120 kg and usually around 60-90/100 kg for a private yard/paving tile job depending on base and area. Since no replacement products are available in products, offer to show/select catalog options in that range as the next step.`
  }];
}

function plateTaskMismatchSafeRewrite(clause: RequiredResponseClause) {
  const names = uniqueStrings(clause.catalogProductNames ?? []);
  const namesText = names.length ? `: ${names.join(', ')}` : '';
  return [
    `Из этих вариантов я бы не выбирал ни один как основной для домашней укладки тротуарной плитки${namesText}.`,
    'Это тяжелые реверсивные плиты около 400 кг: они нужны под серьезное основание, щебень, грунт, дорожные и профессиональные работы. Для двора и плитки такой вес избыточный: выше риск повредить плитку, сложнее работать у дома и обычно нужен другой класс плиты.',
    'Под домашнюю плитку лучше смотреть конкретный рабочий диапазон: примерно 60-120 кг, а для частного двора чаще 60-90/100 кг в зависимости от основания, площади и того, сколько щебня. По уже уложенной плитке нужен резиновый или полиуретановый коврик. Я бы подобрал и показал варианты из каталога в этом диапазоне, а эти 400 кг оставил бы только если у вас реально тяжелая подготовка основания, а не финишная укладка плитки.'
  ].join('\n\n');
}

function answerSatisfiesExplicitHeavyPlateTaskConflict(answerText: string) {
  const normalized = normalizeModelText(answerText);
  const mentionsHeavyRequestedWeight = /(?:^|[^\d])(?:3\d{2}|4\d{2})\s*(?:\u043a\u0433|kg)?/iu.test(answerText);
  const hasDirectRejection = normalizedTextIncludesAny(normalized, [
    'not recommend',
    'not recommended',
    'too heavy',
    'excessive',
    'overkill',
    'not the right',
    '\u043d\u0435 \u0440\u0435\u043a\u043e\u043c\u0435\u043d\u0434',
    '\u043d\u0435 \u0441\u043e\u0432\u0435\u0442',
    '\u0441\u043b\u0438\u0448\u043a\u043e\u043c',
    '\u0438\u0437\u0431\u044b\u0442\u043e\u0447',
    '\u043d\u0435 \u043f\u043e\u0434\u0445\u043e\u0434'
  ]);
  const statesConcreteRange = /60\s*(?:-|–|—|\/|\u0434\u043e)\s*120\s*(?:\u043a\u0433|kg)?/iu.test(answerText) ||
    (/60\s*(?:\u043a\u0433|kg)?/iu.test(answerText) && /(?:90|100)\s*(?:\u043a\u0433|kg)?/iu.test(answerText));
  return mentionsHeavyRequestedWeight && hasDirectRejection && statesConcreteRange;
}

function plateExplicitHeavyTaskConflictSafeRewrite(products: Product[]) {
  const productLines = products.slice(0, 6).map((product) => {
    const weight = extractWeightKg(product);
    return weight !== undefined
      ? `- ${product.name} (${weight} kg)`
      : `- ${product.name}`;
  });
  const productBlock = productLines.length
    ? `Из подходящих вариантов сейчас можно смотреть:\n${productLines.join('\n')}`
    : 'Могу подобрать и показать варианты из каталога в этом диапазоне.';
  return [
    'Плиту около 300-400 кг под тротуарную плитку во дворе я бы не рекомендовал как основной вариант. Это слишком тяжелый класс для такой задачи: он больше нужен под серьезную подготовку основания, щебень, грунт, дорожные и профессиональные объемы.',
    'Для двора и тротуарной плитки практичнее смотреть примерно 60-120 кг, а для частного двора чаще 60-90/100 кг в зависимости от основания, площади и слоя щебня. По уже уложенной плитке нужен резиновый или полиуретановый коврик.',
    productBlock
  ].join('\n\n');
}

function hasCatalogEvidenceRequest(intent: AgentIntentContract) {
  return intent.toolRequests.some((request) =>
    request.tool === 'catalog.search' || request.tool === 'catalog.getProductDetails'
  );
}

function hasWebEvidenceRequest(intent: AgentIntentContract) {
  return intent.toolRequests.some((request) => request.tool === 'web.researchProductFacts');
}

function catalogProductNameGuardApplies(input: {
  intent: AgentIntentContract;
  products: Product[];
}) {
  if (!input.products.length) return false;
  if (!hasCatalogEvidenceRequest(input.intent)) return false;
  if (hasWebEvidenceRequest(input.intent)) return false;
  return input.intent.grounding?.taskType === 'product_selection' ||
    input.intent.grounding?.sourcePolicy === 'catalog_required' ||
    input.intent.toolRequests.some((request) => request.tool === 'catalog.search');
}

function productEvidenceModelTokens(products: Product[]) {
  return new Set(products.flatMap((product) =>
    modelIdentifierTokens([
      product.name,
      product.brand,
      product.externalId,
      product.slug
    ].filter(Boolean).join(' '))
  ));
}

function nonTargetMentionModelTokens(intent: AgentIntentContract) {
  return new Set((intent.productMentions ?? [])
    .filter((mention) => !exactTargetProductMentionRoles.has(mention.role))
    .flatMap((mention) => modelIdentifierTokens(mention.name)));
}

function splitAnswerSegments(value: string) {
  const segments: string[] = [];
  let current = '';
  const terminators = new Set(['.', '!', '?', '\n', '。', '！', '？']);
  for (const char of value) {
    current += char;
    if (terminators.has(char)) {
      segments.push(current);
      current = '';
    }
  }
  if (current) segments.push(current);
  return segments;
}

function collapseExcessBlankLines(value: string) {
  const lines = value.split('\n');
  const output: string[] = [];
  let blank = 0;
  for (const line of lines) {
    if (line.trim()) {
      blank = 0;
      output.push(line.trimEnd());
    } else {
      blank += 1;
      if (blank <= 1) output.push('');
    }
  }
  return output.join('\n').trim();
}

function unsupportedCatalogProductMentionSafeRewrite(input: {
  answerText: string;
  intent: AgentIntentContract;
  products: Product[];
}) {
  if (!catalogProductNameGuardApplies(input)) return null;
  const allowedTokens = productEvidenceModelTokens(input.products);
  for (const token of nonTargetMentionModelTokens(input.intent)) allowedTokens.add(token);
  if (!allowedTokens.size) return null;

  const unsupportedDisplayTokens = modelIdentifierDisplayTokens(input.answerText)
    .filter((token) => !allowedTokens.has(compactModelText(token)));
  const unsupportedTokens = new Set(unsupportedDisplayTokens.map(compactModelText));
  if (!unsupportedTokens.size) return null;

  const keptSegments = splitAnswerSegments(input.answerText).filter((segment) =>
    !modelIdentifierTokens(segment).some((token) => unsupportedTokens.has(token))
  );
  const revisedAnswerText = collapseExcessBlankLines(keptSegments.join(''));
  if (!revisedAnswerText || revisedAnswerText === input.answerText.trim()) return null;
  return {
    revisedAnswerText,
    unsupportedDisplayTokens: uniqueStrings(unsupportedDisplayTokens)
  };
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

function coerceVisibleCardIntent(value: unknown): ProductSelectionClass {
  if (typeof value !== 'string' || !value.trim()) return 'unknown';
  const trimmed = value.trim();
  const normalized = trimmed.toLocaleLowerCase('ru-RU');
  if (
    normalized.includes('battery power station') ||
    normalized.includes('portable power station') ||
    normalized.includes(fromEscaped('\\u0430\\u043a\\u043a\\u0443\\u043c\\u0443\\u043b\\u044f\\u0442\\u043e\\u0440\\u043d\\u0430\\u044f \\u044d\\u043b\\u0435\\u043a\\u0442\\u0440\\u043e\\u0441\\u0442\\u0430\\u043d\\u0446')) ||
    normalized.includes(fromEscaped('\\u0437\\u0430\\u0440\\u044f\\u0434\\u043d\\u0430\\u044f \\u0441\\u0442\\u0430\\u043d\\u0446'))
  ) {
    return 'generator';
  }
  if (trimmed === 'vibroplate') return 'plate';
  if (productSelectionClasses.includes(trimmed as ProductSelectionClass)) return trimmed as ProductSelectionClass;
  return inferProductIntent(trimmed);
}

function previousVisibleCardProducts(input: {
  history: Message[];
  intent: ProductSelectionClass;
}) {
  if (isGeneratorProductClass(input.intent)) return [];
  for (let index = input.history.length - 1; index >= 0; index -= 1) {
    const metadata = input.history[index]?.metadata as { productCards?: unknown } | undefined;
    const cards = Array.isArray(metadata?.productCards)
      ? metadata.productCards.filter((card): card is ProductCard =>
          Boolean(
            card &&
            typeof card === 'object' &&
            typeof (card as { id?: unknown }).id === 'string' &&
            typeof (card as { name?: unknown }).name === 'string'
          )
        )
      : [];
    const products = cards
      .map(productFromVisibleCard)
      .filter((product) => productMatchesIntent(product, input.intent))
      .slice(0, 4);
    if (products.length) return products;
  }
  return [];
}

function continuityCardIntent(input: {
  fallback: ProductSelectionClass;
  decisionProductClass?: string;
}) {
  const decisionIntent = coerceVisibleCardIntent(input.decisionProductClass);
  return decisionIntent === 'unknown' ? input.fallback : decisionIntent;
}

function continuityProductClassFromCurrentTurn(input: {
  intent: AgentIntentContract;
  needState: CustomerNeedState;
  userMessage: string;
}) {
  const targetMention = (input.intent.productMentions ?? []).find((mention) =>
    exactTargetProductMentionRoles.has(mention.role)
  );
  const mentionIntent = coerceVisibleCardIntent(targetMention?.productClass);
  if (mentionIntent !== 'unknown') return mentionIntent;

  const activeNeeds = input.needState.activeNeeds ?? [];
  for (let index = activeNeeds.length - 1; index >= 0; index -= 1) {
    const needIntent = coerceVisibleCardIntent(activeNeeds[index]?.productClass);
    if (needIntent !== 'unknown') return needIntent;
  }

  return inferProductIntent([
    input.userMessage,
    input.intent.userMessageSummary,
    input.intent.dialogueUnderstanding,
    input.intent.nextStepRationale
  ].filter(Boolean).join('\n'));
}

function catalogPresenceForTargets(targetNames: string[], products: Product[]) {
  return targetNames.map((productName) => {
    const exactMatches = products.filter((product) => productMatchesTargetName(product, productName));
    return {
      productName,
      status: exactMatches.length ? 'present' : 'absent',
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
  return input.products.find((product) => textMatchesTargetName(product.name, input.fact.productName))
    ?? input.products.find((product) =>
      input.targetProductNames.some((targetName) => productMatchesTargetName(product, targetName))
    )
    ?? null;
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

function generatorLoadRequirementKw(toolResults: ToolResult[]) {
  for (let index = toolResults.length - 1; index >= 0; index -= 1) {
    const result = toolResults[index];
    if (result?.tool !== 'calculator.generatorLoad' || result.status !== 'ok') continue;
    const profile = (result.payload as { profile?: { requiredNominalKw?: unknown } }).profile;
    const required = Number(profile?.requiredNominalKw);
    if (Number.isFinite(required) && required > 0) return required;
  }
  return undefined;
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

function requiredResponseClausesForUserMessage(userMessage: string): RequiredResponseClause[] {
  if (!ambiguousCutterRequestNeedsMaterialClarification(userMessage)) return [];
  return [{
    code: 'cutter_ambiguous_material_or_work',
    sourceRequestId: 'user_message',
    instruction: 'The buyer asked for a “резчик/резак” without material or work context. Do not list concrete cutter models, prices, or catalog cards yet. Briefly explain that this can mean a шовнарезчик for floor/asphalt/concrete seams or a handheld бензорез/cut-off saw for metal, concrete, brick, pipes, etc.; ask one main question about what material/work they need to cut. Set selectionReadiness.canShowProductCards=false and missingFacts must include cutter_material_or_work.'
  }];
}

function requiredResponseClausesForToolResults(toolResults: ToolResult[]): RequiredResponseClause[] {
  const clauses: RequiredResponseClause[] = [];
  for (const result of toolResults) {
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
        code: 'generator_unconfirmed_load_no_numeric_selection',
        sourceRequestId: result.requestId,
        instruction: `This generator load calculation has an unconfirmed or incomplete load basis. ${profileInstruction} Do not present the number as a confirmed recommendation, confirmed minimum, or purchase-safe final selection. Keep product cards and prices blocked, name the missing load power/model/type, and ask for the smallest missing fact needed to make exact selection safe.`
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
    if (result.status !== 'ok') {
      clauses.push({
        code: 'web_research_unavailable_grounding',
        sourceRequestId: result.requestId,
        instruction: 'The requested web fact check did not complete successfully. Answer only at the truthful general engineering level from the current dialogue and already available facts; explicitly separate that from exact/current verification, and do not claim that web facts were checked or verified by this failed tool result.'
      });
      continue;
    }
    const payload = result.payload as {
      catalogPresence?: Array<{ productName?: string; status?: string }>;
      nearbyCatalogProducts?: Array<{ name?: string }>;
      facts?: Array<{ productName?: string; sourceType?: string; confidence?: string }>;
      answerGuidance?: { directAnswer?: string; completeness?: string };
    };
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

type StartControlCoverageItem = {
  attribute?: unknown;
  status?: unknown;
  value?: unknown;
  evidence?: unknown;
};

const startControlUncertaintyStatuses = new Set(['not_confirmed', 'ambiguous', 'not_found']);

function normalizedTextIncludesAny(normalizedText: string, fragments: string[]) {
  return fragments.some((fragment) => {
    const normalizedFragment = normalizeModelText(fragment);
    return normalizedFragment.length > 0 && normalizedText.includes(normalizedFragment);
  });
}

function startControlCoverageText(coverageItem: StartControlCoverageItem) {
  return normalizeModelText([
    coverageItem.attribute,
    coverageItem.value,
    coverageItem.evidence
  ].filter(Boolean).join(' '));
}

function startControlCoverageLabels(attribute: unknown, value: unknown) {
  const text = normalizeModelText([attribute, value].filter(Boolean).join(' '));
  const labels: string[] = [];
  if (
    normalizedTextIncludesAny(text, ['key', 'ignition', 'switch', 'ключ', 'зажиган', 'выключател'])
  ) {
    labels.push('Запуск с ключа/через выключатель');
  }
  if (
    normalizedTextIncludesAny(text, ['button', 'pushbutton', 'кноп'])
  ) {
    labels.push('Кнопочный запуск');
  }
  return labels;
}

function normalizedAnswerMentionsStartControlLabel(normalizedAnswer: string, label: string) {
  if (label === 'Кнопочный запуск') {
    return normalizedTextIncludesAny(normalizedAnswer, ['button', 'pushbutton', 'кноп']);
  }
  if (label === 'Запуск с ключа/через выключатель') {
    return normalizedTextIncludesAny(normalizedAnswer, ['key', 'ignition', 'switch', 'ключ', 'зажиган', 'выключател']);
  }
  return normalizedTextIncludesAny(normalizedAnswer, [label]);
}

function answerAlreadyCoversStartControlUncertainty(answerText: string, label: string) {
  const normalizedAnswer = normalizeModelText(answerText);
  if (!normalizedAnswerMentionsStartControlLabel(normalizedAnswer, label)) return false;
  return normalizedTextIncludesAny(normalizedAnswer, [
    'не виж',
    'не видно',
    'не указан',
    'не указано',
    'не найден',
    'не нашел',
    'не нашли',
    'не подтверж',
    'не могу подтвердить',
    'нет подтверждения',
    'точно подтвердить не могу',
    'not confirmed',
    'not found',
    'not specified',
    'unknown',
    'unclear'
  ]);
}

function answerAlreadyCoversGeneralStartControlUncertainty(answerText: string) {
  const normalizedAnswer = normalizeModelText(answerText);
  const mentionsElectricControl = normalizedTextIncludesAny(normalizedAnswer, [
    'чем включается электростартер',
    'чем включается электрозапуск',
    'ключом, кнопкой',
    'ключом кнопкой',
    'ключом или переключателем',
    'key or button',
    'key, button',
    'start control'
  ]);
  if (!mentionsElectricControl) return false;
  return normalizedTextIncludesAny(normalizedAnswer, [
    'не подтверд',
    'не виж',
    'нет подтверждения',
    'not confirmed',
    'not found',
    'not specified',
    'unknown',
    'unclear'
  ]);
}

function coverageItemConfirmsManualStarter(coverageItem: StartControlCoverageItem) {
  if (coverageItem.status !== 'confirmed') return false;
  const text = startControlCoverageText(coverageItem);
  return normalizedTextIncludesAny(text, ['manual', 'recoil', 'ручной стартер', 'ручной запуск', 'ручн']);
}

function answerMentionsManualStarter(answerText: string) {
  const text = normalizeModelText(answerText);
  return normalizedTextIncludesAny(text, ['manual', 'recoil', 'ручной стартер', 'ручной запуск', 'ручн']);
}

function coverageItemConfirmsElectricStarter(coverageItem: StartControlCoverageItem) {
  if (coverageItem.status !== 'confirmed') return false;
  const text = startControlCoverageText(coverageItem);
  return normalizedTextIncludesAny(text, ['electric starter', 'electric start', 'electrostarter', 'электростартер', 'электро стартер', 'электропуск']);
}

function startControlConfirmedSupplementLines(coverage: unknown[], answerText: string) {
  const lines: string[] = [];
  const coverageItems = coverage
    .filter((item): item is StartControlCoverageItem => Boolean(item) && typeof item === 'object');
  if (!answerMentionsManualStarter(answerText) && coverageItems.some(coverageItemConfirmsManualStarter)) {
    lines.push('Ручной стартер тоже есть.');
  }
  return lines;
}

function confirmedStartControlLabels(coverageItems: StartControlCoverageItem[]) {
  const labels = new Set<string>();
  for (const coverageItem of coverageItems) {
    if (coverageItem.status !== 'confirmed') continue;
    for (const label of startControlCoverageLabels(coverageItem.attribute, coverageItem.value)) {
      labels.add(label);
    }
  }
  return labels;
}

function startControlUncertaintyStatement(input: {
  label: string;
  status: string;
  hasConfirmedElectricStarter: boolean;
}) {
  const suffix = input.status === 'ambiguous' ? 'точно подтвердить не могу' : 'в данных не вижу';
  if (input.hasConfirmedElectricStarter && input.label === 'Запуск с ключа/через выключатель') {
    return `Чем именно включается электростартер - ключом или переключателем - ${suffix}`;
  }
  return `${input.label} ${suffix}`;
}

function startControlCoverageUncertaintyLine(coverage: unknown[], answerText = '') {
  const statements: string[] = [];
  const seen = new Set<string>();
  const coverageItems = coverage
    .filter((item): item is StartControlCoverageItem => Boolean(item) && typeof item === 'object');
  if (answerAlreadyCoversGeneralStartControlUncertainty(answerText)) return '';
  const confirmedLabels = confirmedStartControlLabels(coverageItems);
  const hasConfirmedElectricStarter = coverageItems.some(coverageItemConfirmsElectricStarter);
  for (const coverageItem of coverageItems) {
    const status = coverageItem.status;
    if (typeof status !== 'string' || !startControlUncertaintyStatuses.has(status)) continue;
    for (const label of startControlCoverageLabels(coverageItem.attribute, coverageItem.value)) {
      if (confirmedLabels.has(label)) continue;
      if (seen.has(label)) continue;
      seen.add(label);
      if (answerAlreadyCoversStartControlUncertainty(answerText, label)) continue;
      statements.push(startControlUncertaintyStatement({ label, status, hasConfirmedElectricStarter }));
    }
  }
  return statements.length ? `${statements.join('. ')}.` : '';
}

function hasConfirmedStartControlCoverage(coverage: unknown[]) {
  return coverage.some((item) => {
    if (!item || typeof item !== 'object') return false;
    const coverageItem = item as StartControlCoverageItem;
    return coverageItem.status === 'confirmed' &&
      (
        startControlCoverageLabels(coverageItem.attribute, coverageItem.value).length > 0 ||
        coverageItemConfirmsManualStarter(coverageItem) ||
        coverageItemConfirmsElectricStarter(coverageItem)
      );
  });
}

function presentCatalogPresenceLine(productName: string, directAnswer: string) {
  if (textMatchesTargetName(directAnswer, productName)) {
    return 'У нас эта модель есть в каталоге.';
  }
  return `У нас ${productName} есть в каталоге.`;
}

function presentCatalogPresenceRelevant(intent: AgentIntentContract) {
  return intent.riskFlags.includes('answer_policy_catalog_presence_relevant');
}

function productNamesFromToolRequest(request: ToolRequest | undefined) {
  const productNames = request?.args.productNames;
  if (!Array.isArray(productNames)) return [];
  return productNames
    .map((item) => typeof item === 'string' ? item.trim() : '')
    .filter(Boolean);
}

function nonOkToolResultIds(toolResults: ToolResult[]) {
  return new Set(toolResults
    .filter((result) => result.status !== 'ok')
    .map((result) => result.requestId));
}

function factSourceIdsFromNonOkTools(input: {
  answer: AnswerContract;
  toolResults: ToolResult[];
}) {
  const failedIds = nonOkToolResultIds(input.toolResults);
  return uniqueStrings(input.answer.factsUsed.flatMap((fact) =>
    fact.sourceEventIds.filter((sourceId) => failedIds.has(sourceId))
  ));
}

function failedGeneralTechnicalWebResearchSafeRewrite(input: {
  intent: AgentIntentContract;
  request?: ToolRequest;
}) {
  const requestText = [
    input.request?.args.query,
    input.request?.args.semanticQuery,
    Array.isArray(input.request?.args.comparisonAttributes) ? input.request?.args.comparisonAttributes.join(' ') : '',
    input.intent.userMessageSummary,
    input.intent.grounding?.rationale
  ].filter(Boolean).join(' ');
  const normalizedRequestText = normalizeModelText(requestText);
  const isThdQuestion = normalizedTextIncludesAny(normalizedRequestText, [
    'thd',
    'гармоник',
    'искажен'
  ]);
  const isGeneratorPowerQualityQuestion = normalizedTextIncludesAny(normalizedRequestText, [
    'generator',
    'inverter',
    'voltage',
    'sine',
    'генератор',
    'инвертор',
    'напряжен',
    'синусоид'
  ]);
  if (!isThdQuestion || !isGeneratorPowerQualityQuestion) return null;

  const mentionsSensitiveLoads = normalizedTextIncludesAny(normalizedRequestText, [
    'boiler',
    'electronics',
    'control board',
    'power supply',
    'котел',
    'электроник',
    'плата',
    'блок питания'
  ]);
  const loadLine = mentionsSensitiveLoads
    ? 'Для котла, платы управления, блоков питания и другой электроники это важно: чем выше гармонические искажения, тем выше риск ошибок, нагрева, шума в питании и нестабильной работы чувствительных устройств.'
    : 'Для чувствительной электроники это важно: чем выше гармонические искажения, тем выше риск ошибок, нагрева, шума в питании и нестабильной работы устройств.';
  return [
    'THD — это уровень гармонических искажений: насколько форма напряжения генератора отличается от ровной синусоиды.',
    loadLine,
    'Практический вывод такой: для чувствительной нагрузки лучше выбирать инверторный генератор или модель, где прямо указаны чистая синусоида, низкий THD или пригодность для электроники.',
    'Точную цифру THD по конкретной модели в этом ходе не подтверждаю: внешняя проверка не завершилась. Поэтому это общий инженерный ориентир, а точное значение для выбранной модели нужно отдельно подтвердить по источнику или паспорту.'
  ].join('\n\n');
}

function failedWebResearchSafeRewrite(input: {
  intent: AgentIntentContract;
  toolResults: ToolResult[];
}) {
  const failedWebResult = input.toolResults.find((result) =>
    result.tool === 'web.researchProductFacts' && result.status !== 'ok'
  );
  if (!failedWebResult) return null;
  const request = input.intent.toolRequests.find((item) => item.id === failedWebResult.requestId);
  const productName = productNamesFromToolRequest(request)[0];
  const generalTechnicalRewrite = failedGeneralTechnicalWebResearchSafeRewrite({ intent: input.intent, request });
  if (!productName && generalTechnicalRewrite) return generalTechnicalRewrite;
  if (productName) {
    return `Не буду сейчас уверенно утверждать точный факт по ${productName}: внешняя проверка не завершилась. Могу опираться только на уже подтвержденные данные, а спорный параметр нужно добрать по источникам.`;
  }
  return 'Внешняя проверка не завершилась, поэтому точный факт сейчас не подтверждаю. Могу ответить только на общем уровне, а спорный параметр нужно добрать по источникам.';
}

function researchGuidanceSafeRewrite(input: {
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
      answerGuidance?: {
        directAnswer?: unknown;
        coverage?: unknown;
      };
    };
    const targetNames = Array.isArray(payload.targetProductNames)
      ? payload.targetProductNames.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      : [];
    if (targetNames.length !== 1) continue;
    const directAnswer = typeof payload.answerGuidance?.directAnswer === 'string'
      ? payload.answerGuidance.directAnswer.trim()
      : '';
    if (!directAnswer) continue;
    const coverage = Array.isArray(payload.answerGuidance?.coverage)
      ? payload.answerGuidance.coverage
      : [];
    const hasUncertainCoverage = coverage.some((item) => {
      if (!item || typeof item !== 'object') return false;
      const status = (item as { status?: unknown }).status;
      return status === 'not_confirmed' || status === 'ambiguous' || status === 'not_found';
    });
    const hasConfirmedStartControl = hasConfirmedStartControlCoverage(coverage);
    if (!hasUncertainCoverage && !hasConfirmedStartControl) continue;
    lines.push(directAnswer);
    lines.push(...startControlConfirmedSupplementLines(coverage, directAnswer));
    const uncertaintyLine = startControlCoverageUncertaintyLine(coverage, directAnswer);
    if (uncertaintyLine) lines.push(uncertaintyLine);
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

const nullableStringJsonSchema = { type: ['string', 'null'] } as const;
const nullableNumberJsonSchema = { type: ['number', 'null'] } as const;
const nullableBooleanJsonSchema = { type: ['boolean', 'null'] } as const;
const stringArrayJsonSchema = { type: 'array', items: { type: 'string' } } as const;
const scalarValueJsonSchema = { type: ['string', 'number', 'boolean', 'null'] } as const;

const ledgerPayloadJsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    factKey: nullableStringJsonSchema,
    value: scalarValueJsonSchema,
    valueText: nullableStringJsonSchema,
    unit: nullableStringJsonSchema,
    questionId: nullableStringJsonSchema,
    text: nullableStringJsonSchema,
    answer: scalarValueJsonSchema,
    answerKnown: nullableBooleanJsonSchema,
    targetEventIds: stringArrayJsonSchema,
    targetQuestionIds: stringArrayJsonSchema,
    closesQuestionIds: stringArrayJsonSchema,
    supersedesEventIds: stringArrayJsonSchema,
    negatesEventIds: stringArrayJsonSchema,
    needId: nullableStringJsonSchema,
    productId: nullableStringJsonSchema,
    productIds: stringArrayJsonSchema,
    toolRequestId: nullableStringJsonSchema,
    sourceResultId: nullableStringJsonSchema,
    notes: nullableStringJsonSchema
  },
  required: [
    'factKey',
    'value',
    'valueText',
    'unit',
    'questionId',
    'text',
    'answer',
    'answerKnown',
    'targetEventIds',
    'targetQuestionIds',
    'closesQuestionIds',
    'supersedesEventIds',
    'negatesEventIds',
    'needId',
    'productId',
    'productIds',
    'toolRequestId',
    'sourceResultId',
    'notes'
  ]
} as const;

const contactArgsJsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    name: nullableStringJsonSchema,
    phone: nullableStringJsonSchema,
    email: nullableStringJsonSchema,
    preferredContact: nullableStringJsonSchema,
    comment: nullableStringJsonSchema
  },
  required: ['name', 'phone', 'email', 'preferredContact', 'comment']
} as const;

const loadItemArgsJsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    kind: nullableStringJsonSchema,
    name: nullableStringJsonSchema,
    count: nullableNumberJsonSchema,
    runningKw: nullableNumberJsonSchema,
    startingKw: nullableNumberJsonSchema,
    source: { type: ['string', 'null'], enum: ['explicit_user', 'estimated_average', 'catalog_fact', 'web_average', null] },
    evidence: nullableStringJsonSchema,
    basisKind: {
      type: ['string', 'null'],
      enum: ['exact_power', 'checked_fact', 'specific_type_or_function', 'generic_load_name', 'unknown', null]
    },
    basisSignals: {
      type: 'array',
      items: {
        type: 'string',
        enum: [
          'consumer_type_known',
          'consumer_function_known',
          'voltage_or_phase_known',
          'usage_scope_known',
          'simultaneous_operation_known',
          'buyer_requested_approximation',
          'catalog_or_web_fact',
          'explicit_power'
        ]
      }
    }
  },
  required: ['kind', 'name', 'count', 'runningKw', 'startingKw', 'source', 'evidence', 'basisKind', 'basisSignals']
} as const;

const toolArgsJsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    query: nullableStringJsonSchema,
    semanticQuery: nullableStringJsonSchema,
    productIntent: { type: ['string', 'null'], enum: [...productSelectionClasses, null] },
    limit: nullableNumberJsonSchema,
    productIds: stringArrayJsonSchema,
    productNames: stringArrayJsonSchema,
    comparisonAttributes: stringArrayJsonSchema,
    loads: { type: 'array', items: loadItemArgsJsonSchema },
    simultaneousStarting: nullableBooleanJsonSchema,
    simultaneousStartingKinds: stringArrayJsonSchema,
    estimateBasis: {
      type: ['string', 'null'],
      enum: ['exact_or_user_provided', 'catalog_or_web_fact', 'bounded_assumption', 'unbounded_guess', null]
    },
    contact: contactArgsJsonSchema,
    reason: nullableStringJsonSchema,
    notes: nullableStringJsonSchema
  },
  required: [
    'query',
    'semanticQuery',
    'productIntent',
    'limit',
    'productIds',
    'productNames',
    'comparisonAttributes',
    'loads',
    'simultaneousStarting',
    'simultaneousStartingKinds',
    'estimateBasis',
    'contact',
    'reason',
    'notes'
  ]
} as const;

const ledgerDeltaFormat = {
  format: {
    type: 'json_schema',
    name: 'ledger_state_delta',
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        rationale: { type: 'string' },
        events: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              eventId: nullableStringJsonSchema,
              eventType: {
                type: 'string',
                enum: ['fact.observed', 'fact.confirmed', 'fact.superseded', 'fact.negated', 'question.asked', 'question.answered', 'question.closed', 'need.opened', 'need.updated', 'need.closed', 'tool.artifact.linked']
              },
              scope: { type: 'string', enum: ['dialogue', 'turn', 'need', 'product', 'lead', 'tool', 'question'] },
              payload: ledgerPayloadJsonSchema,
              evidence: { type: 'string' },
              source: { type: 'string', enum: ['llm_state_delta', 'tool_result', 'system_reducer', 'admin_curation', 'catalog', 'web'] },
              status: { type: 'string', enum: ['active', 'superseded', 'negated', 'closed', 'rejected'] }
            },
            required: ['eventId', 'eventType', 'scope', 'payload', 'evidence', 'source', 'status']
          }
        }
      },
      required: ['rationale', 'events']
    }
  }
} as const;

const toolRequestJsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string' },
    tool: { type: 'string', enum: ['catalog.search', 'catalog.getProductDetails', 'calculator.generatorLoad', 'web.researchProductFacts', 'lead.capture'] },
    args: toolArgsJsonSchema,
    rationale: { type: 'string' },
    required: { type: 'boolean' }
  },
  required: ['id', 'tool', 'args', 'rationale', 'required']
} as const;

const productMentionJsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    name: { type: 'string' },
    role: {
      type: 'string',
      enum: [
        'target_product',
        'catalog_candidate',
        'comparison_subject',
        'context_load_device',
        'compatibility_context',
        'mentioned_only'
      ]
    },
    productClass: nullableStringJsonSchema,
    evidence: { type: 'string' }
  },
  required: ['name', 'role', 'productClass', 'evidence']
} as const;

const groundingJsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    taskType: {
      type: 'string',
      enum: [
        'technical_answer',
        'product_selection',
        'comparison',
        'availability_or_delivery',
        'lead_handoff',
        'offtopic'
      ]
    },
    sourcePolicy: {
      type: 'string',
      enum: [
        'conversation_only',
        'catalog_required',
        'web_required',
        'specialist_required'
      ]
    },
    webPurpose: {
      type: 'string',
      enum: [
        'technical_specs',
        'manual_or_service',
        'current_lineup',
        'none'
      ]
    },
    requiredToolKinds: {
      type: 'array',
      items: { type: 'string', enum: agentManagerToolNames }
    },
    technicalAttributes: stringArrayJsonSchema,
    rationale: { type: 'string' }
  },
  required: [
    'taskType',
    'sourcePolicy',
    'webPurpose',
    'requiredToolKinds',
    'technicalAttributes',
    'rationale'
  ]
} as const;

const intentContractFormat = {
  format: {
    type: 'json_schema',
    name: 'agent_intent_contract',
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        turnId: nullableStringJsonSchema,
        userMessageSummary: { type: 'string' },
        dialogueUnderstanding: { type: 'string' },
        nextStepRationale: { type: 'string' },
        requiresTools: { type: 'boolean' },
        toolRequests: { type: 'array', items: toolRequestJsonSchema },
        productMentions: { type: 'array', items: productMentionJsonSchema },
        grounding: groundingJsonSchema,
        mustNotAskQuestionIds: { type: 'array', items: { type: 'string' } },
        riskFlags: { type: 'array', items: { type: 'string' } }
      },
      required: ['turnId', 'userMessageSummary', 'dialogueUnderstanding', 'nextStepRationale', 'requiresTools', 'toolRequests', 'productMentions', 'grounding', 'mustNotAskQuestionIds', 'riskFlags']
    }
  }
} as const;

const answerContractFormat = {
  format: {
    type: 'json_schema',
    name: 'agent_answer_contract',
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        answerText: { type: 'string' },
        factsUsed: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              factKey: { type: 'string' },
              sourceEventIds: { type: 'array', items: { type: 'string' } },
              value: scalarValueJsonSchema
            },
            required: ['factKey', 'sourceEventIds', 'value']
          }
        },
        questionsAsked: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              questionId: { type: 'string' },
              text: { type: 'string' },
              reason: { type: 'string' }
            },
            required: ['questionId', 'text', 'reason']
          }
        },
        toolResultIds: { type: 'array', items: { type: 'string' } },
        leadAction: { type: 'string', enum: ['none', 'offer_form', 'capture_contact', 'confirm_contact_received'] },
        riskFlags: { type: 'array', items: { type: 'string' } },
        selectionReadiness: {
          type: 'object',
          additionalProperties: false,
          properties: {
            productClass: { type: 'string' },
            status: {
              type: 'string',
              enum: ['not_applicable', 'needs_more_info', 'ready_for_preliminary_cards', 'ready_for_exact_cards']
            },
            canShowProductCards: { type: 'boolean' },
            missingFacts: { type: 'array', items: { type: 'string' } },
            rationale: { type: 'string' }
          },
          required: ['productClass', 'status', 'canShowProductCards', 'missingFacts', 'rationale']
        }
      },
      required: ['answerText', 'factsUsed', 'questionsAsked', 'toolResultIds', 'leadAction', 'riskFlags', 'selectionReadiness']
    }
  }
} as const;

const preSendReviewFormat = {
  format: {
    type: 'json_schema',
    name: 'agent_pre_send_review',
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        verdict: { type: 'string', enum: ['pass', 'rewrite_required', 'block'] },
        issues: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              code: { type: 'string' },
              severity: { type: 'string', enum: ['low', 'medium', 'high'] },
              message: { type: 'string' },
              evidence: { type: 'string' }
            },
            required: ['code', 'severity', 'message', 'evidence']
          }
        },
        revisedAnswerText: nullableStringJsonSchema
      },
      required: ['verdict', 'issues', 'revisedAnswerText']
    }
  }
} as const;

export const agentManagerStructuredFormats = {
  ledgerDeltaFormat,
  intentContractFormat,
  answerContractFormat,
  preSendReviewFormat
} as const;

class OpenAIAgentManagerModel implements AgentManagerModel {
  async proposeLedgerDelta(input: AgentManagerModelInput): Promise<LedgerStateDelta> {
    const request = {
      model: config.OPENAI_PLANNER_MODEL,
      max_output_tokens: config.OPENAI_PLANNER_MAX_OUTPUT_TOKENS,
      input: [
        {
          role: 'system',
          content: [
            'Ты state-reducer AI менеджера БАКАУТ.',
            'Твоя задача: понять текущую реплику покупателя и историю, затем вернуть только JSON LedgerStateDelta.',
            'Не переносишь контекст из других диалогов. Не добавляешь выдуманные факты.',
            'Если покупатель ответил на уже заданный вопрос, создай question.answered/question.closed.',
            'Если покупатель изменил вводные, создай новый fact.confirmed и укажи supersedesEventIds для старого факта, если он известен.',
            'Не пиши ответ покупателю.'
          ].join('\n')
        },
        {
          role: 'user',
          content: JSON.stringify({
            userMessage: input.userMessage,
            history: compactHistory(input.history),
            existingLedger: input.ledgerEvents.slice(-80)
          })
        }
      ],
      text: ledgerDeltaFormat
    };
    const { parsed } = await createStructuredJsonResponse({ request, stage: 'agent_ledger_delta', signal: input.signal });
    return LedgerStateDeltaSchema.parse(parsed);
  }

  async planTurn(input: AgentManagerModelInput & { ledgerState: ReducedDialogueLedgerState }): Promise<AgentIntentContract> {
    const request = {
      model: config.OPENAI_PLANNER_MODEL,
      max_output_tokens: config.OPENAI_PLANNER_MAX_OUTPUT_TOKENS,
      input: [
        {
          role: 'system',
          content: [
            'Ты планировщик AI менеджера БАКАУТ.',
            'LLM решает смысл хода без фиксированного списка сценариев.',
            'Код только исполнит typed tools, но не будет подменять твой смысл.',
            'Сначала заполни grounding: taskType, sourcePolicy, webPurpose, requiredToolKinds, technicalAttributes и rationale. Затем toolRequests должны исполнять эту grounding-политику.',
            'Если grounding.sourcePolicy="web_required" или requiredToolKinds содержит web.researchProductFacts, toolRequests обязан содержать web.researchProductFacts. Если named model нет, это все равно общий technical web grounding: productNames=[], query/semanticQuery = смысл вопроса, comparisonAttributes = запрошенные технические факты.',
            'Для доставки, наличия, скидок, сроков и индивидуальных условий не обещай точный результат: планируй lead.capture/offer form, если нужен контакт.',
            'Для сравнения товаров и нехватки важных фактов планируй web.researchProductFacts.',
            'Для подбора товара планируй catalog.search.',
            'If previous visible product cards become unsuitable after the buyer narrows or corrects the need, plan a fresh catalog.search in the same product class instead of only explaining that the old cards do not fit. The answer should reject the old cards by reason and use the new catalog results as replacement cards when available.',
            'Для расчета генератора по нагрузкам планируй calculator.generatorLoad.',
            'For exact technical facts about a named model that may be outside the catalog, plan web.researchProductFacts with args.productNames and comparisonAttributes. The answer should still answer the direct question if an external fact is found.',
            'If the buyer explicitly asks whether the exact model is in our catalog/available from us, asks to order/buy it, asks for price, or needs catalog alternatives, add riskFlags item "answer_policy_catalog_presence_relevant". Do not add this flag for a pure technical fact question where catalog presence would be extra noise.',
            'Fill productMentions for every named product, model, brand-model, or equipment item in the current buyer turn. Classify its semantic role: target_product when the buyer wants to buy/check that exact product; catalog_candidate for a product alternative being considered; comparison_subject for products being compared; context_load_device when it is only a consumer/load/device used to size or apply another product; compatibility_context when it is only equipment that the target product must work with; mentioned_only when no action is needed.',
            'Do not put context_load_device or compatibility_context names into web.researchProductFacts args.productNames. Example: in "нужен генератор для котла Baxi 24 и насоса 1,1 кВт", Baxi 24 is context_load_device, not a BAKAUT catalog target, so do not report that Baxi 24 is absent from our catalog. The target product class is the generator.',
            'Only target_product, catalog_candidate, and comparison_subject roles should drive exact target catalog presence, exact model web research, or nearby catalog alternatives.',
            'For a general technical question, answer from engineering knowledge only when the buyer did not ask for verification. When the buyer asks to check, verify, confirm facts, mentions missing catalog data, or asks for exact/current technical grounding, set grounding.sourcePolicy="web_required", grounding.taskType="technical_answer", grounding.webPurpose="technical_specs", add "web.researchProductFacts" to grounding.requiredToolKinds, and plan web.researchProductFacts even without a named model: keep args.productNames empty, put the buyer question in query and semanticQuery, and put the requested technical attributes in comparisonAttributes.',
            'When the buyer names a different exact model in the current turn, do not reuse technical facts from a previous model even if the buyer says "same". Plan current-turn evidence for the newly named model unless ledger/tool evidence is already scoped to that exact same model identifier.',
            'For generator selection, decide tool order semantically: use calculator.generatorLoad when load sizing is needed, and add catalog.search only when exact cards or clearly preliminary cards are appropriate for the current buyer request.',
            'For multi-turn generator selection, do not run catalog.search alone when history contains a previous load estimate, a prior generator sizing answer, or enough load facts to calculate. Re-run calculator.generatorLoad in the current turn before catalog.search so the current tool results carry payload.profile.requiredNominalKw and weak products can be filtered.',
            'For calculator.generatorLoad, fill args.loads with structured load items only when the dialogue gives a defensible explicit, checked, or bounded estimated basis; the runtime will not infer pump/fridge/tool loads from raw text.',
            'For calculator.generatorLoad, set args.estimateBasis: "exact_or_user_provided" for explicit powers, "catalog_or_web_fact" for checked facts, "bounded_assumption" when the buyer wants an approximate selection and the unknown load is bounded by type/function/scenario, or "unbounded_guess" when only vague load names are known.',
            'For calculator.generatorLoad, do not omit a known relevant consumer just because its exact power is missing. If the consumer is important and only its broad name is known, include it with null kW and an incomplete basis; if its concrete type/function plus voltage or phase is known and the buyer asks for preliminary variants, include a conservative numeric bounded_assumption instead of pretending the remaining explicit loads are the whole system.',
            'For every calculator.generatorLoad load item, set basisKind: exact_power for explicit nameplate or user kW, checked_fact for catalog or web facts, specific_type_or_function when an estimated load is bounded by a concrete type, function, or scenario, generic_load_name when only a broad name such as pump, compressor, or tool is known, and unknown when the load source itself is unclear.',
            'For every calculator.generatorLoad load item, set basisSignals from dialogue/tool facts only. Do not set basisKind=specific_type_or_function merely because a broad load class is named; "pump" alone is generic_load_name, while a borehole pump, drainage pump, circulation pump, irrigation pump, or a pump function/scenario can be specific_type_or_function.',
            'For a motor load estimate such as a pump/compressor/pressure washer, bounded_assumption requires basisKind=specific_type_or_function plus consumer_type_known or consumer_function_known and voltage_or_phase_known; otherwise use unbounded_guess and ask one minimal question.',
            'For bounded_assumption, every estimated_average load that should affect the generator calculation must include numeric runningKw or startingKw. A load with null kW is only a missing fact and will not be counted by the calculator.',
            'For a bounded unknown load, use source="estimated_average" with numeric runningKw and startingKw; do not use source="explicit_user" for a load whose kW was not explicitly provided.',
            'When the buyer asks for preliminary generator variants and the context identifies a specific motor/function plus voltage or phase, supply conservative numeric estimates for that bounded load and preserve the exact nameplate/model as a missing fact.',
            'When the buyer asks for preliminary generator variants after naming a borehole/deep-well/circulation/drainage pump plus voltage or phase, treat that pump as a bounded motor load for preliminary sizing. Do not return estimateBasis="exact_or_user_provided" unless every relevant load that affects sizing has exact or checked power.',
            'Use canonical load kinds in args.loads.kind such as pump, refrigerator, lighting, handheld_tool, compressor, pressure_washer, boiler, television, router, laptop, or unknown_load; put descriptive wording in name/evidence, not in kind.',
            'For unknown load sources, ask the minimum useful question before exact selection: identify what the consumer does, its type/class, voltage/phase, and simultaneous operation only as needed for the current calculation.',
            'For generator selection, do not plan catalog.search when the only available load basis is an unbounded guess. Ask for the missing type/function/scenario first.',
            'If the buyer asks for preliminary minimum/reserve variants after enough load context exists for a bounded estimate, plan both calculator.generatorLoad and catalog.search; if the load context is too vague for any useful selection, plan clarification instead of catalog.search.',
            'Не задавай вопрос, ответ на который уже есть в ledger.'
          ].join('\n')
        },
        {
          role: 'user',
          content: JSON.stringify({
            userMessage: input.userMessage,
            history: compactHistory(input.history),
            ledger: compactLedger(input.ledgerState)
          })
        }
      ],
      text: intentContractFormat
    };
    const { parsed } = await createStructuredJsonResponse({ request, stage: 'agent_intent_contract', signal: input.signal });
    return AgentIntentContractSchema.parse(parsed);
  }

  async composeAnswer(input: AgentManagerAnswerInput): Promise<AnswerContract> {
    const styleExamples = approvedAnswerStyleExamplesPromptBlock();
    const request = {
      model: config.OPENAI_ANSWER_MODEL,
      max_output_tokens: config.OPENAI_MAX_OUTPUT_TOKENS,
      input: [
        {
          role: 'system',
          content: [
            'Ты AI менеджер-консультант БАКАУТ в чате сайта.',
            'Отвечай по-русски, кратко, понятно, как живой менеджер.',
            'Пиши как знакомый знакомому: просто, легко, без канцелярита и третьего лица. Говори от лица магазина: "у нас есть", "можем уточнить", а не "В каталоге БАКАУТ". Не используй роботизированные связки вроде "по деталям запуска"; скажи проще: "кнопочный запуск в данных не вижу" или "точно не подтверждаю".',
            'Опирайся только на ledger, catalog/tool results, checked research facts и текущий диалог.',
            'Если точного dB, наличия, доставки, скидки или срока нет в фактах, честно скажи, что это нужно уточнить, и при необходимости предложи форму.',
            'Если lead.capture вернул ok, подтверди получение контакта и не проси его повторно.',
            'Если lead.capture вернул not_found/error из-за отсутствия имени или телефона, НЕ подтверждай контакт и НЕ говори, что запрос уже передан; поставь leadAction="offer_form" и попроси оставить недостающий контакт в форме.',
            'Не задавай лишних вопросов. Если вопрос нужен, он должен быть реально нужен для следующего шага.',
            'If toolResults contains calculator.generatorLoad with status ok, treat payload.profile.requiredNominalKw and requiredStartingKw as the authoritative calculated minimum. Do not replace that number with a broader or higher default class. A higher class may be described only as comfort/reserve, not as the calculated minimum.',
            'For generator load profiles based on assumptions, be useful without overstating certainty: give the preliminary sizing orientation only as "по расчету/допущениям/ориентир", then separately say what exact pump/tool fact is still needed before final product selection or purchase.',
            'If calculator.generatorLoad is not_found, do not invent kW values. Ask for the missing load/nameplate data or clearly say the estimate is not reliable yet.',
            'If calculator.generatorLoad warnings include generator_load_estimate_only, generator_load_unbounded_guess, generator_load_bounded_basis_incomplete, or generator_load_invalid_load_kind, do not name catalog products or prices. Set selectionReadiness.canShowProductCards=false and ask the minimum useful question to bound the unknown load source.',
            'If calculator.generatorLoad warnings include generator_load_bounded_assumption, you may show only preliminary product cards when the buyer asked for an approximate selection; keep exact missing facts in selectionReadiness.missingFacts and state the assumptions in answerText.',
            'If the buyer explicitly asks for preliminary generator variants and toolResults include calculator.generatorLoad status ok plus catalog.search products, use selectionReadiness.status="ready_for_preliminary_cards" when the catalog products are useful orientation candidates. The answer must say the cards are preliminary and name any missing exact load fact before final purchase-safe selection.',
            'You must set selectionReadiness for the current answer. It is your semantic decision about whether buyer-visible product cards are useful and honest now.',
            'When selectionReadiness.canShowProductCards is false, answerText must itself explain what is missing or what the next useful question is. The code will not append a canned clarification.',
            'When productClass is generator and cards are blocked, answerText must remain self-contained: explicitly mention the generator selection and the missing load/power/model fact that blocks the next step. Do not return only a bare question.',
            'Use selectionReadiness.status="needs_more_info" when product cards would be premature. Use "ready_for_preliminary_cards" only when the buyer asked for a preliminary selection and the executed tools give a usable estimated basis. Use "ready_for_exact_cards" when the facts are strong enough for exact cards.',
            'For a named model that is absent from the BAKAUT catalog but has checked external facts in web.researchProductFacts: answerText must include all three parts in this order: first answer the buyer direct technical question in simple words, then state that the exact model is not in our catalog, then mention genuinely nearby catalog models from payload.nearbyCatalogProducts when that list is non-empty. Do not omit catalog absence or nearby catalog orientation just because the direct technical fact was answered. Do not say "not found" when catalogPresence.status is "absent"; say the model is not in the catalog.',
            'For catalogPresence.status="present", do not mention "у нас есть в каталоге" in a pure technical answer unless intent.riskFlags contains "answer_policy_catalog_presence_relevant".',
            'Nearby means same brand plus same product class/model family first. If none are present, mention comparable same-class catalog products only as an orientation. Do not present nearby products as proof about the absent target model.',
            'Do not add availability, delivery, discount, lead form, callback, or price discussion for a pure technical fact question unless the buyer asked for those commercial terms.',
            'For plate compactors, preserve the buyer transport constraint from tool results and product cards: if the buyer will load it alone, do not recommend heavy 90+ kg plates as the first choice unless no lighter catalog candidates are present.',
            'For a small driveway/paving plate compactor that the buyer will load alone, recommend roughly 50-80 kg, usually 60-75 kg. Mention 90+ kg only as heavier than the preferred self-loading range, not as part of the first target range.',
            'For a plate compactor mismatch where the buyer asked for around 300-400 kg but the stated job is private yard / paving tile / paths, never say only "lighter class". State a concrete range: roughly 60-120 kg, usually around 60-90/100 kg for a private paving tile job depending on base and area. If products are provided, show and explain those options now instead of asking the buyer to request them again; ask whether to show/select options only when no suitable products are available in products.',
            'For plate compactor selection with a budget plus one-person, light, or self-loading transport constraint, rank the shortlist by fit to both constraints: first show the lightest in-budget candidates that still match the job. If two or more clearly lighter in-budget candidates are present in products, do not put a heavier in-budget product in the primary bullet list as an equal recommendation; mention it only after the shortlist as a heavier compromise if that tradeoff is useful.',
            'For plate compactor selection with a budget plus one-person, light, or self-loading transport constraint, if no clearly light in-budget candidate is available, do not call a heavier in-budget candidate light or clearly best. Present it as a budget/availability compromise, state the weight tradeoff, and ask whether that weight is acceptable before final selection.',
            'When the buyer gives a budget, never present products above that budget as satisfying it. If in-budget catalog candidates exist but are weaker or compromise options, say that plainly and treat higher-priced models only as above-budget reference points.',
            'For catalog selection answers, first cover all honestly suitable products that match the buyer hard requirements and materially fit the job. If there are many suitable products, group or prioritize them briefly, but do not replace them with random 1-2 picks. Add compromise products only when honest matches are few, weak, or the buyer explicitly allows alternatives; label each compromise with the exact tradeoff. Mention dimensions, widths, weights, prices, and specs only when they are present in the provided product context or checked research facts.',
            'For catalog selection answers, every catalog model or brand-model named in answerText must be copied from products[].name, and every named catalog recommendation must be strong enough to be shown as a visible card. Do not introduce product names that are absent from products, and do not mention a returned product as narrative filler if it is not a real recommendation candidate.',
            'Products can include current catalog results or buyer-visible cards from previous turns that remain relevant to the current narrowing request. If products are present and fit the current need, use them instead of claiming there is no fresh catalog or asking for a lead form just to continue selection.',
            'factsUsed[].sourceEventIds must contain only exact strings from availableEvidenceSources.allowedSourceIds. Do not invent source ids from fact names.',
            'If a fact comes from a tool result, cite the tool request id. If it comes from ledger, cite the ledger event id. toolResultIds must contain only current tool request ids.',
            'For a pure availability/delivery/discount handoff where no exact live status is known, keep factsUsed empty unless you explicitly use catalog or checked research facts.',
            'If requiredResponseClauses is non-empty, answerText must satisfy every clause by meaning. Treat these clauses as required semantic content, not optional style advice.',
            'If a requiredResponseClause says a generator load basis is unconfirmed, distinguish rough orientation from exact selection: do not present the number as confirmed or purchase-safe, but do not hide a useful tool-calculated orientation when the clause tells you to include or qualify it.',
            'If web.researchProductFacts payload.answerGuidance.directAnswer is present, use that practical direct answer before broader catalog context. Do not convert answerGuidance.coverage status "not_confirmed" into "no" or "does not have".',
            'If web.researchProductFacts has status error, timeout, denied, or not_found, do not write that facts were checked, verified, or confirmed by that research step. Give the best general answer only at the current truthful level and state that exact verification is unavailable in this turn when the buyer asked for verification.',
            styleExamples,
            'Верни только JSON AnswerContract.'
          ].join('\n')
        },
        {
          role: 'user',
          content: JSON.stringify({
            userMessage: input.userMessage,
            history: compactHistory(input.history),
            ledger: compactLedger(input.ledgerState),
            intent: input.intent,
            toolResults: input.toolResults,
            requiredResponseClauses: input.requiredResponseClauses ?? [],
            availableEvidenceSources: answerEvidenceSourceHints(input),
            products: input.products.map(answerProductContext)
          })
        }
      ],
      text: answerContractFormat
    };
    const { parsed } = await createStructuredJsonResponse({ request, stage: 'agent_answer_contract', signal: input.signal });
    return AnswerContractSchema.parse(parsed);
  }

  async reviewAnswer(input: AgentManagerReviewInput): Promise<PreSendReview> {
    const request = {
      model: config.OPENAI_FACT_MODEL,
      max_output_tokens: config.OPENAI_FACT_MAX_OUTPUT_TOKENS,
      input: [
        {
          role: 'system',
          content: [
            'Ты evidence-bound reviewer ответа AI менеджера БАКАУТ.',
            'Проверь только по фактам ledger/toolResults/products.',
            'Блокируй или требуй rewrite, если ответ спрашивает уже известное, обещает непроверенное наличие/доставку/скидку/срок, противоречит текущему диалогу или просит повторить контакт, который уже есть.',
            'For calculator.generatorLoad, block or rewrite any answer that states a calculated minimum inconsistent with payload.profile.requiredNominalKw/requiredStartingKw.',
            'For generator answers, require rewrite if the answer names catalog products, prices, or product cards when tool results include generator_load_estimate_only, generator_load_unbounded_guess, generator_load_bounded_basis_incomplete, generator_load_invalid_load_kind, or catalog_search_skipped:generator_load_unconfirmed_basis.',
            'For generator_load_bounded_assumption, allow preliminary product cards only when the answer labels them as approximate, preserves missing exact facts, and does not present assumptions as confirmed nameplate data.',
            'For generator preliminary selection, require rewrite if catalog.search returned useful products and the buyer asked for preliminary variants, but the answer refuses to show any orientation cards solely because one exact load fact is still missing. The rewrite should keep the missing fact caveat and present the candidates as preliminary, not final.',
            'For a generator clarification answer with selectionReadiness.canShowProductCards=false, require rewrite if the answer is only a short question or does not explicitly mention generator selection plus the missing load/power/model fact.',
            'For catalog.search plate results, block or rewrite any first-choice recommendation that ignores an explicit self-loading/light transport constraint when lighter product cards are available.',
            'For self-loading small-site plate compactor advice, require rewrite if the answer recommends 90 kg as part of the primary target range instead of treating it as a heavier fallback.',
            'For plate compactor selection with a budget plus one-person, light, or self-loading transport constraint, require rewrite if the primary shortlist presents a heavier in-budget product as an equal recommendation while two or more lighter in-budget products are available in products. The heavier product may appear only as a clearly labeled compromise after the lighter shortlist.',
            'For plate compactor selection with a budget plus one-person, light, or self-loading transport constraint, require rewrite if no clearly light in-budget candidate is available and the answer presents a heavier in-budget product as clearly best or light without stating the weight compromise and asking whether that tradeoff is acceptable.',
            'For catalog selection answers, require rewrite if the answer hides honestly suitable products and shows only one or two random picks while products contains more clear matches for the current hard requirements. Require rewrite if compromise products are mixed into the main suitable list without a clear tradeoff, or if concrete dimensions/specs are stated without products or checked research facts. A named product should be treated as a visible recommendation candidate.',
            'For catalog selection answers, require rewrite if answerText names a catalog recommendation or brand-model that is absent from products[].name, or if it names a returned product that is not strong enough to be a visible recommendation candidate.',
            'For a catalog narrowing continuation where products are available from current or previous visible cards, require rewrite if the answer claims it cannot show concrete models due to missing fresh catalog data or asks for a lead form instead of using those product facts.',
            'For a pure technical fact question about an exact model absent from catalog, require rewrite if the answer skips a checked web fact, omits catalogPresence.status="absent", omits non-empty nearbyCatalogProducts, fails to separate external facts from BAKAUT catalog facts, says only that it cannot answer, or adds unsolicited availability, delivery, discount, lead, callback, or price discussion.',
            'For every item in requiredResponseClauses, check whether answer.answerText contains the clause by meaning. If any required clause is missing, return rewrite_required and revise the answer by adding the missing content while preserving correct existing facts.',
            'If a requiredResponseClause says a generator load basis is unconfirmed, require rewrite when the answer presents a numeric kW value as confirmed/final, or when it omits the clause-required rough/partial orientation and missing load fact.',
            'For web.researchProductFacts answerGuidance.coverage, require rewrite if the answer turns not_confirmed/ambiguous/not_found into a categorical negative claim. It may say the control was not confirmed, not that it is absent.',
            'Require rewrite if the answer is formally correct but sounds like an internal report: third-person catalog wording, "В каталоге БАКАУТ...", "По деталям запуска...", or similar robotic source labels. Rewrite it as simple conversational Russian from our shop voice.',
            'Не оценивай стиль субъективно. Верни только JSON PreSendReview.'
          ].join('\n')
        },
        {
          role: 'user',
          content: JSON.stringify({
            ledger: compactLedger(input.ledgerState),
            intent: input.intent,
            toolResults: input.toolResults,
            requiredResponseClauses: input.requiredResponseClauses ?? [],
            products: input.products.map(answerProductContext),
            answer: input.answer
          })
        }
      ],
      text: preSendReviewFormat
    };
    const { parsed } = await createStructuredJsonResponse({ request, stage: 'agent_pre_send_review', signal: input.signal });
    return PreSendReviewSchema.parse(parsed);
  }
}

export class AgentManagerOrchestrator {
  private readonly embeddingCoverageCache = new Map<string, { usable: boolean; expiresAt: number }>();
  private readonly queryEmbeddingCache = new Map<string, { value: number[]; expiresAt: number }>();

  constructor(
    private readonly conversations = new ConversationRepository(),
    private readonly products = new ProductRepository(),
    private readonly leads = new LeadRepository(),
    private readonly model: AgentManagerModel = new OpenAIAgentManagerModel(),
    private readonly embedQuery: (text: string, signal?: AbortSignal) => Promise<number[] | undefined | null> = createEmbedding
  ) {}

  async generateAnswer(input: AgentManagerGenerateInput): Promise<ChatResponsePayload> {
    const session = await this.conversations.getSession(input.sessionId);
    if (!session || session.status !== 'active') throw new Error('Conversation session is not active');
    if (!input.turnId) throw new Error('Agent manager harness requires a turn id');
    return this.executeTurn({ ...input, session, turnId: input.turnId, recovered: false });
  }

  async recoverTurn(input: AgentManagerRecoverInput): Promise<ChatResponsePayload> {
    const session = await this.conversations.getSession(input.sessionId);
    if (!session || session.status !== 'active') throw new Error('Conversation session is not active');
    return this.executeTurn({
      sessionId: input.sessionId,
      userMessage: '',
      turnId: input.turnId,
      skipUserMessage: true,
      onDelta: input.onDelta,
      signal: input.signal,
      session,
      recovered: true
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

  private async researchFromVerifiedFactMemory(input: {
    sessionId: string;
    turnId: string;
    targetProductNames: string[];
    comparisonAttributes: string[];
    selectedProducts: Product[];
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
      sourceTypes: ['web'],
      limit: 32
    });
    const matchingFacts = matchingVerifiedFactsForRequest({
      facts,
      targetProductNames: input.targetProductNames,
      comparisonAttributes: input.comparisonAttributes
    });
    const requiredProductNames = input.targetProductNames.length
      ? input.targetProductNames
      : input.selectedProducts.length > 1
        ? input.selectedProducts.map((product) => product.name)
        : [];
    const coversRequiredProducts = requiredProductNames.length
      ? requiredProductNames.every((productName) =>
          verifiedFactsCoverRequest({
            facts: matchingFacts.filter((fact) => textMatchesTargetName(fact.productName, productName)),
            comparisonAttributes: input.comparisonAttributes
          })
        )
      : true;
    if (!coversRequiredProducts) return null;
    if (!verifiedFactsCoverRequest({ facts: matchingFacts, comparisonAttributes: input.comparisonAttributes })) return null;
    if (typeof repo.markVerifiedProductFactsUsed === 'function') {
      await repo.markVerifiedProductFactsUsed(matchingFacts.map((fact) => fact.id))
        .catch((error) => console.warn('Verified product fact usage write failed', safeError(error)));
    }
    await this.trace(input.sessionId, input.turnId, 'tools', 'verified_fact_memory_used', {
      factIds: matchingFacts.map((fact) => fact.id),
      productNames: uniqueStrings(matchingFacts.map((fact) => fact.productName)),
      attributes: uniqueStrings(matchingFacts.map((fact) => fact.attribute))
    });
    return verifiedFactsResearchResult(matchingFacts);
  }

  private async persistVerifiedResearchFacts(input: {
    sessionId: string;
    turnId: string;
    research: ProductComparisonResearchResult;
    targetProductNames: string[];
    selectedProducts: Product[];
  }) {
    const repo = this.verifiedFactRepository();
    if (typeof repo.upsertVerifiedProductFact !== 'function') return;
    const targetNames = input.targetProductNames.length
      ? input.targetProductNames
      : input.selectedProducts.map((product) => product.name);
    let savedCount = 0;
    for (const fact of input.research.facts) {
      if (fact.sourceType !== 'web') continue;
      if (fact.confidence !== 'high' && fact.confidence !== 'medium') continue;
      if (targetNames.length && !targetNames.some((targetName) => textMatchesTargetName(fact.productName, targetName))) continue;
      const sourceUrl = typeof fact.sourceUrl === 'string' && fact.sourceUrl.trim() ? fact.sourceUrl.trim() : null;
      const sourceTitle = typeof fact.sourceTitle === 'string' && fact.sourceTitle.trim() ? fact.sourceTitle.trim() : null;
      const evidence = fact.evidence.trim();
      if (!evidence || (!sourceUrl && !sourceTitle)) continue;
      const product = productForResearchFact({
        fact,
        targetProductNames: input.targetProductNames,
        products: input.selectedProducts
      });
      const productName = researchFactProductName({ fact, targetProductNames: input.targetProductNames, product });
      if (!productName) continue;
      await repo.upsertVerifiedProductFact({
        productId: product?.id ?? null,
        productName,
        attribute: fact.attribute,
        value: fact.value,
        sourceType: 'web',
        sourceUrl,
        sourceTitle,
        evidence,
        confidence: fact.confidence
      });
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
    if (savedCount > 0) {
      await this.trace(input.sessionId, input.turnId, 'tools', 'verified_fact_memory_saved', {
        savedCount,
        targetProductNames: input.targetProductNames
      });
    }
  }

  private async executeTurn(input: AgentManagerGenerateInput & {
    session: ConversationSession;
    turnId: string;
    recovered: boolean;
  }): Promise<ChatResponsePayload> {
    const completed = await this.completedPayload(input.session, input.turnId, input.onDelta);
    if (completed) return completed;
    const completedFromAnswerContract = await this.completedFromFinalAnswerContract(input.session, input.turnId, input.recovered, input.onDelta);
    if (completedFromAnswerContract) return completedFromAnswerContract;
    await this.trace(input.sessionId, input.turnId, 'turn', 'started', { recovered: input.recovered });

    let history = await this.conversations.listMessages(input.sessionId, 80);
    let turn = await this.conversations.getTurn(input.sessionId, input.turnId);
    if (!turn) throw new Error('Conversation turn not found');

    let userMessage = input.userMessage;
    if (!turn.userMessageId && !input.skipUserMessage) {
      const user = await this.conversations.addMessage({
        sessionId: input.sessionId,
        role: 'user',
        content: input.userMessage
      });
      await this.conversations.updateTurn({
        sessionId: input.sessionId,
        turnId: input.turnId,
        status: 'received',
        stage: 'user_message_saved',
        userMessageId: user.id,
        activeNeedsBefore: input.session.needState.activeNeeds ?? []
      });
      await this.conversations.upsertTurnCheckpoint({
        sessionId: input.sessionId,
        turnId: input.turnId,
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

    const rawLedgerRows = await this.conversations.listDialogueLedgerEvents(input.sessionId, 500);
    const ledgerEvents = mapLedgerRows(rawLedgerRows as DialogueLedgerRow[]);

    const delta = await this.model.proposeLedgerDelta({ session: input.session, history, userMessage, ledgerEvents, signal: input.signal });
    await this.conversations.upsertTurnCheckpoint({
      sessionId: input.sessionId,
      turnId: input.turnId,
      checkpoint: 'ledger_delta_proposed',
      status: 'succeeded',
      payload: delta
    });
    const newEvents = normalizeLedgerStateDeltaEvents({
      sessionId: input.sessionId,
      turnId: input.turnId,
      delta
    });
    for (const event of newEvents) {
      await this.conversations.upsertDialogueLedgerEvent({
        sessionId: event.sessionId,
        turnId: event.turnId,
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
      checkpoint: 'ledger_delta_applied',
      status: 'succeeded',
      payload: { eventIds: newEvents.map((event) => event.eventId) }
    });
    await this.trace(input.sessionId, input.turnId, 'ledger', 'delta_applied', { eventIds: newEvents.map((event) => event.eventId) });

    const ledgerState = reduceDialogueLedger([...ledgerEvents, ...newEvents]);
    const needStateSnapshot = deriveNeedStateSnapshotFromLedger(ledgerState, input.session.needState ?? emptyNeedState());
    const plannedIntent = await this.model.planTurn({ session: input.session, history, userMessage, ledgerEvents: [...ledgerEvents, ...newEvents], ledgerState, signal: input.signal });
    const intent = repairIntentForExactModelEvidence(
      repairIntentForCatalogGrounding(
        repairIntentForGroundingPolicy(plannedIntent, userMessage),
        userMessage
      ),
      userMessage
    );
    await this.conversations.updateTurn({
      sessionId: input.sessionId,
      turnId: input.turnId,
      status: 'planned',
      stage: 'intent_contract_created',
      plannerContract: intent,
      activeNeedsAfter: needStateSnapshot.activeNeeds
    });
    await this.conversations.upsertTurnCheckpoint({
      sessionId: input.sessionId,
      turnId: input.turnId,
      checkpoint: 'intent_contract_created',
      status: 'succeeded',
      payload: intent
    });
    await this.trace(input.sessionId, input.turnId, 'intent', 'contract_created', {
      requiresTools: intent.requiresTools,
      toolRequests: intent.toolRequests.map((tool) => ({ id: tool.id, tool: tool.tool, required: tool.required })),
      productMentions: intent.productMentions ?? []
    });

    let { toolResults, products } = await this.executeTools({
      session: input.session,
      turnId: input.turnId,
      userMessage,
      history,
      intent,
      needState: needStateSnapshot,
      toolRequests: intent.toolRequests,
      signal: input.signal
    });

    await this.conversations.upsertTurnCheckpoint({
      sessionId: input.sessionId,
      turnId: input.turnId,
      checkpoint: 'tool_artifacts_saved',
      status: 'succeeded',
      payload: { resultCount: toolResults.length }
    });
    await this.trace(input.sessionId, input.turnId, 'tools', 'artifacts_saved', {
      statuses: toolResults.map((result) => ({ requestId: result.requestId, tool: result.tool, status: result.status }))
    });

    const continuityIntent = continuityProductClassFromCurrentTurn({
      intent,
      needState: needStateSnapshot,
      userMessage
    });
    const historicalProducts = products.length
      ? []
      : previousVisibleCardProducts({ history, intent: continuityIntent });
    const rawAnswerProducts = products.length ? products : historicalProducts;
    const budgetAnswerProductEvidence = filterAnswerProductsForBudget({
      products: rawAnswerProducts,
      needState: needStateSnapshot,
      productClass: continuityIntent,
      userMessage
    });
    const plateAnswerProductEvidence = continuityIntent === 'plate'
      ? filterPlateProductsByCurrentTask({
          products: budgetAnswerProductEvidence.products,
          userMessage,
          query: '',
          semanticContext: answerProductSemanticContext(intent)
        })
      : {
          products: budgetAnswerProductEvidence.products,
          droppedProductIds: [] as string[],
          warnings: [] as string[],
          policy: undefined
        };
    let replacementProductEvidence: ReplacementProductEvidence | null = null;
    let effectiveIntent = intent;
    let answerProductEvidence = {
      products: plateAnswerProductEvidence.products,
      droppedProductIds: uniqueStrings([
        ...budgetAnswerProductEvidence.droppedProductIds,
        ...plateAnswerProductEvidence.droppedProductIds
      ]),
      warnings: uniqueStrings([
        ...budgetAnswerProductEvidence.warnings,
        ...plateAnswerProductEvidence.warnings
      ]),
      plateTaskPolicy: plateAnswerProductEvidence.policy,
      originalProductIds: rawAnswerProducts.map((product) => product.id),
      replacementProductIds: [] as string[]
    };
    const budgetNarrowingRejection = previousProductsRejectedByCurrentBudget({
      products: historicalProducts,
      needState: needStateSnapshot,
      productClass: continuityIntent,
      userMessage
    });
    if (
      continuityIntent === 'plate' &&
      plateAnswerProductEvidence.policy &&
      budgetAnswerProductEvidence.products.length > 0 &&
      !answerProductEvidence.products.length &&
      plateAnswerProductEvidence.droppedProductIds.length > 0
    ) {
      const replacement = await this.searchPlateReplacementProducts({
        session: input.session,
        turnId: input.turnId,
        userMessage,
        intent,
        needState: needStateSnapshot,
        policy: plateAnswerProductEvidence.policy,
        droppedPreviousProductIds: plateAnswerProductEvidence.droppedProductIds,
        signal: input.signal
      });
      toolResults = [...toolResults, replacement.toolResult];
      replacementProductEvidence = replacement.evidence;
      if (replacement.products.length) {
        effectiveIntent = {
          ...intent,
          toolRequests: [
            ...intent.toolRequests,
            {
              id: 'catalog-search:plate-replacement',
              tool: 'catalog.search',
              args: {
                query: replacement.evidence.query,
                semanticQuery: [
                  userMessage,
                  'replacement plate search after unsuitable heavy 400 kg options',
                  plateAnswerProductEvidence.policy.reason
                ].join('\n'),
                productIntent: 'plate',
                limit: 8
              },
              rationale: 'Automatic replacement catalog search after all previous heavy vibroplates failed the current home paving/tile task.',
              required: true
            }
          ]
        };
        answerProductEvidence = {
          ...answerProductEvidence,
          products: replacement.products,
          warnings: uniqueStrings([
            ...answerProductEvidence.warnings,
            ...replacement.evidence.warnings
          ]),
          replacementProductIds: replacement.products.map((product) => product.id)
        };
        products = [...new Map([...products, ...replacement.products].map((product) => [product.id, product])).values()];
      }
    }
    if (
      !replacementProductEvidence &&
      historicalProducts.length > 0 &&
      continuityIntent !== 'unknown' &&
      !isGeneratorProductClass(continuityIntent) &&
      budgetNarrowingRejection.droppedProductIds.length > 0
    ) {
      const replacement = await this.searchNarrowedReplacementProducts({
        session: input.session,
        turnId: input.turnId,
        userMessage,
        intent,
        needState: needStateSnapshot,
        productIntent: continuityIntent,
        reason: budgetNarrowingRejection.reason ?? 'current buyer constraints no longer match the previous visible cards',
        droppedPreviousProductIds: budgetNarrowingRejection.droppedProductIds,
        signal: input.signal
      });
      toolResults = [...toolResults, replacement.toolResult];
      replacementProductEvidence = replacement.evidence;
      effectiveIntent = {
        ...intent,
        toolRequests: [
          ...intent.toolRequests,
          {
            id: replacement.evidence.sourceRequestId,
            tool: 'catalog.search',
            args: {
              query: replacement.evidence.query,
              semanticQuery: [
                userMessage,
                answerProductSemanticContext(intent),
                replacement.evidence.reason
              ].filter(Boolean).join('\n'),
              productIntent: replacement.evidence.productIntent,
              limit: 8
            },
            rationale: 'Automatic replacement catalog search after previous visible cards no longer matched the narrowed current need.',
            required: true
          }
        ]
      };
      answerProductEvidence = {
        ...answerProductEvidence,
        products: replacement.products,
        droppedProductIds: uniqueStrings([
          ...answerProductEvidence.droppedProductIds,
          ...budgetNarrowingRejection.droppedProductIds
        ]),
        warnings: uniqueStrings([
          ...answerProductEvidence.warnings,
          ...replacement.evidence.warnings,
          'answer_products_previous_cards_rejected_by_narrowed_need'
        ]),
        replacementProductIds: replacement.products.map((product) => product.id)
      };
      products = [...new Map([...products, ...replacement.products].map((product) => [product.id, product])).values()];
    }
    const answerProducts = answerProductEvidence.products;

    const usingHistoricalProducts = !products.length && historicalProducts.length > 0;
    const requiredResponseClauses = [
      ...requiredResponseClausesForUserMessage(userMessage),
      ...requiredResponseClausesForNarrowedProductReplacement({
        originalProducts: historicalProducts,
        droppedProductIds: budgetNarrowingRejection.droppedProductIds,
        replacementProductIds: replacementProductEvidence?.productIds,
        sourceRequestId: replacementProductEvidence?.sourceRequestId,
        reason: budgetNarrowingRejection.reason,
        productIntent: continuityIntent
      }),
      ...requiredResponseClausesForExplicitHeavyPlateTaskConflict({
        userMessage,
        intent: effectiveIntent,
        policy: plateAnswerProductEvidence.policy,
        products: answerProducts,
        droppedProductIds: plateAnswerProductEvidence.droppedProductIds
      }),
      ...requiredResponseClausesForPlateTaskProductMismatch({
        originalProducts: budgetAnswerProductEvidence.products,
        filteredProductIds: answerProducts.map((product) => product.id),
        droppedProductIds: plateAnswerProductEvidence.droppedProductIds,
        policy: plateAnswerProductEvidence.policy,
        replacementProductIds: replacementProductEvidence?.productIds
      }),
      ...requiredResponseClausesForToolResults(toolResults)
    ];
    const rawAnswer = await this.model.composeAnswer({
      session: input.session,
      history,
      userMessage,
      ledgerEvents: [...ledgerEvents, ...newEvents],
      ledgerState,
      intent: effectiveIntent,
      toolResults,
      products: answerProducts,
      requiredResponseClauses,
      signal: input.signal
    });
    const answer = normalizeAnswerEvidenceSources({
      answer: rawAnswer,
      ledgerState,
      toolResults
    });
    await this.conversations.saveAnswerContract({
      sessionId: input.sessionId,
      turnId: input.turnId,
      answerText: answer.answerText,
      contract: answer,
      status: 'draft'
    });
    await this.conversations.upsertTurnCheckpoint({
      sessionId: input.sessionId,
      turnId: input.turnId,
      checkpoint: 'answer_contract_created',
      status: 'succeeded',
      payload: answer
    });
    await this.trace(input.sessionId, input.turnId, 'answer', 'contract_created', {
      leadAction: answer.leadAction,
      questionsAsked: answer.questionsAsked.map((question) => question.questionId),
      factsUsed: answer.factsUsed.map((fact) => fact.factKey)
    });

    const review = await this.review({
      session: input.session,
      history,
      userMessage,
      ledgerEvents: [...ledgerEvents, ...newEvents],
      ledgerState,
      intent: effectiveIntent,
      toolResults,
      products: answerProducts,
      requiredResponseClauses,
      answer,
      signal: input.signal
    });
    let finalText = review.verdict === 'rewrite_required' && review.revisedAnswerText?.trim()
      ? review.revisedAnswerText.trim()
      : answer.answerText.trim();
    const finalLeadAction = leadActionAfterReview({ answer, finalText, review, toolResults });
    if (review.verdict === 'block') {
      throw new Error(`Agent manager answer blocked: ${review.issues.map((issue) => issue.code).join(', ')}`);
    }
    const reviewInvalidatedFactSources = review.issues.some((issue) =>
      issue.code === 'failed_tool_result_used_as_fact_source'
    );
    const failedToolSourceIds = reviewInvalidatedFactSources
      ? nonOkToolResultIds(toolResults)
      : new Set<string>();
    const finalFactsUsed = reviewInvalidatedFactSources
      ? answer.factsUsed.filter((fact) => !fact.sourceEventIds.some((sourceId) => failedToolSourceIds.has(sourceId)))
      : answer.factsUsed;
    await this.conversations.upsertTurnCheckpoint({
      sessionId: input.sessionId,
      turnId: input.turnId,
      checkpoint: 'review_completed',
      status: 'succeeded',
      payload: review
    });
    await this.trace(input.sessionId, input.turnId, 'review', 'completed', {
      verdict: review.verdict,
      issues: review.issues.map((issue) => issue.code)
    });
    const initialAnswerContract: AnswerContract = {
      ...answer,
      factsUsed: finalFactsUsed,
      answerText: finalText,
      leadAction: finalLeadAction
    };
    let initialCardSelection = selectProductsForVisibleCards({
      products: answerProducts,
      userMessage,
      history,
      intent: effectiveIntent,
      answerText: finalText,
      needState: needStateSnapshot,
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
      toolResults,
      userMessage
    });
    let cardSelection = suppressVisibleCardsForReadiness({
      cardSelection: initialCardSelection,
      readiness: selectionReadiness
    });
    if (selectionReadiness.status === 'ready_for_cards' && !cardSelection.products.length) {
      const previousProducts = previousVisibleCardProducts({
        history,
        intent: continuityCardIntent({
          fallback: initialCardSelection.intent,
          decisionProductClass: selectionReadiness.decision?.productClass
        })
      });
      if (previousProducts.length) {
        const narrowedPreviousSelection = selectProductsForVisibleCards({
            products: previousProducts,
            userMessage,
            history,
            intent: effectiveIntent,
            answerText: finalText,
          needState: needStateSnapshot,
          allowHistoricalProducts: true
        });
        const previousSelectionBlockedByPlateTask = narrowedPreviousSelection.warnings.some((warning) =>
          warning.includes('plate_task_weight_mismatch')
        );
        const previousSelectionBlockedByNarrowedNeed = answerProductEvidence.warnings.some((warning) =>
          warning.includes('previous_cards_rejected_by_narrowed_need')
        );
        const previousSelectionBlocked = previousSelectionBlockedByPlateTask || previousSelectionBlockedByNarrowedNeed;
        const reusedProducts = previousSelectionBlocked
          ? []
          : (narrowedPreviousSelection.products.length ? narrowedPreviousSelection.products : previousProducts);
        cardSelection = {
          ...cardSelection,
          products: reusedProducts,
          selectedProductIds: reusedProducts.map((product) => product.id),
          answerMentionedProductIds: narrowedPreviousSelection.answerMentionedProductIds.length
            ? narrowedPreviousSelection.answerMentionedProductIds
            : reusedProducts.map((product) => product.id),
          droppedProductIds: uniqueStrings([
            ...cardSelection.droppedProductIds,
            ...narrowedPreviousSelection.droppedProductIds
          ]),
          warnings: uniqueStrings([
            ...cardSelection.warnings,
            ...narrowedPreviousSelection.warnings,
            'product_cards_reused_from_previous_turn'
          ])
        };
      }
    }

    const finalAnswerContract: AnswerContract = {
      ...answer,
      factsUsed: finalFactsUsed,
      answerText: finalText,
      leadAction: finalLeadAction,
      riskFlags: selectionReadiness.status !== 'ready_for_cards'
        ? uniqueStrings([...answer.riskFlags, 'selection_readiness_blocked_cards'])
        : answer.riskFlags
    };
    await this.conversations.saveAnswerContract({
      sessionId: input.sessionId,
      turnId: input.turnId,
      answerText: finalText,
      contract: finalAnswerContract,
      review,
      status: 'final'
    });
    const cards = productCards(cardSelection.products, ['Найдено в каталоге под текущий запрос.']);
    const runtimeDecision = getAgentManagerRuntimeDecision(input.session);
    const metadata = {
      agentManager: true,
      runtimeMode: runtimeDecision.runtimeMode,
      runtimeModeReason: runtimeDecision.reason,
      agentManagerRuntime: runtimeDecision,
      recovered: input.recovered,
      turnId: input.turnId,
      ledgerState,
      ledgerEventIds: newEvents.map((event) => event.eventId),
      intentContract: intent,
      effectiveIntentContract: effectiveIntent === intent ? undefined : effectiveIntent,
      turnContract: turnContractMetadataFromIntent(intent),
      sourcePolicy: sourcePolicyMetadataFromIntent(intent),
      answerContract: finalAnswerContract,
      preSendReview: review,
      toolResults,
      cardSelection,
      selectionReadiness,
      answerProductEvidence,
      replacementProductEvidence,
      productCards: cards,
      needStateSnapshot,
      warnings: [
        ...ledgerState.warnings,
        ...toolResults.flatMap((result) => result.warnings),
        ...answerProductEvidence.warnings,
        ...cardSelection.warnings,
        ...selectionReadiness.warnings
      ]
    };

    await input.onDelta?.(finalText);
    const assistantMessage = await this.conversations.addAssistantMessageForTurn({
      sessionId: input.sessionId,
      turnId: input.turnId,
      content: finalText,
      metadata,
      recovered: input.recovered
    });
    await this.conversations.upsertTurnCheckpoint({
      sessionId: input.sessionId,
      turnId: input.turnId,
      checkpoint: 'assistant_message_saved',
      status: 'succeeded',
      artifactRef: assistantMessage.id,
      payload: { recovered: input.recovered }
    });
    await this.trace(input.sessionId, input.turnId, 'turn', 'assistant_message_saved', {
      assistantMessageId: assistantMessage.id,
      recovered: input.recovered
    });

    return {
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
      leadCreated: toolResults.some((result) => result.tool === 'lead.capture' && result.status === 'ok'),
      assistantMessageId: assistantMessage.id,
      metadata
    };
  }

  private async executeTools(input: {
    session: ConversationSession;
    turnId: string;
    userMessage: string;
    history: Message[];
    intent: AgentIntentContract;
    toolRequests: ToolRequest[];
    needState: CustomerNeedState;
    signal?: AbortSignal;
  }) {
    const productsById = new Map<string, Product>();
    const toolResults: ToolResult[] = [];
    const budgetMax = budgetMaxFromNeedState(input.needState);

    for (const request of input.toolRequests) {
      const startedAt = Date.now();
      let result: ToolResult;
      try {
        if (request.tool === 'catalog.search') {
          const { query, semanticQuery } = toolRequestScopedQuery(request, input.userMessage);
          const limit = Math.max(1, Math.min(12, Number(request.args.limit ?? 8)));
          const productIntent = toolRequestProductIntent(request, [input.userMessage, semanticQuery, request.rationale].join('\n'));
          if (isGeneratorProductClass(productIntent) && hasUnconfirmedGeneratorLoadBasisResult(toolResults)) {
            result = ToolResultSchema.parse({
              requestId: request.id,
              tool: request.tool,
              status: 'denied',
              payload: {
                query,
                productIntent,
                reason: 'generator_load_unconfirmed_basis'
              },
              warnings: ['catalog_search_skipped:generator_load_unconfirmed_basis']
            });
          } else {
            const search = await this.searchCatalogProducts({
              query,
              limit,
              signal: input.signal,
              userMessage: input.userMessage,
              semanticContext: [semanticQuery, input.userMessage, request.rationale].join('\n'),
              productIntent,
              embeddingQuery: semanticQuery,
              budgetMax
            });
            const loadRequirementKw = isGeneratorProductClass(productIntent)
              ? generatorLoadRequirementKw(toolResults)
              : undefined;
            const loadFit = filterGeneratorProductsByLoadProfile(search.products, loadRequirementKw);
            const products = loadFit.products;
            const warnings = [...search.warnings, ...loadFit.warnings];
            products.forEach((product) => productsById.set(product.id, product));
            result = ToolResultSchema.parse({
              requestId: request.id,
              tool: request.tool,
              status: products.length ? 'ok' : 'not_found',
              payload: {
                query,
                productIds: products.map((product) => product.id),
                products,
                ...(loadRequirementKw === undefined ? {} : {
                  generatorLoadFit: {
                    requiredNominalKw: loadRequirementKw,
                    droppedProductIds: loadFit.droppedProductIds
                  }
                }),
                retrieval: {
                  intent: search.productIntent,
                  query: search.query,
                  embeddingQuery: search.embeddingQuery,
                  textCount: search.textCount,
                  vectorCount: search.vectorCount,
                  usedEmbeddings: search.vectorCount > 0
                }
              },
              warnings: products.length ? warnings : [...warnings, 'catalog_search_no_matches']
            });
          }
        } else if (request.tool === 'catalog.getProductDetails') {
          const names = Array.isArray(request.args.productNames)
            ? request.args.productNames.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
            : [];
          const queries = names.length
            ? names
            : [typeof request.args.query === 'string' && request.args.query.trim() ? request.args.query : input.userMessage];
          const productIntent = toolRequestProductIntent(request, input.userMessage);
          const semanticQuery = toolRequestScopedQuery(request, input.userMessage).semanticQuery;
          if (isGeneratorProductClass(productIntent) && hasUnconfirmedGeneratorLoadBasisResult(toolResults)) {
            result = ToolResultSchema.parse({
              requestId: request.id,
              tool: request.tool,
              status: 'denied',
              payload: {
                productIntent,
                reason: 'generator_load_unconfirmed_basis'
              },
              warnings: ['product_details_skipped:generator_load_unconfirmed_basis']
            });
          } else {
            for (const query of queries.slice(0, 4)) {
              const found = await this.searchCatalogProducts({
                query,
                limit: 4,
                signal: input.signal,
                userMessage: input.userMessage,
                semanticContext: [semanticQuery, query, input.userMessage, request.rationale].join('\n'),
                productIntent,
                embeddingQuery: semanticQuery,
                budgetMax
              });
              found.products.forEach((product) => productsById.set(product.id, product));
            }
            result = ToolResultSchema.parse({
              requestId: request.id,
              tool: request.tool,
              status: productsById.size ? 'ok' : 'not_found',
              payload: { productIds: [...productsById.keys()], products: [...productsById.values()] },
              warnings: productsById.size ? [] : ['product_details_no_matches']
            });
          }
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
          const targetProductNames = targetProductNamesForRequest(request, input.intent);
          const suppressedTargetProductNames = suppressedContextTargetProductNamesForRequest(request, input.intent);
          const comparisonAttributes = comparisonAttributesForRequest(request);
          if (productsById.size < 2 || targetProductNames.length) {
            const scopedQuery = toolRequestScopedQuery(request, input.userMessage);
            const lookupQuery = targetProductNames.length
              ? targetProductNames.join(' ')
              : input.userMessage;
            const found = await this.searchCatalogProducts({
              query: lookupQuery,
              limit: 4,
              signal: input.signal,
              userMessage: input.userMessage,
              semanticContext: [scopedQuery.semanticQuery, lookupQuery, input.userMessage, request.rationale].join('\n'),
              productIntent: toolRequestProductIntent(request, input.userMessage),
              embeddingQuery: scopedQuery.semanticQuery,
              budgetMax
            });
            found.products.forEach((product) => productsById.set(product.id, product));
          }
          const selectedProducts = [...productsById.values()].slice(0, 4);
          let research = await this.researchFromVerifiedFactMemory({
            sessionId: input.session.id,
            turnId: input.turnId,
            targetProductNames,
            comparisonAttributes,
            selectedProducts
          });
          if (!research) {
            research = await researchProductComparisonFacts({
              userMessage: input.userMessage,
              products: selectedProducts,
              targetProductNames,
              comparisonAttributes,
              signal: input.signal
            });
            await this.persistVerifiedResearchFacts({
              sessionId: input.session.id,
              turnId: input.turnId,
              research,
              targetProductNames,
              selectedProducts
            }).catch((error) => console.warn('Verified product fact memory write failed', safeError(error)));
          }
          const catalogPresence = catalogPresenceForTargets(targetProductNames, selectedProducts);
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
          result = ToolResultSchema.parse({
            requestId: request.id,
            tool: request.tool,
            status: research.warnings.includes('not_enough_products_for_comparison') && !targetProductNames.length ? 'not_found' : 'ok',
            payload: {
              ...research,
              targetProductNames,
              comparisonAttributes,
              catalogPresence,
              nearbyCatalogProducts,
              suppressedTargetProductNames
            },
            warnings: [
              ...research.warnings,
              ...suppressedTargetProductNames.map((productName) => `exact_target_suppressed_by_product_role:${productName}`),
              ...catalogPresence
                .filter((item) => item.status === 'absent')
                .map((item) => `exact_catalog_product_absent:${item.productName}`)
            ]
          });
        } else if (request.tool === 'lead.capture') {
          const extractedContact = extractContact(input.userMessage);
          const contact = {
            ...extractedContact,
            ...(request.args.contact && typeof request.args.contact === 'object' ? request.args.contact as Record<string, unknown> : {})
          };
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
          const currentTurnHasContact = Boolean(extractedContact.phone || extractedContact.email);
          if (existingLead && !currentTurnHasContact) {
            contact.name ??= existingLead.name ?? undefined;
            contact.phone ??= existingLead.phone ?? undefined;
            contact.email ??= existingLead.email ?? undefined;
          }
          if (existingLead && !currentTurnHasContact && contact.name && (contact.phone || contact.email)) {
            result = ToolResultSchema.parse({
              requestId: request.id,
              tool: request.tool,
              status: 'ok',
              payload: { leadId: existingLead.id, existing: true },
              warnings: ['lead_existing_session_contact_used']
            });
          } else if (!contact.phone && !contact.email) {
            result = ToolResultSchema.parse({
              requestId: request.id,
              tool: request.tool,
              status: 'not_found',
              payload: { missing: 'contact' },
              warnings: ['lead_contact_missing']
            });
          } else if (!contact.name) {
            result = ToolResultSchema.parse({
              requestId: request.id,
              tool: request.tool,
              status: 'not_found',
              payload: { missing: 'name', contact },
              warnings: ['lead_name_missing']
            });
          } else {
            const lead = await this.leads.createLead({
              sessionId: input.session.id,
              name: String(contact.name),
              phone: typeof contact.phone === 'string' ? contact.phone : undefined,
              email: typeof contact.email === 'string' ? contact.email : undefined,
              question: input.userMessage
            });
            await this.conversations.enqueueLeadOutbox({
              leadId: lead.id,
              sessionId: input.session.id,
              turnId: input.turnId,
              destination: 'lead_email',
              payload: { leadId: lead.id }
            });
            result = ToolResultSchema.parse({
              requestId: request.id,
              tool: request.tool,
              status: 'ok',
              payload: { leadId: lead.id, outbox: true },
              warnings: []
            });
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
        result = ToolResultSchema.parse({
          requestId: request.id,
          tool: request.tool,
          status: 'error',
          payload: { error: safeError(error) },
          warnings: ['tool_execution_error'],
          errorCode: safeError(error).code ?? safeError(error).message
        });
      }
      await this.conversations.saveToolArtifact({
        sessionId: input.session.id,
        turnId: input.turnId,
        toolName: request.tool,
        toolRequestId: request.id,
        status: result.status,
        payload: result.payload,
        warnings: [...result.warnings, `duration_ms:${Date.now() - startedAt}`]
      });
      toolResults.push(result);
    }

    return { toolResults, products: [...productsById.values()] };
  }

  private async searchPlateReplacementProducts(input: {
    session: ConversationSession;
    turnId: string;
    userMessage: string;
    intent: AgentIntentContract;
    needState: CustomerNeedState;
    policy?: { reason: string; maxPracticalWeightKg: number };
    droppedPreviousProductIds: string[];
    signal?: AbortSignal;
  }) {
    const startedAt = Date.now();
    const query = 'виброплита 60 90 кг для тротуарной плитки во дворе с ковриком';
    const semanticContext = [
      input.userMessage,
      answerProductSemanticContext(input.intent),
      input.policy?.reason,
      'replacement search after previous heavy plate options failed task suitability',
      'home paving tile yard small plate rubber mat'
    ].filter(Boolean).join('\n');
    const budgetMax = budgetMaxFromNeedState(input.needState);
    let result: ToolResult;
    let replacementProducts: Product[] = [];

    try {
      const search = await this.searchCatalogProducts({
        query,
        limit: 16,
        signal: input.signal,
        userMessage: input.userMessage,
        semanticContext,
        productIntent: 'plate' as ProductSelectionClass,
        embeddingQuery: 'виброплита 60 90 кг тротуарная плитка двор коврик',
        budgetMax
      });
      const filtered = filterPlateProductsByCurrentTask({
        products: search.products,
        userMessage: input.userMessage,
        query,
        semanticContext
      });
      replacementProducts = filtered.products.slice(0, 8);
      result = ToolResultSchema.parse({
        requestId: 'catalog-search:plate-replacement',
        tool: 'catalog.search',
        status: replacementProducts.length ? 'ok' : 'not_found',
        payload: {
          query,
          productIds: replacementProducts.map((product) => product.id),
          products: replacementProducts,
          replacementFor: 'plate_task_weight_mismatch',
          droppedPreviousProductIds: input.droppedPreviousProductIds,
          retrieval: {
            intent: search.productIntent,
            query: search.query,
            embeddingQuery: search.embeddingQuery,
            textCount: search.textCount,
            vectorCount: search.vectorCount,
            usedEmbeddings: search.vectorCount > 0
          }
        },
        warnings: uniqueStrings([
          'answer_products_replaced_by_plate_task_search',
          ...search.warnings,
          ...filtered.warnings,
          ...(replacementProducts.length ? [] : ['catalog_search_no_matches'])
        ])
      });
    } catch (error) {
      result = ToolResultSchema.parse({
        requestId: 'catalog-search:plate-replacement',
        tool: 'catalog.search',
        status: 'error',
        payload: {
          query,
          replacementFor: 'plate_task_weight_mismatch',
          droppedPreviousProductIds: input.droppedPreviousProductIds,
          error: safeError(error)
        },
        warnings: ['answer_products_replacement_search_error'],
        errorCode: safeError(error).code ?? safeError(error).message
      });
    }

    await this.conversations.saveToolArtifact({
      sessionId: input.session.id,
      turnId: input.turnId,
      toolName: result.tool,
      toolRequestId: result.requestId,
      status: result.status,
      payload: result.payload,
      warnings: [...result.warnings, `duration_ms:${Date.now() - startedAt}`]
    });

    return {
      products: replacementProducts,
      toolResult: result,
      evidence: {
        query,
        productIds: replacementProducts.map((product) => product.id),
        droppedPreviousProductIds: input.droppedPreviousProductIds,
        warnings: result.warnings,
        sourceRequestId: 'catalog-search:plate-replacement',
        productIntent: 'plate' as ProductSelectionClass,
        reason: input.policy?.reason ?? 'previous visible plate cards no longer match the current task',
        policy: input.policy
      }
    };
  }

  private async searchNarrowedReplacementProducts(input: {
    session: ConversationSession;
    turnId: string;
    userMessage: string;
    intent: AgentIntentContract;
    needState: CustomerNeedState;
    productIntent: ProductSelectionClass;
    reason: string;
    droppedPreviousProductIds: string[];
    signal?: AbortSignal;
  }) {
    const startedAt = Date.now();
    const requestId = 'catalog-search:narrowed-replacement';
    const semanticContext = [
      input.userMessage,
      answerProductSemanticContext(input.intent),
      input.reason,
      'replacement search after previous visible product cards no longer match the narrowed current need'
    ].filter(Boolean).join('\n');
    const query = [
      input.userMessage,
      input.reason,
      input.productIntent
    ].filter(Boolean).join(' ');
    const budgetMax = effectiveBudgetMax({ needState: input.needState, userMessage: input.userMessage });
    let result: ToolResult;
    let replacementProducts: Product[] = [];

    try {
      const search = await this.searchCatalogProducts({
        query,
        limit: 16,
        signal: input.signal,
        userMessage: input.userMessage,
        semanticContext,
        productIntent: input.productIntent,
        embeddingQuery: semanticContext,
        budgetMax
      });
      const budgetFiltered = filterAnswerProductsForBudget({
        products: search.products,
        needState: input.needState,
        productClass: input.productIntent,
        userMessage: input.userMessage
      });
      const plateFiltered = input.productIntent === 'plate'
        ? filterPlateProductsByCurrentTask({
            products: budgetFiltered.products,
            userMessage: input.userMessage,
            query,
            semanticContext
          })
        : {
            products: budgetFiltered.products,
            droppedProductIds: [] as string[],
            warnings: [] as string[]
          };
      const droppedPreviousIds = new Set(input.droppedPreviousProductIds);
      replacementProducts = plateFiltered.products
        .filter((product) => productMatchesIntent(product, input.productIntent))
        .filter((product) => !droppedPreviousIds.has(product.id))
        .slice(0, 8);
      result = ToolResultSchema.parse({
        requestId,
        tool: 'catalog.search',
        status: replacementProducts.length ? 'ok' : 'not_found',
        payload: {
          query,
          productIds: replacementProducts.map((product) => product.id),
          products: replacementProducts,
          replacementFor: 'narrowed_need_mismatch',
          droppedPreviousProductIds: input.droppedPreviousProductIds,
          sourceRequestId: requestId,
          productIntent: input.productIntent,
          reason: input.reason,
          retrieval: {
            intent: search.productIntent,
            query: search.query,
            embeddingQuery: search.embeddingQuery,
            textCount: search.textCount,
            vectorCount: search.vectorCount,
            usedEmbeddings: search.vectorCount > 0
          }
        },
        warnings: uniqueStrings([
          'answer_products_replaced_by_narrowed_need_search',
          ...search.warnings,
          ...budgetFiltered.warnings,
          ...plateFiltered.warnings,
          ...(replacementProducts.length ? [] : ['catalog_search_no_matches'])
        ])
      });
    } catch (error) {
      result = ToolResultSchema.parse({
        requestId,
        tool: 'catalog.search',
        status: 'error',
        payload: {
          query,
          productIds: [],
          products: [],
          replacementFor: 'narrowed_need_mismatch',
          droppedPreviousProductIds: input.droppedPreviousProductIds,
          sourceRequestId: requestId,
          productIntent: input.productIntent,
          reason: input.reason,
          error: safeError(error)
        },
        warnings: ['answer_products_narrowed_replacement_search_error'],
        errorCode: safeError(error).code ?? safeError(error).message
      });
    }

    await this.conversations.saveToolArtifact({
      sessionId: input.session.id,
      turnId: input.turnId,
      toolName: result.tool,
      toolRequestId: result.requestId,
      status: result.status,
      payload: result.payload,
      warnings: [...result.warnings, `duration_ms:${Date.now() - startedAt}`]
    });

    return {
      products: replacementProducts,
      toolResult: result,
      evidence: {
        query,
        productIds: replacementProducts.map((product) => product.id),
        droppedPreviousProductIds: input.droppedPreviousProductIds,
        warnings: result.warnings,
        sourceRequestId: requestId,
        productIntent: input.productIntent,
        reason: input.reason
      }
    };
  }

  private async canUseProductEmbeddings() {
    const coverageFn = (this.products as unknown as {
      getEmbeddingCoverage?: ProductRepository['getEmbeddingCoverage'];
    }).getEmbeddingCoverage;
    if (!coverageFn) return false;

    const key = `products:${config.OPENAI_EMBEDDING_MODEL}`;
    const cached = this.embeddingCoverageCache.get(key);
    const now = Date.now();
    if (cached && cached.expiresAt > now) return cached.usable;

    try {
      const coverage = await coverageFn.call(this.products, 'products', config.OPENAI_EMBEDDING_MODEL);
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
    userMessage?: string;
    semanticContext?: string;
    productIntent?: ProductSelectionClass;
    embeddingQuery?: string;
    budgetMax?: number;
  }) {
    const query = input.query;
    const limit = input.limit;
    const semanticContext = input.semanticContext ?? query;
    const productIntent = input.productIntent && input.productIntent !== 'unknown'
      ? input.productIntent
      : inferProductIntent(semanticContext);
    const embeddingQuery = input.embeddingQuery?.trim() || query;
    const warnings: string[] = [];
    let firstError: unknown = null;
    let textProducts: Product[] = [];
    let vectorProducts: Product[] = [];

    try {
      textProducts = await this.products.searchProducts(query, Math.max(limit, limit * 3));
    } catch (error) {
      firstError = error;
      warnings.push(`catalog_text_search_error:${safeError(error).code ?? safeError(error).message}`);
    }

    const vectorSearchFn = (this.products as unknown as {
      vectorSearch?: ProductRepository['vectorSearch'];
    }).vectorSearch;
    if (vectorSearchFn && await this.canUseProductEmbeddings()) {
      const embedding = await this.createCachedQueryEmbedding(embeddingQuery, input.signal);
      if (embedding) {
        try {
          vectorProducts = await vectorSearchFn.call(this.products, embedding, Math.max(limit, limit * 3));
        } catch (error) {
          firstError ??= error;
          warnings.push(`catalog_vector_search_error:${safeError(error).code ?? safeError(error).message}`);
        }
      }
    }

    const byId = new Map<string, Product>();
    for (const product of [...textProducts, ...vectorProducts]) byId.set(product.id, product);
    const shouldBroadenForBudget = input.budgetMax !== undefined &&
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
          const broadProducts = await this.products.searchProducts('', 500);
          let added = 0;
          for (const product of broadProducts) {
            if (!productMatchesIntent(product, productIntent)) continue;
            if (typeof product.price !== 'number' || !Number.isFinite(product.price) || product.price > input.budgetMax!) continue;
            if (!byId.has(product.id)) added += 1;
            byId.set(product.id, product);
          }
          if (added > 0) warnings.push(`catalog_budget_fallback_pool:${added}`);
        } catch (error) {
          firstError ??= error;
          warnings.push(`catalog_budget_fallback_error:${safeError(error).code ?? safeError(error).message}`);
        }
      }
    }
    const mergedProducts = [...byId.values()];
    const matchingProducts = productIntent === 'unknown'
      ? mergedProducts
      : mergedProducts.filter((product) => productMatchesIntent(product, productIntent));
    if (productIntent !== 'unknown' && matchingProducts.length !== mergedProducts.length) {
      warnings.push(`catalog_products_filtered_by_intent:${productIntent}:${mergedProducts.length - matchingProducts.length}`);
    }
    const batteryPowerRequired = isGeneratorProductClass(productIntent) &&
      requiresBatteryPowerStationFromText([
        query,
        semanticContext,
        input.userMessage,
        input.embeddingQuery
      ].filter(Boolean).join('\n'));
    let sourceFilteredProducts = batteryPowerRequired
      ? matchingProducts.filter(isBatteryPowerStation)
      : matchingProducts;
    if (sourceFilteredProducts.length !== matchingProducts.length) {
      warnings.push(`catalog_products_filtered_by_power_source:battery:${matchingProducts.length - sourceFilteredProducts.length}`);
      if (!sourceFilteredProducts.length) {
        try {
          const fallbackBatteryProducts = await this.products.searchProducts(
            fromEscaped('\\u0430\\u043a\\u043a\\u0443\\u043c\\u0443\\u043b\\u044f\\u0442\\u043e\\u0440\\u043d\\u0430\\u044f \\u044d\\u043b\\u0435\\u043a\\u0442\\u0440\\u043e\\u0441\\u0442\\u0430\\u043d\\u0446\\u0438\\u044f'),
            Math.max(limit * 6, 80)
          );
          sourceFilteredProducts = fallbackBatteryProducts
            .filter((product) => productMatchesIntent(product, productIntent))
            .filter(isBatteryPowerStation);
          if (sourceFilteredProducts.length) {
            warnings.push(`catalog_battery_power_station_fallback_pool:${sourceFilteredProducts.length}`);
          } else {
            warnings.push('catalog_search_no_power_source_fit:battery');
          }
        } catch (error) {
          firstError ??= error;
          warnings.push(`catalog_battery_power_station_fallback_error:${safeError(error).code ?? safeError(error).message}`);
          warnings.push('catalog_search_no_power_source_fit:battery');
        }
      }
    }
    const rankedProducts = rankCatalogProductsByNumericFit({
      products: sourceFilteredProducts,
      intent: productIntent,
      query,
      semanticContext,
      userMessage: input.userMessage ?? query
    });
    const products = rankedProducts.slice(0, limit);
    if (!products.length && firstError) throw firstError;
    return {
      query,
      embeddingQuery,
      productIntent,
      products,
      textCount: textProducts.length,
      vectorCount: vectorProducts.length,
      warnings
    };
  }

  private async review(input: AgentManagerReviewInput): Promise<PreSendReview> {
    const mechanicalIssues: PreSendReview['issues'] = [];
    const contactInTurn = extractContact(input.userMessage);
    if (hasLeadContact(contactInTurn) && answerRequestsContactData(input.answer.answerText)) {
      mechanicalIssues.push({
        code: 'asks_contact_already_provided',
        severity: 'high',
        message: 'Answer asks for contact even though the current buyer message already contains contact details.',
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
    const trustedSourceIds = new Set<string>([
      ...input.ledgerState.eventIds,
      ...input.toolResults.map((result) => result.requestId)
    ]);
    for (const fact of input.answer.factsUsed) {
      const unknownSourceIds = fact.sourceEventIds.filter((sourceId) => !trustedSourceIds.has(sourceId));
      if (unknownSourceIds.length) {
        mechanicalIssues.push({
          code: 'unsupported_fact_source',
          severity: 'high',
          message: `Answer fact ${fact.factKey} references sources that are absent from ledger/tool artifacts.`,
          evidence: unknownSourceIds.join(', ')
        });
      }
    }
    const failedFactSourceIds = factSourceIdsFromNonOkTools({
      answer: input.answer,
      toolResults: input.toolResults
    });
    if (failedFactSourceIds.length) {
      mechanicalIssues.push({
        code: 'failed_tool_result_used_as_fact_source',
        severity: 'high',
        message: 'A failed, denied, timed out, or not-found tool result was used as evidence for a factual claim.',
        evidence: failedFactSourceIds.join(', ')
      });
    }
    const unknownToolResultIds = input.answer.toolResultIds.filter((toolResultId) => !trustedSourceIds.has(toolResultId));
    if (unknownToolResultIds.length) {
      mechanicalIssues.push({
        code: 'unknown_tool_result_reference',
        severity: 'high',
        message: 'Answer references tool results that were not executed for this turn.',
        evidence: unknownToolResultIds.join(', ')
      });
    }
    const leadCaptureOk = input.toolResults.some((result) => result.tool === 'lead.capture' && result.status === 'ok');
    if ((input.answer.leadAction === 'capture_contact' || input.answer.leadAction === 'confirm_contact_received') && !leadCaptureOk) {
      const contactMissing = leadCaptureMissingContact(input.toolResults);
      if (contactMissing && !hasLeadContact(contactInTurn)) {
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
    if (
      leadCaptureMissingContact(input.toolResults) &&
      !hasLeadContact(contactInTurn) &&
      !mechanicalIssues.some((issue) => issue.code === 'lead_capture_missing_contact_offer_form')
    ) {
      mechanicalIssues.push({
        code: 'lead_capture_missing_contact_offer_form',
        severity: 'medium',
        message: 'A commercial handoff was planned without buyer contact; rewrite to a safe form offer without promising delivery, discounts, stock, or special terms.',
        evidence: JSON.stringify(input.toolResults.filter((result) => result.tool === 'lead.capture'))
      });
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
    const safeResearchRewrite = researchGuidanceSafeRewrite({
      toolResults: input.toolResults,
      intent: input.intent
    });
    if (safeResearchRewrite && safeResearchRewrite !== input.answer.answerText.trim()) {
      mechanicalIssues.push({
        code: 'research_guidance_uncertainty_safe_rewrite',
        severity: 'high',
        message: 'Exact-model research has unconfirmed or ambiguous coverage; use checked answerGuidance instead of a broader generated claim.',
        evidence: safeResearchRewrite
      });
    }
    const unsupportedCatalogProductMentionRewrite = unsupportedCatalogProductMentionSafeRewrite({
      answerText: input.answer.answerText,
      intent: input.intent,
      products: input.products
    });
    if (unsupportedCatalogProductMentionRewrite) {
      mechanicalIssues.push({
        code: 'unsupported_catalog_product_mention',
        severity: 'high',
        message: 'Catalog selection answer names a model identifier that is absent from the product evidence passed to the answer.',
        evidence: unsupportedCatalogProductMentionRewrite.unsupportedDisplayTokens.join(', ')
      });
    }
    const plateTaskMismatchClause = (input.requiredResponseClauses ?? []).find((clause) =>
      clause.code === 'plate_previous_cards_unsuitable_for_current_task'
    );
    const explicitHeavyPlateTaskConflictClause = (input.requiredResponseClauses ?? []).find((clause) =>
      clause.code === 'plate_explicit_heavy_request_conflicts_with_small_site_task'
    );
    if (plateTaskMismatchClause) {
      mechanicalIssues.push({
        code: 'plate_previous_cards_unsuitable_for_current_task',
        severity: 'high',
        message: 'Previous heavy plate products conflict with the current home paving/tile task and must not be recommended.',
        evidence: uniqueStrings(plateTaskMismatchClause.catalogProductNames ?? []).join(', ') || plateTaskMismatchClause.instruction
      });
    }
    if (
      explicitHeavyPlateTaskConflictClause &&
      !answerSatisfiesExplicitHeavyPlateTaskConflict(input.answer.answerText)
    ) {
      mechanicalIssues.push({
        code: 'plate_explicit_heavy_request_conflicts_with_small_site_task',
        severity: 'high',
        message: 'Explicit heavy plate request conflicts with the current home paving/tile task and must be rejected with a concrete lighter weight range.',
        evidence: explicitHeavyPlateTaskConflictClause.instruction
      });
    }
    const blockingIssueCodes = new Set([
      'unsupported_fact_source',
      'unknown_tool_result_reference',
      'lead_confirmation_without_local_capture',
      'requires_adjudication',
      'unsupported_claim_risk_flag'
    ]);
    const blockingIssues = mechanicalIssues.filter((issue) => blockingIssueCodes.has(issue.code));
    if (blockingIssues.length) {
      return {
        verdict: 'block',
        issues: blockingIssues
      };
    }
    const leadCaptureRepairIssue = mechanicalIssues.find((issue) =>
      issue.code === 'lead_capture_missing_contact_offer_form' || issue.code === 'lead_capture_missing_name'
    );
    if (leadCaptureRepairIssue) {
      return {
        verdict: 'rewrite_required',
        issues: mechanicalIssues,
        revisedAnswerText: leadCaptureRepairText({
          contact: contactInTurn,
          toolResults: input.toolResults,
          answerText: input.answer.answerText
        })
      };
    }
    const researchGuidanceRepairIssue = mechanicalIssues.find((issue) => issue.code === 'research_guidance_uncertainty_safe_rewrite');
    if (researchGuidanceRepairIssue && safeResearchRewrite) {
      return {
        verdict: 'rewrite_required',
        issues: mechanicalIssues,
        revisedAnswerText: safeResearchRewrite
      };
    }
    const failedFactSourceRepairIssue = mechanicalIssues.find((issue) => issue.code === 'failed_tool_result_used_as_fact_source');
    const failedWebResearchRewrite = failedWebResearchSafeRewrite({
      intent: input.intent,
      toolResults: input.toolResults
    });
    if (failedFactSourceRepairIssue && failedWebResearchRewrite) {
      return {
        verdict: 'rewrite_required',
        issues: mechanicalIssues,
        revisedAnswerText: failedWebResearchRewrite
      };
    }
    const unsupportedCatalogProductMentionIssue = mechanicalIssues.find((issue) =>
      issue.code === 'unsupported_catalog_product_mention'
    );
    if (unsupportedCatalogProductMentionIssue && unsupportedCatalogProductMentionRewrite) {
      return {
        verdict: 'rewrite_required',
        issues: mechanicalIssues,
        revisedAnswerText: unsupportedCatalogProductMentionRewrite.revisedAnswerText
      };
    }
    const plateTaskMismatchIssue = mechanicalIssues.find((issue) =>
      issue.code === 'plate_previous_cards_unsuitable_for_current_task'
    );
    if (plateTaskMismatchIssue && plateTaskMismatchClause) {
      return {
        verdict: 'rewrite_required',
        issues: mechanicalIssues,
        revisedAnswerText: plateTaskMismatchSafeRewrite(plateTaskMismatchClause)
      };
    }
    const explicitHeavyPlateTaskConflictIssue = mechanicalIssues.find((issue) =>
      issue.code === 'plate_explicit_heavy_request_conflicts_with_small_site_task'
    );
    if (explicitHeavyPlateTaskConflictIssue) {
      return {
        verdict: 'rewrite_required',
        issues: mechanicalIssues,
        revisedAnswerText: plateExplicitHeavyTaskConflictSafeRewrite(input.products)
      };
    }
    if (mechanicalIssues.length) {
      return {
        verdict: 'rewrite_required',
        issues: mechanicalIssues,
        revisedAnswerText: stripContactRequestSentence(input.answer.answerText)
      };
    }
    if (!config.AGENT_MANAGER_PRE_SEND_REVIEW_ENABLED) {
      return { verdict: 'pass', issues: [] };
    }
    return this.model.reviewAnswer(input);
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
    const runtimeDecision = getAgentManagerRuntimeDecision(session);
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
    onDelta?: (text: string) => void | Promise<void>
  ): Promise<ChatResponsePayload | null> {
    const row = await this.conversations.getFinalAnswerContract(session.id, turnId);
    const answerText = typeof row?.answer_text === 'string' ? row.answer_text.trim() : '';
    if (!answerText) return null;
    const rawLedgerRows = await this.conversations.listDialogueLedgerEvents(session.id, 500);
    const ledgerState = reduceDialogueLedger(mapLedgerRows(rawLedgerRows as DialogueLedgerRow[]));
    const needStateSnapshot = deriveNeedStateSnapshotFromLedger(ledgerState, session.needState ?? emptyNeedState());
    const runtimeDecision = getAgentManagerRuntimeDecision(session);
    const metadata = {
      agentManager: true,
      runtimeMode: runtimeDecision.runtimeMode,
      runtimeModeReason: runtimeDecision.reason,
      agentManagerRuntime: runtimeDecision,
      recovered,
      recoveredFromAnswerContract: true,
      turnId,
      answerContract: row.contract,
      preSendReview: row.review,
      needStateSnapshot
    };
    await onDelta?.(answerText);
    const assistantMessage = await this.conversations.addAssistantMessageForTurn({
      sessionId: session.id,
      turnId,
      content: answerText,
      metadata,
      recovered
    });
    await this.conversations.upsertTurnCheckpoint({
      sessionId: session.id,
      turnId,
      checkpoint: 'assistant_message_saved',
      status: 'succeeded',
      artifactRef: assistantMessage.id,
      payload: { recoveredFromAnswerContract: true }
    });
    await this.trace(session.id, turnId, 'turn', 'assistant_message_saved_from_answer_contract', {
      assistantMessageId: assistantMessage.id,
      recovered
    });
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
    await this.conversations.addAgentTrace({
      sessionId,
      turnId,
      phase,
      eventType,
      payload,
      redacted: true
    }).catch((error) => console.warn('Agent manager trace write failed', safeError(error)));
  }
}
