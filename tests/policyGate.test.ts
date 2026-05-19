import { describe, expect, it } from 'vitest';
import type {
  AgentTurnContractV2,
  ExecutionContract,
  FactClaimPlanner,
  LeadStateMachine,
  ProductEvidenceRegistry,
  RequirementLedger
} from '../src/shared/types.js';
import { enforcePolicyGateBeforeAnswer, runPolicyGate } from '../src/ai/policyGate.js';

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
  selectedProductIds: [],
  rejectedProductIds: [],
  mustAnswerNow: [],
  currentFocus: 'generator',
  errorRecoveryPriority: 'answer',
  confidence: 0.8,
  warnings: []
};

const requirementLedger: RequirementLedger = {
  version: 1,
  activeRequirementIds: [],
  primaryRequirementIds: [],
  alternativeMode: 'none',
  items: [],
  hardConstraintKeys: [],
  warnings: []
};

const executionContract: ExecutionContract = {
  version: 1,
  source: 'agent_turn_contract',
  answerTask: 'product_selection',
  taskType: 'product_selection',
  catalogPolicy: 'find_matching_products',
  cardsPolicy: 'primary',
  leadPolicy: 'none',
  factPolicy: 'catalog_only',
  activeRequirementIds: [],
  postconditions: [],
  warnings: []
};

const factClaimPlanner: FactClaimPlanner = {
  version: 1,
  factPolicy: 'catalog_only',
  allowedSources: ['catalog', 'visible_cards'],
  requiredDisclaimers: [],
  forbiddenClaims: [],
  risk: 'low',
  warnings: []
};

const leadStateMachine: LeadStateMachine = {
  version: 1,
  state: 'not_needed',
  nextAction: 'answer_without_lead',
  leadPolicy: 'none',
  hasContactInTurn: false,
  leadRequested: false,
  leadCreated: false,
  warnings: []
};

const registry: ProductEvidenceRegistry = {
  version: 1,
  items: [],
  visibleProductIds: ['p1'],
  hiddenProductIds: [],
  rejectedProductIds: [],
  allowedProductIdsForText: ['p1'],
  warnings: []
};

