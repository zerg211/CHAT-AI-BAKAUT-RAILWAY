import { describe, expect, it, vi } from 'vitest';
import { createClientDiagnostics, MAX_CLIENT_DIAGNOSTIC_EVENTS } from '../src/client/clientDiagnostics';

const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const input = { apiBase: '', sessionId: id, visitorId: 'CAPABILITY_SECRET', recovery: false };
const capture = () => vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
const body = (reporter: ReturnType<typeof capture>) => JSON.parse(String(reporter.mock.calls[0]?.[1]?.body));

describe('safe browser diagnostics', () => {
  it('reports only UUIDs and enum observations, with one bounded terminal request', () => {
    const reporter = capture();
    let time = 100;
    const trace = createClientDiagnostics({ ...input, clientMessageId: id }, { reporter, now: () => time });
    trace.event('request_sent');
    time = 125;
    trace.headers(new Response(null, { status: 200, headers: { 'x-request-id': id, 'x-chat-turn-id': id } }));
    trace.event('status_received');
    trace.event('status_received');
    trace.event('first_answer_received');
    trace.event('first_answer_received');
    trace.event('done_received');
    trace.finish();
    trace.finish();
    trace.event('stream_error');
    expect(reporter).toHaveBeenCalledOnce();
    expect(body(reporter)).toEqual({
      clientMessageId: id, turnId: id, requestId: id, recovery: false, droppedEvents: 0,
      events: [
        { type: 'request_sent', offsetMs: 0 }, { type: 'headers_received', offsetMs: 25, statusCode: 200 },
        { type: 'turn_identified', offsetMs: 25 }, { type: 'status_received', offsetMs: 25 },
        { type: 'first_answer_received', offsetMs: 25 }, { type: 'done_received', offsetMs: 25 }
      ]
    });
    expect(reporter.mock.calls[0]?.[1]).toMatchObject({ keepalive: true, headers: { 'x-bakaut-visitor-id': input.visitorId } });
    expect(JSON.stringify(body(reporter))).not.toContain('CAPABILITY_SECRET');
  });

  it('rejects arbitrary identifiers/types/status fields and caps event count and offsets', () => {
    const reporter = capture();
    let time = 0;
    const trace = createClientDiagnostics({ ...input, clientMessageId: 'PRIVATE_TEXT', turnId: 'PRIVATE_TEXT' }, { reporter, now: () => time });
    trace.headers(new Response(null, { headers: { 'x-request-id': 'PRIVATE_TEXT' } }));
    trace.event('PRIVATE_TEXT' as never);
    time = 1e15;
    for (let i = 0; i < 100; i++) trace.event('request_sent', 9999);
    trace.finish();
    const report = body(reporter);
    expect(report.events).toHaveLength(MAX_CLIENT_DIAGNOSTIC_EVENTS);
    expect(report.droppedEvents).toBe(69);
    expect(report.events[1]).toEqual({ type: 'request_sent', offsetMs: 3_600_000 });
    expect(JSON.stringify(report)).not.toContain('PRIVATE_TEXT');
  });

  it('suppresses synchronous and asynchronous reporter failures without retries', async () => {
    for (const reporter of [vi.fn(() => { throw new Error('PRIVATE_ERROR'); }), vi.fn(async () => { throw new Error('PRIVATE_ERROR'); })]) {
      const trace = createClientDiagnostics(input, { reporter });
      expect(() => trace.finish()).not.toThrow();
      await Promise.resolve();
      expect(reporter).toHaveBeenCalledOnce();
    }
  });

  it('does not wait for reporting and aborts a hung report after two seconds', async () => {
    vi.useFakeTimers();
    try {
      const reporter = vi.fn<typeof fetch>(() => new Promise(() => undefined));
      const trace = createClientDiagnostics(input, { reporter });
      expect(trace.finish()).toBeUndefined();
      const signal = reporter.mock.calls[0]?.[1]?.signal;
      expect(signal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(2000);
      expect(signal?.aborted).toBe(true);
      expect(reporter).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); }
  });
});
