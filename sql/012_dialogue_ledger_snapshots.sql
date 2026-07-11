CREATE SEQUENCE IF NOT EXISTS dialogue_ledger_event_seq_seq;

ALTER TABLE dialogue_ledger_events
  ADD COLUMN IF NOT EXISTS event_seq bigint;

ALTER SEQUENCE dialogue_ledger_event_seq_seq
  OWNED BY dialogue_ledger_events.event_seq;

ALTER TABLE dialogue_ledger_events
  ALTER COLUMN event_seq SET DEFAULT nextval('dialogue_ledger_event_seq_seq');

WITH current_max AS (
  SELECT coalesce(max(event_seq), 0) AS max_seq
  FROM dialogue_ledger_events
),
numbered AS (
  SELECT id,
         row_number() OVER (ORDER BY created_at ASC, id ASC) AS row_seq
  FROM dialogue_ledger_events
  WHERE event_seq IS NULL
)
UPDATE dialogue_ledger_events AS event
SET event_seq = current_max.max_seq + numbered.row_seq
FROM current_max, numbered
WHERE event.id = numbered.id;

SELECT setval(
  'dialogue_ledger_event_seq_seq',
  greatest(coalesce((SELECT max(event_seq) FROM dialogue_ledger_events), 0), 1),
  coalesce((SELECT max(event_seq) FROM dialogue_ledger_events), 0) > 0
);

ALTER TABLE dialogue_ledger_events
  ALTER COLUMN event_seq SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS dialogue_ledger_events_event_seq_idx
  ON dialogue_ledger_events(event_seq);

CREATE INDEX IF NOT EXISTS dialogue_ledger_events_session_event_seq_idx
  ON dialogue_ledger_events(session_id, event_seq);

CREATE TABLE IF NOT EXISTS dialogue_ledger_snapshots (
  session_id uuid PRIMARY KEY REFERENCES conversation_sessions(id) ON DELETE CASCADE,
  through_event_seq bigint NOT NULL,
  event_count integer NOT NULL CHECK (event_count >= 0),
  state jsonb NOT NULL,
  recent_events jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS dialogue_ledger_snapshots_updated_idx
  ON dialogue_ledger_snapshots(updated_at DESC);
