CREATE TABLE IF NOT EXISTS lead_capture_drafts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES conversation_sessions(id) ON DELETE CASCADE,
  origin_turn_id uuid NOT NULL REFERENCES conversation_turns(id) ON DELETE CASCADE,
  origin_tool_request_id text NOT NULL,
  purpose text NOT NULL CHECK (length(trim(purpose)) > 0),
  buyer_question text NOT NULL CHECK (length(trim(buyer_question)) > 0),
  preferred_contact text CHECK (preferred_contact IN ('message', 'call')),
  name text,
  phone text,
  email text,
  consent_evidence_hash text NOT NULL CHECK (length(consent_evidence_hash) = 64),
  scope_hash text NOT NULL CHECK (length(scope_hash) = 64),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'consumed', 'cancelled', 'expired')),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '30 minutes'),
  consumed_by_turn_id uuid REFERENCES conversation_turns(id) ON DELETE SET NULL,
  consumed_lead_id uuid REFERENCES leads(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(session_id, origin_turn_id, origin_tool_request_id)
);

CREATE INDEX IF NOT EXISTS lead_capture_drafts_pending_session_idx
  ON lead_capture_drafts(session_id, updated_at DESC)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS lead_capture_drafts_expiry_idx
  ON lead_capture_drafts(expires_at)
  WHERE status = 'pending';
