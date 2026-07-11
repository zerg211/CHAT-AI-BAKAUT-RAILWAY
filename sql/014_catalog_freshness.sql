ALTER TABLE products
  ADD COLUMN IF NOT EXISTS last_seen_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_synced_at timestamptz,
  ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS source_content_hash text;

UPDATE products
SET last_seen_at = coalesce(last_seen_at, updated_at, created_at),
    last_synced_at = coalesce(last_synced_at, updated_at, created_at)
WHERE last_seen_at IS NULL OR last_synced_at IS NULL;

ALTER TABLE products
  ALTER COLUMN last_seen_at SET DEFAULT now(),
  ALTER COLUMN last_seen_at SET NOT NULL,
  ALTER COLUMN last_synced_at SET DEFAULT now(),
  ALTER COLUMN last_synced_at SET NOT NULL;

ALTER TABLE catalog_pages
  ADD COLUMN IF NOT EXISTS last_seen_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_synced_at timestamptz,
  ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS source_content_hash text;

UPDATE catalog_pages
SET last_seen_at = coalesce(last_seen_at, updated_at, created_at),
    last_synced_at = coalesce(last_synced_at, updated_at, created_at)
WHERE last_seen_at IS NULL OR last_synced_at IS NULL;

ALTER TABLE catalog_pages
  ALTER COLUMN last_seen_at SET DEFAULT now(),
  ALTER COLUMN last_seen_at SET NOT NULL,
  ALTER COLUMN last_synced_at SET DEFAULT now(),
  ALTER COLUMN last_synced_at SET NOT NULL;

CREATE TABLE IF NOT EXISTS catalog_sync_runs (
  id uuid PRIMARY KEY REFERENCES catalog_sources(id) ON DELETE CASCADE,
  source_type text NOT NULL CHECK (length(trim(source_type)) > 0),
  source_location text NOT NULL CHECK (length(trim(source_location)) > 0),
  lock_identity text NOT NULL CHECK (length(trim(lock_identity)) > 0),
  sync_mode text NOT NULL CHECK (sync_mode IN ('full', 'partial')),
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'completed', 'failed')),
  coverage_complete boolean NOT NULL DEFAULT false,
  discovered_item_count integer NOT NULL DEFAULT 0 CHECK (discovered_item_count >= 0),
  synced_item_count integer NOT NULL DEFAULT 0 CHECK (synced_item_count >= 0),
  failed_item_count integer NOT NULL DEFAULT 0 CHECK (failed_item_count >= 0),
  deactivated_item_count integer NOT NULL DEFAULT 0 CHECK (deactivated_item_count >= 0),
  stats jsonb NOT NULL DEFAULT '{}'::jsonb,
  error text,
  started_at timestamptz NOT NULL DEFAULT now(),
  heartbeat_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  deactivation_eligible boolean GENERATED ALWAYS AS (
    sync_mode = 'full'
    AND status = 'completed'
    AND coverage_complete
    AND failed_item_count = 0
    AND discovered_item_count > 0
    AND synced_item_count > 0
    AND synced_item_count = discovered_item_count
    AND finished_at IS NOT NULL
  ) STORED,
  deactivation_applied_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (status = 'running' AND finished_at IS NULL)
    OR (status IN ('completed', 'failed') AND finished_at IS NOT NULL)
  ),
  CHECK (
    deactivation_applied_at IS NULL
    OR (
      sync_mode = 'full'
      AND status = 'completed'
      AND coverage_complete
      AND failed_item_count = 0
      AND discovered_item_count > 0
      AND synced_item_count > 0
      AND synced_item_count = discovered_item_count
      AND finished_at IS NOT NULL
    )
  ),
  CHECK (deactivated_item_count = 0 OR deactivation_applied_at IS NOT NULL)
);

CREATE OR REPLACE FUNCTION catalog_sync_advisory_key(identity text)
RETURNS bigint
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT hashtextextended(identity, 0);
$$;

CREATE INDEX IF NOT EXISTS products_catalog_freshness_idx
  ON products(is_active, last_seen_at DESC);

CREATE INDEX IF NOT EXISTS catalog_pages_freshness_idx
  ON catalog_pages(is_active, last_seen_at DESC);

CREATE INDEX IF NOT EXISTS catalog_sync_runs_source_finished_idx
  ON catalog_sync_runs(source_type, source_location, finished_at DESC);

CREATE INDEX IF NOT EXISTS catalog_sync_runs_status_started_idx
  ON catalog_sync_runs(status, started_at DESC);

CREATE INDEX IF NOT EXISTS catalog_sync_runs_running_lock_idx
  ON catalog_sync_runs(lock_identity, started_at DESC)
  WHERE status = 'running';

COMMENT ON COLUMN products.last_seen_at IS
  'Last time a source inventory observed this product, even when its content was unchanged.';
COMMENT ON COLUMN products.last_synced_at IS
  'Last time this product was processed successfully by a catalog sync.';
COMMENT ON COLUMN products.is_active IS
  'May be set false only after a complete successful full sync proves the source record is absent.';
COMMENT ON COLUMN products.source_content_hash IS
  'Hash of canonical source content used to skip unchanged catalog processing safely.';

COMMENT ON COLUMN catalog_pages.last_seen_at IS
  'Last time a source inventory observed this page, even when its content was unchanged.';
COMMENT ON COLUMN catalog_pages.last_synced_at IS
  'Last time this page was processed successfully by a catalog sync.';
COMMENT ON COLUMN catalog_pages.is_active IS
  'May be set false only after a complete successful full sync proves the source record is absent.';
COMMENT ON COLUMN catalog_pages.source_content_hash IS
  'Hash of canonical source content used to skip unchanged catalog processing safely.';

COMMENT ON TABLE catalog_sync_runs IS
  'Catalog sync lifecycle ledger. Acquire pg_try_advisory_lock(catalog_sync_advisory_key(lock_identity)) before starting a run with the same identity.';
COMMENT ON COLUMN catalog_sync_runs.deactivation_eligible IS
  'True only for completed, coverage-complete, failure-free full syncs.';
