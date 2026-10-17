import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

export type TimingKind = 'model' | 'provider' | 'budget' | 'database' | 'pool_wait' | 'http' | 'retry';
type TimingOutcome = 'ok' | 'error';
export type TimingFields = {
  model?: string;
  reasoningEffort?: string;
  maxOutputTokens?: number;
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  totalTokens?: number;
  statusCode?: number;
  attempt?: number;
  durationMs?: number;
};
export type TimingLog = Record<string, unknown>;
type TimingSink = (event: TimingLog) => void;
type TimingRun = {
  sessionId: string;
  turnId: string;
  executionId: string;
  startedAt: number;
  sink: TimingSink;
  emitted: number;
  dropped: number;
  nextSpan: number;
  activeSpans: number;
  counts: Partial<Record<TimingKind, number>>;
  totalMs: Partial<Record<TimingKind, number>>;
};
type TimingContext = { run: TimingRun; stage: string; parentSpanId?: number };
const timingContext = new AsyncLocalStorage<TimingContext>();
const maxEventsPerExecution = 400;

// Only application labels and numeric counters enter this module. No payloads,
// SQL, URLs, error text, user agents or conversation text belong in timing logs.
function emit(run: TimingRun, event: TimingLog, terminal = false) {
  if (!terminal && run.emitted >= maxEventsPerExecution) { run.dropped += 1; return; }
  run.emitted += 1;
  try {
    run.sink({ event: 'turn_timing', sessionId: run.sessionId, turnId: run.turnId,
      executionId: run.executionId, ...event });
  } catch { /* Diagnostics must not alter the operation being measured. */ }
}

function defaultSink(event: TimingLog) { console.info(JSON.stringify(event)); }
function elapsed(startedAt: number) { return Math.max(0, Math.round((performance.now() - startedAt) * 10) / 10); }

export async function runWithTurnTiming<T>(identity: {sessionId: string; turnId: string},
  operation: () => Promise<T>, sink: TimingSink = defaultSink): Promise<T> {
  const run: TimingRun = { ...identity, executionId: randomUUID(), startedAt: performance.now(),
    sink, emitted: 0, dropped: 0, nextSpan: 0, activeSpans: 0, counts: {}, totalMs: {} };
  return timingContext.run({run, stage: 'turn'}, async () => {
    let outcome: TimingOutcome = 'error';
    emit(run, {type: 'start', at: new Date().toISOString()});
    try { const result = await operation(); outcome = 'ok'; return result; }
    finally {
      emit(run, {type: 'complete', outcome, durationMs: elapsed(run.startedAt),
        counts: {...run.counts}, cumulativeMs: {...run.totalMs}, activeSpans: run.activeSpans,
        droppedEvents: run.dropped}, true);
    }
  });
}

export function withTimingStage<T>(stage: string, operation: () => T): T {
  const context = timingContext.getStore();
  return context ? timingContext.run({...context, stage}, operation) : operation();
}

export function startTimingSpan(kind: TimingKind, name: string, fields: TimingFields = {}) {
  const context = timingContext.getStore();
  if (!context) return { run: <T>(operation: () => T) => operation(), finish: (_outcome: TimingOutcome, _fields?: TimingFields) => {} };
  const {run} = context;
  const startedAt = performance.now();
  const spanId = ++run.nextSpan;
  const offsetMs = elapsed(run.startedAt);
  run.activeSpans += 1;
  run.counts[kind] = (run.counts[kind] ?? 0) + 1;
  let finished = false;
  return {
    run: <T>(operation: () => T): T => timingContext.run({...context, parentSpanId: spanId}, operation),
    finish(outcome: TimingOutcome, completionFields: TimingFields = {}) {
      if (finished) return;
      finished = true;
      run.activeSpans -= 1;
      const durationMs = elapsed(startedAt);
      run.totalMs[kind] = Math.round(((run.totalMs[kind] ?? 0) + durationMs) * 10) / 10;
      emit(run, {type: 'span', spanId, parentSpanId: context.parentSpanId ?? null,
        kind, name, stage: context.stage, offsetMs, ...fields, ...completionFields, durationMs, outcome});
    }
  };
}

export async function timeOperation<T>(kind: TimingKind, name: string, operation: () => Promise<T>,
  fields?: TimingFields): Promise<T> {
  const span = startTimingSpan(kind, name, fields);
  return span.run(async () => {
    try { const result = await operation(); span.finish('ok'); return result; }
    catch (error) { span.finish('error'); throw error; }
  });
}

export function providerUsageFields(response: unknown): TimingFields {
  const usage = (response as {usage?: Record<string, unknown>} | null)?.usage;
  if (!usage) return {};
  const input = usage.input_tokens_details as Record<string, unknown> | undefined;
  const output = usage.output_tokens_details as Record<string, unknown> | undefined;
  const candidates = {inputTokens: usage.input_tokens ?? usage.prompt_tokens, outputTokens: usage.output_tokens,
    totalTokens: usage.total_tokens, cachedInputTokens: input?.cached_tokens, reasoningTokens: output?.reasoning_tokens};
  return Object.fromEntries(Object.entries(candidates).filter(([, value]) =>
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0));
}

export function recordTimingStage(phase: string, eventType: string, payload: Record<string, unknown>) {
  const context = timingContext.getStore();
  if (!context) return;
  // Deliberately project a small allowlist instead of forwarding private traces.
  const numeric: Record<string, number> = {};
  for (const key of ['attempt', 'attemptCount', 'durationMs', 'elapsedMs', 'remainingTurnMs', 'timeoutMs', 'outputTokenCap']) {
    const value = payload[key];
    if (typeof value === 'number' && Number.isFinite(value)) numeric[key] = value;
  }
  const tool = typeof payload.tool === 'string' ? payload.tool : undefined;
  emit(context.run, {type: 'stage', phase, eventType, offsetMs: elapsed(context.run.startedAt), tool, ...numeric});
}
