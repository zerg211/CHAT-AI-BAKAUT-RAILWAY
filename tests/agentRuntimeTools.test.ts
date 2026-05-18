import { describe, expect, it } from 'vitest';
import type { AgentTurnContractV2, ProductEvidenceRegistry } from '../src/shared/types.js';
import { createRuntimeArtifactToolHandlers } from '../src/ai/agentRuntimeTools.js';
import { buildLeadDraft } from '../src/ai/leadDraft.js';

const contract: AgentTurnContractV2 = {
  version: 2,
  intent: 'product_selection',
  answerTask: 'product_selection',
  taskType: 'product_selection',
  catalogAction: 'find_matching_products',
  commercialAction: 'none',
  productCardsPolicy: 'show_matching_products',
  cardsRole: 'primary',
  leadPolicy: 'none',
  sourcePolicy: { allowed: ['catalog', 'visible_cards'], required: [], forbidden: ['specialist'], webPurpose: 'none' },
  needDelta: {
    newRequirements: [],
    confirmedRequirements: [],
    changedRequirements: [],
    supersededRequirementIds: [],
    rejectedProductIds: []
  },
  missingFacts: [],
  toolPlan: [],
  selectedProductIds: ['p1'],
  rejectedProductIds: [],
  mustAnswerNow: [],
  currentFocus: 'generator',
  errorRecoveryPriority: 'answer',
  confidence: 0.8,
  warnings: []
};

const registry: ProductEvidenceRegistry = {
  version: 1,
  items: [],
  visibleProductIds: ['p1'],
  hiddenProductIds: [],
  rejectedProductIds: ['bad'],
  allowedProductIdsForText: ['p1'],
  warnings: ['registry_warning']
};

function handlers(overrides: Partial<Parameters<typeof createRuntimeArtifactToolHandlers>[0]> = {}) {
  return createRuntimeArtifactToolHandlers({
    contract,
    selection: {
      matchedProducts: [{ id: 'p1' }],
      rejectedProducts: [{ productId: 'bad', reason: 'wrong class' }]
    },
    productEvidenceRegistry: registry,
    leadDraft: null,
    autoLeadResult: null,
    webSearchEnabled: false,
    ...overrides
  });
}

describe('runtime artifact tool handlers', () => {
  it('returns structured catalog and selection observations from runtime artifacts', async () => {
    const toolHandlers = handlers();
    const catalog = await toolHandlers.searchCatalog?.({
      tool: 'searchCatalog',
      reason: 'search',
      required: true,
      inputHint: {}
    }, {} as never);
    const selection = await toolHandlers.selectProducts?.({
      tool: 'selectProducts',
      reason: 'select',
      required: true,
      inputHint: {}
    }, {} as never);

    expect(catalog).toMatchObject({
      ok: true,
      result: expect.objectContaining({
        mode: 'runtime_catalog_search_result',
        matchedProducts: 1
      })
    });
    expect(selection).toMatchObject({
      ok: true,
      result: expect.objectContaining({
        mode: 'runtime_product_selection_result',
        selectedProductIds: ['p1'],
        rejectedProductIds: ['bad']
      }),
      warnings: ['registry_warning']
    });
  });

  it('reports webFactSearch as unavailable unless answer runtime enabled web search', async () => {
    const denied = await handlers().webFactSearch?.({
      tool: 'webFactSearch',
      reason: 'verify',
      required: true,
      inputHint: {}
    }, {} as never);
    const allowed = await handlers({
      webSearchEnabled: true,
      contract: {
        ...contract,
        sourcePolicy: { allowed: ['web'], required: ['web'], forbidden: [], webPurpose: 'technical_specs' }
      }
    }).webFactSearch?.({
      tool: 'webFactSearch',
      reason: 'verify',
      required: true,
      inputHint: {}
    }, {} as never);

    expect(denied).toMatchObject({
      ok: false,
      error: 'web_required_but_answer_model_web_search_not_enabled'
    });
    expect(allowed).toMatchObject({
      ok: true,
      result: expect.objectContaining({
        mode: 'openai_web_search_preview_attached_to_answer',
        webPurpose: 'technical_specs'
      })
    });
  });

  it('separates lead draft observation from sensitive lead commit observation', async () => {
    const leadDraft = buildLeadDraft({
      contract: { ...contract, leadPolicy: 'required_now', answerTask: 'lead_handoff' },
      registry,
      buyerQuestion: 'call me',
      contact: { name: 'Alex', phone: '+79990000000' }
    });
    const toolHandlers = handlers({
      leadDraft,
      autoLeadResult: { created: true, lead: { id: 'lead-1' }, emailStatus: 'sent_email' }
    });
    const draft = await toolHandlers.createLeadDraft?.({
      tool: 'createLeadDraft',
      reason: 'draft',
      required: true,
      inputHint: {}
    }, {} as never);
    const committed = await toolHandlers.createLead?.({
      tool: 'createLead',
      reason: 'commit',
      required: true,
      inputHint: {}
    }, {} as never);

    expect(draft).toMatchObject({
      ok: true,
      risk: 'safe',
      result: expect.objectContaining({ productIds: ['p1'] })
    });
    expect(committed).toMatchObject({
      ok: true,
      risk: 'sensitive',
      result: expect.objectContaining({ leadId: 'lead-1' })
    });
  });
});
