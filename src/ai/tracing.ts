export interface TraceEvent {
  type: string;
  sessionId?: string;
  duration?: number;
  model?: string;
  tokens?: { input?: number; output?: number; reasoning?: number };
  metadata?: Record<string, unknown>;
}

const traceListeners: Array<(event: TraceEvent) => void> = [];

export function onTrace(listener: (event: TraceEvent) => void) {
  traceListeners.push(listener);
  return () => {
    const idx = traceListeners.indexOf(listener);
    if (idx >= 0) traceListeners.splice(idx, 1);
  };
}

export function emitTrace(event: TraceEvent) {
  for (const listener of traceListeners) {
    try {
      listener(event);
    } catch {
      // ignore listener errors
    }
  }
  if (process.env.DEBUG_TRACING === 'true') {
    console.log('[Trace]', JSON.stringify(event));
  }
}

export function traceTimer(type: string, sessionId?: string) {
  const start = performance.now();
  return (metadata?: Record<string, unknown>) => {
    const duration = Math.round(performance.now() - start);
    emitTrace({ type, sessionId, duration, metadata });
    return duration;
  };
}
