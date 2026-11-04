import type { ChatResponsePayload } from '../shared/types';
import { createClientDiagnostics, type ClientDiagnostics } from './clientDiagnostics';

export type ChatStreamHandlers = {
  onDelta: (delta: string) => void;
  onStatus?: (status: string) => void;
  onTurn?: (turnId: string) => void;
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
const MAX_RECOVERY_TRANSPORT_ATTEMPTS = 2;
const RECOVERY_TRANSPORT_RETRY_DELAY_MS = 250;
const STREAM_TIMEOUT_MESSAGE = 'Ответ ассистента не завершился вовремя.';
const RECOVERING_STATUS = 'Ответ оборвался, восстанавливаю...';
const FRIENDLY_FINAL_ERROR = 'Не удалось завершить ответ. Текст вашего вопроса остался в чате.';

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
  onEvent?: (event: string, data: Record<string, unknown>) => Promise<ChatResponsePayload | void> | ChatResponsePayload | void,
  diagnostics?: ClientDiagnostics
) {
  if (!response.body) throw new Error(FRIENDLY_FINAL_ERROR);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let donePayload: ChatResponsePayload | null = null;

  while (true) {
    const { value, done } = await readWithIdleWatchdog(reader, idleTimeoutMs, signal);
    if (done) {
      diagnostics?.event('stream_closed');
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split('\n\n');
    buffer = events.pop() ?? '';

    for (const rawEvent of events) {
      const parsed = parseSseEvent(rawEvent);
      if (!parsed) continue;
      if (parsed.event === 'turn') diagnostics?.identifyTurn(parsed.data.turnId);
      if (parsed.event === 'status') diagnostics?.event('status_received');
      if (parsed.event === 'delta' || parsed.event === 'done') diagnostics?.event('first_answer_received');
      if (parsed.event === 'done') {
        diagnostics?.identifyTurn(parsed.data.turnId);
        diagnostics?.event('done_received');
      }
      const delegated = await onEvent?.(parsed.event, parsed.data);
      if (delegated) return delegated;
      if (parsed.event === 'turn' && typeof parsed.data.turnId === 'string') handlers.onTurn?.(parsed.data.turnId);
      if (parsed.event === 'delta') handlers.onDelta(parsed.data.delta ?? '');
      if (parsed.event === 'status') handlers.onStatus?.(parsed.data.status ?? '');
      if (parsed.event === 'done') donePayload = parsed.data as ChatResponsePayload;
      if (parsed.event === 'cancelled') throw new DOMException('The turn was cancelled.', 'AbortError');
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
  idleTimeoutMs: number,
  diagnostics: ClientDiagnostics
) {
  let lastError: unknown = new Error(FRIENDLY_FINAL_ERROR);
  let lastSeq = 0;
  for (let attempt = 0; attempt < MAX_RECOVERY_TRANSPORT_ATTEMPTS; attempt += 1) {
    const replayed = await replayDurableTurnEvents({
      apiBase,
      sessionId,
      turnId,
      visitorId,
      afterSeq: lastSeq,
      diagnostics,
      signal,
      fetcher,
      onStatus: (status) => { diagnostics.event('status_received'); handlers.onStatus?.(status); },
      onSeq: (seq) => { lastSeq = Math.max(lastSeq, seq); }
    });
    if (replayed) {
      diagnostics.event('first_answer_received');
      diagnostics.event('done_received');
      return replayed;
    }
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
        Math.max(idleTimeoutMs, DEFAULT_RECOVERY_IDLE_TIMEOUT_MS),
        undefined,
        diagnostics
      );
    } catch (error) {
      if (signal?.aborted || (error instanceof DOMException && error.name === 'AbortError')) throw error;
      if (error instanceof ServerSseError && !error.recoverable) throw error;
      diagnostics.event('stream_error');
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

async function replayDurableTurnEvents(input: {
  apiBase: string;
  sessionId: string;
  turnId: string;
  visitorId: string;
  afterSeq: number;
  diagnostics: ClientDiagnostics;
  signal?: AbortSignal;
  fetcher: FetchLike;
  onStatus?: (status: string) => void;
  onSeq: (seq: number) => void;
}): Promise<ChatResponsePayload | null> {
  try {
    const response = await input.fetcher(
      `${input.apiBase}/api/chat/sessions/${input.sessionId}/messages/${input.turnId}/events?afterSeq=${input.afterSeq}`,
      {
        method: 'GET',
        headers: { 'x-bakaut-visitor-id': input.visitorId },
        signal: input.signal
      }
    );
    if (!response.ok) { input.diagnostics.event('stream_error'); return null; }
    const body = await response.json() as {
      events?: Array<{ seq?: unknown; status?: unknown }>;
      result?: ChatResponsePayload | null;
    };
    for (const event of body.events ?? []) {
      const seq = typeof event.seq === 'number' && Number.isSafeInteger(event.seq) ? event.seq : Number(event.seq);
      if (!Number.isSafeInteger(seq) || seq <= input.afterSeq) continue;
      input.onSeq(seq);
      if (typeof event.status === 'string' && event.status.trim()) input.onStatus?.(event.status);
    }
    return body.result && typeof body.result.answer === 'string' && body.result.answer.trim()
      ? body.result
      : null;
  } catch (error) {
    if (input.signal?.aborted || (error instanceof DOMException && error.name === 'AbortError')) throw error;
    input.diagnostics.event('stream_error');
    return null;
  }
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
  const diagnostics = createClientDiagnostics({ apiBase, sessionId, turnId, visitorId, recovery: true });
  diagnostics.event('recovery_started');
  try {
    const result = await recoverChatMessage(
      apiBase, sessionId, turnId, visitorId, handlers, signal,
      diagnosticFetch(options.fetcher ?? fetch, diagnostics),
      options.idleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS,
      diagnostics
    );
    diagnostics.event('recovery_completed');
    return result;
  } catch (error) {
    diagnostics.event(signal?.aborted || (error instanceof DOMException && error.name === 'AbortError') ? 'aborted' : 'stream_error');
    diagnostics.event('recovery_failed');
    throw error;
  } finally {
    diagnostics.finish();
  }
}

export async function streamChatMessage(
  apiBase: string,
  sessionId: string,
  message: string,
  handlers: ChatStreamHandlers,
  signal: AbortSignal | undefined,
  options: ChatStreamOptions
) {
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS;
  const clientMessageId = options.clientMessageId ?? crypto.randomUUID();
  const diagnostics = createClientDiagnostics({ apiBase, sessionId, visitorId: options.visitorId, clientMessageId, recovery: false });
  const fetcher = diagnosticFetch(options.fetcher ?? fetch, diagnostics);
  try {
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
      return await consumeSse(response, handlers, signal, idleTimeoutMs, undefined, diagnostics);
    } catch (error) {
      if (signal?.aborted || (error instanceof DOMException && error.name === 'AbortError')) throw error;
      throw new Error(error instanceof Error && error.message ? error.message : FRIENDLY_FINAL_ERROR);
    }
  } catch (error) {
    diagnostics.event(signal?.aborted || (error instanceof DOMException && error.name === 'AbortError') ? 'aborted' : 'stream_error');
    throw error;
  } finally {
    diagnostics.finish();
  }
}

function diagnosticFetch(fetcher: FetchLike, diagnostics: ClientDiagnostics): FetchLike {
  return async (input, init) => {
    diagnostics.event('request_sent');
    const response = await fetcher(input, init);
    diagnostics.headers(response);
    return response;
  };
}
