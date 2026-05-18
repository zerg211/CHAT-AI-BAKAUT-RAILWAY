import type {
  AgentCatalogAction,
  AgentAnswerTask,
  AgentCardsRole,
  AgentCommercialAction,
  AgentIntentV2,
  AgentProductCardsPolicy,
  AgentSource,
  AgentToolName,
  AgentToolPlanStepV2,
  AgentTurnContract,
  AgentTurnContractV2,
  AgentWebPurpose,
  CustomerNeedState,
  ExecutionLeadPolicy,
  AgentTaskType
} from '../shared/types.js';
import { normalizeSourcePolicy, sourcePolicyFromLegacyContract, sourcePolicyWarnings } from './sourcePolicy.js';

type LegacyPlanLike = {
  action?: string;
  answerMode?: string;
  selectedProductIds?: string[];
  missingInformation?: string[];
  agentContractV2?: AgentTurnContractV2 | null;
};

const answerTasks: AgentAnswerTask[] = ['technical_explanation', 'comparison', 'product_selection', 'mixed', 'lead_handoff'];
const taskTypes: AgentTaskType[] = [
  'pure_delivery',
  'pure_availability',
  'product_selection',
  'product_selection_with_delivery',
  'product_selection_with_availability',
  'technical_answer',
  'comparison',
  'contact_refusal_continue_selection'
];
const catalogActions: AgentCatalogAction[] = ['none', 'exact_model_lookup', 'find_matching_products', 'verify_catalog_absence'];
const commercialActions: AgentCommercialAction[] = ['none', 'explain_manager_required', 'offer_contact_after_answer'];
const productCardsPolicies: AgentProductCardsPolicy[] = ['none', 'show_exact_matches', 'show_matching_products', 'supporting_only'];
const cardsRoles: AgentCardsRole[] = ['none', 'supporting', 'primary'];
const leadPolicies: ExecutionLeadPolicy[] = ['none', 'forbidden', 'optional_after_answer', 'required_now'];
const agentIntents: AgentIntentV2[] = [
  'product_selection',
  'technical_answer',
  'comparison',
  'exact_model_lookup',
  'availability_check',
  'delivery_or_discount',
  'lead_handoff',
  'offtopic'
];
const agentSources: AgentSource[] = ['catalog', 'visible_cards', 'web', 'specialist', 'conversation_memory'];
const webPurposes: AgentWebPurpose[] = ['technical_specs', 'manual_or_service', 'current_lineup', 'none'];
const toolNames: AgentToolName[] = [
  'searchCatalog',
  'getProductDetails',
  'selectProducts',
  'compareProducts',
  'webFactSearch',
  'createLeadDraft',
  'createLead'
];

function unique<T>(items: T[], limit = 100) {
  return [...new Set(items)].slice(0, limit);
}

function compactStrings(items: unknown, limit = 12) {
  return Array.isArray(items)
    ? items.map((item) => String(item ?? '').trim()).filter(Boolean).slice(0, limit)
    : [];
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? value as T : fallback;
}

function optionalEnumValue<T extends string>(value: unknown, allowed: readonly T[], fallback?: T): T | undefined {
  return allowed.includes(value as T) ? value as T : fallback;
}

function numberConfidence(value: unknown, fallback: number) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(1, number)) : fallback;
}

function sourceList(value: unknown) {
  return compactStrings(value, 8).filter((item): item is AgentSource => agentSources.includes(item as AgentSource));
}

function normalizeToolPlan(value: unknown): AgentToolPlanStepV2[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): AgentToolPlanStepV2[] => {
    if (!item || typeof item !== 'object') return [];
    const object = item as Record<string, unknown>;
    const tool = enumValue(object.tool, toolNames, 'selectProducts');
    return [{
      tool,
      reason: String(object.reason ?? '').trim().slice(0, 300) || `Planner requested ${tool}.`,
      required: typeof object.required === 'boolean' ? object.required : true,
      inputHint: object.inputHint && typeof object.inputHint === 'object' && !Array.isArray(object.inputHint)
        ? object.inputHint as Record<string, unknown>
        : {}
    }];
  }).slice(0, 8);
}

