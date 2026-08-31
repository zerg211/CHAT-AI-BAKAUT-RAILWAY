ALTER TABLE verified_product_facts
  ADD COLUMN IF NOT EXISTS source_tier text,
  ADD COLUMN IF NOT EXISTS source_authority text,
  ADD COLUMN IF NOT EXISTS observed_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE verified_product_facts
  DROP CONSTRAINT IF EXISTS verified_product_facts_source_tier_check,
  ADD CONSTRAINT verified_product_facts_source_tier_check
    CHECK (source_tier IS NULL OR source_tier IN ('official_page', 'official_manual', 'reliable_secondary')),
  DROP CONSTRAINT IF EXISTS verified_product_facts_source_authority_check,
  ADD CONSTRAINT verified_product_facts_source_authority_check
    CHECK (source_authority IS NULL OR source_authority IN ('manufacturer', 'secondary'));
