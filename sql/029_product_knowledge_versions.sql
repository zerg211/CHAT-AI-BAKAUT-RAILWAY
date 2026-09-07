-- Technical knowledge depends on exact identity and technical content, not price.
-- Retain the original source hash for old readers and forensic provenance.
ALTER TABLE products ADD COLUMN IF NOT EXISTS identity_version text;
ALTER TABLE products ADD COLUMN IF NOT EXISTS technical_version text;
ALTER TABLE products ADD COLUMN IF NOT EXISTS commercial_version text;
ALTER TABLE verified_product_facts ADD COLUMN IF NOT EXISTS catalog_technical_version text;

CREATE OR REPLACE FUNCTION set_product_knowledge_versions() RETURNS trigger AS $$
BEGIN
  NEW.identity_version := encode(digest(jsonb_build_array(
    NEW.external_id, NEW.source_url, NEW.slug, NEW.name, NEW.brand
  )::text, 'sha256'), 'hex');
  NEW.technical_version := encode(digest(jsonb_build_array(
    NEW.identity_version, NEW.category, NEW.description, NEW.specs
  )::text, 'sha256'), 'hex');
  NEW.commercial_version := encode(digest(jsonb_build_array(
    NEW.price, NEW.currency
  )::text, 'sha256'), 'hex');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS product_knowledge_versions ON products;
CREATE TRIGGER product_knowledge_versions BEFORE INSERT OR UPDATE ON products
FOR EACH ROW EXECUTE FUNCTION set_product_knowledge_versions();

UPDATE products SET name = name WHERE technical_version IS NULL;
-- Only bind legacy facts that are still applicable. Never resurrect stale facts.
UPDATE verified_product_facts f SET catalog_technical_version = p.technical_version
FROM products p WHERE f.product_id = p.id AND f.catalog_technical_version IS NULL
  AND f.catalog_source_hash = p.source_content_hash AND f.status = 'active';

CREATE OR REPLACE FUNCTION bind_verified_fact_technical_version() RETURNS trigger AS $$
BEGIN
  -- Repository writes carry the observed full snapshot. Price-only updates do
  -- not change the technical binding; arbitrary stale snapshots cannot rebind.
  SELECT p.technical_version INTO NEW.catalog_technical_version FROM products p
  WHERE p.id = NEW.product_id AND p.source_content_hash = NEW.catalog_source_hash;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS verified_fact_technical_version ON verified_product_facts;
CREATE TRIGGER verified_fact_technical_version
BEFORE INSERT OR UPDATE OF catalog_source_hash ON verified_product_facts
FOR EACH ROW EXECUTE FUNCTION bind_verified_fact_technical_version();

CREATE INDEX IF NOT EXISTS verified_fact_product_attribute_active_idx
ON verified_product_facts(product_id, attribute, last_verified_at DESC)
WHERE status = 'active';
