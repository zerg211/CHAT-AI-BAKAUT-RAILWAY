ALTER TABLE verified_product_facts
ADD COLUMN IF NOT EXISTS evidence_verified_exact boolean NOT NULL DEFAULT false;
