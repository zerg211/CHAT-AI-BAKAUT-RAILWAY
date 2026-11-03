CREATE TABLE IF NOT EXISTS platform_agent_sessions (
  session_id uuid PRIMARY KEY REFERENCES conversation_sessions(id) ON DELETE CASCADE,
  agent_session_id text NOT NULL,
  next_cursor text,
  seen_product_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);