describe('policy gate', () => {
  it('passes a grounded catalog product-selection turn', () => {
    const result = runPolicyGate({
      contract,
      requirementLedger,
      productEvidenceRegistry: registry,
      executionContract,
      factClaimPlanner,
      leadStateMachine,
      webSearchPlanned: false
    });

    expect(result.ok).toBe(true);
    expect(result.blockedReasons).toEqual([]);
    expect(enforcePolicyGateBeforeAnswer({ policyGate: result }).mode).toBe('pass');
  });

  it('requires webFactSearch when source policy requires web and it was not planned', () => {
    const result = runPolicyGate({
      contract: {
        ...contract,
        sourcePolicy: { allowed: ['catalog', 'web'], required: ['web'], forbidden: [], webPurpose: 'current_lineup' }
      },
      requirementLedger,
      productEvidenceRegistry: registry,
      executionContract,
      factClaimPlanner,
      leadStateMachine,
      webSearchPlanned: false
    });

    expect(result.ok).toBe(false);
    expect(result.blockedReasons).toContain('web_required_but_not_planned');
    expect(result.requiredActions).toContain('webFactSearch');

    const enforcement = enforcePolicyGateBeforeAnswer({ policyGate: result });
    expect(enforcement.mode).toBe('hard_block');
    expect(enforcement.hardBlockReasons).toContain('web_required_but_not_planned');
  });

  it('repairs a primary card answer with no visible allowed card into a text-only safe answer constraint', () => {
    const result = runPolicyGate({
      contract,
      requirementLedger,
      productEvidenceRegistry: {
        ...registry,
        visibleProductIds: [],
        allowedProductIdsForText: []
      },
      executionContract,
      factClaimPlanner,
      leadStateMachine,
      webSearchPlanned: false
    });

    const enforcement = enforcePolicyGateBeforeAnswer({ policyGate: result });

    expect(result.blockedReasons).toContain('primary_cards_required_but_no_allowed_visible_cards');
    expect(enforcement.mode).toBe('repair');
    expect(enforcement.repairedReasons).toContain('primary_cards_required_but_no_allowed_visible_cards');
    expect(enforcement.hardBlockReasons).toEqual([]);
    expect(enforcement.requiredActions).toContain('selectProducts');
    expect(enforcement.answerConstraints).toContain('do_not_name_concrete_products_without_allowed_product_evidence');
  });

  it('hard-blocks answer generation when a required tool failed', () => {
    const result = runPolicyGate({
      contract,
      requirementLedger,
      productEvidenceRegistry: registry,
      executionContract,
      factClaimPlanner,
      leadStateMachine,
      webSearchPlanned: false
    });

    const enforcement = enforcePolicyGateBeforeAnswer({
      policyGate: result,
      toolTrace: [{
        tool: 'webFactSearch',
        ok: false,
        risk: 'safe',
        reason: 'verify missing technical facts',
        required: true,
        warnings: ['web_search_not_enabled'],
        error: 'web_required_but_answer_model_web_search_not_enabled'
      }]
    });

    expect(enforcement.mode).toBe('hard_block');
    expect(enforcement.failedRequiredTools).toEqual(['webFactSearch']);
    expect(enforcement.hardBlockReasons).toContain('required_tool_failed:webFactSearch');
    expect(enforcement.requiredActions).toContain('webFactSearch');
  });

  it('does not hard-block searchCatalog when runtime product selection already satisfied catalog retrieval', () => {
    const result = runPolicyGate({
      contract,
      requirementLedger,
      productEvidenceRegistry: registry,
      executionContract,
      factClaimPlanner,
      leadStateMachine,
      webSearchPlanned: false
    });

    const enforcement = enforcePolicyGateBeforeAnswer({
      policyGate: result,
      toolTrace: [
        {
          tool: 'searchCatalog',
          ok: false,
          risk: 'safe',
          reason: 'planner requested catalog search',
          required: true,
          warnings: [],
          error: 'catalog_search_not_executed'
        },
        {
          tool: 'selectProducts',
          ok: true,
          risk: 'safe',
          reason: 'runtime selected visible product cards',
          required: true,
          warnings: []
        }
      ]
    });

    expect(enforcement.mode).toBe('pass');
    expect(enforcement.failedRequiredTools).toEqual([]);
    expect(enforcement.hardBlockReasons).not.toContain('required_tool_failed:searchCatalog');
  });

  it('does not hard-block createLead when a lead draft is prepared for form capture', () => {
    const result = runPolicyGate({
      contract: {
        ...contract,
        leadPolicy: 'required_now',
        commercialAction: 'offer_contact_after_answer'
      },
      requirementLedger,
      productEvidenceRegistry: registry,
      executionContract: {
        ...executionContract,
        leadPolicy: 'required_now',
        factPolicy: 'specialist_required'
      },
      factClaimPlanner,
      leadStateMachine: {
        ...leadStateMachine,
        state: 'required_contact_missing',
        nextAction: 'ask_for_missing_contact',
        leadPolicy: 'required_now',
        leadRequested: true
      },
      webSearchPlanned: false
    });

    const enforcement = enforcePolicyGateBeforeAnswer({
      policyGate: result,
      toolTrace: [
        {
          tool: 'createLeadDraft',
          ok: true,
          risk: 'safe',
          reason: 'prepare specialist handoff',
          required: true,
          warnings: []
        },
        {
          tool: 'createLead',
          ok: false,
          risk: 'sensitive',
          reason: 'commit lead if contact is already present',
          required: true,
          warnings: ['lead_create_not_committed'],
          error: 'lead_not_created_by_current_turn'
        }
      ]
    });

    expect(enforcement.mode).toBe('pass');
    expect(enforcement.failedRequiredTools).toEqual([]);
    expect(enforcement.hardBlockReasons).not.toContain('required_tool_failed:createLead');
  });

  it('adds commercial verification constraints for specialist policy', () => {
    const result = runPolicyGate({
      contract: {
        ...contract,
        commercialAction: 'explain_manager_required',
        sourcePolicy: { allowed: ['specialist'], required: ['specialist'], forbidden: ['web'], webPurpose: 'none' }
      },
      requirementLedger,
      productEvidenceRegistry: registry,
      executionContract: { ...executionContract, factPolicy: 'specialist_required' },
      factClaimPlanner: {
        ...factClaimPlanner,
        factPolicy: 'specialist_required',
        forbiddenClaims: ['do_not_promise_live_stock_delivery_discount_or_exact_terms']
      },
      leadStateMachine,
      webSearchPlanned: false
    });

    expect(result.answerConstraints).toContain('do_not_promise_live_stock_delivery_discount_or_exact_terms');
    expect(result.answerConstraints).toContain('commercial_facts_need_verification_wording');
  });

  it('forbids contact asks when lead state says do not ask contact', () => {
    const result = runPolicyGate({
      contract,
      requirementLedger,
      productEvidenceRegistry: registry,
      executionContract,
      factClaimPlanner,
      leadStateMachine: { ...leadStateMachine, nextAction: 'do_not_ask_contact', leadPolicy: 'forbidden', state: 'not_allowed' },
      webSearchPlanned: false
    });

    expect(result.answerConstraints).toContain('do_not_ask_for_name_phone_contact_or_callback');
  });
});
