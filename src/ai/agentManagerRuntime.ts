export type AgentManagerRuntimeMode = 'agent_manager';
export type AgentManagerRuntimeReason = 'sole_runtime';

export interface AgentManagerRuntimeDecision {
  runtimeMode: AgentManagerRuntimeMode;
  reason: AgentManagerRuntimeReason;
}

const SOLE_RUNTIME_DECISION: AgentManagerRuntimeDecision = Object.freeze({
  runtimeMode: 'agent_manager',
  reason: 'sole_runtime'
});

export function getAgentManagerRuntimeDecision(): AgentManagerRuntimeDecision {
  return SOLE_RUNTIME_DECISION;
}

export function runtimeResponseMetadata(runtimeDecision = SOLE_RUNTIME_DECISION) {
  return {
    runtimeMode: runtimeDecision.runtimeMode,
    runtimeModeReason: runtimeDecision.reason,
    agentManagerRuntime: runtimeDecision
  };
}
