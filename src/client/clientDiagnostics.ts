/** Advisory transport observations, never evidence that a person read an answer. */
export const CLIENT_DIAGNOSTIC_EVENTS = [
  'request_sent', 'headers_received', 'turn_identified', 'status_received',
  'first_answer_received', 'done_received', 'stream_closed', 'stream_error',
  'recovery_started', 'recovery_completed', 'recovery_failed', 'aborted'
] as const;
export type ClientDiagnosticEventType = typeof CLIENT_DIAGNOSTIC_EVENTS[number];
export type ClientDiagnosticReport = {
  clientMessageId?: string;
  turnId?: string;
  requestId?: string;
  recovery: boolean;
  events: Array<{ type: ClientDiagnosticEventType; offsetMs: number; statusCode?: number }>;
  droppedEvents: number;
};
export const MAX_CLIENT_DIAGNOSTIC_EVENTS = 32;
const MAX_OFFSET_MS = 3_600_000;
const uuid = (value: unknown): string | undefined => typeof value === 'string'
  && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  ? value : undefined;

type Input = {
  apiBase: string;
  sessionId: string;
  visitorId: string;
  clientMessageId?: string;
  turnId?: string;
  recovery: boolean;
};

type Dependencies = {
  now?: () => number;
  /** Injection for isolated offline tests only; production always uses browser global fetch. */
  reporter?: typeof fetch;
};

export function createClientDiagnostics(input: Input, dependencies: Dependencies = {}) {
  const now = dependencies.now ?? (() => performance.now());
  const started = now();
  const report: ClientDiagnosticReport = {
    recovery: input.recovery, events: [], droppedEvents: 0,
    ...(uuid(input.clientMessageId) ? { clientMessageId: uuid(input.clientMessageId) } : {})
  };
  let finished = false;
  const once = new Set<ClientDiagnosticEventType>();
  function event(type: ClientDiagnosticEventType, statusCode?: number) {
    if (finished || !CLIENT_DIAGNOSTIC_EVENTS.includes(type)) return;
    if (['status_received', 'first_answer_received', 'turn_identified', 'aborted'].includes(type)) {
      if (once.has(type)) return;
      once.add(type);
    }
    if (report.events.length >= MAX_CLIENT_DIAGNOSTIC_EVENTS) {
      report.droppedEvents = Math.min(100_000, report.droppedEvents + 1);
      return;
    }
    const elapsed = now() - started;
    const offsetMs = Number.isFinite(elapsed) ? Math.min(MAX_OFFSET_MS, Math.max(0, Math.round(elapsed))) : 0;
    report.events.push({ type, offsetMs,
      ...(Number.isInteger(statusCode) && statusCode! >= 100 && statusCode! <= 599 ? { statusCode } : {})
    });
  }
  function identifyTurn(value: unknown) {
    const id = uuid(value);
    if (!id || report.turnId) return;
    report.turnId = id;
    event('turn_identified');
  }
  identifyTurn(input.turnId);
  return {
    event,
    identifyTurn,
    headers(response: Response) {
      event('headers_received', response.status);
      const id = uuid(response.headers.get('x-request-id'));
      if (id && !report.requestId) report.requestId = id;
      identifyTurn(response.headers.get('x-chat-turn-id'));
    },
    finish() {
      if (finished) return;
      finished = true;
      // No transport outside the browser, no retries, no await in the business path.
      const reporter = dependencies.reporter ?? (typeof document !== 'undefined' ? globalThis.fetch : undefined);
      if (!reporter || !uuid(input.sessionId)) return;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        const controller = new AbortController();
        timeout = setTimeout(() => controller.abort(), 2_000);
        void reporter(`${input.apiBase}/api/chat/sessions/${input.sessionId}/diagnostics`, {
          method: 'POST', keepalive: true,
          headers: { 'content-type': 'application/json', 'x-bakaut-visitor-id': input.visitorId },
          body: JSON.stringify(report), signal: controller.signal
        }).catch(() => undefined).finally(() => clearTimeout(timeout));
      } catch {
        clearTimeout(timeout);
      }
    }
  };
}

export type ClientDiagnostics = ReturnType<typeof createClientDiagnostics>;
