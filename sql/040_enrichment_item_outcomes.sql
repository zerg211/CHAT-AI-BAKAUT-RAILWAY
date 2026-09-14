ALTER TABLE verified_fact_enrichment_jobs
  ADD COLUMN IF NOT EXISTS item_outcomes jsonb NOT NULL DEFAULT '{}'::jsonb;
