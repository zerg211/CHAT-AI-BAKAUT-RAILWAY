import { config } from '../config.js';
import type { ConversationSession } from '../shared/types.js';

export const AGENT_MANAGER_URL_OPT_IN_PARAM = 'agentHarness';

export type AgentManagerRuntimeMode = 'agent_manager' | 'legacy';
export type AgentManagerRuntimeReason =
  | 'sole_production_runtime'
  | 'test_harness_enabled'
  | `url_opt_in_${typeof AGENT_MANAGER_URL_OPT_IN_PARAM}_1`
  | 'test_legacy_runtime';

export interface AgentManagerRuntimeDecision {
  runtimeMode: AgentManagerRuntimeMode;
  reason: AgentManagerRuntimeReason;
  agentManagerHarnessEnabled: boolean;
  globalHarnessEnabled: boolean;
  urlOptIn: boolean;
  urlOptInParam: typeof AGENT_MANAGER_URL_OPT_IN_PARAM;
  legacyAnswerWritersDisabled: boolean;
}

export function resolveAgentManagerRuntimeDecision(input: {
  nodeEnv: 'development' | 'test' | 'production';
  testHarnessEnabled: boolean;
  urlOptIn: boolean;
  legacyAnswerWritersDisabled: boolean;
}): AgentManagerRuntimeDecision {
  const productionRuntime = input.nodeEnv !== 'test';
  const globalHarnessEnabled = productionRuntime || input.testHarnessEnabled;
  const agentManagerHarnessEnabled = globalHarnessEnabled || input.urlOptIn;
  const reason: AgentManagerRuntimeReason = productionRuntime
    ? 'sole_production_runtime'
    : input.testHarnessEnabled
      ? 'test_harness_enabled'
      : input.urlOptIn
        ? `url_opt_in_${AGENT_MANAGER_URL_OPT_IN_PARAM}_1`
        : 'test_legacy_runtime';
  return {
    runtimeMode: agentManagerHarnessEnabled ? 'agent_manager' : 'legacy',
    reason,
    agentManagerHarnessEnabled,
    globalHarnessEnabled,
    urlOptIn: input.urlOptIn,
    urlOptInParam: AGENT_MANAGER_URL_OPT_IN_PARAM,
    legacyAnswerWritersDisabled: productionRuntime ? true : input.legacyAnswerWritersDisabled
  };
}

function hasUrlOptIn(pageUrl?: string | null) {
  if (!pageUrl) return false;
  try {
    const url = new URL(pageUrl, 'https://local.invalid');
    return url.searchParams.get(AGENT_MANAGER_URL_OPT_IN_PARAM) === '1';
  } catch {
    return false;
  }
}

export function getAgentManagerRuntimeDecision(session?: Pick<ConversationSession, 'pageUrl'> | null): AgentManagerRuntimeDecision {
  const urlOptIn = hasUrlOptIn(session?.pageUrl);
  return resolveAgentManagerRuntimeDecision({
    nodeEnv: config.NODE_ENV,
    testHarnessEnabled: config.AGENT_MANAGER_HARNESS_ENABLED,
    urlOptIn,
    legacyAnswerWritersDisabled: config.AGENT_MANAGER_DISABLE_LEGACY_ANSWER_WRITERS
  });
}

export function runtimeResponseMetadata(runtimeDecision: AgentManagerRuntimeDecision, legacyPath?: string) {
  const metadata = {
    runtimeMode: runtimeDecision.runtimeMode,
    runtimeModeReason: runtimeDecision.reason,
    agentManagerRuntime: runtimeDecision
  };
  if (runtimeDecision.runtimeMode !== 'legacy') return metadata;
  return {
    ...metadata,
    legacyRuntime: {
      active: true,
      path: legacyPath ?? 'legacy_unknown',
      reason: runtimeDecision.reason,
      legacyAnswerWritersDisabled: runtimeDecision.legacyAnswerWritersDisabled
    }
  };
}

export function isAgentManagerHarnessEnabledForSession(session?: Pick<ConversationSession, 'pageUrl'> | null) {
  return getAgentManagerRuntimeDecision(session).agentManagerHarnessEnabled;
}
