ALTER TABLE conversation_turns
  ADD COLUMN IF NOT EXISTS deadline_at timestamptz,
  ADD COLUMN IF NOT EXISTS recovery_attempts integer NOT NULL DEFAULT 0;

UPDATE conversation_turns
SET deadline_at = created_at + interval '60 seconds'
WHERE deadline_at IS NULL;

ALTER TABLE conversation_turns
  ALTER COLUMN deadline_at SET NOT NULL;

ALTER TABLE conversation_turns
  ADD CONSTRAINT conversation_turns_recovery_attempts_nonnegative
  CHECK (recovery_attempts >= 0);
