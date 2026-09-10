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
