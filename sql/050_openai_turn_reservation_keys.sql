ALTER TABLE openai_usage_reservations ADD COLUMN IF NOT EXISTS operation_key text;

CREATE UNIQUE INDEX IF NOT EXISTS openai_usage_reservations_turn_operation_unique
  ON openai_usage_reservations (session_id, turn_id, operation_key)
  WHERE operation_key IS NOT NULL;
