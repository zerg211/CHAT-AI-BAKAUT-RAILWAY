import type {
  AgentTurnContract,
  ExecutionCardsPolicy,
  ExecutionContract,
  ExecutionFactPolicy,
  ExecutionLeadPolicy,
  ProductSelectionState
} from '../shared/types.js';
import type { ResolvedTurnContract } from './turnContract.js';

function cardsPolicyFromContracts(
  agent: AgentTurnContract,
  render: ResolvedTurnContract
): ExecutionCardsPolicy {
  const agentRequiresCards = agent.cardsRole !== 'none' && (agent.productCardsPolicy ?? 'none') !== 'none';
  if (!agentRequiresCards) return 'none';
  if (render.render.cards === 'selectedOnly') return 'selected_only';
  if (agent.cardsRole === 'primary') return 'primary';
  if (agent.productCardsPolicy === 'show_exact_matches') return 'selected_only';
  return 'supporting';
}

function leadPolicyFromContract(agent: AgentTurnContract): ExecutionLeadPolicy {
  if (!agent.leadAllowed) return 'forbidden';
  if (agent.answerTask !== 'lead_handoff') {
    if (
      agent.commercialAction === 'explain_manager_required' &&
      (
        agent.taskType === 'product_selection_with_delivery' ||
        agent.taskType === 'product_selection_with_availability'
      )
    ) {
      return 'optional_after_answer';
    }
    return agent.commercialAction === 'offer_contact_after_answer'
      ? 'optional_after_answer'
      : 'none';
  }
  if (agent.commercialAction === 'offer_contact_after_answer') return 'optional_after_answer';
  return 'required_now';
}

function factPolicyFromContract(agent: AgentTurnContract, webRequired: boolean): ExecutionFactPolicy {
  if (webRequired) return 'web_required';
  if (
    agent.commercialAction === 'explain_manager_required' ||
    agent.taskType === 'pure_availability' ||
    agent.taskType === 'pure_delivery' ||
    agent.taskType === 'product_selection_with_availability' ||
    agent.taskType === 'product_selection_with_delivery'
  ) {
    return 'specialist_required';
  }
  return 'catalog_only';
}

function postconditionsForContract(
  agent: AgentTurnContract,
  cardsPolicy: ExecutionCardsPolicy,
  factPolicy: ExecutionFactPolicy
) {
  const postconditions = [
    'named_models_must_be_visible_cards_exact_matches_or_verified_sources'
  ];
  if (cardsPolicy !== 'none') postconditions.push('visible_cards_must_satisfy_active_hard_constraints');
  if (factPolicy === 'specialist_required') {
    postconditions.push('do_not_promise_live_stock_delivery_discount_or_exact_terms');
  }
  if (!agent.leadAllowed) postconditions.push('do_not_request_phone_or_contact_as_main_next_step');
  return postconditions;
}

export function buildExecutionContract(input: {
  agentContract: AgentTurnContract;
  renderContract: ResolvedTurnContract;
  selectionState: ProductSelectionState;
  webRequired: boolean;
  activeRequirementIds?: string[];
}): ExecutionContract {
  const cardsPolicy = cardsPolicyFromContracts(input.agentContract, input.renderContract);
  const leadPolicy = leadPolicyFromContract(input.agentContract);
  const factPolicy = factPolicyFromContract(input.agentContract, input.webRequired);
  const warnings = [...(input.agentContract.validatorWarnings ?? [])];

  if (
    cardsPolicy === 'none' &&
    input.agentContract.cardsRole !== 'none' &&
    (input.agentContract.productCardsPolicy ?? 'none') !== 'none'
  ) {
    warnings.push('execution_cards_suppressed_by_render_contract');
  }
  if (leadPolicy === 'forbidden' && input.renderContract.render.leadForm) {
    warnings.push('execution_lead_form_suppressed_by_agent_contract');
  }

  return {
    version: 1,
    source: 'agent_turn_contract',
    answerTask: input.agentContract.answerTask,
    taskType: input.agentContract.taskType,
    catalogPolicy: input.agentContract.catalogAction ?? 'none',
    cardsPolicy,
    leadPolicy,
    factPolicy,
    activeRequirementIds: [...(input.activeRequirementIds ?? [])],
    activeConstraints: input.selectionState.hardConstraints,
    postconditions: postconditionsForContract(input.agentContract, cardsPolicy, factPolicy),
    warnings
  };
}
