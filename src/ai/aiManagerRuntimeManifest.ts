import {
  SALES_MANAGER_POLICY_PACK_HASH,
  SALES_MANAGER_POLICY_PACK_VERSION
} from './salesManagerBehaviorPolicy.js';

export const AI_MANAGER_RUNTIME_VERSION = '2026-08-24.gpt-5-6-luna-xhigh-harness-v1';
export const AI_MANAGER_CONTRACT_VERSION = '2026-08-11.manager-contract-v2';

export const AI_MANAGER_RUNTIME_MANIFEST = Object.freeze({
  version: AI_MANAGER_RUNTIME_VERSION,
  contractVersion: AI_MANAGER_CONTRACT_VERSION,
  productionRuntime: 'agent_manager' as const,
  orchestrator: 'AgentManagerOrchestrator',
  responseWriter: 'AgentManagerOrchestrator.executeClaimedTurn',
  policyPackVersion: SALES_MANAGER_POLICY_PACK_VERSION,
  policyPackHash: SALES_MANAGER_POLICY_PACK_HASH,
  stateModel: 'dialogue_ledger_snapshot_plus_tail',
  recoveryModel: 'leased_checkpoint_and_tool_artifact_replay',
  reviewPolicy: 'off|risk|always; production default risk',
  runtimeArtifacts: [
    'conversation_turns.client_message_id',
    'conversation_turns.execution_lease',
    'dialogue_ledger_events',
    'dialogue_ledger_snapshots',
    'turn_checkpoints',
    'tool_artifacts',
    'answer_contracts.response_payload',
    'leads.origin_tool_request_id',
    'agent_traces',
    'assistant_feedback_events',
    'catalog_sync_runs',
    'products.is_active'
  ]
});
