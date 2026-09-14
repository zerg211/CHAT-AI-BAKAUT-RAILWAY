-- A text hash describes the embedding input, not the current source revision.
-- Legacy vectors have unknown provenance and remain available for bounded
-- backfill; lexical retrieval continues while they are being checked/rebuilt.
ALTER TABLE catalog_pages ADD COLUMN IF NOT EXISTS embedding_source_revision text;
