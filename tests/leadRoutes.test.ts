import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const repoMocks = vi.hoisted(() => ({
  createClientLeadWithOutbox: vi.fn(),
  markEmailResult: vi.fn(),
  restoreSession: vi.fn()
}));

vi.mock('../src/db/repositories.js', () => ({
  LeadRepository: vi.fn(function LeadRepository() {
    return {
      createClientLeadWithOutbox: repoMocks.createClientLeadWithOutbox,
      markEmailResult: repoMocks.markEmailResult
    };
  }),
  ConversationRepository: vi.fn(function ConversationRepository() {
    return {
      restoreSession: repoMocks.restoreSession
    };
  }),
  ProductRepository: vi.fn()
}));

const { registerLeadRoutes } = await import('../src/routes/leads.js');

async function buildTestApp() {
  const app = Fastify({ logger: false });
  await app.register(rateLimit, { max: 120, timeWindow: '1 minute' });
  await registerLeadRoutes(app);
  return app;
}

const sessionId = '00000000-0000-4000-8000-000000000001';
const clientLeadId = '00000000-0000-4000-8000-000000000003';
const visitorId = 'visitor-capability-with-high-entropy';
const capabilityHeaders = { 'x-bakaut-visitor-id': visitorId };

function validLeadPayload() {
  return {
    sessionId,
    clientLeadId,
    name: 'Илья',
    phone: '+7 900 000-10-03',
    question: 'Проверить наличие и доставку генератора'
  };
}

function completedLeadCapture() {
  return {
    lead: {
      id: 'lead-id',
      sessionId,
      clientLeadId,
      name: 'Илья',
      phone: '+7 900 000-10-03',
      status: 'pending_email',
      createdAt: new Date().toISOString()
    },
    outbox: {
      id: 'outbox-id',
      leadId: 'lead-id',
      sessionId,
      turnId: '00000000-0000-4000-8000-000000000002',
      destination: 'lead_email',
      payload: { leadId: 'lead-id', source: 'lead_form' },
      status: 'pending',
      attemptCount: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    },
    draft: null,
    pendingDraftMatched: false
  };
}

