// @vitest-environment jsdom
import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { Root } from 'react-dom/client';
import type { AvailabilityReceipt } from '../src/shared/types.js';
import followup from './fixtures/live_eval_followup_20261113.json';
import originals from './fixtures/dpu6555-local-originals.json';

const mounted = vi.hoisted(() => ({ element: null as unknown }));
vi.mock('react-dom/client', () => ({ createRoot: () => ({ render: (element: unknown) => { mounted.element = element; } }) }));
import '../src/client/main';

let root: Root;
let heartbeat: () => Promise<void>;
let heartbeatStatus: number;
let fetcher: Mock<(url: string, options?: RequestInit) => Promise<Response>>;
const oldId = '11111111-1111-4111-8111-111111111111';
const history = [
  { id: 'u1', role: 'user', content: 'Нужны аксессуары к выбранной плите', createdAt: '2026-09-08T12:00:00Z' },
  { id: 'a1', role: 'assistant', content: 'Обсуждаем выбранную плиту.', createdAt: '2026-09-08T12:00:01Z' }
];

beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  document.body.innerHTML = '<div id="root"></div>';
  localStorage.clear(); sessionStorage.clear();
  localStorage.setItem('bakaut_visitor_id', 'visitor-capability');
  sessionStorage.setItem('bakaut_session_id', oldId);
  heartbeatStatus = 200;
  vi.spyOn(window, 'setInterval').mockImplementation((callback) => {
    heartbeat = callback as () => Promise<void>;
    return 1 as unknown as ReturnType<typeof window.setInterval>;
  });
  Element.prototype.scrollIntoView = vi.fn();
  fetcher = vi.fn(async (url: string) => {
    if (url.endsWith('/heartbeat')) return new Response(null, { status: heartbeatStatus });
    if (url.endsWith('/messages')) return Response.json({ historyComplete: true, messages: history });
    throw new Error(`Unexpected request: ${url}`);
  });
  vi.stubGlobal('fetch', fetcher);
  const actual = await vi.importActual<typeof import('react-dom/client')>('react-dom/client');
  root = actual.createRoot(document.getElementById('root')!);
  await act(async () => root.render(mounted.element as React.ReactNode));
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});

async function draft(text: string) {
  const field = document.querySelector('textarea')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(field, text);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
  return field;
}

const availabilityId = '33333333-3333-4333-8333-333333333333';
const queuedReceipt = { requestId: availabilityId, outcome: 'queued', warehouseChecked: false };
const technicalReply = 'Модель A легче модели B. Наличие нужно уточнить на складе.';
async function restoreAvailability(state: 'offered' | 'contact_requested' | 'queued' | 'declined' | 'failed', outcome: AvailabilityReceipt['outcome'] = state) {
  await act(async () => root.unmount());
  fetcher.mockImplementation(async (url: string) => url.endsWith('/messages')
    ? Response.json({ historyComplete: true, messages: [{ id: 'availability-answer', role: 'assistant', content: technicalReply,
      availabilityRequest: { id: availabilityId, state, question: 'Уточнить наличие K770', productIds: [] },
      availabilityReceipt: { requestId: availabilityId, outcome, warehouseChecked: false } }] })
    : new Response(null, { status: 200 }));
  const actual = await vi.importActual<typeof import('react-dom/client')>('react-dom/client');
  root = actual.createRoot(document.getElementById('root')!);
  await act(async () => root.render(mounted.element as React.ReactNode));
}

