import { describe, expect, it } from 'vitest';

import { closeSseReply, createStageStatusSender, customerStatusForStage, openSseReply, type SseReply } from '../src/routes/sse.js';

function fakeReply() {
  const writes: string[] = [];
  const headers: Array<{ statusCode: number; headers: Record<string, string> }> = [];
  const reply: SseReply = {
    raw: {
      destroyed: false,
      writableEnded: false,
      writeHead(statusCode, values) {
        headers.push({ statusCode, headers: values });
      },
      write(chunk) {
        writes.push(chunk);
      },
      end() {
        reply.raw.writableEnded = true;
      }
    }
  };
  return { reply, writes, headers };
}

describe('chat SSE helpers', () => {
  it('opens the standard SSE stream and no-ops after close', () => {
    const { reply, writes, headers } = fakeReply();
    const send = openSseReply(reply);

    send('turn', { turnId: 'turn-1' });
    closeSseReply(reply);
    send('done', { ignored: true });

    expect(headers).toEqual([{
      statusCode: 200,
      headers: {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no'
      }
    }]);
    expect(writes.join('')).toBe('event: turn\ndata: {"turnId":"turn-1"}\n\n');
    expect(reply.raw.writableEnded).toBe(true);
  });

  it('adds a durable turn id header without replacing the SSE headers', () => {
    const { reply, headers } = fakeReply();

    openSseReply(reply, { 'x-chat-turn-id': 'turn-durable' });

    expect(headers[0]).toEqual({
      statusCode: 200,
      headers: expect.objectContaining({
        'content-type': 'text/event-stream; charset=utf-8',
        'x-chat-turn-id': 'turn-durable'
      })
    });
  });

  it('maps real agent stages to coalesced customer statuses', () => {
    const events: Array<{ event: string; data: unknown }> = [];
    const sendStageStatus = createStageStatusSender((event, data) => {
      events.push({ event, data });
    });

    sendStageStatus({ phase: 'turn', eventType: 'started' });
    sendStageStatus({ phase: 'turn', eventType: 'started' });
    sendStageStatus({ phase: 'intent', eventType: 'semantic_decision_started' });
    sendStageStatus({ phase: 'tools', eventType: 'tool_started' });
    sendStageStatus({ phase: 'answer', eventType: 'contract_created' });
    sendStageStatus({ phase: 'validation', eventType: 'completed' });
    sendStageStatus({ phase: 'recovery', eventType: 'checkpoint_reused' });

    expect(events).toEqual([
      { event: 'status', data: { status: 'Готовлю ответ...' } },
      { event: 'status', data: { status: 'Уточняю задачу...' } },
      { event: 'status', data: { status: 'Проверяю данные по товарам...' } },
      { event: 'status', data: { status: 'Формирую ответ...' } },
      { event: 'status', data: { status: 'Проверяю итог...' } }
    ]);
    expect(customerStatusForStage({ phase: 'tools', eventType: 'unknown' })).toBeNull();
  });
});
