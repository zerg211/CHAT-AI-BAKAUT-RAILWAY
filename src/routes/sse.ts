export type SseSender = (event: string, data: unknown) => void;

export type AgentStageEvent = {
  phase: string;
  eventType: string;
};

type RawSseReply = {
  destroyed?: boolean;
  writableEnded?: boolean;
  writeHead: (statusCode: number, headers: Record<string, string>) => void;
  write: (chunk: string) => unknown;
  end: () => unknown;
};

export type SseReply = {
  raw: RawSseReply;
};

const sseHeaders = {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-cache, no-transform',
  connection: 'keep-alive',
  'x-accel-buffering': 'no'
} as const;

export function openSseReply(reply: SseReply, headers: Record<string, string> = {}) {
  reply.raw.writeHead(200, { ...sseHeaders, ...headers });
  return createSseSender(reply);
}

export function createSseSender(reply: SseReply): SseSender {
  return (event: string, data: unknown) => {
    if (reply.raw.destroyed || reply.raw.writableEnded) return;
    reply.raw.write(`event: ${event}\n`);
    reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
  };
}

export function closeSseReply(reply: SseReply) {
  if (!reply.raw.destroyed && !reply.raw.writableEnded) reply.raw.end();
}

export function customerStatusForStage(event: AgentStageEvent) {
  if (event.phase === 'turn' && event.eventType === 'started') return 'Готовлю ответ...';
  if (event.phase === 'intent' && event.eventType === 'semantic_decision_started') return 'Уточняю задачу...';
  if (event.phase === 'tools' && event.eventType === 'tool_started') return 'Проверяю данные по товарам...';
  if (event.phase === 'answer' && event.eventType === 'contract_created') return 'Формирую ответ...';
  if (event.phase === 'validation' && event.eventType === 'completed') return 'Проверяю итог...';
  return null;
}

export function createStageStatusSender(send: SseSender) {
  let lastStatus: string | null = null;
  return (event: AgentStageEvent) => {
    const status = customerStatusForStage(event);
    if (!status || status === lastStatus) return;
    lastStatus = status;
    send('status', { status });
  };
}
