import { describe, expect, it } from 'vitest';
import type { AgentTurnContract } from '../src/shared/types.js';
import { buildCardManifest } from '../src/ai/cardManifest.js';
import { buildExecutionContract } from '../src/ai/executionContract.js';
import { buildFactClaimPlanner } from '../src/ai/factClaimPlanner.js';
import { deriveAgentTurnContractV2 } from '../src/ai/agentTurnContractV2.js';
import { buildLeadDraft, shouldCommitLeadFromDraft } from '../src/ai/leadDraft.js';
import { buildLeadStateMachine } from '../src/ai/leadStateMachine.js';
import { emptyNeedState, mergeProductSelectionState } from '../src/ai/needState.js';
import { runPolicyGate, enforcePolicyGateBeforeAnswer } from '../src/ai/policyGate.js';
import { buildProductEvidenceRegistry } from '../src/ai/productEvidenceRegistry.js';
import { verifyPostAnswer } from '../src/ai/postAnswerVerifier.js';
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

  it('hard-blocks final answer generation when a V2 web-required fact has no successful required tool result', () => {
    const needState = emptyNeedState();
    const requirementLedger = buildRequirementLedger({ needState });
    const contractV2 = deriveAgentTurnContractV2({
      userMessage: 'Compare THD and current production status for this generator.',
      legacyContract: {
        ...baseAgentContract,
        answerTask: 'technical_explanation',
        taskType: 'technical_answer',
        catalogAction: 'none',
        productCardsPolicy: 'none',
        cardsRole: 'none'
      },
      plan: {
        ...basePlan,
        agentContractV2: {
          version: 2,
          intent: 'technical_answer',
          answerTask: 'technical_explanation',
          taskType: 'technical_answer',
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
            reason: 'Verify THD and current status.',
            required: true,
            inputHint: {}
          }],
          selectedProductIds: [],
          rejectedProductIds: [],
          mustAnswerNow: ['Answer only after web facts are verified.'],
          currentFocus: 'technical facts',
          errorRecoveryPriority: 'do not guess missing technical facts',
          confidence: 0.9,
          warnings: []
        }
      },
      needState,
      webRequired: true
    });
    const executionContract = buildExecutionContract({
      agentContract: {
        ...baseAgentContract,
        answerTask: 'technical_explanation',
        taskType: 'technical_answer',
        catalogAction: 'none',
        productCardsPolicy: 'none',
        cardsRole: 'none'
      },
      renderContract: resolveTurnContract({ plan: { ...basePlan, cardPolicy: 'textOnly' } }),
      selectionState: needState.selectionState,
      webRequired: true,
      activeRequirementIds: requirementLedger.activeRequirementIds
    });
    const registry = buildProductEvidenceRegistry({
      executionContract,
      cardManifest: buildCardManifest({ executionContract, cards: [], visibleProductIds: [], hiddenProductIds: [] }),
      cards: [],
      rejectedProducts: []
    });
    const factClaimPlanner = buildFactClaimPlanner({ executionContract, requirementLedger });
    const leadStateMachine = buildLeadStateMachine({
      executionContract,
      hasContactInTurn: false,
      leadRequested: false,
      leadCreated: false
    });
    const policyGate = runPolicyGate({
      contract: contractV2,
      requirementLedger,
      productEvidenceRegistry: registry,
      executionContract,
      factClaimPlanner,
      leadStateMachine,
      webSearchPlanned: false
    });
    const enforcement = enforcePolicyGateBeforeAnswer({
      policyGate,
      toolTrace: [{
        tool: 'webFactSearch',
        ok: false,
        risk: 'safe',
        reason: 'Verify THD and current status.',
        required: true,
        error: 'web_search_not_executed',
        warnings: ['web_search_not_executed']
      }]
    });

    expect(contractV2.sourcePolicy.required).toContain('web');
    expect(executionContract.factPolicy).toBe('web_required');
    expect(policyGate.blockedReasons).toContain('web_required_but_not_planned');
    expect(enforcement.mode).toBe('hard_block');
    expect(enforcement.hardBlockReasons).toContain('required_tool_failed:webFactSearch');
  });

  it('keeps product naming constrained by the evidence registry through post-answer verification', () => {
    const needState = emptyNeedState();
    const requirementLedger = buildRequirementLedger({ needState });
    const executionContract = buildExecutionContract({
      agentContract: baseAgentContract,
      renderContract: resolveTurnContract({ plan: basePlan }),
      selectionState: needState.selectionState,
      webRequired: false,
      activeRequirementIds: requirementLedger.activeRequirementIds
    });
    const cardManifest = buildCardManifest({
      executionContract,
      cards: [{
        id: 'allowed-card',
        name: 'TSS SGG 8000EH',
        brand: 'TSS',
        category: 'Generators',
        specs: {},
        reasons: [],
        caveats: []
      }],
      visibleProductIds: ['allowed-card'],
      hiddenProductIds: []
    });
    const registry = buildProductEvidenceRegistry({
      executionContract,
      cardManifest,
      cards: [{
        id: 'allowed-card',
        name: 'TSS SGG 8000EH',
        brand: 'TSS',
        category: 'Generators',
        specs: {},
        reasons: [],
        caveats: []
      }],
      rejectedProducts: [{
        productId: 'Rejected Diesel 15 kW',
        reason: 'wrong fuel'
      }]
    });
    const verification = verifyPostAnswer({
      answer: 'Лучше взять Rejected Diesel 15 kW.',
      factClaimPlanner: buildFactClaimPlanner({ executionContract, requirementLedger, cardManifest }),
      leadStateMachine: buildLeadStateMachine({
        executionContract,
        hasContactInTurn: false,
        leadRequested: false,
        leadCreated: false
      }),
      cardManifest,
      productEvidenceRegistry: registry
    });

    expect(registry.allowedProductIdsForText).toEqual(['allowed-card']);
    expect(verification.status).toBe('error');
    expect(verification.issues.map((issue) => issue.code)).toContain('disallowed_product_named_in_answer');
  });

  it('repairs no-valid-primary-card turns into safe text constraints instead of allowing invented product names', () => {
    const needState = emptyNeedState();
    const requirementLedger = buildRequirementLedger({ needState });
    const executionContract = buildExecutionContract({
      agentContract: baseAgentContract,
      renderContract: resolveTurnContract({ plan: basePlan }),
      selectionState: needState.selectionState,
      webRequired: false,
      activeRequirementIds: requirementLedger.activeRequirementIds
    });
    const cardManifest = buildCardManifest({
      executionContract,
      cards: [],
      visibleProductIds: [],
      hiddenProductIds: []
    });
    const registry = buildProductEvidenceRegistry({
      executionContract,
      cardManifest,
      cards: [],
      rejectedProducts: [{
        productId: 'Wrong Fuel 15 kW',
        reason: 'wrong fuel'
      }]
    });
    const factClaimPlanner = buildFactClaimPlanner({ executionContract, requirementLedger, cardManifest });
    const leadStateMachine = buildLeadStateMachine({
      executionContract,
      hasContactInTurn: false,
      leadRequested: false,
      leadCreated: false
    });
    const contractV2 = deriveAgentTurnContractV2({
      userMessage: 'Need gasoline 8 kW generator, only exact matches.',
      legacyContract: baseAgentContract,
      plan: basePlan,
      needState
    });
    const policyGate = runPolicyGate({
      contract: contractV2,
      requirementLedger,
      productEvidenceRegistry: registry,
      executionContract,
      factClaimPlanner,
      leadStateMachine,
      webSearchPlanned: false
    });
    const enforcement = enforcePolicyGateBeforeAnswer({ policyGate });
    const verification = verifyPostAnswer({
      answer: 'Wrong Fuel 15 kW подходит.',
      factClaimPlanner,
      leadStateMachine,
      cardManifest,
      productEvidenceRegistry: registry
    });

    expect(policyGate.blockedReasons).toContain('primary_cards_required_but_no_allowed_visible_cards');
    expect(enforcement.mode).toBe('repair');
    expect(enforcement.answerConstraints).toContain('do_not_name_concrete_products_without_allowed_product_evidence');
    expect(registry.allowedProductIdsForText).toEqual([]);
    expect(verification.status).toBe('error');
    expect(verification.issues.map((issue) => issue.code)).toContain('disallowed_product_named_in_answer');
  });

  it('routes commercial lead creation through a draft gate before commit', () => {
    const needState = emptyNeedState();
    const requirementLedger = buildRequirementLedger({ needState });
    const executionContract = buildExecutionContract({
      agentContract: {
        ...baseAgentContract,
        answerTask: 'lead_handoff',
        taskType: 'product_selection_with_delivery',
        catalogAction: 'find_matching_products',
        commercialAction: 'offer_contact_after_answer',
        productCardsPolicy: 'show_matching_products'
      },
      renderContract: resolveTurnContract({ plan: { ...basePlan, followUpPolicy: 'collectLead' } }),
      selectionState: needState.selectionState,
      webRequired: false,
      activeRequirementIds: requirementLedger.activeRequirementIds
    });
    const contractV2 = deriveAgentTurnContractV2({
      userMessage: 'Подберите генератор и оформите уточнение доставки. Александр +79990000000',
      legacyContract: {
        ...baseAgentContract,
        answerTask: 'lead_handoff',
        taskType: 'product_selection_with_delivery',
        catalogAction: 'find_matching_products',
        commercialAction: 'offer_contact_after_answer',
        productCardsPolicy: 'show_matching_products'
      },
      plan: { ...basePlan, selectedProductIds: ['tss-8'] },
      needState
    });
    const registry = buildProductEvidenceRegistry({
      executionContract,
      cardManifest: buildCardManifest({
        executionContract,
        cards: [{
          id: 'tss-8',
          name: 'TSS SGG 8000EH',
          brand: 'TSS',
          category: 'Generators',
          specs: {},
          reasons: [],
          caveats: []
        }],
        visibleProductIds: ['tss-8'],
        hiddenProductIds: []
      }),
      cards: [{
        id: 'tss-8',
        name: 'TSS SGG 8000EH',
        brand: 'TSS',
        category: 'Generators',
        specs: {},
        reasons: [],
        caveats: []
      }],
      rejectedProducts: []
    });
    const draft = buildLeadDraft({
      contract: contractV2,
      registry,
      buyerQuestion: 'Подберите генератор и оформите уточнение доставки. Александр +79990000000',
      contact: { name: 'Александр', phone: '+79990000000' }
    });

    expect(draft?.productIds).toEqual(['tss-8']);
    expect(shouldCommitLeadFromDraft({
      draft,
      leadRequested: true,
      executionLeadPolicy: executionContract.leadPolicy,
      contact: draft?.contact
    })).toBe(true);
    expect(shouldCommitLeadFromDraft({
      draft: null,
      leadRequested: true,
      executionLeadPolicy: executionContract.leadPolicy,
      contact: draft?.contact
    })).toBe(false);
  });

  it('keeps mixed product selection commercial verification as optional form handoff', () => {
    const needState = emptyNeedState();
    const mixedCommercialContract: AgentTurnContract = {
      ...baseAgentContract,
      answerTask: 'product_selection',
      taskType: 'product_selection_with_delivery',
      catalogAction: 'find_matching_products',
      commercialAction: 'explain_manager_required',
      productCardsPolicy: 'show_matching_products',
      cardsRole: 'primary',
      leadAllowed: true,
      leadAllowedReason: 'LLM requests form for delivery verification after showing cards'
    };
    const executionContract = buildExecutionContract({
      agentContract: mixedCommercialContract,
      renderContract: resolveTurnContract({ plan: { ...basePlan, followUpPolicy: 'collectLead' } }),
      selectionState: needState.selectionState,
      webRequired: false
    });
    const contractV2 = deriveAgentTurnContractV2({
      userMessage: 'Show 5 kW generators and check delivery to Krasnodar',
      legacyContract: mixedCommercialContract,
      plan: {
        ...basePlan,
        agentContractV2: {
          version: 2,
          intent: 'delivery_or_discount',
          answerTask: 'product_selection',
          taskType: 'product_selection_with_delivery',
          catalogAction: 'find_matching_products',
          commercialAction: 'explain_manager_required',
          productCardsPolicy: 'show_matching_products',
          cardsRole: 'primary',
          leadPolicy: 'optional_after_answer',
          sourcePolicy: {
            allowed: ['catalog', 'specialist', 'conversation_memory'],
            required: ['catalog', 'specialist'],
            forbidden: ['web'],
            webPurpose: 'none'
          },
          needDelta: {
            newRequirements: [],
            confirmedRequirements: [],
            changedRequirements: [],
            supersededRequirementIds: [],
            rejectedProductIds: []
          },
          missingFacts: ['delivery address'],
          toolPlan: [{ tool: 'createLeadDraft', reason: 'delivery requires logistics verification', required: true, inputHint: {} }],
          selectedProductIds: ['tss-8'],
          rejectedProductIds: [],
          mustAnswerNow: ['show cards and explain delivery verification'],
          currentFocus: 'generator_delivery',
          errorRecoveryPriority: 'answer selection and open form for delivery verification',
          confidence: 0.9,
          warnings: []
        }
      },
      needState,
      selectedProductIds: ['tss-8']
    });
    const registry = buildProductEvidenceRegistry({
      executionContract,
      cardManifest: buildCardManifest({
        executionContract,
        cards: [{
          id: 'tss-8',
          name: 'TSS SGG 8000EH',
          category: 'Generators',
          specs: {},
          reasons: [],
          caveats: []
        }],
        visibleProductIds: ['tss-8'],
        hiddenProductIds: []
      }),
      cards: [{
        id: 'tss-8',
        name: 'TSS SGG 8000EH',
        category: 'Generators',
        specs: {},
        reasons: [],
        caveats: []
      }],
      rejectedProducts: []
    });
    const draft = buildLeadDraft({
      contract: contractV2,
      registry,
      buyerQuestion: 'Show 5 kW generators and check delivery to Krasnodar'
    });

    expect(executionContract.leadPolicy).toBe('optional_after_answer');
    expect(contractV2.leadPolicy).toBe('optional_after_answer');
    expect(contractV2.toolPlan.map((step) => step.tool)).toContain('createLeadDraft');
    expect(draft?.reason).toBe('delivery');
    expect(shouldCommitLeadFromDraft({
      draft,
      leadRequested: true,
      executionLeadPolicy: executionContract.leadPolicy
    })).toBe(false);
  });
});
