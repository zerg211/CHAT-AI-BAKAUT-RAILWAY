import { describe, expect, it } from 'vitest';
import { AGENT_MANAGER_URL_OPT_IN_PARAM, isAgentManagerHarnessEnabledForSession } from '../src/ai/agentManagerRuntime.js';

describe('agent manager runtime activation', () => {
  it('keeps the harness off in automated tests unless explicitly enabled', () => {
    expect(isAgentManagerHarnessEnabledForSession({ pageUrl: 'https://bakautprof.ru/' })).toBe(false);
  });

  it('keeps the production widget opt-in query string compatible', () => {
    expect(AGENT_MANAGER_URL_OPT_IN_PARAM).toBe('agentHarness');
    expect(isAgentManagerHarnessEnabledForSession({ pageUrl: 'https://bakautprof.ru/?agentHarness=1' })).toBe(true);
  });
});
