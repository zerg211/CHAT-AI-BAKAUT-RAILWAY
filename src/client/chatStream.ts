import type { ChatResponsePayload } from '../shared/types';

export type ChatStreamHandlers = {
  onDelta: (delta: string) => void;
  onStatus?: (status: string) => void;
};

type FetchLike = typeof fetch;

export type ChatStreamOptions = {
  fetcher?: FetchLike;
  idleTimeoutMs?: number;
  recoverOnError?: boolean;
};

const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 45_000;
const STREAM_TIMEOUT_MESSAGE = 'Ответ ассистента не завершился вовремя.';
const RECOVERING_STATUS = 'Ответ оборвался, восстанавливаю...';
const FRIENDLY_FINAL_ERROR = 'Не смог надежно завершить ответ, вопрос сохранен; можно повторить или оставить контакт.';

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
        timeoutId = setTimeout(() => reject(new Error(STREAM_TIMEOUT_MESSAGE)), idleTimeoutMs);
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

async function consumeSse(
  response: Response,
  handlers: ChatStreamHandlers,
  signal: AbortSignal | undefined,
  idleTimeoutMs: number,
  onEvent?: (event: string, data: Record<string, unknown>) => Promise<ChatResponsePayload | void> | ChatResponsePayload | void
) {
  if (!response.body) throw new Error(FRIENDLY_FINAL_ERROR);
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
      const delegated = await onEvent?.(parsed.event, parsed.data);
      if (delegated) return delegated;
      if (parsed.event === 'delta') handlers.onDelta(parsed.data.delta ?? '');
      if (parsed.event === 'status') handlers.onStatus?.(parsed.data.status ?? '');
      if (parsed.event === 'done') donePayload = parsed.data as ChatResponsePayload;
      if (parsed.event === 'error') throw new Error(parsed.data.error ?? FRIENDLY_FINAL_ERROR);
    }
  }

  if (!donePayload) throw new Error('Server finished without a done payload');
  return donePayload;
}

async function recoverChatMessage(
  apiBase: string,
  sessionId: string,
  turnId: string,
  handlers: ChatStreamHandlers,
  signal: AbortSignal | undefined,
  fetcher: FetchLike,
  idleTimeoutMs: number
) {
  handlers.onStatus?.(RECOVERING_STATUS);
  const response = await fetcher(`${apiBase}/api/chat/sessions/${sessionId}/messages/${turnId}/recover`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
    signal
  });
  if (!response.ok || !response.body) throw new Error(FRIENDLY_FINAL_ERROR);
  return consumeSse(response, handlers, signal, idleTimeoutMs);
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
  const recoverOnError = options.recoverOnError !== false;
  let turnId: string | undefined;
  let recoveryAttempted = false;
  const recoverOnce = async (resolvedTurnId: string) => {
    if (recoveryAttempted) throw new Error(FRIENDLY_FINAL_ERROR);
    recoveryAttempted = true;
    return recoverChatMessage(apiBase, sessionId, resolvedTurnId, handlers, signal, fetcher, idleTimeoutMs);
  };

  const response = await fetcher(`${apiBase}/api/chat/sessions/${sessionId}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message }),
    signal
  });
  if (!response.ok || !response.body) throw new Error('Не удалось получить ответ');

  try {
    return await consumeSse(response, handlers, signal, idleTimeoutMs, async (event, data) => {
      if (event === 'turn') turnId = String(data.turnId ?? turnId ?? '');
      if (event === 'error' && recoverOnError && (data.turnId || turnId)) {
        return recoverOnce(String(data.turnId ?? turnId));
      }
    });
  } catch (error) {
    if (signal?.aborted || (error instanceof DOMException && error.name === 'AbortError')) throw error;
    if (recoverOnError && turnId && !recoveryAttempted) {
      return recoverOnce(turnId);
    }
    throw new Error(error instanceof Error && error.message ? error.message : FRIENDLY_FINAL_ERROR);
  }
}
