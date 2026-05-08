import { describe, expect, it, vi } from 'vitest';
import { streamChatMessage } from '../src/client/chatStream.js';

function sseEvent(event: string, data: unknown) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

describe('streamChatMessage watchdog and recovery', () => {
  it('recovers a stalled SSE stream when the server already emitted turnId', async () => {
    vi.useFakeTimers();
    try {
      const firstStream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(
            sseEvent('turn', { turnId: 'turn-1' }) +
            sseEvent('status', { status: 'Собираю короткий ответ...' })
          ));
        }
      });
      const recoveredPayload = { turnId: 'turn-1', answer: 'Восстановленный ответ', assistantMessageId: 'msg-1', productCards: [], usedWebSearch: false };
      const recoveredStream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(
            sseEvent('status', { status: 'Ответ оборвался, восстанавливаю...' }) +
            sseEvent('delta', { delta: 'Восстановленный ответ' }) +
            sseEvent('done', recoveredPayload)
          ));
          controller.close();
        }
      });
      const fetcher = vi.fn(async (url: string | URL | Request) => {
        return String(url).includes('/recover')
          ? new Response(recoveredStream, { status: 200 })
          : new Response(firstStream, { status: 200 });
      });
      const statuses: string[] = [];
      const deltas: string[] = [];

      const result = streamChatMessage(
        'http://127.0.0.1:3010',
        'session-1',
        'Оставлю телефон',
        { onDelta: (delta) => deltas.push(delta), onStatus: (status) => statuses.push(status) },
        undefined,
        { fetcher, idleTimeoutMs: 1000 }
      );

      await vi.advanceTimersByTimeAsync(1000);

      await expect(result).resolves.toMatchObject(recoveredPayload);
      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(deltas.join('')).toBe('Восстановленный ответ');
      expect(statuses).toContain('Ответ оборвался, восстанавливаю...');
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns the done payload when SSE finishes normally before the watchdog fires', async () => {
    vi.useFakeTimers();
    try {
      const payload = { answer: 'Готово', assistantMessageId: 'msg-1', productCards: [], leadRequested: true, usedWebSearch: false };
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(
            sseEvent('turn', { turnId: 'turn-1' }) +
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
