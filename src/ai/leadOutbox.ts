import { ConversationRepository, LeadRepository, type LeadOutboxItem } from '../db/repositories.js';
import { prepareLeadEmailRequest, sendPreparedLeadEmail } from '../email/httpEmail.js';
import { safeError } from './responseUtils.js';

function nextAttemptAt(attemptCount: number) {
  const delayMinutes = Math.min(60, Math.max(1, 2 ** Math.max(0, attemptCount - 1)));
  return new Date(Date.now() + delayMinutes * 60_000).toISOString();
}

function emailHandoffContext(payload: Record<string, unknown>): {
  preferredContact: 'message' | 'call' | null;
  purpose: string | null;
  buyerQuestion: string | null;
} {
  const preferredContact = payload.preferredContact === 'message' || payload.preferredContact === 'call'
    ? payload.preferredContact
    : null;
  const purpose = typeof payload.purpose === 'string' && payload.purpose.trim()
    ? payload.purpose.trim()
    : null;
  const buyerQuestion = typeof payload.question === 'string' && payload.question.trim()
    ? payload.question.trim()
    : null;
  return { preferredContact, purpose, buyerQuestion };
}

export async function processLeadOutboxItem(input: {
  item: LeadOutboxItem;
  conversations: ConversationRepository;
  leads: LeadRepository;
}) {
  const leaseToken = input.item.leaseToken;
  if (!leaseToken) return {ok: false, error: 'lease_missing'};
  const fail = async (error: string, dead = false) => {
    const updated = await input.leads.markLeadOutboxFailed({id: input.item.id, leaseToken, error, dead,
      nextAttemptAt: dead ? null : nextAttemptAt(input.item.attemptCount)});
    return {ok: false, dead, error, committed: Boolean(updated)};
  };
  // A legacy retry has no immutable wire request. Its prior outcome cannot be
  // reconstructed safely from a mutable transcript or current email settings.
  if (!input.item.requestSnapshot && input.item.attemptCount > 1) {
    return fail('reconciliation_required:legacy_request_unknown', true);
  }
  if (input.item.firstAttemptAt) {
    const age = Date.now() - Date.parse(input.item.firstAttemptAt);
    if (input.item.requestSnapshot?.provider !== 'resend' || !Number.isFinite(age) || age < 0 || age >= 23 * 60 * 60_000) {
      return fail('reconciliation_required:idempotency_window_unavailable', true);
    }
  }
  let snapshot = input.item.requestSnapshot;
  if (!snapshot) {
  const lead = await input.leads.getLead(input.item.leadId);
  const session = await input.conversations.getSession(input.item.sessionId);
  if (!lead || !session) {
    return fail(!lead ? 'lead_not_found' : 'session_not_found', true);
  }

  const messages = await input.conversations.listMessages(session.id, 80);
  const prepared = prepareLeadEmailRequest(lead, {
    session,
    messages,
    handoff: emailHandoffContext(input.item.payload)
  });
  if (!('version' in prepared)) return fail(prepared.error ?? 'email_preparation_failed', true);
  snapshot = prepared;
  }
  const dispatch = await input.leads.prepareLeadOutboxDispatch({id: input.item.id, leaseToken, snapshot});
  if (!dispatch?.requestSnapshot) return {ok: false, error: 'lease_lost'};
  const emailResult = await sendPreparedLeadEmail(dispatch.requestSnapshot);
  if (emailResult.ok) {
    const committed = await input.leads.markLeadOutboxSent(input.item.id, leaseToken, emailResult as unknown as Record<string, unknown>);
    return committed ? {ok: true} : {ok: false, error: 'lease_lost_after_send'};
  }
  const error = JSON.stringify(emailResult).slice(0, 1000);
  if (emailResult.skipped) return fail(`reconciliation_required:${error}`, true);
  return fail(error);
}

export async function processLeadOutboxBatch(input: {
  conversations?: ConversationRepository;
  leads?: LeadRepository;
  limit?: number;
} = {}) {
  const conversations = input.conversations ?? new ConversationRepository();
  const leads = input.leads ?? new LeadRepository();
  const results = [];
  for (let i = 0; i < (input.limit ?? 10); i += 1) {
    // Claim just before sending: queued items must not consume their lease while
    // this worker is awaiting earlier provider requests.
    const [item] = await leads.claimDueLeadOutbox(1);
    if (!item) break;
    results.push(await processLeadOutboxItem({ item, conversations, leads }));
  }
  return { claimed: results.length, results };
}

export function startLeadOutboxWorker(input: {
  log?: { warn: (value: unknown, message?: string) => void };
  intervalMs?: number;
} = {}) {
  const intervalMs = input.intervalMs ?? 30_000;
  const run = () => {
    processLeadOutboxBatch().catch((error) => {
      input.log?.warn({ error: safeError(error) }, 'lead outbox worker failed');
    });
  };
  run();
  const timer = setInterval(run, intervalMs);
  timer.unref?.();
  return timer;
}
