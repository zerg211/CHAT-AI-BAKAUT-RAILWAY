CREATE TABLE IF NOT EXISTS troubleshooting_cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  model text NOT NULL,
  model_key text NOT NULL,
  fault_codes text[] NOT NULL DEFAULT '{}'::text[],
  problem_summary text NOT NULL,
  problem_key text NOT NULL,
  answer text NOT NULL,
  source_urls text[] NOT NULL DEFAULT '{}'::text[],
  source_titles text[] NOT NULL DEFAULT '{}'::text[],
  confidence numeric(3, 2) NOT NULL DEFAULT 0.75,
  embedding vector(1536),
  first_seen_message text,
  hit_count integer NOT NULL DEFAULT 0,
  last_used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(model_key, problem_key)
);

CREATE INDEX IF NOT EXISTS troubleshooting_cases_model_key_idx ON troubleshooting_cases(model_key);
CREATE INDEX IF NOT EXISTS troubleshooting_cases_fault_codes_idx ON troubleshooting_cases USING gin(fault_codes);
CREATE INDEX IF NOT EXISTS troubleshooting_cases_embedding_idx ON troubleshooting_cases USING ivfflat (embedding vector_cosine_ops) WITH (lists = 50);
