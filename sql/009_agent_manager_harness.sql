CREATE TABLE IF NOT EXISTS dialogue_ledger_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES conversation_sessions(id) ON DELETE CASCADE,
  turn_id uuid NOT NULL REFERENCES conversation_turns(id) ON DELETE CASCADE,
  event_id text NOT NULL,
  event_type text NOT NULL,
  scope text NOT NULL,
  payload jsonb NOT NULL,
  evidence text NOT NULL CHECK (length(trim(evidence)) > 0),
  source text NOT NULL CHECK (length(trim(source)) > 0),
  status text NOT NULL CHECK (status IN ('active', 'superseded', 'negated', 'closed', 'rejected')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(session_id, event_id)
);

CREATE INDEX IF NOT EXISTS dialogue_ledger_events_session_created_idx
  ON dialogue_ledger_events(session_id, created_at);

CREATE INDEX IF NOT EXISTS dialogue_ledger_events_session_turn_idx
  ON dialogue_ledger_events(session_id, turn_id);

CREATE INDEX IF NOT EXISTS dialogue_ledger_events_type_idx
  ON dialogue_ledger_events(event_type);

CREATE TABLE IF NOT EXISTS turn_checkpoints (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES conversation_sessions(id) ON DELETE CASCADE,
  turn_id uuid NOT NULL REFERENCES conversation_turns(id) ON DELETE CASCADE,
  checkpoint text NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'running', 'succeeded', 'failed', 'skipped')),
  artifact_ref text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  error_code text,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(session_id, turn_id, checkpoint)
);

CREATE INDEX IF NOT EXISTS turn_checkpoints_session_turn_idx
  ON turn_checkpoints(session_id, turn_id);

CREATE INDEX IF NOT EXISTS turn_checkpoints_status_idx
  ON turn_checkpoints(status);

CREATE TABLE IF NOT EXISTS tool_artifacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES conversation_sessions(id) ON DELETE CASCADE,
  turn_id uuid NOT NULL REFERENCES conversation_turns(id) ON DELETE CASCADE,
  tool_name text NOT NULL,
  tool_request_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('ok', 'denied', 'not_found', 'error', 'timeout')),
  payload jsonb NOT NULL,
  warnings jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(session_id, turn_id, tool_request_id)
);

CREATE INDEX IF NOT EXISTS tool_artifacts_session_turn_idx
  ON tool_artifacts(session_id, turn_id);

CREATE INDEX IF NOT EXISTS tool_artifacts_tool_name_idx
  ON tool_artifacts(tool_name);

CREATE TABLE IF NOT EXISTS answer_contracts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES conversation_sessions(id) ON DELETE CASCADE,
  turn_id uuid NOT NULL REFERENCES conversation_turns(id) ON DELETE CASCADE,
  answer_text text NOT NULL CHECK (length(trim(answer_text)) > 0),
  contract jsonb NOT NULL,
  review jsonb,
  status text NOT NULL CHECK (status IN ('draft', 'reviewed', 'final', 'rejected')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS answer_contracts_final_turn_idx
  ON answer_contracts(session_id, turn_id)
  WHERE status = 'final';

CREATE INDEX IF NOT EXISTS answer_contracts_session_turn_idx
  ON answer_contracts(session_id, turn_id);

CREATE TABLE IF NOT EXISTS lead_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  session_id uuid NOT NULL REFERENCES conversation_sessions(id) ON DELETE CASCADE,
  turn_id uuid NOT NULL REFERENCES conversation_turns(id) ON DELETE CASCADE,
  destination text NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'dead')),
  attempt_count integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(lead_id, destination)
);

CREATE INDEX IF NOT EXISTS lead_outbox_status_next_attempt_idx
  ON lead_outbox(status, next_attempt_at);

CREATE TABLE IF NOT EXISTS agent_traces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid REFERENCES conversation_sessions(id) ON DELETE CASCADE,
  turn_id uuid REFERENCES conversation_turns(id) ON DELETE CASCADE,
  phase text NOT NULL,
  event_type text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  redacted boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS agent_traces_session_turn_created_idx
  ON agent_traces(session_id, turn_id, created_at DESC);

CREATE TABLE IF NOT EXISTS data_quality_issues (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid REFERENCES products(id) ON DELETE SET NULL,
  issue_type text NOT NULL,
  field_name text,
  conflicting_values jsonb NOT NULL DEFAULT '[]'::jsonb,
  evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'reviewing', 'resolved', 'ignored')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS data_quality_issues_status_idx
  ON data_quality_issues(status, created_at DESC);
