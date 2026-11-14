import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

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
const { ConversationRepository } = await import('../src/db/repositories.js');
const { applyPlatformAvailability } = await import('../src/ai/platformAvailability.js');
const { registerLeadRoutes } = await import('../src/routes/leads.js');
const { default: Fastify } = await import('fastify');
const server = Fastify();
await registerLeadRoutes(server);
const client = await pool.connect().catch(async (error: unknown) => {
  try { await server.close(); } finally { await pool.end(); }
  throw error;
});
let sessionId: string | undefined;
const sessions: string[] = [];
try {
  const endpoint = await client.query("SELECT current_database() AS db, inet_server_addr()::text AS address, pg_backend_pid() AS pid");
  const blockingPid: number = endpoint.rows[0].pid;
  assert.equal(endpoint.rows[0].db, database);
  assert.ok(['127.0.0.1/32', '127.0.0.1', '::1/128', '::1'].includes(endpoint.rows[0].address));
  const visitorId = randomUUID();
  const conversations = new ConversationRepository();
  const session = await conversations.createSession({ visitorId });
  sessionId = session.id;
  sessions.push(sessionId);
  const requestId = randomUUID();
  const request = { id: requestId, state: 'contact_requested', question: 'Проверить наличие', productIds: [] };
  await conversations.addMessage({ sessionId, role: 'assistant', content: 'Могу уточнить наличие.', metadata: { availabilityRequest: request } });
  const priorMessages = await conversations.listMessages(sessionId, null);
  const decision = { action: 'capture', continueRequest: true, consentGranted: false, consentQuote: null,
    requestSummary: request.question, productIds: [], preferredContact: 'call' };
  await client.query('BEGIN');
  await client.query('SELECT id FROM conversation_sessions WHERE id=$1 FOR UPDATE', [sessionId]);
  const denied = await applyPlatformAvailability({ db: client, sessionId, turnId: randomUUID(),
    userMessage: '+7 900 000-10-03', priorMessages, decision });
  assert.equal(denied.availabilityReceipt?.outcome, 'consent_required');
  assert.equal((await client.query('SELECT count(*)::int AS n FROM leads WHERE session_id=$1', [sessionId])).rows[0].n, 0);
  const form = server.inject({ method: 'POST', url: '/api/leads', headers: { 'x-bakaut-visitor-id': visitorId },
    payload: { sessionId, clientLeadId: requestId, availabilityRequestId: requestId,
      name: 'Test', phone: '+7 900 000-10-03', preferredContact: 'call' } });
  let waiters = 0;
  for (let attempt = 0; attempt < 100; attempt++) {
    waiters = (await pool.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid))", [blockingPid])).rows[0].n;
    if (waiters) break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.ok(waiters > 0, 'Form must overlap with the held session lock');
  const text = 'Согласен, звоните +7 900 000-10-03';
  const captured = await applyPlatformAvailability({ db: client, sessionId, turnId: randomUUID(), userMessage: text,
    priorMessages, decision: { ...decision, consentGranted: true, consentQuote: text } });
  assert.equal(captured.availabilityReceipt?.outcome, 'queued');
  await client.query('COMMIT');
  const response = await form;
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().availabilityReceipt.outcome, 'already_queued');
  const counts = await pool.query(`SELECT (SELECT count(*) FROM leads WHERE session_id=$1)::int AS leads,
    (SELECT count(*) FROM lead_outbox WHERE session_id=$1)::int AS outbox`, [sessionId]);
  assert.deepEqual(counts.rows[0], { leads: 1, outbox: 1 });
  const reverseSession = await conversations.createSession({ visitorId });
  sessions.push(reverseSession.id);
  const reverseId = randomUUID();
  await conversations.addMessage({ sessionId: reverseSession.id, role: 'assistant', content: 'Могу уточнить наличие.',
    metadata: { availabilityRequest: { ...request, id: reverseId } } });
  const formFirst = await server.inject({ method: 'POST', url: '/api/leads', headers: { 'x-bakaut-visitor-id': visitorId },
    payload: { sessionId: reverseSession.id, clientLeadId: reverseId, availabilityRequestId: reverseId,
      name: 'Test', phone: '+7 900 000-10-03', preferredContact: 'call' } });
  assert.equal(formFirst.statusCode, 200);
  await client.query('BEGIN');
  await client.query('SELECT id FROM conversation_sessions WHERE id=$1 FOR UPDATE', [reverseSession.id]);
  const afterForm = await applyPlatformAvailability({ db: client, sessionId: reverseSession.id, turnId: randomUUID(),
    userMessage: text, priorMessages: await new ConversationRepository(client).listMessages(reverseSession.id, null),
    decision: { ...decision, consentGranted: true, consentQuote: text } });
  assert.equal(afterForm.availabilityReceipt?.outcome, 'already_queued');
  await client.query('COMMIT');
  const reverseCounts = await pool.query(`SELECT (SELECT count(*) FROM leads WHERE session_id=$1)::int AS leads,
    (SELECT count(*) FROM lead_outbox WHERE session_id=$1)::int AS outbox`, [reverseSession.id]);
  assert.deepEqual(reverseCounts.rows[0], { leads: 1, outbox: 1 });

  const declinedSession = await conversations.createSession({ visitorId });
  sessions.push(declinedSession.id);
  const declinedId = randomUUID();
  await conversations.addMessage({ sessionId: declinedSession.id, role: 'assistant', content: 'Могу уточнить наличие.',
    metadata: { availabilityRequest: { ...request, id: declinedId } } });
  await client.query('BEGIN');
  await client.query('SELECT id FROM conversation_sessions WHERE id=$1 FOR UPDATE', [declinedSession.id]);
  const staleForm = server.inject({ method: 'POST', url: '/api/leads', headers: { 'x-bakaut-visitor-id': visitorId },
    payload: { sessionId: declinedSession.id, clientLeadId: declinedId, availabilityRequestId: declinedId,
      name: 'Test', phone: '+7 900 000-10-03' } });
  let blocked = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    blocked = (await pool.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid))", [blockingPid])).rows[0].n > 0;
    if (blocked) break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.ok(blocked, 'Stale form must wait for this session');
  await new ConversationRepository(client).addMessage({ sessionId: declinedSession.id, role: 'assistant', content: 'Хорошо.',
    metadata: { availabilityRequest: { ...request, id: declinedId, state: 'declined' } } });
  await client.query('COMMIT');
  assert.equal((await staleForm).statusCode, 409);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM leads WHERE session_id=$1', [declinedSession.id])).rows[0].n, 0);
  const historySession = await conversations.createSession({ visitorId });
  sessions.push(historySession.id);
  const ids = Array.from({ length: 161 }, () => randomUUID()).sort();
  await pool.query(`INSERT INTO messages(id,session_id,role,content,metadata,created_at)
    SELECT id,$1::uuid,'user','fixture','{}'::jsonb,'2026-01-01T00:00:00Z'::timestamptz
    FROM unnest($2::uuid[]) AS x(id)`, [historySession.id, ids]);
  const collected: string[] = [];
  let before: string | null = null;
  do {
    const historyPage = await conversations.getHistorySnapshot(historySession.id, 81, before);
    assert.equal(historyPage.cursorValid, true);
    const page = historyPage.messages.slice(-80);
    collected.unshift(...page.map(message => message.id));
    before = historyPage.messages.length > page.length ? page[0].id : null;
  } while (before);
  assert.deepEqual(collected, ids);
  assert.equal((await conversations.getHistorySnapshot(historySession.id, 81, randomUUID())).cursorValid, false);
  console.log('PASS: real PostgreSQL form/chat overlap, consent, one lead and outbox; no notification sent');
} finally {
  await client.query('ROLLBACK').catch(() => undefined);
  client.release();
  try {
    for (const id of sessions) {
      await pool.query('DELETE FROM lead_outbox WHERE session_id=$1', [id]);
      await pool.query('DELETE FROM leads WHERE session_id=$1', [id]);
      await pool.query('DELETE FROM conversation_sessions WHERE id=$1', [id]);
    }
  } finally {
    try { await server.close(); } finally { await pool.end(); }
  }
}
