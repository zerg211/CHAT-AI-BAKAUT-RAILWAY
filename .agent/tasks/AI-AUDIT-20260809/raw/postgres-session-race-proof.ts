import { randomUUID } from 'node:crypto';
import pg from 'pg';

import { config } from '../../../../src/config.js';
import {
  ConversationRepository,
  TurnMutationFenceError
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
    const result = await observer.query<{ blocker_count: number }>(
      'SELECT cardinality(pg_blocking_pids($1))::int AS blocker_count',
      [pid]
    );
    if ((result.rows[0]?.blocker_count ?? 0) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`${label} did not reach the PostgreSQL row-lock barrier`);
}

async function createActiveTurn(repository: ConversationRepository) {
  const visitorCapability = randomUUID();
  const session = await repository.createSession({ visitorId: visitorCapability });
  const clientMessageId = randomUUID();
  const requestHash = randomUUID();
  const operation = {
    sessionId: session.id,
    visitorCapability,
    clientMessageId,
    requestHash,
    content: 'race proof question',
    deadlineAt: new Date(Date.now() + 60_000).toISOString()
  };
  const turn = await repository.createTurnWithUserMessage(operation);
  const replayedTurn = await repository.createTurnWithUserMessage(operation);
  const persistedTurn = await repository.getTurn(session.id, turn.id);
  const persistedMessages = await repository.listMessages(session.id, 10);
  assert(replayedTurn.id === turn.id, 'idempotent atomic turn replay created a different turn');
  assert(
    persistedTurn?.userMessageId === turn.userMessageId && turn.userMessageId !== null,
    'atomic turn creation did not persist the linked user message id'
  );
  assert(
    persistedMessages.some((message) => message.id === turn.userMessageId && message.content === 'race proof question'),
    'atomic turn creation did not survive a separate message readback'
  );
  assert(
    persistedMessages.filter((message) => message.role === 'user').length === 1,
    'idempotent atomic turn replay duplicated the user message'
  );
  return { session, turn, visitorCapability };
}

