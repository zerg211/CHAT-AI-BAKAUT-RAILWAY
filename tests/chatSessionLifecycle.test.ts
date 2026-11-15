import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConversationSessionUnavailableError } from '../src/db/repositories.js';
import { registerChatRoutes } from '../src/routes/chat.js';
import { config } from '../src/config.js';
import { ControlledRequestRejected, ControlledResponseFailure } from '../src/ai/controlledResponsesClient.js';
import { AgentAnswerRejectedError } from '../src/ai/agentAnswerRejected.js';

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
    getTurn: vi.fn().mockResolvedValue(null),
    updateTurn: vi.fn().mockResolvedValue(null),
    recordAnswerDelivery: vi.fn(async () => true)
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
    { route: 'messages', kind: 'submission' }, { route: 'recover', kind: 'submission' },
    { route: 'messages', kind: 'answer' }, { route: 'recover', kind: 'answer' },
    { route: 'messages', kind: 'provider' }, { route: 'recover', kind: 'provider' }
  ])('terminalizes a definitive $kind rejection through $route despite a saved checkpoint', async ({ route, kind }) => {
    const { app, conversations, assistant } = await buildApp();
    const previousAgent = config.OPENAI_PLATFORM_AGENT_ID;
    config.OPENAI_PLATFORM_AGENT_ID = 'test-agent';
    conversations.createTurnWithUserMessage.mockResolvedValue({ id: turnId, deadlineAt: null });
    conversations.getTurn.mockResolvedValue({ id: turnId, status: 'answering', deadlineAt: null });
    Object.assign(conversations, { listTurnCheckpoints: vi.fn(async () => [{ checkpoint: 'platform_agent_submission', payload: { rejected: kind === 'submission' } }]) });
    const error = kind === 'submission' ? new ControlledRequestRejected(429) : kind === 'answer'
      ? new AgentAnswerRejectedError('Incomplete classification') : new ControlledResponseFailure('MCP unavailable', undefined, true);
    assistant.generateAnswer.mockRejectedValue(error);
    assistant.recoverTurn.mockRejectedValue(error);
    try {
      const response = await app.inject({ method: 'POST', url: route === 'messages'
        ? `/api/chat/sessions/${sessionId}/messages` : `/api/chat/sessions/${sessionId}/messages/${turnId}/recover`,
        headers: { 'x-bakaut-visitor-id': visitorId }, payload: route === 'messages' ? { message: 'Сравните' } : {} });
      expect(response.body).toContain('"recoverable":false');
      expect(conversations.updateTurn).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed',
        errorCode: kind === 'submission' ? 'controlled_submission_rejected' : kind === 'answer' ? 'agent_answer_rejected' : 'provider_response_failed', requireUnowned: true }));
    } finally { config.OPENAI_PLATFORM_AGENT_ID = previousAgent; }
  });
  it('yields a saved research turn at the HTTP window without failing it or imposing a global deadline', async () => {
    const { app, conversations, assistant } = await buildApp();
    await app.ready();
    const previousAgent = config.OPENAI_PLATFORM_AGENT_ID;
    config.OPENAI_PLATFORM_AGENT_ID = 'test-agent';
    conversations.createTurnWithUserMessage.mockResolvedValue({ id: turnId, deadlineAt: null });
    conversations.getTurn.mockResolvedValue({ id: turnId, status: 'answering', deadlineAt: null });
    Object.assign(conversations, { listTurnCheckpoints: vi.fn(async () => [{ checkpoint: 'platform_agent_submission' }]) });
    let started!: () => void;
    const running = new Promise<void>(resolve => { started = resolve; });
    assistant.generateAnswer.mockImplementation(async ({ signal }: { signal: AbortSignal }) => {
      started();
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error(String(signal.reason))), { once: true }));
    });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const request = app.inject({ method: 'POST', url: `/api/chat/sessions/${sessionId}/messages`,
        headers: { 'x-bakaut-visitor-id': visitorId }, payload: { message: 'Проверьте все модели' } }).then(value => value);
      await running;
      await vi.advanceTimersByTimeAsync(80_000);
      const response = await request;
      expect(response.body).toContain('event: pending');
      expect(response.body).not.toContain('event: error');
      expect(conversations.updateTurn).not.toHaveBeenCalled();
      expect(conversations.createTurnWithUserMessage).toHaveBeenCalledWith(expect.objectContaining({ deadlineAt: null }));
    } finally { vi.useRealTimers(); config.OPENAI_PLATFORM_AGENT_ID = previousAgent; }
  });
  it('records bounded delivery telemetry only for the authorized session', async () => {
    const {app,conversations}=await buildApp();
    const request={method:'POST' as const,url:`/api/chat/sessions/${sessionId}/messages/${messageId}/delivery`,payload:{firstUsefulContentMs:1200}};
    expect((await app.inject(request)).statusCode).toBe(404);
    expect((await app.inject({...request,headers:{'x-bakaut-visitor-id':'wrong'}})).statusCode).toBe(404);
    expect(conversations.recordAnswerDelivery).not.toHaveBeenCalled();
    expect((await app.inject({...request,headers:{'x-bakaut-visitor-id':visitorId}})).statusCode).toBe(200);
    expect(conversations.recordAnswerDelivery).toHaveBeenCalledWith(expect.objectContaining({sessionId,messageId,firstUsefulContentMs:1200}));
    conversations.recordAnswerDelivery.mockClear();
    expect((await app.inject({...request,headers:{'x-bakaut-visitor-id':visitorId},payload:{firstUsefulContentMs:651282}})).statusCode).toBe(200);
    expect(conversations.recordAnswerDelivery).toHaveBeenCalledWith(expect.objectContaining({firstUsefulContentMs:651282}));
    conversations.recordAnswerDelivery.mockClear();
    const invalid=await app.inject({...request,headers:{'x-bakaut-visitor-id':visitorId},payload:{firstUsefulContentMs:Number.MAX_SAFE_INTEGER+1}});
    expect(invalid.statusCode).toBeGreaterThanOrEqual(400);
    expect(conversations.recordAnswerDelivery).not.toHaveBeenCalled();
  });
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
    expect(conversations.getHistorySnapshot).toHaveBeenCalledWith(sessionId, 81, null);
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

  it('does not replay an action-bearing generation when a later stage fails', async () => {
    const { app, conversations, assistant } = await buildApp();
    conversations.updateTurn.mockResolvedValue(null);
    conversations.createTurnWithUserMessage.mockResolvedValue({
      id: turnId, deadlineAt: new Date(Date.now() + 60_000).toISOString()
    });
    let committedActions = 0;
    assistant.generateAnswer.mockImplementation(async () => {
      committedActions += 1;
      throw new Error('provider timeout after action commit');
    });
    const response = await app.inject({
      method: 'POST', url: `/api/chat/sessions/${sessionId}/messages`,
      headers: { 'x-bakaut-visitor-id': visitorId }, payload: { message: 'Продолжить согласованное действие' }
    });
    expect(response.statusCode).toBe(200);
    expect(committedActions).toBe(1);
    expect(assistant.generateAnswer).toHaveBeenCalledTimes(1);
    expect(assistant.recoverTurn).not.toHaveBeenCalled();
    expect(response.body).toContain('event: error');
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

describe('bounded client technical reports',()=>{
  it('requires session capability, rejects another session turn and private payload fields',async()=>{
    const {app,conversations}=await buildApp();
    const request={method:'POST' as const,url:`/api/chat/sessions/${sessionId}/diagnostics`,payload:{clientMessageId:messageId,turnId,requestId:turnId,recovery:false,droppedEvents:100000,
      events:Array.from({length:32},()=>({type:'stream_error',offsetMs:3600000,statusCode:503}))}};
    expect((await app.inject(request)).statusCode).toBe(404);
    const headers={'x-bakaut-visitor-id':visitorId};
    expect((await app.inject({...request,headers})).statusCode).toBe(404);
    conversations.getTurn.mockResolvedValue({id:turnId} as never);
    expect((await app.inject({...request,headers})).statusCode).toBe(200);
    expect((await app.inject({...request,headers,payload:{...request.payload,secret:'PRIVATE'}})).statusCode).toBeGreaterThanOrEqual(400);
    expect((await app.inject({...request,headers,payload:{...request.payload,events:[...request.payload.events,request.payload.events[0]]}})).statusCode).toBeGreaterThanOrEqual(400);
    expect(conversations.updateTurn).not.toHaveBeenCalled();
    expect(conversations.recordAnswerDelivery).not.toHaveBeenCalled();
  });
});
