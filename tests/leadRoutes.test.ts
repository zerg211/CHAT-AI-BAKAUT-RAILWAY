import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { normalizePublicHistoryMessages } from '../src/shared/publicChatHistory.js';

const repoMocks = vi.hoisted(() => ({
  createClientLeadWithOutbox: vi.fn(),
  markEmailResult: vi.fn(),
  restoreSession: vi.fn(),
  listMessages: vi.fn(), findClientLeadWithOutbox: vi.fn(), getLatestUnansweredTurn: vi.fn()
}));

vi.mock('../src/db/repositories.js', () => ({
  LeadRepository: vi.fn(function LeadRepository() {
    return {
      createClientLeadWithOutbox: repoMocks.createClientLeadWithOutbox,
      findClientLeadWithOutbox: repoMocks.findClientLeadWithOutbox,
      markEmailResult: repoMocks.markEmailResult
    };
  }),
  ConversationRepository: vi.fn(function ConversationRepository() {
    return {
      restoreSession: repoMocks.restoreSession, listMessages: repoMocks.listMessages,
      getLatestUnansweredTurn: repoMocks.getLatestUnansweredTurn
    };
  }),
  ProductRepository: vi.fn()
}));

const { registerLeadRoutes } = await import('../src/routes/leads.js');
const { pool } = await import('../src/db/pool.js');
afterEach(() => vi.restoreAllMocks());

async function buildTestApp() {
  const app = Fastify({ logger: false });
  await app.register(rateLimit, { max: 120, timeWindow: '1 minute' });
  await registerLeadRoutes(app);
  return app;
}

const sessionId = '00000000-0000-4000-8000-000000000001';
const clientLeadId = '00000000-0000-4000-8000-000000000003';
const visitorId = 'visitor-capability-with-high-entropy';
const capabilityHeaders = { 'x-bakaut-visitor-id': visitorId };

function validLeadPayload() {
  return {
    sessionId,
    clientLeadId,
    name: 'Илья',
    phone: '+7 900 000-10-03',
    question: 'Проверить наличие и доставку генератора'
  };
}

function completedLeadCapture() {
  return {
    lead: {
      id: 'lead-id',
      sessionId,
      clientLeadId,
      name: 'Илья',
      phone: '+7 900 000-10-03',
      status: 'pending_email',
      createdAt: new Date().toISOString()
    },
    outbox: {
      id: 'outbox-id',
      leadId: 'lead-id',
      sessionId,
      turnId: '00000000-0000-4000-8000-000000000002',
      destination: 'lead_email',
      payload: { leadId: 'lead-id', source: 'lead_form' },
      status: 'pending',
      attemptCount: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    },
    draft: null,
    pendingDraftMatched: false
  };
}

