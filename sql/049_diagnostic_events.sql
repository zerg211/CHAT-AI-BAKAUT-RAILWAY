-- Private, content-free diagnostic journal. No FK: retain technical evidence if
-- a business row expires; never cascade diagnostics into customer state.
CREATE TABLE IF NOT EXISTS diagnostic_events (
  id bigserial PRIMARY KEY,
  event_id uuid NOT NULL UNIQUE,
  occurred_at timestamptz NOT NULL,
  execution_id text,
  request_id text,
  turn_id text,
  event_seq bigint NOT NULL,
  payload jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS diagnostic_events_turn_id_idx ON diagnostic_events(turn_id,id);
CREATE INDEX IF NOT EXISTS diagnostic_events_execution_id_idx ON diagnostic_events(execution_id,id);
CREATE INDEX IF NOT EXISTS diagnostic_events_request_id_idx ON diagnostic_events(request_id,id);
CREATE INDEX IF NOT EXISTS diagnostic_events_occurred_idx ON diagnostic_events(occurred_at);
CREATE INDEX IF NOT EXISTS diagnostic_events_provider_request_idx ON diagnostic_events((payload->>'providerRequestId'),id);
