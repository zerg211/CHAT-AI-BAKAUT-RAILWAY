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
    const session = await conversations.getSession(input.sessionId);
    if (!session || session.status !== 'active') {
      return reply.code(404).send({ error: 'Session not found or inactive' });
    }
    const lead = await leads.createClientLead({
      ...input,
      clientRequestHash: requestHash(input)
    });
    if (!lead) {
      const currentSession = await conversations.getSession(input.sessionId);
      if (!currentSession || currentSession.status !== 'active') {
        return reply.code(404).send({ error: 'Session not found or inactive' });
      }
      return reply.code(409).send({ error: 'clientLeadId already used with different payload' });
    }
    let queued = false;
    let outboxId: string | undefined;

    try {
      const turns = await conversations.listTurns(input.sessionId, 200);
      const latestTurn = turns.at(-1);
      const outbox = await conversations.enqueueLeadOutbox({
        leadId: lead.id,
        sessionId: input.sessionId,
        turnId: latestTurn?.id ?? null,
        destination: 'lead_email',
        payload: { leadId: lead.id, source: 'lead_form' }
      });
      queued = Boolean(outbox);
      outboxId = typeof outbox?.id === 'string' ? outbox.id : undefined;
    } catch (error) {
      request.log.warn({ error: safeError(error), leadId: lead.id }, 'lead form outbox enqueue failed');
      await leads.markEmailResult(lead.id, 'email_failed', {
        ok: false,
        queued: false,
        error: 'lead_outbox_enqueue_failed',
        detail: safeError(error)
      });
    }

    return reply.send({
      lead,
      email: {
        ok: false,
        queued,
        outboxId,
        status: queued ? 'queued' : 'saved_without_outbox'
      }
    });
  });
}
