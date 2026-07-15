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
    restoreEnv();
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
