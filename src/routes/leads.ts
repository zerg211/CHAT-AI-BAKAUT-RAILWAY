import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { ConversationRepository, LeadRepository } from '../db/repositories.js';
import { pool } from '../db/pool.js';
import { latestAvailabilityRequest, durableAvailabilityLead } from '../ai/platformAvailability.js';
import { availabilityTextLimit } from '../shared/availabilityText.js';
import { buildLeadProductReferences, type LeadProductReference } from '../ai/leadProductReferences.js';

const leadSchema = z.object({
  sessionId: z.string().uuid(),
  clientLeadId: z.string().uuid(),
  availabilityRequestId: z.string().uuid().optional(),
  name: z.preprocess(value => value === '' ? undefined : value, z.string().trim().min(1).max(120).optional()),
  preferredContact: z.enum(['message', 'call']).optional(),
  phone: z.string().trim().min(5).max(40).optional(),
  email: z.string().trim().max(254).email().optional(),
  question: z.string().trim().min(1).max(availabilityTextLimit).optional()
}).refine((value) => value.phone || value.email, {
  message: 'phone or email is required'
}).strict();

function requestHash(input: z.infer<typeof leadSchema>, productIds?: string[]) {
  return createHash('sha256').update(JSON.stringify({
    name: input.name,
    preferredContact: input.preferredContact ?? null,
    phone: input.phone ?? null,
    email: input.email ?? null,
    question: input.question ?? null,
    ...(productIds?.length ? { productIds } : {})
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
    let input = parsed.data;
    let productIds: string[] | undefined;
    let productReferences: LeadProductReference[] | undefined;
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
    let db: PoolClient | undefined;
    let transactionOpen = false;
    const rollback = async () => {
      if (db && transactionOpen) {
        await db.query('ROLLBACK');
        transactionOpen = false;
      }
    };
    try {
      let captureLeads = leads;
      let captureConversations = conversations;
      if (input.availabilityRequestId) {
        db = await pool.connect();
        await db.query('BEGIN');
        transactionOpen = true;
        const locked = await db.query(
          `SELECT id FROM conversation_sessions
           WHERE id=$1::uuid AND visitor_id=$2 AND status='active' FOR UPDATE`,
          [input.sessionId, visitorCapability]
        );
        if (!locked.rows.length) {
          await rollback();
          return reply.code(404).send({ error: 'Session not found or inactive' });
        }
        captureLeads = new LeadRepository(db);
        captureConversations = new ConversationRepository(db);
        const pendingTurn = await captureConversations.getLatestUnansweredTurn(input.sessionId);
        if (pendingTurn && ['received', 'need_extracted', 'planned', 'answering'].includes(pendingTurn.turn.status)) {
          await rollback();
          return reply.code(409).send({ error: 'availability_decision_pending', retryable: true });
        }
        // Separate statement after the lock: a waiting form must see the
        // committed decline or scope change under READ COMMITTED.
        const messages = await captureConversations.listMessages(input.sessionId, null);
        const currentRequest = latestAvailabilityRequest(messages);
        if (!currentRequest || currentRequest.id !== input.availabilityRequestId || currentRequest.id !== input.clientLeadId || currentRequest.state === 'declined') {
          await rollback();
          return reply.code(409).send({ error: 'availability_request_changed' });
        }
        input = { ...input, question: currentRequest.question, preferredContact: input.preferredContact ?? currentRequest.preferredContact };
        productIds = [...currentRequest.productIds];
        productReferences = buildLeadProductReferences({ messages, requestId: currentRequest.id, productIds });
      }
      let completion = input.availabilityRequestId
        ? await captureLeads.findClientLeadWithOutbox(input.sessionId, input.clientLeadId) : null;
      let alreadyQueued = Boolean(completion);
      completion ??= await captureLeads.createClientLeadWithOutbox({
        ...input,
        clientRequestHash: requestHash(input, productIds),
        ...(productIds ? { productIds } : {}),
        ...(productReferences ? { productReferences } : {}),
        ...(input.availabilityRequestId ? { skipPendingDraft: true, purpose: 'availability' as const } : {})
      });
      if (!completion && input.availabilityRequestId) {
        completion = await captureLeads.findClientLeadWithOutbox(input.sessionId, input.clientLeadId);
        alreadyQueued = Boolean(completion);
      }
      if (!completion) {
        const currentSession = await captureConversations.restoreSession(input.sessionId, visitorCapability);
        await rollback();
        if (!currentSession) {
          return reply.code(404).send({ error: 'Session not found or inactive' });
        }
        return reply.code(409).send({ error: 'clientLeadId already used with different payload' });
      }
      capturedLeadId = completion.lead.id;
      const outboxId = completion.outbox.id.trim() || undefined;
      const dispatchStatus = durableLeadOutboxStatus(completion.outbox);
      if (!outboxId || !dispatchStatus || !pendingDraftWasPreserved(completion) ||
          (input.availabilityRequestId && !durableAvailabilityLead(completion))) {
        throw new Error(`lead_outbox_not_dispatchable:${completion.outbox.status}`);
      }
      if (db) {
        await db.query('COMMIT');
        transactionOpen = false;
      }
      return reply.send({
        ok: true,
        status: 'queued',
        lead: completion.lead,
        outboxId,
        dispatchStatus,
        ...(input.availabilityRequestId ? { availabilityReceipt: { requestId: input.availabilityRequestId,
          outcome: alreadyQueued ? 'already_queued' : 'queued', warehouseChecked: false } } : {})
      });
    } catch {
      await rollback().catch(() => undefined);
      request.log.warn({ code: 'lead_outbox_enqueue_failed', leadId: capturedLeadId }, 'lead form atomic capture failed');
      return reply.code(503).send({
        ok: false,
        error: 'lead_outbox_enqueue_failed',
        retryable: true,
        ...(capturedLeadId ? { leadId: capturedLeadId } : {})
      });
    } finally {
      db?.release();
    }
  });
}
