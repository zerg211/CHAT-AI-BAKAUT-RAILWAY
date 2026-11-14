import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export async function verifyResearchLifecycle(repo, db) {
  const sessions = [];
  const create = async () => {
    const visitorId = randomUUID();
    const session = await repo.createSession({ visitorId });
    sessions.push(session.id);
    const turn = await repo.createTurnWithUserMessage({ sessionId: session.id, visitorCapability: visitorId,
      clientMessageId: randomUUID(), requestHash: randomUUID(), content: 'Исследование', deadlineAt: null });
    return { session, turn, visitorId };
  };
  try {
    const abandoned = await create(), running = await create(), recent = await create(), rejected = await create();
    const ownerId = randomUUID();
    assert.ok(await repo.claimTurnExecution({ sessionId: running.session.id, turnId: running.turn.id, ownerId, leaseMs: 300000 }));
    await db.query("UPDATE conversation_sessions SET last_heartbeat_at=now()-interval '31 minutes' WHERE id=ANY($1::uuid[])",
      [[abandoned.session.id, running.session.id]]);
    await repo.expireInactiveSessions();
    assert.equal((await repo.getSession(abandoned.session.id)).status, 'expired');
    assert.equal((await repo.getTurn(abandoned.session.id, abandoned.turn.id)).errorCode, 'session_expired');
    assert.equal((await repo.getSession(running.session.id)).status, 'active');
    assert.equal((await repo.getSession(recent.session.id)).status, 'active');
    assert.ok(await repo.renewTurnExecution({ sessionId: running.session.id, turnId: running.turn.id, ownerId, leaseMs: 300000 }));
    await repo.releaseTurnExecution({ sessionId: running.session.id, turnId: running.turn.id, ownerId });
    await repo.expireInactiveSessions();
    assert.equal((await repo.getSession(running.session.id)).status, 'expired');
    assert.equal(await repo.claimTurnExecution({ sessionId: running.session.id, turnId: running.turn.id, ownerId, leaseMs: 10000 }), null);
    await repo.updateTurn({ sessionId: rejected.session.id, turnId: rejected.turn.id, status: 'failed', errorCode: 'controlled_submission_rejected', requireUnowned: true });
    assert.equal(await repo.claimTurnExecution({ sessionId: rejected.session.id, turnId: rejected.turn.id, ownerId, leaseMs: 10000 }), null);
    const next = await repo.createTurnWithUserMessage({ sessionId: rejected.session.id, visitorCapability: rejected.visitorId,
      clientMessageId: randomUUID(), requestHash: randomUUID(), content: 'Следующий вопрос', deadlineAt: null });
    assert.ok(next.id);
    assert.notEqual(next.id, rejected.turn.id);
    await repo.updateTurn({ sessionId: rejected.session.id, turnId: next.id, status: 'failed', errorCode: 'agent_answer_rejected', requireUnowned: true });
    assert.equal(await repo.claimTurnExecution({ sessionId: rejected.session.id, turnId: next.id, ownerId, leaseMs: 10000 }), null);
    const afterAnswer = await repo.createTurnWithUserMessage({ sessionId: rejected.session.id, visitorCapability: rejected.visitorId,
      clientMessageId: randomUUID(), requestHash: randomUUID(), content: 'Следующий вопрос после неполного ответа', deadlineAt: null });
    await repo.updateTurn({ sessionId: rejected.session.id, turnId: afterAnswer.id, status: 'failed', errorCode: 'provider_response_failed', requireUnowned: true });
    assert.equal(await repo.claimTurnExecution({ sessionId: rejected.session.id, turnId: afterAnswer.id, ownerId, leaseMs: 10000 }), null);
    assert.ok(await repo.createTurnWithUserMessage({ sessionId: rejected.session.id, visitorCapability: rejected.visitorId,
      clientMessageId: randomUUID(), requestHash: randomUUID(), content: 'Повтор после сбоя провайдера', deadlineAt: null }));
    console.log('PASS orphan research expires, live lease and recent session survive, expired/rejected turns cannot restart, next buyer question is accepted');
  } finally {
    await db.query('DELETE FROM conversation_sessions WHERE id=ANY($1::uuid[])', [sessions]);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const target = new URL(process.env.DATABASE_URL || 'file:///missing');
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname) && target.pathname.startsWith('/bakaut_acceptance_'),
    'An explicit isolated loopback bakaut_acceptance_* database is required');
  const { pool } = await import('../src/db/pool.ts');
  const { ConversationRepository } = await import('../src/db/repositories.ts');
  const repo = new ConversationRepository();
  const lock = await pool.connect();
  let lockedSession;
  try {
    await verifyResearchLifecycle(repo, pool);
    lockedSession = await repo.createSession({ visitorId: randomUUID() });
    await pool.query("UPDATE conversation_sessions SET last_heartbeat_at=now()-interval '31 minutes' WHERE id=$1", [lockedSession.id]);
    await lock.query('BEGIN');
    await lock.query('SELECT id FROM conversation_sessions WHERE id=$1 FOR UPDATE', [lockedSession.id]);
    await repo.expireInactiveSessions();
    assert.equal((await repo.getSession(lockedSession.id)).status, 'active');
    await lock.query('ROLLBACK');
    await repo.expireInactiveSessions();
    assert.equal((await repo.getSession(lockedSession.id)).status, 'expired');
    console.log('PASS cleanup skips a session locked by another execution');
  } finally {
    await lock.query('ROLLBACK');
    lock.release();
    if (lockedSession) await pool.query('DELETE FROM conversation_sessions WHERE id=$1', [lockedSession.id]);
    await pool.end();
  }
}
