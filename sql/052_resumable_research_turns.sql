ALTER TABLE conversation_turns ALTER COLUMN deadline_at DROP NOT NULL;

COMMENT ON COLUMN conversation_turns.deadline_at IS
  'Absolute deadline for bounded legacy turns; NULL for resumable research governed by leases, cancellation and usage budgets.';
