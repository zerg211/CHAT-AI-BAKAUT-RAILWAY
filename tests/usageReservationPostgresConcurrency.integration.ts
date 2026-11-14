import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';

// This harness only accepts an explicitly confirmed, disposable local database.
const url = new URL(process.env.BAKAUT_TEST_DATABASE_URL ?? 'file:///missing');
const database = decodeURIComponent(url.pathname.slice(1));
assert.ok(['postgres:', 'postgresql:'].includes(url.protocol));
assert.ok(['127.0.0.1', '[::1]'].includes(url.hostname));
assert.match(database, /^bakaut_acceptance_[a-z0-9_]+$/);
assert.equal(process.env.BAKAUT_TEST_DATABASE_CONFIRM, database);
assert.equal(url.search, '');
assert.equal(url.hash, '');
process.env.DATABASE_URL = url.href;
process.env.NODE_ENV = 'test';

const { pool } = await import('../src/db/pool.js');
const { config } = await import('../src/config.js');
const { assertOpenAIUsageBudget } = await import('../src/ai/openaiUsageGuard.js');
config.OPENAI_USAGE_GUARD_ENABLED = true;
config.OPENAI_DAILY_TOKEN_BUDGET = 100;
config.OPENAI_BUDGET_GUARD_RESERVE_TOKENS = 1;
const responseId = `acceptance-${randomUUID()}`;
let reservationId: string | null = null;
let settlement: PoolClient | undefined;
let eventWriteAttempted = false;
try {
  settlement = await pool.connect();
  const endpoint = await settlement.query('SELECT current_database() AS db, inet_server_addr()::text AS address');
  assert.equal(endpoint.rows[0].db, database);
  assert.ok(['127.0.0.1/32', '127.0.0.1', '::1/128', '::1'].includes(endpoint.rows[0].address));
  const existing = await pool.query(`SELECT
    (SELECT count(*) FROM openai_usage_events WHERE created_at >= now() - interval '24 hours')::int AS events,
    (SELECT count(*) FROM openai_usage_reservations WHERE status='reserved' AND expires_at > now())::int AS reservations`);
  assert.deepEqual(existing.rows[0], { events: 0, reservations: 0 }, 'Use an empty disposable ledger');
  reservationId = await assertOpenAIUsageBudget('acceptance', 'test', 80);
  assert.ok(reservationId);

  // Settlement commits its event and reservation update atomically. While it is
  // uncommitted, another connection must still count the old reservation.
  await settlement.query('BEGIN');
  eventWriteAttempted = true;
  await settlement.query(`INSERT INTO openai_usage_events(stage, model, response_id, total_tokens)
    VALUES ('acceptance', 'test', $1, 80)`, [responseId]);
  await settlement.query(`UPDATE openai_usage_reservations SET status='reconciled', actual_tokens=80 WHERE id=$1`, [reservationId]);
  await assert.rejects(() => assertOpenAIUsageBudget('acceptance', 'test', 21), /budget exceeded/);
  await settlement.query('COMMIT');
  // After commit, the same snapshot-based total must count the event instead.
  await assert.rejects(() => assertOpenAIUsageBudget('acceptance', 'test', 21), /budget exceeded/);
  console.log('PASS: settlement overlap never understates reserved or recorded tokens');
} finally {
  try {
    if (settlement) {
      await settlement.query('ROLLBACK').catch(() => undefined);
      settlement.release();
    }
    try {
      if (eventWriteAttempted) await pool.query('DELETE FROM openai_usage_events WHERE response_id=$1', [responseId]);
    } finally {
      if (reservationId) await pool.query('DELETE FROM openai_usage_reservations WHERE id=$1', [reservationId]);
    }
  } finally {
    await pool.end();
  }
}
