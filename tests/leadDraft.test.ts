import { describe, expect, it } from 'vitest';
import type { AgentTurnContractV2, ProductEvidenceRegistry } from '../src/shared/types.js';
import { buildLeadDraft, shouldCommitLeadFromDraft } from '../src/ai/leadDraft.js';

const contract: AgentTurnContractV2 = {
  version: 2,
  intent: 'availability_check',
  answerTask: 'lead_handoff',
  taskType: 'pure_availability',
  catalogAction: 'exact_model_lookup',
  commercialAction: 'explain_manager_required',
  productCardsPolicy: 'show_exact_matches',
  cardsRole: 'supporting',
  leadPolicy: 'required_now',
  sourcePolicy: { allowed: ['specialist'], required: ['specialist'], forbidden: ['web'], webPurpose: 'none' },
  needDelta: {
    newRequirements: [],
    confirmedRequirements: [],
    changedRequirements: [],
    supersededRequirementIds: [],
    rejectedProductIds: []
  },
  missingFacts: ['live stock'],
  toolPlan: [],
  selectedProductIds: ['selected-hidden'],
  rejectedProductIds: [],
  mustAnswerNow: [],
  currentFocus: 'TSS 10 kW',
  errorRecoveryPriority: 'stock check',
  confidence: 0.8,
  warnings: []
};

const registry: ProductEvidenceRegistry = {
  version: 1,
  items: [],
  visibleProductIds: ['visible-card'],
  hiddenProductIds: [],
  rejectedProductIds: [],
  allowedProductIdsForText: ['visible-card'],
  warnings: []
};

describe('lead draft', () => {
  it('captures commercial handoff reason, products, and missing facts', () => {
    const draft = buildLeadDraft({
      contract,
      registry,
      buyerQuestion: 'Is it in stock?'
    });

    expect(draft).toMatchObject({
      reason: 'availability',
      productIds: ['visible-card', 'selected-hidden'],
      buyerQuestion: 'Is it in stock?',
      missingFacts: ['live stock']
    });
  });

  it('does not create draft when contact handoff is forbidden', () => {
    expect(buildLeadDraft({
      contract: { ...contract, leadPolicy: 'forbidden' },
      registry,
      buyerQuestion: 'No phone'
    })).toBeNull();
  });

  it('keeps mixed product selection plus delivery as a logistics handoff reason', () => {
    const draft = buildLeadDraft({
      contract: {
        ...contract,
        intent: 'lead_handoff',
        taskType: 'product_selection_with_delivery',
        commercialAction: 'offer_contact_after_answer'
      },
      registry,
      buyerQuestion: 'Select it and check delivery'
    });

    expect(draft?.reason).toBe('delivery');
  });

  it('allows lead commit only through an existing requested draft with contact and policy permission', () => {
    const draft = buildLeadDraft({
      contract,
      registry,
      buyerQuestion: 'Call me',
      contact: { name: 'Alex', phone: '+79990000000' }
    });

    expect(shouldCommitLeadFromDraft({
      draft,
      leadRequested: true,
      executionLeadPolicy: 'required_now',
      contact: draft?.contact
    })).toBe(true);
    expect(shouldCommitLeadFromDraft({
      draft,
      leadRequested: false,
      executionLeadPolicy: 'required_now',
      contact: draft?.contact
    })).toBe(false);
    expect(shouldCommitLeadFromDraft({
      draft,
      leadRequested: true,
      executionLeadPolicy: 'forbidden',
      contact: draft?.contact
    })).toBe(false);
    expect(shouldCommitLeadFromDraft({
      draft,
      leadRequested: true,
      executionLeadPolicy: 'required_now',
      contact: { name: 'Alex' }
    })).toBe(false);
  });
});
