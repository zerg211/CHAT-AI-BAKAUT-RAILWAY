CREATE TABLE IF NOT EXISTS conversation_turns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES conversation_sessions(id) ON DELETE CASCADE,
  user_message_id uuid REFERENCES messages(id) ON DELETE SET NULL,
  assistant_message_id uuid REFERENCES messages(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'received' CHECK (status IN (
    'received',
    'need_extracted',
    'planned',
    'answering',
    'completed',
    'failed',
    'recovered'
  )),
  request_hash text NOT NULL,
  stage text,
  error_code text,
  error_message text,
  planner_contract jsonb,
  active_needs_before jsonb,
  active_needs_after jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS conversation_turns_session_created_idx
  ON conversation_turns(session_id, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS conversation_turns_request_hash_active_idx
  ON conversation_turns(session_id, request_hash)
  WHERE status IN ('received', 'need_extracted', 'planned', 'answering', 'completed', 'recovered');
