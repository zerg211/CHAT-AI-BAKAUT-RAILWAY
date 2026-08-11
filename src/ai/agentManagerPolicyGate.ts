import {
  canonicalToolObservationStatus,
  type AgentIntentContract,
  type ToolRequest,
  type ToolResult
} from './agentManagerContracts.js';

export interface AgentManagerPolicyGateInput {
  intent: AgentIntentContract;
  toolResults?: ToolResult[];
}

export interface AgentManagerPolicyGateResult {
  version: 1;
  ok: boolean;
  blockedReasons: string[];
  requiredActions: ToolRequest['tool'][];
  answerConstraints: string[];
  warnings: string[];
  catalogFirst: boolean;
  webDeferredUntilCatalogGap: boolean;
}

function uniqueTools(values: ToolRequest['tool'][]) {
  return [...new Set(values)];
}

function hasCatalogTool(requests: ToolRequest[]) {
  return requests.some((request) =>
    request.tool === 'catalog.search' || request.tool === 'catalog.getProductDetails'
  );
}

function hasWebTool(requests: ToolRequest[]) {
  return requests.some((request) => request.tool === 'web.researchProductFacts');
}

function catalogRequired(intent: AgentIntentContract) {
  const grounding = intent.grounding;
  return grounding?.catalogRequirement === 'required' ||
    grounding?.sourcePolicy === 'catalog_required' ||
    grounding?.requiredToolKinds.some((tool) =>
      tool === 'catalog.search' || tool === 'catalog.getProductDetails'
    ) === true ||
    grounding?.taskType === 'availability_or_delivery' ||
    grounding?.taskType === 'product_selection' ||
    grounding?.taskType === 'comparison' ||
    intent.selectionPolicy?.selectionGoal !== undefined;
}

function webRequired(intent: AgentIntentContract) {
  const grounding = intent.grounding;
  return grounding?.buyerRequestedWeb === true ||
    grounding?.sourcePolicy === 'web_required' ||
    grounding?.webRequirement === 'buyer_requested' ||
    grounding?.webRequirement === 'independent_required' ||
    grounding?.requiredToolKinds.includes('web.researchProductFacts') === true;
}

/**
 * Deterministic policy boundary for an already typed LLM intent. It never
 * classifies the buyer message; it only checks whether the typed plan can be
 * safely executed and records the required next action.
 */
export function evaluateAgentManagerPolicyGate(
  input: AgentManagerPolicyGateInput
): AgentManagerPolicyGateResult {
  const requests = input.intent.toolRequests;
  const results = input.toolResults ?? [];
  const grounding = input.intent.grounding;
  const needsCatalog = catalogRequired(input.intent);
  const needsWeb = webRequired(input.intent);
  const conditionalWeb = grounding?.webRequirement === 'conditional_on_catalog_gap';
  const catalogRequestIndex = requests.findIndex((request) =>
    request.tool === 'catalog.search' || request.tool === 'catalog.getProductDetails'
  );
  const webRequestIndex = requests.findIndex((request) => request.tool === 'web.researchProductFacts');
  const catalogExists = catalogRequestIndex >= 0;
  const webExists = webRequestIndex >= 0;
  const blockedReasons: string[] = [];
  const requiredActions: ToolRequest['tool'][] = [];
  const answerConstraints: string[] = ['no_unsupported_factual_claims'];
  const warnings: string[] = [];

  if (needsCatalog) {
    answerConstraints.push('catalog_evidence_required_for_product_identity');
    requiredActions.push(
      requests.find((request) =>
        request.tool === 'catalog.search' || request.tool === 'catalog.getProductDetails'
      )?.tool ?? 'catalog.search'
    );
    if (!catalogExists) {
      blockedReasons.push('required_catalog_tool_missing');
    }
  }

  if (grounding?.taskType === 'availability_or_delivery') {
    answerConstraints.push('catalog_presence_is_not_live_stock');
  }

  if (needsWeb && !webExists) {
    blockedReasons.push('required_web_tool_missing');
  }
  if (needsWeb) requiredActions.push('web.researchProductFacts');

  if (conditionalWeb && !webExists) {
    warnings.push('web_deferred_until_catalog_gap');
  }

  const catalogFirst = !catalogExists || !webExists || catalogRequestIndex < webRequestIndex;
  if (needsCatalog && webExists && !catalogExists) {
    blockedReasons.push('catalog_before_web_required');
  } else if (needsCatalog && webExists && catalogRequestIndex > webRequestIndex) {
    blockedReasons.push('catalog_before_web_required');
    requiredActions.push('catalog.search');
  }

  const successfulCatalogEvidence = results.some((result) => {
    if (result.tool !== 'catalog.search' && result.tool !== 'catalog.getProductDetails') return false;
    return canonicalToolObservationStatus(result) === 'success';
  });
  if (conditionalWeb && successfulCatalogEvidence && webExists) {
    warnings.push('conditional_web_may_be_short_circuited_by_catalog_evidence');
  }

  if (!input.intent.requiresTools && results.length === 0) {
    answerConstraints.push('answer_only_from_conversation_or_confirmed_memory');
  }

  return {
    version: 1,
    ok: blockedReasons.length === 0,
    blockedReasons: [...new Set(blockedReasons)],
    requiredActions: uniqueTools(requiredActions),
    answerConstraints: [...new Set(answerConstraints)],
    warnings: [...new Set(warnings)],
    catalogFirst,
    webDeferredUntilCatalogGap: conditionalWeb && !webExists
  };
}
