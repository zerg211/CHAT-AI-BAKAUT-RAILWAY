import { describe, expect, it } from 'vitest';

import {
  humanizeTerminalVerificationLabel,
  terminalCatalogRecovery,
  terminalGeneratorCalculationFromIntent,
  terminalGeneratorCalculationRecovery,
  terminalOpenQuestionRecovery,
  validateAgentSemanticDecision,
  type AgentSemanticDecision
} from '../src/ai/agentManagerOrchestrator.js';
import { normalizeLedgerStateDeltaEvents } from '../src/ai/agentManagerContracts.js';
import { reduceDialogueLedger } from '../src/ai/dialogueLedgerReducer.js';

function generatorDecision(): AgentSemanticDecision {
  const loads = [
    { kind: 'compressor', name: 'compressor', runningKw: 2.2 },
    { kind: 'machine', name: 'machine', runningKw: 1.1 },
    { kind: 'lighting', name: 'lighting', runningKw: 0.3 },
    { kind: 'handheld_tool', name: 'angle grinder', runningKw: 1.5 }
  ];
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
            loads,
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
          loads: loads.map((load) => ({
            ...load,
            count: 1,
            startingKw: load.runningKw,
            source: 'explicit_user',
            evidence: `${load.name} runs simultaneously`,
            basisKind: 'exact_power',
            basisSignals: ['explicit_power', 'simultaneous_operation_known']
          })),
          simultaneousStarting: false,
          simultaneousStartingKinds: [],
          estimateBasis: 'exact_or_user_provided'
        },
        rationale: 'calculate every declared simultaneous load',
        required: true,
        coversRequirementIds: ['load-scenario']
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
        requiredToolKinds: ['calculator.generatorLoad'],
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
  it('does not expose internal verification keys to the buyer', () => {
    expect(humanizeTerminalVerificationLabel('nominal_power_kw')).toBe('номинальная мощность');
    expect(humanizeTerminalVerificationLabel('auto_start_required')).toBe('электростартер');
    expect(humanizeTerminalVerificationLabel('starting power kw')).toBe('пусковая мощность');
    expect(humanizeTerminalVerificationLabel('electric starter')).toBe('электростартер');
    expect(humanizeTerminalVerificationLabel('Starting power, kW')).toBe('пусковая мощность');
  });

  it('rejects a ledger and plan that both forgot an explicit power fact', () => {
    const decision = generatorDecision();
    const scenarioEvent = decision.ledgerDelta.events.find((event) =>
      event.eventType === 'fact.confirmed' && event.payload.factKey === 'generator_load_scenario'
    );
    if (!scenarioEvent || !('value' in scenarioEvent.payload)) throw new Error('scenario event missing');
    const scenario = scenarioEvent.payload.value as { loads: Array<{ name: string }> };
    scenario.loads = scenario.loads.filter((load) => load.name !== 'angle grinder');
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

    expect(result.issues).toContain('explicit_power_fact_missing:1.5kw');
  });

  it('does not recover stale cards when a required current-turn calculation is missing', () => {
    const decision = generatorDecision();
    const staleProduct = {
      id: 'stale-generator',
      name: 'Старый генератор 8 кВт',
      category: 'Бензиновые генераторы',
      price: 99_990,
      currency: 'RUB',
      specs: { nominal_power_kw: 8 }
    };
    expect(terminalCatalogRecovery({
      intent: decision.intent,
      toolResults: [],
      previousProductReferents: [staleProduct]
    })).toMatchObject({
      products: [],
      cards: [],
      warnings: ['terminal_catalog_recovery_required_tool_missing:calculator.generatorLoad']
    });
  });

  it('executes the persisted deterministic generator calculation at the terminal boundary', () => {
    const result = terminalGeneratorCalculationFromIntent(generatorDecision().intent, '');

    expect(result).toMatchObject({
      requestId: 'load-calculation',
      tool: 'calculator.generatorLoad',
      status: 'ok',
      warnings: expect.arrayContaining(['terminal_deterministic_generator_calculation']),
      payload: {
        loads: expect.arrayContaining([
          expect.objectContaining({ name: 'compressor', runningKw: 2.2 }),
          expect.objectContaining({ name: 'angle grinder', runningKw: 1.5 })
        ]),
        profile: expect.objectContaining({ requiredNominalKw: expect.any(Number) })
      }
    });
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

  it('preserves a successful generator calculation for terminal recovery', () => {
    expect(terminalGeneratorCalculationRecovery([{
      requestId: 'load-calculation',
      tool: 'calculator.generatorLoad',
      status: 'ok',
      observationStatus: 'success',
      payload: {
        loads: [{ kind: 'compressor' }, { kind: 'handheld_tool' }],
        profile: {
          totalRunningKw: 5.1,
          requiredStartingKw: 10.7,
          requiredNominalKw: 11
        }
      },
      warnings: []
    }])).toEqual({
      requestId: 'load-calculation',
      loadCount: 2,
      totalRunningKw: 5.1,
      requiredStartingKw: 10.7,
      requiredNominalKw: 11
    });
  });

  it('preserves the authoritative open question for terminal recovery', () => {
    const decision = generatorDecision();
    decision.ledgerDelta.events.push({
      eventType: 'question.asked',
      scope: 'question',
      payload: {
        questionId: 'generator-loads',
        text: 'Какие приборы будут работать одновременно?',
        needId: 'generator-workshop'
      },
      evidence: 'Generator power is unknown until the simultaneous loads are named.',
      source: 'llm_state_delta',
      status: 'active'
    });
    const events = normalizeLedgerStateDeltaEvents({
      sessionId: '11111111-1111-4111-8111-111111111111',
      turnId: '22222222-2222-4222-8222-222222222222',
      delta: decision.ledgerDelta
    });

    expect(terminalOpenQuestionRecovery(reduceDialogueLedger(events))).toMatchObject({
      questionId: 'generator-loads',
      text: 'Какие приборы будут работать одновременно?',
      productClass: 'generator'
    });
  });
});
