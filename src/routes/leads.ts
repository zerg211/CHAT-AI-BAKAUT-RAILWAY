import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ConversationRepository, LeadRepository } from '../db/repositories.js';
import { safeError } from '../ai/responseUtils.js';

const leadSchema = z.object({
  sessionId: z.string().uuid(),
  clientLeadId: z.string().uuid(),
  name: z.string().trim().min(2).max(120),
  phone: z.string().trim().min(5).max(40).optional(),
  email: z.string().trim().max(254).email().optional(),
  question: z.string().trim().min(1).max(3000).optional()
}).refine((value) => value.phone || value.email, {
  message: 'phone or email is required'
}).strict();

function requestHash(input: z.infer<typeof leadSchema>) {
  return createHash('sha256').update(JSON.stringify({
    name: input.name,
    phone: input.phone ?? null,
    email: input.email ?? null,
    question: input.question ?? null
  })).digest('hex');
}

function durableLeadOutboxStatus(row: unknown) {
  if (!row || typeof row !== 'object') return null;
  const status = (row as { status?: unknown }).status;
  return status === 'pending' || status === 'sending' || status === 'sent' || status === 'failed'
    ? status
    : null;
}

function pendingDraftWasPreserved(completion: Awaited<ReturnType<LeadRepository['createClientLeadWithOutbox']>>) {
  if (!completion || !completion.pendingDraftMatched) return true;
  const draft = completion.draft;
  if (!draft || draft.status !== 'consumed' || draft.consumedLeadId !== completion.lead.id) return false;
  const payload = completion.outbox.payload;
  return payload.purpose === draft.purpose &&
    payload.question === draft.buyerQuestion &&
    (payload.preferredContact ?? null) === (draft.preferredContact ?? null);
}

export async function registerLeadRoutes(app: FastifyInstance) {
  const leads = new LeadRepository();
  const conversations = new ConversationRepository();

  app.post('/api/leads', {
    config: {
      rateLimit: { max: 10, timeWindow: '1 minute' }
    }
  }, async (request, reply) => {
    const parsed = leadSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid lead request' });
    const input = parsed.data;
    reply.header('cache-control', 'no-store');
    reply.header('vary', 'x-bakaut-visitor-id');
    const capabilityHeader = request.headers['x-bakaut-visitor-id'];
    const visitorCapability = typeof capabilityHeader === 'string' && capabilityHeader.trim()
      ? capabilityHeader
      : null;
    const session = visitorCapability
      ? await conversations.restoreSession(input.sessionId, visitorCapability)
      : null;
    if (!visitorCapability || !session) {
      return reply.code(404).send({ error: 'Session not found or inactive' });
    }
    let capturedLeadId: string | undefined;
    try {
      const completion = await leads.createClientLeadWithOutbox({
        ...input,
        clientRequestHash: requestHash(input)
      });
      if (!completion) {
        const currentSession = await conversations.restoreSession(input.sessionId, visitorCapability);
        if (!currentSession) {
          return reply.code(404).send({ error: 'Session not found or inactive' });
        }
        return reply.code(409).send({ error: 'clientLeadId already used with different payload' });
      }
      capturedLeadId = completion.lead.id;
      const outboxId = completion.outbox.id.trim() || undefined;
      const dispatchStatus = durableLeadOutboxStatus(completion.outbox);
      if (!outboxId || !dispatchStatus || !pendingDraftWasPreserved(completion)) {
        throw new Error(`lead_outbox_not_dispatchable:${completion.outbox.status}`);
      }
      return reply.send({
        ok: true,
        status: 'queued',
        lead: completion.lead,
        outboxId,
        dispatchStatus
      });
    } catch (error) {
      request.log.warn({ error: safeError(error), leadId: capturedLeadId }, 'lead form atomic capture failed');
      return reply.code(503).send({
        ok: false,
        error: 'lead_outbox_enqueue_failed',
        retryable: true,
        ...(capturedLeadId ? { leadId: capturedLeadId } : {})
      });
    }
  });
}
