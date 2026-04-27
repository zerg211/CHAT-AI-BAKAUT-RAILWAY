import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ConversationRepository, LeadRepository } from '../db/repositories.js';
import { sendLeadEmail } from '../email/httpEmail.js';

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
    const session = lead.sessionId ? await conversations.getSession(lead.sessionId) : null;
    const messages = lead.sessionId ? await conversations.listMessages(lead.sessionId, 60) : [];
    const emailResult = await sendLeadEmail(lead, { session, messages });
    const updated = await leads.markEmailResult(
      lead.id,
      emailResult.ok ? 'sent_email' : 'email_failed',
      emailResult as unknown as Record<string, unknown>
    );
    return reply.send({ lead: updated, email: emailResult });
  });
}
