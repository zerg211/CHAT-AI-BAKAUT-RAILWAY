ALTER TABLE conversation_turns
  ALTER COLUMN deadline_at SET DEFAULT now() + interval '85 seconds';
