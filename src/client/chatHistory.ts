import {
  normalizePublicHistoryMessages,
  type PublicChatHistoryMessage
} from '../shared/publicChatHistory.js';

export type RestoredChatMessage = PublicChatHistoryMessage;
export type ChatHydrationState = 'restoring' | 'ready' | 'error';
export type RestoredPendingTurnStatus =
  | 'received'
  | 'need_extracted'
  | 'planned'
  | 'answering'
  | 'completed'
  | 'failed'
  | 'recovered';

export type RestoredPendingTurn = {
  turnId: string;
  status: RestoredPendingTurnStatus;
  stage: string | null;
  deadlineAt: string | null;
  terminal: boolean;
  resultState: 'pending' | 'ready' | 'failed';
};

export type LoadedChatHistory = {
  messages: RestoredChatMessage[];
  pendingTurn: RestoredPendingTurn | null;
  leadOfferConsumed?: true;
};

export interface SessionIdStorage {
  getItem(key: string): string | null;
  removeItem(key: string): void;
}

export function savedSessionHeartbeatOutcome(
  response: Pick<Response, 'ok' | 'status'> | null
): 'reuse' | 'abandon' | 'retry' {
  if (response?.ok) return 'reuse';
  if (response?.status === 404) return 'abandon';
  return 'retry';
}

let sessionCreationInFlight: Promise<string> | null = null;

export async function runSessionCreationSingleFlight(create: () => Promise<string>) {
  if (sessionCreationInFlight) return sessionCreationInFlight;
  const creation = create();
  sessionCreationInFlight = creation;
  try {
    return await creation;
  } finally {
    if (sessionCreationInFlight === creation) sessionCreationInFlight = null;
  }
}

export interface WritableStorage extends SessionIdStorage {
  setItem(key: string, value: string): void;
}

export type SavedChatRestoration =
  | {
      kind: 'restored';
      sessionId: string;
      messages: RestoredChatMessage[];
      leadRequested: boolean;
      pendingTurn: RestoredPendingTurn | null;
    }
  | { kind: 'stale'; sessionId: null }
  | { kind: 'superseded'; sessionId: string | null };

export class ChatHistoryNotFoundError extends Error {
  constructor() {
    super('Saved chat history was not found');
    this.name = 'ChatHistoryNotFoundError';
  }
}

/**
 * Finds the persisted assistant answer for a user message whose live stream
 * broke. The stream can die (flaky network, long thinking) while the server
 * still completes the turn, so the answer already exists in history.
 * Returns the matching assistant message, or null when there is nothing
 * safe to show (no match, empty answer, or the turn is still running —
 * callers can check pendingTurn separately).
 */
export function findCompletedAnswerForRetry(
  messages: RestoredChatMessage[],
  userText: string
): RestoredChatMessage | null {
  const wanted = userText.trim();
  if (!wanted) return null;
  let userSeen = false;
  let candidate: RestoredChatMessage | null = null;
  for (const message of messages) {
    if (message.role === 'user' && message.content.trim() === wanted) {
      userSeen = true;
      candidate = null;
    } else if (userSeen && message.role === 'assistant') {
      if (message.content.trim()) candidate = message;
    }
  }
  return candidate;
}

function trimTrailingSlashes(value: string) {
  let result = value;
  while (result.endsWith('/')) result = result.slice(0, -1);
  return result;
}

function sessionMessagesUrl(apiBase: string, sessionId: string) {
  return `${trimTrailingSlashes(apiBase)}/api/chat/sessions/${encodeURIComponent(sessionId)}/messages`;
}

export function initialChatHydrationState(savedSessionId: string | null): ChatHydrationState {
  return savedSessionId ? 'restoring' : 'ready';
}

export function safeBrowserStorage(kind: 'localStorage' | 'sessionStorage'): WritableStorage | null {
  try {
    return typeof window === 'undefined' ? null : window[kind];
  } catch {
    return null;
  }
}

