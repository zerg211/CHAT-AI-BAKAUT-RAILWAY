export const AI_MANAGER_RUNTIME_VERSION = '2026-11-14.resumable-agent-research-v5';
export const AI_MANAGER_CONTRACT_VERSION = '2026-11-03.catalog-snapshot-v1';

export const AI_MANAGER_RUNTIME_MANIFEST = Object.freeze({
  version: AI_MANAGER_RUNTIME_VERSION,
  contractVersion: AI_MANAGER_CONTRACT_VERSION,
  productionRuntime: 'openai_platform_agent' as const,
  modelConfigurationSource: 'saved_platform_agent',
  executionPaths: { initialDiscovery: 'agents_api', knownProducts: 'stateless_responses_no_truncation' },
  orchestrator: 'PlatformAgentAssistant',
  responseWriter: 'PlatformAgentAssistant.saveResult',
  stateModel: 'platform_agent_session_and_conversation_turns',
  recoveryModel: 'leased_research_steps_and_http_windows',
  runtimeArtifacts: [
    'conversation_turns.client_message_id',
    'conversation_turns.execution_lease',
    'turn_checkpoints',
    'turn_events.seq'
  ]
});
