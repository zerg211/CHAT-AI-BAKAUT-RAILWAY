import type { ChatResponsePayload } from '../shared/types';

export type ChatStreamHandlers = {
  onDelta: (delta: string) => void;
  onStatus?: (status: string) => void;
};

type FetchLike = typeof fetch;

export type ChatStreamOptions = {
  fetcher?: FetchLike;
  idleTimeoutMs?: number;
};

const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 45_000;
const STREAM_TIMEOUT_MESSAGE = 'Ответ ассистента не завершился вовремя. Попробуйте отправить сообщение ещё раз или оставьте контакты — менеджер БАКАУТ продолжит подбор.';

function parseSseEvent(rawEvent: string) {
  const lines = rawEvent.split('\n');
  const eventLine = lines.find((line) => line.startsWith('event:'));
  const dataLines = lines.filter((line) => line.startsWith('data:'));
  if (!eventLine || !dataLines.length) return null;

  return {
    event: eventLine.replace('event:', '').trim(),
    data: JSON.parse(dataLines.map((line) => line.replace('data:', '').trim()).join('\n'))
  };
}

async function readWithIdleWatchdog(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  idleTimeoutMs: number,
  signal?: AbortSignal
) {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error(STREAM_TIMEOUT_MESSAGE));
        }, idleTimeoutMs);
        signal?.addEventListener('abort', () => {
          if (timeoutId) clearTimeout(timeoutId);
          reader.cancel().catch(() => undefined);
          reject(new DOMException('The operation was aborted.', 'AbortError'));
        }, { once: true });
      })
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

export async function streamChatMessage(
  apiBase: string,
  sessionId: string,
  message: string,
  handlers: ChatStreamHandlers,
  signal?: AbortSignal,
  options: ChatStreamOptions = {}
) {
  const fetcher = options.fetcher ?? fetch;
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS;
  const response = await fetcher(`${apiBase}/api/chat/sessions/${sessionId}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message }),
    signal
  });
  if (!response.ok || !response.body) throw new Error('Не удалось получить ответ');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let donePayload: ChatResponsePayload | null = null;

  while (true) {
    const { value, done } = await readWithIdleWatchdog(reader, idleTimeoutMs, signal);
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split('\n\n');
    buffer = events.pop() ?? '';

    for (const rawEvent of events) {
      const parsed = parseSseEvent(rawEvent);
      if (!parsed) continue;
      if (parsed.event === 'delta') handlers.onDelta(parsed.data.delta ?? '');
      if (parsed.event === 'status') handlers.onStatus?.(parsed.data.status ?? '');
      if (parsed.event === 'done') donePayload = parsed.data as ChatResponsePayload;
      if (parsed.event === 'error') throw new Error(parsed.data.error ?? 'Ошибка ответа');
    }
  }

  if (!donePayload) throw new Error('Server finished without a done payload');
  return donePayload;
}
