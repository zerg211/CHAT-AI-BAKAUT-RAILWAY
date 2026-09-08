CREATE TABLE IF NOT EXISTS admin_mutation_audit (
  id uuid PRIMARY KEY,
  actor text NOT NULL,
  scope text NOT NULL,
  operation text NOT NULL,
  resource text NOT NULL,
  request_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  http_status integer CHECK (http_status BETWEEN 100 AND 599)
);
CREATE INDEX IF NOT EXISTS admin_mutation_audit_created_idx ON admin_mutation_audit(created_at DESC);