function normalizeNeedDelta(value: unknown): AgentTurnContractV2['needDelta'] {
  const object = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  return {
    newRequirements: compactStrings(object.newRequirements, 16),
    confirmedRequirements: compactStrings(object.confirmedRequirements, 16),
    changedRequirements: compactStrings(object.changedRequirements, 16),
    supersededRequirementIds: compactStrings(object.supersededRequirementIds, 16),
    rejectedProductIds: compactStrings(object.rejectedProductIds, 24)
  };
}

export function coercePlannerAgentTurnContractV2(
  value: unknown,
  fallback?: AgentTurnContractV2
): AgentTurnContractV2 | null {
  if (!value || typeof value !== 'object') return fallback ?? null;
  const object = value as Record<string, unknown>;
  const sourcePolicyInput = object.sourcePolicy && typeof object.sourcePolicy === 'object'
    ? object.sourcePolicy as Record<string, unknown>
    : {};
  const sourcePolicy = normalizeSourcePolicy({
    allowed: sourceList(sourcePolicyInput.allowed),
    required: sourceList(sourcePolicyInput.required),
    forbidden: sourceList(sourcePolicyInput.forbidden),
    webPurpose: enumValue(sourcePolicyInput.webPurpose, webPurposes, fallback?.sourcePolicy.webPurpose ?? 'none')
  });
  const needDelta = normalizeNeedDelta(object.needDelta);
  const selectedProductIds = compactStrings(object.selectedProductIds, 24);
  const rejectedProductIds = unique([
    ...compactStrings(object.rejectedProductIds, 24),
    ...needDelta.rejectedProductIds
  ], 24);

  return {
    version: 2,
    intent: enumValue(object.intent, agentIntents, fallback?.intent ?? 'technical_answer'),
    answerTask: enumValue(object.answerTask, answerTasks, fallback?.answerTask ?? 'mixed'),
    taskType: optionalEnumValue(object.taskType, taskTypes, fallback?.taskType),
    catalogAction: enumValue(object.catalogAction, catalogActions, fallback?.catalogAction ?? 'none'),
    commercialAction: enumValue(object.commercialAction, commercialActions, fallback?.commercialAction ?? 'none'),
    productCardsPolicy: enumValue(object.productCardsPolicy, productCardsPolicies, fallback?.productCardsPolicy ?? 'none'),
    cardsRole: enumValue(object.cardsRole, cardsRoles, fallback?.cardsRole ?? 'none'),
    leadPolicy: enumValue(object.leadPolicy, leadPolicies, fallback?.leadPolicy ?? 'none'),
    sourcePolicy,
    needDelta,
    missingFacts: compactStrings(object.missingFacts, 12),
    toolPlan: normalizeToolPlan(object.toolPlan),
    selectedProductIds,
    rejectedProductIds,
    mustAnswerNow: compactStrings(object.mustAnswerNow, 8),
    currentFocus: String(object.currentFocus ?? fallback?.currentFocus ?? '').trim().slice(0, 120) || 'latest_message',
    errorRecoveryPriority: String(object.errorRecoveryPriority ?? fallback?.errorRecoveryPriority ?? '').trim().slice(0, 500) || 'Answer the latest buyer question from validated context.',
    confidence: numberConfidence(object.confidence, fallback?.confidence ?? 0.5),
    warnings: unique([
      'contract_v2_source:llm_planner',
      ...compactStrings(object.warnings, 24),
      ...(fallback?.warnings ?? []).filter((warning) => !warning.startsWith('contract_v2_source:'))
    ], 40)
  };
}

function leadPolicyFromLegacy(contract: AgentTurnContract): ExecutionLeadPolicy {
  if (!contract.leadAllowed) return 'forbidden';
  if (contract.answerTask !== 'lead_handoff') {
    return contract.commercialAction === 'offer_contact_after_answer' ? 'optional_after_answer' : 'none';
  }
  if (contract.commercialAction === 'offer_contact_after_answer') return 'optional_after_answer';
  return 'required_now';
}