export function safeStorageGet(storage: Pick<SessionIdStorage, 'getItem'> | null, key: string) {
  try {
    return storage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

export function safeStorageRemove(storage: Pick<SessionIdStorage, 'removeItem'> | null, key: string) {
  try {
    storage?.removeItem(key);
    return storage !== null;
  } catch {
    return false;
  }
}

export function safeStorageSet(storage: Pick<WritableStorage, 'setItem'> | null, key: string, value: string) {
  try {
    storage?.setItem(key, value);
    return storage !== null;
  } catch {
    return false;
  }
}

export function clearSavedSessionIfMatches(storage: SessionIdStorage | null, expectedSessionId: string) {
  if (safeStorageGet(storage, 'bakaut_session_id') !== expectedSessionId) return false;
  return safeStorageRemove(storage, 'bakaut_session_id');
}

export function abandonSavedChat(storage: SessionIdStorage | null, expectedSessionId: string) {
  return {
    cleared: clearSavedSessionIfMatches(storage, expectedSessionId),
    hydrationState: 'ready' as const
  };
}

export async function loadChatHistory(
  apiBase: string,
  sessionId: string,
  visitorId: string,
  fetcher: typeof fetch = fetch
): Promise<RestoredChatMessage[]> {
  return (await loadChatHistoryState(apiBase, sessionId, visitorId, fetcher)).messages;
}

const pendingTurnStatuses = new Set<RestoredPendingTurnStatus>([
  'received',
  'need_extracted',
  'planned',
  'answering',
  'completed',
  'failed',
  'recovered'
]);

function normalizePendingTurn(value: unknown): RestoredPendingTurn | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.turnId !== 'string' ||
    !candidate.turnId.trim() ||
    typeof candidate.status !== 'string' ||
    !pendingTurnStatuses.has(candidate.status as RestoredPendingTurnStatus)
  ) return null;
  const status = candidate.status as RestoredPendingTurnStatus;
  const terminal = status === 'completed' || status === 'failed' || status === 'recovered';
  const resultState = candidate.resultState === 'ready'
    ? 'ready'
    : terminal
      ? 'failed'
      : 'pending';
  return {
    turnId: candidate.turnId,
    status,
    stage: typeof candidate.stage === 'string' ? candidate.stage : null,
    deadlineAt: typeof candidate.deadlineAt === 'string' ? candidate.deadlineAt : null,
    terminal,
    resultState
  };
}

export async function loadChatHistoryState(
  apiBase: string,
  sessionId: string,
  visitorId: string,
  fetcher: typeof fetch = fetch
): Promise<LoadedChatHistory> {
  const response = await fetcher(sessionMessagesUrl(apiBase, sessionId), {
    headers: {
      Accept: 'application/json',
      'x-bakaut-visitor-id': visitorId
    }
  });
  if (response.status === 404) throw new ChatHistoryNotFoundError();
  if (!response.ok) throw new Error(`History request failed: ${response.status}`);
  const payload = await response.json() as {
    messages?: unknown;
    pendingTurn?: unknown;
    leadOfferConsumed?: unknown;
  };
  return {
    messages: normalizePublicHistoryMessages(payload.messages),
    pendingTurn: normalizePendingTurn(payload.pendingTurn),
    ...(payload.leadOfferConsumed === true ? { leadOfferConsumed: true as const } : {})
  };
}

function staleRestorationResult(storage: SessionIdStorage | null, expectedSessionId: string): SavedChatRestoration {
  if (clearSavedSessionIfMatches(storage, expectedSessionId)) {
    return { kind: 'stale', sessionId: null };
  }
  return { kind: 'superseded', sessionId: safeStorageGet(storage, 'bakaut_session_id') };
}

export async function restoreSavedChatSession(
  apiBase: string,
  savedSessionId: string,
  visitorId: string,
  storage: SessionIdStorage | null,
  fetcher: typeof fetch = fetch
): Promise<SavedChatRestoration> {
  try {
    const history = await loadChatHistoryState(apiBase, savedSessionId, visitorId, fetcher);
    const latestAssistantMessage = [...history.messages]
      .reverse()
      .find((message) => message.role === 'assistant');
    return {
      kind: 'restored',
      sessionId: savedSessionId,
      messages: history.messages,
      leadRequested: latestAssistantMessage?.leadRequested === true && history.leadOfferConsumed !== true,
      pendingTurn: history.pendingTurn
    };
  } catch (error) {
    if (error instanceof ChatHistoryNotFoundError) {
      return staleRestorationResult(storage, savedSessionId);
    }
    throw error;
  }
}
