CREATE TABLE IF NOT EXISTS verified_product_facts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid REFERENCES products(id) ON DELETE SET NULL,
  product_key text NOT NULL,
  product_name text NOT NULL,
  attribute text NOT NULL,
  value text NOT NULL,
  source_type text NOT NULL CHECK (source_type IN ('web', 'catalog', 'manual')),
  source_url text,
  source_title text,
  evidence text,
  confidence text NOT NULL CHECK (confidence IN ('high', 'medium', 'low')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'superseded', 'rejected')),
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_verified_at timestamptz NOT NULL DEFAULT now(),
  hit_count integer NOT NULL DEFAULT 0,
  catalog_source_hash text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS verified_product_facts_unique_active_idx
  ON verified_product_facts(product_key, attribute, value, source_type, coalesce(source_url, ''), status);

CREATE INDEX IF NOT EXISTS verified_product_facts_key_status_idx
  ON verified_product_facts(product_key, status, last_verified_at DESC);

CREATE INDEX IF NOT EXISTS verified_product_facts_product_status_idx
  ON verified_product_facts(product_id, status, last_verified_at DESC)
  WHERE product_id IS NOT NULL;
