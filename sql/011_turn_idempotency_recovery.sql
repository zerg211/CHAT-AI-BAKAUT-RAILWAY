ALTER TABLE conversation_turns
  ADD COLUMN IF NOT EXISTS client_message_id uuid;

UPDATE conversation_turns
SET client_message_id = id
WHERE client_message_id IS NULL;

ALTER TABLE conversation_turns
  ALTER COLUMN client_message_id SET DEFAULT gen_random_uuid(),
  ALTER COLUMN client_message_id SET NOT NULL;

ALTER TABLE conversation_turns
  ADD COLUMN IF NOT EXISTS execution_owner uuid,
  ADD COLUMN IF NOT EXISTS execution_lease_expires_at timestamptz;

DROP INDEX IF EXISTS conversation_turns_request_hash_active_idx;

CREATE UNIQUE INDEX IF NOT EXISTS conversation_turns_client_message_id_idx
  ON conversation_turns(session_id, client_message_id);

WITH ranked_active_turns AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY session_id
           ORDER BY created_at DESC, id DESC
         ) AS active_rank
  FROM conversation_turns
  WHERE status IN ('received', 'need_extracted', 'planned', 'answering')
)
UPDATE conversation_turns AS turn
SET status = 'failed',
    stage = 'migration_superseded_active_turn',
    error_code = 'superseded_active_turn',
    error_message = 'A newer active turn existed when the single-active-turn invariant was installed.',
    execution_owner = NULL,
    execution_lease_expires_at = NULL,
    updated_at = now()
FROM ranked_active_turns AS ranked
WHERE turn.id = ranked.id
  AND ranked.active_rank > 1;

CREATE UNIQUE INDEX IF NOT EXISTS conversation_turns_one_active_per_session_idx
  ON conversation_turns(session_id)
  WHERE status IN ('received', 'need_extracted', 'planned', 'answering');

ALTER TABLE tool_artifacts
  ADD COLUMN IF NOT EXISTS error_code text;

ALTER TABLE answer_contracts
  ADD COLUMN IF NOT EXISTS response_payload jsonb;

ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS origin_turn_id uuid REFERENCES conversation_turns(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS origin_tool_request_id text;

CREATE UNIQUE INDEX IF NOT EXISTS leads_origin_tool_request_idx
  ON leads(session_id, origin_turn_id, origin_tool_request_id);
