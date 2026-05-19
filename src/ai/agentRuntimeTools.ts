import type {
  AgentToolName,
  AgentTurnContractV2,
  LeadDraft,
  ProductEvidenceRegistry,
  ProductSelectionRejection
} from '../shared/types.js';
import type { AgentToolHandler } from './agentTools.js';

type RuntimeAutoLeadResult = {
  created: boolean;
  lead?: { id: string };
  emailStatus?: 'sent_email' | 'email_failed' | 'pending_outbox';
  missing?: 'name' | 'contact';
  error?: string;
};

export interface RuntimeToolSelectionArtifacts {
  matchedProducts: unknown[];
  rejectedProducts: ProductSelectionRejection[];
}

export interface RuntimeToolArtifacts {
  contract: AgentTurnContractV2;
  selection: RuntimeToolSelectionArtifacts;
  productEvidenceRegistry: ProductEvidenceRegistry;
  leadDraft: LeadDraft | null;
  autoLeadResult: RuntimeAutoLeadResult | null;
  webSearchEnabled: boolean;
}

function result<T>(
  tool: AgentToolName,
  ok: boolean,
  risk: 'safe' | 'sensitive',
  value: T | undefined,
  warnings: string[] = [],
  error?: string
) {
  return {
    tool,
    ok,
    risk,
    result: value,
    error,
    warnings,
    durationMs: 0
  };
}

export function createRuntimeArtifactToolHandlers(input: RuntimeToolArtifacts): Partial<Record<AgentToolName, AgentToolHandler>> {
  return {
    searchCatalog: (step) => result(step.tool, true, 'safe', {
      mode: 'runtime_catalog_search_result',
      catalogAction: input.contract.catalogAction,
      matchedProducts: input.selection.matchedProducts.length,
      visibleProducts: input.productEvidenceRegistry.visibleProductIds.length
    }, input.selection.matchedProducts.length ? [] : ['catalog_search_returned_no_matches']),

    selectProducts: (step) => result(step.tool, true, 'safe', {
      mode: 'runtime_product_selection_result',
      selectedProductIds: input.productEvidenceRegistry.visibleProductIds,
      allowedProductIdsForText: input.productEvidenceRegistry.allowedProductIdsForText,
      rejectedProductIds: input.productEvidenceRegistry.rejectedProductIds.slice(0, 20)
    }, input.productEvidenceRegistry.warnings),

    getProductDetails: (step) => result(step.tool, input.productEvidenceRegistry.allowedProductIdsForText.length > 0, 'safe', {
      mode: 'runtime_product_evidence_details',
      visibleProductIds: input.productEvidenceRegistry.visibleProductIds,
      allowedProductIdsForText: input.productEvidenceRegistry.allowedProductIdsForText
    }, [], input.productEvidenceRegistry.allowedProductIdsForText.length ? undefined : 'product_details_not_available'),

    compareProducts: (step) => result(step.tool, input.productEvidenceRegistry.allowedProductIdsForText.length >= 2, 'safe', {
      mode: 'runtime_product_comparison_basis',
      productIds: input.productEvidenceRegistry.allowedProductIdsForText,
      answerTask: input.contract.answerTask
    }, [], input.productEvidenceRegistry.allowedProductIdsForText.length >= 2 ? undefined : 'not_enough_products_to_compare'),

    webFactSearch: (step) => result(
      step.tool,
      input.webSearchEnabled,
      'safe',
      input.webSearchEnabled
        ? {
            mode: 'openai_web_search_preview_attached_to_answer',
            webPurpose: input.contract.sourcePolicy.webPurpose
          }
        : undefined,
      input.webSearchEnabled ? [] : ['web_search_not_enabled'],
      input.webSearchEnabled ? undefined : 'web_required_but_answer_model_web_search_not_enabled'
    ),

    createLeadDraft: (step) => result(
      step.tool,
      Boolean(input.leadDraft),
      'safe',
      input.leadDraft
        ? {
            reason: input.leadDraft.reason,
            productIds: input.leadDraft.productIds,
            missingFacts: input.leadDraft.missingFacts
          }
        : undefined,
      [],
      input.leadDraft ? undefined : 'lead_draft_not_required'
    ),

    createLead: (step) => result(
      step.tool,
      input.autoLeadResult?.created ?? false,
      'sensitive',
      input.autoLeadResult
        ? {
            created: input.autoLeadResult.created,
            leadId: input.autoLeadResult.lead?.id,
            emailStatus: input.autoLeadResult.emailStatus,
            missing: input.autoLeadResult.missing
          }
        : undefined,
      input.autoLeadResult?.created ? [] : ['lead_create_not_committed'],
      input.autoLeadResult?.error ?? (input.autoLeadResult?.created ? undefined : 'lead_not_created_by_current_turn')
    )
  };
}
