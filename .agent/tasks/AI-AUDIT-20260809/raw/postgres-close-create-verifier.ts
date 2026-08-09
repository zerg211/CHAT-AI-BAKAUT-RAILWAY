import { randomUUID } from 'node:crypto';
import pg from 'pg';

import { config } from '../../../../src/config.js';
import {
  ConversationRepository,
  ConversationSessionUnavailableError
} from '../../../../src/db/repositories.js';

type ConnectedClient = InstanceType<typeof pg.Client>;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function connectClient() {
  const client = new pg.Client({ connectionString: config.DATABASE_URL });
  await client.connect();
  return client;
}

async function backendPid(client: ConnectedClient) {
  const result = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
  return result.rows[0].pid;
}

async function waitUntilBlocked(observer: ConnectedClient, pid: number, label: string) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const result = await observer.query<{ blockers: number }>(
      'SELECT cardinality(pg_blocking_pids($1))::int AS blockers',
      [pid]
    );
    if ((result.rows[0]?.blockers ?? 0) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`${label} did not reach the PostgreSQL row-lock barrier`);
}

async function main() {
  const setup = await connectClient();
  const lockOwner = await connectClient();
  const contender = await connectClient();
  const observer = await connectClient();
  const createdSessionIds: string[] = [];

  try {
    const setupRepository = new ConversationRepository(setup);

    // Serialized outcome A: close owns the session row first; create must fail
    // closed and leave neither a turn nor an orphan user message.
    {
      const visitorCapability = randomUUID();
      const session = await setupRepository.createSession({ visitorId: visitorCapability });
      createdSessionIds.push(session.id);

      await lockOwner.query('BEGIN');
      await lockOwner.query(
        'SELECT id FROM conversation_sessions WHERE id = $1 FOR UPDATE',
        [session.id]
      );

      const contenderRepository = new ConversationRepository(contender);
      const contenderPid = await backendPid(contender);
      const createResult = contenderRepository.createTurnWithUserMessage({
        sessionId: session.id,
        visitorCapability,
        clientMessageId: randomUUID(),
        requestHash: randomUUID(),
        content: 'close first must reject this message'
      }).then(
        () => ({ unavailable: false }),
        (error: unknown) => ({ unavailable: error instanceof ConversationSessionUnavailableError })
      );

      await waitUntilBlocked(observer, contenderPid, 'close-first create');
      const lockOwnerRepository = new ConversationRepository(lockOwner);
      const closed = await lockOwnerRepository.closeSession({ id: session.id, visitorCapability });
      assert(closed?.status === 'closed', 'close-first session was not closed');
      await lockOwner.query('COMMIT');

      assert((await createResult).unavailable, 'create succeeded after serialized close');
      const readback = await setup.query<{ turn_count: number; message_count: number }>(
        `SELECT
           (SELECT count(*)::int FROM conversation_turns WHERE session_id = $1) AS turn_count,
           (SELECT count(*)::int FROM messages WHERE session_id = $1) AS message_count`,
        [session.id]
      );
      assert(readback.rows[0]?.turn_count === 0, 'close-first leaked a conversation turn');
      assert(readback.rows[0]?.message_count === 0, 'close-first leaked an orphan user message');
    }

    // Serialized outcome B: create owns the session row first; close waits, then
    // revokes the now-linked active turn without losing the accepted user message.
    {
      const visitorCapability = randomUUID();
      const session = await setupRepository.createSession({ visitorId: visitorCapability });
      createdSessionIds.push(session.id);

      await lockOwner.query('BEGIN');
      const lockOwnerRepository = new ConversationRepository(lockOwner);
      const turn = await lockOwnerRepository.createTurnWithUserMessage({
        sessionId: session.id,
        visitorCapability,
        clientMessageId: randomUUID(),
        requestHash: randomUUID(),
        content: 'create first persists this message'
      });
      assert(turn.userMessageId !== null, 'create-first did not return a linked user message');

      const contenderRepository = new ConversationRepository(contender);
      const contenderPid = await backendPid(contender);
      await contender.query('BEGIN');
      const closeResult = contenderRepository.closeSession({ id: session.id, visitorCapability });
      await waitUntilBlocked(observer, contenderPid, 'create-first close');
      await lockOwner.query('COMMIT');

      const closed = await closeResult;
      assert(closed?.status === 'closed', 'create-first close did not complete');
      await contender.query('COMMIT');
      const readback = await setup.query<{
        session_status: string;
        turn_status: string;
        turn_stage: string;
        turn_error_code: string | null;
        linked_message_id: string | null;
        message_content: string | null;
      }>(
        `SELECT session.status AS session_status,
                turn.status AS turn_status,
                turn.stage AS turn_stage,
                turn.error_code AS turn_error_code,
                turn.user_message_id::text AS linked_message_id,
                message.content AS message_content
         FROM conversation_sessions AS session
         JOIN conversation_turns AS turn ON turn.session_id = session.id
         LEFT JOIN messages AS message ON message.id = turn.user_message_id
         WHERE session.id = $1`,
        [session.id]
      );
      assert(readback.rows[0]?.session_status === 'closed', 'create-first session stayed active');
      assert(
        readback.rows[0]?.turn_status === 'failed',
        `close did not terminalize the active turn; actual=${JSON.stringify({
          status: readback.rows[0]?.turn_status,
          stage: readback.rows[0]?.turn_stage,
          errorCode: readback.rows[0]?.turn_error_code
        })}`
      );
      assert(
        readback.rows[0]?.turn_stage === 'session_closed',
        `close used the wrong terminal stage; actual=${readback.rows[0]?.turn_stage}`
      );
      assert(readback.rows[0]?.linked_message_id === turn.userMessageId, 'linked message id changed');
      assert(readback.rows[0]?.message_content === 'create first persists this message', 'accepted user message was lost');
    }

    console.log(JSON.stringify({
      postgresCloseCreateVerifier: 'PASS',
      cases: ['close_first_rejects_without_orphans', 'create_first_links_then_close_revokes']
    }));
  } finally {
    try {
      await lockOwner.query('ROLLBACK');
    } catch {
      // The transaction may already be closed.
    }
    try {
      await contender.query('ROLLBACK');
    } catch {
      // The transaction may already be closed.
    }
    for (const sessionId of createdSessionIds) {
      await setup.query('DELETE FROM conversation_sessions WHERE id = $1', [sessionId]);
    }
    await Promise.all([setup.end(), lockOwner.end(), contender.end(), observer.end()]);
  }
}

await main();
