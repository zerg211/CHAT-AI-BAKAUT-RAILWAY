import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { LeadRepository } from '../db/repositories.js';
import type { AvailabilityReceipt, AvailabilityRequest, Message } from '../shared/types.js';
import { normalizeAvailabilityRequest } from '../shared/publicChatHistory.js';
import { extractContact } from './contactExtraction.js';

export const availabilityOutputSchema = {
  type: ['object', 'null'], additionalProperties: false,
  properties: {
    action: { type: 'string', enum: ['none', 'offer', 'request_contact', 'capture', 'decline'] },
    continueRequest: { type: 'boolean' }, consentGranted: { type: 'boolean' },
    consentQuote: { type: ['string', 'null'] }, requestSummary: { type: 'string' },
    productIds: { type: 'array', items: { type: 'string' } },
    preferredContact: { type: ['string', 'null'], enum: ['message', 'call', null] }
  }, required: ['action', 'continueRequest', 'consentGranted', 'consentQuote', 'requestSummary', 'productIds', 'preferredContact']
} as const;

const decisionSchema = z.object({
  action: z.enum(['none', 'offer', 'request_contact', 'capture', 'decline']),
  continueRequest: z.boolean(), consentGranted: z.boolean(), consentQuote: z.string().max(3000).nullable(),
  requestSummary: z.string().max(3000), productIds: z.array(z.string().regex(/^[0-9a-f]{24}$/)),
  preferredContact: z.enum(['message', 'call']).nullable()
}).strict();

export function latestAvailabilityRequest(messages: readonly Pick<Message, 'role' | 'metadata'>[]): AvailabilityRequest | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role !== 'assistant') continue;
    const request = normalizeAvailabilityRequest(messages[i].metadata.availabilityRequest);
    if (request) return request;
  }
}

export function availabilityLeadHash(input: {
  name?: string; phone?: string; email?: string; preferredContact?: 'message' | 'call'; question?: string;
}) {
  return createHash('sha256').update(JSON.stringify({ name: input.name,
    preferredContact: input.preferredContact ?? null, phone: input.phone ?? null,
    email: input.email ?? null, question: input.question ?? null })).digest('hex');
}

export function durableAvailabilityLead(completion: Awaited<ReturnType<LeadRepository['createClientLeadWithOutbox']>>) {
  return !!completion?.lead.id && !!completion.outbox.id.trim() &&
    ['pending', 'sending', 'sent', 'failed'].includes(completion.outbox.status);
}

function safeScope(summary: string, userMessages: string[]) {
  let text = summary.replace(/\s+/g, ' ');
  for (const message of userMessages) {
    const contact = extractContact(message);
    for (const value of [contact.name, contact.email, contact.phone]) if (value) text = text.split(value).join('[контакт скрыт]');
  }
  text = text.replace(/\+?\d[\d\s().-]{7,}\d/g,
    candidate => extractContact(candidate).phone ? '[контакт скрыт]' : candidate);
  return text.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[контакт скрыт]').trim().slice(0, 3000);
}

export interface PlatformAvailabilityInput {
  db: Pool | PoolClient; sessionId: string; turnId: string; userMessage: string;
  decision: unknown; priorMessages: Message[]; knownProductIds?: string[];
}

export async function applyPlatformAvailability(input: PlatformAvailabilityInput): Promise<{
  leadRequested: boolean; leadCreated: boolean;
  availabilityRequest?: AvailabilityRequest; availabilityReceipt?: AvailabilityReceipt; metadata: Record<string, unknown>;
}> {
  const parsed = decisionSchema.safeParse(input.decision);
  const inactive = { leadRequested: false, leadCreated: false, metadata: {} };
  if (!parsed.success || parsed.data.action === 'none') return inactive;
  const decision = parsed.data;
  const sessionMessages = input.priorMessages.filter(message => message.sessionId === input.sessionId);
  const previous = latestAvailabilityRequest(sessionMessages);
  const continuing = decision.continueRequest && previous;
  const question = continuing ? previous.question : safeScope(decision.requestSummary,
    [...sessionMessages.filter(message => message.role === 'user').map(message => message.content), input.userMessage]);
  if (!question) return inactive;
  const productIds = continuing ? previous.productIds : [...new Set(decision.productIds)];
  if (!continuing && input.knownProductIds && productIds.some(id => !input.knownProductIds!.includes(id))) return inactive;
  let request: AvailabilityRequest = continuing ? { ...previous } : {
    id: input.turnId, state: 'offered', question, productIds
  };
  if (!z.string().uuid().safeParse(request.id).success) return inactive;
  if (decision.preferredContact) request.preferredContact = decision.preferredContact;
  const result = (outcome: AvailabilityReceipt['outcome'], state: AvailabilityRequest['state'], leadRequested = false, leadCreated = false) => {
    request = { ...request, state };
    const availabilityReceipt: AvailabilityReceipt = { requestId: request.id, outcome, warehouseChecked: false };
    return { leadRequested, leadCreated, availabilityRequest: request, availabilityReceipt,
      metadata: { availabilityRequest: request, availabilityReceipt, leadRequested, leadCreated } };
  };
  if (decision.action === 'decline') return continuing && previous.state === 'queued'
    ? result('cancellation_not_confirmed', 'queued', false, true)
    : result('declined', 'declined');
  if (continuing && previous.state === 'queued') return result('already_queued', 'queued', false, true);
  if (decision.action === 'offer') return result('offered', 'offered');
  if (decision.action === 'request_contact') return result('contact_requested', 'contact_requested', true);
  const quote = decision.consentQuote?.trim();
  const contact = extractContact(input.userMessage);
  if (!decision.consentGranted || !quote || !input.userMessage.includes(quote) || (!contact.phone && !contact.email)) {
    return result('consent_required', 'contact_requested', true);
  }
  const leads = new LeadRepository(input.db);
  await input.db.query('SAVEPOINT platform_availability_capture');
  try {
    let completion = await leads.findClientLeadWithOutbox(input.sessionId, request.id);
    let alreadyQueued = Boolean(completion);
    if (!completion) {
      const payload = { sessionId: input.sessionId, clientLeadId: request.id, ...contact,
        question: request.question, preferredContact: request.preferredContact };
      completion = await leads.createClientLeadWithOutbox({ ...payload, clientRequestHash: availabilityLeadHash(payload),
        skipPendingDraft: true, purpose: 'availability', source: 'platform_chat' });
      if (!completion) {
        completion = await leads.findClientLeadWithOutbox(input.sessionId, request.id);
        alreadyQueued = Boolean(completion);
      }
    }
    if (!durableAvailabilityLead(completion)) throw new Error('availability_capture_not_durable');
    await input.db.query('RELEASE SAVEPOINT platform_availability_capture');
    return result(alreadyQueued ? 'already_queued' : 'queued', 'queued', false, true);
  } catch {
    await input.db.query('ROLLBACK TO SAVEPOINT platform_availability_capture');
    await input.db.query('RELEASE SAVEPOINT platform_availability_capture');
    return result('failed', 'failed', true);
  }
}
