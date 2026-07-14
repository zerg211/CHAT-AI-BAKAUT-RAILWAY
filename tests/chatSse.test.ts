import { describe, expect, it, vi } from 'vitest';

import { closeSseReply, openSseReply, startStatusTimer, type SseReply } from '../src/routes/sse.js';

function fakeReply() {
  const writes: string[] = [];
  const headers: Array<{ statusCode: number; headers: Record<string, string> }> = [];
  const reply: SseReply = {
    raw: {
      destroyed: false,
      writableEnded: false,
      writeHead(statusCode, values) {
        headers.push({ statusCode, headers: values });
      },
      write(chunk) {
        writes.push(chunk);
      },
      end() {
        reply.raw.writableEnded = true;
      }
    }
  };
  return { reply, writes, headers };
}

describe('chat SSE helpers', () => {
  it('opens the standard SSE stream and no-ops after close', () => {
    const { reply, writes, headers } = fakeReply();
    const send = openSseReply(reply);

    send('turn', { turnId: 'turn-1' });
    closeSseReply(reply);
    send('done', { ignored: true });

    expect(headers).toEqual([{
      statusCode: 200,
      headers: {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no'
      }
    }]);
    expect(writes.join('')).toBe('event: turn\ndata: {"turnId":"turn-1"}\n\n');
    expect(reply.raw.writableEnded).toBe(true);
  });

  it('adds a durable turn id header without replacing the SSE headers', () => {
    const { reply, headers } = fakeReply();

    openSseReply(reply, { 'x-chat-turn-id': 'turn-durable' });

    expect(headers[0]).toEqual({
      statusCode: 200,
      headers: expect.objectContaining({
        'content-type': 'text/event-stream; charset=utf-8',
        'x-chat-turn-id': 'turn-durable'
      })
    });
  });

  it('sends the initial status immediately and advances on the timer', async () => {
    vi.useFakeTimers();
    const events: Array<{ event: string; data: unknown }> = [];
    const stop = startStatusTimer({
      send(event, data) {
        events.push({ event, data });
      },
      initialStatus: 'starting',
      statusMessages: ['first', 'second', 'third'],
      intervalMs: 1000
    });

    expect(events).toEqual([{ event: 'status', data: { status: 'starting' } }]);

    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);

    expect(events).toEqual([
      { event: 'status', data: { status: 'starting' } },
      { event: 'status', data: { status: 'second' } },
      { event: 'status', data: { status: 'third' } },
      { event: 'status', data: { status: 'third' } }
    ]);

    stop();
    await vi.advanceTimersByTimeAsync(1000);
    expect(events).toHaveLength(4);
    vi.useRealTimers();
  });
});
