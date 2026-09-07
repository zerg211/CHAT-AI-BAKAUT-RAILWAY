ALTER TABLE products ADD COLUMN IF NOT EXISTS price_verified_at timestamptz;
ALTER TABLE products ADD COLUMN IF NOT EXISTS price_source_url text;
