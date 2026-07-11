import { ConversationRepository, LeadRepository, type LeadOutboxItem } from '../db/repositories.js';
import { sendLeadEmail } from '../email/httpEmail.js';
import { safeError } from './responseUtils.js';

function nextAttemptAt(attemptCount: number) {
  const delayMinutes = Math.min(60, Math.max(1, 2 ** Math.max(0, attemptCount - 1)));
  return new Date(Date.now() + delayMinutes * 60_000).toISOString();
}

export async function processLeadOutboxItem(input: {
  item: LeadOutboxItem;
  conversations: ConversationRepository;
  leads: LeadRepository;
}) {
  const lead = await input.leads.getLead(input.item.leadId);
  const session = await input.conversations.getSession(input.item.sessionId);
  if (!lead || !session) {
    await input.leads.markLeadOutboxFailed({
      id: input.item.id,
      error: !lead ? 'lead_not_found' : 'session_not_found',
      dead: true
    });
    return { ok: false, dead: true, error: !lead ? 'lead_not_found' : 'session_not_found' };
  }

  const messages = await input.conversations.listMessages(session.id, 80);
  const emailResult = await sendLeadEmail(lead, { session, messages });
  if (emailResult.ok) {
    await input.leads.markLeadOutboxSent(input.item.id);
    await input.leads.markEmailResult(lead.id, 'sent_email', emailResult as unknown as Record<string, unknown>);
    return { ok: true };
  }

  const error = JSON.stringify(emailResult).slice(0, 1000);
  await input.leads.markLeadOutboxFailed({
    id: input.item.id,
    error,
    nextAttemptAt: nextAttemptAt(input.item.attemptCount)
  });
  await input.leads.markEmailResult(lead.id, 'email_failed', emailResult as unknown as Record<string, unknown>);
  return { ok: false, error };
}

export async function processLeadOutboxBatch(input: {
  conversations?: ConversationRepository;
  leads?: LeadRepository;
  limit?: number;
} = {}) {
  const conversations = input.conversations ?? new ConversationRepository();
  const leads = input.leads ?? new LeadRepository();
  const items = await leads.claimDueLeadOutbox(input.limit ?? 10);
  const results = [];
  for (const item of items) {
    results.push(await processLeadOutboxItem({ item, conversations, leads }));
  }
  return { claimed: items.length, results };
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