async function main() {
  const setup = await connectClient();
  const control = await connectClient();
  const contenderA = await connectClient();
  const observer = await connectClient();
  const createdSessionIds: string[] = [];

  try {
    const setupRepository = new ConversationRepository(setup);

    // Race 1: close owns the session row first, so queued feedback must fail closed.
    {
      const { session, turn, visitorCapability } = await createActiveTurn(setupRepository);
      createdSessionIds.push(session.id);
      const owner = randomUUID();
      const claimed = await setupRepository.claimTurnExecution({
        sessionId: session.id,
        turnId: turn.id,
        ownerId: owner,
        leaseMs: 60_000
      });
      assert(claimed, 'feedback race turn was not claimed');
      const assistant = await setupRepository.addAssistantMessageForTurn({
        sessionId: session.id,
        turnId: turn.id,
        executionOwner: owner,
        content: 'race proof answer',
        answerContract: { answerText: 'race proof answer' },
        responsePayload: { answer: 'race proof answer' }
      });

      await control.query('BEGIN');
      await control.query('SELECT id FROM conversation_sessions WHERE id = $1 FOR UPDATE', [session.id]);
      const feedbackRepository = new ConversationRepository(contenderA);
      const feedbackPid = await backendPid(contenderA);
      const feedbackPromise = feedbackRepository.updateAssistantFeedback({
        sessionId: session.id,
        messageId: assistant.id,
        visitorCapability,
        rating: 'positive'
      });
      await waitUntilBlocked(observer, feedbackPid, 'feedback mutation');

      const controlRepository = new ConversationRepository(control);
      const closed = await controlRepository.closeSession({ id: session.id, visitorCapability });
      assert(closed?.status === 'closed', 'session did not close inside the lock owner transaction');
      await control.query('COMMIT');

      const feedback = await feedbackPromise;
      assert(feedback === null, 'feedback mutated a session after the serialized close');
      const stored = await setup.query<{ has_feedback: boolean }>(
        "SELECT metadata ? 'feedback' AS has_feedback FROM messages WHERE id = $1",
        [assistant.id]
      );
      assert(stored.rows[0]?.has_feedback === false, 'feedback metadata leaked through the close barrier');
    }

    // Race 2: close owns the session row first, so queued final persistence must be fenced.
    {
      const { session, turn, visitorCapability } = await createActiveTurn(setupRepository);
      createdSessionIds.push(session.id);
      const owner = randomUUID();
      const claimed = await setupRepository.claimTurnExecution({
        sessionId: session.id,
        turnId: turn.id,
        ownerId: owner,
        leaseMs: 60_000
      });
      assert(claimed, 'finalization race turn was not claimed');

      await control.query('BEGIN');
      await control.query('SELECT id FROM conversation_sessions WHERE id = $1 FOR UPDATE', [session.id]);
      const finalRepository = new ConversationRepository(contenderA);
      const finalPid = await backendPid(contenderA);
      const finalPromise = finalRepository.addAssistantMessageForTurn({
        sessionId: session.id,
        turnId: turn.id,
        executionOwner: owner,
        content: 'must not persist after close',
        answerContract: { answerText: 'must not persist after close' },
        responsePayload: { answer: 'must not persist after close' }
      });
      const fencedFinalPromise = finalPromise.then(
        () => ({ fenced: false }),
        (error: unknown) => ({ fenced: error instanceof TurnMutationFenceError })
      );
      await waitUntilBlocked(observer, finalPid, 'final answer persistence');

      const controlRepository = new ConversationRepository(control);
      const closed = await controlRepository.closeSession({ id: session.id, visitorCapability });
      assert(closed?.status === 'closed', 'session did not close before final persistence');
      await control.query('COMMIT');

      const finalResult = await fencedFinalPromise;
      assert(finalResult.fenced, 'final answer persisted after the serialized session close');
      const stored = await setup.query<{ assistant_count: number }>(
        "SELECT count(*)::int AS assistant_count FROM messages WHERE session_id = $1 AND role = 'assistant'",
        [session.id]
      );
      assert(stored.rows[0]?.assistant_count === 0, 'assistant message leaked through the close barrier');
    }

    // Race 3: a queued new owner wins first; the stale owner must not persist an artifact.
    {
      const { session, turn } = await createActiveTurn(setupRepository);
      createdSessionIds.push(session.id);
      const staleOwner = randomUUID();
      const nextOwner = randomUUID();
      const claimed = await setupRepository.claimTurnExecution({
        sessionId: session.id,
        turnId: turn.id,
        ownerId: staleOwner,
        leaseMs: 60_000
      });
      assert(claimed, 'stale-owner race turn was not claimed');

      await control.query('BEGIN');
      await control.query('SELECT id FROM conversation_sessions WHERE id = $1 FOR UPDATE', [session.id]);
      await control.query(
        "UPDATE conversation_turns SET execution_owner = $2::uuid, execution_lease_expires_at = now() + interval '60 seconds' WHERE id = $1",
        [turn.id, nextOwner]
      );

      const staleRepository = new ConversationRepository(contenderA);
      const stalePid = await backendPid(contenderA);
      const toolRequestId = randomUUID();
      const staleWritePromise = staleRepository.saveToolArtifact({
        sessionId: session.id,
        turnId: turn.id,
        executionOwner: staleOwner,
        toolName: 'catalog.searchProducts',
        toolRequestId,
        status: 'ok',
        payload: { stale: true }
      });
      const fencedStaleWrite = staleWritePromise.then(
        () => ({ fenced: false }),
        (error: unknown) => ({ fenced: error instanceof TurnMutationFenceError })
      );
      await waitUntilBlocked(observer, stalePid, 'stale durable write');
      await control.query('COMMIT');

      const staleResult = await fencedStaleWrite;
      assert(staleResult.fenced, 'stale execution owner persisted after takeover');
      const storedTurn = await setup.query<{ execution_owner: string | null }>(
        'SELECT execution_owner::text FROM conversation_turns WHERE id = $1',
        [turn.id]
      );
      assert(storedTurn.rows[0]?.execution_owner === nextOwner, 'new execution owner was not committed');
      const artifact = await setup.query<{ artifact_count: number }>(
        'SELECT count(*)::int AS artifact_count FROM tool_artifacts WHERE tool_request_id = $1',
        [toolRequestId]
      );
      assert(artifact.rows[0]?.artifact_count === 0, 'stale artifact leaked through the owner fence');
    }

    console.log(JSON.stringify({
      postgresBarrierRaceProof: 'PASS',
      cases: [
        'close_vs_feedback',
        'close_vs_final_answer_commit',
        'new_owner_vs_stale_durable_write'
      ]
    }));
  } finally {
    try {
      await control.query('ROLLBACK');
    } catch {
      // The transaction may already be closed.
    }
    for (const sessionId of createdSessionIds) {
      await setup.query('DELETE FROM conversation_sessions WHERE id = $1', [sessionId]);
    }
    await Promise.all([
      setup.end(),
      control.end(),
      contenderA.end(),
      observer.end()
    ]);
  }
}

await main();
