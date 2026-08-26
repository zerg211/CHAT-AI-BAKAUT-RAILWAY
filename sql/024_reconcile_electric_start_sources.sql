-- 024: Reconcile electric-start enrichment with the catalog sources in 021.
-- 021 is explicit that G3500i, G4000iS and ET5500iS use a manual starter;
-- 019 incorrectly added an electric-starter key/fact for those same cards.

UPDATE products
SET specs = CASE
      WHEN source_url IN (
        'https://bakautprof.ru/catalog/invertornye_generatory/generator_benzinovyy_invertornyy_sunreka_g3500i_3_5_kvt/',
        'https://bakautprof.ru/catalog/invertornye_generatory/generator_benzinovyy_invertornyy_sunreka_g4000is_3_5_kvt/'
      ) THEN specs - 'электростартер'
      WHEN source_url = 'https://bakautprof.ru/catalog/invertornye_generatory/generator_benzinovyy_invertornyy_et_power_et5500is_5_0_kvt/' THEN
        (specs - 'электростартер' - 'стартер')
        || jsonb_build_object('стартер', coalesce(specs->>'запуск', 'ручной стартер'))
      ELSE specs
    END,
    embedding = NULL,
    embedding_model = NULL,
    embedding_source_hash = NULL,
    embedding_updated_at = NULL,
    updated_at = now()
WHERE source_url IN (
  'https://bakautprof.ru/catalog/invertornye_generatory/generator_benzinovyy_invertornyy_sunreka_g3500i_3_5_kvt/',
  'https://bakautprof.ru/catalog/invertornye_generatory/generator_benzinovyy_invertornyy_sunreka_g4000is_3_5_kvt/',
  'https://bakautprof.ru/catalog/invertornye_generatory/generator_benzinovyy_invertornyy_et_power_et5500is_5_0_kvt/'
);

UPDATE verified_product_facts
SET status = 'superseded',
    updated_at = now()
WHERE status = 'active'
  AND source_type = 'web'
  AND attribute = 'electric start электростартер'
  AND (
    (product_key = 'g3500i' AND source_url = 'https://sunreka-market.ru/category/invertornye-generatory/')
    OR (product_key = 'g4000is' AND source_url = 'https://sunreka-market.ru/category/invertornye-generatory/')
    OR (product_key = 'et5500is' AND source_url = 'https://stabhouse.ru/shop/39286/desc/invertornyj-generator-et-power-et5500is')
  );

-- Keep the marker compatible with the legacy marker created by 023 after the
-- catalog specs correction. The normal catalog sync will use its source hash.
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
WHERE source_url IN (
  'https://bakautprof.ru/catalog/invertornye_generatory/generator_benzinovyy_invertornyy_sunreka_g3500i_3_5_kvt/',
  'https://bakautprof.ru/catalog/invertornye_generatory/generator_benzinovyy_invertornyy_sunreka_g4000is_3_5_kvt/',
  'https://bakautprof.ru/catalog/invertornye_generatory/generator_benzinovyy_invertornyy_et_power_et5500is_5_0_kvt/'
);

UPDATE verified_product_facts AS fact
SET catalog_source_hash = product.source_content_hash,
    updated_at = now()
FROM products AS product
WHERE fact.product_id = product.id
  AND fact.status = 'active'
  AND product.source_url IN (
    'https://bakautprof.ru/catalog/invertornye_generatory/generator_benzinovyy_invertornyy_sunreka_g3500i_3_5_kvt/',
    'https://bakautprof.ru/catalog/invertornye_generatory/generator_benzinovyy_invertornyy_sunreka_g4000is_3_5_kvt/',
    'https://bakautprof.ru/catalog/invertornye_generatory/generator_benzinovyy_invertornyy_et_power_et5500is_5_0_kvt/'
  );
