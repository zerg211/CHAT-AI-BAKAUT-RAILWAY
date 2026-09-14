import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
const target = new URL(process.env.DATABASE_URL || 'file:///missing');
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname) && target.pathname.startsWith('/bakaut_acceptance_'));
process.env.NODE_ENV = 'test';
const { pool } = await import('../src/db/pool.ts');
const { ConversationRepository } = await import('../src/db/repositories.ts');
const repo = new ConversationRepository();
const sessions = [randomUUID(), randomUUID(), randomUUID()];
const turnId = randomUUID(), leadId = randomUUID(), outboxId = randomUUID();
try {
  for (const id of sessions) await pool.query("INSERT INTO conversation_sessions(id,created_at,last_heartbeat_at) VALUES($1,now()-interval '3 days',now()-interval '1 day')", [id]);
  await pool.query("INSERT INTO conversation_turns(id,session_id,status,request_hash,deadline_at) VALUES($1,$2,'answering','maintenance-fixture',now()+interval '1 minute')", [turnId, sessions[0]]);
  await pool.query("INSERT INTO leads(id,session_id,name) VALUES($1,$2,'isolated maintenance test')", [leadId, sessions[1]]);
  await pool.query("INSERT INTO lead_outbox(id,lead_id,session_id,destination,payload,status) VALUES($1,$2,$3,'lead_email','{}','pending')", [outboxId, leadId, sessions[1]]);
  await repo.expireInactiveSessions();
  assert.equal((await pool.query('SELECT status FROM conversation_sessions WHERE id=$1', [sessions[0]])).rows[0].status, 'active');
  await repo.deleteEmptyNonWidgetSessions();
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM conversation_sessions WHERE id=ANY($1::uuid[])', [sessions.slice(0,2)])).rows[0].n, 2);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM conversation_sessions WHERE id=$1', [sessions[2]])).rows[0].n, 0);
  await pool.query("UPDATE conversation_sessions SET page_url='https://fixtures.bakaut.invalid' WHERE id=ANY($1::uuid[])", [sessions.slice(0,2)]);
  await repo.deleteOldEmptyWidgetSessions();
  assert.equal((await pool.query('SELECT session_id FROM lead_outbox WHERE id=$1', [outboxId])).rows[0].session_id, sessions[1]);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM conversation_turns WHERE id=$1', [turnId])).rows[0].n, 1);
  for (const widget of [false, true]) {
    const id = randomUUID(), visitor = randomUUID(); sessions.push(id);
    await pool.query("INSERT INTO conversation_sessions(id,visitor_id,page_url,created_at,last_heartbeat_at) VALUES($1,$2,$3,now()-interval '3 days',now()-interval '1 minute')",
      [id, visitor, widget ? 'https://fixtures.bakaut.invalid' : null]);
    const owner = await pool.connect();
    try {
      await owner.query('BEGIN');
      await new ConversationRepository(owner).createTurnWithUserMessage({ sessionId: id, visitorCapability: visitor,
        clientMessageId: randomUUID(), requestHash: 'concurrent-maintenance', content: 'Fixture buyer message',
        deadlineAt: new Date(Date.now() + 60000).toISOString() });
      const cleanup = widget ? repo.deleteOldEmptyWidgetSessions() : repo.deleteEmptyNonWidgetSessions();
      await Promise.race([cleanup, new Promise(resolve => setTimeout(resolve, 100))]);
      await owner.query('COMMIT');
      await cleanup;
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM conversation_turns WHERE session_id=$1', [id])).rows[0].n, 1,
        'Concurrent cleanup must not cascade-delete an accepted message/turn');
    } finally { await owner.query('ROLLBACK'); owner.release(); }
  }
  console.log(JSON.stringify({ status: 'PASS', level: 'I', checks: ['Y15/active-session-maintenance', 'Y15/pending-lead-maintenance', 'concurrent-acceptance-versus-both-cleanups'] }));
} finally {
  await pool.query('DELETE FROM lead_outbox WHERE id=$1', [outboxId]);
  await pool.query('DELETE FROM leads WHERE id=$1', [leadId]);
  await pool.query('DELETE FROM conversation_sessions WHERE id=ANY($1::uuid[])', [sessions]);
  await pool.end();
}
