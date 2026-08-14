import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  ActiveConversationTurnError,
  ChatMessageNotAcceptedError,
  registerChatAbortController,
  recoverChatTurn,
  streamChatMessage
} from '../src/client/chatStream.js';

const visitorId = 'visitor-capability-with-high-entropy';

function sseEvent(event: string, data: unknown) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

describe('streamChatMessage watchdog and explicit continuation', () => {
  it('preserves the session across reloads and same-tab catalog navigation', () => {
    const source = readFileSync('src/client/main.tsx', 'utf8');

    expect(source).toContain("safeStorageGet(safeBrowserStorage('sessionStorage'), 'bakaut_session_id')");
    expect(source).toContain("safeStorageSet(chatSessionStorage, 'bakaut_session_id', data.session.id)");
    expect(source).not.toContain("addEventListener('pagehide'");
    expect(source).not.toContain('navigator.sendBeacon');
    expect(source).toContain('restoration.pendingTurn');
    expect(source).toContain('recoverChatTurn');
    expect(source).toContain('registerChatAbortController(abortRef, pendingController)');
    expect(source).toContain('submitError instanceof ChatMessageNotAcceptedError');
    expect(source).toContain('message.id !== userId && message.id !== assistantId');
    expect(source).toContain('setInput(userText)');
    expect(source).toContain('if (submitError.activeTurnId && activeSessionId && visitorId)');
    expect(source).toContain('submitError.statusCode === 404');
    expect(source).toContain('abandonSavedChat(chatSessionStorage, attemptedSessionId)');
    expect(source).toContain('current === attemptedSessionId ? null : current');
    expect(source).toContain('abortRef.current?.abort()');
  });

  it('keeps a newer chat controller owned when an older operation finishes', () => {
    const slot: { current: AbortController | null } = { current: null };
    const hydrationController = new AbortController();
    const releaseHydration = registerChatAbortController(slot, hydrationController);
    const submitController = new AbortController();
    const releaseSubmit = registerChatAbortController(slot, submitController);

    hydrationController.abort();
    releaseHydration();
    expect(slot.current).toBe(submitController);

    slot.current?.abort();
    expect(submitController.signal.aborted).toBe(true);
    expect(hydrationController.signal.aborted).toBe(true);
    expect(slot.current).toBeNull();

    releaseSubmit();
    expect(slot.current).toBeNull();
  });

  it('does not claim an unconfirmed question was saved in generic client errors', () => {
    const streamSource = readFileSync('src/client/chatStream.ts', 'utf8');
    const appSource = readFileSync('src/client/main.tsx', 'utf8');

    expect(streamSource).not.toContain('Вопрос сохранен');
    expect(appSource).not.toContain('Вопрос сохранен');
  });

  it('keeps the browser idle watchdog longer than the server generation timeout', () => {
    const source = readFileSync('src/client/chatStream.ts', 'utf8');
    const match = source.match(/const DEFAULT_STREAM_IDLE_TIMEOUT_MS = ([\d_]+);/);

    expect(match).not.toBeNull();
    expect(Number(match![1]!.replace(/_/g, ''))).toBeGreaterThan(120_000);
  });

  it('never turns a failed primary stream into an automatic recover request', async () => {
    const primaryStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close();
      }
    });
    const recoveredStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(sseEvent('done', {
          turnId: 'turn-primary-failed',
          answer: 'This alternate delivery path must not be used automatically.',
          productCards: [],
          usedWebSearch: false
        })));
        controller.close();
      }
    });
    const fetcher = vi.fn(async (url: string | URL | Request) => (
      String(url).includes('/recover')
        ? new Response(recoveredStream, { status: 200 })
        : new Response(primaryStream, {
            status: 200,
            headers: { 'x-chat-turn-id': 'turn-primary-failed' }
          })
    ));

    await expect(streamChatMessage(
      '',
      'session-1',
      'Нужна виброплита',
      { onDelta: () => undefined },
      undefined,
      { fetcher, visitorId }
    )).rejects.toThrow('Server finished without a done payload');

    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('surfaces a stalled primary SSE stream without automatic recovery', async () => {
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
        { fetcher, idleTimeoutMs: 1000, visitorId }
      );

      const rejection = expect(result).rejects.toThrow();
      await vi.advanceTimersByTimeAsync(1000);
      await rejection;
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(deltas).toEqual([]);
      expect(statuses).not.toContain('Ответ оборвался, восстанавливаю...');
    } finally {
      vi.useRealTimers();
    }
  });

  it('surfaces a closed primary SSE body without automatic recovery', async () => {
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
      { fetcher, visitorId }
    )).rejects.toThrow('Server finished without a done payload');

    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('does not start any recovery transport when the primary stream closes', async () => {
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
        { fetcher, visitorId }
      );
      await expect(result).rejects.toThrow('Server finished without a done payload');
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(recoveryCalls).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not request recovery after a primary stream closes', async () => {
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
      { fetcher, visitorId }
    )).rejects.toThrow('Server finished without a done payload');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('does not extend a failed primary stream through recovery', async () => {
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
        { fetcher, idleTimeoutMs: 1000, visitorId }
      );

      const rejection = expect(result).rejects.toThrow();
      await vi.advanceTimersByTimeAsync(1000);
      await rejection;
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(deltas).toEqual([]);
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
        { fetcher: async () => new Response(stream, { status: 200 }), idleTimeoutMs: 1000, visitorId }
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
      { fetcher, clientMessageId, visitorId }
    );

    const request = fetcher.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(request.body))).toEqual({ message: 'да', clientMessageId });
    expect(request.headers).toMatchObject({ 'x-bakaut-visitor-id': visitorId });
  });

  it('returns the active turn id without treating the second message as persisted', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      error: 'active_conversation_turn_exists',
      activeTurnId: '33333333-3333-4333-8333-333333333333',
      recoverable: true
    }), { status: 409, headers: { 'content-type': 'application/json' } }));

    const error = await streamChatMessage(
      '',
      'session-1',
      'Второй вопрос',
      { onDelta: () => undefined },
      undefined,
      { fetcher, visitorId }
    ).catch((caught) => caught);

    expect(error).toBeInstanceOf(ActiveConversationTurnError);
    expect(error).toMatchObject({
      activeTurnId: '33333333-3333-4333-8333-333333333333'
    });
    expect(error.message).not.toContain('сохран');
  });

  it('treats every 409 without an active turn id as a non-accepted buyer message', async () => {
    for (const payload of [
      { error: 'active_conversation_turn_exists', recoverable: true },
      { error: 'client_message_id_reused_with_different_payload', recoverable: false },
      { error: 'conflict' }
    ]) {
      const fetcher = vi.fn(async () => new Response(JSON.stringify(payload), {
        status: 409,
        headers: { 'content-type': 'application/json' }
      }));

      const error = await streamChatMessage(
        '',
        'session-1',
        'Второй вопрос',
        { onDelta: () => undefined },
        undefined,
        { fetcher, visitorId }
      ).catch((caught) => caught);

      expect(error).toBeInstanceOf(ChatMessageNotAcceptedError);
      expect(error).not.toBeInstanceOf(ActiveConversationTurnError);
      expect(error).toMatchObject({ activeTurnId: undefined });
      expect(error.message).toContain('не принят');
      expect(error.message).not.toContain('сохран');
    }
  });

  it('types a definitive session 404 as non-accepted and marks only that session stale', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      error: 'Session not found or inactive'
    }), {
      status: 404,
      headers: { 'content-type': 'application/json' }
    }));

    const error = await streamChatMessage(
      '',
      'session-1',
      'Нужен генератор',
      { onDelta: () => undefined },
      undefined,
      { fetcher, visitorId }
    ).catch((caught) => caught);

    expect(error).toBeInstanceOf(ChatMessageNotAcceptedError);
    expect(error).toMatchObject({
      activeTurnId: undefined,
      statusCode: 404
    });
    expect(error.message).toContain('не принято');
  });

  it('sends the visitor capability when recovering an existing turn', async () => {
    const payload = {
      turnId: '33333333-3333-4333-8333-333333333333',
      answer: 'Готовый ответ',
      needState: {},
      productCards: [],
      usedWebSearch: false
    };
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(sseEvent('done', payload)));
        controller.close();
      }
    });
    const fetcher = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(stream, { status: 200 }));

    await expect(recoverChatTurn(
      '',
      'session-1',
      '33333333-3333-4333-8333-333333333333',
      visitorId,
      { onDelta: () => undefined },
      undefined,
      { fetcher }
    )).resolves.toMatchObject(payload);

    expect(fetcher.mock.calls[0]?.[1]?.headers).toMatchObject({
      'x-bakaut-visitor-id': visitorId
    });
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
      { fetcher, visitorId }
    )).rejects.toThrow('Этот ответ уже формируется.');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
