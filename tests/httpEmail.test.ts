import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConversationSession, Lead, Message } from '../src/shared/types.js';

const originalEnv = { ...process.env };
const emailEnvKeys = [
  'EMAIL_HTTP_URL',
  'EMAIL_HTTP_METHOD',
  'EMAIL_HTTP_AUTH_HEADER',
  'EMAIL_HTTP_TIMEOUT_MS',
  'EMAIL_FROM',
  'LEADS_TO_EMAIL',
  'RESEND_API_KEY',
  'RESEND_FROM',
  'RESEND_TIMEOUT_MS',
  'LEAD_EMAIL_TO',
  'LEAD_EMAIL'
];

function restoreEnv() {
  for (const key of Object.keys(process.env)) {
    delete process.env[key];
  }
  Object.assign(process.env, originalEnv);
}

function clearEmailEnv() {
  for (const key of emailEnvKeys) {
    process.env[key] = '';
  }
}

function lead(overrides: Partial<Lead> = {}): Lead {
  return {
    id: 'lead-1',
    sessionId: null,
    name: 'Иван',
    phone: '+7 900 000-00-00',
    email: null,
    question: [
      'Контакт оставлен покупателем прямо в чате.',
      'Последняя реплика: Меня зовут Иван, телефон +7 900 000-00-00.',
      'Сводка потребности: нужен бензиновый генератор для дачи, бюджет до 80 тыс.',
      'Показанные/выбранные позиции: SUMEC SU4500i - 79 000 ₽',
      '',
      'Последние сообщения   :',
      'user: старая простыня из истории'
    ].join('\n'),
    status: 'pending_email',
    createdAt: '2026-05-05T10:00:00.000Z',
    ...overrides
  };
}

function session(): ConversationSession {
  return {
    id: 'session-1',
    status: 'active',
    conversationNumber: 42,
    topic: 'Подбор генератора',
    title: 'Диалог #42: генератор для дачи',
    visitorId: null,
    pageUrl: 'http://localhost:5173/catalog/generators',
    userAgent: null,
    needState: {},
    historySummary: null,
    createdAt: '2026-05-05T09:50:00.000Z',
    updatedAt: '2026-05-05T10:00:00.000Z',
    lastHeartbeatAt: '2026-05-05T10:00:00.000Z',
    closedAt: null
  } as ConversationSession;
}

function messages(): Message[] {
  return [
    {
      id: 'message-1',
      sessionId: 'session-1',
      role: 'user',
      content: 'Нужен бензиновый генератор для дачи до 80 тысяч.',
      metadata: {},
      createdAt: '2026-05-05T09:51:00.000Z'
    },
    {
      id: 'message-2',
      sessionId: 'session-1',
      role: 'assistant',
      content: 'Подойдет модель около 4 кВт с запасом под насос.',
      metadata: {},
      createdAt: '2026-05-05T09:52:00.000Z'
    }
  ];
}

