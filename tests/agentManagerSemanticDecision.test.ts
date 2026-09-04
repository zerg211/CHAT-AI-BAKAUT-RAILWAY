import { describe, expect, it } from 'vitest';

import {
  validateAgentSemanticDecision,
  type AgentSemanticDecision
} from '../src/ai/agentManagerOrchestrator.js';
import type { ToolResult } from '../src/ai/agentManagerContracts.js';
import { reduceDialogueLedger } from '../src/ai/dialogueLedgerReducer.js';
import { buildRequirementProofs } from '../src/ai/requirementProofs.js';

const memorySessionId = '11111111-1111-4111-8111-111111111111';
const memoryTurnId = '22222222-2222-4222-8222-222222222222';

function selectionDecision() {
  const decision = generatorDecision();
  decision.ledgerDelta.events = decision.ledgerDelta.events.filter((event) => event.payload.factKey !== 'generator_load_scenario');
  decision.intent.toolRequests = decision.intent.toolRequests.filter((request) => request.tool === 'catalog.search');
  decision.intent.selectionPolicy!.requirements = decision.intent.selectionPolicy!.requirements.filter((requirement) => requirement.kind !== 'generator_load_scenario');
  decision.intent.grounding.requiredToolKinds = ['catalog.search'];
  return decision;
}

function validateMemoryDecision(decision: AgentSemanticDecision, previousLedgerState = reduceDialogueLedger([])) {
  return validateAgentSemanticDecision({ decision, previousLedgerState, sessionId: memorySessionId, turnId: memoryTurnId });
}

function continuingSelection() {
  const previousLedgerState = validateMemoryDecision(selectionDecision()).ledgerState;
  const decision = selectionDecision();
  decision.ledgerDelta.events = [];
  decision.intent.selectionPolicy!.needAction = 'continue';
  return { decision, previousLedgerState };
}

