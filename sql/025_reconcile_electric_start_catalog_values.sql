-- 025: Remove the stale catalog starter text left by 019.
-- The current catalog enrichment in 021 identifies these three cards as manual-start.

UPDATE products
SET specs = specs || jsonb_build_object('стартер', 'ручной стартер'),
    embedding = NULL,
    embedding_model = NULL,
    embedding_source_hash = NULL,
    embedding_updated_at = NULL,
    updated_at = now()
WHERE source_url IN (
  'https://bakautprof.ru/catalog/invertornye_generatory/generator_benzinovyy_invertornyy_sunreka_g3500i_3_5_kvt/',
  'https://bakautprof.ru/catalog/invertornye_generatory/generator_benzinovyy_invertornyy_sunreka_g4000is_3_5_kvt/',
  'https://bakautprof.ru/catalog/invertornye_generatory/generator_benzinovyy_invertornyy_et_power_et5500is_5_0_kvt/'
)
  AND specs->>'стартер' = 'ручной и электростартер';

UPDATE product_facts AS fact
SET value = 'ручной стартер'
FROM products AS product
WHERE fact.product_id = product.id
  AND fact.source_url = product.source_url
  AND fact.attribute = 'стартер'
  AND fact.value = 'ручной и электростартер'
  AND product.source_url IN (
    'https://bakautprof.ru/catalog/invertornye_generatory/generator_benzinovyy_invertornyy_sunreka_g3500i_3_5_kvt/',
    'https://bakautprof.ru/catalog/invertornye_generatory/generator_benzinovyy_invertornyy_sunreka_g4000is_3_5_kvt/',
    'https://bakautprof.ru/catalog/invertornye_generatory/generator_benzinovyy_invertornyy_et_power_et5500is_5_0_kvt/'
  );

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
