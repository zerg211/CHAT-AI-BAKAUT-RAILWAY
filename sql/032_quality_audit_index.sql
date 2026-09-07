CREATE INDEX IF NOT EXISTS conversation_turns_created_idx ON conversation_turns(created_at DESC);
CREATE INDEX IF NOT EXISTS agent_traces_turn_created_idx ON agent_traces(turn_id,created_at DESC);
