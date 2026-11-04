// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { DiagnosticTimeline, diagnosticEventFailed, diagnosticJournalSummary, mergeDiagnosticEvents, safeDiagnosticEvent, validDiagnosticId } from '../src/client/DiagnosticTimeline';
const uuid = '30b1b4b0-c9cd-4c0a-bfbd-06c395fb3c03';
describe('technical diagnostic timeline helpers', () => {
  it('accepts bounded technical IDs only', () => {
    expect(validDiagnosticId('turnId', uuid)).toBe(true);
    expect(validDiagnosticId('executionId', uuid)).toBe(true);
    expect(validDiagnosticId('requestId', uuid)).toBe(true);
    expect(validDiagnosticId('requestId', 'req-1')).toBe(false);
    expect(validDiagnosticId('providerRequestId', 'req_abc123')).toBe(true);
    for (const value of ['', 'hello', 'Bearer secret', 'req_abc?token=secret', 'req_\n', 'req_' + 'a'.repeat(201), '<script>']) {
      expect(validDiagnosticId('providerRequestId', value)).toBe(false);
    }
    expect(validDiagnosticId('turnId', 'req-1')).toBe(false);
    expect(validDiagnosticId('requestId', 'req_' + 'x'.repeat(50))).toBe(false);
  });
  it('renders only allowlisted scalar technical fields, never arbitrary nested objects or error text', () => {
    const safe = safeDiagnosticEvent({ id: 42, name: 'platform.failed', errorCode: 'timeout', durationMs: 10, timestamp: '2026-11-04T20:00:00.000Z', prompt: 'PRIVATE_CANARY', messages: ['PRIVATE_CANARY'], error: 'PRIVATE_CANARY', stack: 'PRIVATE_CANARY', body: 'PRIVATE_CANARY', sql: 'PRIVATE_CANARY', operation: { prompt: 'PRIVATE_CANARY' }, endpoint: 'https://example.test/?secret=PRIVATE_CANARY', statusCode: Infinity });
    expect(safe).toEqual({ id: '42', name: 'platform.failed', errorCode: 'timeout', durationMs: 10, timestamp: '2026-11-04T20:00:00.000Z' });
    expect(JSON.stringify(safe)).not.toContain('PRIVATE_CANARY');
    expect(safeDiagnosticEvent(null)).toEqual({});
  });
  it('highlights local and remote failures without interpreting absent evidence as success', () => {
    expect(diagnosticEventFailed({ statusCode: 503 })).toBe(true);
    expect(diagnosticEventFailed({ remoteStatus: 'incomplete' })).toBe(true);
    expect(diagnosticEventFailed({ errorCode: 'unknown' })).toBe(true);
    expect(diagnosticEventFailed({ name: 'request.failed' })).toBe(true);
    expect(diagnosticEventFailed({ name: 'request.start' })).toBe(false);
  });
  it('sorts loaded pages chronologically and de-duplicates IDs without summing timings', () => {
    const events = mergeDiagnosticEvents([{ id: '2', timestamp: '2026-11-04T20:00:02.000Z', durationMs: 50 }], [
      { id: '1', timestamp: '2026-11-04T20:00:01.000Z', durationMs: 40 },
      { id: '2', timestamp: '2026-11-04T20:00:02.000Z', durationMs: 50 }
    ]);
    expect(events.map(e => e.id)).toEqual(['1', '2']);
    expect(events.map(e => e.durationMs)).toEqual([40, 50]);
  });
  it('does not turn absent journal health into zero loss', () => {
    expect(diagnosticJournalSummary(undefined)).toContain('Потеряно событий: неизвестно');
    expect(diagnosticJournalSummary({ dropped: 5, storageFailures: 2, queueDepth: 3, retentionBacklog: true })).toContain('очистка отстаёт: да');
  });
});


describe('manual diagnostic timeline requests', () => {
  let root: Root | undefined;
  let container: HTMLDivElement;
  afterEach(async () => {
    if (root) await act(async () => root?.unmount());
    container?.remove(); vi.unstubAllGlobals(); root = undefined;
  });
  async function mount(token = 'test-token') {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    container = document.createElement('div'); document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root?.render(React.createElement(DiagnosticTimeline, { baseUrl: '', token })));
    await act(async () => {
      const input = container.querySelector('input')!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, uuid);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }
  async function submit() {
    await act(async () => container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  }
  it('never fetches automatically, and blocks requests without a token', async () => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    await mount(''); await submit();
    expect(fetcher).not.toHaveBeenCalled();
    expect(container.querySelector('button')!.disabled).toBe(true);
  });
  it('ignores even successful stale responses after a token change', async () => {
    let resolve!: (value: unknown) => void;
    const fetcher = vi.fn((_url: string, _options: RequestInit) => new Promise(done => { resolve = done; }));
    vi.stubGlobal('fetch', fetcher); await mount();
    expect(fetcher).not.toHaveBeenCalled();
    await submit(); expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]?.[0]).toContain('/api/admin/diagnostics?turnId=');
    await act(async () => root?.render(React.createElement(DiagnosticTimeline, { baseUrl: '', token: 'replacement-token' })));
    await act(async () => resolve({ ok: true, json: async () => ({ events: [{ id: '1', name: 'stale_event' }], hasMore: false }) }));
    expect(container.textContent).not.toContain('stale_event');
    expect(container.textContent).not.toContain('Загружено событий');
  });
  it('loads subsequent pages only on demand, with the cursor and bearer token', async () => {
    const fetcher = vi.fn(async (_url: string, _options: RequestInit) => ({ ok: true, json: async () => ({ events: [{ id: '7', name: 'request.start' }], nextId: '7', hasMore: true }) }));
    vi.stubGlobal('fetch', fetcher); await mount(); await submit();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain('Показана часть записей');
    await act(async () => [...container.querySelectorAll('button')].find(button => button.textContent === 'Загрузить ещё')!.click());
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[1][0]).toContain('afterId=7');
    expect(fetcher.mock.calls[1][1]).toMatchObject({ method: 'GET', headers: { Authorization: 'Bearer test-token' } });
    expect(container.textContent).toContain('Загружено событий: 1');
    expect(container.textContent).toContain('не вернул новый корректный курсор');
  });
  it.each([401, 403, 503])('shows a safe actionable message for HTTP %s without reading error bodies', async status => {
    const json = vi.fn();
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status, json })));
    await mount(); await submit();
    expect(container.querySelector('[role="alert"]')?.textContent).toBeTruthy();
    expect(json).not.toHaveBeenCalled();
  });
});
