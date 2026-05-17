CREATE TABLE IF NOT EXISTS openai_usage_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  stage text NOT NULL,
  model text NOT NULL,
  request_source text NOT NULL DEFAULT 'unknown',
  session_id uuid REFERENCES conversation_sessions(id) ON DELETE SET NULL,
  turn_id uuid REFERENCES conversation_turns(id) ON DELETE SET NULL,
  page_url text,
  user_agent text,
  input_tokens integer,
  output_tokens integer,
  reasoning_tokens integer,
  total_tokens integer,
  response_id text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS openai_usage_events_created_idx
  ON openai_usage_events(created_at DESC);

CREATE INDEX IF NOT EXISTS openai_usage_events_source_created_idx
  ON openai_usage_events(request_source, created_at DESC);

CREATE INDEX IF NOT EXISTS openai_usage_events_session_created_idx
  ON openai_usage_events(session_id, created_at DESC);
