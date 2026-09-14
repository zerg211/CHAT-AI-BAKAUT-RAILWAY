ALTER TABLE products ADD COLUMN IF NOT EXISTS price_observed_at timestamptz;
ALTER TABLE products ADD COLUMN IF NOT EXISTS price_on_request boolean NOT NULL DEFAULT false;
ALTER TABLE products ADD COLUMN IF NOT EXISTS price_observation_source_type text;
UPDATE products SET price_observed_at=price_verified_at,
  price_observation_source_type=CASE WHEN price_verified_at IS NOT NULL THEN 'site'
    WHEN raw->>'sourceType'='csv' THEN 'csv' ELSE 'site' END
WHERE price_observation_source_type IS NULL;

-- One invariant for every writer, including imports and future SQL callers.
-- A missing parser field is not an observed withdrawal. An unordered conflicting
-- observation cannot replace a known price merely by finishing later.
CREATE OR REPLACE FUNCTION enforce_product_price_observation() RETURNS trigger AS $$
DECLARE
  preserve_old boolean := false;
  same_value boolean;
BEGIN
  IF NEW.price_on_request AND NEW.price_observed_at IS NULL THEN
    RAISE EXCEPTION 'price withdrawal requires observation time' USING ERRCODE='22023';
  END IF;
  IF NEW.price_on_request THEN NEW.price := NULL; END IF;
  IF TG_OP='UPDATE' THEN
    same_value := ROW(NEW.price,NEW.currency,NEW.price_on_request)
      IS NOT DISTINCT FROM ROW(OLD.price,OLD.currency,OLD.price_on_request);
    preserve_old := (NEW.price IS NULL AND NOT NEW.price_on_request)
      OR (OLD.price_observed_at IS NOT NULL AND
        (NEW.price_observed_at IS NULL OR NEW.price_observed_at < OLD.price_observed_at
          OR (NEW.price_observed_at = OLD.price_observed_at AND NOT same_value)))
      OR (OLD.price_observed_at IS NULL AND NEW.price_observed_at IS NULL
        AND OLD.price IS NOT NULL AND NOT same_value);
    IF preserve_old THEN
      NEW.price := OLD.price;
      NEW.currency := OLD.currency;
      NEW.price_on_request := OLD.price_on_request;
      NEW.price_observed_at := OLD.price_observed_at;
      NEW.price_verified_at := OLD.price_verified_at;
      NEW.price_source_url := OLD.price_source_url;
      NEW.price_observation_source_type := OLD.price_observation_source_type;
    ELSIF same_value AND NEW.price_verified_at IS NULL THEN
      -- Keep the old proof with its original date, never refresh it on a hit.
      NEW.price_verified_at := OLD.price_verified_at;
      NEW.price_source_url := OLD.price_source_url;
    ELSIF NOT same_value AND (NEW.price_verified_at IS NULL
      OR NEW.price_verified_at IS DISTINCT FROM NEW.price_observed_at
      OR NEW.price_source_url IS DISTINCT FROM NEW.source_url) THEN
      NEW.price_verified_at := NULL;
      NEW.price_source_url := NULL;
    END IF;
  END IF;
  IF NEW.price IS NULL THEN NEW.price_verified_at := NULL; NEW.price_source_url := NULL; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER a_product_price_observation BEFORE INSERT OR UPDATE ON products
FOR EACH ROW EXECUTE FUNCTION enforce_product_price_observation();

-- price is a derived current-state fact, not a second independent price writer.
CREATE OR REPLACE FUNCTION mirror_current_product_price() RETURNS trigger AS $$
BEGIN
  DELETE FROM product_facts WHERE product_id=NEW.id AND attribute='price';
  IF NEW.price IS NOT NULL THEN
    INSERT INTO product_facts(product_id,attribute,value,unit,source_type,source_url,confidence)
    VALUES(NEW.id,'price',NEW.price::text,NEW.currency,
      coalesce(NEW.price_observation_source_type,'site'),
      coalesce(NEW.price_source_url,NEW.source_url),
      CASE WHEN NEW.price_verified_at IS NOT NULL THEN 0.95 ELSE 0.65 END);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER product_price_fact_mirror AFTER INSERT OR UPDATE OF price,currency,price_verified_at,price_source_url ON products
FOR EACH ROW EXECUTE FUNCTION mirror_current_product_price();
