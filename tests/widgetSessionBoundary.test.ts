// @vitest-environment jsdom
import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Root } from 'react-dom/client';

const mounted = vi.hoisted(() => ({ element: null as unknown }));
vi.mock('react-dom/client', () => ({ createRoot: () => ({ render: (element: unknown) => { mounted.element = element; } }) }));
import '../src/client/main';

let root: Root;
let heartbeat: () => Promise<void>;
let heartbeatStatus: number;
let fetcher: ReturnType<typeof vi.fn>;
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
    if (url.endsWith('/messages')) return Response.json({ messages: history });
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

describe('rendered widget session boundary', () => {
  it('shows a new chat button and closes the old session before clearing the buyer view', async () => {
    const button = [...document.querySelectorAll('button')].find((item) => item.textContent === 'Новый чат')!;
    expect(button).toBeTruthy();
    expect(document.body.textContent).toContain(history[1].content);
    fetcher.mockImplementation(async (url: string) => url.endsWith('/close')
      ? Response.json({ ok: true })
      : url.endsWith('/messages') ? Response.json({ messages: history }) : new Response(null, { status: 200 }));
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

  it('separates and paginates verified on-request products in restored history', async () => {
    await act(async () => root.unmount());
    const cards = [
      ...Array.from({ length: 12 }, (_, i) => ({ id: `matched-${i}`, name: `Подходит ${i}`, price: 90000, specs: {}, reasons: [], caveats: [] })),
      ...Array.from({ length: 12 }, (_, i) => ({ id: `order-${i}`, name: `Заказ ${i}`, price: null, priceOnRequest: true, specs: {}, reasons: [], caveats: [] }))
    ];
    fetcher.mockImplementation(async (url: string) => url.endsWith('/messages')
      ? Response.json({ messages: [{ id: 'a1', role: 'assistant', content: 'Результаты', products: cards }] })
      : new Response(null, { status: 200 }));
    const actual = await vi.importActual<typeof import('react-dom/client')>('react-dom/client');
    root = actual.createRoot(document.getElementById('root')!);
    await act(async () => root.render(mounted.element as React.ReactNode));
    const panels = [...document.querySelectorAll('.product-panel')];
    expect(panels).toHaveLength(2);
    expect(panels[0].textContent).toContain('Подходящие варианты');
    expect(panels[0].textContent).not.toContain('Заказ 0');
    expect(panels[1].textContent).toContain('Под заказ — цену и сроки уточнит менеджер');
    expect(panels[1].textContent).toContain('Товар под заказ, сроки уточнит менеджер');
    expect(panels.map((panel) => panel.querySelectorAll('.product-card').length)).toEqual([10, 10]);
    await act(async () => (panels[1].querySelector('button') as HTMLButtonElement).click());
    expect(panels.map((panel) => panel.querySelectorAll('.product-card').length)).toEqual([10, 12]);
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
