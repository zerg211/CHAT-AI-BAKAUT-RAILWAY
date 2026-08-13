import { AsyncLocalStorage } from 'node:async_hooks';
import type { AgentManagerToolDefinition } from './agentManagerToolRegistry.js';
import type { ProviderCallEstimate, ProviderBudgetEstimationStopReason } from './openaiRequestBudget.js';

export interface AgentManagerTurnLimits {
  maxModelCalls: number;
  maxProviderCalls: number;
  maxToolCalls: number;
  maxWebCalls: number;
  maxResultBytes: number;
  maxProviderEstimatedInputTokens: number;
  maxProviderReservedOutputTokens: number;
  maxProviderEstimatedTotalTokens: number;
  maxEstimatedCostUsd: number;
  maxWallTimeMs: number;
}

export type AgentManagerStopReason =
  | 'model_call_budget_exceeded'
  | 'provider_call_budget_exceeded'
  | 'tool_call_budget_exceeded'
  | 'web_call_budget_exceeded'
  | 'tool_result_budget_exceeded'
  | 'provider_input_token_budget_exceeded'
  | 'provider_output_token_budget_exceeded'
  | 'provider_total_token_budget_exceeded'
  | 'estimated_cost_budget_exceeded'
  | 'wall_time_budget_exceeded'
  | ProviderBudgetEstimationStopReason;

export const DEFAULT_AGENT_MANAGER_TURN_LIMITS: AgentManagerTurnLimits = {
  maxModelCalls: 6,
  maxProviderCalls: 20,
  maxToolCalls: 8,
  maxWebCalls: 2,
  maxResultBytes: 900_000,
  maxProviderEstimatedInputTokens: 1_250_000,
  maxProviderReservedOutputTokens: 80_000,
  maxProviderEstimatedTotalTokens: 1_350_000,
  maxEstimatedCostUsd: 10,
  maxWallTimeMs: 40_000
};

export class AgentManagerTurnBudgetExceededError extends Error {
  readonly code = 'agent_manager_turn_budget_exceeded';

  constructor(readonly stopReason: AgentManagerStopReason) {
    super(stopReason);
    this.name = 'AgentManagerTurnBudgetExceededError';
  }
}

export class AgentManagerTurnBudget {
  private readonly startedAt: number;
  private readonly deadlineAtMs: number;
  private modelCalls = 0;
  private providerCalls = 0;
  private toolCalls = 0;
  private webCalls = 0;
  private resultBytes = 0;
  private providerEstimatedInputTokens = 0;
  private providerReservedOutputTokens = 0;
  private providerEstimatedTotalTokens = 0;
  private estimatedCostUsd = 0;
  private hostedToolEstimatedCostUsd = 0;

  constructor(
    readonly limits: AgentManagerTurnLimits = DEFAULT_AGENT_MANAGER_TURN_LIMITS,
    private readonly now: () => number = Date.now,
    absoluteDeadlineAtMs?: number
  ) {
    this.startedAt = this.now();
    const localDeadlineAtMs = this.startedAt + this.limits.maxWallTimeMs;
    this.deadlineAtMs = Number.isFinite(absoluteDeadlineAtMs)
      ? Math.min(localDeadlineAtMs, Number(absoluteDeadlineAtMs))
      : localDeadlineAtMs;
  }

  assertWallTime() {
    if (this.now() >= this.deadlineAtMs) {
      throw new AgentManagerTurnBudgetExceededError('wall_time_budget_exceeded');
    }
  }

  remainingWallTimeMs() {
    return Math.max(0, this.deadlineAtMs - this.now());
  }

  createWallTimeAbortSignal() {
    this.assertWallTime();
    return AbortSignal.timeout(Math.max(1, this.remainingWallTimeMs()));
  }

  consumeModelCall() {
    this.assertWallTime();
    if (this.modelCalls + 1 > this.limits.maxModelCalls) {
      throw new AgentManagerTurnBudgetExceededError('model_call_budget_exceeded');
    }
    this.modelCalls += 1;
  }