function intentFromLegacy(contract: AgentTurnContract): AgentIntentV2 {
  if (contract.taskType === 'pure_availability') return 'availability_check';
  if (contract.taskType === 'pure_delivery') return 'delivery_or_discount';
  if (contract.catalogAction === 'exact_model_lookup' || contract.catalogAction === 'verify_catalog_absence') return 'exact_model_lookup';
  if (contract.answerTask === 'product_selection') return 'product_selection';
  if (contract.answerTask === 'comparison' || contract.taskType === 'comparison') return 'comparison';
  if (contract.answerTask === 'lead_handoff') return 'lead_handoff';
  return 'technical_answer';
}

function toolForCatalogAction(action: AgentCatalogAction): AgentToolName | null {
  if (action === 'none') return null;
  if (action === 'exact_model_lookup' || action === 'verify_catalog_absence') return 'searchCatalog';
  return 'selectProducts';
}

function toolPlanFromLegacy(input: {
  contract: AgentTurnContract;
  selectedProductIds: string[];
  missingFacts: string[];
  webRequired: boolean;
}): AgentToolPlanStepV2[] {
  const steps: AgentToolPlanStepV2[] = [];
  const catalogTool = toolForCatalogAction(input.contract.catalogAction ?? 'none');
  if (catalogTool) {
    steps.push({
      tool: catalogTool,
      reason: input.contract.catalogAction === 'exact_model_lookup'
        ? 'Exact model or catalog-presence lookup requested by the semantic contract.'
        : 'Catalog selection requested by the semantic contract.',
      required: true,
      inputHint: {
        catalogAction: input.contract.catalogAction,
        productCardsPolicy: input.contract.productCardsPolicy,
        selectedProductIds: input.selectedProductIds
      }
    });
  }
  if (input.webRequired) {
    steps.push({
      tool: 'webFactSearch',
      reason: 'The turn requires external technical/current-lineup verification before answering.',
      required: true,
      inputHint: {
        missingFacts: input.missingFacts
      }
    });
  }
  if (input.contract.answerTask === 'lead_handoff' && input.contract.leadAllowed) {
    steps.push({
      tool: 'createLeadDraft',
      reason: 'The buyer question requires specialist follow-up or commercial verification.',
      required: input.contract.commercialAction === 'explain_manager_required',
      inputHint: {
        commercialAction: input.contract.commercialAction,
        currentFocus: input.contract.currentFocus
      }
    });
  }
  return steps;
}

function reconcileToolPlanWithLeadPolicy(
  steps: AgentToolPlanStepV2[],
  leadPolicy: ExecutionLeadPolicy
) {
  if (leadPolicy === 'none' || leadPolicy === 'forbidden') {
    return steps.filter((step) => step.tool !== 'createLeadDraft' && step.tool !== 'createLead');
  }
  return steps;
}

