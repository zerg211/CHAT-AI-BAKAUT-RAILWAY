CREATE TABLE IF NOT EXISTS assistant_feedback_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES conversation_sessions(id) ON DELETE CASCADE,
  turn_id uuid NOT NULL REFERENCES conversation_turns(id) ON DELETE CASCADE,
  user_message_id uuid REFERENCES messages(id) ON DELETE SET NULL,
  assistant_message_id uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  rating text NOT NULL CHECK (rating IN ('negative', 'wrong_cards')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending',
    'in_review',
    'exported',
    'resolved',
    'dismissed'
  )),
  buyer_message text NOT NULL,
  assistant_answer text NOT NULL,
  policy_evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  model_evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  tool_evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
  card_evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
  diagnostic_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  exported_fixture jsonb,
  feedback_created_at timestamptz NOT NULL DEFAULT now(),
  exported_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(assistant_message_id, rating),
  CHECK (length(trim(buyer_message)) > 0),
  CHECK (length(trim(assistant_answer)) > 0),
  CHECK (jsonb_typeof(policy_evidence) = 'object'),
  CHECK (jsonb_typeof(model_evidence) = 'object'),
  CHECK (jsonb_typeof(tool_evidence) = 'array'),
  CHECK (jsonb_typeof(card_evidence) = 'array'),
  CHECK (jsonb_typeof(diagnostic_metadata) = 'object'),
  CHECK (exported_fixture IS NULL OR jsonb_typeof(exported_fixture) = 'object')
);

CREATE INDEX IF NOT EXISTS assistant_feedback_events_queue_idx
  ON assistant_feedback_events(status, created_at ASC);

CREATE INDEX IF NOT EXISTS assistant_feedback_events_rating_queue_idx
  ON assistant_feedback_events(rating, status, created_at ASC);

CREATE INDEX IF NOT EXISTS assistant_feedback_events_turn_idx
  ON assistant_feedback_events(turn_id, created_at DESC);

CREATE INDEX IF NOT EXISTS assistant_feedback_events_policy_version_idx
  ON assistant_feedback_events((policy_evidence->>'version'));

CREATE INDEX IF NOT EXISTS assistant_feedback_events_answer_model_idx
  ON assistant_feedback_events((model_evidence->>'answerModel'));

CREATE INDEX IF NOT EXISTS assistant_feedback_events_tool_evidence_idx
  ON assistant_feedback_events USING gin(tool_evidence);

CREATE INDEX IF NOT EXISTS assistant_feedback_events_card_evidence_idx
  ON assistant_feedback_events USING gin(card_evidence);
