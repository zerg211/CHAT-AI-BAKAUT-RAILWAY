import { describe, expect, it } from 'vitest';
import {
  getAgentManagerRuntimeDecision,
  runtimeResponseMetadata
} from '../src/ai/agentManagerRuntime.js';

describe('sole agent manager runtime', () => {
  it('has one runtime decision in every environment and session', () => {
    expect(getAgentManagerRuntimeDecision()).toEqual({
      runtimeMode: 'agent_manager',
      reason: 'sole_runtime'
    });
  });

  it('publishes metadata without feature flags, URL opt-in, or legacy state', () => {
    const decision = getAgentManagerRuntimeDecision();
    expect(runtimeResponseMetadata(decision)).toEqual({
      runtimeMode: 'agent_manager',
      runtimeModeReason: 'sole_runtime',
      agentManagerRuntime: decision
    });
  });
});
