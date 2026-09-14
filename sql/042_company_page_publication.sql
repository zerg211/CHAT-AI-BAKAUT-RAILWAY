ALTER TABLE catalog_pages ADD COLUMN IF NOT EXISTS source_observed_at timestamptz;
ALTER TABLE verified_fact_enrichment_jobs ADD COLUMN IF NOT EXISTS page_payload jsonb
  CHECK (page_payload IS NULL OR jsonb_typeof(page_payload) = 'object');
ALTER TABLE verified_fact_enrichment_jobs ADD CONSTRAINT company_page_job_has_no_product_items
  CHECK (page_payload IS NULL OR facts = '[]'::jsonb);
