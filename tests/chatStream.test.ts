import { describe, expect, it, vi } from 'vitest';
import { streamChatMessage } from '../src/client/chatStream.js';

function sseEvent(event: string, data: unknown) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

describe('streamChatMessage watchdog', () => {
  it('fails a stalled SSE stream instead of leaving the widget in typing state forever', async () => {
    vi.useFakeTimers();
    try {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(sseEvent('status', { status: 'Собираю короткий ответ...' })));
        }
      });
      const fetcher = vi.fn(async () => new Response(stream, { status: 200 }));
      const statuses: string[] = [];

      const result = streamChatMessage(
        'http://127.0.0.1:3010',
        'session-1',
        'Оставлю телефон',
        { onDelta: () => undefined, onStatus: (status) => statuses.push(status) },
        undefined,
        { fetcher, idleTimeoutMs: 1000 }
      );

      const assertion = expect(result).rejects.toThrow('Ответ ассистента не завершился вовремя');
      await vi.advanceTimersByTimeAsync(1000);

      await assertion;
      expect(statuses).toEqual(['Собираю короткий ответ...']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns the done payload when SSE finishes normally before the watchdog fires', async () => {
    vi.useFakeTimers();
    try {
      const payload = { answer: 'Готово', assistantMessageId: 'msg-1', productCards: [], leadRequested: true };
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(
            sseEvent('delta', { delta: 'Го' }) +
            sseEvent('delta', { delta: 'тово' }) +
            sseEvent('done', payload)
          ));
          controller.close();
        }
      });
      const deltas: string[] = [];

      await expect(streamChatMessage(
        '',
        'session-1',
        'текст',
        { onDelta: (delta) => deltas.push(delta) },
        undefined,
        { fetcher: async () => new Response(stream, { status: 200 }), idleTimeoutMs: 1000 }
      )).resolves.toMatchObject(payload);
      expect(deltas.join('')).toBe('Готово');
    } finally {
      vi.useRealTimers();
    }
  });
});
