import { describe, expect, it } from 'vitest';
import {
  AGENT_MANAGER_URL_OPT_IN_PARAM,
  getAgentManagerRuntimeDecision,
  isAgentManagerHarnessEnabledForSession,
  resolveAgentManagerRuntimeDecision,
  runtimeResponseMetadata
} from '../src/ai/agentManagerRuntime.js';

describe('agent manager runtime activation', () => {
  it('uses the agent manager as the sole runtime in production even if the old harness flag is false', () => {
    expect(resolveAgentManagerRuntimeDecision({
      nodeEnv: 'production',
      testHarnessEnabled: false,
      urlOptIn: false,
      legacyAnswerWritersDisabled: false
    })).toMatchObject({
      runtimeMode: 'agent_manager',
      reason: 'sole_production_runtime',
      agentManagerHarnessEnabled: true,
      legacyAnswerWritersDisabled: true
    });
  });
  it('keeps the harness off in automated tests unless explicitly enabled', () => {
    expect(isAgentManagerHarnessEnabledForSession({ pageUrl: 'https://bakautprof.ru/' })).toBe(false);
    expect(getAgentManagerRuntimeDecision({ pageUrl: 'https://bakautprof.ru/' })).toMatchObject({
      runtimeMode: 'legacy',
      reason: 'test_legacy_runtime',
      agentManagerHarnessEnabled: false,
      urlOptIn: false
    });
  });

  it('keeps the production widget opt-in query string compatible', () => {
    expect(AGENT_MANAGER_URL_OPT_IN_PARAM).toBe('agentHarness');
    expect(isAgentManagerHarnessEnabledForSession({ pageUrl: 'https://bakautprof.ru/?agentHarness=1' })).toBe(true);
    expect(getAgentManagerRuntimeDecision({ pageUrl: 'https://bakautprof.ru/?agentHarness=1' })).toMatchObject({
      runtimeMode: 'agent_manager',
      reason: 'url_opt_in_agentHarness_1',
      agentManagerHarnessEnabled: true,
      urlOptIn: true
    });
  });

  it('keeps relative widget opt-in values compatible without regex parsing', () => {
    expect(isAgentManagerHarnessEnabledForSession({ pageUrl: '/?agentHarness=1' })).toBe(true);
    expect(isAgentManagerHarnessEnabledForSession({ pageUrl: '?agentHarness=1' })).toBe(true);
    expect(isAgentManagerHarnessEnabledForSession({ pageUrl: '/catalog/?x=1&agentHarness=1' })).toBe(true);
  });

  it('does not opt in for similar non-matching harness query values', () => {
    expect(isAgentManagerHarnessEnabledForSession({ pageUrl: 'https://bakautprof.ru/?agentHarness=10' })).toBe(false);
    expect(isAgentManagerHarnessEnabledForSession({ pageUrl: '/?agentHarness=true' })).toBe(false);
    expect(isAgentManagerHarnessEnabledForSession({ pageUrl: '/?other=1' })).toBe(false);
  });

  it('builds response metadata without legacy block for agent manager runtime', () => {
    const decision = getAgentManagerRuntimeDecision({ pageUrl: 'https://bakautprof.ru/?agentHarness=1' });

    expect(runtimeResponseMetadata(decision)).toEqual({
      runtimeMode: 'agent_manager',
      runtimeModeReason: 'url_opt_in_agentHarness_1',
      agentManagerRuntime: decision
    });
  });

  it('builds response metadata with legacy block for legacy runtime', () => {
    const decision = getAgentManagerRuntimeDecision({ pageUrl: 'https://bakautprof.ru/' });

    expect(runtimeResponseMetadata(decision, 'legacy_full_pipeline')).toEqual({
      runtimeMode: 'legacy',
      runtimeModeReason: 'test_legacy_runtime',
      agentManagerRuntime: decision,
      legacyRuntime: {
        active: true,
        path: 'legacy_full_pipeline',
        reason: 'test_legacy_runtime',
        legacyAnswerWritersDisabled: decision.legacyAnswerWritersDisabled
      }
    });
  });
});
