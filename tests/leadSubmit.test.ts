import { describe, expect, it, vi } from 'vitest';
import { submitLead } from '../src/client/leadSubmit.js';

describe('submitLead watchdog', () => {
  const visitorId = 'visitor-capability-with-high-entropy';
  it('fails a stalled lead request instead of leaving the form in sending state forever', async () => {
    vi.useFakeTimers();
    try {
      const fetcher = vi.fn(() => new Promise<Response>(() => undefined));
      const result = submitLead('', {
        sessionId: '00000000-0000-4000-8000-000000000001',
        clientLeadId: '00000000-0000-4000-8000-000000000002',
        name: 'Иван',
        phone: '+79990000000',
        question: 'Нужен генератор'
      }, { fetcher, timeoutMs: 1000, visitorId });

      const assertion = expect(result).rejects.toThrow('Заявка не отправилась вовремя');
      await vi.advanceTimersByTimeAsync(1000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns when the lead endpoint accepts the request', async () => {
    await expect(submitLead('', {
      sessionId: '00000000-0000-4000-8000-000000000001',
      clientLeadId: '00000000-0000-4000-8000-000000000002',
      name: 'Иван',
      email: 'buyer@example.com',
      question: 'Нужен генератор'
    }, { visitorId, fetcher: async () => new Response(JSON.stringify({
      ok: true,
      status: 'queued',
      outboxId: 'outbox-1',
      lead: { id: 'lead-1' }
    }), { status: 201 }) })).resolves.toMatchObject({ status: 'queued', outboxId: 'outbox-1' });
  });

  it('sends the client idempotency key with the lead payload', async () => {
    const fetcher = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({
      ok: true,
      status: 'queued',
      outboxId: 'outbox-1'
    }), { status: 200 }));
    const payload = {
      sessionId: '00000000-0000-4000-8000-000000000001',
      clientLeadId: '00000000-0000-4000-8000-000000000002',
      name: 'Иван',
      phone: '+79990000000'
    };

    await submitLead('', payload, { fetcher, visitorId });

    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual(payload);
    expect(fetcher.mock.calls[0]?.[1]?.headers).toMatchObject({
      'x-bakaut-visitor-id': visitorId
    });
  });

  it('rejects a legacy success-shaped response that has no durable outbox', async () => {
    await expect(submitLead('', {
      sessionId: '00000000-0000-4000-8000-000000000001',
      clientLeadId: '00000000-0000-4000-8000-000000000002',
      name: 'Иван',
      phone: '+79990000000'
    }, {
      visitorId,
      fetcher: async () => new Response(JSON.stringify({
        lead: { id: 'lead-1' },
        email: { queued: false, status: 'saved_without_outbox' }
      }), { status: 200 })
    })).rejects.toThrow('lead failed');
  });

  it('rejects a queued response without an outbox id', async () => {
    await expect(submitLead('', {
      sessionId: '00000000-0000-4000-8000-000000000001',
      clientLeadId: '00000000-0000-4000-8000-000000000002',
      name: 'Иван',
      phone: '+79990000000'
    }, {
      visitorId,
      fetcher: async () => new Response(JSON.stringify({ ok: true, status: 'queued' }), { status: 200 })
    })).rejects.toThrow('lead failed');
  });
});
