import { describe, expect, it } from 'vitest';
import type { AgentTurnContract } from '../src/shared/types.js';
import { buildExecutionContract } from '../src/ai/executionContract.js';
import { emptyNeedState, mergeProductSelectionState } from '../src/ai/needState.js';
import { resolveTurnContract } from '../src/ai/turnContract.js';

const baseAgentContract: AgentTurnContract = {
  answerTask: 'product_selection',
  taskType: 'product_selection',
  catalogAction: 'find_matching_products',
  commercialAction: 'none',
  productCardsPolicy: 'show_matching_products',
  mustAnswerNow: [],
  activeNeeds: [{ id: 'need-1', productClass: 'generator', summary: 'home generator' }],
  currentFocus: 'home generator',
  cardsRole: 'primary',
  leadAllowed: true,
  leadAllowedReason: 'selection turn',
  errorRecoveryPriority: 'none',
  validatorWarnings: []
};

const basePlan = {
  action: 'recommend_products' as const,
  answerMode: 'productRecommendation' as const,
  cardPolicy: 'showProducts' as const,
  followUpPolicy: 'auto' as const,
  contextScope: 'activeNeed' as const,
  searchScope: 'focusedNeed' as const,
  catalogSearchQuery: 'generator for home',
  selectedProductIds: ['g1'],
  needsWebSearch: false,
  missingInformation: [],
  answerGuidance: 'answer briefly'
};

describe('execution contract', () => {
  it('marks product-selection cards as primary and forbids contact collection when lead is blocked', () => {
    const selectionState = mergeProductSelectionState(emptyNeedState().selectionState, {
      hardConstraints: {
        ...emptyNeedState().selectionState.hardConstraints,
        productIntent: 'generator',
        brandConstraint: 'TSS'
      }
    });
    const contract = buildExecutionContract({
      agentContract: {
        ...baseAgentContract,
        leadAllowed: false,
        leadAllowedReason: 'buyer declined contacts'
      },
      renderContract: resolveTurnContract({ plan: basePlan }),
      selectionState,
      webRequired: false,
      activeRequirementIds: ['req-generator', 'req-tss']
    });

    expect(contract.cardsPolicy).toBe('primary');
    expect(contract.leadPolicy).toBe('forbidden');
    expect(contract.factPolicy).toBe('catalog_only');
    expect(contract.activeRequirementIds).toEqual(['req-generator', 'req-tss']);
    expect(contract.activeConstraints?.brandConstraint).toBe('TSS');
    expect(contract.postconditions).toContain('visible_cards_must_satisfy_active_hard_constraints');
    expect(contract.postconditions).toContain('do_not_request_phone_or_contact_as_main_next_step');
  });

  it('marks availability handoff as specialist-required and requires the lead step', () => {
    const contract = buildExecutionContract({
      agentContract: {
        ...baseAgentContract,
        answerTask: 'lead_handoff',
        taskType: 'pure_availability',
        catalogAction: 'exact_model_lookup',
        commercialAction: 'explain_manager_required',
        productCardsPolicy: 'supporting_only',
        cardsRole: 'supporting',
        leadAllowed: true
      },
      renderContract: resolveTurnContract({
        plan: {
          ...basePlan,
          action: 'handoff_specialist',
          answerMode: 'leadCollection',
          followUpPolicy: 'collectLead',
          cardPolicy: 'auto'
        }
      }),
      selectionState: emptyNeedState().selectionState,
      webRequired: false
    });

    expect(contract.catalogPolicy).toBe('exact_model_lookup');
    expect(contract.cardsPolicy).toBe('selected_only');
    expect(contract.leadPolicy).toBe('required_now');
    expect(contract.factPolicy).toBe('specialist_required');
    expect(contract.postconditions).toContain('do_not_promise_live_stock_delivery_discount_or_exact_terms');
  });

  it('keeps web-required factual turns explicit even without product cards', () => {
    const contract = buildExecutionContract({
      agentContract: {
        ...baseAgentContract,
        answerTask: 'technical_explanation',
        taskType: 'technical_answer',
        catalogAction: 'none',
        productCardsPolicy: 'none',
        cardsRole: 'none'
      },
      renderContract: resolveTurnContract({
        plan: {
          ...basePlan,
          action: 'verify_with_web',
          answerMode: 'detailedFact',
          cardPolicy: 'textOnly',
          needsWebSearch: true
        },
        forceTextOnlyReason: 'web_fact_check'
      }),
      selectionState: emptyNeedState().selectionState,
      webRequired: true
    });

    expect(contract.cardsPolicy).toBe('none');
    expect(contract.leadPolicy).toBe('none');
    expect(contract.factPolicy).toBe('web_required');
    expect(contract.postconditions).toContain('named_models_must_be_visible_cards_exact_matches_or_verified_sources');
  });
});
