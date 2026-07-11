import { config, type AppConfig } from '../config.js';

export interface AgentManagerFeatureFlags {
  harnessEnabled: boolean;
  disableLegacyAnswerWriters: boolean;
}

export type LegacyAnswerWriterKind =
  | 'fast_commercial_contact_confirmation'
  | 'fast_catalog_selection'
  | 'fast_technical_orientation'
  | 'deterministic_answer_generation_fallback'
  | 'proactive_commercial_answer'
  | 'proactive_catalog_selection_answer'
  | 'lead_confirmation_answer'
  | 'deterministic_turn_recovery';

type ConfigLike = Pick<
  AppConfig,
  | 'AGENT_MANAGER_HARNESS_ENABLED'
  | 'AGENT_MANAGER_DISABLE_LEGACY_ANSWER_WRITERS'
>;

export function readAgentManagerFeatureFlags(source: ConfigLike = config): AgentManagerFeatureFlags {
  return {
    harnessEnabled: source.AGENT_MANAGER_HARNESS_ENABLED,
    disableLegacyAnswerWriters: source.AGENT_MANAGER_DISABLE_LEGACY_ANSWER_WRITERS
  };
}

export function legacyAnswerWriterAllowed(
  kind: LegacyAnswerWriterKind,
  flags: AgentManagerFeatureFlags = readAgentManagerFeatureFlags()
) {
  if (kind === 'fast_technical_orientation') return false;
  if (!flags.harnessEnabled) return true;
  return !flags.disableLegacyAnswerWriters;
}

export function disabledLegacyWriterMetadata(kind: LegacyAnswerWriterKind, flags = readAgentManagerFeatureFlags()) {
  return {
    kind,
    harnessEnabled: flags.harnessEnabled,
    disabledBy: flags.harnessEnabled && flags.disableLegacyAnswerWriters
      ? 'AGENT_MANAGER_DISABLE_LEGACY_ANSWER_WRITERS'
      : null
  };
}
