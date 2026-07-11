CREATE TABLE IF NOT EXISTS openai_usage_reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bucket text NOT NULL,
  stage text NOT NULL,
  model text NOT NULL,
  request_source text NOT NULL,
  session_id uuid REFERENCES conversation_sessions(id) ON DELETE SET NULL,
  turn_id uuid REFERENCES conversation_turns(id) ON DELETE SET NULL,
  reserved_tokens integer NOT NULL CHECK (reserved_tokens > 0),
  actual_tokens integer CHECK (actual_tokens IS NULL OR actual_tokens >= 0),
  status text NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved', 'reconciled', 'released')),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS openai_usage_reservations_active_idx
  ON openai_usage_reservations(bucket, expires_at)
  WHERE status = 'reserved';

CREATE INDEX IF NOT EXISTS openai_usage_reservations_created_idx
  ON openai_usage_reservations(created_at DESC);
