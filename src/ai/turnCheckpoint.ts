import { createHash } from 'node:crypto';

export const turnCheckpointNames = [
  'user_message_saved',
  'ledger_delta_proposed',
  'ledger_delta_applied',
  'intent_contract_created',
  'tool_requests_created',
  'tool_artifacts_saved',
  'answer_contract_created',
  'review_completed',
  'assistant_message_saved',
  'client_delivery_completed'
] as const;

export type TurnCheckpointName = typeof turnCheckpointNames[number];
export type TurnCheckpointStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped';

export function stableToolRequestId(input: {
  turnId: string;
  tool: string;
  args: unknown;
  ordinal?: number;
}) {
  const hash = createHash('sha256')
    .update(JSON.stringify({
      turnId: input.turnId,
      tool: input.tool,
      args: input.args,
      ordinal: input.ordinal ?? 0
    }))
    .digest('hex')
    .slice(0, 24);
  return `${input.tool}:${hash}`;
}

export function canAdvanceCheckpoint(previous: TurnCheckpointStatus | undefined, next: TurnCheckpointStatus) {
  if (!previous) return true;
  if (previous === 'succeeded' && next !== 'succeeded') return false;
  if (previous === 'failed' && next === 'running') return true;
  return true;
}
