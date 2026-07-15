import { beforeEach, describe, expect, it, vi } from 'vitest';

const sendLeadEmail = vi.hoisted(() => vi.fn());

vi.mock('../src/email/httpEmail.js', () => ({
  sendLeadEmail
}));

const { processLeadOutboxItem } = await import('../src/ai/leadOutbox.js');

describe('lead outbox worker', () => {
  beforeEach(() => {
    sendLeadEmail.mockReset();
  });

  it('preserves pending draft context from a public form through email delivery', async () => {
    sendLeadEmail.mockResolvedValue({ ok: true });
    const conversations = {
      getSession: vi.fn(async () => ({ id: 'session-id', status: 'active' })),
      listMessages: vi.fn(async () => [])
    };
    const leads = {
      getLead: vi.fn(async () => ({ id: 'lead-id', name: 'Алексей', status: 'pending_email', createdAt: new Date().toISOString() })),
      markLeadOutboxSent: vi.fn(async () => null),
      markLeadOutboxFailed: vi.fn(async () => null),
      markEmailResult: vi.fn(async () => null)
    };

    const result = await processLeadOutboxItem({
      conversations: conversations as never,
      leads: leads as never,
      item: {
        id: 'outbox-id',
        leadId: 'lead-id',
        sessionId: 'session-id',
        turnId: 'turn-id',
        destination: 'lead_email',
        payload: {
          source: 'lead_form',
          purpose: 'Уточнить совместимость виброплиты с толщиной слоя 30 см',
          question: 'Подойдет ли эта виброплита для слоя щебня 30 см?',
          preferredContact: 'message'
        },
        status: 'sending',
        attemptCount: 1,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }
    });

    expect(result).toEqual({ ok: true });
    expect(sendLeadEmail).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'lead-id' }),
      expect.objectContaining({
        handoff: {
          purpose: 'Уточнить совместимость виброплиты с толщиной слоя 30 см',
          buyerQuestion: 'Подойдет ли эта виброплита для слоя щебня 30 см?',
          preferredContact: 'message'
        }
      })
    );
    expect(leads.markLeadOutboxSent).toHaveBeenCalledWith('outbox-id');
    expect(leads.markEmailResult).toHaveBeenCalledWith('lead-id', 'sent_email', { ok: true });
  });

  it('keeps failed delivery in outbox for retry without buyer-facing action', async () => {
    sendLeadEmail.mockResolvedValue({ ok: false, error: 'transport_down' });
    const conversations = {
      getSession: vi.fn(async () => ({ id: 'session-id', status: 'active' })),
      listMessages: vi.fn(async () => [])
    };
    const leads = {
      getLead: vi.fn(async () => ({ id: 'lead-id', name: 'Алексей', status: 'pending_email', createdAt: new Date().toISOString() })),
      markLeadOutboxSent: vi.fn(async () => null),
      markLeadOutboxFailed: vi.fn(async () => null),
      markEmailResult: vi.fn(async () => null)
    };

    const result = await processLeadOutboxItem({
      conversations: conversations as never,
      leads: leads as never,
      item: {
        id: 'outbox-id',
        leadId: 'lead-id',
        sessionId: 'session-id',
        turnId: 'turn-id',
        destination: 'lead_email',
        payload: {},
        status: 'sending',
        attemptCount: 2,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }
    });

    expect(result.ok).toBe(false);
    expect(leads.markLeadOutboxFailed).toHaveBeenCalledWith(expect.objectContaining({
      id: 'outbox-id',
      error: expect.stringContaining('transport_down')
    }));
    expect(leads.markEmailResult).toHaveBeenCalledWith('lead-id', 'email_failed', { ok: false, error: 'transport_down' });
  });
});