describe('lead routes', () => {
  beforeEach(() => {
    repoMocks.createClientLeadWithOutbox.mockReset();
    repoMocks.markEmailResult.mockReset();
    repoMocks.restoreSession.mockReset();
    repoMocks.listMessages.mockReset(); repoMocks.findClientLeadWithOutbox.mockReset();
    repoMocks.listMessages.mockResolvedValue([]); repoMocks.findClientLeadWithOutbox.mockResolvedValue(null);
    repoMocks.restoreSession.mockImplementation(async (_id: string, capability: string) => capability === visitorId
      ? { id: sessionId, status: 'active' }
      : null);
    repoMocks.createClientLeadWithOutbox.mockResolvedValue(completedLeadCapture());
  });

  it('saves the lead and queues email delivery without blocking the form response', async () => {
    const app = await buildTestApp();
    const response = await app.inject({
      method: 'POST',
      url: '/api/leads',
      headers: capabilityHeaders,
      payload: validLeadPayload()
    });
    await app.close();

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      ok: true,
      status: 'queued',
      lead: { id: 'lead-id' },
      outboxId: 'outbox-id'
    });
    expect(repoMocks.createClientLeadWithOutbox).toHaveBeenCalledWith(expect.objectContaining({
      sessionId,
      clientLeadId,
      question: validLeadPayload().question
    }));
    expect(repoMocks.markEmailResult).not.toHaveBeenCalled();
  });

  it('does not report success if the atomic lead and outbox operation fails', async () => {
    repoMocks.createClientLeadWithOutbox.mockRejectedValueOnce(new Error('outbox unavailable'));
    const app = await buildTestApp();
    const response = await app.inject({
      method: 'POST',
      url: '/api/leads',
      headers: capabilityHeaders,
      payload: {
        sessionId,
        clientLeadId,
        name: 'Илья',
        phone: '+7 900 000-10-03'
      }
    });
    await app.close();

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      ok: false,
      error: 'lead_outbox_enqueue_failed',
      retryable: true
    });
    expect(repoMocks.markEmailResult).not.toHaveBeenCalled();
  });

  it('does not report success when outbox enqueue returns no durable row', async () => {
    repoMocks.createClientLeadWithOutbox.mockResolvedValueOnce({
      ...completedLeadCapture(),
      outbox: { ...completedLeadCapture().outbox, id: '' }
    });
    const app = await buildTestApp();
    const response = await app.inject({ method: 'POST', url: '/api/leads', headers: capabilityHeaders, payload: validLeadPayload() });
    await app.close();

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      ok: false,
      error: 'lead_outbox_enqueue_failed',
      retryable: true,
      leadId: 'lead-id'
    });
  });

  it('does not report a terminal dead outbox row as queued', async () => {
    repoMocks.createClientLeadWithOutbox.mockResolvedValueOnce({
      ...completedLeadCapture(),
      outbox: { ...completedLeadCapture().outbox, id: 'outbox-dead', status: 'dead' }
    });
    const app = await buildTestApp();
    const response = await app.inject({ method: 'POST', url: '/api/leads', headers: capabilityHeaders, payload: validLeadPayload() });
    await app.close();

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      ok: false,
      error: 'lead_outbox_enqueue_failed',
      retryable: true,
      leadId: 'lead-id'
    });
  });

  it('accepts a pending chat draft only when its context was atomically preserved and consumed', async () => {
    const draft = {
      id: 'draft-id',
      purpose: 'Уточнить совместимость виброплиты',
      buyerQuestion: 'Подойдёт ли плита для слоя 30 см?',
      preferredContact: 'message',
      status: 'consumed',
      consumedLeadId: 'lead-id'
    };
    repoMocks.createClientLeadWithOutbox.mockResolvedValueOnce({
      ...completedLeadCapture(),
      draft,
      pendingDraftMatched: true,
      outbox: {
        ...completedLeadCapture().outbox,
        payload: {
          leadId: 'lead-id',
          source: 'lead_form',
          purpose: draft.purpose,
          question: draft.buyerQuestion,
          preferredContact: draft.preferredContact
        }
      }
    });
    const app = await buildTestApp();
    const response = await app.inject({ method: 'POST', url: '/api/leads', headers: capabilityHeaders, payload: validLeadPayload() });
    await app.close();

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ ok: true, status: 'queued', outboxId: 'outbox-id' });
  });

  it('does not report success when a matched draft was not consumed with its outbox', async () => {
    repoMocks.createClientLeadWithOutbox.mockResolvedValueOnce({
      ...completedLeadCapture(),
      pendingDraftMatched: true,
      draft: null
    });
    const app = await buildTestApp();
    const response = await app.inject({ method: 'POST', url: '/api/leads', headers: capabilityHeaders, payload: validLeadPayload() });
    await app.close();

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      ok: false,
      error: 'lead_outbox_enqueue_failed',
      retryable: true,
      leadId: 'lead-id'
    });
  });

  it('uses the same request hash for an identical client retry and returns the same lead', async () => {
    const app = await buildTestApp();
    const first = await app.inject({ method: 'POST', url: '/api/leads', headers: capabilityHeaders, payload: validLeadPayload() });
    const second = await app.inject({ method: 'POST', url: '/api/leads', headers: capabilityHeaders, payload: validLeadPayload() });
    await app.close();

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(first.json().lead.id).toBe(second.json().lead.id);
    expect(repoMocks.createClientLeadWithOutbox).toHaveBeenCalledTimes(2);
    const firstInput = repoMocks.createClientLeadWithOutbox.mock.calls[0]?.[0];
    const secondInput = repoMocks.createClientLeadWithOutbox.mock.calls[1]?.[0];
    const hash = String(firstInput.clientRequestHash);
    const hexadecimal = new Set('0123456789abcdef');
    expect(hash).toHaveLength(64);
    expect([...hash].every((character) => hexadecimal.has(character))).toBe(true);
    expect(secondInput.clientRequestHash).toBe(firstInput.clientRequestHash);
  });

  it('returns 409 when a client lead id is reused with a different payload', async () => {
    repoMocks.createClientLeadWithOutbox.mockResolvedValueOnce(null);
    const app = await buildTestApp();
    const response = await app.inject({ method: 'POST', url: '/api/leads', headers: capabilityHeaders, payload: validLeadPayload() });
    await app.close();

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: 'clientLeadId already used with different payload' });
    expect(repoMocks.createClientLeadWithOutbox).toHaveBeenCalledTimes(1);
  });

  it('does not create a lead if the session becomes inactive before insertion', async () => {
    repoMocks.restoreSession
      .mockResolvedValueOnce({ id: sessionId, status: 'active' })
      .mockResolvedValueOnce(null);
    repoMocks.createClientLeadWithOutbox.mockResolvedValueOnce(null);
    const app = await buildTestApp();
    const response = await app.inject({ method: 'POST', url: '/api/leads', headers: capabilityHeaders, payload: validLeadPayload() });
    await app.close();

    expect(response.statusCode).toBe(404);
    expect(repoMocks.createClientLeadWithOutbox).toHaveBeenCalledTimes(1);
  });

  it('rejects missing, inactive, and malformed session-bound submissions', async () => {
    const app = await buildTestApp();
    const missingSession = await app.inject({
      method: 'POST',
      url: '/api/leads',
      headers: capabilityHeaders,
      payload: { ...validLeadPayload(), sessionId: undefined }
    });
    repoMocks.restoreSession.mockResolvedValueOnce(null);
    const inactiveSession = await app.inject({ method: 'POST', url: '/api/leads', headers: capabilityHeaders, payload: validLeadPayload() });
    const oversizedPhone = await app.inject({
      method: 'POST',
      url: '/api/leads',
      headers: capabilityHeaders,
      payload: { ...validLeadPayload(), phone: '1'.repeat(41) }
    });
    await app.close();

    expect(missingSession.statusCode).toBe(400);
    expect(inactiveSession.statusCode).toBe(404);
    expect(oversizedPhone.statusCode).toBe(400);
  });

  it('applies a lead-form-specific request limit', async () => {
    const app = await buildTestApp();
    const responses = [];
    for (let index = 0; index < 11; index += 1) {
      responses.push(await app.inject({
        method: 'POST',
        url: '/api/leads',
        headers: capabilityHeaders,
        payload: { ...validLeadPayload(), clientLeadId: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}` }
      }));
    }
    await app.close();

    expect(responses.slice(0, 10).every((response) => response.statusCode === 200)).toBe(true);
    expect(responses[10]?.statusCode).toBe(429);
  });

  it('rejects a missing or wrong visitor capability before creating a lead', async () => {
    const app = await buildTestApp();
    const missing = await app.inject({ method: 'POST', url: '/api/leads', payload: validLeadPayload() });
    const wrong = await app.inject({
      method: 'POST',
      url: '/api/leads',
      headers: { 'x-bakaut-visitor-id': 'wrong-capability' },
      payload: validLeadPayload()
    });
    await app.close();

    expect(missing.statusCode).toBe(404);
    expect(wrong.statusCode).toBe(404);
    expect(missing.json()).toEqual(wrong.json());
    expect(repoMocks.createClientLeadWithOutbox).not.toHaveBeenCalled();
  });
});


const { applyPlatformAvailability } = await import('../src/ai/platformAvailability.js');
const productId = '010dd344fdd5b592007941b3';
const turnId = '00000000-0000-4000-8000-000000000009';
const scope = { id: clientLeadId, state: 'offered' as const, question: 'Уточнить наличие DPU 6555', productIds: [productId] };
const priorMessages = [{ id: 'm', sessionId, role: 'assistant' as const, content: 'Можно оставить контакт',
  createdAt: '2026-11-12T12:00:00Z', metadata: { availabilityRequest: scope } }];
const decision = { action: 'offer', continueRequest: false, consentGranted: false, consentQuote: null,
  requestSummary: scope.question, productIds: [productId], preferredContact: null };

describe('platform availability local actions', () => {
  beforeEach(() => {
    repoMocks.createClientLeadWithOutbox.mockReset(); repoMocks.findClientLeadWithOutbox.mockReset();
    repoMocks.findClientLeadWithOutbox.mockResolvedValue(null);
    repoMocks.createClientLeadWithOutbox.mockResolvedValue(completedLeadCapture());
  });
  const input = () => ({ db: { query: vi.fn(async () => ({ rows: [] })) } as unknown as import('pg').PoolClient,
    sessionId, turnId, userMessage: 'Есть ли DPU 6555?', decision,
    priorMessages: [], knownProductIds: [productId] });
  it('offers a voluntary collapsed form without creating a lead', async () => {
    const result = await applyPlatformAvailability(input());
    expect(result).toMatchObject({ leadRequested: false, leadCreated: false,
      availabilityRequest: { id: turnId, state: 'offered', productIds: [productId] } });
    expect(result.availabilityReceipt).toEqual({ requestId: turnId, outcome: 'offered', warehouseChecked: false });
    expect(result).not.toHaveProperty('answer');
    expect(repoMocks.createClientLeadWithOutbox).not.toHaveBeenCalled();
  });
  it('opens the form for the semantic callback action without inspecting keywords', async () => {
    const result = await applyPlatformAvailability({ ...input(), userMessage: 'Сообщите мне результат',
      decision: { ...decision, action: 'request_contact', continueRequest: true }, priorMessages });
    expect(result).toMatchObject({ leadRequested: true, leadCreated: false, availabilityRequest: { id: clientLeadId, state: 'contact_requested' } });
    expect(result.availabilityReceipt?.outcome).toBe('contact_requested');
    expect(repoMocks.createClientLeadWithOutbox).not.toHaveBeenCalled();
  });
  it('does not capture a contact without grounded current-turn consent', async () => {
    const result = await applyPlatformAvailability({ ...input(), userMessage: '+7 900 000-10-03',
      decision: { ...decision, action: 'capture', consentGranted: true, consentQuote: 'я согласен' } });
    expect(result.leadCreated).toBe(false); expect(result.leadRequested).toBe(true);
    expect(result.availabilityReceipt?.outcome).toBe('consent_required');
    expect(repoMocks.createClientLeadWithOutbox).not.toHaveBeenCalled();
  });
  it('captures an actual current contact without requiring a name and keeps it out of metadata', async () => {
    const userMessage = 'Сообщите результат на +7 900 000-10-03';
    const result = await applyPlatformAvailability({ ...input(), userMessage, priorMessages,
      decision: { ...decision, action: 'capture', continueRequest: true, consentGranted: true, consentQuote: userMessage } });
    expect(result).toMatchObject({ leadCreated: true, leadRequested: false, availabilityRequest: { id: clientLeadId, state: 'queued' } });
    expect(repoMocks.createClientLeadWithOutbox).toHaveBeenCalledWith(expect.objectContaining({
      clientLeadId, skipPendingDraft: true, purpose: 'availability', source: 'platform_chat', question: scope.question }));
    expect(JSON.stringify(result.metadata)).not.toContain('900');
    expect(result.availabilityReceipt?.outcome).toBe('queued');
  });
  it('returns only a failed receipt when capture fails, without owning conversation text', async () => {
    repoMocks.createClientLeadWithOutbox.mockRejectedValue(new Error('do not expose this contact'));
    const current = input(); const userMessage = 'Позвоните на +7 900 000-10-03';
    const result = await applyPlatformAvailability({ ...current, userMessage, priorMessages,
      decision: { ...decision, action: 'capture', continueRequest: true, consentGranted: true, consentQuote: userMessage } });
    expect(result.leadCreated).toBe(false); expect(result.availabilityReceipt?.outcome).toBe('failed');
    expect(result).not.toHaveProperty('answer');
    expect(current.db.query).toHaveBeenCalledWith('ROLLBACK TO SAVEPOINT platform_availability_capture');
  });
  it('a declined request neither opens a form nor captures a supplied number', async () => {
    const result = await applyPlatformAvailability({ ...input(), userMessage: 'Не связывайтесь со мной +7 900 000-10-03', priorMessages,
      decision: { ...decision, action: 'decline', continueRequest: true } });
    expect(result).toMatchObject({ leadRequested: false, leadCreated: false, availabilityRequest: { state: 'declined' } });
    expect(result.availabilityReceipt?.outcome).toBe('declined');
    expect(repoMocks.createClientLeadWithOutbox).not.toHaveBeenCalled();
  });
  it('reuses an already durable same-request receipt instead of a second channel capture', async () => {
    repoMocks.findClientLeadWithOutbox.mockResolvedValue(completedLeadCapture());
    const userMessage = 'Напишите на test@example.org';
    const result = await applyPlatformAvailability({ ...input(), userMessage, priorMessages,
      decision: { ...decision, action: 'capture', continueRequest: true, consentGranted: true, consentQuote: userMessage } });
    expect(result.leadCreated).toBe(true); expect(result.availabilityReceipt?.outcome).toBe('already_queued');
    expect(repoMocks.createClientLeadWithOutbox).not.toHaveBeenCalled();
  });
  it('ordinary technical discussion does not trigger a request even if it contains a phone', async () => {
    const result = await applyPlatformAvailability({ ...input(), userMessage: 'В инструкции указан телефон +7 900 000-10-03',
      decision: { ...decision, action: 'none' } });
    expect(result.availabilityRequest).toBeUndefined(); expect(repoMocks.createClientLeadWithOutbox).not.toHaveBeenCalled();
    expect(result).not.toHaveProperty('answer'); expect(result.availabilityReceipt).toBeUndefined();
  });
  it('does not reuse a contact from history when the current reply only gives consent', async () => {
    const userMessage = 'Да, согласен';
    const result = await applyPlatformAvailability({ ...input(), userMessage,
      priorMessages: [...priorMessages, { ...priorMessages[0], role: 'user', content: 'Мой телефон +7 900 000-10-03', metadata: {} }],
      decision: { ...decision, action: 'capture', continueRequest: true, consentGranted: true, consentQuote: userMessage } });
    expect(result.leadCreated).toBe(false); expect(repoMocks.createClientLeadWithOutbox).not.toHaveBeenCalled();
  });
  it('keeps scope and request identity on a retry after an atomic capture failure', async () => {
    repoMocks.createClientLeadWithOutbox.mockRejectedValueOnce(new Error('private database failure'));
    const userMessage = 'Позвоните на +7 900 000-10-03';
    const capture = { ...input(), userMessage, priorMessages,
      decision: { ...decision, action: 'capture', continueRequest: true, consentGranted: true, consentQuote: userMessage } };
    const failed = await applyPlatformAvailability(capture);
    expect(failed.availabilityRequest?.state).toBe('failed');
    const retry = await applyPlatformAvailability({ ...capture,
      priorMessages: [...priorMessages, { ...priorMessages[0], metadata: failed.metadata }] });
    expect(retry).toMatchObject({ leadCreated: true, availabilityRequest: { id: clientLeadId, question: scope.question } });
    expect(repoMocks.createClientLeadWithOutbox.mock.calls.map(([payload]) => payload.clientLeadId)).toEqual([clientLeadId, clientLeadId]);
  });
  it('resolves a concurrent channel conflict through the same durable receipt', async () => {
    repoMocks.createClientLeadWithOutbox.mockResolvedValue(null);
    repoMocks.findClientLeadWithOutbox.mockResolvedValueOnce(null).mockResolvedValueOnce(completedLeadCapture());
    const userMessage = 'Напишите на test@example.org';
    const result = await applyPlatformAvailability({ ...input(), userMessage, priorMessages,
      decision: { ...decision, action: 'capture', continueRequest: true, consentGranted: true, consentQuote: userMessage } });
    expect(result.leadCreated).toBe(true); expect(repoMocks.createClientLeadWithOutbox).toHaveBeenCalledTimes(1);
  });
  it('never calls a saved lead successful without its durable outbox', async () => {
    const completion = completedLeadCapture(); completion.outbox.id = '';
    repoMocks.createClientLeadWithOutbox.mockResolvedValue(completion);
    const userMessage = 'Напишите на test@example.org';
    const result = await applyPlatformAvailability({ ...input(), userMessage, priorMessages,
      decision: { ...decision, action: 'capture', continueRequest: true, consentGranted: true, consentQuote: userMessage } });
    expect(result).toMatchObject({ leadCreated: false, availabilityRequest: { state: 'failed' } });
    expect(result.availabilityReceipt?.outcome).toBe('failed');
  });
  it('does not borrow request identity or private contacts from another session', async () => {
    const result = await applyPlatformAvailability({ ...input(), priorMessages: priorMessages.map(message => ({
      ...message, sessionId: '99999999-9999-4999-8999-999999999999' })),
      decision: { ...decision, continueRequest: true } });
    expect(result.availabilityRequest?.id).toBe(turnId);
    expect(repoMocks.createClientLeadWithOutbox).not.toHaveBeenCalled();
  });
  it('continues a stored availability scope after the active product selection changes', async () => {
    const otherProduct = 'bbbbbbbbbbbbbbbbbbbbbbbb';
    const userMessage = 'Сообщите всё-таки про DPU 6555 на buyer@example.org';
    const result = await applyPlatformAvailability({ ...input(), userMessage, priorMessages,
      knownProductIds: [otherProduct], decision: { ...decision, action: 'capture', continueRequest: true,
        productIds: [otherProduct], consentGranted: true, consentQuote: userMessage } });
    expect(result).toMatchObject({ leadCreated: true,
      availabilityRequest: { id: clientLeadId, question: scope.question, productIds: [productId] } });
    expect(repoMocks.createClientLeadWithOutbox).toHaveBeenCalledWith(expect.objectContaining({ clientLeadId, question: scope.question }));
  });
  it('redacts contacts from a new public scope and never stores the consent quote', async () => {
    const result = await applyPlatformAvailability({ ...input(), userMessage: 'Напишите на private@example.org +7 900 000-10-03',
      decision: { ...decision, requestSummary: 'K770 для private@example.org +7 900 000-10-03' } });
    expect(JSON.stringify(result.metadata)).not.toContain('private@example.org');
    expect(JSON.stringify(result.metadata)).not.toContain('900');
    expect(JSON.stringify(result.metadata)).not.toContain('consentQuote');
  });
  it('keeps technical numeric article codes in scope while removing reformatted contact details', async () => {
    const result = await applyPlatformAvailability({ ...input(), userMessage: 'Мой телефон +7 900 000-10-03',
      decision: { ...decision, requestSummary: 'Артикул 5100024696; контакт +79000001003' } });
    expect(result.availabilityRequest?.question).toContain('5100024696');
    expect(result.availabilityRequest?.question).not.toContain('79000001003');
  });
  it('allows a buyer to change their mind after declining and captures only fresh consent', async () => {
    const declinedMessages = [{ ...priorMessages[0], metadata: { availabilityRequest: { ...scope, state: 'declined' } } }];
    const reopened = await applyPlatformAvailability({ ...input(), priorMessages: declinedMessages,
      decision: { ...decision, action: 'request_contact', continueRequest: true } });
    expect(reopened).toMatchObject({ leadRequested: true, leadCreated: false,
      availabilityRequest: { id: clientLeadId, state: 'contact_requested' } });
    expect(repoMocks.createClientLeadWithOutbox).not.toHaveBeenCalled();
    const userMessage = 'Передумал, напишите на buyer@example.org';
    const captured = await applyPlatformAvailability({ ...input(), userMessage, priorMessages: declinedMessages,
      decision: { ...decision, action: 'capture', continueRequest: true, consentGranted: true, consentQuote: userMessage } });
    expect(captured).toMatchObject({ leadCreated: true, availabilityRequest: { id: clientLeadId, state: 'queued' } });
    expect(repoMocks.createClientLeadWithOutbox).toHaveBeenCalledTimes(1);
  });
  it('does not pretend a queued request has been cancelled', async () => {
    const queued = await applyPlatformAvailability({ ...input(), priorMessages: [{ ...priorMessages[0],
      metadata: { availabilityRequest: { ...scope, state: 'queued' } } }],
      decision: { ...decision, action: 'decline', continueRequest: true } });
    expect(queued.availabilityReceipt?.outcome).toBe('cancellation_not_confirmed');
    expect(queued).not.toHaveProperty('answer');
    expect(repoMocks.createClientLeadWithOutbox).not.toHaveBeenCalled();
  });
});

describe('availability request binding in the form', () => {
  let transactionQuery: ReturnType<typeof vi.fn<(sql: string) => Promise<{ rows: Array<{ id: string }> }>>>;
  let release: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    repoMocks.createClientLeadWithOutbox.mockReset(); repoMocks.findClientLeadWithOutbox.mockReset(); repoMocks.restoreSession.mockReset();
    repoMocks.listMessages.mockReset();
    repoMocks.getLatestUnansweredTurn.mockReset(); repoMocks.getLatestUnansweredTurn.mockResolvedValue(null);
    repoMocks.restoreSession.mockResolvedValue({ id: sessionId, status: 'active' });
    repoMocks.listMessages.mockResolvedValue(priorMessages); repoMocks.findClientLeadWithOutbox.mockResolvedValue(null);
    repoMocks.createClientLeadWithOutbox.mockResolvedValue(completedLeadCapture());
    transactionQuery = vi.fn(async (sql: string) => ({ rows: sql.includes('FOR UPDATE') ? [{ id: sessionId }] : [] }));
    release = vi.fn();
    vi.spyOn(pool, 'connect').mockResolvedValue({ query: transactionQuery, release } as never);
  });
  it('roundtrips a3000-code-point scope and meaningful tail into the authenticated form capture', async () => {
    const tail = ' DO NOT CALL; EMAIL ONLY';
    const question = 'A'.repeat(3000 - 600 - Array.from(tail).length) + '🛠'.repeat(600) + tail;
    const offered = await applyPlatformAvailability({ db: { query: transactionQuery } as never, sessionId, turnId: clientLeadId,
      userMessage: 'Уточните', priorMessages: [], knownProductIds: [productId],
      decision: { ...decision, requestSummary: question, preferredContact: 'message' } });
    const stored = JSON.parse(JSON.stringify(offered.metadata));
    const restored = normalizePublicHistoryMessages([{ role: 'assistant', content: 'Можно уточнить наличие.',
      availabilityRequest: stored.availabilityRequest, availabilityReceipt: stored.availabilityReceipt }])[0];
    expect(restored.availabilityRequest?.question).toBe(question);
    repoMocks.listMessages.mockResolvedValue([{ ...priorMessages[0], metadata: { availabilityRequest: restored.availabilityRequest } }]);
    const app = await buildTestApp();
    try {
      const response = await app.inject({ method: 'POST', url: '/api/leads', headers: capabilityHeaders,
        payload: { ...validLeadPayload(), availabilityRequestId: clientLeadId, question } });
      expect(response.statusCode).toBe(200);
      expect(response.json().availabilityReceipt?.outcome).toBe('queued');
      expect(repoMocks.createClientLeadWithOutbox).toHaveBeenCalledWith(expect.objectContaining({
        question, preferredContact: 'message', clientLeadId }));
      expect(repoMocks.createClientLeadWithOutbox.mock.calls[0][0].question.endsWith(tail)).toBe(true);
    } finally { await app.close(); }
  });
  it('takes multiple product IDs only from the server scope for form capture', async () => {
    const productIds = [productId, 'b'.repeat(24)];
    const sourceId = '00000000-0000-4000-8000-000000000017';
    const source = { ...priorMessages[0], id: sourceId, createdAt: '2026-11-12T11:59:00Z', metadata: {
      runtimeMode: 'openai_responses_saved_agent', catalogRevision: 'saved-v1',
      knownProducts: { source_revision: 'saved-v1', product_ids: productIds },
      productCards: [{ id: productIds[0], name: 'Историческая модель 🛠', sourceUrl: 'https://bakautprof.ru/catalog/vibroplity/saved/' }] } };
    repoMocks.listMessages.mockResolvedValue([source, { ...priorMessages[0], metadata: {
      availabilityRequest: { ...scope, question: 'Check availability of these two models', productIds } } },
      { ...source, id: '00000000-0000-4000-8000-000000000018', createdAt: '2026-11-12T12:01:00Z',
        metadata: { ...source.metadata, productCards: [{ id: productIds[0], name: 'Changed after offer', sourceUrl: 'https://bakautprof.ru/catalog/new/' }] } }]);
    const app = await buildTestApp();
    try {
      const response = await app.inject({ method: 'POST', url: '/api/leads', headers: capabilityHeaders,
        payload: { ...validLeadPayload(), availabilityRequestId: clientLeadId, question: 'Untrusted free text' } });
      expect(response.statusCode).toBe(200);
      expect(repoMocks.createClientLeadWithOutbox).toHaveBeenCalledWith(expect.objectContaining({
        productIds, question: 'Check availability of these two models', purpose: 'availability', productReferences: [
          { productId: productIds[0], status: 'saved_card', name: 'Историческая модель 🛠', sourceUrl: 'https://bakautprof.ru/catalog/vibroplity/saved/',
            sourceMessageId: sourceId, catalogRevision: 'saved-v1' },
          { productId: productIds[1], status: 'unavailable', reason: 'missing_card' }
        ] }));
    } finally { await app.close(); }
  });
  it('rejects client product-ID injection and malformed stored scopes without creating a lead', async () => {
    const app = await buildTestApp();
    try {
      const injected = await app.inject({ method: 'POST', url: '/api/leads', headers: capabilityHeaders,
        payload: { ...validLeadPayload(), availabilityRequestId: clientLeadId, productIds: ['b'.repeat(24)] } });
      expect(injected.statusCode).toBe(400);
      const injectedReference = await app.inject({ method: 'POST', url: '/api/leads', headers: capabilityHeaders,
        payload: { ...validLeadPayload(), availabilityRequestId: clientLeadId,
          productReferences: [{ productId, name: 'Client invention', sourceUrl: 'https://evil.example/' }] } });
      expect(injectedReference.statusCode).toBe(400);
      repoMocks.listMessages.mockResolvedValue([{ ...priorMessages[0], metadata: {
        availabilityRequest: { ...scope, productIds: ['not-a-catalog-id'] } } }]);
      const invalid = await app.inject({ method: 'POST', url: '/api/leads', headers: capabilityHeaders,
        payload: { ...validLeadPayload(), availabilityRequestId: clientLeadId } });
      expect(invalid.statusCode).toBe(409); expect(repoMocks.createClientLeadWithOutbox).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });
  it('uses server-stored scope and the same request ID for the form', async () => {
    const app = await buildTestApp();
    const response = await app.inject({ method: 'POST', url: '/api/leads', headers: capabilityHeaders,
      payload: { ...validLeadPayload(), availabilityRequestId: clientLeadId, question: 'untrusted different product' } });
    await app.close(); expect(response.statusCode).toBe(200);
    expect(repoMocks.createClientLeadWithOutbox).toHaveBeenCalledWith(expect.objectContaining({
      clientLeadId, question: scope.question, skipPendingDraft: true, purpose: 'availability' }));
  });
  it('rejects a cancelled or stale request rather than consuming another pending draft', async () => {
    repoMocks.listMessages.mockResolvedValue([{ ...priorMessages[0], metadata: { availabilityRequest: { ...scope, state: 'declined' } } }]);
    const app = await buildTestApp(); const response = await app.inject({ method: 'POST', url: '/api/leads', headers: capabilityHeaders,
      payload: { ...validLeadPayload(), availabilityRequestId: clientLeadId } });
    await app.close(); expect(response.statusCode).toBe(409); expect(repoMocks.createClientLeadWithOutbox).not.toHaveBeenCalled();
  });
  it('returns the same queued receipt when chat capture won the race', async () => {
    repoMocks.findClientLeadWithOutbox.mockResolvedValue(completedLeadCapture());
    const app = await buildTestApp(); const response = await app.inject({ method: 'POST', url: '/api/leads', headers: capabilityHeaders,
      payload: { ...validLeadPayload(), availabilityRequestId: clientLeadId } });
    await app.close(); expect(response.statusCode).toBe(200); expect(repoMocks.createClientLeadWithOutbox).not.toHaveBeenCalled();
  });
  it('refuses a request belonging to another conversation without reading its scope', async () => {
    repoMocks.restoreSession.mockResolvedValue(null);
    const app = await buildTestApp(); const response = await app.inject({ method: 'POST', url: '/api/leads', headers: capabilityHeaders,
      payload: { ...validLeadPayload(), availabilityRequestId: clientLeadId } });
    await app.close(); expect(response.statusCode).toBe(404); expect(repoMocks.createClientLeadWithOutbox).not.toHaveBeenCalled();
  });
  it.each(['declined', 'changed'] as const)('reads a concurrent %s decision only after acquiring the session lock', async change => {
    let unlock: ((value: { rows: Array<{ id: string }> }) => void) | undefined;
    transactionQuery.mockImplementation(async sql => sql.includes('FOR UPDATE')
      ? new Promise(resolve => { unlock = resolve; }) : { rows: [] });
    const app = await buildTestApp();
    const pending = app.inject({ method: 'POST', url: '/api/leads', headers: capabilityHeaders,
      payload: { ...validLeadPayload(), availabilityRequestId: clientLeadId } }).then(response => response);
    await vi.waitFor(() => expect(unlock).toBeTypeOf('function'));
    expect(repoMocks.getLatestUnansweredTurn).not.toHaveBeenCalled();
    expect(repoMocks.listMessages).not.toHaveBeenCalled();
    expect(repoMocks.createClientLeadWithOutbox).not.toHaveBeenCalled();
    repoMocks.listMessages.mockResolvedValue([{ ...priorMessages[0], metadata: { availabilityRequest: {
      ...scope, ...(change === 'declined' ? { state: 'declined' } : { id: turnId, question: 'Теперь другой товар' }) } } }]);
    unlock?.({ rows: [{ id: sessionId }] });
    const response = await pending;
    await app.close();
    expect(response.statusCode).toBe(409);
    expect(repoMocks.createClientLeadWithOutbox).not.toHaveBeenCalled();
    expect(transactionQuery).toHaveBeenCalledWith('ROLLBACK');
    expect(transactionQuery).not.toHaveBeenCalledWith('COMMIT');
    expect(release).toHaveBeenCalledOnce();
  });
  it('locks, reads fresh scope, captures, and commits before reporting queued', async () => {
    const events: string[] = [];
    let finishCommit: ((value: { rows: Array<{ id: string }> }) => void) | undefined;
    transactionQuery.mockImplementation(async sql => {
      events.push(sql.includes('FOR UPDATE') ? 'lock' : sql);
      if (sql === 'COMMIT') return new Promise(resolve => { finishCommit = resolve; });
      return { rows: sql.includes('FOR UPDATE') ? [{ id: sessionId }] : [] };
    });
    repoMocks.listMessages.mockImplementation(async () => { events.push('fresh scope'); return priorMessages; });
    repoMocks.getLatestUnansweredTurn.mockImplementation(async () => { events.push('fresh turn'); return null; });
    repoMocks.createClientLeadWithOutbox.mockImplementation(async () => { events.push('capture'); return completedLeadCapture(); });
    const app = await buildTestApp();
    let answered = false;
    const pending = app.inject({ method: 'POST', url: '/api/leads', headers: capabilityHeaders,
      payload: { ...validLeadPayload(), availabilityRequestId: clientLeadId } }).then(response => { answered = true; return response; });
    await vi.waitFor(() => expect(finishCommit).toBeTypeOf('function'));
    expect(events).toEqual(['BEGIN', 'lock', 'fresh turn', 'fresh scope', 'capture', 'COMMIT']);
    expect(answered).toBe(false);
    finishCommit?.({ rows: [] });
    const response = await pending;
    await app.close();
    expect(response.statusCode).toBe(200); expect(response.json().status).toBe('queued');
    expect(release).toHaveBeenCalledOnce();
  });
  it('rolls back a commit failure and never returns a false success', async () => {
    transactionQuery.mockImplementation(async sql => {
      if (sql === 'COMMIT') throw new Error('private database contact details');
      return { rows: sql.includes('FOR UPDATE') ? [{ id: sessionId }] : [] };
    });
    const app = await buildTestApp(); const response = await app.inject({ method: 'POST', url: '/api/leads', headers: capabilityHeaders,
      payload: { ...validLeadPayload(), availabilityRequestId: clientLeadId } });
    await app.close(); expect(response.statusCode).toBe(503); expect(response.json().ok).toBe(false);
    expect(transactionQuery).toHaveBeenCalledWith('ROLLBACK'); expect(release).toHaveBeenCalledOnce();
    expect(response.body).not.toContain('private database');
  });
  it('refuses a session closed before the lock without reading scope or capturing a lead', async () => {
    transactionQuery.mockResolvedValue({ rows: [] });
    const app = await buildTestApp(); const response = await app.inject({ method: 'POST', url: '/api/leads', headers: capabilityHeaders,
      payload: { ...validLeadPayload(), availabilityRequestId: clientLeadId } });
    await app.close(); expect(response.statusCode).toBe(404);
    expect(repoMocks.listMessages).not.toHaveBeenCalled(); expect(repoMocks.createClientLeadWithOutbox).not.toHaveBeenCalled();
    expect(transactionQuery).toHaveBeenCalledWith('ROLLBACK'); expect(release).toHaveBeenCalledOnce();
  });
  it.each(['received', 'need_extracted', 'planned', 'answering'])('defers capture while a newer %s turn awaits its semantic decision', async status => {
    repoMocks.getLatestUnansweredTurn.mockResolvedValue({ turn: { id: turnId, status }, resultReady: false });
    const app = await buildTestApp(); const response = await app.inject({ method: 'POST', url: '/api/leads', headers: capabilityHeaders,
      payload: { ...validLeadPayload(), availabilityRequestId: clientLeadId } });
    await app.close(); expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: 'availability_decision_pending', retryable: true });
    expect(repoMocks.getLatestUnansweredTurn).toHaveBeenCalledWith(sessionId);
    expect(repoMocks.listMessages).not.toHaveBeenCalled(); expect(repoMocks.createClientLeadWithOutbox).not.toHaveBeenCalled();
    expect(transactionQuery).toHaveBeenCalledWith('ROLLBACK'); expect(transactionQuery).not.toHaveBeenCalledWith('COMMIT');
  });
  it('keeps the durable form receipt through history restoration and a later contact in chat without duplication', async () => {
    let savedScope: { id: string; state: string; question: string; productIds: string[] } = { ...scope };
    repoMocks.listMessages.mockImplementation(async () => [{ ...priorMessages[0], metadata: { availabilityRequest: savedScope } }]);
    repoMocks.createClientLeadWithOutbox.mockImplementation(async () => {
      savedScope = { ...savedScope, state: 'queued' }; return completedLeadCapture();
    });
    const app = await buildTestApp(); const response = await app.inject({ method: 'POST', url: '/api/leads', headers: capabilityHeaders,
      payload: { ...validLeadPayload(), availabilityRequestId: clientLeadId } });
    await app.close(); expect(response.statusCode).toBe(200);
    const restored = normalizePublicHistoryMessages([{ role: 'assistant', content: 'Заявка сохранена', availabilityRequest: savedScope }]);
    expect(restored[0].availabilityRequest?.state).toBe('queued');
    const userMessage = 'Продублирую, напишите на buyer@example.org';
    const result = await applyPlatformAvailability({ db: { query: vi.fn() } as never, sessionId, turnId, userMessage,
      priorMessages: [{ ...priorMessages[0], metadata: { availabilityRequest: restored[0].availabilityRequest } }],
      decision: { ...decision, action: 'capture', continueRequest: true, consentGranted: true, consentQuote: userMessage } });
    expect(result.leadCreated).toBe(true); expect(result.availabilityReceipt?.outcome).toBe('already_queued');
    expect(repoMocks.createClientLeadWithOutbox).toHaveBeenCalledTimes(1);
  });
});
