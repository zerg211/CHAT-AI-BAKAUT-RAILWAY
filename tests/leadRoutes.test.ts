import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const repoMocks = vi.hoisted(() => ({
  createLead: vi.fn(),
  markEmailResult: vi.fn(),
  listTurns: vi.fn(),
  enqueueLeadOutbox: vi.fn()
}));

vi.mock('../src/db/repositories.js', () => ({
  LeadRepository: vi.fn(function LeadRepository() {
    return {
      createLead: repoMocks.createLead,
      markEmailResult: repoMocks.markEmailResult
    };
  }),
  ConversationRepository: vi.fn(function ConversationRepository() {
    return {
      listTurns: repoMocks.listTurns,
      enqueueLeadOutbox: repoMocks.enqueueLeadOutbox
    };
  }),
  ProductRepository: vi.fn()
}));

const { registerLeadRoutes } = await import('../src/routes/leads.js');

async function buildTestApp() {
  const app = Fastify({ logger: false });
  await registerLeadRoutes(app);
  return app;
}

describe('lead routes', () => {
  beforeEach(() => {
    repoMocks.createLead.mockReset();
    repoMocks.markEmailResult.mockReset();
    repoMocks.listTurns.mockReset();
    repoMocks.enqueueLeadOutbox.mockReset();
    repoMocks.createLead.mockResolvedValue({
      id: 'lead-id',
      sessionId: '00000000-0000-4000-8000-000000000001',
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
      payload: {
        sessionId: '00000000-0000-4000-8000-000000000001',
        name: 'Илья',
        phone: '+7 900 000-10-03',
        question: 'Проверить наличие и доставку генератора'
      }
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
      sessionId: '00000000-0000-4000-8000-000000000001',
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
        sessionId: '00000000-0000-4000-8000-000000000001',
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
});
