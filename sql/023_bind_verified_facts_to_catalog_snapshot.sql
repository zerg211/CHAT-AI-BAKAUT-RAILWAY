-- 023: Bind legacy catalog rows and imported verified facts to the current snapshot.
-- Older restored rows have no source_content_hash, so their active facts are
-- intentionally ignored by searchVerifiedProductFacts until this marker exists.
-- jsonb text is canonical in PostgreSQL, which makes this marker deterministic
-- for the stored legacy row; future catalog syncs use the normal source hash.
ALTER TABLE verified_product_facts
  ADD COLUMN IF NOT EXISTS catalog_source_hash text;

UPDATE products
SET source_content_hash = encode(
  digest(
    concat_ws(
      E'\x1f',
      coalesce(external_id, ''),
      coalesce(source_url, ''),
      coalesce(slug, ''),
      coalesce(name, ''),
      coalesce(brand, ''),
      coalesce(category, ''),
      coalesce(price::text, ''),
      coalesce(currency, ''),
      coalesce(image_url, ''),
      coalesce(description, ''),
      specs::text,
      raw::text,
      coalesce(source_priority::text, '')
    ),
    'sha256'
  ),
  'hex'
)
WHERE source_content_hash IS NULL;

UPDATE verified_product_facts AS fact
SET catalog_source_hash = product.source_content_hash,
    updated_at = now()
FROM products AS product
WHERE fact.product_id = product.id
  AND fact.status = 'active'
  AND fact.catalog_source_hash IS NULL
  AND product.source_content_hash IS NOT NULL;
