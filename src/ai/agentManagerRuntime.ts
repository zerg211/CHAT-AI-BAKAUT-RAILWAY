import { config } from '../config.js';
import type { ConversationSession } from '../shared/types.js';

export const AGENT_MANAGER_URL_OPT_IN_PARAM = 'agentHarness';

function hasUrlOptIn(pageUrl?: string | null) {
  if (!pageUrl) return false;
  try {
    const url = new URL(pageUrl);
    return url.searchParams.get(AGENT_MANAGER_URL_OPT_IN_PARAM) === '1';
  } catch {
    return new RegExp(`[?&]${AGENT_MANAGER_URL_OPT_IN_PARAM}=1(?:&|$)`, 'u').test(pageUrl);
  }
}

export function isAgentManagerHarnessEnabledForSession(session?: Pick<ConversationSession, 'pageUrl'> | null) {
  return config.AGENT_MANAGER_HARNESS_ENABLED || hasUrlOptIn(session?.pageUrl);
}
