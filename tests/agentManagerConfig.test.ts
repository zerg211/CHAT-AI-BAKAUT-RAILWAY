import { describe, expect, it } from 'vitest';
import {
  legacyAnswerWriterAllowed,
  readAgentManagerFeatureFlags,
  type AgentManagerFeatureFlags
} from '../src/ai/agentManagerConfig.js';

function flags(overrides: Partial<AgentManagerFeatureFlags> = {}): AgentManagerFeatureFlags {
  return {
    harnessEnabled: false,
    ledgerStateEnabled: false,
    llmAnswerStepEnabled: false,
    turnCheckpointRecoveryEnabled: false,
    preSendReviewEnabled: false,
    comparisonResearchEnabled: false,
    leadOutboxEnabled: false,
    disableLegacyAnswerWriters: true,
    ...overrides
  };
}

describe('agent manager feature flags', () => {
  it('keeps deterministic emergency fallback available while the new harness is off', () => {
    expect(legacyAnswerWriterAllowed('deterministic_answer_generation_fallback', flags())).toBe(true);
  });

  it('blocks the canned fast technical writer by default even before full harness rollout', () => {
    expect(legacyAnswerWriterAllowed('fast_technical_orientation', flags())).toBe(false);
  });

  it('blocks all legacy answer writers when the harness owns user-visible answers', () => {
    expect(legacyAnswerWriterAllowed('fast_catalog_selection', flags({ harnessEnabled: true }))).toBe(false);
    expect(legacyAnswerWriterAllowed('deterministic_turn_recovery', flags({ harnessEnabled: true }))).toBe(false);
  });

  it('supports an explicit emergency override for legacy writers', () => {
    expect(legacyAnswerWriterAllowed('fast_catalog_selection', flags({
      harnessEnabled: true,
      disableLegacyAnswerWriters: false
    }))).toBe(true);
  });

  it('maps environment config names to internal feature flags', () => {
    const mapped = readAgentManagerFeatureFlags({
      AGENT_MANAGER_HARNESS_ENABLED: true,
      AGENT_MANAGER_LEDGER_STATE_ENABLED: true,
      AGENT_MANAGER_LLM_ANSWER_STEP_ENABLED: false,
      AGENT_MANAGER_TURN_CHECKPOINT_RECOVERY_ENABLED: true,
      AGENT_MANAGER_PRE_SEND_REVIEW_ENABLED: false,
      AGENT_MANAGER_COMPARISON_RESEARCH_ENABLED: false,
      AGENT_MANAGER_LEAD_OUTBOX_ENABLED: true,
      AGENT_MANAGER_DISABLE_LEGACY_ANSWER_WRITERS: true
    });

    expect(mapped).toMatchObject({
      harnessEnabled: true,
      ledgerStateEnabled: true,
      turnCheckpointRecoveryEnabled: true,
      leadOutboxEnabled: true
    });
  });
});
