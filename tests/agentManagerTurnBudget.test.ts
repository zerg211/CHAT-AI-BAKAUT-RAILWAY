import { describe, expect, it } from 'vitest';
import { agentManagerToolRegistry } from '../src/ai/agentManagerToolRegistry.js';
import {
  AgentManagerTurnBudget,
  AgentManagerTurnBudgetExceededError,
  DEFAULT_AGENT_MANAGER_TURN_LIMITS,
  consumeCurrentAgentManagerProviderCall,
  runWithAgentManagerTurnBudget
} from '../src/ai/agentManagerTurnBudget.js';
import { effectiveAgentToolTimeoutMs } from '../src/ai/agentManagerOrchestrator.js';

describe('agent manager turn budget', () => {
  const providerEstimate = (inputTokens: number, outputTokens: number, costUsd = 0.01) => ({
    kind: 'responses' as const,
    model: 'gpt-5.6-terra',
    estimatedInputTokens: inputTokens,
    reservedOutputTokens: outputTokens,
    estimatedTotalTokens: inputTokens + outputTokens,
    estimatedCostUsd: costUsd,
    hostedToolCostUsd: 0
  });

  it('reserves a bounded 58-second work budget with web capped inside it', () => {
    const webTimeoutMs = agentManagerToolRegistry['web.researchProductFacts'].timeoutMs;

    expect(DEFAULT_AGENT_MANAGER_TURN_LIMITS.maxWallTimeMs).toBe(58_000);
    expect(webTimeoutMs).toBe(30_000);
    expect(webTimeoutMs).toBeLessThan(DEFAULT_AGENT_MANAGER_TURN_LIMITS.maxWallTimeMs);
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

    expect(effectiveWebTimeoutMs).toBe(30_000);
    now += effectiveWebTimeoutMs;
    expect(budget.remainingWallTimeMs()).toBe(26_000);
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

  it('reserves semantic decision, answer composition, and one bounded semantic correction', () => {
    const budget = new AgentManagerTurnBudget(DEFAULT_AGENT_MANAGER_TURN_LIMITS);
    for (let call = 0; call < 3; call += 1) budget.consumeModelCall();

    expect(budget.snapshot().usage.modelCalls).toBe(3);
    expect(() => budget.consumeModelCall()).toThrow('model_call_budget_exceeded');
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
    expect(worstCaseCostAtTokenCeilings).toBeLessThanOrEqual(limits.maxEstimatedCostUsd);
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
