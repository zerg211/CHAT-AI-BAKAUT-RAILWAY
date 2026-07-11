import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const repoMocks = vi.hoisted(() => ({
  createClientLead: vi.fn(),
  markEmailResult: vi.fn(),
  getSession: vi.fn(),
  listTurns: vi.fn(),
  enqueueLeadOutbox: vi.fn()
}));

vi.mock('../src/db/repositories.js', () => ({
  LeadRepository: vi.fn(function LeadRepository() {
    return {
      createClientLead: repoMocks.createClientLead,
      markEmailResult: repoMocks.markEmailResult
    };
  }),
  ConversationRepository: vi.fn(function ConversationRepository() {
    return {
      getSession: repoMocks.getSession,
      listTurns: repoMocks.listTurns,
      enqueueLeadOutbox: repoMocks.enqueueLeadOutbox
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

function validLeadPayload() {
  return {
    sessionId,
    clientLeadId,
    name: 'Илья',
    phone: '+7 900 000-10-03',
    question: 'Проверить наличие и доставку генератора'
  };
}

describe('lead routes', () => {
  beforeEach(() => {
    repoMocks.createClientLead.mockReset();
    repoMocks.markEmailResult.mockReset();
    repoMocks.getSession.mockReset();
    repoMocks.listTurns.mockReset();
    repoMocks.enqueueLeadOutbox.mockReset();
    repoMocks.getSession.mockResolvedValue({ id: sessionId, status: 'active' });
    repoMocks.createClientLead.mockResolvedValue({
      id: 'lead-id',
      sessionId,
      clientLeadId,
      name: 'Илья',
      phone: '+7 900 000-10-03',
      status: 'pending_email',
      createdAt: new Date().toISOString()
    });
    repoMocks.listTurns.mockResolvedValue([
      { id: '00000000-0000-4000-8000-000000000002' }
    ]);
    repoMocks.enqueueLeadOutbox.mockResolvedValue({ id: 'outbox-id' });
  });

  it('saves the lead and queues email delivery without blocking the form response', async () => {
    const app = await buildTestApp();
    const response = await app.inject({
      method: 'POST',
      url: '/api/leads',
      payload: validLeadPayload()
    });
    await app.close();

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      lead: { id: 'lead-id' },
      email: {
        ok: false,
        queued: true,
        outboxId: 'outbox-id',
        status: 'queued'
      }
    });
    expect(repoMocks.enqueueLeadOutbox).toHaveBeenCalledWith(expect.objectContaining({
      leadId: 'lead-id',
      sessionId,
      turnId: '00000000-0000-4000-8000-000000000002',
      destination: 'lead_email'
    }));
    expect(repoMocks.markEmailResult).not.toHaveBeenCalled();
  });

  it('still returns a saved lead if outbox enqueue fails after local capture', async () => {
    repoMocks.enqueueLeadOutbox.mockRejectedValueOnce(new Error('outbox unavailable'));
    const app = await buildTestApp();
    const response = await app.inject({
      method: 'POST',
      url: '/api/leads',
      payload: {
        sessionId,
        clientLeadId,
        name: 'Илья',
        phone: '+7 900 000-10-03'
      }
    });
    await app.close();

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      lead: { id: 'lead-id' },
      email: {
        ok: false,
        queued: false,
        status: 'saved_without_outbox'
      }
    });
    expect(repoMocks.markEmailResult).toHaveBeenCalledWith('lead-id', 'email_failed', expect.objectContaining({
      ok: false,
      error: 'lead_outbox_enqueue_failed'
    }));
  });

  it('queues a form lead even when the session has no chat turn yet', async () => {
    repoMocks.listTurns.mockResolvedValueOnce([]);
    const app = await buildTestApp();
    const response = await app.inject({ method: 'POST', url: '/api/leads', payload: validLeadPayload() });
    await app.close();

    expect(response.statusCode).toBe(200);
    expect(repoMocks.enqueueLeadOutbox).toHaveBeenCalledWith(expect.objectContaining({
      leadId: 'lead-id',
      sessionId,
      turnId: null,
      destination: 'lead_email'
    }));
  });

  it('uses the same request hash for an identical client retry and returns the same lead', async () => {
    const app = await buildTestApp();
    const first = await app.inject({ method: 'POST', url: '/api/leads', payload: validLeadPayload() });
    const second = await app.inject({ method: 'POST', url: '/api/leads', payload: validLeadPayload() });
    await app.close();

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(first.json().lead.id).toBe(second.json().lead.id);
    expect(repoMocks.createClientLead).toHaveBeenCalledTimes(2);
    const firstInput = repoMocks.createClientLead.mock.calls[0]?.[0];
    const secondInput = repoMocks.createClientLead.mock.calls[1]?.[0];
    const hash = String(firstInput.clientRequestHash);
    const hexadecimal = new Set('0123456789abcdef');
    expect(hash).toHaveLength(64);
    expect([...hash].every((character) => hexadecimal.has(character))).toBe(true);
    expect(secondInput.clientRequestHash).toBe(firstInput.clientRequestHash);
  });

  it('returns 409 when a client lead id is reused with a different payload', async () => {
    repoMocks.createClientLead.mockResolvedValueOnce(null);
    const app = await buildTestApp();
    const response = await app.inject({ method: 'POST', url: '/api/leads', payload: validLeadPayload() });
    await app.close();

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: 'clientLeadId already used with different payload' });
    expect(repoMocks.enqueueLeadOutbox).not.toHaveBeenCalled();
  });

  it('does not create a lead if the session becomes inactive before insertion', async () => {
    repoMocks.getSession
      .mockResolvedValueOnce({ id: sessionId, status: 'active' })
      .mockResolvedValueOnce({ id: sessionId, status: 'closed' });
    repoMocks.createClientLead.mockResolvedValueOnce(null);
    const app = await buildTestApp();
    const response = await app.inject({ method: 'POST', url: '/api/leads', payload: validLeadPayload() });
    await app.close();

    expect(response.statusCode).toBe(404);
    expect(repoMocks.enqueueLeadOutbox).not.toHaveBeenCalled();
  });

  it('rejects missing, inactive, and malformed session-bound submissions', async () => {
    const app = await buildTestApp();
    const missingSession = await app.inject({
      method: 'POST',
      url: '/api/leads',
      payload: { ...validLeadPayload(), sessionId: undefined }
    });
    repoMocks.getSession.mockResolvedValueOnce({ id: sessionId, status: 'closed' });
    const inactiveSession = await app.inject({ method: 'POST', url: '/api/leads', payload: validLeadPayload() });
    const oversizedPhone = await app.inject({
      method: 'POST',
      url: '/api/leads',
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
        payload: { ...validLeadPayload(), clientLeadId: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}` }
      }));
    }
    await app.close();

    expect(responses.slice(0, 10).every((response) => response.statusCode === 200)).toBe(true);
    expect(responses[10]?.statusCode).toBe(429);
  });
});
