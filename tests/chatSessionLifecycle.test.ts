import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConversationSessionUnavailableError } from '../src/db/repositories.js';
import { registerChatRoutes } from '../src/routes/chat.js';

const sessionId = '11111111-1111-4111-8111-111111111111';
const messageId = '22222222-2222-4222-8222-222222222222';
const turnId = '33333333-3333-4333-8333-333333333333';
const visitorId = 'visitor-capability-with-high-entropy';

const openApps: Array<ReturnType<typeof Fastify>> = [];

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
});

function buildDependencies() {
  const conversations = {
    restoreSession: vi.fn(async (_id: string, capability: string) => capability === visitorId
      ? { id: sessionId, status: 'active', pageUrl: null, userAgent: null, needState: { activeNeeds: [] } }
      : null),
    listMessages: vi.fn(async () => []),
    getLatestUnansweredTurn: vi.fn(async () => null),
    getHistorySnapshot: vi.fn(async () => ({ messages: [], pendingTurn: null, leadOfferConsumed: false })),
    touchSession: vi.fn(),
    closeSession: vi.fn(async (input: { id: string; visitorCapability: string }) => (
      input.id === sessionId && input.visitorCapability === visitorId
        ? { id: sessionId, status: 'closed' }
        : null
    )),
    updateAssistantFeedback: vi.fn(async (input: { visitorCapability: string }) => (
      input.visitorCapability === visitorId
        ? { id: messageId, sessionId, role: 'assistant', content: 'answer', metadata: {}, createdAt: new Date().toISOString() }
        : null
    )),
    createTurnWithUserMessage: vi.fn(),
    getTurn: vi.fn(),
    updateTurn: vi.fn()
  };
  const assistant = {
    generateAnswer: vi.fn(),
    recoverTurn: vi.fn()
  };
  return { conversations, assistant };
}

async function buildApp() {
  const dependencies = buildDependencies();
  const app = Fastify({ logger: false });
  openApps.push(app);
  await registerChatRoutes(app, dependencies as never);
  return { app, ...dependencies };
}

