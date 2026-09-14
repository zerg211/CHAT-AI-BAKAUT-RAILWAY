import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
const dbUrl = new URL(process.env.DATABASE_URL || 'file:///missing');
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(dbUrl.hostname) && dbUrl.pathname.startsWith('/bakaut_acceptance_'));
const receipts = [];
let firstArrived, releaseFirst;
const arrival = new Promise(resolve => { firstArrived = resolve; });
const hold = new Promise(resolve => { releaseFirst = resolve; });
const sink = createServer(async (request, response) => {
  let text = ''; for await (const chunk of request) text += chunk;
  receipts.push({ key: request.headers['idempotency-key'], body: JSON.parse(text) });
  if (receipts.length === 1) { firstArrived(); await hold; }
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ id: 'sink-' + receipts.length }));
});
await new Promise(resolve => sink.listen(0, '127.0.0.1', resolve));
Object.assign(process.env, { NODE_ENV: 'test', EMAIL_HTTP_URL: `http://127.0.0.1:${sink.address().port}/leads`,
  EMAIL_HTTP_AUTH_HEADER: 'X-Fixture: local-only', EMAIL_FROM: 'assistant@example.invalid', LEADS_TO_EMAIL: 'sink@example.invalid',
  RESEND_API_KEY: '', RESEND_TIMEOUT_MS: '2000', EMAIL_HTTP_TIMEOUT_MS: '2000', EMAIL_HTTP_METHOD: 'POST' });
const { pool } = await import('../src/db/pool.ts');
const { buildApp } = await import('../src/app.ts');
const { startLeadOutboxWorker } = await import('../src/ai/leadOutbox.ts');
const sessionId = randomUUID(), visitorId = randomUUID();
let app, stop;
try {
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM lead_outbox WHERE status IN ('pending','sending')")).rows[0].n, 0);
  await pool.query('INSERT INTO conversation_sessions(id,visitor_id) VALUES($1,$2)', [sessionId, visitorId]);
  app = await buildApp();
  const payload = { sessionId, clientLeadId: randomUUID(), email: 'buyer@example.invalid', question: 'Check fixture delivery', preferredContact: 'message' };
  const send = body => app.inject({ method: 'POST', url: '/api/leads', headers: { 'x-bakaut-visitor-id': visitorId }, payload: body });
  const [first, retry] = await Promise.all([send(payload), send(payload)]);
  assert.equal(first.statusCode, 200); assert.equal(retry.statusCode, 200);
  assert.equal(first.json().outboxId, retry.json().outboxId);
  assert.equal(first.json().lead.name, null);
  const second = await send({ ...payload, clientLeadId: randomUUID(), question: 'Another fixture question', preferredContact: 'call' });
  assert.equal(second.statusCode, 200);
  stop = startLeadOutboxWorker({ intervalMs: 5 });
  await Promise.race([arrival, new Promise((_, reject) => setTimeout(() => reject(new Error('local sink not reached')), 4000))]);
  let stopped = false;
  const draining = stop().then(() => { stopped = true; });
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(stopped, false); assert.equal(receipts.length, 1);
  releaseFirst(); await draining;
  const statuses = (await pool.query('SELECT status FROM lead_outbox WHERE session_id=$1 ORDER BY created_at,id', [sessionId])).rows.map(row => row.status).sort();
  assert.deepEqual(statuses, ['pending', 'sent']);
  await app.close(); app = await buildApp();
  stop = startLeadOutboxWorker({ intervalMs: 5 });
  for (let i = 0; i < 100 && receipts.length < 2; i++) await new Promise(resolve => setTimeout(resolve, 20));
  await stop();
  assert.equal(receipts.length, 2); assert.equal(new Set(receipts.map(item => item.key)).size, 2);
  assert.ok(receipts.some(item => item.body.text.includes('Check fixture delivery')));
  assert.ok(receipts.some(item => item.body.text.includes('Позвонить') || item.body.text.toLowerCase().includes('звон')));
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM leads WHERE session_id=$1 AND status='sent_email'", [sessionId])).rows[0].n, 2);
  console.log(JSON.stringify({ status: 'PASS', level: 'I', checks: ['phone-or-email-without-name', 'concurrent-form-idempotency',
    'route-to-durable-outbox-to-real-loopback-http', 'singleflight-and-drain', 'restart-continues-pending', 'preferred-channel-in-wire-payload'], externalSends: 0 }));
} catch (error) {
  console.error(error); process.exitCode = 1;
} finally {
  releaseFirst(); await stop?.();
  // Even a deliberately broken stop implementation must not leak an HTTP/DB task from this test.
  for (let i = 0; i < 100; i++) {
    const sending = (await pool.query("SELECT count(*)::int AS n FROM lead_outbox WHERE session_id=$1 AND status='sending'", [sessionId])).rows[0].n;
    if (!sending) break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  await app?.close();
  await pool.query('DELETE FROM leads WHERE session_id=$1', [sessionId]);
  await pool.query('DELETE FROM conversation_sessions WHERE id=$1', [sessionId]); await pool.end();
  await new Promise(resolve => sink.close(resolve));
}
