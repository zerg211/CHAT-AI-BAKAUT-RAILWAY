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
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS conversation_turns_session_created_idx
      ON conversation_turns(session_id, created_at DESC)
  `);
  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS conversation_turns_request_hash_active_idx
      ON conversation_turns(session_id, request_hash)
      WHERE status IN ('received', 'need_extracted', 'planned', 'answering', 'completed', 'recovered')
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
  await repairAgentManagerHarnessSchema(client);
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

  await client.query(`
    CREATE TABLE IF NOT EXISTS lead_outbox (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      lead_id uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
      session_id uuid NOT NULL REFERENCES conversation_sessions(id) ON DELETE CASCADE,
      turn_id uuid NOT NULL REFERENCES conversation_turns(id) ON DELETE CASCADE,
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
