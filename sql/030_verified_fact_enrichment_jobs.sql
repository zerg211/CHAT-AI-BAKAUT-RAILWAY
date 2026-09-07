CREATE TABLE IF NOT EXISTS verified_fact_enrichment_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dedupe_key text NOT NULL UNIQUE,
  facts jsonb NOT NULL CHECK (jsonb_typeof(facts) = 'array'),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','completed','failed')),
  attempts integer NOT NULL DEFAULT 0,
  lease_token uuid,
  available_at timestamptz NOT NULL DEFAULT now(),
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
CREATE INDEX IF NOT EXISTS verified_fact_enrichment_due_idx
ON verified_fact_enrichment_jobs(available_at) WHERE status IN ('pending','processing');
ALTER TABLE verified_product_facts ADD COLUMN IF NOT EXISTS normalized_attribute text;
ALTER TABLE verified_product_facts ADD COLUMN IF NOT EXISTS normalized_value jsonb;
