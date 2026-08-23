-- 020: Fix SUNREKA G7500iSM (11026) — was "с ручным стартером" but actually has electric starter (button START)
-- Audit 2026-08-22: manual-audit-results.json — kuvalda.ru / sadpom.ru confirm "ручной/электрический"
UPDATE products
SET specs = specs || '{"стартер":"ручной и электростартер","электростартер":"есть"}'::jsonb,
    updated_at = now()
WHERE id = '6ad38777-930f-4698-bc5a-d722934721fc';

INSERT INTO verified_product_facts (product_id, product_key, product_name, attribute, value, source_type, source_url, source_title, evidence, confidence, status)
VALUES ('6ad38777-930f-4698-bc5a-d722934721fc', 'g7500ism', 'Генератор бензиновый инверторный SUNREKA G7500iSM (7,0 кВт) 11026', 'electric start электростартер', 'present — есть электростартер (ключ/кнопка), у части моделей дистанционный; ручной резервный', 'web', 'https://www.kuvalda.ru/catalog/1968-bytovye-benzinovye-generatory/product-225194/', 'SUNREKA G7500iSM — kuvalda.ru', 'kuvalda.ru: "Стартер ручной/электрический"; sadpom.ru: "Тип запуска двигателя: Ручной стартер - Электростартер" + "К тому же, генератор оснащен электростартером – запустить генератор можно простым нажатием кнопки START!" (312 см³); masterts.ru: бак 23л, электростартер', 'high', 'active')
ON CONFLICT (product_key, attribute, value, source_type, coalesce(source_url, '')) WHERE status = 'active' DO NOTHING;
