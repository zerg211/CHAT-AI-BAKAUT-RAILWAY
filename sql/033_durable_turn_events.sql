CREATE SEQUENCE IF NOT EXISTS turn_event_seq_seq;

CREATE TABLE IF NOT EXISTS turn_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES conversation_sessions(id) ON DELETE CASCADE,
  turn_id uuid NOT NULL REFERENCES conversation_turns(id) ON DELETE CASCADE,
  seq bigint NOT NULL DEFAULT nextval('turn_event_seq_seq'),
  stage text NOT NULL,
  event_type text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(turn_id, seq)
);

CREATE INDEX IF NOT EXISTS turn_events_turn_seq_idx
  ON turn_events(turn_id, seq);

CREATE INDEX IF NOT EXISTS turn_events_session_turn_seq_idx
  ON turn_events(session_id, turn_id, seq);
