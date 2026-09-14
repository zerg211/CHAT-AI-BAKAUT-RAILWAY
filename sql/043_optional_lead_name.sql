-- A permitted phone/email is sufficient for delivery; do not fabricate a customer name.
ALTER TABLE leads ALTER COLUMN name DROP NOT NULL;
