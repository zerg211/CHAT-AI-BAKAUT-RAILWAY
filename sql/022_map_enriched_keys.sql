-- 022: Map enriched English specs to Russian catalog keys for filtering/display
-- After 021 added English keys (maxPower etc.), copy them to the Russian keys the catalog and bot expect.

UPDATE products SET specs = specs || jsonb_build_object(
  'max. мощность, квт', coalesce(specs->>'maxPower', specs->>'мощность_максимальная', specs->>'max. мощность, квт'),
  'мощность номинальная', coalesce(specs->>'ratedPower', specs->>'мощность_номинальная', specs->>'мощность номинальная'),
  'стартер', coalesce(specs->>'starter', specs->>'запуск', specs->>'стартер'),
  'тип двигателя', coalesce(specs->>'engineType', specs->>'тип двигателя'),
  'модель двигателя', coalesce(specs->>'engineModel', specs->>'двигатель', specs->>'модель двигателя'),
  'бак, л', coalesce(specs->>'tankL', specs->>'бак', specs->>'емкость топливного бака, л'),
  'расход топлива, л/ч', coalesce(specs->>'fuelConsumption', specs->>'fuelConsumption25_50_75_100', specs->>'расход_топлива', specs->>'расход топлива, л/ч'),
  'вес, кг', coalesce(specs->>'weightKg', specs->>'масса', specs->>'вес, кг'),
  'габариты, мм', coalesce(specs->>'dimensionsMm', specs->>'габариты', specs->>'габариты без упаковки (д/ш/в), мм')
) WHERE specs ? 'maxPower' OR specs ? 'ratedPower' OR specs ? 'engineType';

-- Ensure search_tsv is refreshed (generated column will auto-update, but force updated_at touch for reindex if needed)
UPDATE products SET updated_at = now() WHERE specs ? 'maxPower';
