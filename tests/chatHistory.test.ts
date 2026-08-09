import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ChatHistoryNotFoundError,
  abandonSavedChat,
  clearSavedSessionIfMatches,
  initialChatHydrationState,
  loadChatHistory,
  loadChatHistoryState,
  restoreSavedChatSession,
  safeStorageGet,
  savedSessionHeartbeatOutcome,
  runSessionCreationSingleFlight
} from '../src/client/chatHistory.js';
import { registerChatRoutes } from '../src/routes/chat.js';
import {
  PUBLIC_HISTORY_MAX_RESPONSE_BYTES,
  limitPublicHistoryResponse
} from '../src/shared/publicChatHistory.js';

const sessionId = '11111111-1111-4111-8111-111111111111';
const otherSessionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const visitorId = 'visitor-capability-with-high-entropy';

const openApps: Array<ReturnType<typeof Fastify>> = [];
afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
});

function memorySessionStorage(initialSessionId: string | null) {
  let value = initialSessionId;
  return {
    getItem: vi.fn(() => value),
    removeItem: vi.fn(() => { value = null; }),
    replace(next: string | null) { value = next; }
  };
}

async function publicHistoryApp(
  messages: Array<Record<string, unknown>>,
  pendingTurn: { turn: Record<string, unknown>; resultReady: boolean } | null = null
) {
  const conversations = {
    restoreSession: vi.fn(async (id: string, capability: string) => id === sessionId && capability === visitorId
      ? { id: sessionId, status: 'active', visitorId }
      : null),
    touchSession: vi.fn(async (id: string, capability: string) => id === sessionId && capability === visitorId
      ? { id: sessionId, status: 'active', visitorId }
      : null),
    listMessages: vi.fn(async () => messages),
    getLatestUnansweredTurn: vi.fn(async () => pendingTurn),
    getHistorySnapshot: vi.fn(async () => ({ messages, pendingTurn }))
  };
  const app = Fastify();
  openApps.push(app);
  await registerChatRoutes(app, { conversations: conversations as never });
  return { app, conversations };
}

