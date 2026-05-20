import { describe, expect, it } from 'vitest';
import { AGENT_MANAGER_URL_OPT_IN_PARAM, getAgentManagerRuntimeDecision, isAgentManagerHarnessEnabledForSession } from '../src/ai/agentManagerRuntime.js';

describe('agent manager runtime activation', () => {
  it('keeps the harness off in automated tests unless explicitly enabled', () => {
    expect(isAgentManagerHarnessEnabledForSession({ pageUrl: 'https://bakautprof.ru/' })).toBe(false);
    expect(getAgentManagerRuntimeDecision({ pageUrl: 'https://bakautprof.ru/' })).toMatchObject({
      runtimeMode: 'legacy',
      reason: 'harness_disabled_and_no_url_opt_in',
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
});
