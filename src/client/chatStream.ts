import type { ChatResponsePayload } from '../shared/types';

export type ChatStreamHandlers = {
  onDelta: (delta: string) => void;
  onStatus?: (status: string) => void;
};

type FetchLike = typeof fetch;

export type ChatStreamOptions = {
  visitorId: string;
  fetcher?: FetchLike;
  idleTimeoutMs?: number;
  clientMessageId?: string;
};

const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 150_000;
const DEFAULT_RECOVERY_IDLE_TIMEOUT_MS = 180_000;
const MAX_RECOVERY_TRANSPORT_ATTEMPTS = 1;
const RECOVERY_TRANSPORT_RETRY_DELAY_MS = 250;
const STREAM_TIMEOUT_MESSAGE = 'Ответ ассистента не завершился вовремя.';
const RECOVERING_STATUS = 'Ответ оборвался, восстанавливаю...';
const FRIENDLY_FINAL_ERROR = 'Сейчас не удалось надежно завершить ответ. Попробуйте отправить вопрос ещё раз.';

export class ChatMessageNotAcceptedError extends Error {
  constructor(
    message: string,
    readonly activeTurnId?: string,
    readonly statusCode?: number
  ) {
    super(message);
    this.name = 'ChatMessageNotAcceptedError';
  }
}

export class ActiveConversationTurnError extends ChatMessageNotAcceptedError {
  constructor(activeTurnId: string) {
    super('Предыдущий ответ ещё формируется. Новый вопрос не отправлен и остался в поле ввода.', activeTurnId, 409);
    this.name = 'ActiveConversationTurnError';
  }
}

export function registerChatAbortController(
  slot: { current: AbortController | null },
  controller: AbortController
) {
  slot.current = controller;
  const release = () => {
    controller.signal.removeEventListener('abort', release);
    if (slot.current === controller) slot.current = null;
  };
  controller.signal.addEventListener('abort', release, { once: true });
  return release;
}

class ServerSseError extends Error {
  constructor(message: string, readonly recoverable: boolean) {
    super(message);
    this.name = 'ServerSseError';
  }
}

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
      if (parsed.event === 'error') {
        throw new ServerSseError(
          String(parsed.data.error ?? FRIENDLY_FINAL_ERROR),
          parsed.data.recoverable !== false
        );
      }
    }
  }

  if (!donePayload) throw new Error('Server finished without a done payload');
  return donePayload;
}

async function recoverChatMessage(
  apiBase: string,
  sessionId: string,
  turnId: string,
  visitorId: string,
  handlers: ChatStreamHandlers,
  signal: AbortSignal | undefined,
  fetcher: FetchLike,
  idleTimeoutMs: number
) {
  let lastError: unknown = new Error(FRIENDLY_FINAL_ERROR);
  for (let attempt = 0; attempt < MAX_RECOVERY_TRANSPORT_ATTEMPTS; attempt += 1) {
    handlers.onStatus?.(RECOVERING_STATUS);
    try {
      const response = await fetcher(`${apiBase}/api/chat/sessions/${sessionId}/messages/${turnId}/recover`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-bakaut-visitor-id': visitorId
        },
        body: JSON.stringify({}),
        signal
      });
      if (!response.ok || !response.body) throw new Error(FRIENDLY_FINAL_ERROR);
      return await consumeSse(
        response,
        handlers,
        signal,
        Math.max(idleTimeoutMs, DEFAULT_RECOVERY_IDLE_TIMEOUT_MS)
      );
    } catch (error) {
      if (signal?.aborted || (error instanceof DOMException && error.name === 'AbortError')) throw error;
      if (error instanceof ServerSseError && !error.recoverable) throw error;
      lastError = error;
      if (attempt + 1 >= MAX_RECOVERY_TRANSPORT_ATTEMPTS) break;
      await new Promise<void>((resolve, reject) => {
        const onTimeout = () => {
          signal?.removeEventListener('abort', onAbort);
          resolve();
        };
        const timeout = setTimeout(onTimeout, RECOVERY_TRANSPORT_RETRY_DELAY_MS);
        const onAbort = () => {
          clearTimeout(timeout);
          signal?.removeEventListener('abort', onAbort);
          reject(new DOMException('The operation was aborted.', 'AbortError'));
        };
        signal?.addEventListener('abort', onAbort, { once: true });
      });
    }
  }
  throw lastError instanceof Error ? lastError : new Error(FRIENDLY_FINAL_ERROR);
}

export async function recoverChatTurn(
  apiBase: string,
  sessionId: string,
  turnId: string,
  visitorId: string,
  handlers: ChatStreamHandlers,
  signal?: AbortSignal,
  options: Pick<ChatStreamOptions, 'fetcher' | 'idleTimeoutMs'> = {}
) {
  return recoverChatMessage(
    apiBase,
    sessionId,
    turnId,
    visitorId,
    handlers,
    signal,
    options.fetcher ?? fetch,
    options.idleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS
  );
}

export async function streamChatMessage(
  apiBase: string,
  sessionId: string,
  message: string,
  handlers: ChatStreamHandlers,
  signal: AbortSignal | undefined,
  options: ChatStreamOptions
) {
  const fetcher = options.fetcher ?? fetch;
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS;
  const clientMessageId = options.clientMessageId ?? crypto.randomUUID();

  const response = await fetcher(`${apiBase}/api/chat/sessions/${sessionId}/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-bakaut-visitor-id': options.visitorId
    },
    body: JSON.stringify({ message, clientMessageId }),
    signal
  });
  if (!response.ok) {
    const errorPayload = await response.json().catch(() => ({})) as { error?: string; activeTurnId?: unknown };
    const activeTurnId = typeof errorPayload.activeTurnId === 'string'
      ? errorPayload.activeTurnId.trim()
      : '';
    if (response.status === 409) {
      if (activeTurnId) throw new ActiveConversationTurnError(activeTurnId);
      throw new ChatMessageNotAcceptedError(
        'Сообщение не принято. Оно осталось в поле ввода — попробуйте отправить ещё раз.',
        undefined,
        response.status
      );
    }
    if (response.status >= 400 && response.status < 500) {
      throw new ChatMessageNotAcceptedError(
        response.status === 404
          ? 'Сообщение не принято: сессия завершилась. Вопрос остался в поле ввода — отправьте его ещё раз.'
          : 'Сообщение не принято. Оно осталось в поле ввода — попробуйте отправить ещё раз.',
        undefined,
        response.status
      );
    }
    throw new Error('Не удалось получить ответ');
  }
  if (!response.body) throw new Error('Не удалось получить ответ');
  try {
    return await consumeSse(response, handlers, signal, idleTimeoutMs);
  } catch (error) {
    if (signal?.aborted || (error instanceof DOMException && error.name === 'AbortError')) throw error;
    throw new Error(error instanceof Error && error.message ? error.message : FRIENDLY_FINAL_ERROR);
  }
}
