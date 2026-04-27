CREATE SEQUENCE IF NOT EXISTS conversation_sessions_number_seq;

ALTER TABLE conversation_sessions
  ADD COLUMN IF NOT EXISTS conversation_number bigint,
  ADD COLUMN IF NOT EXISTS topic text,
  ADD COLUMN IF NOT EXISTS title text;

WITH max_existing AS (
  SELECT coalesce(max(conversation_number), 0) AS base
  FROM conversation_sessions
),
numbered AS (
  SELECT
    s.id,
    max_existing.base + row_number() OVER (ORDER BY s.created_at, s.id) AS next_number
  FROM conversation_sessions s
  CROSS JOIN max_existing
  WHERE s.conversation_number IS NULL
)
UPDATE conversation_sessions s
SET conversation_number = numbered.next_number
FROM numbered
WHERE s.id = numbered.id;

UPDATE conversation_sessions
SET title = 'Диалог #' || conversation_number
WHERE title IS NULL OR btrim(title) = '' OR btrim(title) = 'Диалог';

DO $$
DECLARE
  max_num bigint;
BEGIN
  SELECT coalesce(max(conversation_number), 0) INTO max_num FROM conversation_sessions;
  IF max_num > 0 THEN
    PERFORM setval('conversation_sessions_number_seq', max_num, true);
  ELSE
    PERFORM setval('conversation_sessions_number_seq', 1, false);
  END IF;
END $$;

ALTER TABLE conversation_sessions
  ALTER COLUMN conversation_number SET DEFAULT nextval('conversation_sessions_number_seq'),
  ALTER COLUMN conversation_number SET NOT NULL,
  ALTER COLUMN title SET DEFAULT 'Диалог',
  ALTER COLUMN title SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS conversation_sessions_number_unique_idx
  ON conversation_sessions(conversation_number);

CREATE INDEX IF NOT EXISTS conversation_sessions_freshness_idx
  ON conversation_sessions(updated_at DESC, conversation_number DESC);
