ALTER TABLE lead_outbox
  ADD COLUMN IF NOT EXISTS lease_token uuid,
  ADD COLUMN IF NOT EXISTS leased_until timestamptz,
  ADD COLUMN IF NOT EXISTS first_attempt_at timestamptz,
  ADD COLUMN IF NOT EXISTS request_snapshot jsonb,
  ADD COLUMN IF NOT EXISTS provider_operation_id text;
