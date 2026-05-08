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
