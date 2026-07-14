export type SseSender = (event: string, data: unknown) => void;

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

export function startStatusTimer(input: {
  send: SseSender;
  initialStatus: string;
  statusMessages: string[];
  intervalMs?: number;
}) {
  input.send('status', { status: input.initialStatus });
  let statusIndex = 0;
  const timer = setInterval(() => {
    statusIndex = Math.min(statusIndex + 1, input.statusMessages.length - 1);
    input.send('status', { status: input.statusMessages[statusIndex] });
  }, input.intervalMs ?? 12_000);
  timer.unref?.();
  return () => clearInterval(timer);
}
