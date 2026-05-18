import type {
  AgentSource,
  AgentSourcePolicyV2,
  AgentTurnContract,
  AgentWebPurpose,
  ExecutionFactPolicy
} from '../shared/types.js';

function unique<T>(items: T[]) {
  return [...new Set(items)];
}

function withoutForbidden(allowed: AgentSource[], forbidden: AgentSource[]) {
  const blocked = new Set(forbidden);
  return allowed.filter((source) => !blocked.has(source));
}

export function normalizeSourcePolicy(policy: Partial<AgentSourcePolicyV2> | undefined): AgentSourcePolicyV2 {
  const forbidden = unique(policy?.forbidden ?? []);
  const required = unique(policy?.required ?? []).filter((source) => !forbidden.includes(source));
  const allowed = unique(withoutForbidden([...(policy?.allowed ?? []), ...required], forbidden));
  return {
    allowed,
    required,
    forbidden,
    webPurpose: policy?.webPurpose ?? (required.includes('web') ? 'technical_specs' : 'none')
  };
}

export function sourcePolicyRequiresWeb(policy: AgentSourcePolicyV2) {
  return policy.required.includes('web') || (policy.allowed.includes('web') && policy.webPurpose !== 'none');
}

export function sourcePolicyForFactPolicy(factPolicy: ExecutionFactPolicy): AgentSourcePolicyV2 {
  if (factPolicy === 'web_required') {
    return normalizeSourcePolicy({
      allowed: ['catalog', 'visible_cards', 'conversation_memory', 'web'],
      required: ['web'],
      forbidden: ['specialist'],
      webPurpose: 'technical_specs'
    });
  }
  if (factPolicy === 'specialist_required') {
    return normalizeSourcePolicy({
      allowed: ['catalog', 'visible_cards', 'conversation_memory', 'specialist'],
      required: ['specialist'],
      forbidden: ['web'],
      webPurpose: 'none'
    });
  }
  return normalizeSourcePolicy({
    allowed: ['catalog', 'visible_cards', 'conversation_memory'],
    required: [],
    forbidden: ['specialist'],
    webPurpose: 'none'
  });
}

function webPurposeFromContract(contract: AgentTurnContract, webRequired: boolean): AgentWebPurpose {
  if (!webRequired) return 'none';
  if (contract.taskType === 'technical_answer') return 'technical_specs';
  if (contract.answerTask === 'technical_explanation') return 'manual_or_service';
  return 'technical_specs';
}

export function sourcePolicyFromLegacyContract(input: {
  contract: AgentTurnContract;
  webRequired?: boolean;
}): AgentSourcePolicyV2 {
  const { contract } = input;
  const webRequired = Boolean(input.webRequired);
  if (
    contract.commercialAction === 'explain_manager_required' ||
    contract.taskType === 'pure_availability' ||
    contract.taskType === 'pure_delivery' ||
    contract.taskType === 'product_selection_with_availability' ||
    contract.taskType === 'product_selection_with_delivery'
  ) {
    return normalizeSourcePolicy({
      allowed: ['catalog', 'visible_cards', 'conversation_memory', 'specialist'],
      required: ['specialist'],
      forbidden: ['web'],
      webPurpose: 'none'
    });
  }
  if (webRequired) {
    return normalizeSourcePolicy({
      allowed: ['catalog', 'visible_cards', 'conversation_memory', 'web'],
      required: ['web'],
      forbidden: ['specialist'],
      webPurpose: webPurposeFromContract(contract, webRequired)
    });
  }
  return normalizeSourcePolicy({
    allowed: contract.cardsRole === 'none'
      ? ['catalog', 'conversation_memory']
      : ['catalog', 'visible_cards', 'conversation_memory'],
    required: [],
    forbidden: ['specialist'],
    webPurpose: 'none'
  });
}

export function sourcePolicyAllows(policy: AgentSourcePolicyV2, source: AgentSource) {
  return policy.allowed.includes(source) && !policy.forbidden.includes(source);
}

export function sourcePolicyWarnings(policy: AgentSourcePolicyV2) {
  const warnings: string[] = [];
  for (const source of policy.required) {
    if (!policy.allowed.includes(source)) warnings.push(`required_source_not_allowed:${source}`);
    if (policy.forbidden.includes(source)) warnings.push(`required_source_forbidden:${source}`);
  }
  if (policy.forbidden.includes('web') && policy.webPurpose && policy.webPurpose !== 'none') {
    warnings.push('web_purpose_set_while_web_forbidden');
  }
  return warnings;
}
