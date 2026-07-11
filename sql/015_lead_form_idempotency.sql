ALTER TABLE leads ADD COLUMN IF NOT EXISTS client_lead_id uuid;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS client_request_hash text;

CREATE UNIQUE INDEX IF NOT EXISTS leads_session_client_lead_id_idx
  ON leads(session_id, client_lead_id)
  WHERE client_lead_id IS NOT NULL;

ALTER TABLE lead_outbox ALTER COLUMN turn_id DROP NOT NULL;
