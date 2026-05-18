import type {
  CustomerNeedState,
  NeedItem,
  SemanticRequirement
} from '../shared/types.js';

function nowIso() {
  return new Date().toISOString();
}

function uniqueStrings(values: Array<string | undefined | null>, limit = 50) {
  return [...new Set(values.map((value) => String(value ?? '').trim()).filter(Boolean))].slice(0, limit);
}

function needItem(value: string, evidence: string): NeedItem {
  return {
    value,
    evidence,
    confidence: 0.82,
    updatedAt: nowIso()
  };
}

function requirementFromText(value: string, index: number): SemanticRequirement {
  const now = nowIso();
  return {
    id: `contract:${now}:${index}`,
    kind: 'task',
    value: { text: value },
    status: 'active',
    strictness: 'targetRange',
    evidence: 'agent_turn_contract_v2.needDelta',
    source: 'llm_inference',
    replacesRequirementIds: [],
    updatedAt: now
  };
}

export function applyContractNeedDelta(input: {
  needState: CustomerNeedState;
  needDelta?: {
    newRequirements?: string[];
    confirmedRequirements?: string[];
    changedRequirements?: string[];
    supersededRequirementIds?: string[];
    rejectedProductIds?: string[];
  };
}): CustomerNeedState {
  const delta = input.needDelta;
  if (!delta) return input.needState;
  const hasDelta = Boolean(
    delta.newRequirements?.length ||
    delta.confirmedRequirements?.length ||
    delta.changedRequirements?.length ||
    delta.supersededRequirementIds?.length ||
    delta.rejectedProductIds?.length
  );
  if (!hasDelta) return input.needState;

  const now = nowIso();
  const superseded = new Set(delta.supersededRequirementIds ?? []);
  const changedRequirements = uniqueStrings(delta.changedRequirements ?? [], 20);
  const newRequirements = uniqueStrings(delta.newRequirements ?? [], 20);
  const confirmedRequirements = uniqueStrings(delta.confirmedRequirements ?? [], 20);
  const requirements = input.needState.semanticMemory.requirements.map((requirement) =>
    superseded.has(requirement.id)
      ? { ...requirement, status: 'superseded' as const, updatedAt: now }
      : requirement
  );
  const addedRequirements = [...newRequirements, ...changedRequirements].map(requirementFromText);
  const activeRequirementIds = uniqueStrings([
    ...input.needState.semanticMemory.activeRequirementIds.filter((id) => !superseded.has(id)),
    ...addedRequirements.map((item) => item.id)
  ], 64);

  return {
    ...input.needState,
    explicitNeeds: [
      ...input.needState.explicitNeeds,
      ...confirmedRequirements.map((value) => needItem(value, 'agent_turn_contract_v2.confirmedRequirements')),
      ...newRequirements.map((value) => needItem(value, 'agent_turn_contract_v2.newRequirements'))
    ].slice(-20),
    contradictions: [
      ...input.needState.contradictions,
      ...changedRequirements.map((value) => needItem(value, 'agent_turn_contract_v2.changedRequirements'))
    ].slice(-20),
    semanticMemory: {
      ...input.needState.semanticMemory,
      activeRequirementIds,
      requirements: [...requirements, ...addedRequirements].slice(-80),
      mentionedProducts: input.needState.semanticMemory.mentionedProducts.map((product) =>
        delta.rejectedProductIds?.some((id) => product.productIds.includes(id))
          ? { ...product, status: 'notMatchingRequirement' as const, updatedAt: now }
          : product
      )
    }
  };
}