function generatorDecision(): AgentSemanticDecision {
  const loads = [
    { kind: 'compressor', name: 'compressor', runningKw: 2.2 },
    { kind: 'machine', name: 'machine', runningKw: 1.1 },
    { kind: 'lighting', name: 'lighting', runningKw: 0.3 },
    { kind: 'handheld_tool', name: 'angle grinder', runningKw: 1.5 }
  ].map((load) => ({
    ...load,
    count: 1,
    startingKw: load.runningKw,
    source: 'explicit_user' as const,
    runningSource: 'explicit_user' as const,
    startingSource: 'explicit_user' as const,
    operationMode: 'continuous' as const,
    coRunningGroup: 'workshop',
    evidence: `${load.name} runs simultaneously`,
    basisKind: 'exact_power' as const,
    basisSignals: ['explicit_power', 'simultaneous_operation_known'] as Array<
      'explicit_power' | 'simultaneous_operation_known'
    >
  }));
  return {
    ledgerDelta: {
      rationale: 'preserve the corrected workshop generator need',
      events: [{
        eventType: 'need.opened',
        scope: 'need',
        payload: {
          needId: 'generator-workshop',
          productClass: 'generator',
          summary: 'single-phase workshop generator',
          constraints: ['all declared loads run simultaneously'],
          constraintsUpdateMode: 'replace',
          openQuestions: [],
          openQuestionsUpdateMode: 'clear',
          selectedProductIds: [],
          rejectedProductIds: [],
          rejectedProductIdsUpdateMode: 'clear',
          selectionUpdateMode: 'clear',
          invalidatedProductIds: [],
          status: 'open',
          activate: true
        },
        evidence: 'All declared loads run simultaneously.',
        source: 'llm_state_delta',
        status: 'active'
      }, {
        eventType: 'fact.confirmed',
        scope: 'need',
        payload: {
          factKey: 'generator_load_scenario',
          value: {
            loads: loads.map((load) => ({ ...load, basisSignals: [...load.basisSignals] })),
            simultaneousRunning: true,
            simultaneousStarting: false
          },
          needId: 'generator-workshop',
          productClass: 'generator',
          role: 'hard_requirement',
          confidence: 1
        },
        evidence: 'The compressor, machine, lighting and angle grinder all run simultaneously.',
        source: 'llm_state_delta',
        status: 'active'
      }, {
        eventType: 'fact.confirmed',
        scope: 'need',
        payload: {
          factKey: 'budget_max_rub',
          value: 180000,
          needId: 'generator-workshop',
          productClass: 'generator',
          role: 'hard_requirement',
          confidence: 1
        },
        evidence: 'Budget is up to 180000 RUB.',
        source: 'llm_state_delta',
        status: 'active'
      }]
    },
    intent: {
      userMessageSummary: 'recalculate the generator for corrected simultaneous loads',
      dialogueUnderstanding: 'all four loads run together; only their starts are not declared simultaneous',
      nextStepRationale: 'calculate, then search the catalog',
      requiresTools: true,
      toolRequests: [{
        id: 'load-calculation',
        tool: 'calculator.generatorLoad',
        args: {
          loads: loads.map((load) => ({ ...load, basisSignals: [...load.basisSignals] })),
          simultaneousRunning: true,
          simultaneousStarting: false,
          simultaneousStartingKinds: [],
          estimateBasis: 'exact_or_user_provided'
        },
        rationale: 'calculate every declared simultaneous load',
        required: true,
        coversRequirementIds: ['load-scenario']
      }, {
        id: 'catalog-search',
        tool: 'catalog.search',
        args: {
          query: 'single-phase fuel generators for workshop load',
          productIntent: 'generator',
          canonicalProductIntent: 'generator',
          powerSource: 'fuel',
          phase: 'single_phase'
        },
        rationale: 'find catalog products after calculating the required load',
        required: true,
        coversRequirementIds: ['budget']
      }],
      productMentions: [],
      selectionPolicy: {
        targetProductClass: 'generator',
        canonicalProductClass: 'generator',
        selectionGoal: 'preliminary_fit',
        needAction: 'open',
        alternativePolicy: 'same_class_only',
        reusePreviousCards: false,
        maxCards: 6,
        powerSource: 'fuel',
        phase: 'single_phase',
        requirements: [{
          id: 'load-scenario',
          kind: 'generator_load_scenario',
          value: true,
          unit: null,
          relation: 'must_have',
          role: 'hard_constraint',
          strictness: 'strict',
          evidence: 'all declared loads run simultaneously',
          verification: {
            mode: 'typed_tool',
            toolRequestId: 'load-calculation',
            tool: 'calculator.generatorLoad',
            verifier: 'generator_load_profile',
            bindAs: 'nominal_power_min_kw'
          }
        }, {
          id: 'budget',
          kind: 'budget_max_rub',
          value: 180000,
          unit: 'RUB',
          relation: 'must_have',
          role: 'hard_constraint',
          strictness: 'strict',
          evidence: 'budget is up to 180000 RUB',
          verification: { mode: 'product_attribute' }
        }],
        rankingObjectives: [],
        rationale: 'use the corrected current-turn requirements'
      },
      leadCaptureAuthorization: {
        authorized: false,
        contactSource: 'none',
        handoffKind: 'none',
        handoffOfferMessageId: null,
        purpose: null,
        buyerQuestion: null,
        evidence: null,
        pendingDraftId: null
      },
      policyRuleIds: [],
      grounding: {
        taskType: 'product_selection',
        buyerRequestedWeb: false,
        catalogRequirement: 'required',
        responseMode: 'recommend',
        sourcePolicy: 'catalog_required',
        webPurpose: 'none',
        webRequirement: 'none',
        requiredToolKinds: ['calculator.generatorLoad', 'catalog.search'],
        technicalAttributes: [],
        buyerQuestion: 'Recalculate and show options.',
        rationale: 'calculation and catalog evidence are required'
      },
      mustNotAskQuestionIds: [],
      riskFlags: []
    }
  };
}

