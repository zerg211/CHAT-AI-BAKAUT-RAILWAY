import { describe, expect, it } from 'vitest';
import type { AgentTurnContract } from '../src/shared/types.js';
import {
  coercePlannerAgentTurnContractV2,
  contractV2ToLegacyAgentContract,
  deriveAgentTurnContractV2
} from '../src/ai/agentTurnContractV2.js';
import { emptyNeedState } from '../src/ai/needState.js';

const baseContract: AgentTurnContract = {
  answerTask: 'product_selection',
  taskType: 'product_selection',
  catalogAction: 'find_matching_products',
  commercialAction: 'none',
  productCardsPolicy: 'show_matching_products',
  mustAnswerNow: ['show catalog options'],
  activeNeeds: [],
  currentFocus: 'generator',
  cardsRole: 'primary',
  leadAllowed: true,
  leadAllowedReason: 'selection',
  errorRecoveryPriority: 'answer from catalog',
  validatorWarnings: ['contract_source:llm_planner']
};

describe('AgentTurnContractV2 adapter', () => {
  it('converts product selection into a V2 selection contract with a selectProducts tool', () => {
    const contract = deriveAgentTurnContractV2({
      userMessage: 'Show generator options',
      legacyContract: baseContract,
      plan: { selectedProductIds: ['p1'] },
      needState: emptyNeedState()
    });

    expect(contract.version).toBe(2);
    expect(contract.intent).toBe('product_selection');
    expect(contract.leadPolicy).toBe('none');
    expect(contract.selectedProductIds).toEqual(['p1']);
    expect(contract.toolPlan.map((step) => step.tool)).toContain('selectProducts');
    expect(contract.sourcePolicy.allowed).toContain('catalog');
  });

  it('separates exact availability from live stock and requires specialist source', () => {
    const contract = deriveAgentTurnContractV2({
      userMessage: 'Is TSS 10 kW gasoline in stock?',
      legacyContract: {
        ...baseContract,
        answerTask: 'lead_handoff',
        taskType: 'pure_availability',
        catalogAction: 'exact_model_lookup',
        commercialAction: 'explain_manager_required',
        productCardsPolicy: 'show_exact_matches',
        cardsRole: 'supporting'
      },
      plan: { selectedProductIds: ['tss-10'] },
      needState: emptyNeedState()
    });

    expect(contract.intent).toBe('availability_check');
    expect(contract.catalogAction).toBe('exact_model_lookup');
    expect(contract.sourcePolicy.required).toContain('specialist');
    expect(contract.sourcePolicy.forbidden).toContain('web');
    expect(contract.toolPlan.map((step) => step.tool)).toEqual(['searchCatalog', 'createLeadDraft']);
  });

  it('keeps contact refusal as leadPolicy forbidden', () => {
    const contract = deriveAgentTurnContractV2({
      userMessage: 'No phone yet, summarize first.',
      legacyContract: {
        ...baseContract,
        answerTask: 'technical_explanation',
        catalogAction: 'none',
        productCardsPolicy: 'none',
        cardsRole: 'none',
        leadAllowed: false
      },
      needState: emptyNeedState()
    });

    expect(contract.leadPolicy).toBe('forbidden');
    expect(contract.toolPlan.some((step) => step.tool === 'createLeadDraft')).toBe(false);
  });

  it('requires webFactSearch when web is required', () => {
    const contract = deriveAgentTurnContractV2({
      userMessage: 'Is this model still current?',
      legacyContract: {
        ...baseContract,
        answerTask: 'technical_explanation',
        taskType: 'technical_answer',
        catalogAction: 'none',
        productCardsPolicy: 'none',
        cardsRole: 'none'
      },
      needState: emptyNeedState(),
      webRequired: true
    });

    expect(contract.sourcePolicy.required).toContain('web');
    expect(contract.toolPlan.map((step) => step.tool)).toContain('webFactSearch');
  });

  it('coerces direct planner V2 output as the canonical contract source', () => {
    const direct = coercePlannerAgentTurnContractV2({
      version: 2,
      intent: 'comparison',
      answerTask: 'comparison',
      taskType: 'comparison',
      catalogAction: 'none',
      commercialAction: 'none',
      productCardsPolicy: 'none',
      cardsRole: 'none',
      leadPolicy: 'forbidden',
      sourcePolicy: {
        allowed: ['catalog', 'conversation_memory', 'web'],
        required: ['web'],
        forbidden: ['specialist'],
        webPurpose: 'technical_specs'
      },
      needDelta: {
        newRequirements: ['compare THD'],
        confirmedRequirements: [],
        changedRequirements: [],
        supersededRequirementIds: [],
        rejectedProductIds: ['old-card']
      },
      missingFacts: ['THD'],
      toolPlan: [{
        tool: 'webFactSearch',
        reason: 'Verify THD.',
        required: true,
        inputHint: { query: 'ignored by strict planner schema until tool handlers own inputs' }
      }],
      selectedProductIds: [],
      rejectedProductIds: [],
      mustAnswerNow: ['Compare inverter and conventional generators.'],
      currentFocus: 'generator THD',
      errorRecoveryPriority: 'Answer technical comparison first.',
      confidence: 0.91,
      warnings: []
    });

    expect(direct).toMatchObject({
      version: 2,
      intent: 'comparison',
      leadPolicy: 'forbidden',
      sourcePolicy: expect.objectContaining({
        required: ['web'],
        forbidden: ['specialist']
      })
    });
    expect(direct?.warnings).toContain('contract_v2_source:llm_planner');
    expect(direct?.toolPlan[0]).toMatchObject({
      tool: 'webFactSearch',
      required: true
    });
  });

  it('reconciles direct V2 output through runtime validation without falling back to legacy source', () => {
    const contract = deriveAgentTurnContractV2({
      userMessage: 'Compare THD on these generators',
      legacyContract: {
        ...baseContract,
        answerTask: 'comparison',
        taskType: 'comparison',
        catalogAction: 'none',
        productCardsPolicy: 'none',
        cardsRole: 'none'
      },
      plan: {
        agentContractV2: {
          version: 2,
          intent: 'comparison',
          answerTask: 'comparison',
          taskType: 'comparison',
          catalogAction: 'none',
          commercialAction: 'none',
          productCardsPolicy: 'none',
          cardsRole: 'none',
          leadPolicy: 'none',
          sourcePolicy: {
            allowed: ['catalog', 'conversation_memory', 'web'],
            required: ['web'],
            forbidden: ['specialist'],
            webPurpose: 'technical_specs'
          },
          needDelta: {
            newRequirements: [],
            confirmedRequirements: [],
            changedRequirements: [],
            supersededRequirementIds: [],
            rejectedProductIds: []
          },
          missingFacts: ['THD'],
          toolPlan: [{
            tool: 'webFactSearch',
            reason: 'Verify THD.',
            required: true,
            inputHint: {}
          }],
          selectedProductIds: [],
          rejectedProductIds: [],
          mustAnswerNow: ['Compare THD.'],
          currentFocus: 'generator THD',
          errorRecoveryPriority: 'Answer comparison.',
          confidence: 0.9,
          warnings: []
        }
      },
      needState: emptyNeedState(),
      webRequired: true
    });

    expect(contract.warnings).toContain('contract_v2_source:llm_planner');
    expect(contract.warnings).not.toContain('contract_v2_source:legacy_adapter');
    expect(contract.sourcePolicy.required).toContain('web');
    expect(contract.toolPlan.map((step) => step.tool)).toContain('webFactSearch');
  });

  it('converts V2 lead policy into legacy adapter fields for old runtime branches', () => {
    const contract = deriveAgentTurnContractV2({
      userMessage: 'No phone, summarize first',
      legacyContract: {
        ...baseContract,
        answerTask: 'technical_explanation',
        catalogAction: 'none',
        productCardsPolicy: 'none',
        cardsRole: 'none',
        leadAllowed: false
      },
      needState: emptyNeedState()
    });
    const legacy = contractV2ToLegacyAgentContract(contract);

    expect(legacy.leadAllowed).toBe(false);
    expect(legacy.leadAllowedReason).toBe('contract_v2_lead_policy:forbidden');
    expect(legacy.validatorWarnings).toContain('contract_v2_source:legacy_adapter');
  });
});
