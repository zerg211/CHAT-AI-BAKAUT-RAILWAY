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
    expect(queries).toContain('ALTER TABLE products ADD COLUMN IF NOT EXISTS embedding_model text');
    expect(queries).toContain('ALTER TABLE catalog_pages ADD COLUMN IF NOT EXISTS embedding_source_hash text');
    expect(queries).toContain('ALTER TABLE troubleshooting_cases ADD COLUMN IF NOT EXISTS embedding_updated_at timestamptz');
    expect(queries.some((query) => query.includes('CREATE TABLE IF NOT EXISTS troubleshooting_cases'))).toBe(true);
    expect(queries.some((query) => query.includes('CREATE TABLE IF NOT EXISTS openai_usage_events'))).toBe(true);
    expect(queries.some((query) => query.includes('CREATE TABLE IF NOT EXISTS openai_usage_reservations'))).toBe(true);
    expect(queries).toContain('ALTER SEQUENCE dialogue_ledger_event_seq_seq OWNED BY dialogue_ledger_events.event_seq');
    expect(queries.filter((query) => query.includes("SELECT setval(\n      'dialogue_ledger_event_seq_seq'")).length).toBe(2);
    expect(queries).toContain('ALTER TABLE leads ADD COLUMN IF NOT EXISTS client_lead_id uuid');
    expect(queries).toContain('ALTER TABLE leads ADD COLUMN IF NOT EXISTS client_request_hash text');
    expect(queries).toContain('ALTER TABLE lead_outbox ALTER COLUMN turn_id DROP NOT NULL');
    expect(queries.some((query) => query.includes('leads_session_client_lead_id_idx'))).toBe(true);
    expect(queries.some((query) => query.includes('CREATE TABLE IF NOT EXISTS lead_capture_drafts'))).toBe(true);
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
    expect(schema).toContain('embedding_model text');
    expect(schema).toContain('UNIQUE(model_key, problem_key)');
    expect(schema).not.toContain('GENERATED ALWAYS');
  });

  it('adds embedding metadata to existing catalog tables', async () => {
    const schema = await fs.readFile(path.join(process.cwd(), 'sql', '008_embedding_metadata.sql'), 'utf8');

    expect(schema).toContain('ALTER TABLE products');
    expect(schema).toContain('embedding_source_hash text');
    expect(schema).toContain('products_embedding_metadata_idx');
    expect(schema).toContain('catalog_pages_embedding_metadata_idx');
    expect(schema).toContain('troubleshooting_cases_embedding_metadata_idx');
  });

  it('creates the OpenAI usage ledger schema', async () => {
    const schema = await fs.readFile(path.join(process.cwd(), 'sql', '007_openai_usage_events.sql'), 'utf8');

    expect(schema).toContain('CREATE TABLE IF NOT EXISTS openai_usage_events');
    expect(schema).toContain('request_source text NOT NULL');
    expect(schema).toContain('total_tokens integer');
    expect(schema).toContain('openai_usage_events_source_created_idx');
  });

  it('adds atomic OpenAI token reservations for concurrent budget enforcement', async () => {
    const schema = await fs.readFile(path.join(process.cwd(), 'sql', '016_openai_usage_reservations.sql'), 'utf8');

    expect(schema).toContain('CREATE TABLE IF NOT EXISTS openai_usage_reservations');
    expect(schema).toContain("status IN ('reserved', 'reconciled', 'released')");
    expect(schema).toContain('reserved_tokens integer NOT NULL');
    expect(schema).toContain('openai_usage_reservations_active_idx');
  });

  it('adds durable turn idempotency, execution leases, exact response recovery, and lead origin keys', async () => {
    const schema = await fs.readFile(path.join(process.cwd(), 'sql', '011_turn_idempotency_recovery.sql'), 'utf8');

    expect(schema).toContain('client_message_id uuid');
    expect(schema).toContain('UNIQUE INDEX IF NOT EXISTS conversation_turns_client_message_id_idx');
    expect(schema).toContain('conversation_turns_one_active_per_session_idx');
    expect(schema).toContain('execution_lease_expires_at');
    expect(schema).toContain('response_payload jsonb');
    expect(schema).toContain('origin_tool_request_id');
    expect(schema).toContain('leads_origin_tool_request_idx');
    expect(schema).toContain('DROP INDEX IF EXISTS conversation_turns_request_hash_active_idx');
  });

  it('adds monotonic ledger sequencing and snapshot-plus-tail compaction', async () => {
    const schema = await fs.readFile(path.join(process.cwd(), 'sql', '012_dialogue_ledger_snapshots.sql'), 'utf8');

    expect(schema).toContain('dialogue_ledger_event_seq_seq');
    expect(schema).toContain('event_seq bigint');
    expect(schema).toContain('dialogue_ledger_events_session_event_seq_idx');
    expect(schema).toContain('CREATE TABLE IF NOT EXISTS dialogue_ledger_snapshots');
    expect(schema).toContain('through_event_seq bigint NOT NULL');
    expect(schema).toContain('recent_events jsonb');
  });

  it('adds public lead-form idempotency and allows pre-turn email outbox rows', async () => {
    const schema = await fs.readFile(path.join(process.cwd(), 'sql', '015_lead_form_idempotency.sql'), 'utf8');

    expect(schema).toContain('client_lead_id uuid');
    expect(schema).toContain('client_request_hash text');
    expect(schema).toContain('leads_session_client_lead_id_idx');
    expect(schema).toContain('WHERE client_lead_id IS NOT NULL');
    expect(schema).toContain('ALTER TABLE lead_outbox ALTER COLUMN turn_id DROP NOT NULL');
  });

  it('adds expiring partial-contact drafts that preserve the original handoff scope', async () => {
    const schema = await fs.readFile(path.join(process.cwd(), 'sql', '018_lead_capture_drafts.sql'), 'utf8');

    expect(schema).toContain('CREATE TABLE IF NOT EXISTS lead_capture_drafts');
    expect(schema).toContain('buyer_question text NOT NULL');
    expect(schema).toContain('preferred_contact text');
    expect(schema).toContain("status IN ('pending', 'consumed', 'cancelled', 'expired')");
    expect(schema).toContain("now() + interval '30 minutes'");
    expect(schema).toContain('consent_evidence_hash text NOT NULL');
    expect(schema).toContain('scope_hash text NOT NULL');
    expect(schema).toContain('lead_capture_drafts_pending_session_idx');
    expect(schema).toContain('lead_capture_drafts_expiry_idx');
  });
});