describe('public chat history API', () => {
  it('returns the same 404 for a missing, wrong, or unknown restoration capability', async () => {
    const { app, conversations } = await publicHistoryApp([]);

    const missing = await app.inject({
      method: 'GET',
      url: `/api/chat/sessions/${sessionId}/messages`
    });
    const wrong = await app.inject({
      method: 'GET',
      url: `/api/chat/sessions/${sessionId}/messages`,
      headers: { 'x-bakaut-visitor-id': 'wrong-capability' }
    });
    const unknown = await app.inject({
      method: 'GET',
      url: `/api/chat/sessions/${otherSessionId}/messages`,
      headers: { 'x-bakaut-visitor-id': visitorId }
    });

    expect(missing.statusCode).toBe(404);
    expect(wrong.statusCode).toBe(404);
    expect(unknown.statusCode).toBe(404);
    expect(missing.json()).toEqual(wrong.json());
    expect(wrong.json()).toEqual(unknown.json());
    for (const response of [missing, wrong, unknown]) {
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.headers.vary).toContain('x-bakaut-visitor-id');
    }
    expect(conversations.getHistorySnapshot).not.toHaveBeenCalled();
  });

  it('restores and touches only through the authenticated repository operation', async () => {
    const { app, conversations } = await publicHistoryApp([]);

    const response = await app.inject({
      method: 'GET',
      url: `/api/chat/sessions/${sessionId}/messages`,
      headers: { 'x-bakaut-visitor-id': visitorId }
    });

    expect(response.statusCode).toBe(200);
    expect(conversations.restoreSession).toHaveBeenCalledWith(sessionId, visitorId);
    expect(conversations.getHistorySnapshot).toHaveBeenCalledWith(sessionId);
  });

  it('authenticates heartbeat without disclosing the visitor capability or session data', async () => {
    const { app, conversations } = await publicHistoryApp([]);
    const missingCapability = await app.inject({
      method: 'POST',
      url: `/api/chat/sessions/${sessionId}/heartbeat`
    });
    const authenticated = await app.inject({
      method: 'POST',
      url: `/api/chat/sessions/${sessionId}/heartbeat`,
      headers: { 'x-bakaut-visitor-id': visitorId }
    });

    expect(missingCapability.statusCode).toBe(404);
    expect(authenticated.statusCode).toBe(200);
    expect(authenticated.json()).toEqual({ ok: true });
    expect(JSON.stringify(authenticated.json())).not.toContain(visitorId);
    expect(conversations.restoreSession).toHaveBeenCalledWith(sessionId, visitorId);
  });

  it('allowlists user/assistant rows and schema-picks nested public card fields', async () => {
    const oversizedReason = 'x'.repeat(2_000);
    const { app } = await publicHistoryApp([
      {
        id: '20000000-0000-4000-8000-000000000000',
        sessionId,
        role: 'system',
        content: 'internal system prompt',
        metadata: { secret: 'system-secret' },
        createdAt: '2026-07-27T11:59:00.000Z'
      },
      {
        id: '21111111-1111-4111-8111-111111111111',
        sessionId,
        role: 'tool',
        content: 'raw tool output',
        metadata: { secret: 'tool-secret' },
        createdAt: '2026-07-27T11:59:30.000Z'
      },
      {
        id: '22222222-2222-4222-8222-222222222222',
        sessionId,
        role: 'user',
        content: 'Нужен генератор',
        metadata: { internalUserFlag: 'must-not-leak' },
        createdAt: '2026-07-27T12:00:00.000Z'
      },
      {
        id: '33333333-3333-4333-8333-333333333333',
        sessionId,
        role: 'assistant',
        content: 'Вот подходящий вариант.',
        metadata: {
          productCards: [{
            id: 'product-1',
            name: 'Тестовый генератор',
            brand: 'Brand',
            category: 'Генераторы',
            price: 12345,
            currency: 'RUB',
            imageUrl: 'javascript:alert(1)',
            sourceUrl: 'https://example.test/product-1',
            specs: {
              power: '5 кВт',
              internalMetadata: { apiKey: 'must-not-leak' },
              constructor: 'must-not-leak'
            },
            reasons: ['Подходит по мощности', 42, oversizedReason],
            caveats: ['Проверьте наличие'],
            metadata: { rankingTrace: 'must-not-leak' },
            raw: { supplierSecret: 'must-not-leak' }
          }],
          cardDisplay: { initialVisibleCount: 999, internalLayout: 'must-not-leak' },
          answerContract: { leadAction: 'offer_form', privateReasoning: 'must-not-leak' },
          toolResults: [{ secret: 'must-not-leak' }]
        },
        createdAt: '2026-07-27T12:00:05.000Z'
      }
    ]);

    const response = await app.inject({
      method: 'GET',
      url: `/api/chat/sessions/${sessionId}/messages`,
      headers: { 'x-bakaut-visitor-id': visitorId }
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    const payload = response.json() as { messages: Array<Record<string, unknown>> };
    expect(payload.messages.map((message) => message.role)).toEqual(['user', 'assistant']);
    expect(payload.messages[0]).toEqual({
      id: '22222222-2222-4222-8222-222222222222',
      role: 'user',
      content: 'Нужен генератор',
      createdAt: '2026-07-27T12:00:00.000Z'
    });
    const assistant = payload.messages[1] as {
      products: Array<Record<string, unknown>>;
      cardDisplay: Record<string, unknown>;
      leadRequested: boolean;
    };
    expect(assistant.products[0]).toEqual(expect.objectContaining({
      id: 'product-1',
      name: 'Тестовый генератор',
      sourceUrl: 'https://example.test/product-1',
      specs: { power: '5 кВт' },
      caveats: ['Проверьте наличие']
    }));
    expect(assistant.products[0]).not.toHaveProperty('imageUrl');
    expect(assistant.products[0]).not.toHaveProperty('metadata');
    expect(assistant.products[0]).not.toHaveProperty('raw');
    expect((assistant.products[0].reasons as string[])).toHaveLength(2);
    expect((assistant.products[0].reasons as string[])[1]).toHaveLength(500);
    expect(assistant.cardDisplay).toEqual({ initialVisibleCount: 50 });
    expect(assistant.leadRequested).toBe(true);
    for (const forbiddenTerm of [
      'toolResults',
      'internal',
      'secret',
      'privateReasoning',
      'rankingTrace',
      'supplierSecret'
    ]) {
      expect(response.body.toLowerCase()).not.toContain(forbiddenTerm.toLowerCase());
    }
  });

  it('caps the complete serialized history response instead of only individual fields', async () => {
    const hugeMessages = Array.from({ length: 10 }, (_, index) => ({
      id: `message-${index}`,
      sessionId,
      role: 'assistant',
      content: 'я'.repeat(100_000),
      metadata: {},
      createdAt: '2026-07-27T12:00:05.000Z'
    }));
    const { app } = await publicHistoryApp(hugeMessages);

    const response = await app.inject({
      method: 'GET',
      url: `/api/chat/sessions/${sessionId}/messages`,
      headers: { 'x-bakaut-visitor-id': visitorId }
    });

    expect(response.statusCode).toBe(200);
    expect(new TextEncoder().encode(response.body).byteLength).toBeLessThanOrEqual(PUBLIC_HISTORY_MAX_RESPONSE_BYTES);
    expect((response.json() as { messages: unknown[] }).messages.length).toBeLessThan(hugeMessages.length);
  });

  it('returns an allowlisted pending turn state without execution or error internals', async () => {
    const deadlineAt = '2026-08-09T12:30:00.000Z';
    const { app } = await publicHistoryApp([], {
      turn: {
        id: '33333333-3333-4333-8333-333333333333',
        status: 'answering',
        stage: 'catalog_search',
        deadlineAt,
        requestHash: 'must-not-leak',
        executionOwner: 'must-not-leak',
        errorMessage: 'must-not-leak'
      },
      resultReady: false
    });

    const response = await app.inject({
      method: 'GET',
      url: `/api/chat/sessions/${sessionId}/messages`,
      headers: { 'x-bakaut-visitor-id': visitorId }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      pendingTurn: {
        turnId: '33333333-3333-4333-8333-333333333333',
        status: 'answering',
        stage: 'catalog_search',
        deadlineAt,
        terminal: false,
        resultState: 'pending'
      }
    });
    expect(response.body).not.toContain('must-not-leak');
  });
});

describe('public chat history client', () => {
  it('parses a typed pending turn for hydrate recovery', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      messages: [{ id: 'user-1', role: 'user', content: 'Нужен генератор' }],
      pendingTurn: {
        turnId: '33333333-3333-4333-8333-333333333333',
        status: 'answering',
        stage: 'catalog_search',
        deadlineAt: '2026-08-09T12:30:00.000Z',
        terminal: false,
        resultState: 'pending'
      }
    }), { status: 200, headers: { 'content-type': 'application/json' } }));

    await expect(loadChatHistoryState('', sessionId, visitorId, fetcher)).resolves.toEqual({
      messages: [{ id: 'user-1', role: 'user', content: 'Нужен генератор' }],
      pendingTurn: {
        turnId: '33333333-3333-4333-8333-333333333333',
        status: 'answering',
        stage: 'catalog_search',
        deadlineAt: '2026-08-09T12:30:00.000Z',
        terminal: false,
        resultState: 'pending'
      }
    });
  });

  it('sends the visitor restoration capability and normalizes malformed legacy cards', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      messages: [
        { role: 'system', content: 'must be dropped' },
        {
          id: 'message-1',
          role: 'assistant',
          content: 'Старый ответ',
          products: [
            {
              id: 'legacy-card',
              name: 'Legacy card',
              reasons: 'not-an-array',
              caveats: [null, 'Уточнить цену'],
              specs: { power: '4 кВт', nested: { secret: true } },
              imageUrl: 'data:text/html,bad',
              sourceUrl: 'http://example.test/card',
              metadata: { secret: true }
            },
            { id: null, name: 'invalid card' }
          ],
          cardDisplay: { initialVisibleCount: -5, secret: true },
          leadRequested: true
        }
      ]
    }), { status: 200, headers: { 'content-type': 'application/json' } }));

    const messages = await loadChatHistory('', sessionId, visitorId, fetcher);

    expect(fetcher).toHaveBeenCalledWith(
      `/api/chat/sessions/${sessionId}/messages`,
      expect.objectContaining({
        headers: {
          Accept: 'application/json',
          'x-bakaut-visitor-id': visitorId
        }
      })
    );
    expect(messages).toEqual([{
      id: 'message-1',
      role: 'assistant',
      content: 'Старый ответ',
      products: [{
        id: 'legacy-card',
        name: 'Legacy card',
        sourceUrl: 'http://example.test/card',
        specs: { power: '4 кВт' },
        reasons: [],
        caveats: ['Уточнить цену']
      }],
      cardDisplay: { initialVisibleCount: 1 },
      leadRequested: true
    }]);
  });

  it('distinguishes a history 404 from a valid empty history', async () => {
    const notFoundFetcher = vi.fn(async () => new Response('{}', { status: 404 }));
    const emptyFetcher = vi.fn(async () => new Response('{"messages":[]}', {
      status: 200,
      headers: { 'content-type': 'application/json' }
    }));

    await expect(loadChatHistory('', sessionId, visitorId, notFoundFetcher)).rejects.toBeInstanceOf(ChatHistoryNotFoundError);
    await expect(loadChatHistory('', sessionId, visitorId, emptyFetcher)).resolves.toEqual([]);
  });

  it('initializes explicit hydration state from the saved session and restores lead intent', async () => {
    expect(initialChatHydrationState(sessionId)).toBe('restoring');
    expect(initialChatHydrationState(null)).toBe('ready');
    const storage = memorySessionStorage(sessionId);
    const fetcher = vi.fn(async (_input: string | URL | Request) => new Response(JSON.stringify({
      messages: [{ role: 'assistant', content: 'Оставьте контакты', leadRequested: true }]
    }), { status: 200, headers: { 'content-type': 'application/json' } }));

    const restored = await restoreSavedChatSession('', sessionId, visitorId, storage, fetcher);

    expect(restored).toEqual(expect.objectContaining({
      kind: 'restored',
      sessionId,
      leadRequested: true
    }));
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(String(fetcher.mock.calls[0][0])).toBe(`/api/chat/sessions/${sessionId}/messages`);
  });

  it('carries pending turn state through saved-session restoration', async () => {
    const storage = memorySessionStorage(sessionId);
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      messages: [{ id: 'user-1', role: 'user', content: 'Нужен генератор' }],
      pendingTurn: {
        turnId: '33333333-3333-4333-8333-333333333333',
        status: 'failed',
        stage: 'deadline_expired',
        deadlineAt: '2026-08-09T12:30:00.000Z',
        terminal: true,
        resultState: 'ready'
      }
    }), { status: 200, headers: { 'content-type': 'application/json' } }));

    const restored = await restoreSavedChatSession('', sessionId, visitorId, storage, fetcher);

    expect(restored).toMatchObject({
      kind: 'restored',
      pendingTurn: {
        turnId: '33333333-3333-4333-8333-333333333333',
        terminal: true,
        resultState: 'ready'
      }
    });
  });

  it('does not reopen lead capture from an old assistant offer after a newer assistant response', async () => {
    const storage = memorySessionStorage(sessionId);
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      messages: [
        { id: 'assistant-old', role: 'assistant', content: 'Оставьте контакты', leadRequested: true },
        { id: 'user-next', role: 'user', content: 'Не сейчас' },
        { id: 'assistant-latest', role: 'assistant', content: 'Хорошо, продолжим без заявки', leadRequested: false }
      ]
    }), { status: 200, headers: { 'content-type': 'application/json' } }));

    const restored = await restoreSavedChatSession('', sessionId, visitorId, storage, fetcher);

    expect(restored).toMatchObject({ kind: 'restored', leadRequested: false });
  });

  it('reopens lead capture when the latest assistant response requests it', async () => {
    const storage = memorySessionStorage(sessionId);
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      messages: [
        { id: 'assistant-old', role: 'assistant', content: 'Продолжим подбор', leadRequested: false },
        { id: 'user-next', role: 'user', content: 'Передайте специалисту' },
        { id: 'assistant-latest', role: 'assistant', content: 'Оставьте контакты', leadRequested: true }
      ]
    }), { status: 200, headers: { 'content-type': 'application/json' } }));

    const restored = await restoreSavedChatSession('', sessionId, visitorId, storage, fetcher);

    expect(restored).toMatchObject({ kind: 'restored', leadRequested: true });
  });

  it('does not reopen the latest lead offer after a durable lead was submitted for it', async () => {
    const storage = memorySessionStorage(sessionId);
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      messages: [
        { id: 'assistant-latest', role: 'assistant', content: 'Оставьте контакты', leadRequested: true }
      ],
      leadOfferConsumed: true
    }), { status: 200, headers: { 'content-type': 'application/json' } }));

    const restored = await restoreSavedChatSession('', sessionId, visitorId, storage, fetcher);

    expect(restored).toMatchObject({ kind: 'restored', leadRequested: false });
  });

  it('clears and resets only the matching stale session when authenticated history restoration 404s', async () => {
    const storage = memorySessionStorage(sessionId);
    const fetcher = vi.fn(async () => new Response('{}', { status: 404 }));

    await expect(restoreSavedChatSession('', sessionId, visitorId, storage, fetcher)).resolves.toEqual({
      kind: 'stale',
      sessionId: null
    });
    expect(storage.removeItem).toHaveBeenCalledWith('bakaut_session_id');

    const racedStorage = memorySessionStorage(otherSessionId);
    expect(clearSavedSessionIfMatches(racedStorage, sessionId)).toBe(false);
    expect(racedStorage.removeItem).not.toHaveBeenCalled();
    expect(racedStorage.getItem()).toBe(otherSessionId);
  });

  it('contains blocked storage failures and can abandon only the expected saved chat', () => {
    const blockedStorage = {
      getItem: vi.fn(() => { throw new DOMException('blocked', 'SecurityError'); }),
      removeItem: vi.fn(() => { throw new DOMException('blocked', 'SecurityError'); })
    };
    expect(safeStorageGet(blockedStorage, 'bakaut_session_id')).toBeNull();
    expect(clearSavedSessionIfMatches(blockedStorage, sessionId)).toBe(false);

    const storage = memorySessionStorage(sessionId);
    expect(abandonSavedChat(storage, sessionId)).toEqual({
      cleared: true,
      hydrationState: 'ready'
    });
    expect(storage.getItem()).toBeNull();
  });

  it('abandons a saved session only after an authoritative heartbeat 404', () => {
    expect(savedSessionHeartbeatOutcome({ ok: true, status: 204 })).toBe('reuse');
    expect(savedSessionHeartbeatOutcome({ ok: false, status: 404 })).toBe('abandon');
    expect(savedSessionHeartbeatOutcome({ ok: false, status: 429 })).toBe('retry');
    expect(savedSessionHeartbeatOutcome({ ok: false, status: 503 })).toBe('retry');
    expect(savedSessionHeartbeatOutcome(null)).toBe('retry');
  });

  it('coalesces concurrent replacement-session creation into one request', async () => {
    let resolveCreation!: (value: string) => void;
    const create = vi.fn(() => new Promise<string>((resolve) => { resolveCreation = resolve; }));

    const first = runSessionCreationSingleFlight(create);
    const second = runSessionCreationSingleFlight(create);
    resolveCreation('replacement-session');

    await expect(Promise.all([first, second])).resolves.toEqual(['replacement-session', 'replacement-session']);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('keeps the newest restorable messages and skips oversized older entries', () => {
    const limited = limitPublicHistoryResponse([
      { id: 'oversized-old', role: 'assistant', content: 'x'.repeat(1_000) },
      { id: 'recent-user', role: 'user', content: 'Последний вопрос' },
      { id: 'recent-answer', role: 'assistant', content: 'Последний ответ' }
    ], 300);

    expect(limited.map((message) => message.id)).toEqual(['recent-user', 'recent-answer']);
  });
});
