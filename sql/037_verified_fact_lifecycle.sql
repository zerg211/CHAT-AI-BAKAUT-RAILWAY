ALTER TABLE verified_product_facts ADD COLUMN IF NOT EXISTS valid_until timestamptz;
ALTER TABLE verified_product_facts ADD COLUMN IF NOT EXISTS supersedes_fact_ids uuid[] NOT NULL DEFAULT '{}';
UPDATE verified_product_facts SET valid_until=last_verified_at+interval '90 days' WHERE valid_until IS NULL;
CREATE INDEX IF NOT EXISTS verified_fact_slot_idx ON verified_product_facts(product_key,normalized_attribute) WHERE status='active';
