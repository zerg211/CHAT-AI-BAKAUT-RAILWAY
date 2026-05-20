import { describe, expect, it } from 'vitest';
import { AGENT_MANAGER_URL_OPT_IN_PARAM, isAgentManagerHarnessEnabledForSession } from '../src/ai/agentManagerRuntime.js';

describe('agent manager runtime activation', () => {
  it('keeps the harness off by default', () => {
    expect(isAgentManagerHarnessEnabledForSession({ pageUrl: 'https://bakautprof.ru/' })).toBe(false);
  });

  it('allows production widget opt-in through the pageUrl query string', () => {
    expect(AGENT_MANAGER_URL_OPT_IN_PARAM).toBe('agentHarness');
    expect(isAgentManagerHarnessEnabledForSession({ pageUrl: 'https://bakautprof.ru/?agentHarness=1' })).toBe(true);
  });
});
