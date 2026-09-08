import { describe, expect, it } from 'vitest';
import { agentManagerToolRegistry } from '../src/ai/agentManagerToolRegistry.js';
import {
  AgentManagerTurnBudget,
  AgentManagerTurnBudgetExceededError,
  AGENT_MANAGER_TURN_BUDGET_PROFILES,
  DEFAULT_AGENT_MANAGER_TURN_LIMITS,
  agentManagerTurnLimitsForProfile,
  consumeCurrentAgentManagerProviderCall,
  recordCurrentAgentPromptShape,
  runWithAgentManagerTurnBudget,
  selectAgentManagerBudgetProfile
} from '../src/ai/agentManagerTurnBudget.js';
import { effectiveAgentToolTimeoutMs } from '../src/ai/agentManagerOrchestrator.js';
import { emptyNeedState } from '../src/ai/needState.js';

describe('agent manager turn budget', () => {
  it('releases only a completed request reserve so the final review can run', () => {
    const budget = new AgentManagerTurnBudget({ ...DEFAULT_AGENT_MANAGER_TURN_LIMITS,
      maxProviderEstimatedInputTokens: 1000, maxProviderEstimatedTotalTokens: 1200 });
    const request = { kind: 'responses' as const, model: 'gpt-5.6-luna',
      estimatedInputTokens: 700, reservedOutputTokens: 100, estimatedTotalTokens: 800,
      estimatedCostUsd: 0.00286, hostedToolCostUsd: 0 };
    const settle = budget.consumeProviderCall(request);
    expect(() => budget.consumeProviderCall(request)).toThrow('provider_input_token_budget_exceeded');
    settle({ input_tokens: 100, output_tokens: 20, total_tokens: 120 });
    settle({ input_tokens: 0, output_tokens: 0, total_tokens: 0 });
    budget.consumeProviderCall(request);
    expect(budget.snapshot().usage).toMatchObject({ providerCalls: 2,
      providerEstimatedInputTokens: 800, providerReservedOutputTokens: 120, providerEstimatedTotalTokens: 920 });
    expect(budget.snapshot().usage.estimatedCostUsd).toBeCloseTo(0.003344, 6);
  });

  it('retains unknown or malformed usage and other in-flight reserves', () => {
    const budget = new AgentManagerTurnBudget();
    const request = { kind: 'responses' as const, model: 'gpt-5.6-luna',
      estimatedInputTokens: 700, reservedOutputTokens: 100, estimatedTotalTokens: 800,
      estimatedCostUsd: 0.00286, hostedToolCostUsd: 0 };
    const settleFirst = budget.consumeProviderCall(request);
    budget.consumeProviderCall(request);
    for (const usage of [null, {}, { input_tokens: -1, output_tokens: 0, total_tokens: -1 },
      { input_tokens: 100, output_tokens: 20, total_tokens: 100 },
      { input_tokens: '100', output_tokens: 20, total_tokens: 120 }]) settleFirst(usage);
    expect(budget.snapshot().usage.providerEstimatedTotalTokens).toBe(1600);
    settleFirst({ input_tokens: 100, output_tokens: 20, total_tokens: 120 });
    expect(budget.snapshot().usage.providerEstimatedTotalTokens).toBe(920);
    expect(budget.snapshot().usage.providerCalls).toBe(2);
  });
  const providerEstimate = (inputTokens: number, outputTokens: number, costUsd = 0.01) => ({
    kind: 'responses' as const,
    model: 'gpt-5.6-terra',
    estimatedInputTokens: inputTokens,
    reservedOutputTokens: outputTokens,
    estimatedTotalTokens: inputTokens + outputTokens,
    estimatedCostUsd: costUsd,
    hostedToolCostUsd: 0
  });

  it('reserves a bounded turn budget with web capped inside it', () => {
    const webTimeoutMs = agentManagerToolRegistry['web.researchProductFacts'].timeoutMs;

    expect(DEFAULT_AGENT_MANAGER_TURN_LIMITS.maxWallTimeMs).toBe(150_000);
    expect(webTimeoutMs).toBe(60_000);
    expect(webTimeoutMs).toBeLessThan(DEFAULT_AGENT_MANAGER_TURN_LIMITS.maxWallTimeMs);
  });

  it('selects risk-adaptive profiles while keeping every profile below the hard ceiling', () => {
    const contextualState = emptyNeedState();
    contextualState.lastSummary = 'Покупатель уточняет генератор для дачи';
    const researchState = emptyNeedState();
    researchState.uncertainInferences.push({
      key: 'power',
      value: 'unknown',
      confidence: 0.2,
      source: 'inference'
    } as never);
    const actionState = emptyNeedState();
    actionState.activeNeeds.push({
      id: 'generator',
      productClass: 'generator',
      summary: 'Выбран генератор',
      constraints: [],
      openQuestions: [],
      selectedProductIds: ['product-1'],
      status: 'selected',
      updatedAt: new Date().toISOString()
    });

    expect(selectAgentManagerBudgetProfile({ recovered: true })).toBe('RECOVERY');
    expect(selectAgentManagerBudgetProfile({ recovered: false, userMessage: 'Да', needState: contextualState })).toBe('RESEARCH');
    expect(selectAgentManagerBudgetProfile({ recovered: false, userMessage: 'Проверь характеристики', needState: researchState })).toBe('RESEARCH');
    expect(selectAgentManagerBudgetProfile({ recovered: false, userMessage: 'Оформим', needState: actionState })).toBe('RESEARCH');
    expect(agentManagerTurnLimitsForProfile('NORMAL').maxModelCalls).toBeLessThan(
      AGENT_MANAGER_TURN_BUDGET_PROFILES.RESEARCH.maxModelCalls
    );
    expect(agentManagerTurnLimitsForProfile('FAST').maxWallTimeMs).toBeLessThan(
      AGENT_MANAGER_TURN_BUDGET_PROFILES.RESEARCH.maxWallTimeMs
    );
  });

  it('uses current semantic meaning rather than short text or a previously selected product',()=>{
    const exact = {grounding:{taskType:'technical_answer',sourcePolicy:'catalog_required'},toolRequests:[],riskFlags:[]} as never;
    expect(selectAgentManagerBudgetProfile({recovered:false,userMessage:'x'.repeat(2000),intent:exact})).toBe('FAST');
    const selection={grounding:{taskType:'product_selection'},toolRequests:[],riskFlags:[]} as never;
    expect(selectAgentManagerBudgetProfile({recovered:false,userMessage:'Да',intent:selection})).toBe('NORMAL');
    const research={grounding:{taskType:'technical_answer',sourcePolicy:'web_required'},toolRequests:[],riskFlags:[]} as never;
    expect(selectAgentManagerBudgetProfile({recovered:false,intent:research})).toBe('RESEARCH');
    const action={toolRequests:[{tool:'lead.capture'}],riskFlags:[],leadCaptureAuthorization:{authorized:true}} as never;
    expect(selectAgentManagerBudgetProfile({recovered:false,intent:action})).toBe('ACTION');
  });

  it('escalates a discovered gap without resetting spent calls or the original hard deadline',()=>{
    let now=0;
    const budget=new AgentManagerTurnBudget(agentManagerTurnLimitsForProfile('RESEARCH'),()=>now,100_000,'RESEARCH');
    budget.consumeModelCall();budget.applySemanticProfile('FAST','current_intent');
    expect(budget.remainingWallTimeMs()).toBe(60_000);
    now=40_000;budget.applySemanticProfile('RESEARCH','discovered_gap');
    expect(budget.remainingWallTimeMs()).toBe(60_000);
    expect(budget.snapshot().usage.modelCalls).toBe(1);
    expect(budget.snapshot().profileTransitions).toHaveLength(2);
    expect(DEFAULT_AGENT_MANAGER_TURN_LIMITS.maxWallTimeMs).toBe(150_000);
  });

  it('records a stable prompt fingerprint and selected profile in the turn snapshot', async () => {
    const budget = new AgentManagerTurnBudget(
      agentManagerTurnLimitsForProfile('FAST'),
      Date.now,
      undefined,
      'FAST'
    );
    await runWithAgentManagerTurnBudget(budget, async () => {
      recordCurrentAgentPromptShape('observe', {
        model: 'gpt-5.6-luna',
        input: { b: 2, a: 1 },
        instructions: 'Уточнить задачу',
        text: { format: { type: 'json_schema' } }
      });
      recordCurrentAgentPromptShape('observe', {
        model: 'gpt-5.6-luna',
        input: { a: 1, b: 2 },
        instructions: 'Уточнить задачу',
        text: { format: { type: 'json_schema' } }
      });
    });

    const snapshot = budget.snapshot();
    expect(snapshot.profile).toBe('FAST');
    expect(snapshot.usage.promptShapes).toHaveLength(2);
    expect(snapshot.usage.promptShapes[0]?.promptFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(snapshot.usage.promptShapes[0]?.promptFingerprint)
      .toBe(snapshot.usage.promptShapes[1]?.promptFingerprint);
  });

  it('caps web work to the time left after preserving one answer composition', () => {
    let now = 1_000;
    const budget = new AgentManagerTurnBudget(DEFAULT_AGENT_MANAGER_TURN_LIMITS, () => now);
    now += 2_000;
    const answerReserveMs = 5_000;
    const effectiveWebTimeoutMs = Math.min(
      agentManagerToolRegistry['web.researchProductFacts'].timeoutMs,
      budget.remainingWallTimeMs() - answerReserveMs
    );

    expect(effectiveWebTimeoutMs).toBe(60_000);
    now += effectiveWebTimeoutMs;
    expect(budget.remainingWallTimeMs()).toBe(88_000);
  });

  it('leaves enough time after web research to compose and commit a complex answer', () => {
    expect(effectiveAgentToolTimeoutMs({
      tool: 'web.researchProductFacts',
      configuredTimeoutMs: 60_000,
      remainingWallTimeMs: 45_000
    })).toBe(15_000);
  });

  it('caps catalog work before the answer reserve', () => {
    expect(effectiveAgentToolTimeoutMs({
      tool: 'catalog.search',
      configuredTimeoutMs: 60_000,
      remainingWallTimeMs: 16_500
    })).toBe(8_500);
    expect(effectiveAgentToolTimeoutMs({
      tool: 'calculator.generatorLoad',
      configuredTimeoutMs: 5_000,
      remainingWallTimeMs: 16_500
    })).toBe(5_000);
  });

  it('bounds logical model stages independently from provider reservations', () => {
    const budget = new AgentManagerTurnBudget({
      ...DEFAULT_AGENT_MANAGER_TURN_LIMITS,
      maxModelCalls: 1
    });
    budget.consumeModelCall();

    expect(() => budget.consumeModelCall())
      .toThrow(AgentManagerTurnBudgetExceededError);
  });

  it('reserves semantic decision, bounded observation rounds, answer, review, and corrections', () => {
    const budget = new AgentManagerTurnBudget(DEFAULT_AGENT_MANAGER_TURN_LIMITS);
    for (let call = 0; call < 8; call += 1) budget.consumeModelCall();

    expect(budget.snapshot().usage.modelCalls).toBe(8);
    expect(() => budget.consumeModelCall()).toThrow('model_call_budget_exceeded');
  });

  it('bounds three semantic attempts before a downstream tools and writer reserve', () => {
    let now = 1_000;
    const budget = new AgentManagerTurnBudget(DEFAULT_AGENT_MANAGER_TURN_LIMITS, () => now);

    expect(budget.deadlineForStage(45_000, 45_000)).toBe(46_000);
    now += 45_000;
    expect(budget.deadlineForStage(45_000, 45_000)).toBe(91_000);
    now += 45_000;
    expect(budget.deadlineForStage(45_000, 45_000)).toBe(106_000);
    now += 15_000;
    expect(() => budget.deadlineForStage(45_000, 45_000))
      .toThrow('wall_time_budget_exceeded');
    expect(budget.remainingWallTimeMs()).toBe(45_000);
  });

  it('counts every physical provider call, including nested calls and retries', async () => {
    const budget = new AgentManagerTurnBudget({
      ...DEFAULT_AGENT_MANAGER_TURN_LIMITS,
      maxProviderCalls: 2,
      maxProviderReservedOutputTokens: 100
    });
    await expect(runWithAgentManagerTurnBudget(budget, async () => {
      consumeCurrentAgentManagerProviderCall(providerEstimate(10, 40));
      await Promise.resolve();
      consumeCurrentAgentManagerProviderCall(providerEstimate(10, 40));
      consumeCurrentAgentManagerProviderCall(providerEstimate(1, 1));
    })).rejects.toThrow('provider_call_budget_exceeded');
    expect(budget.snapshot().usage).toMatchObject({
      providerCalls: 2,
      providerEstimatedInputTokens: 20,
      providerReservedOutputTokens: 80,
      providerEstimatedTotalTokens: 100
    });
  });

  it('prospectively blocks nested provider calls on input tokens and estimated cost', () => {
    const inputBudget = new AgentManagerTurnBudget({
      ...DEFAULT_AGENT_MANAGER_TURN_LIMITS,
      maxProviderEstimatedInputTokens: 50
    });
    inputBudget.consumeProviderCall(providerEstimate(40, 1));
    expect(() => inputBudget.consumeProviderCall(providerEstimate(11, 1)))
      .toThrow('provider_input_token_budget_exceeded');
    expect(inputBudget.snapshot().usage.providerCalls).toBe(1);

    const costBudget = new AgentManagerTurnBudget({
      ...DEFAULT_AGENT_MANAGER_TURN_LIMITS,
      maxEstimatedCostUsd: 0.05
    });
    costBudget.consumeProviderCall(providerEstimate(1, 1, 0.03));
    expect(() => costBudget.consumeProviderCall(providerEstimate(1, 1, 0.03)))
      .toThrow('estimated_cost_budget_exceeded');
    expect(costBudget.snapshot().usage.estimatedCostUsd).toBe(0.03);
  });

  it('keeps default token and cost ceilings internally coherent for GPT-5.6 Terra priority regional pricing', () => {
    const limits = DEFAULT_AGENT_MANAGER_TURN_LIMITS;
    const worstCaseCostAtTokenCeilings =
      limits.maxProviderEstimatedInputTokens * 5.5 / 1_000_000 +
      limits.maxProviderReservedOutputTokens * 33 / 1_000_000 +
      limits.maxProviderCalls * 0.01;

    expect(limits.maxProviderEstimatedTotalTokens).toBeGreaterThanOrEqual(
      limits.maxProviderEstimatedInputTokens + limits.maxProviderReservedOutputTokens
    );
    expect(limits.maxEstimatedCostUsd).toBeGreaterThanOrEqual(10);
    expect(worstCaseCostAtTokenCeilings).toBeLessThanOrEqual(limits.maxEstimatedCostUsd + limits.maxProviderCalls * 0.01);
  });

  it('accepts the operational provider ceiling exactly and rejects one extra input token prospectively', () => {
    const limits = DEFAULT_AGENT_MANAGER_TURN_LIMITS;
    const budget = new AgentManagerTurnBudget(limits);
    budget.consumeProviderCall({
      kind: 'responses',
      model: 'gpt-5.6-terra',
      estimatedInputTokens: limits.maxProviderEstimatedInputTokens,
      reservedOutputTokens: limits.maxProviderReservedOutputTokens,
      estimatedTotalTokens: limits.maxProviderEstimatedInputTokens + limits.maxProviderReservedOutputTokens,
      estimatedCostUsd: 9.715,
      hostedToolCostUsd: 0.2
    });
    expect(budget.snapshot().usage).toMatchObject({
      providerCalls: 1,
      providerEstimatedInputTokens: limits.maxProviderEstimatedInputTokens,
      providerReservedOutputTokens: limits.maxProviderReservedOutputTokens
    });

    expect(() => budget.consumeProviderCall(providerEstimate(1, 0, 0)))
      .toThrow('provider_input_token_budget_exceeded');
    expect(budget.snapshot().usage.providerCalls).toBe(1);
  });

  it('separately bounds external web calls and total tool result bytes', () => {
    const budget = new AgentManagerTurnBudget({
      ...DEFAULT_AGENT_MANAGER_TURN_LIMITS,
      maxWebCalls: 1,
      maxResultBytes: 10
    });
    budget.consumeToolCall(agentManagerToolRegistry['web.researchProductFacts']);
    budget.consumeToolResult(8);

    expect(() => budget.consumeToolCall(agentManagerToolRegistry['web.researchProductFacts']))
      .toThrow('web_call_budget_exceeded');
    expect(() => budget.consumeToolResult(3)).toThrow('tool_result_budget_exceeded');
  });

  it('fails the final wall-time assertion even when no later budget consume occurs', () => {
    let now = 1_000;
    const budget = new AgentManagerTurnBudget({
      ...DEFAULT_AGENT_MANAGER_TURN_LIMITS,
      maxWallTimeMs: 100
    }, () => now);

    budget.consumeModelCall();
    now = 1_100;

    expect(() => budget.assertWallTime()).toThrow('wall_time_budget_exceeded');
    expect(budget.remainingWallTimeMs()).toBe(0);
  });
});