describe('sendLeadEmail', () => {
  afterEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    restoreEnv();
  });

  it.each([
    ['https://api.resend.com/emails', 'ascii'], ['https://api.resend.com/emails', 'unicode'],
    ['https://mail-gateway.example.test/send', 'ascii'], ['https://mail-gateway.example.test/send', 'unicode']
  ])('keeps the full agreed %s question in visible email text (%s) without sending', async (url, style) => {
    const blocked = vi.fn(async () => { throw new Error('Network forbidden in formatter regression'); });
    vi.stubGlobal('fetch', blocked); vi.doMock('undici', () => ({ fetch: blocked }));
    clearEmailEnv(); Object.assign(process.env, { EMAIL_HTTP_URL: url, EMAIL_HTTP_METHOD: 'POST',
      EMAIL_FROM: 'fixture@example.org', LEADS_TO_EMAIL: 'manager@example.org' });
    const tail = 'CRITICAL: NOT FOR INDOOR USE; EXHAUST MUST STAY OUTSIDE';
    const question = style === 'ascii' ? 'Context '.repeat(140) + tail
      : 'A'.repeat(1800) + '🛠'.repeat(600) + '\nDO NOT CALL; EMAIL ONLY; ' + tail;
    const historyCanary = 'PRIVATE_UNRELATED_HISTORY_CANARY';
    const { prepareLeadEmailRequest } = await import('../src/email/httpEmail.js');
    const snapshot = prepareLeadEmailRequest(lead({ question }), { session: session(),
      messages: [...messages(), { ...messages()[0], content: 'Old context '.repeat(100) + historyCanary }],
      handoff: { buyerQuestion: question, preferredContact: 'message', purpose: 'Уточнение задачи' } });
    expect('version' in snapshot).toBe(true); if (!('version' in snapshot)) throw new Error('Missing local snapshot');
    const wire = JSON.parse(snapshot.body);
    expect(wire.text).toContain(`Исходный вопрос покупателя: ${question}`);
    expect(wire.text).toContain(tail); expect(wire.text).not.toContain(historyCanary);
    expect(wire.text).toContain('SUMMARY:'); expect(wire.text).toContain('Предпочтительный способ связи: написать');
    if (snapshot.provider === 'resend') expect(Object.keys(wire).sort()).toEqual(['from', 'subject', 'text', 'to']);
    expect(blocked).not.toHaveBeenCalled();
  });

  it('preserves full outbox scope in the real wire snapshot and reuses its bytes on retry', async () => {
    const blocked = vi.fn(async () => { throw new Error('External network and SQL forbidden'); });
    vi.stubGlobal('fetch', blocked);
    vi.doMock('../src/db/pool.js', () => ({ pool: { query: blocked, connect: blocked } }));
    let attempts = 0;
    const fetchMock = vi.fn(async (_url: string, _request: RequestInit) => {
      if (++attempts === 1) throw new Error('Offline first delivery interrupted');
      return Response.json({ id: 'offline-provider-id' });
    });
    vi.doMock('undici', () => ({ fetch: fetchMock }));
    clearEmailEnv(); Object.assign(process.env, { EMAIL_HTTP_URL: 'https://api.resend.com/emails', EMAIL_HTTP_METHOD: 'POST',
      EMAIL_FROM: 'fixture@example.org', LEADS_TO_EMAIL: 'manager@example.org' });
    const { processLeadOutboxItem } = await import('../src/ai/leadOutbox.js');
    const question = 'A'.repeat(1800) + '🛠'.repeat(600) + '\nCRITICAL: NOT FOR INDOOR USE; EXHAUST MUST STAY OUTSIDE; EMAIL ONLY';
    const productIds = ['a'.repeat(24), 'b'.repeat(24)];
    let saved: import('../src/email/httpEmail.js').LeadEmailRequestSnapshot | undefined;
    const conversations = { getSession: vi.fn(async () => session()), listMessages: vi.fn(async () => messages()) };
    const leads = {
      getLead: vi.fn(async () => lead({ question })),
      prepareLeadOutboxDispatch: vi.fn(async (input: { snapshot: import('../src/email/httpEmail.js').LeadEmailRequestSnapshot }) => {
        saved ??= structuredClone(input.snapshot); return { requestSnapshot: structuredClone(saved) };
      }),
      markLeadOutboxFailed: vi.fn(async () => ({ id: 'outbox' })), markLeadOutboxSent: vi.fn(async () => ({ id: 'outbox' }))
    };
    const item = { id: 'outbox', leadId: 'lead-1', sessionId: 'session-1', turnId: 'turn-1', destination: 'lead_email',
      payload: { question, productIds, purpose: 'availability', preferredContact: 'message' }, status: 'sending', attemptCount: 1, leaseToken: 'lease-1',
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    const run = (current: unknown) => processLeadOutboxItem({ item: current as never, conversations: conversations as never, leads: leads as never });
    expect(await run(item)).toMatchObject({ ok: false, committed: true });
    expect(saved).toBeDefined();
    const original = structuredClone(saved!);
    expect(original.productIds).toEqual(productIds);
    expect(JSON.parse(original.body).text).toContain(`Исходный вопрос покупателя: ${question}`);
    expect(JSON.parse(original.body).text).toContain(`Товары заявки (ID каталога):\n- ${productIds[0]}\n- ${productIds[1]}`);
    expect(Object.keys(JSON.parse(original.body)).sort()).toEqual(['from', 'subject', 'text', 'to']);
    expect(leads.prepareLeadOutboxDispatch.mock.invocationCallOrder[0]).toBeLessThan(fetchMock.mock.invocationCallOrder[0]);
    const { config } = await import('../src/config.js'); config.EMAIL_FROM = 'changed@example.org';
    leads.getLead.mockResolvedValue(lead({ question: 'Changed lead must not rebuild the snapshot' }));
    conversations.listMessages.mockResolvedValue([{ ...messages()[0], content: 'Changed history' }]);
    expect(await run({ ...item, attemptCount: 2, firstAttemptAt: new Date().toISOString(), leaseToken: 'lease-2',
      requestSnapshot: structuredClone(original), payload: { question: 'Changed payload', productIds: ['not-a-catalog-id'] } })).toEqual({ ok: true });
    expect(saved).toEqual(original);
    expect(leads.getLead).toHaveBeenCalledTimes(1); expect(conversations.listMessages).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [, request] of fetchMock.mock.calls) {
      expect(request.body).toBe(original.body);
      expect(request.headers).toMatchObject({ 'Idempotency-Key': original.idempotencyKey });
    }
    expect(blocked).not.toHaveBeenCalled();
  });
  it('treats an empty EMAIL_HTTP_URL as not configured', async () => {
    const fetchMock = vi.fn();
    vi.doMock('undici', () => ({ fetch: fetchMock }));
    clearEmailEnv();

    const { sendLeadEmail } = await import('../src/email/httpEmail.js');
    const result = await sendLeadEmail(lead());

    expect(result).toMatchObject({
      ok: false,
      skipped: true,
      error: 'EMAIL_HTTP_URL is not configured'
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('posts Resend-compatible lead email with contact data and short SUMMARY first', async () => {
    const fetchMock = vi.fn(async (_url: string, _request: RequestInit & { body: string }) =>
      new Response(JSON.stringify({ id: 'resend-message-1' }), { status: 200 })
    );
    vi.doMock('undici', () => ({ fetch: fetchMock }));
    clearEmailEnv();
    process.env.EMAIL_HTTP_URL = 'https://api.resend.com/emails///';
    process.env.EMAIL_HTTP_METHOD = 'POST';
    process.env.EMAIL_HTTP_AUTH_HEADER = 'Authorization: Bearer test-token';
    process.env.EMAIL_FROM = 'Bakaut <orp5@bakaut.biz>';
    process.env.LEADS_TO_EMAIL = 'orp5@bakaut.biz';

    const { sendLeadEmail } = await import('../src/email/httpEmail.js');
    const result = await sendLeadEmail(lead(), {
      session: session(),
      messages: messages(),
      handoff: {
        purpose: 'Уточнить совместимость генератора с насосом',
        buyerQuestion: 'Подойдет ли этот генератор для насоса?',
        preferredContact: 'message'
      }
    });

    expect(result).toMatchObject({ ok: true, status: 200 });
    expect(fetchMock).toHaveBeenCalledWith('https://api.resend.com/emails///', expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({
        'content-type': 'application/json',
        'Idempotency-Key': 'bakaut-lead-lead-1',
        Authorization: 'Bearer test-token'
      })
    }));
    const request = fetchMock.mock.calls[0]?.[1];
    expect(request).toBeDefined();
    const body = JSON.parse(request!.body);
    expect(body).toEqual({
      from: 'Bakaut <orp5@bakaut.biz>',
      to: ['orp5@bakaut.biz'],
      subject: 'Новый лид из AI-чата: Иван, +7 900 000-00-00',
      text: expect.any(String)
    });
    expect(body.text).toContain('Контакт:\nИмя: Иван\nТелефон: +7 900 000-00-00\nEmail: не указан');
    expect(body.text).toContain('Предпочтительный способ связи: написать');
    expect(body.text).toContain('Цель обращения: Уточнить совместимость генератора с насосом');
    expect(body.text).toContain('Исходный вопрос покупателя: Подойдет ли этот генератор для насоса?');
    expect(body.text).toContain('SUMMARY:');
    expect(body.text).toContain('Сводка потребности: нужен бензиновый генератор для дачи, бюджет до 80 тыс.');
    expect(body.text).toContain('Показанные/выбранные позиции: SUMEC SU4500i - 79 000 ₽');
    expect(body.text).toContain('Номер диалога: 42');
    expect(body.text).toContain('Короткий контекст диалога:');
    expect(body.text).not.toContain('старая простыня из истории');
    expect(body.text.indexOf('Телефон:')).toBeLessThan(body.text.indexOf('SUMMARY:'));
    expect(body.lead).toBeUndefined();
    expect(body.messages).toBeUndefined();
  });

  it('renders the call preference and original pending-draft question from a public form outbox', async () => {
    const fetchMock = vi.fn(async (_url: string, _request: RequestInit & { body: string }) =>
      new Response(JSON.stringify({ id: 'resend-message-call' }), { status: 200 })
    );
    vi.doMock('undici', () => ({ fetch: fetchMock }));
    clearEmailEnv();
    process.env.EMAIL_HTTP_URL = 'https://api.resend.com/emails';
    process.env.EMAIL_FROM = 'Bakaut <orp5@bakaut.biz>';
    process.env.LEADS_TO_EMAIL = 'orp5@bakaut.biz';

    const { sendLeadEmail } = await import('../src/email/httpEmail.js');
    await sendLeadEmail(lead(), {
      handoff: {
        purpose: 'Уточнить толщину уплотняемого слоя',
        buyerQuestion: 'Подойдёт ли эта виброплита для слоя щебня 30 см?',
        preferredContact: 'call'
      }
    });

    const request = fetchMock.mock.calls[0]?.[1];
    expect(request).toBeDefined();
    const body = JSON.parse(request!.body);
    expect(body.text).toContain('Предпочтительный способ связи: позвонить');
    expect(body.text).toContain('Цель обращения: Уточнить толщину уплотняемого слоя');
    expect(body.text).toContain('Исходный вопрос покупателя: Подойдёт ли эта виброплита для слоя щебня 30 см?');
  });

  it('supports legacy Railway Resend variables from the previous deployment', async () => {
    const fetchMock = vi.fn(async (_url: string, _request: RequestInit & { body: string }) =>
      new Response(JSON.stringify({ id: 'resend-message-2' }), { status: 200 })
    );
    vi.doMock('undici', () => ({ fetch: fetchMock }));
    clearEmailEnv();
    process.env.RESEND_API_KEY = 're_test_key';
    process.env.RESEND_FROM = 'Bakaut <orp5@bakaut.biz>';
    process.env.LEAD_EMAIL_TO = 'orp5@bakaut.biz';

    const { sendLeadEmail } = await import('../src/email/httpEmail.js');
    const result = await sendLeadEmail(lead());

    expect(result).toMatchObject({ ok: true, status: 200 });
    expect(fetchMock).toHaveBeenCalledWith('https://api.resend.com/emails', expect.objectContaining({
      headers: expect.objectContaining({
        Authorization: 'Bearer re_test_key'
      })
    }));
  });
});
