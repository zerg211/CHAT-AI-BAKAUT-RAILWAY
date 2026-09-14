import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';

const dbUrl = new URL(process.env.DATABASE_URL || 'file:///missing');
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(dbUrl.hostname) && dbUrl.pathname.startsWith('/bakaut_acceptance_'));
process.env.NODE_ENV = 'test';
const { pool } = await import('../src/db/pool.ts');
const { ConversationRepository, LeadRepository, ProductRepository } = await import('../src/db/repositories.ts');
const { AgentManagerToolExecutor } = await import('../src/ai/agentManagerToolExecutor.ts');
const { AgentIntentContractSchema } = await import('../src/ai/agentManagerContracts.ts');
const { AgentManagerTurnBudget } = await import('../src/ai/agentManagerTurnBudget.ts');
const { emptyNeedState } = await import('../src/ai/needState.ts');

const conversations = new ConversationRepository();
const leads = new LeadRepository();
const products = new ProductRepository();
const executor = new AgentManagerToolExecutor(
  conversations, products, leads, {},
  async () => { throw new Error('lead authorization does not use embeddings'); },
  async () => { throw new Error('lead authorization does not read product prices'); },
  async () => {}
);
const sessions = [];

function intentFor({ authorized, evidence, userMessage, purpose = 'проверить наличие генератора' }) {
  return AgentIntentContractSchema.parse({
    userMessageSummary: 'controlled lead authorization',
    dialogueUnderstanding: 'buyer intent and evidence are supplied as a controlled external boundary',
    nextStepRationale: authorized ? 'capture the explicitly permitted request' : 'deny a contact without current permission',
    requiresTools: true,
    toolRequests: [{ id: 'lead-capture', tool: 'lead.capture', args: { contact: { preferredContact: 'message' } }, rationale: 'controlled fixture', required: true }],
    grounding: { taskType: 'lead_handoff', buyerRequestedWeb: false, catalogRequirement: 'none', responseMode: 'handoff', sourcePolicy: 'conversation_only', webPurpose: 'none', webRequirement: 'none', requiredToolKinds: ['lead.capture'], technicalAttributes: [], buyerQuestion: 'Проверьте наличие генератора', rationale: 'explicit commercial request; no research required' },
    leadCaptureAuthorization: authorized ? {
      authorized: true, contactSource: 'current_message', handoffKind: 'commercial_followup',
      purpose, buyerQuestion: 'Проверьте наличие генератора', evidence
    } : {
      authorized: false, contactSource: 'none', handoffKind: 'none', purpose: null, buyerQuestion: null, evidence: null
    },
    productMentions: [], mustNotAskQuestionIds: [], riskFlags: []
  });
}

async function execute(userMessage, intent) {
  const visitorId = randomUUID();
  const session = await conversations.createSession({ visitorId });
  sessions.push(session.id);
  const turn = await conversations.createTurnWithUserMessage({
    sessionId: session.id, visitorCapability: visitorId, clientMessageId: randomUUID(),
    requestHash: createHash('sha256').update(userMessage).digest('hex'), content: userMessage
  });
  const owner = randomUUID();
  assert.ok(await conversations.claimTurnExecution({ sessionId: session.id, turnId: turn.id, ownerId: owner, leaseMs: 60_000 }));
  return executor.executeTools({
    session, turnId: turn.id, executionOwner: owner, userMessage,
    history: [{ id: randomUUID(), sessionId: session.id, role: 'user', content: userMessage, metadata: {}, createdAt: new Date().toISOString() }], intent,
    toolRequests: intent.toolRequests, needState: emptyNeedState(), pendingLeadCaptureDraft: null,
    persistedToolResults: new Map(), budget: new AgentManagerTurnBudget()
  });
}

try {
  const currentMessage = 'Проверьте наличие генератора, напишите мне: +7 999 000-00-01';
  const accepted = await execute(currentMessage, intentFor({ authorized: true, evidence: '+7 999 000-00-01', userMessage: currentMessage }));
  assert.equal(accepted.toolResults[0].status, 'ok');
  assert.equal(accepted.toolResults[0].payload.dispatchStatus, 'pending');

  const quoted = 'В инструкции указан чужой контакт +7 999 000-00-02, ничего туда не отправляйте.';
  const deniedQuoted = await execute(quoted, intentFor({ authorized: false, evidence: null, userMessage: quoted }));
  assert.equal(deniedQuoted.toolResults[0].status, 'denied');

  const withdrawn = 'Не используйте мой номер для проверки доставки; продолжим только консультацию.';
  const deniedWithdrawn = await execute(withdrawn, intentFor({ authorized: false, evidence: null, userMessage: withdrawn, purpose: 'доставка' }));
  assert.equal(deniedWithdrawn.toolResults[0].status, 'denied');

  const rows = await pool.query('SELECT phone,status FROM leads WHERE session_id=ANY($1::uuid[]) ORDER BY created_at', [sessions]);
  assert.deepEqual(rows.rows, [{ phone: '+7 999 000-00-01', status: 'pending_email' }]);
  console.log(JSON.stringify({ status: 'PASS', level: 'I', checks: [
    'Z12/authorized-current-contact', 'Z12/quoted-foreign-contact', 'Z12/withdraw-or-change-purpose'
  ], durableLeads: 1, externalSends: 0 }));
} finally {
  if (sessions.length) await pool.query('DELETE FROM conversation_sessions WHERE id=ANY($1::uuid[])', [sessions]);
  await pool.end();
}