  consumeProviderCall(input: ProviderCallEstimate) {
    this.assertWallTime();
    const nextProviderCalls = this.providerCalls + 1;
    const nextInputTokens = this.providerEstimatedInputTokens + Math.max(0, input.estimatedInputTokens);
    const nextOutputTokens = this.providerReservedOutputTokens + Math.max(0, input.reservedOutputTokens);
    const nextTotalTokens = this.providerEstimatedTotalTokens + Math.max(0, input.estimatedTotalTokens);
    const nextCostUsd = this.estimatedCostUsd + Math.max(0, input.estimatedCostUsd);
    if (nextProviderCalls > this.limits.maxProviderCalls) {
      throw new AgentManagerTurnBudgetExceededError('provider_call_budget_exceeded');
    }
    if (nextInputTokens > this.limits.maxProviderEstimatedInputTokens) {
      throw new AgentManagerTurnBudgetExceededError('provider_input_token_budget_exceeded');
    }
    if (nextOutputTokens > this.limits.maxProviderReservedOutputTokens) {
      throw new AgentManagerTurnBudgetExceededError('provider_output_token_budget_exceeded');
    }
    if (nextTotalTokens > this.limits.maxProviderEstimatedTotalTokens) {
      throw new AgentManagerTurnBudgetExceededError('provider_total_token_budget_exceeded');
    }
    if (nextCostUsd > this.limits.maxEstimatedCostUsd) {
      throw new AgentManagerTurnBudgetExceededError('estimated_cost_budget_exceeded');
    }
    this.providerCalls = nextProviderCalls;
    this.providerEstimatedInputTokens = nextInputTokens;
    this.providerReservedOutputTokens = nextOutputTokens;
    this.providerEstimatedTotalTokens = nextTotalTokens;
    this.estimatedCostUsd = nextCostUsd;
    this.hostedToolEstimatedCostUsd += Math.max(0, input.hostedToolCostUsd);
  }

  consumeToolCall(definition: AgentManagerToolDefinition) {
    this.assertWallTime();
    this.toolCalls += 1;
    if (definition.risk === 'external_read') this.webCalls += 1;
    if (this.toolCalls > this.limits.maxToolCalls) {
      throw new AgentManagerTurnBudgetExceededError('tool_call_budget_exceeded');
    }
    if (this.webCalls > this.limits.maxWebCalls) {
      throw new AgentManagerTurnBudgetExceededError('web_call_budget_exceeded');
    }
  }

  consumeToolResult(bytes: number) {
    this.assertWallTime();
    this.resultBytes += Math.max(0, bytes);
    if (this.resultBytes > this.limits.maxResultBytes) {
      throw new AgentManagerTurnBudgetExceededError('tool_result_budget_exceeded');
    }
  }

  snapshot() {
    return {
      limits: this.limits,
      usage: {
        modelCalls: this.modelCalls,
        providerCalls: this.providerCalls,
        toolCalls: this.toolCalls,
        webCalls: this.webCalls,
        resultBytes: this.resultBytes,
        providerEstimatedInputTokens: this.providerEstimatedInputTokens,
        providerReservedOutputTokens: this.providerReservedOutputTokens,
        providerEstimatedTotalTokens: this.providerEstimatedTotalTokens,
        estimatedCostUsd: Number(this.estimatedCostUsd.toFixed(6)),
        hostedToolEstimatedCostUsd: Number(this.hostedToolEstimatedCostUsd.toFixed(6)),
        wallTimeMs: this.now() - this.startedAt,
        deadlineAtMs: this.deadlineAtMs
      }
    };
  }
}

const activeTurnBudget = new AsyncLocalStorage<AgentManagerTurnBudget>();

export function runWithAgentManagerTurnBudget<T>(budget: AgentManagerTurnBudget, fn: () => Promise<T>) {
  return activeTurnBudget.run(budget, fn);
}

export function hasCurrentAgentManagerTurnBudget() {
  return Boolean(activeTurnBudget.getStore());
}

export function consumeCurrentAgentManagerProviderCall(estimate: ProviderCallEstimate) {
  activeTurnBudget.getStore()?.consumeProviderCall(estimate);
}