describe('lead routes', () => {
  beforeEach(() => {
    repoMocks.createClientLeadWithOutbox.mockReset();
    repoMocks.markEmailResult.mockReset();
    repoMocks.restoreSession.mockReset();
    repoMocks.restoreSession.mockImplementation(async (_id: string, capability: string) => capability === visitorId
      ? { id: sessionId, status: 'active' }
      : null);
    repoMocks.createClientLeadWithOutbox.mockResolvedValue(completedLeadCapture());
  });

  it('saves the lead and queues email delivery without blocking the form response', async () => {
    const app = await buildTestApp();
    const response = await app.inject({
      method: 'POST',
      url: '/api/leads',
      headers: capabilityHeaders,
      payload: validLeadPayload()
    });
    await app.close();

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      ok: true,
      status: 'queued',
      lead: { id: 'lead-id' },
      outboxId: 'outbox-id'
    });
    expect(repoMocks.createClientLeadWithOutbox).toHaveBeenCalledWith(expect.objectContaining({
      sessionId,
      clientLeadId,
      question: validLeadPayload().question
    }));
    expect(repoMocks.markEmailResult).not.toHaveBeenCalled();
  });

  it('does not report success if the atomic lead and outbox operation fails', async () => {
    repoMocks.createClientLeadWithOutbox.mockRejectedValueOnce(new Error('outbox unavailable'));
    const app = await buildTestApp();
    const response = await app.inject({
      method: 'POST',
      url: '/api/leads',
      headers: capabilityHeaders,
      payload: {
        sessionId,
        clientLeadId,
        name: 'Илья',
        phone: '+7 900 000-10-03'
      }
    });
    await app.close();

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      ok: false,
      error: 'lead_outbox_enqueue_failed',
      retryable: true
    });
    expect(repoMocks.markEmailResult).not.toHaveBeenCalled();
  });

  it('does not report success when outbox enqueue returns no durable row', async () => {
    repoMocks.createClientLeadWithOutbox.mockResolvedValueOnce({
      ...completedLeadCapture(),
      outbox: { ...completedLeadCapture().outbox, id: '' }
    });
    const app = await buildTestApp();
    const response = await app.inject({ method: 'POST', url: '/api/leads', headers: capabilityHeaders, payload: validLeadPayload() });
    await app.close();

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      ok: false,
      error: 'lead_outbox_enqueue_failed',
      retryable: true,
      leadId: 'lead-id'
    });
  });

  it('does not report a terminal dead outbox row as queued', async () => {
    repoMocks.createClientLeadWithOutbox.mockResolvedValueOnce({
      ...completedLeadCapture(),
      outbox: { ...completedLeadCapture().outbox, id: 'outbox-dead', status: 'dead' }
    });
    const app = await buildTestApp();
    const response = await app.inject({ method: 'POST', url: '/api/leads', headers: capabilityHeaders, payload: validLeadPayload() });
    await app.close();

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      ok: false,
      error: 'lead_outbox_enqueue_failed',
      retryable: true,
      leadId: 'lead-id'
    });
  });

  it('accepts a pending chat draft only when its context was atomically preserved and consumed', async () => {
    const draft = {
      id: 'draft-id',
      purpose: 'Уточнить совместимость виброплиты',
      buyerQuestion: 'Подойдёт ли плита для слоя 30 см?',
      preferredContact: 'message',
      status: 'consumed',
      consumedLeadId: 'lead-id'
    };
    repoMocks.createClientLeadWithOutbox.mockResolvedValueOnce({
      ...completedLeadCapture(),
      draft,
      pendingDraftMatched: true,
      outbox: {
        ...completedLeadCapture().outbox,
        payload: {
          leadId: 'lead-id',
          source: 'lead_form',
          purpose: draft.purpose,
          question: draft.buyerQuestion,
          preferredContact: draft.preferredContact
        }
      }
    });
    const app = await buildTestApp();
    const response = await app.inject({ method: 'POST', url: '/api/leads', headers: capabilityHeaders, payload: validLeadPayload() });
    await app.close();

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ ok: true, status: 'queued', outboxId: 'outbox-id' });
  });

  it('does not report success when a matched draft was not consumed with its outbox', async () => {
    repoMocks.createClientLeadWithOutbox.mockResolvedValueOnce({
      ...completedLeadCapture(),
      pendingDraftMatched: true,
      draft: null
    });
    const app = await buildTestApp();
    const response = await app.inject({ method: 'POST', url: '/api/leads', headers: capabilityHeaders, payload: validLeadPayload() });
    await app.close();

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      ok: false,
      error: 'lead_outbox_enqueue_failed',
      retryable: true,
      leadId: 'lead-id'
    });
  });

  it('uses the same request hash for an identical client retry and returns the same lead', async () => {
    const app = await buildTestApp();
    const first = await app.inject({ method: 'POST', url: '/api/leads', headers: capabilityHeaders, payload: validLeadPayload() });
    const second = await app.inject({ method: 'POST', url: '/api/leads', headers: capabilityHeaders, payload: validLeadPayload() });
    await app.close();

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(first.json().lead.id).toBe(second.json().lead.id);
    expect(repoMocks.createClientLeadWithOutbox).toHaveBeenCalledTimes(2);
    const firstInput = repoMocks.createClientLeadWithOutbox.mock.calls[0]?.[0];
    const secondInput = repoMocks.createClientLeadWithOutbox.mock.calls[1]?.[0];
    const hash = String(firstInput.clientRequestHash);
    const hexadecimal = new Set('0123456789abcdef');
    expect(hash).toHaveLength(64);
    expect([...hash].every((character) => hexadecimal.has(character))).toBe(true);
    expect(secondInput.clientRequestHash).toBe(firstInput.clientRequestHash);
  });

  it('returns 409 when a client lead id is reused with a different payload', async () => {
    repoMocks.createClientLeadWithOutbox.mockResolvedValueOnce(null);
    const app = await buildTestApp();
    const response = await app.inject({ method: 'POST', url: '/api/leads', headers: capabilityHeaders, payload: validLeadPayload() });
    await app.close();

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: 'clientLeadId already used with different payload' });
    expect(repoMocks.createClientLeadWithOutbox).toHaveBeenCalledTimes(1);
  });

  it('does not create a lead if the session becomes inactive before insertion', async () => {
    repoMocks.restoreSession
      .mockResolvedValueOnce({ id: sessionId, status: 'active' })
      .mockResolvedValueOnce(null);
    repoMocks.createClientLeadWithOutbox.mockResolvedValueOnce(null);
    const app = await buildTestApp();
    const response = await app.inject({ method: 'POST', url: '/api/leads', headers: capabilityHeaders, payload: validLeadPayload() });
    await app.close();

    expect(response.statusCode).toBe(404);
    expect(repoMocks.createClientLeadWithOutbox).toHaveBeenCalledTimes(1);
  });

  it('rejects missing, inactive, and malformed session-bound submissions', async () => {
    const app = await buildTestApp();
    const missingSession = await app.inject({
      method: 'POST',
      url: '/api/leads',
      headers: capabilityHeaders,
      payload: { ...validLeadPayload(), sessionId: undefined }
    });
    repoMocks.restoreSession.mockResolvedValueOnce(null);
    const inactiveSession = await app.inject({ method: 'POST', url: '/api/leads', headers: capabilityHeaders, payload: validLeadPayload() });
    const oversizedPhone = await app.inject({
      method: 'POST',
      url: '/api/leads',
      headers: capabilityHeaders,
      payload: { ...validLeadPayload(), phone: '1'.repeat(41) }
    });
    await app.close();

    expect(missingSession.statusCode).toBe(400);
    expect(inactiveSession.statusCode).toBe(404);
    expect(oversizedPhone.statusCode).toBe(400);
  });

  it('applies a lead-form-specific request limit', async () => {
    const app = await buildTestApp();
    const responses = [];
    for (let index = 0; index < 11; index += 1) {
      responses.push(await app.inject({
        method: 'POST',
        url: '/api/leads',
        headers: capabilityHeaders,
        payload: { ...validLeadPayload(), clientLeadId: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}` }
      }));
    }
    await app.close();

    expect(responses.slice(0, 10).every((response) => response.statusCode === 200)).toBe(true);
    expect(responses[10]?.statusCode).toBe(429);
  });

  it('rejects a missing or wrong visitor capability before creating a lead', async () => {
    const app = await buildTestApp();
    const missing = await app.inject({ method: 'POST', url: '/api/leads', payload: validLeadPayload() });
    const wrong = await app.inject({
      method: 'POST',
      url: '/api/leads',
      headers: { 'x-bakaut-visitor-id': 'wrong-capability' },
      payload: validLeadPayload()
    });
    await app.close();

    expect(missing.statusCode).toBe(404);
    expect(wrong.statusCode).toBe(404);
    expect(missing.json()).toEqual(wrong.json());
    expect(repoMocks.createClientLeadWithOutbox).not.toHaveBeenCalled();
  });
});
