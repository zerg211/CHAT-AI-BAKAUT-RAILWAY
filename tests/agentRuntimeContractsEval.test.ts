import { describe, expect, it } from 'vitest';
import type { AgentTurnContract } from '../src/shared/types.js';
import { buildCardManifest } from '../src/ai/cardManifest.js';
import { buildExecutionContract } from '../src/ai/executionContract.js';
import { buildFactClaimPlanner } from '../src/ai/factClaimPlanner.js';
import { buildLeadStateMachine } from '../src/ai/leadStateMachine.js';
import { emptyNeedState, mergeProductSelectionState } from '../src/ai/needState.js';
import { buildRequirementLedger } from '../src/ai/requirementLedger.js';
import { resolveTurnContract } from '../src/ai/turnContract.js';

const basePlan = {
  action: 'recommend_products' as const,
  answerMode: 'productRecommendation' as const,
  cardPolicy: 'showProducts' as const,
  followUpPolicy: 'auto' as const,
  contextScope: 'activeNeed' as const,
  searchScope: 'focusedNeed' as const,
  catalogSearchQuery: 'TSS gasoline generator 8-10 kW 220 V',
  selectedProductIds: ['tss-8'],
  needsWebSearch: false,
  missingInformation: [],
  answerGuidance: 'short product recommendation'
};

const baseAgentContract: AgentTurnContract = {
  answerTask: 'product_selection',
  taskType: 'product_selection',
  catalogAction: 'find_matching_products',
  commercialAction: 'none',
  productCardsPolicy: 'show_matching_products',
  mustAnswerNow: [],
  activeNeeds: [{ id: 'need-generator', productClass: 'generator', summary: 'TSS gasoline generator' }],
  currentFocus: 'generator',
  cardsRole: 'primary',
  leadAllowed: true,
  leadAllowedReason: 'selection',
  errorRecoveryPriority: 'none',
  validatorWarnings: []
};

describe('agent runtime contract eval suite', () => {
  it('keeps requirements, execution, cards, facts, and lead policy aligned for a catalog recommendation', () => {
    const base = emptyNeedState();
    const selectionState = mergeProductSelectionState(base.selectionState, {
      hardConstraints: {
        ...base.selectionState.hardConstraints,
        productIntent: 'generator',
        brandConstraint: 'TSS',
        fuel: 'gasoline',
        singlePhase220: true
      }
    });
    const needState = { ...base, selectionState };
    const requirementLedger = buildRequirementLedger({ needState });
    const executionContract = buildExecutionContract({
      agentContract: baseAgentContract,
      renderContract: resolveTurnContract({ plan: basePlan }),
      selectionState,
      webRequired: false,
      activeRequirementIds: requirementLedger.activeRequirementIds
    });
    const cardManifest = buildCardManifest({
      executionContract,
      cards: [{
        id: 'tss-8',
        name: 'TSS SGG 8000EH gasoline generator 220 V',
        brand: 'TSS',
        category: 'Generators',
        specs: { fuel: 'gasoline', voltage: '220 V' },
        reasons: [],
        caveats: []
      }],
      visibleProductIds: ['tss-8'],
      hiddenProductIds: []
    });
    const factClaimPlanner = buildFactClaimPlanner({ executionContract, requirementLedger, cardManifest });
    const leadStateMachine = buildLeadStateMachine({
      executionContract,
      hasContactInTurn: false,
      leadRequested: false,
      leadCreated: false
    });

    expect(executionContract.cardsPolicy).toBe('primary');
    expect(cardManifest.warnings).toEqual([]);
    expect(factClaimPlanner.risk).toBe('low');
    expect(leadStateMachine.state).toBe('not_needed');
  });

  it('marks specialist handoff turns as high-risk facts and lead-required without inventing stock promises', () => {
    const needState = emptyNeedState();
    const requirementLedger = buildRequirementLedger({ needState });
    const executionContract = buildExecutionContract({
      agentContract: {
        ...baseAgentContract,
        answerTask: 'lead_handoff',
        taskType: 'pure_availability',
        catalogAction: 'exact_model_lookup',
        commercialAction: 'explain_manager_required',
        productCardsPolicy: 'show_exact_matches',
        cardsRole: 'supporting'
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
      selectionState: needState.selectionState,
      webRequired: false
    });
    const factClaimPlanner = buildFactClaimPlanner({ executionContract, requirementLedger });
    const leadStateMachine = buildLeadStateMachine({
      executionContract,
      hasContactInTurn: false,
      leadRequested: true,
      leadCreated: false
    });

    expect(executionContract.factPolicy).toBe('specialist_required');
    expect(factClaimPlanner.risk).toBe('high');
    expect(factClaimPlanner.forbiddenClaims).toContain('do_not_promise_live_stock_delivery_discount_or_exact_terms');
    expect(leadStateMachine.state).toBe('required_contact_missing');
  });
});
