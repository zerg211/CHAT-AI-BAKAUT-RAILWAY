import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { repairRequiredSchema } from '../src/db/migrate.js';

describe('database schema migrations', () => {
  it('repairs conversation_sessions.history_summary even when migration bookkeeping drifted', async () => {
    const queries: string[] = [];
    const client = {
      query: async (text: string) => {
        queries.push(text);
        return { rowCount: 0, rows: [] };
      }
    };

    await repairRequiredSchema(client);

    expect(queries).toContain('ALTER TABLE conversation_sessions ADD COLUMN IF NOT EXISTS history_summary TEXT');
    expect(queries.some((query) => query.includes('CREATE TABLE IF NOT EXISTS troubleshooting_cases'))).toBe(true);
  });

  it('creates history_summary in the fresh database schema', async () => {
    const schema = await fs.readFile(path.join(process.cwd(), 'sql', '001_init.sql'), 'utf8');

    expect(schema).toContain('CREATE TABLE IF NOT EXISTS conversation_sessions');
    expect(schema).toContain('history_summary text');
  });

  it('creates the troubleshooting memory schema', async () => {
    const schema = await fs.readFile(path.join(process.cwd(), 'sql', '005_troubleshooting_cases.sql'), 'utf8');

    expect(schema).toContain('CREATE TABLE IF NOT EXISTS troubleshooting_cases');
    expect(schema).toContain('model_key text NOT NULL');
    expect(schema).toContain('embedding vector(1536)');
    expect(schema).toContain('UNIQUE(model_key, problem_key)');
    expect(schema).not.toContain('GENERATED ALWAYS');
  });
});
