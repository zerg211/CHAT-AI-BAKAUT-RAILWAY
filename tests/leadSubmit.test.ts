import { describe, expect, it, vi } from 'vitest';
import { submitLead } from '../src/client/leadSubmit.js';

describe('submitLead watchdog', () => {
  it('fails a stalled lead request instead of leaving the form in sending state forever', async () => {
    vi.useFakeTimers();
    try {
      const fetcher = vi.fn(() => new Promise<Response>(() => undefined));
      const result = submitLead('', {
        sessionId: 'session-1',
        name: 'Иван',
        phone: '+79990000000',
        question: 'Нужен генератор'
      }, { fetcher, timeoutMs: 1000 });

      const assertion = expect(result).rejects.toThrow('Заявка не отправилась вовремя');
      await vi.advanceTimersByTimeAsync(1000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns when the lead endpoint accepts the request', async () => {
    await expect(submitLead('', {
      sessionId: 'session-1',
      name: 'Иван',
      email: 'buyer@example.com',
      question: 'Нужен генератор'
    }, { fetcher: async () => new Response(JSON.stringify({ id: 'lead-1' }), { status: 201 }) })).resolves.toBeUndefined();
  });
});
