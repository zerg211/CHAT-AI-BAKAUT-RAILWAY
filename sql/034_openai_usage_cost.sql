ALTER TABLE openai_usage_events
  ADD COLUMN IF NOT EXISTS cost_usd numeric(12, 6);

CREATE INDEX IF NOT EXISTS openai_usage_events_turn_cost_idx
  ON openai_usage_events(turn_id, created_at DESC)
  WHERE turn_id IS NOT NULL;
