ALTER TABLE products
  ADD COLUMN IF NOT EXISTS embedding_model text,
  ADD COLUMN IF NOT EXISTS embedding_source_hash text,
  ADD COLUMN IF NOT EXISTS embedding_updated_at timestamptz;

ALTER TABLE catalog_pages
  ADD COLUMN IF NOT EXISTS embedding_model text,
  ADD COLUMN IF NOT EXISTS embedding_source_hash text,
  ADD COLUMN IF NOT EXISTS embedding_updated_at timestamptz;

ALTER TABLE troubleshooting_cases
  ADD COLUMN IF NOT EXISTS embedding_model text,
  ADD COLUMN IF NOT EXISTS embedding_source_hash text,
  ADD COLUMN IF NOT EXISTS embedding_updated_at timestamptz;

CREATE INDEX IF NOT EXISTS products_embedding_metadata_idx
  ON products(embedding_model, embedding_updated_at)
  WHERE embedding IS NOT NULL;

CREATE INDEX IF NOT EXISTS catalog_pages_embedding_metadata_idx
  ON catalog_pages(embedding_model, embedding_updated_at)
  WHERE embedding IS NOT NULL;

CREATE INDEX IF NOT EXISTS troubleshooting_cases_embedding_metadata_idx
  ON troubleshooting_cases(embedding_model, embedding_updated_at)
  WHERE embedding IS NOT NULL;