async function contactValue(value: string) {
  const field = document.querySelector('input[aria-label="Телефон"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('rendered widget session boundary', () => {
  function deliveryFixture(initialVisibility: DocumentVisibilityState = 'visible') {
    let visibility = initialVisibility; let clock = 1000; let nextId = 0;
    const frames = new Map<number, FrameRequestCallback>();
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
    vi.spyOn(performance, 'now').mockImplementation(() => clock);
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++nextId, callback); return nextId; });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
    fetcher.mockImplementation(async (url: string, options?: RequestInit) => {
      if (url.endsWith('/messages') && options?.method === 'POST') {
        return new Response('event: done\ndata: {"answer":"Готовый ответ","assistantMessageId":"saved-answer"}\n\n');
      }
      return new Response(null, { status: 200 });
    });
    return {
      frames,
      visible(value: DocumentVisibilityState) { visibility = value; document.dispatchEvent(new Event('visibilitychange')); },
      clock(value: number) { clock = value; },
      frame() { const [id, callback] = frames.entries().next().value!; frames.delete(id); callback(clock); },
      posts: () => fetcher.mock.calls.filter(([url]) => url.endsWith('/delivery'))
    };
  }

  it('reports the finished visible answer after hiding between frames without new stream events', async () => {
    const metric = deliveryFixture();
    await draft('Ответьте');
    await act(async () => document.querySelector('form.composer')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    expect(document.body.textContent).toContain('Готовый ответ');
    metric.frame(); metric.visible('hidden'); expect(metric.frames.size).toBe(0); expect(metric.posts()).toHaveLength(0);
    metric.clock(2500); metric.visible('visible'); expect(metric.frames.size).toBe(1);
    await act(async () => { metric.frame(); metric.frame(); });
    expect(metric.posts()).toHaveLength(1);
    expect(JSON.parse(String(metric.posts()[0][1]?.body))).toEqual({ firstUsefulContentMs: 1500 });
    metric.visible('hidden'); metric.visible('visible');
    expect(metric.frames.size).toBe(0); expect(metric.posts()).toHaveLength(1);
  });

  it.each(['unmount', 'new-chat'] as const)('disposes a finished hidden answer on %s', async mode => {
    const metric = deliveryFixture('hidden');
    await draft('Ответьте');
    await act(async () => document.querySelector('form.composer')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    expect(document.body.textContent).toContain('Готовый ответ'); expect(metric.frames.size).toBe(0);
    await act(async () => {
      if (mode === 'unmount') root.unmount();
      else (document.querySelector('.new-chat-button') as HTMLButtonElement).click();
    });
    metric.visible('visible');
    expect(metric.frames.size).toBe(0); expect(metric.posts()).toHaveLength(0);
  });

  it.each(['fresh', 'replay'] as const)('shows mixed cards in separate groups for a %s answer', async (mode) => {
    const cards = [
      { id: 'confirmed', name: 'Подтверждённый', price: 100, specs: {}, reasons: [], caveats: [] },
      { id: 'order', name: 'Под заказ', priceOnRequest: true, specs: {}, reasons: [], caveats: [] },
      { id: 'uncertain', name: 'Возможный', matchStatus: 'uncertain', specs: {}, reasons: [], caveats: [] }
    ];
    const result = { answer: 'Результаты', productCards: cards };
    if (mode === 'replay') {
      await act(async () => root.unmount());
      fetcher.mockImplementation(async (url: string) => {
        if (url.includes('/events?')) return Response.json({ events: [], result });
        if (url.endsWith('/messages')) return Response.json({ historyComplete: true, messages: history,
          pendingTurn: { turnId: 'turn-1', status: 'completed', resultState: 'ready' } });
        return new Response(null, { status: 200 });
      });
      const actual = await vi.importActual<typeof import('react-dom/client')>('react-dom/client');
      root = actual.createRoot(document.getElementById('root')!);
      await act(async () => root.render(mounted.element as React.ReactNode));
    } else {
      fetcher.mockImplementation(async (url: string, options?: RequestInit) => {
        if (url.endsWith('/messages') && options?.method === 'POST') {
          return new Response(`event: done\ndata: ${JSON.stringify(result)}\n\n`);
        }
        return new Response(null, { status: 200 });
      });
      await draft('Покажите товары');
      await act(async () => document.querySelector('form.composer')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    }
    expect(document.querySelectorAll('.product-card')).toHaveLength(3);
    expect(document.querySelector('[aria-label="Подходящие варианты"]')?.textContent).toContain('Подтверждённый');
    expect(document.querySelector('[aria-label="Под заказ — цену и сроки уточнит менеджер"]')?.textContent).toContain('Под заказ');
    const uncertain = document.querySelector('[aria-label="Возможные варианты — нужно уточнить соответствие"]');
    expect(uncertain?.textContent).toContain('Возможный');
    expect(uncertain?.querySelectorAll('.product-card')).toHaveLength(1);
  });
  it('shows the two real DPU comparison cards as uncertain after restoring history', async () => {
    const answer = followup.cases.find(item => item.case_id === 'dpu6555_narrow_trench')!.answers[0];
    const cards = answer.uncertain.map(id => ({ id, name: originals.items.find(item => item.product_id === id)!.original['название'],
      matchStatus: 'uncertain', specs: {}, reasons: [], caveats: [] }));
    await act(async () => root.unmount());
    fetcher.mockImplementation(async (url: string) => url.endsWith('/messages')
      ? Response.json({ historyComplete: true, messages: [{ id: 'dpu-answer', role: 'assistant', content: answer.answer, products: cards }] })
      : new Response(null, { status: 200 }));
    const actual = await vi.importActual<typeof import('react-dom/client')>('react-dom/client');
    root = actual.createRoot(document.getElementById('root')!);
    await act(async () => root.render(mounted.element as React.ReactNode));
    expect(document.body.textContent).toContain('Возможные варианты — нужно уточнить соответствие');
    expect(document.querySelectorAll('.product-card')).toHaveLength(2);
    for (const card of cards) expect(document.body.textContent).toContain(card.name);
    expect(document.body.textContent).not.toContain('Подходящие варианты');
  });
  it('keeps an availability offer voluntary and allows opening and collapsing its form', async () => {
    await restoreAvailability('offered');
    expect(document.querySelector('.lead-panel.collapsed')).toBeTruthy();
    expect(document.querySelector('input[aria-label="Телефон"]')).toBeNull();
    expect(document.querySelector('[data-availability-outcome]')).toBeNull();
    await act(async () => (document.querySelector('.lead-toggle') as HTMLButtonElement).click());
    expect(document.querySelector('input[aria-label="Имя"]')?.getAttribute('placeholder')).toContain('необязательно');
    expect((document.querySelector('textarea[aria-label="Вопрос"]') as HTMLTextAreaElement).value).toBe('Уточнить наличие K770');
    expect((document.querySelector('textarea[aria-label="Вопрос"]') as HTMLTextAreaElement).readOnly).toBe(true);
    await act(async () => (document.querySelector('.lead-collapse') as HTMLButtonElement).click());
    expect(document.querySelector('input[aria-label="Телефон"]')).toBeNull();
    expect(fetcher.mock.calls.some(([url]) => url.endsWith('/leads'))).toBe(false);
  });

  it.each(['contact_requested', 'failed'] as const)('opens restored %s requests, not the generic offer', async state => {
    await restoreAvailability(state);
    expect(document.querySelector('input[aria-label="Телефон"]')).toBeTruthy();
    expect((document.querySelector('.lead-panel button[type="submit"]') as HTMLButtonElement).disabled).toBe(true);
  });

  it('preserves contact on failure and retries with the same scope until a durable queued receipt', async () => {
    await restoreAvailability('contact_requested');
    await contactValue('+7 900 000-10-03');
    const previousFetch = fetcher.getMockImplementation()!;
    let submissions = 0;
    fetcher.mockImplementation(async (url: string, options?: RequestInit) => {
      if (!url.endsWith('/leads')) return previousFetch(url);
      submissions++;
      return submissions === 1 ? Response.json({ ok: false }, { status: 503 })
        : Response.json({ ok: true, status: 'queued', outboxId: 'outbox-availability', availabilityReceipt: queuedReceipt });
    });
    const submit = async () => act(async () => {
      document.querySelector('form.lead-panel')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await submit();
    expect(document.body.textContent).toContain('Не удалось отправить');
    expect((document.querySelector('input[aria-label="Телефон"]') as HTMLInputElement).value).toBe('+7 900 000-10-03');
    expect(document.body.textContent).not.toContain('Заявка сохранена');
    await submit();
    expect(document.body.textContent).toContain('Заявка сохранена · в очереди');
    expect(document.body.textContent).toContain(technicalReply);
    expect(document.querySelector('input[aria-label="Телефон"]')).toBeNull();
    const payloads = fetcher.mock.calls.filter(([url]) => url.endsWith('/leads'))
      .map(([, options]) => JSON.parse(String(options?.body)));
    expect(payloads).toHaveLength(2);
    expect(payloads[0]).toEqual(payloads[1]);
    expect(payloads[0]).toMatchObject({ clientLeadId: availabilityId, availabilityRequestId: availabilityId,
      sessionId: oldId, question: 'Уточнить наличие K770' });
  });

  it('restores a queued request as a receipt without a second submission form', async () => {
    await restoreAvailability('queued');
    expect(document.body.textContent).toContain('Наличие на складе не подтверждено');
    expect(document.body.textContent).toContain(technicalReply);
    expect(document.querySelector('.lead-toggle')).toBeNull();
    expect(document.querySelector('input[aria-label="Телефон"]')).toBeNull();
  });
  it.each([
    ['contact_requested', 'consent_required'], ['queued', 'already_queued'],
    ['queued', 'cancellation_not_confirmed'], ['failed', 'failed']
  ] as const)('restores %s/%s as a separate factual status without changing the consultation', async (state, outcome) => {
    await restoreAvailability(state, outcome);
    expect(document.querySelector('.message.assistant .bubble')?.textContent).toBe(technicalReply);
    expect(document.querySelector('[data-availability-outcome]')?.getAttribute('data-availability-outcome')).toBe(outcome);
    expect(document.querySelector('.message.assistant .bubble [data-availability-outcome]')).toBeNull();
  });
  it('asks the buyer to wait for a pending chat decision and retains the contact for retry', async () => {
    await restoreAvailability('contact_requested');
    await contactValue('+7 900 000-10-03');
    const previousFetch = fetcher.getMockImplementation()!;
    fetcher.mockImplementation(async (url: string) => url.endsWith('/leads')
      ? Response.json({ error: 'availability_decision_pending', retryable: true }, { status: 409 }) : previousFetch(url));
    await act(async () => { document.querySelector('form.lead-panel')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
    expect(document.body.textContent).toContain('Дождитесь ответа бота и повторите отправку заявки');
    expect((document.querySelector('input[aria-label="Телефон"]') as HTMLInputElement).value).toBe('+7 900 000-10-03');
    expect(document.body.textContent).not.toContain('Заявка сохранена');
  });

  it('does not submit two forms when the buyer double-clicks while capture is pending', async () => {
    await restoreAvailability('contact_requested');
    await contactValue('+7 900 000-10-03');
    const previousFetch = fetcher.getMockImplementation()!;
    let finish: ((response: Response) => void) | undefined;
    fetcher.mockImplementation(async (url: string) => url.endsWith('/leads')
      ? new Promise<Response>(resolve => { finish = resolve; }) : previousFetch(url));
    await act(async () => {
      const form = document.querySelector('form.lead-panel')!;
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(fetcher.mock.calls.filter(([url]) => url.endsWith('/leads'))).toHaveLength(1);
    expect(document.body.textContent).not.toContain('Заявка сохранена');
    await act(async () => { finish?.(Response.json({ ok: true, status: 'queued', outboxId: 'queued-once', availabilityReceipt: queuedReceipt })); });
    expect(document.body.textContent).toContain('Заявка сохранена · в очереди');
  });

  it('hides a declined request and does not silently replace an unavailable session on form submit', async () => {
    await restoreAvailability('declined');
    expect(document.querySelector('form.lead-panel')).toBeNull();
    await restoreAvailability('contact_requested');
    await contactValue('+7 900 000-10-03');
    const previousFetch = fetcher.getMockImplementation()!;
    fetcher.mockImplementation(async (url: string) => url.endsWith('/leads')
      ? Response.json({ error: 'Session not found' }, { status: 404 }) : previousFetch(url));
    await act(async () => { document.querySelector('form.lead-panel')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
    expect(document.body.textContent).toContain('Предыдущий диалог недоступен');
    expect(fetcher.mock.calls.some(([url]) => url.endsWith('/sessions'))).toBe(false);
    expect((document.querySelector('input[aria-label="Телефон"]') as HTMLInputElement).value).toBe('+7 900 000-10-03');
  });

  it('shows a new chat button and closes the old session before clearing the buyer view', async () => {
    const button = [...document.querySelectorAll('button')].find((item) => item.textContent === 'Новый чат')!;
    expect(button).toBeTruthy();
    expect(document.body.textContent).toContain(history[1].content);
    fetcher.mockImplementation(async (url: string) => url.endsWith('/close')
      ? Response.json({ ok: true })
      : url.endsWith('/messages') ? Response.json({ historyComplete: true, messages: history }) : new Response(null, { status: 200 }));
    await act(async () => button.click());
    expect(fetcher).toHaveBeenCalledWith(expect.stringContaining(`/sessions/${oldId}/close`), expect.objectContaining({ method: 'POST' }));
    expect(sessionStorage.getItem('bakaut_session_id')).toBeNull();
    expect(document.body.textContent).not.toContain(history[1].content);
    expect(document.querySelector('details')).toBeNull();
  });

  it('keeps the current chat when closing it fails', async () => {
    const button = [...document.querySelectorAll('button')].find((item) => item.textContent === 'Новый чат')!;
    fetcher.mockImplementation(async () => new Response(null, { status: 503 }));
    await act(async () => button.click());
    expect(sessionStorage.getItem('bakaut_session_id')).toBe(oldId);
    expect(document.body.textContent).toContain(history[1].content);
    expect(document.body.textContent).toContain('Не удалось начать новый чат');
  });

  it('paginates all goods and separates uncertain cards in restored buyer history', async () => {
    await act(async () => root.unmount());
    const cards = [
      ...Array.from({ length: 12 }, (_, i) => ({ id: `matched-${i}`, name: `Подходит ${i}`, price: 90000, specs: {}, reasons: [], caveats: [] })),
      ...Array.from({ length: 12 }, (_, i) => ({ id: `order-${i}`, name: `Заказ ${i}`, price: null, priceOnRequest: true, specs: {}, reasons: [], caveats: [] })),
      { id: 'uncertain', name: 'Возможный', matchStatus: 'uncertain', specs: {}, reasons: [], caveats: [] }
    ];
    fetcher.mockImplementation(async (url: string) => url.endsWith('/messages')
      ? Response.json({ historyComplete: true, messages: [{ id: 'a1', role: 'assistant', content: 'Результаты', products: cards }] })
      : new Response(null, { status: 200 }));
    const actual = await vi.importActual<typeof import('react-dom/client')>('react-dom/client');
    root = actual.createRoot(document.getElementById('root')!);
    await act(async () => root.render(mounted.element as React.ReactNode));
    expect(document.querySelectorAll('.product-card')).toHaveLength(10);
    expect(document.body.textContent).toContain('10 из 25');
    expect(document.body.textContent).not.toContain('Заказ 0');
    await act(async () => (document.querySelector('.product-more') as HTMLButtonElement).click());
    expect(document.querySelectorAll('.product-card')).toHaveLength(20);
    expect(document.body.textContent).toContain('Под заказ — цену и сроки уточнит менеджер');
    await act(async () => (document.querySelector('.product-more') as HTMLButtonElement).click());
    expect(document.querySelectorAll('.product-card')).toHaveLength(25);
    const uncertainGroup = document.querySelector('[aria-label="Возможные варианты — нужно уточнить соответствие"]');
    expect(uncertainGroup?.querySelectorAll('.product-card')).toHaveLength(1);
    expect(uncertainGroup?.textContent).toContain('Возможный');
    expect(uncertainGroup?.textContent).not.toContain('Подходит');
    expect(document.querySelector('.product-more')).toBeNull();
  });

  it('blocks silent continuation and preserves history and draft across explicit new chat', async () => {
    const field = await draft('А какие из них подходят?');
    heartbeatStatus = 404;
    await act(async () => heartbeat());
    expect(field.disabled).toBe(true);
    expect(field.value).toBe('А какие из них подходят?');
    expect(document.body.textContent).toContain('Предыдущий диалог недоступен');
    expect(document.body.textContent).toContain(history[1].content);
    expect(fetcher.mock.calls.every(([url]) => !url.endsWith('/sessions'))).toBe(true);
    const start = [...document.querySelectorAll('button')].find((button) => button.textContent === 'Начать новый чат')!;
    await act(async () => start.click());
    expect(field.disabled).toBe(false);
    expect(field.value).toBe('А какие из них подходят?');
    expect(document.querySelector('details')?.textContent).toContain(history[1].content);
    expect(document.querySelector('summary')?.textContent).toContain('не используется в новом чате');
    expect(sessionStorage.getItem('bakaut_session_id')).toBeNull();
    expect(fetcher.mock.calls.every(([url]) => !url.endsWith('/sessions'))).toBe(true);
  });

  it('does not discard context or block the composer on a transient heartbeat failure', async () => {
    const field = await draft('Продолжим подбор');
    heartbeatStatus = 503;
    await act(async () => heartbeat());
    expect(field.disabled).toBe(false);
    expect(field.value).toBe('Продолжим подбор');
    expect(sessionStorage.getItem('bakaut_session_id')).toBe(oldId);
    expect(document.body.textContent).not.toContain('Предыдущий диалог недоступен');
  });

  it('restores the draft when submission discovers a missing session before heartbeat does', async () => {
    const field = await draft('Проверьте точную совместимость');
    fetcher.mockImplementation(async () => Response.json({ error: 'Session not found' }, { status: 404 }));
    await act(async () => {
      document.querySelector('form.composer')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(field.disabled).toBe(true);
    expect(field.value).toBe('Проверьте точную совместимость');
    expect(document.body.textContent).toContain(history[1].content);
    expect(document.body.textContent).toContain('Предыдущий диалог недоступен');
    expect(fetcher.mock.calls.every(([url]) => !url.endsWith('/sessions'))).toBe(true);
    expect(document.querySelectorAll('.message.user')).toHaveLength(1);
  });
});
