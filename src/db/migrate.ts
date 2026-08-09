import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { pool } from './pool.js';

type QueryableClient = {
  query: (text: string, values?: unknown[]) => Promise<unknown>;
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..', '..');

async function resolveSqlDir() {
  const candidates = [path.join(rootDir, 'sql'), path.join(process.cwd(), 'sql')];
  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // Try the next runtime layout.
    }
  }
  return candidates[0];
}

export async function runMigrations() {
  const sqlDir = await resolveSqlDir();
  const files = (await fs.readdir(sqlDir)).filter((file) => file.endsWith('.sql')).sort();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    for (const file of files) {
      const applied = await client.query('SELECT 1 FROM schema_migrations WHERE filename = $1', [file]);
      if ((applied.rowCount ?? 0) > 0) continue;
      const sql = await fs.readFile(path.join(sqlDir, file), 'utf8');
      await client.query(sql);
      await client.query(
        `INSERT INTO schema_migrations(filename)
         VALUES ($1)
         ON CONFLICT (filename) DO NOTHING`,
        [file]
      );
    }
    await repairRequiredSchema(client);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function repairRequiredSchema(client: QueryableClient) {
  // Keep this tiny and idempotent: it protects local/dev databases where
  // schema_migrations can say that 004 ran while the physical column is absent.
  await client.query('ALTER TABLE conversation_sessions ADD COLUMN IF NOT EXISTS history_summary TEXT');
  for (const table of ['products', 'catalog_pages', 'troubleshooting_cases']) {
    await client.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS embedding_model text`);
    await client.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS embedding_source_hash text`);
    await client.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS embedding_updated_at timestamptz`);
  }
  await client.query(`
    CREATE TABLE IF NOT EXISTS conversation_turns (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      session_id uuid NOT NULL REFERENCES conversation_sessions(id) ON DELETE CASCADE,
      client_message_id uuid NOT NULL DEFAULT gen_random_uuid(),
      user_message_id uuid REFERENCES messages(id) ON DELETE SET NULL,
      assistant_message_id uuid REFERENCES messages(id) ON DELETE SET NULL,
      status text NOT NULL DEFAULT 'received' CHECK (status IN (
        'received',
        'need_extracted',
        'planned',
        'answering',
        'completed',
        'failed',
        'recovered'
      )),
      request_hash text NOT NULL,
      stage text,
      error_code text,
      error_message text,
      planner_contract jsonb,
      active_needs_before jsonb,
      active_needs_after jsonb,
      execution_owner uuid,
      execution_lease_expires_at timestamptz,
      deadline_at timestamptz,
      recovery_attempts integer NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS conversation_turns_session_created_idx
      ON conversation_turns(session_id, created_at DESC)
  `);
  await client.query(`
    ALTER TABLE conversation_turns
      ADD COLUMN IF NOT EXISTS client_message_id uuid,
      ADD COLUMN IF NOT EXISTS execution_owner uuid,
      ADD COLUMN IF NOT EXISTS execution_lease_expires_at timestamptz,
      ADD COLUMN IF NOT EXISTS deadline_at timestamptz,
      ADD COLUMN IF NOT EXISTS recovery_attempts integer NOT NULL DEFAULT 0
  `);
  await client.query('UPDATE conversation_turns SET client_message_id = id WHERE client_message_id IS NULL');
  await client.query("UPDATE conversation_turns SET deadline_at = created_at + interval '60 seconds' WHERE deadline_at IS NULL");
  await client.query('ALTER TABLE conversation_turns ALTER COLUMN deadline_at SET NOT NULL');
  await client.query(`
    ALTER TABLE conversation_turns
      ALTER COLUMN client_message_id SET DEFAULT gen_random_uuid(),
      ALTER COLUMN client_message_id SET NOT NULL
  `);
  await client.query('DROP INDEX IF EXISTS conversation_turns_request_hash_active_idx');
  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS conversation_turns_client_message_id_idx
      ON conversation_turns(session_id, client_message_id)
  `);
  await client.query(`
    WITH ranked_active_turns AS (
      SELECT id,
             row_number() OVER (PARTITION BY session_id ORDER BY created_at DESC, id DESC) AS active_rank
      FROM conversation_turns
      WHERE status IN ('received', 'need_extracted', 'planned', 'answering')
    )
    UPDATE conversation_turns AS turn
    SET status = 'failed',
        stage = 'migration_superseded_active_turn',
        error_code = 'superseded_active_turn',
        error_message = 'A newer active turn existed when the single-active-turn invariant was installed.',
        execution_owner = NULL,
        execution_lease_expires_at = NULL,
        updated_at = now()
    FROM ranked_active_turns AS ranked
    WHERE turn.id = ranked.id AND ranked.active_rank > 1
  `);
  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS conversation_turns_one_active_per_session_idx
      ON conversation_turns(session_id)
      WHERE status IN ('received', 'need_extracted', 'planned', 'answering')
  `);
  await client.query(`
    CREATE TABLE IF NOT EXISTS troubleshooting_cases (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      model text NOT NULL,
      model_key text NOT NULL,
      fault_codes text[] NOT NULL DEFAULT '{}'::text[],
      problem_summary text NOT NULL,
      problem_key text NOT NULL,
      answer text NOT NULL,
      source_urls text[] NOT NULL DEFAULT '{}'::text[],
      source_titles text[] NOT NULL DEFAULT '{}'::text[],
      confidence numeric(3, 2) NOT NULL DEFAULT 0.75,
      embedding vector(1536),
      first_seen_message text,
      hit_count integer NOT NULL DEFAULT 0,
      last_used_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE(model_key, problem_key)
    )
  `);
  await client.query(`
    CREATE TABLE IF NOT EXISTS openai_usage_events (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      created_at timestamptz NOT NULL DEFAULT now(),
      stage text NOT NULL,
      model text NOT NULL,
      request_source text NOT NULL DEFAULT 'unknown',
      session_id uuid REFERENCES conversation_sessions(id) ON DELETE SET NULL,
      turn_id uuid REFERENCES conversation_turns(id) ON DELETE SET NULL,
      page_url text,
      user_agent text,
      input_tokens integer,
      output_tokens integer,
      reasoning_tokens integer,
      total_tokens integer,
      response_id text,
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb
    )
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS openai_usage_events_created_idx
      ON openai_usage_events(created_at DESC)
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS openai_usage_events_source_created_idx
      ON openai_usage_events(request_source, created_at DESC)
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS openai_usage_events_session_created_idx
      ON openai_usage_events(session_id, created_at DESC)
  `);
  await client.query(`
    CREATE TABLE IF NOT EXISTS openai_usage_reservations (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      bucket text NOT NULL,
      stage text NOT NULL,
      model text NOT NULL,
      request_source text NOT NULL,
      session_id uuid REFERENCES conversation_sessions(id) ON DELETE SET NULL,
      turn_id uuid REFERENCES conversation_turns(id) ON DELETE SET NULL,
      reserved_tokens integer NOT NULL CHECK (reserved_tokens > 0),
      actual_tokens integer CHECK (actual_tokens IS NULL OR actual_tokens >= 0),
      status text NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved', 'reconciled', 'released')),
      expires_at timestamptz NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await client.query("CREATE INDEX IF NOT EXISTS openai_usage_reservations_active_idx ON openai_usage_reservations(bucket, expires_at) WHERE status = 'reserved'");
  await client.query('CREATE INDEX IF NOT EXISTS openai_usage_reservations_created_idx ON openai_usage_reservations(created_at DESC)');
  await client.query(`
    CREATE INDEX IF NOT EXISTS products_embedding_metadata_idx
      ON products(embedding_model, embedding_updated_at)
      WHERE embedding IS NOT NULL
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS catalog_pages_embedding_metadata_idx
      ON catalog_pages(embedding_model, embedding_updated_at)
      WHERE embedding IS NOT NULL
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS troubleshooting_cases_embedding_metadata_idx
      ON troubleshooting_cases(embedding_model, embedding_updated_at)
      WHERE embedding IS NOT NULL
  `);
  await repairVerifiedProductFactsSchema(client);
  await repairAgentManagerHarnessSchema(client);
  await repairAssistantFeedbackSchema(client);
  await repairCatalogFreshnessSchema(client);
}

async function repairVerifiedProductFactsSchema(client: QueryableClient) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS verified_product_facts (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      product_id uuid REFERENCES products(id) ON DELETE SET NULL,
      product_key text NOT NULL,
      product_name text NOT NULL,
      attribute text NOT NULL,
      value text NOT NULL,
      source_type text NOT NULL CHECK (source_type IN ('web', 'catalog', 'manual')),
      source_url text,
      source_title text,
      evidence text,
      catalog_source_hash text,
      source_fingerprint text,
      confidence text NOT NULL CHECK (confidence IN ('high', 'medium', 'low')),
      status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'superseded', 'rejected')),
      first_seen_at timestamptz NOT NULL DEFAULT now(),
      last_verified_at timestamptz NOT NULL DEFAULT now(),
      hit_count integer NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await client.query(`
    ALTER TABLE verified_product_facts
      ADD COLUMN IF NOT EXISTS catalog_source_hash text,
      ADD COLUMN IF NOT EXISTS source_fingerprint text
  `);
  await client.query(`DROP INDEX IF EXISTS verified_product_facts_unique_active_idx`);
  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS verified_product_facts_unique_active_v2_idx
      ON verified_product_facts(product_key, attribute, value, source_type, coalesce(source_url, ''))
      WHERE status = 'active'
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS verified_product_facts_key_status_idx
      ON verified_product_facts(product_key, status, last_verified_at DESC)
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS verified_product_facts_product_status_idx
      ON verified_product_facts(product_id, status, last_verified_at DESC)
      WHERE product_id IS NOT NULL
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS verified_product_facts_catalog_fingerprint_idx
      ON verified_product_facts(product_id, catalog_source_hash)
      WHERE product_id IS NOT NULL AND status = 'active'
  `);
}

async function repairAgentManagerHarnessSchema(client: QueryableClient) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS dialogue_ledger_events (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      session_id uuid NOT NULL REFERENCES conversation_sessions(id) ON DELETE CASCADE,
      turn_id uuid NOT NULL REFERENCES conversation_turns(id) ON DELETE CASCADE,
      event_id text NOT NULL,
      event_type text NOT NULL,
      scope text NOT NULL,
      payload jsonb NOT NULL,
      evidence text NOT NULL CHECK (length(trim(evidence)) > 0),
      source text NOT NULL CHECK (length(trim(source)) > 0),
      status text NOT NULL CHECK (status IN ('active', 'superseded', 'negated', 'closed', 'rejected')),
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE(session_id, event_id)
    )
  `);
  await client.query('CREATE INDEX IF NOT EXISTS dialogue_ledger_events_session_created_idx ON dialogue_ledger_events(session_id, created_at)');
  await client.query('CREATE INDEX IF NOT EXISTS dialogue_ledger_events_session_turn_idx ON dialogue_ledger_events(session_id, turn_id)');
  await client.query('CREATE INDEX IF NOT EXISTS dialogue_ledger_events_type_idx ON dialogue_ledger_events(event_type)');
  await client.query('CREATE SEQUENCE IF NOT EXISTS dialogue_ledger_event_seq_seq');
  await client.query('ALTER TABLE dialogue_ledger_events ADD COLUMN IF NOT EXISTS event_seq bigint');
  await client.query('ALTER SEQUENCE dialogue_ledger_event_seq_seq OWNED BY dialogue_ledger_events.event_seq');
  await client.query("ALTER TABLE dialogue_ledger_events ALTER COLUMN event_seq SET DEFAULT nextval('dialogue_ledger_event_seq_seq')");
  await client.query(`
    SELECT setval(
      'dialogue_ledger_event_seq_seq',
      greatest(coalesce((SELECT max(event_seq) FROM dialogue_ledger_events), 0), 1),
      coalesce((SELECT max(event_seq) FROM dialogue_ledger_events), 0) > 0
    )
  `);
  await client.query("UPDATE dialogue_ledger_events SET event_seq = nextval('dialogue_ledger_event_seq_seq') WHERE event_seq IS NULL");
  await client.query(`
    SELECT setval(
      'dialogue_ledger_event_seq_seq',
      greatest(coalesce((SELECT max(event_seq) FROM dialogue_ledger_events), 0), 1),
      coalesce((SELECT max(event_seq) FROM dialogue_ledger_events), 0) > 0
    )
  `);
  await client.query('ALTER TABLE dialogue_ledger_events ALTER COLUMN event_seq SET NOT NULL');
  await client.query('CREATE UNIQUE INDEX IF NOT EXISTS dialogue_ledger_events_event_seq_idx ON dialogue_ledger_events(event_seq)');
  await client.query('CREATE INDEX IF NOT EXISTS dialogue_ledger_events_session_event_seq_idx ON dialogue_ledger_events(session_id, event_seq)');
  await client.query(`
    CREATE TABLE IF NOT EXISTS dialogue_ledger_snapshots (
      session_id uuid PRIMARY KEY REFERENCES conversation_sessions(id) ON DELETE CASCADE,
      through_event_seq bigint NOT NULL,
      event_count integer NOT NULL CHECK (event_count >= 0),
      state jsonb NOT NULL,
      recent_events jsonb NOT NULL DEFAULT '[]'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await client.query('CREATE INDEX IF NOT EXISTS dialogue_ledger_snapshots_updated_idx ON dialogue_ledger_snapshots(updated_at DESC)');

  await client.query(`
    CREATE TABLE IF NOT EXISTS turn_checkpoints (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      session_id uuid NOT NULL REFERENCES conversation_sessions(id) ON DELETE CASCADE,
      turn_id uuid NOT NULL REFERENCES conversation_turns(id) ON DELETE CASCADE,
      checkpoint text NOT NULL,
      status text NOT NULL CHECK (status IN ('pending', 'running', 'succeeded', 'failed', 'skipped')),
      artifact_ref text,
      payload jsonb NOT NULL DEFAULT '{}'::jsonb,
      error_code text,
      error_message text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE(session_id, turn_id, checkpoint)
    )
  `);
  await client.query('CREATE INDEX IF NOT EXISTS turn_checkpoints_session_turn_idx ON turn_checkpoints(session_id, turn_id)');
  await client.query('CREATE INDEX IF NOT EXISTS turn_checkpoints_status_idx ON turn_checkpoints(status)');

  await client.query(`
    CREATE TABLE IF NOT EXISTS tool_artifacts (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      session_id uuid NOT NULL REFERENCES conversation_sessions(id) ON DELETE CASCADE,
      turn_id uuid NOT NULL REFERENCES conversation_turns(id) ON DELETE CASCADE,
      tool_name text NOT NULL,
      tool_request_id text NOT NULL,
      status text NOT NULL CHECK (status IN ('ok', 'denied', 'not_found', 'error', 'timeout')),
      payload jsonb NOT NULL,
      warnings jsonb NOT NULL DEFAULT '[]'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE(session_id, turn_id, tool_request_id)
    )
  `);
  await client.query('CREATE INDEX IF NOT EXISTS tool_artifacts_session_turn_idx ON tool_artifacts(session_id, turn_id)');
  await client.query('CREATE INDEX IF NOT EXISTS tool_artifacts_tool_name_idx ON tool_artifacts(tool_name)');
  await client.query('ALTER TABLE tool_artifacts ADD COLUMN IF NOT EXISTS error_code text');

  await client.query(`
    CREATE TABLE IF NOT EXISTS answer_contracts (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      session_id uuid NOT NULL REFERENCES conversation_sessions(id) ON DELETE CASCADE,
      turn_id uuid NOT NULL REFERENCES conversation_turns(id) ON DELETE CASCADE,
      answer_text text NOT NULL CHECK (length(trim(answer_text)) > 0),
      contract jsonb NOT NULL,
      review jsonb,
      status text NOT NULL CHECK (status IN ('draft', 'reviewed', 'final', 'rejected')),
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await client.query("CREATE UNIQUE INDEX IF NOT EXISTS answer_contracts_final_turn_idx ON answer_contracts(session_id, turn_id) WHERE status = 'final'");
  await client.query('CREATE INDEX IF NOT EXISTS answer_contracts_session_turn_idx ON answer_contracts(session_id, turn_id)');
  await client.query('ALTER TABLE answer_contracts ADD COLUMN IF NOT EXISTS response_payload jsonb');

  await client.query(`
    CREATE TABLE IF NOT EXISTS lead_outbox (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      lead_id uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
      session_id uuid NOT NULL REFERENCES conversation_sessions(id) ON DELETE CASCADE,
      turn_id uuid REFERENCES conversation_turns(id) ON DELETE CASCADE,
      destination text NOT NULL,
      payload jsonb NOT NULL,
      status text NOT NULL CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'dead')),
      attempt_count integer NOT NULL DEFAULT 0,
      next_attempt_at timestamptz,
      last_error text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE(lead_id, destination)
    )
  `);
  await client.query('CREATE INDEX IF NOT EXISTS lead_outbox_status_next_attempt_idx ON lead_outbox(status, next_attempt_at)');
  await client.query('ALTER TABLE leads ADD COLUMN IF NOT EXISTS client_lead_id uuid');
  await client.query('ALTER TABLE leads ADD COLUMN IF NOT EXISTS client_request_hash text');
  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS leads_session_client_lead_id_idx
      ON leads(session_id, client_lead_id)
      WHERE client_lead_id IS NOT NULL
  `);
  await client.query('ALTER TABLE lead_outbox ALTER COLUMN turn_id DROP NOT NULL');
  await client.query('ALTER TABLE leads ADD COLUMN IF NOT EXISTS origin_turn_id uuid REFERENCES conversation_turns(id) ON DELETE SET NULL');
  await client.query('ALTER TABLE leads ADD COLUMN IF NOT EXISTS origin_tool_request_id text');
  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS leads_origin_tool_request_idx
      ON leads(session_id, origin_turn_id, origin_tool_request_id)
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS lead_capture_drafts (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      session_id uuid NOT NULL REFERENCES conversation_sessions(id) ON DELETE CASCADE,
      origin_turn_id uuid NOT NULL REFERENCES conversation_turns(id) ON DELETE CASCADE,
      origin_tool_request_id text NOT NULL,
      purpose text NOT NULL CHECK (length(trim(purpose)) > 0),
      buyer_question text NOT NULL CHECK (length(trim(buyer_question)) > 0),
      preferred_contact text CHECK (preferred_contact IN ('message', 'call')),
      name text,
      phone text,
      email text,
      consent_evidence_hash text NOT NULL CHECK (length(consent_evidence_hash) = 64),
      scope_hash text NOT NULL CHECK (length(scope_hash) = 64),
      status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'consumed', 'cancelled', 'expired')),
      expires_at timestamptz NOT NULL DEFAULT (now() + interval '30 minutes'),
      consumed_by_turn_id uuid REFERENCES conversation_turns(id) ON DELETE SET NULL,
      consumed_lead_id uuid REFERENCES leads(id) ON DELETE SET NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE(session_id, origin_turn_id, origin_tool_request_id)
    )
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS lead_capture_drafts_pending_session_idx
      ON lead_capture_drafts(session_id, updated_at DESC)
      WHERE status = 'pending'
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS lead_capture_drafts_expiry_idx
      ON lead_capture_drafts(expires_at)
      WHERE status = 'pending'
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS agent_traces (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      session_id uuid REFERENCES conversation_sessions(id) ON DELETE CASCADE,
      turn_id uuid REFERENCES conversation_turns(id) ON DELETE CASCADE,
      phase text NOT NULL,
      event_type text NOT NULL,
      payload jsonb NOT NULL DEFAULT '{}'::jsonb,
      redacted boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await client.query('CREATE INDEX IF NOT EXISTS agent_traces_session_turn_created_idx ON agent_traces(session_id, turn_id, created_at DESC)');

  await client.query(`
    CREATE TABLE IF NOT EXISTS data_quality_issues (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      product_id uuid REFERENCES products(id) ON DELETE SET NULL,
      issue_type text NOT NULL,
      field_name text,
      conflicting_values jsonb NOT NULL DEFAULT '[]'::jsonb,
      evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
      status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'reviewing', 'resolved', 'ignored')),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await client.query('CREATE INDEX IF NOT EXISTS data_quality_issues_status_idx ON data_quality_issues(status, created_at DESC)');
}

