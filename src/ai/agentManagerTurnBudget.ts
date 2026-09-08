import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import type { AgentManagerToolDefinition } from './agentManagerToolRegistry.js';
import type { ProviderCallEstimate, ProviderBudgetEstimationStopReason } from './openaiRequestBudget.js';
import type { CustomerNeedState } from '../shared/types.js';

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
  maxModelCalls: 8,
  maxProviderCalls: 60,
  maxToolCalls: 8,
  maxWebCalls: 2,
  maxResultBytes: 900_000,
  maxProviderEstimatedInputTokens: 1_250_000,
  maxProviderReservedOutputTokens: 80_000,
  maxProviderEstimatedTotalTokens: 1_350_000,
  maxEstimatedCostUsd: 10,
  // Decision, observation rounds, writer, factual/language review and bounded
  // corrections share this deadline and the same provider/tool budgets.
  maxWallTimeMs: 150_000
};

export type AgentManagerBudgetProfile = 'FAST' | 'NORMAL' | 'RESEARCH' | 'ACTION' | 'RECOVERY' | 'CUSTOM';

export const AGENT_MANAGER_TURN_BUDGET_PROFILES: Record<Exclude<AgentManagerBudgetProfile, 'CUSTOM'>, AgentManagerTurnLimits> = {
  FAST: {
    maxModelCalls: 4,
    maxProviderCalls: 20,
    maxToolCalls: 3,
    maxWebCalls: 1,
    maxResultBytes: 400_000,
    maxProviderEstimatedInputTokens: 450_000,
    maxProviderReservedOutputTokens: 24_000,
    maxProviderEstimatedTotalTokens: 474_000,
    maxEstimatedCostUsd: 3,
    maxWallTimeMs: 60_000
  },
  NORMAL: {
    maxModelCalls: 6,
    maxProviderCalls: 36,
    maxToolCalls: 5,
    // A normal turn can still require a bounded initial and follow-up web
    // read before the planner can classify it as RESEARCH.
    maxWebCalls: 2,
    maxResultBytes: 650_000,
    maxProviderEstimatedInputTokens: 800_000,
    maxProviderReservedOutputTokens: 48_000,
    maxProviderEstimatedTotalTokens: 848_000,
    maxEstimatedCostUsd: 6,
    maxWallTimeMs: 125_000
  },
  RESEARCH: { ...DEFAULT_AGENT_MANAGER_TURN_LIMITS },
  ACTION: {
    maxModelCalls: 6,
    maxProviderCalls: 40,
    maxToolCalls: 6,
    maxWebCalls: 2,
    maxResultBytes: 750_000,
    maxProviderEstimatedInputTokens: 900_000,
    maxProviderReservedOutputTokens: 56_000,
    maxProviderEstimatedTotalTokens: 956_000,
    maxEstimatedCostUsd: 7,
    maxWallTimeMs: 135_000
  },
  RECOVERY: {
    maxModelCalls: 6,
    maxProviderCalls: 40,
    maxToolCalls: 6,
    maxWebCalls: 2,
    maxResultBytes: 750_000,
    maxProviderEstimatedInputTokens: 900_000,
    maxProviderReservedOutputTokens: 56_000,
    maxProviderEstimatedTotalTokens: 956_000,
    maxEstimatedCostUsd: 7,
    maxWallTimeMs: 135_000
  }
};

export function agentManagerTurnLimitsForProfile(profile: Exclude<AgentManagerBudgetProfile, 'CUSTOM'>) {
  // Keep the established operational ceiling live for RESEARCH so targeted
  // emergency overrides and recovery tests cannot drift from the hard guard.
  return profile === 'RESEARCH'
    ? { ...DEFAULT_AGENT_MANAGER_TURN_LIMITS }
    : { ...AGENT_MANAGER_TURN_BUDGET_PROFILES[profile] };
}

export function selectAgentManagerBudgetProfile(input: {
  recovered: boolean;
  userMessage?: string;
  needState?: CustomerNeedState | null;
}): Exclude<AgentManagerBudgetProfile, 'CUSTOM'> {
  if (input.recovered) return 'RECOVERY';
  const state = input.needState;
  if (!state) return 'NORMAL';
  const selectedNeed = state.activeNeeds.some((need) => need.status === 'selected' && need.selectedProductIds.length > 0);
  if (selectedNeed) return 'ACTION';
  const requiresResearch = state.contradictions.length > 0 ||
    state.uncertainInferences.length > 0 ||
    state.selectionState.unknowns.length > 0 ||
    state.activeNeeds.some((need) => need.status === 'open' &&
      (need.openQuestions.length > 0 || need.selectedProductIds.length === 0));
  if (requiresResearch) return 'RESEARCH';
  const hasConversationContext = Boolean(state.lastSummary.trim()) || state.activeNeeds.length > 0;
  if (hasConversationContext && (input.userMessage?.trim().length ?? 0) <= 160) return 'FAST';
  return 'NORMAL';
}

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
  private promptShapes: Array<{
    stage: string;
    model: string;
    reasoningEffort: string | null;
    inputCharacters: number;
    schemaCharacters: number;
    promptFingerprint: string;
  }> = [];

  recordPromptShape(shape: {
    stage: string;
    model: string;
    reasoningEffort: string | null;
    inputCharacters: number;
    schemaCharacters: number;
    promptFingerprint: string;
  }) {
    this.promptShapes.push(shape);
  }

  constructor(
    readonly limits: AgentManagerTurnLimits = DEFAULT_AGENT_MANAGER_TURN_LIMITS,
    private readonly now: () => number = Date.now,
    absoluteDeadlineAtMs?: number,
    readonly profile: AgentManagerBudgetProfile = 'CUSTOM'
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

  deadlineForStage(maxDurationMs: number, downstreamReserveMs = 0) {
    this.assertWallTime();
    const now = this.now();
    const latestStageDeadlineAtMs = this.deadlineAtMs - Math.max(0, downstreamReserveMs);
    if (now >= latestStageDeadlineAtMs) {
      throw new AgentManagerTurnBudgetExceededError('wall_time_budget_exceeded');
    }
    return Math.min(latestStageDeadlineAtMs, now + Math.max(1, maxDurationMs));
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
      profile: this.profile,
      usage: {
        promptShapes: this.promptShapes.map(shape => ({ ...shape })),
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

export function recordCurrentAgentPromptShape(stage: string, request: Record<string, unknown>) {
  activeTurnBudget.getStore()?.recordPromptShape({ stage, model: String(request.model ?? ''),
    reasoningEffort: typeof request.reasoning === 'object' && request.reasoning !== null
      ? String((request.reasoning as Record<string, unknown>).effort ?? '') || null
      : null,
    inputCharacters: JSON.stringify(request.input ?? '').length + JSON.stringify(request.instructions ?? '').length,
    schemaCharacters: JSON.stringify(request.text ?? {}).length,
    promptFingerprint: promptFingerprint(request) });
}

function stablePromptValue(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'undefined';
  if (Array.isArray(value)) return `[${value.map(stablePromptValue).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stablePromptValue(record[key])}`).join(',')}}`;
}

function promptFingerprint(request: Record<string, unknown>) {
  return createHash('sha256')
    .update(stablePromptValue({
      input: request.input ?? null,
      instructions: request.instructions ?? null,
      text: request.text ?? null
    }))
    .digest('hex');
}