export function deriveAgentTurnContractV2(input: {
  userMessage: string;
  legacyContract: AgentTurnContract;
  plan?: LegacyPlanLike;
  needState: CustomerNeedState;
  webRequired?: boolean;
  selectedProductIds?: string[];
  rejectedProductIds?: string[];
}): AgentTurnContractV2 {
  const legacy = input.legacyContract;
  const selectedProductIds = unique([
    ...(input.selectedProductIds ?? []),
    ...(input.plan?.selectedProductIds ?? [])
  ].filter(Boolean), 24);
  const rejectedProductIds = unique(input.rejectedProductIds ?? [], 24);
  const missingFacts = unique([
    ...compactStrings(input.plan?.missingInformation, 12),
    ...(input.webRequired ? ['external_fact_verification_required'] : [])
  ], 12);
  const sourcePolicy = sourcePolicyFromLegacyContract({
    contract: legacy,
    webRequired: input.webRequired
  });
  const warnings = unique([
    input.plan?.agentContractV2 ? 'contract_v2_source:llm_planner' : 'contract_v2_source:legacy_adapter',
    ...(legacy.validatorWarnings ?? []),
    ...sourcePolicyWarnings(sourcePolicy)
  ], 40);

  const fallback: AgentTurnContractV2 = {
    version: 2,
    intent: intentFromLegacy(legacy),
    answerTask: legacy.answerTask,
    taskType: legacy.taskType,
    catalogAction: legacy.catalogAction ?? 'none',
    commercialAction: legacy.commercialAction ?? 'none',
    productCardsPolicy: legacy.productCardsPolicy ?? 'none',
    cardsRole: legacy.cardsRole,
    leadPolicy: leadPolicyFromLegacy(legacy),
    sourcePolicy,
    needDelta: {
      newRequirements: [],
      confirmedRequirements: [],
      changedRequirements: [],
      supersededRequirementIds: [],
      rejectedProductIds
    },
    missingFacts,
    toolPlan: toolPlanFromLegacy({
      contract: legacy,
      selectedProductIds,
      missingFacts,
      webRequired: Boolean(input.webRequired)
    }),
    selectedProductIds,
    rejectedProductIds,
    mustAnswerNow: [...legacy.mustAnswerNow],
    currentFocus: legacy.currentFocus,
    errorRecoveryPriority: legacy.errorRecoveryPriority,
    confidence: legacy.validatorWarnings?.includes('contract_source:missing_llm_contract') ? 0.25 : 0.72,
    warnings
  };

  const direct = coercePlannerAgentTurnContractV2(input.plan?.agentContractV2, fallback);
  if (!direct || !input.plan?.agentContractV2) return fallback;
  const directSourcePolicy = normalizeSourcePolicy(direct.sourcePolicy);
  const safetySourcePolicy = sourcePolicy.required.includes('specialist') || sourcePolicy.forbidden.includes('web')
    ? sourcePolicy
    : directSourcePolicy;
  const leadPolicy = leadPolicyFromLegacy(legacy);
  const toolPlan = reconcileToolPlanWithLeadPolicy(
    direct.toolPlan.length ? direct.toolPlan : fallback.toolPlan,
    leadPolicy
  );

  return {
    ...direct,
    answerTask: legacy.answerTask,
    taskType: legacy.taskType,
    catalogAction: legacy.catalogAction ?? 'none',
    commercialAction: legacy.commercialAction ?? 'none',
    productCardsPolicy: legacy.productCardsPolicy ?? 'none',
    cardsRole: legacy.cardsRole,
    leadPolicy,
    sourcePolicy: safetySourcePolicy,
    selectedProductIds: unique([...direct.selectedProductIds, ...selectedProductIds], 24),
    rejectedProductIds: unique([...direct.rejectedProductIds, ...rejectedProductIds], 24),
    missingFacts: unique([...direct.missingFacts, ...missingFacts], 12),
    toolPlan,
    mustAnswerNow: legacy.mustAnswerNow.length ? [...legacy.mustAnswerNow] : direct.mustAnswerNow,
    currentFocus: legacy.currentFocus || direct.currentFocus,
    errorRecoveryPriority: legacy.errorRecoveryPriority || direct.errorRecoveryPriority,
    confidence: Math.min(1, Math.max(0, direct.confidence)),
    warnings: unique([
      'contract_v2_source:llm_planner',
      ...direct.warnings.filter((warning) => !warning.startsWith('contract_v2_source:')),
      ...legacy.validatorWarnings,
      ...sourcePolicyWarnings(safetySourcePolicy)
    ], 40)
  };
}

export function contractV2ToLegacyAgentContract(contract: AgentTurnContractV2): AgentTurnContract {
  return {
    answerTask: contract.answerTask,
    taskType: contract.taskType,
    catalogAction: contract.catalogAction,
    commercialAction: contract.commercialAction,
    productCardsPolicy: contract.productCardsPolicy,
    mustAnswerNow: [...contract.mustAnswerNow],
    activeNeeds: [],
    currentFocus: contract.currentFocus,
    cardsRole: contract.cardsRole,
    leadAllowed: contract.leadPolicy !== 'forbidden',
    leadAllowedReason: `contract_v2_lead_policy:${contract.leadPolicy}`,
    errorRecoveryPriority: contract.errorRecoveryPriority,
    validatorWarnings: [...contract.warnings]
  };
}
