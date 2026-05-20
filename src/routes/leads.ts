import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ConversationRepository, LeadRepository } from '../db/repositories.js';
import { safeError } from '../ai/responseUtils.js';

const leadSchema = z.object({
  sessionId: z.string().uuid().optional(),
  name: z.string().trim().min(2).max(120),
  phone: z.string().trim().max(80).optional(),
  email: z.string().trim().email().optional(),
  question: z.string().trim().max(3000).optional()
}).refine((value) => value.phone || value.email, {
  message: 'phone or email is required'
});

export async function registerLeadRoutes(app: FastifyInstance) {
  const leads = new LeadRepository();
  const conversations = new ConversationRepository();

  app.post('/api/leads', async (request, reply) => {
    const input = leadSchema.parse(request.body ?? {});
    const lead = await leads.createLead(input);
    let queued = false;
    let outboxId: string | undefined;

    if (lead.sessionId) {
      try {
        const turns = await conversations.listTurns(lead.sessionId, 200);
        const latestTurn = turns.at(-1);
        if (latestTurn) {
          const outbox = await conversations.enqueueLeadOutbox({
            leadId: lead.id,
            sessionId: lead.sessionId,
            turnId: latestTurn.id,
            destination: 'lead_email',
            payload: { leadId: lead.id, source: 'lead_form' }
          });
          queued = Boolean(outbox);
          outboxId = typeof outbox?.id === 'string' ? outbox.id : undefined;
        }
      } catch (error) {
        request.log.warn({ error: safeError(error), leadId: lead.id }, 'lead form outbox enqueue failed');
        await leads.markEmailResult(lead.id, 'email_failed', {
          ok: false,
          queued: false,
          error: 'lead_outbox_enqueue_failed',
          detail: safeError(error)
        });
      }
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