describe('combined semantic decision validation', () => {
  it.each(['missing', 'wrong_value', 'wrong_unit'] as const)('rejects an old active hard requirement with $0 on a later turn', (change) => {
    const { decision, previousLedgerState } = continuingSelection();
    const oldBudget = Object.values(previousLedgerState.factsByKey).find((fact) => fact.factKey === 'budget_max_rub')!;
    Object.assign(oldBudget, { unit: 'RUB', relation: 'must_have' });
    const requirement = decision.intent.selectionPolicy!.requirements[0]!;
    if (change === 'missing') decision.intent.selectionPolicy!.requirements = [];
    if (change === 'wrong_value') requirement.value = 200000;
    if (change === 'wrong_unit') requirement.unit = 'USD';
    expect(validateMemoryDecision(decision, previousLedgerState).issues).toContain('active_requirement_mismatch:budget_max_rub');
  });

  it('keeps all scoped hard kinds on card reuse and does not enforce observations as confirmed requirements', () => {
    const { decision, previousLedgerState } = continuingSelection();
    const state = reduceDialogueLedger([{
      sessionId: memorySessionId, turnId: memoryTurnId, eventId: 'old-weight', eventType: 'fact.confirmed',
      scope: 'need', payload: { needId: 'generator-workshop', factKey: 'weight_max_kg', value: 60, unit: 'kg', role: 'hard_requirement' },
      evidence: 'At most 60 kg', source: 'llm_state_delta', status: 'active'
    }, {
      sessionId: memorySessionId, turnId: memoryTurnId, eventId: 'observed-noise', eventType: 'fact.observed',
      scope: 'need', payload: { needId: 'generator-workshop', factKey: 'noise_level_max_db', value: 65, role: 'hard_requirement' },
      evidence: 'An unconfirmed preference', source: 'llm_state_delta', status: 'active'
    }], previousLedgerState);
    decision.intent.selectionPolicy!.reusePreviousCards = true;
    const issues = validateMemoryDecision(decision, state).issues;
    expect(issues).toContain('active_requirement_mismatch:weight_max_kg');
    expect(issues).not.toContain('active_requirement_mismatch:noise_level_max_db');
  });

  it('does not treat a generic fuel power source as the persisted diesel requirement', () => {
    const { decision, previousLedgerState } = continuingSelection();
    const state = reduceDialogueLedger([{
      sessionId: memorySessionId, turnId: memoryTurnId, eventId: 'diesel', eventType: 'fact.confirmed',
      scope: 'need', payload: { needId: 'generator-workshop', factKey: 'fuel_type', value: 'diesel', role: 'hard_requirement' },
      evidence: 'Diesel only', source: 'llm_state_delta', status: 'active'
    }], previousLedgerState);
    expect(validateMemoryDecision(decision, state).issues).toContain('active_requirement_mismatch:fuel_type');
  });

  it.each(['generator', 'plate'] as const)('switches to a separate %s need without leaking local facts and restores them on resume', (productClass) => {
    const { decision, previousLedgerState } = continuingSelection();
    decision.ledgerDelta.events = [{
      eventType: 'need.opened', scope: 'need', payload: { needId: 'other', productClass, activate: true },
      evidence: 'A separate purchase', source: 'llm_state_delta', status: 'active'
    }];
    Object.assign(decision.intent.selectionPolicy!, {
      targetProductClass: productClass, canonicalProductClass: productClass, needAction: 'switch', requirements: []
    });
    Object.assign(decision.intent.toolRequests[0]!.args, { productIntent: productClass, canonicalProductIntent: productClass });
    const switched = validateMemoryDecision(decision, previousLedgerState);
    expect(switched.issues).not.toContain('active_requirement_mismatch:budget_max_rub');
    decision.ledgerDelta.events = [{
      eventType: 'need.updated', scope: 'need', payload: { needId: 'generator-workshop', activate: true },
      evidence: 'Back to the workshop', source: 'llm_state_delta', status: 'active'
    }];
    Object.assign(decision.intent.selectionPolicy!, { targetProductClass: 'generator', canonicalProductClass: 'generator', needAction: 'resume' });
    Object.assign(decision.intent.toolRequests[0]!.args, { productIntent: 'generator', canonicalProductIntent: 'generator' });
    expect(validateMemoryDecision(decision, switched.ledgerState).issues).toContain('active_requirement_mismatch:budget_max_rub');
  });

  it('carries only explicitly dialogue-wide constraints across a need switch with the original value', () => {
    const { decision, previousLedgerState } = continuingSelection();
    const state = reduceDialogueLedger([{
      sessionId: memorySessionId, turnId: memoryTurnId, eventId: 'global-weight', eventType: 'fact.confirmed',
      scope: 'dialogue', payload: { factKey: 'weight_max_kg', value: 60, unit: 'kg', role: 'hard_requirement' },
      evidence: 'I lift every purchase myself', source: 'llm_state_delta', status: 'active'
    }], previousLedgerState);
    decision.ledgerDelta.events = [{
      eventType: 'need.opened', scope: 'need', payload: { needId: 'other', productClass: 'generator', activate: true },
      evidence: 'Another generator', source: 'llm_state_delta', status: 'active'
    }];
    decision.intent.selectionPolicy!.needAction = 'switch';
    decision.intent.selectionPolicy!.requirements = [{
      id: 'weight', kind: 'weight_max_kg', value: 90, unit: 'kg', relation: 'must_have',
      role: 'hard_constraint', strictness: 'strict', evidence: 'weight', verification: { mode: 'product_attribute' }
    }];
    expect(validateMemoryDecision(decision, state).issues).toContain('active_requirement_mismatch:weight_max_kg');
    decision.intent.selectionPolicy!.requirements[0]!.value = 60;
    expect(validateMemoryDecision(decision, state).issues.filter((issue) => issue.startsWith('active_requirement_mismatch'))).toEqual([]);
  });

  it('accepts an explicit replacement and cancellation without keeping the superseded restriction', () => {
    const { decision, previousLedgerState } = continuingSelection();
    const budget = Object.values(previousLedgerState.factsByKey).find((fact) => fact.factKey === 'budget_max_rub')!;
    decision.ledgerDelta.events = [{
      eventType: 'fact.confirmed', scope: 'need', payload: {
        needId: 'generator-workshop', factKey: 'budget_max_rub', value: 200000,
        role: 'hard_requirement', supersedesEventIds: [budget.eventId]
      }, evidence: 'New budget 200000', source: 'llm_state_delta', status: 'active'
    }];
    decision.intent.selectionPolicy!.requirements[0]!.value = 200000;
    const replaced = validateMemoryDecision(decision, previousLedgerState);
    expect(replaced.issues).toEqual([]);
    const currentBudget = Object.values(replaced.ledgerState.factsByKey).find((fact) => fact.factKey === 'budget_max_rub')!;
    decision.ledgerDelta.events = [{
      eventType: 'fact.negated', scope: 'need', payload: { targetEventIds: [currentBudget.eventId] },
      evidence: 'No fixed budget now', source: 'llm_state_delta', status: 'active'
    }];
    decision.intent.selectionPolicy!.requirements = [];
    decision.intent.toolRequests[0]!.coversRequirementIds = [];
    expect(validateMemoryDecision(decision, replaced.ledgerState).issues).toEqual([]);
  });

  it('distinguishes a forbidden feature from a cancelled requirement and excludes product facts', () => {
    const { decision, previousLedgerState } = continuingSelection();
    const state = reduceDialogueLedger([{
      sessionId: memorySessionId, turnId: memoryTurnId, eventId: 'no-auto-start', eventType: 'fact.confirmed',
      scope: 'need', payload: { needId: 'generator-workshop', factKey: 'auto_start_required', value: true, relation: 'must_not_have', role: 'hard_requirement' },
      evidence: 'Without automatic start', source: 'llm_state_delta', status: 'active'
    }, {
      sessionId: memorySessionId, turnId: memoryTurnId, eventId: 'product-weight', eventType: 'fact.confirmed',
      scope: 'product', payload: { needId: 'generator-workshop', productId: 'model-a', factKey: 'weight_max_kg', value: 80, role: 'hard_requirement' },
      evidence: 'The model weighs 80 kg', source: 'catalog', status: 'active'
    }], previousLedgerState);
    decision.intent.selectionPolicy!.requirements.push({
      id: 'auto-start', kind: 'auto_start_required', value: true, unit: null, relation: 'not_required',
      role: 'hard_constraint', strictness: 'strict', evidence: 'feature', verification: { mode: 'product_attribute' }
    });
    expect(validateMemoryDecision(decision, state).issues).toContain('active_requirement_mismatch:auto_start_required');
    decision.intent.selectionPolicy!.requirements.at(-1)!.relation = 'must_not_have';
    expect(validateMemoryDecision(decision, state).issues.filter((issue) => issue.startsWith('active_requirement_mismatch'))).toEqual([]);
    decision.ledgerDelta.events = [{
      eventType: 'fact.negated', scope: 'need', payload: { targetEventIds: ['no-auto-start'] },
      evidence: 'Automatic start no longer matters', source: 'llm_state_delta', status: 'active'
    }];
    Object.assign(decision.intent.selectionPolicy!.requirements.at(-1)!, { relation: 'not_required', role: 'preference', strictness: 'preferred' });
    expect(validateMemoryDecision(decision, state).issues).toEqual([]);
  });

  it('does not require catalog execution for a pure clarification carrying old constraints', () => {
    const { decision, previousLedgerState } = continuingSelection();
    decision.intent.toolRequests = [];
    decision.intent.requiresTools = false;
    decision.intent.selectionPolicy!.requirements = [];
    Object.assign(decision.intent.grounding, { taskType: 'technical_answer', responseMode: 'clarify', sourcePolicy: 'conversation_only', catalogRequirement: 'none', requiredToolKinds: [] });
    expect(validateMemoryDecision(decision, previousLedgerState).issues.filter((issue) => issue.startsWith('active_requirement_mismatch'))).toEqual([]);
  });

  it('rejects invalid numeric strict requirement shapes before tools run', () => {
    const decision = generatorDecision();
    const budget = decision.intent.selectionPolicy?.requirements.find((requirement) => requirement.id === 'budget');
    if (!budget) throw new Error('budget requirement missing');
    budget.value = true;

    const result = validateAgentSemanticDecision({
      decision,
      previousLedgerState: reduceDialogueLedger([]),
      sessionId: '11111111-1111-4111-8111-111111111111',
      turnId: '22222222-2222-4222-8222-222222222222',
      userMessage: 'Budget is up to 180000 RUB.'
    });

    expect(result.issues).toContain('strict_requirement_shape_invalid:budget:invalid_numeric_value');
  });

  it('rejects a calculator plan that drops a load from the semantic scenario', () => {
    const decision = generatorDecision();
    const calculation = decision.intent.toolRequests.find((request) => request.tool === 'calculator.generatorLoad');
    if (!calculation) throw new Error('calculation request missing');
    calculation.args.loads = calculation.args.loads?.filter((load) => load.name !== 'angle grinder');

    const result = validateAgentSemanticDecision({
      decision,
      previousLedgerState: reduceDialogueLedger([]),
      sessionId: '11111111-1111-4111-8111-111111111111',
      turnId: '22222222-2222-4222-8222-222222222222',
      userMessage: 'Одновременно работают компрессор 2,2 кВт, станок 1,1 кВт, свет 300 Вт и болгарка 1,5 кВт.'
    });

    expect(result.issues).toContain('generator_load_scenario_missing_load:handheld_tool:angle grinder');
  });

  it('uses an unambiguous catalog product identity as fuel-type proof', () => {
    const product = {
      id: 'gasoline-generator',
      name: 'Генератор бензиновый TEST 8000',
      category: 'Бензиновые генераторы',
      price: 100000,
      currency: 'RUB',
      specs: {
        'вид топлива': 'бензиновые',
        'расход топлива, л/ч': '1',
        'емкость топливного бака, л': '26'
      }
    };
    const intent = generatorDecision().intent;
    intent.selectionPolicy = {
      ...intent.selectionPolicy!,
      requirements: [{
        id: 'fuel', kind: 'fuel_type', value: 'gasoline', unit: null, relation: 'must_have',
        role: 'hard_constraint', strictness: 'strict', evidence: 'бензиновый',
        verification: { mode: 'product_attribute' }
      }]
    };
    intent.toolRequests = [{
      id: 'catalog', tool: 'catalog.search', required: true, rationale: 'find gasoline generators',
      coversRequirementIds: ['fuel'], args: { productIntent: 'generator' }
    }];
    const toolResults: ToolResult[] = [{
      requestId: 'catalog', tool: 'catalog.search', status: 'ok', observationStatus: 'success',
      payload: { products: [product], productIds: [product.id] }, warnings: []
    }];

    expect(buildRequirementProofs({ intent, products: [product], toolResults })).toContainEqual(
      expect.objectContaining({
        requirementId: 'fuel',
        productId: product.id,
        status: 'satisfied',
        normalizedValue: 'gasoline',
        sourceAuthority: 'catalog'
      })
    );
  });

  it('accepts one coherent post-delta decision with every simultaneous consumer', () => {
    const result = validateAgentSemanticDecision({
      decision: generatorDecision(),
      previousLedgerState: reduceDialogueLedger([]),
      sessionId: '11111111-1111-4111-8111-111111111111',
      turnId: '22222222-2222-4222-8222-222222222222'
    });

    expect(result.issues).toEqual([]);
    expect(result.ledgerState.needsById['generator-workshop']?.productClass).toBe('generator');
  });

  it('rejects a calculator plan that drops a load from the same semantic decision', () => {
    const decision = generatorDecision();
    const request = decision.intent.toolRequests[0]!;
    const args = request.args as typeof request.args & { loads?: unknown[] };
    args.loads = args.loads?.filter((load: unknown) =>
      (load as { kind?: string }).kind !== 'handheld_tool'
    );

    const result = validateAgentSemanticDecision({
      decision,
      previousLedgerState: reduceDialogueLedger([]),
      sessionId: '11111111-1111-4111-8111-111111111111',
      turnId: '22222222-2222-4222-8222-222222222222'
    });

    expect(result.issues).toContain('generator_load_scenario_missing_load:handheld_tool:angle grinder');
  });

  it('rejects a calculator plan that stages loads declared as simultaneously running', () => {
    const decision = generatorDecision();
    const request = decision.intent.toolRequests.find((item) => item.tool === 'calculator.generatorLoad')!;
    request.args.simultaneousRunning = false;

    const result = validateAgentSemanticDecision({
      decision,
      previousLedgerState: reduceDialogueLedger([]),
      sessionId: '11111111-1111-4111-8111-111111111111',
      turnId: '22222222-2222-4222-8222-222222222222'
    });

    expect(result.issues).toContain('generator_load_scenario_simultaneous_running_mismatch');
  });

  it('reports the exact generator load semantic fields that differ', () => {
    const decision = generatorDecision();
    const request = decision.intent.toolRequests.find((item) => item.tool === 'calculator.generatorLoad')!;
    const compressor = request.args.loads?.find((load: unknown) =>
      (load as { kind?: string }).kind === 'compressor'
    ) as Record<string, unknown>;
    compressor.operationMode = 'separate';
    compressor.coRunningGroup = 'separate-load';

    const result = validateAgentSemanticDecision({
      decision,
      previousLedgerState: reduceDialogueLedger([]),
      sessionId: '11111111-1111-4111-8111-111111111111',
      turnId: '22222222-2222-4222-8222-222222222222'
    });

    expect(result.issues).toContain(
      'generator_load_scenario_load_semantics_mismatch:compressor:compressor:operationMode|coRunningGroup'
    );
  });

  it('rejects a calculator plan that replaces a declared load with a product class', () => {
    const decision = generatorDecision();
    const request = decision.intent.toolRequests.find((item) => item.tool === 'calculator.generatorLoad')!;
    const grinder = request.args.loads?.find((load: unknown) => (load as { name?: string }).name === 'angle grinder') as Record<string, unknown>;
    grinder.kind = 'generator';
    grinder.name = 'generator';

    const result = validateAgentSemanticDecision({
      decision,
      previousLedgerState: reduceDialogueLedger([]),
      sessionId: '11111111-1111-4111-8111-111111111111',
      turnId: '22222222-2222-4222-8222-222222222222',
      userMessage: 'All loads run simultaneously.'
    });

    expect(result.issues).toContain('generator_load_scenario_missing_load:handheld_tool:angle grinder');
  });

  it('rejects an unknown load kind instead of inferring its meaning from the name', () => {
    const decision = generatorDecision();
    const request = decision.intent.toolRequests.find((item) => item.tool === 'calculator.generatorLoad')!;
    const machine = request.args.loads?.find((load: unknown) => (load as { name?: string }).name === 'machine') as Record<string, unknown>;
    machine.kind = 'unknown_load';
    const scenarioEvent = decision.ledgerDelta.events.find((event) => event.payload.factKey === 'generator_load_scenario')!;
    const scenarioValue = scenarioEvent.payload.value as { loads: Array<Record<string, unknown>> };
    scenarioValue.loads.find((load) => load.name === 'machine')!.kind = 'unknown_load';

    const result = validateAgentSemanticDecision({
      decision,
      previousLedgerState: reduceDialogueLedger([]),
      sessionId: '11111111-1111-4111-8111-111111111111',
      turnId: '22222222-2222-4222-8222-222222222222',
      userMessage: 'The machine is explicitly rated at 1.1 kW.'
    });

    expect(result.issues).toContain('generator_load_scenario_unexecutable_load:unknown_load:machine');
  });

  it('rejects calculator execution without a persisted structured load scenario', () => {
    const decision = generatorDecision();
    decision.ledgerDelta.events = decision.ledgerDelta.events.filter((event) =>
      event.payload.factKey !== 'generator_load_scenario'
    );

    const result = validateAgentSemanticDecision({
      decision,
      previousLedgerState: reduceDialogueLedger([]),
      sessionId: '11111111-1111-4111-8111-111111111111',
      turnId: '22222222-2222-4222-8222-222222222222'
    });

    expect(result.issues).toContain('generator_load_scenario_fact_missing');
  });

  it('rejects a stale hard requirement value in the execution intent', () => {
    const decision = generatorDecision();
    decision.intent.selectionPolicy!.requirements.find((item) => item.kind === 'budget_max_rub')!.value = 120000;

    const result = validateAgentSemanticDecision({
      decision,
      previousLedgerState: reduceDialogueLedger([]),
      sessionId: '11111111-1111-4111-8111-111111111111',
      turnId: '22222222-2222-4222-8222-222222222222'
    });

    expect(result.issues).toContain('active_requirement_mismatch:budget_max_rub');
  });

  it.each([
    { factVoltage: 220, requirementVoltage: 230 },
    { factVoltage: 230, requirementVoltage: 220 },
    { factVoltage: 380, requirementVoltage: 400 },
    { factVoltage: 400, requirementVoltage: 380 }
  ])('accepts equivalent $factVoltage V and $requirementVoltage V requirement representations', ({
    factVoltage,
    requirementVoltage
  }) => {
    const decision = generatorDecision();
    decision.ledgerDelta.events.push({
      eventType: 'fact.confirmed',
      scope: 'need',
      payload: {
        factKey: 'voltage_v',
        value: factVoltage,
        needId: 'generator-workshop',
        productClass: 'generator',
        role: 'hard_requirement',
        confidence: 1
      },
      evidence: `The supply is ${factVoltage} V.`,
      source: 'llm_state_delta',
      status: 'active'
    });
    decision.intent.selectionPolicy!.requirements.push({
      id: 'voltage',
      kind: 'voltage_v',
      value: requirementVoltage,
      unit: 'V',
      relation: 'must_have',
      role: 'hard_constraint',
      strictness: 'strict',
      evidence: `${requirementVoltage} V supply`,
      verification: { mode: 'product_attribute' }
    });

    const result = validateAgentSemanticDecision({
      decision,
      previousLedgerState: reduceDialogueLedger([]),
      sessionId: '11111111-1111-4111-8111-111111111111',
      turnId: '22222222-2222-4222-8222-222222222222'
    });

    expect(result.issues).not.toContain('active_requirement_mismatch:voltage_v');
  });

  it('keeps incompatible single-phase and three-phase voltage requirements distinct', () => {
    const decision = generatorDecision();
    decision.ledgerDelta.events.push({
      eventType: 'fact.confirmed',
      scope: 'need',
      payload: {
        factKey: 'voltage_v',
        value: 220,
        needId: 'generator-workshop',
        productClass: 'generator',
        role: 'hard_requirement',
        confidence: 1
      },
      evidence: 'The supply is 220 V.',
      source: 'llm_state_delta',
      status: 'active'
    });
    decision.intent.selectionPolicy!.requirements.push({
      id: 'voltage',
      kind: 'voltage_v',
      value: 400,
      unit: 'V',
      relation: 'must_have',
      role: 'hard_constraint',
      strictness: 'strict',
      evidence: '400 V supply',
      verification: { mode: 'product_attribute' }
    });

    const result = validateAgentSemanticDecision({
      decision,
      previousLedgerState: reduceDialogueLedger([]),
      sessionId: '11111111-1111-4111-8111-111111111111',
      turnId: '22222222-2222-4222-8222-222222222222'
    });

    expect(result.issues).toContain('active_requirement_mismatch:voltage_v');
  });

});
