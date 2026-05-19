import type {
  AgentToolName,
  AgentToolTraceItem,
  AgentTurnContractV2,
  ExecutionContract,
  FactClaimPlanner,
  LeadStateMachine,
  PolicyGateEnforcement,
  PolicyGateResult,
  ProductEvidenceRegistry,
  RequirementLedger
} from '../shared/types.js';
import { sourcePolicyRequiresWeb } from './sourcePolicy.js';

function unique<T>(items: T[]) {
  return [...new Set(items)];
}

const repairableBlockedReasons = new Set([
  'primary_cards_required_but_no_allowed_visible_cards'
]);

export function runPolicyGate(input: {
  contract: AgentTurnContractV2;
  requirementLedger: RequirementLedger;
  productEvidenceRegistry: ProductEvidenceRegistry;
  executionContract: ExecutionContract;
  factClaimPlanner: FactClaimPlanner;
  leadStateMachine: LeadStateMachine;
  webSearchPlanned: boolean;
}): PolicyGateResult {
  const blockedReasons: string[] = [];
  const requiredActions: AgentToolName[] = [];
  const answerConstraints: string[] = [];
  const warnings: string[] = [];

  if (sourcePolicyRequiresWeb(input.contract.sourcePolicy) && !input.webSearchPlanned) {
    blockedReasons.push('web_required_but_not_planned');
    requiredActions.push('webFactSearch');
  }

  if (input.contract.sourcePolicy.required.includes('specialist')) {
    answerConstraints.push('do_not_promise_live_stock_delivery_discount_or_exact_terms');
    answerConstraints.push('explain_that_specialist_or_logistics_must_verify_final_terms');
  }

  if (input.leadStateMachine.nextAction === 'do_not_ask_contact') {
    answerConstraints.push('do_not_ask_for_name_phone_contact_or_callback');
  }
  if (input.leadStateMachine.nextAction === 'confirm_created_lead') {
    answerConstraints.push('confirm_contact_received_only');
    answerConstraints.push('do_not_repeat_product_selection_or_commercial_handoff');
    answerConstraints.push('do_not_ask_for_name_phone_contact_or_form_again');
  }

  if (
    input.executionContract.cardsPolicy === 'primary' &&
    input.contract.cardsRole === 'primary' &&
    input.productEvidenceRegistry.visibleProductIds.length === 0
  ) {
    blockedReasons.push('primary_cards_required_but_no_allowed_visible_cards');
    requiredActions.push('selectProducts');
  }

  if (
    input.contract.catalogAction === 'exact_model_lookup' &&
    input.productEvidenceRegistry.visibleProductIds.length > 0 &&
    input.contract.commercialAction === 'explain_manager_required'
  ) {
    answerConstraints.push('separate_catalog_presence_from_live_stock');
  }

  if (input.factClaimPlanner.forbiddenClaims.includes('do_not_promise_live_stock_delivery_discount_or_exact_terms')) {
    answerConstraints.push('commercial_facts_need_verification_wording');
  }

  if (input.requirementLedger.warnings.length) {
    warnings.push(...input.requirementLedger.warnings.map((warning) => `requirement_ledger:${warning}`));
  }
  if (input.productEvidenceRegistry.warnings.length) {
    warnings.push(...input.productEvidenceRegistry.warnings.map((warning) => `product_evidence:${warning}`));
  }
  if (input.executionContract.warnings.length) {
    warnings.push(...input.executionContract.warnings.map((warning) => `execution_contract:${warning}`));
  }

  return {
    version: 1,
    ok: blockedReasons.length === 0,
    blockedReasons: unique(blockedReasons),
    requiredActions: unique(requiredActions),
    answerConstraints: unique(answerConstraints),
    warnings: unique(warnings)
  };
}

export function enforcePolicyGateBeforeAnswer(input: {
  policyGate: PolicyGateResult;
  toolTrace?: AgentToolTraceItem[];
}): PolicyGateEnforcement {
  const failedRequiredTools = unique((input.toolTrace ?? [])
    .filter((item) => item.required && !item.ok)
    .map((item) => item.tool));
  const repairedReasons = failedRequiredTools.length
    ? []
    : input.policyGate.blockedReasons.filter((reason) => repairableBlockedReasons.has(reason));
  const repairedReasonSet = new Set(repairedReasons);
  const hardBlockReasons = unique([
    ...input.policyGate.blockedReasons.filter((reason) => !repairedReasonSet.has(reason)),
    ...failedRequiredTools.map((tool) => `required_tool_failed:${tool}`)
  ]);
  const repairConstraints = repairedReasons.length
    ? [
        'do_not_name_concrete_products_without_allowed_product_evidence',
        'explain_that_no_valid_visible_catalog_cards_match_current_hard_constraints',
        'ask_one_targeted_clarifying_question_or_offer_to_broaden_constraints'
      ]
    : [];

  return {
    version: 1,
    mode: hardBlockReasons.length ? 'hard_block' : repairedReasons.length ? 'repair' : 'pass',
    hardBlockReasons,
    repairedReasons: unique(repairedReasons),
    requiredActions: unique([
      ...input.policyGate.requiredActions,
      ...failedRequiredTools
    ]),
    answerConstraints: unique([
      ...input.policyGate.answerConstraints,
      ...repairConstraints
    ]),
    failedRequiredTools,
    warnings: unique([
      ...input.policyGate.warnings,
      ...repairedReasons.map((reason) => `policy_gate_repaired:${reason}`),
      ...failedRequiredTools.map((tool) => `tool_trace:required_tool_failed:${tool}`)
    ])
  };
}
