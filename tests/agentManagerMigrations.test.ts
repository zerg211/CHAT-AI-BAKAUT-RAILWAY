import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('agent manager harness migration', () => {
  it('reserves migration 009 for the new harness tables', async () => {
    const schema = await fs.readFile(path.join(process.cwd(), 'sql', '009_agent_manager_harness.sql'), 'utf8');

    expect(schema).toContain('CREATE TABLE IF NOT EXISTS dialogue_ledger_events');
    expect(schema).toContain('CREATE TABLE IF NOT EXISTS turn_checkpoints');
    expect(schema).toContain('CREATE TABLE IF NOT EXISTS tool_artifacts');
    expect(schema).toContain('CREATE TABLE IF NOT EXISTS answer_contracts');
    expect(schema).toContain('CREATE TABLE IF NOT EXISTS lead_outbox');
    expect(schema).toContain('CREATE TABLE IF NOT EXISTS agent_traces');
    expect(schema).toContain('CREATE TABLE IF NOT EXISTS data_quality_issues');
    expect(schema).toContain('UNIQUE(session_id, event_id)');
    expect(schema).toContain("WHERE status = 'final'");
  });
});
