ALTER TABLE openai_usage_reservations ADD COLUMN IF NOT EXISTS monetary_reserved_nano numeric(38,0);
ALTER TABLE openai_usage_reservations ADD COLUMN IF NOT EXISTS monetary_policy_version text;
