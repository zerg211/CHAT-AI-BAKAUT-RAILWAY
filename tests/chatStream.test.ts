import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { streamChatMessage } from '../src/client/chatStream.js';

function sseEvent(event: string, data: unknown) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

describe('streamChatMessage watchdog and recovery', () => {
  it('preserves the session across reloads and same-tab catalog navigation', () => {
    const source = readFileSync('src/client/main.tsx', 'utf8');

    expect(source).toContain("safeStorageGet(safeBrowserStorage('sessionStorage'), 'bakaut_session_id')");
    expect(source).toContain("safeStorageSet(chatSessionStorage, 'bakaut_session_id', data.session.id)");
    expect(source).not.toContain("addEventListener('pagehide'");
    expect(source).not.toContain('navigator.sendBeacon');
  });

  it('keeps the browser idle watchdog longer than the server generation timeout', () => {
    const source = readFileSync('src/client/chatStream.ts', 'utf8');
    const match = source.match(/const DEFAULT_STREAM_IDLE_TIMEOUT_MS = ([\d_]+);/);

    expect(match).not.toBeNull();
    expect(Number(match![1]!.replace(/_/g, ''))).toBeGreaterThan(120_000);
  });

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

  it('recovers a completed turn when the primary SSE body closes before any event is delivered', async () => {
    const emptyPrimaryStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close();
      }
    });
    const recoveredPayload = {
      turnId: 'turn-from-header',
      answer: 'Saved answer delivered after transport interruption',
      assistantMessageId: 'msg-from-header',
      productCards: [{ id: 'generator-5kw', name: 'Generator 5 kW', url: '/generator-5kw' }],
      usedWebSearch: false
    };
    const recoveredStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(sseEvent('done', recoveredPayload)));
        controller.close();
      }
    });
    const fetcher = vi.fn(async (url: string | URL | Request) => (
      String(url).includes('/recover')
        ? new Response(recoveredStream, { status: 200 })
        : new Response(emptyPrimaryStream, {
            status: 200,
            headers: { 'x-chat-turn-id': 'turn-from-header' }
          })
    ));

    await expect(streamChatMessage(
      'http://127.0.0.1:3010',
      'session-1',
      'need a generator',
      { onDelta: () => undefined },
      undefined,
      { fetcher }
    )).resolves.toMatchObject(recoveredPayload);

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(String(fetcher.mock.calls[1]?.[0])).toContain('/messages/turn-from-header/recover');
  });

  it('does not start a second recovery transport when the only recovery closes before done', async () => {
    vi.useFakeTimers();
    try {
      const emptyStream = () => new ReadableStream<Uint8Array>({
        start(controller) {
          controller.close();
        }
      });
      const recoveredPayload = {
        turnId: 'turn-retry-transport',
        answer: 'Saved answer delivered by the second recovery transport.',
        assistantMessageId: 'msg-retry-transport',
        productCards: [{ id: 'generator-5kw', name: 'Generator 5 kW', url: '/generator-5kw' }],
        usedWebSearch: false
      };
      let recoveryCalls = 0;
      const fetcher = vi.fn(async (url: string | URL | Request) => {
        if (!String(url).includes('/recover')) {
          return new Response(emptyStream(), {
            status: 200,
            headers: { 'x-chat-turn-id': 'turn-retry-transport' }
          });
        }
        recoveryCalls += 1;
        if (recoveryCalls === 1) return new Response(emptyStream(), { status: 200 });
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(sseEvent('done', recoveredPayload)));
            controller.close();
          }
        }), { status: 200 });
      });

      const result = streamChatMessage(
        'http://127.0.0.1:3010',
        'session-1',
        'need a generator',
        { onDelta: () => undefined },
        undefined,
        { fetcher }
      );
      await expect(result).rejects.toThrow('Server finished without a done payload');
      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(recoveryCalls).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not retry a recovery stream after an explicit non-recoverable server error', async () => {
    const emptyPrimary = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close();
      }
    });
    const terminalRecovery = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(sseEvent('error', {
          error: 'The saved turn cannot be recovered.',
          recoverable: false,
          turnId: 'turn-terminal-recovery'
        })));
        controller.close();
      }
    });
    const fetcher = vi.fn(async (url: string | URL | Request) => (
      String(url).includes('/recover')
        ? new Response(terminalRecovery, { status: 200 })
        : new Response(emptyPrimary, {
            status: 200,
            headers: { 'x-chat-turn-id': 'turn-terminal-recovery' }
          })
    ));

    await expect(streamChatMessage(
      'http://127.0.0.1:3010',
      'session-1',
      'need a generator',
      { onDelta: () => undefined },
      undefined,
      { fetcher }
    )).rejects.toThrow('The saved turn cannot be recovered.');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('lets recovery outlive the primary stream idle watchdog', async () => {
    vi.useFakeTimers();
    try {
      const firstStream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(sseEvent('turn', { turnId: 'turn-long' })));
        }
      });
      const recoveredPayload = {
        turnId: 'turn-long',
        answer: 'Recovered after a long repair',
        assistantMessageId: 'msg-long',
        productCards: [{ id: 'dpu-130', name: 'DPU 130', url: '/dpu-130' }],
        usedWebSearch: false
      };
      const recoveredStream = new ReadableStream<Uint8Array>({
        start(controller) {
          setTimeout(() => {
            controller.enqueue(new TextEncoder().encode(
              sseEvent('delta', { delta: 'Recovered after a long repair' }) +
              sseEvent('done', recoveredPayload)
            ));
            controller.close();
          }, 70_000);
        }
      });
      const fetcher = vi.fn(async (url: string | URL | Request) => (
        String(url).includes('/recover')
          ? new Response(recoveredStream, { status: 200 })
          : new Response(firstStream, { status: 200 })
      ));
      const deltas: string[] = [];

      const result = streamChatMessage(
        'http://127.0.0.1:3010',
        'session-1',
        'need heavy plate',
        { onDelta: (delta) => deltas.push(delta) },
        undefined,
        { fetcher, idleTimeoutMs: 1000 }
      );

      await vi.advanceTimersByTimeAsync(1000);
      expect(fetcher).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(70_000);

      await expect(result).resolves.toMatchObject(recoveredPayload);
      expect(deltas.join('')).toBe('Recovered after a long repair');
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

  it('sends a stable client message id as the idempotency key', async () => {
    const payload = { answer: 'Готово', productCards: [], usedWebSearch: false };
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(
          sseEvent('turn', { turnId: 'turn-client-id' }) +
          sseEvent('done', payload)
        ));
        controller.close();
      }
    });
    const fetcher = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(stream, { status: 200 }));
    const clientMessageId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

    await streamChatMessage(
      '',
      'session-1',
      'да',
      { onDelta: () => undefined },
      undefined,
      { fetcher, clientMessageId }
    );

    const request = fetcher.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(request.body))).toEqual({ message: 'да', clientMessageId });
  });

  it('does not start recovery when the server reports a non-recoverable runner collision', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(
          sseEvent('turn', { turnId: 'turn-running' }) +
          sseEvent('error', {
            turnId: 'turn-running',
            recoverable: false,
            error: 'Этот ответ уже формируется.'
          })
        ));
        controller.close();
      }
    });
    const fetcher = vi.fn(async () => new Response(stream, { status: 200 }));

    await expect(streamChatMessage(
      '',
      'session-1',
      'да',
      { onDelta: () => undefined },
      undefined,
      { fetcher }
    )).rejects.toThrow('Этот ответ уже формируется.');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