async function repairAssistantFeedbackSchema(client: QueryableClient) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS assistant_feedback_events (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      session_id uuid NOT NULL REFERENCES conversation_sessions(id) ON DELETE CASCADE,
      turn_id uuid NOT NULL REFERENCES conversation_turns(id) ON DELETE CASCADE,
      user_message_id uuid REFERENCES messages(id) ON DELETE SET NULL,
      assistant_message_id uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      rating text NOT NULL CHECK (rating IN ('negative', 'wrong_cards')),
      status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'in_review', 'exported', 'resolved', 'dismissed')),
      buyer_message text NOT NULL,
      assistant_answer text NOT NULL,
      policy_evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
      model_evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
      tool_evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
      card_evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
      diagnostic_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
      exported_fixture jsonb,
      feedback_created_at timestamptz NOT NULL DEFAULT now(),
      exported_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE(assistant_message_id, rating)
    )
  `);
  await client.query('CREATE INDEX IF NOT EXISTS assistant_feedback_events_queue_idx ON assistant_feedback_events(status, created_at ASC)');
  await client.query('CREATE INDEX IF NOT EXISTS assistant_feedback_events_rating_queue_idx ON assistant_feedback_events(rating, status, created_at ASC)');
  await client.query('CREATE INDEX IF NOT EXISTS assistant_feedback_events_turn_idx ON assistant_feedback_events(turn_id, created_at DESC)');
}

async function repairCatalogFreshnessSchema(client: QueryableClient) {
  for (const table of ['products', 'catalog_pages']) {
    await client.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS last_seen_at timestamptz`);
    await client.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS last_synced_at timestamptz`);
    await client.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true`);
    await client.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS source_content_hash text`);
    await client.query(`UPDATE ${table} SET last_seen_at = coalesce(last_seen_at, updated_at, created_at), last_synced_at = coalesce(last_synced_at, updated_at, created_at) WHERE last_seen_at IS NULL OR last_synced_at IS NULL`);
    await client.query(`ALTER TABLE ${table} ALTER COLUMN last_seen_at SET DEFAULT now()`);
    await client.query(`ALTER TABLE ${table} ALTER COLUMN last_seen_at SET NOT NULL`);
    await client.query(`ALTER TABLE ${table} ALTER COLUMN last_synced_at SET DEFAULT now()`);
    await client.query(`ALTER TABLE ${table} ALTER COLUMN last_synced_at SET NOT NULL`);
  }
  await client.query(`
    CREATE TABLE IF NOT EXISTS catalog_sync_runs (
      id uuid PRIMARY KEY REFERENCES catalog_sources(id) ON DELETE CASCADE,
      source_type text NOT NULL,
      source_location text NOT NULL,
      lock_identity text NOT NULL,
      sync_mode text NOT NULL CHECK (sync_mode IN ('full', 'partial')),
      status text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'completed', 'failed')),
      coverage_complete boolean NOT NULL DEFAULT false,
      discovered_item_count integer NOT NULL DEFAULT 0,
      synced_item_count integer NOT NULL DEFAULT 0,
      failed_item_count integer NOT NULL DEFAULT 0,
      deactivated_item_count integer NOT NULL DEFAULT 0,
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
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await client.query(`
    DO $catalog_freshness_repair$
    DECLARE
      generated_expression text;
    BEGIN
      SELECT pg_get_expr(attribute.adbin, attribute.adrelid)
      INTO generated_expression
      FROM pg_attrdef attribute
      JOIN pg_attribute column_definition
        ON column_definition.attrelid = attribute.adrelid
       AND column_definition.attnum = attribute.adnum
      WHERE attribute.adrelid = 'catalog_sync_runs'::regclass
        AND column_definition.attname = 'deactivation_eligible';

      IF generated_expression IS NULL
         OR position('discovered_item_count > 0' in generated_expression) = 0
         OR position('synced_item_count = discovered_item_count' in generated_expression) = 0 THEN
        ALTER TABLE catalog_sync_runs DROP COLUMN IF EXISTS deactivation_eligible;
        ALTER TABLE catalog_sync_runs
        ADD COLUMN deactivation_eligible boolean GENERATED ALWAYS AS (
          sync_mode = 'full'
          AND status = 'completed'
          AND coverage_complete
          AND failed_item_count = 0
          AND discovered_item_count > 0
          AND synced_item_count > 0
          AND synced_item_count = discovered_item_count
          AND finished_at IS NOT NULL
        ) STORED;
      END IF;
    END
    $catalog_freshness_repair$
  `);
  await client.query(`
    CREATE OR REPLACE FUNCTION catalog_sync_advisory_key(identity text)
    RETURNS bigint LANGUAGE sql IMMUTABLE PARALLEL SAFE
    AS $$ SELECT hashtextextended(identity, 0); $$
  `);
  await client.query('CREATE INDEX IF NOT EXISTS products_catalog_freshness_idx ON products(is_active, last_seen_at DESC)');
  await client.query('CREATE INDEX IF NOT EXISTS catalog_pages_freshness_idx ON catalog_pages(is_active, last_seen_at DESC)');
  await client.query('CREATE INDEX IF NOT EXISTS catalog_sync_runs_source_finished_idx ON catalog_sync_runs(source_type, source_location, finished_at DESC)');
  await client.query("CREATE INDEX IF NOT EXISTS catalog_sync_runs_running_lock_idx ON catalog_sync_runs(lock_identity, started_at DESC) WHERE status = 'running'");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runMigrations()
    .then(async () => {
      console.log('Migrations completed');
      await pool.end();
    })
    .catch(async (error) => {
      console.error(error);
      await pool.end();
      process.exitCode = 1;
    });
}
