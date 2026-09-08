import { beforeEach, describe, expect, it, vi } from 'vitest';

const sendLeadEmail = vi.hoisted(() => vi.fn());
const prepareLeadEmailRequest = vi.hoisted(() => vi.fn());
const snapshot = {version: 1, url: 'https://api.resend.com/emails', method: 'POST', body: '{}', idempotencyKey: 'lead-id', provider: 'resend'};

vi.mock('../src/email/httpEmail.js', () => ({
  sendPreparedLeadEmail: sendLeadEmail, prepareLeadEmailRequest
}));

const { processLeadOutboxItem } = await import('../src/ai/leadOutbox.js');

describe('lead outbox worker', () => {
  beforeEach(() => {
    sendLeadEmail.mockReset();
    prepareLeadEmailRequest.mockReset();
    prepareLeadEmailRequest.mockReturnValue(snapshot);
  });

  it('preserves pending draft context from a public form through email delivery', async () => {
    sendLeadEmail.mockResolvedValue({ ok: true });
    const conversations = {
      getSession: vi.fn(async () => ({ id: 'session-id', status: 'active' })),
      listMessages: vi.fn(async () => [])
    };
    const leads = {
      getLead: vi.fn(async () => ({ id: 'lead-id', name: 'Алексей', status: 'pending_email', createdAt: new Date().toISOString() })),
      prepareLeadOutboxDispatch: vi.fn(async () => ({requestSnapshot: snapshot})),
      markLeadOutboxSent: vi.fn(async () => ({status: 'sent'})),
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
        leaseToken: 'owner',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }
    });

    expect(result).toEqual({ ok: true });
    expect(prepareLeadEmailRequest).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'lead-id' }),
      expect.objectContaining({
        handoff: {
          purpose: 'Уточнить совместимость виброплиты с толщиной слоя 30 см',
          buyerQuestion: 'Подойдет ли эта виброплита для слоя щебня 30 см?',
          preferredContact: 'message'
        }
      })
    );
    expect(sendLeadEmail).toHaveBeenCalledWith(snapshot);
    expect(leads.markLeadOutboxSent).toHaveBeenCalledWith('outbox-id', 'owner', {ok: true});
    expect(leads.markEmailResult).not.toHaveBeenCalled();
  });

  it('keeps failed delivery in outbox for retry without buyer-facing action', async () => {
    sendLeadEmail.mockResolvedValue({ ok: false, error: 'transport_down' });
    const conversations = {
      getSession: vi.fn(async () => ({ id: 'session-id', status: 'active' })),
      listMessages: vi.fn(async () => [])
    };
    const leads = {
      getLead: vi.fn(async () => ({ id: 'lead-id', name: 'Алексей', status: 'pending_email', createdAt: new Date().toISOString() })),
      prepareLeadOutboxDispatch: vi.fn(async () => ({requestSnapshot: snapshot})),
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
        attemptCount: 1,
        leaseToken: 'owner',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }
    });

    expect(result.ok).toBe(false);
    expect(leads.markLeadOutboxFailed).toHaveBeenCalledWith(expect.objectContaining({
      id: 'outbox-id',
      error: expect.stringContaining('transport_down')
    }));
    expect(leads.markEmailResult).not.toHaveBeenCalled();
  });
});
