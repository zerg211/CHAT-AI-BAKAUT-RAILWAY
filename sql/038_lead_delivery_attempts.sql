CREATE TABLE IF NOT EXISTS lead_delivery_attempts (
  outbox_id uuid NOT NULL REFERENCES lead_outbox(id) ON DELETE CASCADE,
  lease_token uuid NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  received_at timestamptz,
  provider_operation_id text,
  PRIMARY KEY(outbox_id, lease_token)
);
CREATE INDEX IF NOT EXISTS lead_delivery_attempts_started_idx ON lead_delivery_attempts(started_at);
