import type {
  AgentTurnContractV2,
  ExecutionLeadPolicy,
  LeadDraft,
  ProductEvidenceRegistry
} from '../shared/types.js';

function reasonFromContract(contract: AgentTurnContractV2): LeadDraft['reason'] {
  if (
    contract.intent === 'availability_check' ||
    contract.taskType === 'pure_availability' ||
    contract.taskType === 'product_selection_with_availability'
  ) return 'availability';
  if (
    contract.intent === 'delivery_or_discount' ||
    contract.taskType === 'pure_delivery' ||
    contract.taskType === 'product_selection_with_delivery'
  ) return 'delivery';
  if (contract.commercialAction === 'offer_contact_after_answer') return 'order';
  if (contract.answerTask === 'lead_handoff') return 'specialist_consultation';
  return 'specialist_consultation';
}

export function buildLeadDraft(input: {
  contract: AgentTurnContractV2;
  registry: ProductEvidenceRegistry;
  buyerQuestion: string;
  contact?: LeadDraft['contact'];
}): LeadDraft | null {
  if (input.contract.leadPolicy === 'none' || input.contract.leadPolicy === 'forbidden') return null;
  return {
    version: 1,
    reason: reasonFromContract(input.contract),
    productIds: [
      ...input.registry.visibleProductIds,
      ...input.contract.selectedProductIds.filter((id) => !input.registry.visibleProductIds.includes(id))
    ].slice(0, 20),
    buyerQuestion: input.buyerQuestion,
    missingFacts: input.contract.missingFacts,
    contact: input.contact
  };
}

export function shouldCommitLeadFromDraft(input: {
  draft: LeadDraft | null;
  leadRequested: boolean;
  executionLeadPolicy: ExecutionLeadPolicy;
  contact?: LeadDraft['contact'];
}) {
  if (!input.draft) return false;
  if (!input.leadRequested) return false;
  if (input.executionLeadPolicy === 'none' || input.executionLeadPolicy === 'forbidden') return false;
  return Boolean(input.contact?.phone || input.contact?.email);
}
