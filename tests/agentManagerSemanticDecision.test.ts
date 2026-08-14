import { describe, expect, it } from 'vitest';

import {
  humanizeTerminalVerificationLabel,
  enforceReviewerPreliminaryCandidateRecovery,
  filterProductsByStructuredSelectionPolicy,
  limitTerminalRecoveryProducts,
  terminalCatalogRecovery,
  terminalGeneratorCalculationFromIntent,
  terminalGeneratorCalculationRecovery,
  terminalOpenQuestionRecovery,
  validateAgentSemanticDecision,
  type AgentSemanticDecision
} from '../src/ai/agentManagerOrchestrator.js';
import { normalizeLedgerStateDeltaEvents } from '../src/ai/agentManagerContracts.js';
import type { ToolResult } from '../src/ai/agentManagerContracts.js';
import { reduceDialogueLedger } from '../src/ai/dialogueLedgerReducer.js';
import { buildRequirementProofs } from '../src/ai/requirementProofs.js';

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
          simultaneousRunning: true,
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
    expect(humanizeTerminalVerificationLabel('starting system')).toBe('электростартер');
    expect(humanizeTerminalVerificationLabel('Starting power, kW')).toBe('пусковая мощность');
    expect(humanizeTerminalVerificationLabel('max_power_kw')).toBe('максимальная мощность');
    expect(humanizeTerminalVerificationLabel('Max power kW')).toBe('максимальная мощность');
    expect(humanizeTerminalVerificationLabel('current buyer question')).toBe('применимость к текущей задаче');
    expect(humanizeTerminalVerificationLabel('travel type')).toBe('тип хода');
  });

  it('respects the semantic card limit during terminal catalog recovery', () => {
    const products = ['one', 'two', 'three'].map((id, index) => ({
      id,
      name: `Generator ${id}`,
      category: 'Generators',
      price: 50_000 + index * 1_000,
      currency: 'RUB',
      specs: {}
    }));

    expect(limitTerminalRecoveryProducts(products, 2)).toHaveLength(2);
    expect(limitTerminalRecoveryProducts(products, null)).toHaveLength(3);
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

  it('does not call catalog-proven candidate attributes unfinished web verification', () => {
    const product = {
      id: 'plate-80',
      name: 'Виброплита прямоходная бензиновая TEST (80 кг)',
      category: 'Виброплиты',
      price: 100000,
      currency: 'RUB',
      specs: { weight_kg: 80, fuel_type: 'petrol' }
    };
    const intent = generatorDecision().intent;
    intent.grounding = {
      taskType: 'product_selection',
      buyerRequestedWeb: false,
      catalogRequirement: 'required',
      responseMode: 'recommend',
      sourcePolicy: 'catalog_required',
      webPurpose: 'technical_specs',
      webRequirement: 'conditional_on_catalog_gap',
      requiredToolKinds: ['catalog.search'],
      technicalAttributes: ['weight_kg', 'price_rub'],
      buyerQuestion: 'Select a plate.',
      rationale: 'Use catalog attributes first.'
    };
    intent.selectionPolicy = {
      ...intent.selectionPolicy!,
      targetProductClass: 'plate',
      canonicalProductClass: 'plate',
      requirements: [{
        id: 'weight', kind: 'weight_max_kg', value: 90, unit: 'kg', relation: 'must_have',
        role: 'hard_constraint', strictness: 'strict', evidence: 'up to 90 kg', verification: { mode: 'product_attribute' }
      }, {
        id: 'budget', kind: 'budget_max_rub', value: 170000, unit: 'RUB', relation: 'must_have',
        role: 'hard_constraint', strictness: 'strict', evidence: 'up to 170000 RUB', verification: { mode: 'product_attribute' }
      }]
    };
    intent.toolRequests = [{
      id: 'catalog', tool: 'catalog.search', required: true, rationale: 'find plates',
      coversRequirementIds: ['weight', 'budget'], args: { productIntent: 'plate' }
    }, {
      id: 'web', tool: 'web.researchProductFacts', required: true, rationale: 'conditional verification',
      coversRequirementIds: ['weight', 'budget'], args: {
        comparisonAttributes: ['weight_kg', 'price_rub'],
        comparisonAttributeBindings: [
          { attribute: 'weight_kg', requirementId: 'weight' },
          { attribute: 'price_rub', requirementId: 'budget' }
        ]
      }
    }];
    const toolResults: ToolResult[] = [{
      requestId: 'catalog', tool: 'catalog.search', status: 'ok', observationStatus: 'success',
      payload: { products: [product], productIds: [product.id] }, warnings: []
    }, {
      requestId: 'web', tool: 'web.researchProductFacts', status: 'error', observationStatus: 'malformed',
      payload: { error: { code: 'web_research_skipped_budget' } }, warnings: []
    }];

    expect(terminalCatalogRecovery({ intent, toolResults: [...toolResults] })).toMatchObject({
      products: [product],
      unfinishedVerification: []
    });
  });

  it('enforces a reviewer finding when a rewrite still hides eligible preliminary candidates', () => {
    const product = {
      id: 'generator-8kw', name: 'Energo E11000EAX (8.0 kW)', category: 'Бензиновые генераторы',
      price: 110000, currency: 'RUB', specs: { voltage_v: 220, fuel_type: 'бензин', electric_start: true }
    };
    const intent = generatorDecision().intent;
    intent.selectionPolicy = {
      ...intent.selectionPolicy!,
      requirements: [],
      selectionGoal: 'preliminary_fit',
      maxCards: 2
    };
    intent.toolRequests = [{
      id: 'catalog', tool: 'catalog.search', required: true, rationale: 'find candidates', args: {}
    }, {
      id: 'web', tool: 'web.researchProductFacts', required: true, rationale: 'verify noise',
      args: { comparisonAttributes: ['noise_db'] }
    }];
    const toolResults: ToolResult[] = [{
      requestId: 'catalog', tool: 'catalog.search', status: 'ok', observationStatus: 'success',
      payload: { products: [product], productIds: [product.id] }, warnings: []
    }, {
      requestId: 'web', tool: 'web.researchProductFacts', status: 'error', observationStatus: 'malformed',
      payload: { error: { code: 'web_research_skipped_budget' } }, warnings: []
    }];
    const answer = {
      answerText: 'No model can be named.', factsUsed: [], questionsAsked: [], toolResultIds: ['catalog', 'web'],
      selectedProductIds: [], leadAction: 'none' as const, riskFlags: [],
      selectionReadiness: {
        productClass: 'generator', status: 'needs_more_info' as const, canShowProductCards: false,
        missingFacts: ['noise_db'], rationale: 'noise is not confirmed'
      }
    };
    const recovered = enforceReviewerPreliminaryCandidateRecovery({
      review: {
        verdict: 'rewrite_required',
        revisedAnswerText: 'Still no model.',
        issues: [{ code: 'hide_preliminary_candidates', severity: 'high', message: 'hidden', evidence: product.name }]
      },
      answer,
      intent,
      toolResults
    });

    expect(recovered).toMatchObject({
      selectedProductIds: [product.id],
      selectionReadiness: { canShowProductCards: true, missingFacts: ['официальный уровень шума в дБ'] }
    });
    expect(recovered?.answerText).toContain(product.name);
    expect(recovered?.answerText).toContain('официальный уровень шума в дБ');
  });

  it('keeps a catalog candidate at the terminal boundary when only the required web fact is unconfirmed', () => {
    const product = {
      id: 'energo-e11000eax',
      name: 'Генератор бензиновый Energo E11000EAX (8,0 кВт) E11000EAX',
      category: 'Бензиновые генераторы',
      price: 80279,
      currency: 'RUB',
      specs: {
        стартер: 'с электростартером',
        автозапуск: 'с автозапуском',
        'число фаз': 'однофазные',
        'напряжение, в': '230В',
        'вид топлива': 'бензиновые',
        'мощность номинальная при 220 в, квт': '8'
      }
    };
    const intent = generatorDecision().intent;
    intent.selectionPolicy = {
      phase: 'single_phase',
      maxCards: null,
      rationale: 'A preliminary candidate is useful while noise remains unconfirmed.',
      needAction: 'open',
      powerSource: 'fuel',
      requirements: [{
        id: 'fuel', kind: 'fuel_type', role: 'hard_constraint', unit: null, value: 'бензин',
        evidence: 'бензиновый', relation: 'must_have', strictness: 'strict', verification: { mode: 'product_attribute' }
      }, {
        id: 'voltage', kind: 'voltage_v', role: 'hard_constraint', unit: 'В', value: 220,
        evidence: '220 В', relation: 'must_have', strictness: 'strict', verification: { mode: 'product_attribute' }
      }, {
        id: 'power', kind: 'nominal_power_min_kw', role: 'preference', unit: 'кВт', value: 8,
        evidence: 'около 8 кВт', relation: 'preferred', strictness: 'preferred', verification: { mode: 'product_attribute' }
      }, {
        id: 'start', kind: 'electric_start_required', role: 'hard_constraint', unit: null, value: true,
        evidence: 'с электростартом', relation: 'must_have', strictness: 'strict', verification: { mode: 'product_attribute' }
      }, {
        id: 'budget', kind: 'budget_max_rub', role: 'hard_constraint', unit: '₽', value: 120000,
        evidence: 'до 120 000 ₽', relation: 'must_have', strictness: 'strict', verification: { mode: 'product_attribute' }
      }, {
        id: 'noise', kind: 'noise_level_db_official', role: 'hard_constraint', unit: null, value: true,
        evidence: 'точный официальный уровень шума', relation: 'must_have', strictness: 'strict', verification: { mode: 'product_attribute' }
      }],
      selectionGoal: 'preliminary_fit',
      alternativePolicy: 'same_class_only',
      rankingObjectives: [],
      reusePreviousCards: false,
      targetProductClass: 'бензиновый генератор',
      canonicalProductClass: 'generator'
    };
    intent.toolRequests = [{
      id: 'catalog', tool: 'catalog.search', required: true, rationale: 'find candidates',
      args: {}, coversRequirementIds: ['power', 'voltage', 'fuel', 'start', 'budget']
    }, {
      id: 'web', tool: 'web.researchProductFacts', required: true, rationale: 'verify official noise',
      args: { comparisonAttributes: ['noise_level_db'] }, coversRequirementIds: ['noise']
    }];
    const toolResults: ToolResult[] = [{
      requestId: 'catalog', tool: 'catalog.search', status: 'ok', observationStatus: 'success',
      payload: { products: [product], productIds: [product.id] },
      warnings: ['answer_products_preliminary:unverified_web_covered_strict_requirements:1']
    }, {
      requestId: 'web', tool: 'web.researchProductFacts', status: 'error', observationStatus: 'malformed',
      payload: { error: { code: 'web_research_skipped_budget' } }, warnings: []
    }];
    const filtered = filterProductsByStructuredSelectionPolicy({ products: [product], intent, toolResults });
    const recovery = terminalCatalogRecovery({
      intent,
      toolResults
    });

    const proofs = buildRequirementProofs({ intent, products: [product], toolResults });
    expect(proofs).toContainEqual(expect.objectContaining({
      requirementId: 'voltage', status: 'satisfied', normalizedValue: 230
    }));
    expect(proofs).toContainEqual(expect.objectContaining({
      requirementId: 'start', status: 'satisfied', normalizedValue: true
    }));
    expect(proofs).toContainEqual(expect.objectContaining({
      requirementId: 'noise', status: 'unverified'
    }));
    expect(filtered).toMatchObject({ products: [expect.objectContaining({ id: product.id })] });
    expect(recovery.products.map((item) => item.id)).toEqual([product.id]);
    expect(recovery.unfinishedVerification).toEqual(['официальный уровень шума в дБ']);
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

  it('rejects a semantic load that the deterministic calculator would discard', () => {
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

    expect(result.issues).toContain('generator_load_scenario_unexecutable_load:handheld_tool:angle grinder');
  });

  it('accepts an explicit numeric load after the calculator canonicalizes an unknown kind from its name', () => {
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

    expect(result.issues).not.toContain('generator_load_scenario_unexecutable_load:machine:machine');
    expect(result.issues).not.toContain('generator_load_scenario_unexecutable_load:unknown_load:machine');
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