describe('session-scoped chat route capability', () => {
  it.each([
    {
      label: 'send',
      request: { method: 'POST', url: `/api/chat/sessions/${sessionId}/messages`, payload: { message: 'Нужен генератор' } },
      forbidden: ['createTurnWithUserMessage', 'generateAnswer']
    },
    {
      label: 'recover',
      request: { method: 'POST', url: `/api/chat/sessions/${sessionId}/messages/${turnId}/recover`, payload: {} },
      forbidden: ['getTurn', 'recoverTurn', 'updateTurn']
    }
  ])('rejects an absent or wrong capability before any $label side effect', async ({ request, forbidden }) => {
    const { app, conversations, assistant } = await buildApp();

    const missing = await app.inject(request as never);
    const wrong = await app.inject({
      ...request,
      headers: { 'x-bakaut-visitor-id': 'wrong-capability' }
    } as never);

    expect(missing.statusCode).toBe(404);
    expect(wrong.statusCode).toBe(404);
    expect(missing.json()).toEqual(wrong.json());
    for (const method of forbidden) {
      const target = (conversations as Record<string, unknown>)[method] ?? (assistant as Record<string, unknown>)[method];
      expect(target).not.toHaveBeenCalled();
    }
  });

  it('capability-gates close in the atomic repository statement without a route-level restore race', async () => {
    const { app, conversations } = await buildApp();

    const missing = await app.inject({
      method: 'POST',
      url: `/api/chat/sessions/${sessionId}/close`,
      payload: {}
    });
    const wrong = await app.inject({
      method: 'POST',
      url: `/api/chat/sessions/${sessionId}/close`,
      headers: { 'x-bakaut-visitor-id': 'wrong-capability' },
      payload: {}
    });
    const accepted = await app.inject({
      method: 'POST',
      url: `/api/chat/sessions/${sessionId}/close`,
      headers: { 'x-bakaut-visitor-id': visitorId },
      payload: {}
    });

    expect(missing.statusCode).toBe(404);
    expect(wrong.statusCode).toBe(404);
    expect(missing.json()).toEqual(wrong.json());
    expect(accepted.statusCode).toBe(200);
    expect(conversations.restoreSession).not.toHaveBeenCalled();
    expect(conversations.closeSession).toHaveBeenNthCalledWith(1, {
      id: sessionId,
      visitorCapability: 'wrong-capability'
    });
    expect(conversations.closeSession).toHaveBeenNthCalledWith(2, {
      id: sessionId,
      visitorCapability: visitorId
    });
  });

  it('capability-gates feedback in the atomic repository statement without a route-level restore race', async () => {
    const { app, conversations } = await buildApp();
    const request = {
      method: 'POST',
      url: `/api/chat/sessions/${sessionId}/messages/${messageId}/feedback`,
      payload: { rating: 'negative' }
    };

    const missing = await app.inject(request as never);
    const wrong = await app.inject({
      ...request,
      headers: { 'x-bakaut-visitor-id': 'wrong-capability' }
    } as never);
    const accepted = await app.inject({
      ...request,
      headers: { 'x-bakaut-visitor-id': visitorId }
    } as never);

    expect(missing.statusCode).toBe(404);
    expect(wrong.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: 'Session not found or inactive' });
    expect(accepted.statusCode).toBe(200);
    expect(conversations.restoreSession).not.toHaveBeenCalled();
    expect(conversations.updateAssistantFeedback).toHaveBeenNthCalledWith(1, {
      sessionId,
      messageId,
      visitorCapability: 'wrong-capability',
      rating: 'negative'
    });
    expect(conversations.updateAssistantFeedback).toHaveBeenNthCalledWith(2, {
      sessionId,
      messageId,
      visitorCapability: visitorId,
      rating: 'negative'
    });
  });

  it('restores messages and pending state through one repository snapshot', async () => {
    const { app, conversations } = await buildApp();
    conversations.getHistorySnapshot.mockResolvedValueOnce({
      messages: [],
      pendingTurn: null,
      leadOfferConsumed: true
    });

    const response = await app.inject({
      method: 'GET',
      url: `/api/chat/sessions/${sessionId}/messages`,
      headers: { 'x-bakaut-visitor-id': visitorId }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ leadOfferConsumed: true });
    expect(conversations.getHistorySnapshot).toHaveBeenCalledOnce();
    expect(conversations.getHistorySnapshot).toHaveBeenCalledWith(sessionId);
    expect(conversations.getLatestUnansweredTurn).not.toHaveBeenCalled();
    expect(conversations.listMessages).not.toHaveBeenCalled();
  });

  it('marks a generation failure only when no replacement execution owns the turn', async () => {
    const { app, conversations, assistant } = await buildApp();
    conversations.createTurnWithUserMessage.mockResolvedValue({
      id: turnId,
      deadlineAt: new Date(Date.now() + 60_000).toISOString()
    });
    assistant.generateAnswer.mockRejectedValue(new Error('generation failed'));
    assistant.recoverTurn.mockRejectedValue(new Error('recovery failed'));

    const response = await app.inject({
      method: 'POST',
      url: `/api/chat/sessions/${sessionId}/messages`,
      headers: { 'x-bakaut-visitor-id': visitorId },
      payload: { message: 'Нужен генератор' }
    });

    expect(response.statusCode).toBe(200);
    expect(conversations.createTurnWithUserMessage).toHaveBeenCalledWith(expect.objectContaining({
      sessionId,
      visitorCapability: visitorId
    }));
    expect(conversations.updateTurn).toHaveBeenCalledWith(expect.objectContaining({
      turnId,
      status: 'failed',
      requireUnowned: true
    }));
  });

  it('returns the same non-disclosing 404 when atomic message acceptance loses the session race', async () => {
    const { app, conversations, assistant } = await buildApp();
    conversations.createTurnWithUserMessage.mockRejectedValue(new ConversationSessionUnavailableError());

    const response = await app.inject({
      method: 'POST',
      url: `/api/chat/sessions/${sessionId}/messages`,
      headers: { 'x-bakaut-visitor-id': visitorId },
      payload: { message: 'Нужен генератор' }
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'Session not found or inactive' });
    expect(assistant.generateAnswer).not.toHaveBeenCalled();
  });

  it('marks a recovery failure only when no replacement execution owns the turn', async () => {
    const { app, conversations, assistant } = await buildApp();
    conversations.getTurn.mockResolvedValue({
      id: turnId,
      deadlineAt: new Date(Date.now() + 60_000).toISOString()
    });
    assistant.recoverTurn.mockRejectedValue(new Error('recovery failed'));

    const response = await app.inject({
      method: 'POST',
      url: `/api/chat/sessions/${sessionId}/messages/${turnId}/recover`,
      headers: { 'x-bakaut-visitor-id': visitorId },
      payload: {}
    });

    expect(response.statusCode).toBe(200);
    expect(conversations.updateTurn).toHaveBeenCalledWith(expect.objectContaining({
      turnId,
      status: 'failed',
      stage: 'recovery_failed',
      requireUnowned: true
    }));
  });
});
