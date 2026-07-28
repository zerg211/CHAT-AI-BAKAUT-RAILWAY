import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const defaultMaxPages = 80;
const defaultMaxTextChars = 250_000;
const defaultTimeoutMs = 5_000;
const maximumPdfBytes = 8 * 1024 * 1024;
const maxConcurrentChildren = 1;
const maxQueuedChildren = 3;
const childKillGraceMs = 1_000;

export type PdfTextExtractionResult = {
  text: string;
  totalPages: number;
  parsedPages: number;
  truncated: boolean;
};

type PdfTextChildResult =
  | ({ ok: true } & PdfTextExtractionResult)
  | { ok: false; error: 'parse_failed' };

export interface PdfTextChildLike {
  readonly exitCode: number | null;
  readonly pid?: number;
  once(event: 'message', listener: (message: unknown) => void): this;
  once(event: 'error', listener: (error: Error) => void): this;
  once(event: 'exit', listener: (exitCode: number | null, signal: NodeJS.Signals | null) => void): this;
  removeListener(event: 'message', listener: (message: unknown) => void): this;
  removeListener(event: 'error', listener: (error: Error) => void): this;
  removeListener(event: 'exit', listener: (exitCode: number | null, signal: NodeJS.Signals | null) => void): this;
  send(message: unknown, callback?: (error: Error | null) => void): boolean;
  kill(signal?: NodeJS.Signals | number): boolean;
}

export type PdfTextChildFactory = (
  modulePath: string,
  args: readonly string[],
  options: PdfTextChildLaunchOptions
) => PdfTextChildLike;

export type PdfTextChildLaunchOptions = {
  execArgv: string[];
  env: NodeJS.ProcessEnv;
  serialization: 'advanced';
  stdio: ['ignore', 'ignore', 'ignore', 'ipc'];
  windowsHide: true;
};

export type PdfTextExtractionOptions = {
  signal?: AbortSignal;
  timeoutMs?: number;
  maxPages?: number;
  maxTextChars?: number;
  childFactory?: PdfTextChildFactory;
};

export class PdfTextExtractionError extends Error {
  constructor(public readonly code: 'busy' | 'parse_failed' | 'timed_out' | 'too_large' | 'child_failed') {
    super(code);
    this.name = 'PdfTextExtractionError';
  }
}

type ChildSlotWaiter = {
  start: () => void;
  reject: (error: unknown) => void;
  signal?: AbortSignal;
  abortListener?: () => void;
  timeout?: ReturnType<typeof setTimeout>;
};

let activeChildren = 0;
const childWaiters: ChildSlotWaiter[] = [];

function abortError() {
  return new DOMException('The operation was aborted.', 'AbortError');
}

function runNextChild() {
  while (activeChildren < maxConcurrentChildren) {
    const waiter = childWaiters.shift();
    if (!waiter) return;
    if (waiter.signal?.aborted) {
      clearTimeout(waiter.timeout);
      waiter.reject(abortError());
      continue;
    }
    clearTimeout(waiter.timeout);
    if (waiter.abortListener) waiter.signal?.removeEventListener('abort', waiter.abortListener);
    activeChildren += 1;
    waiter.start();
  }
}

function acquireChildSlot(signal: AbortSignal | undefined, deadlineAtMs: number): Promise<() => void> {
  if (signal?.aborted) return Promise.reject(abortError());
  if (activeChildren >= maxConcurrentChildren && childWaiters.length >= maxQueuedChildren) {
    return Promise.reject(new PdfTextExtractionError('busy'));
  }
  return new Promise((resolve, reject) => {
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      activeChildren -= 1;
      runNextChild();
    };
    const waiter: ChildSlotWaiter = {
      signal,
      reject,
      start: () => resolve(release)
    };
    const rejectWhileQueued = (error: unknown) => {
      const index = childWaiters.indexOf(waiter);
      if (index >= 0) childWaiters.splice(index, 1);
      clearTimeout(waiter.timeout);
      if (waiter.abortListener) signal?.removeEventListener('abort', waiter.abortListener);
      reject(error);
    };
    if (signal) {
      waiter.abortListener = () => rejectWhileQueued(abortError());
      signal.addEventListener('abort', waiter.abortListener, { once: true });
    }
    waiter.timeout = setTimeout(
      () => rejectWhileQueued(new PdfTextExtractionError('timed_out')),
      Math.max(1, deadlineAtMs - Date.now())
    );
    childWaiters.push(waiter);
    runNextChild();
  });
}

function childScript() {
  const runningFromTypeScript = import.meta.url.endsWith('.ts');
  return {
    path: fileURLToPath(new URL(runningFromTypeScript ? './pdfTextChild.ts' : './pdfTextChild.js', import.meta.url)),
    execArgv: [
      '--max-old-space-size=256',
      '--max-semi-space-size=32',
      '--stack-size=2048',
      ...(runningFromTypeScript ? ['--import', 'tsx'] : [])
    ]
  };
}

function childEnvironment() {
  const allowedKeys = ['NODE_ENV', 'PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'LANG', 'TZ'];
  return Object.fromEntries(allowedKeys.flatMap((key) =>
    process.env[key] === undefined ? [] : [[key, process.env[key]]]
  ));
}

function defaultChildFactory(modulePath: string, args: readonly string[], options: PdfTextChildLaunchOptions) {
  return spawn(process.execPath, [...options.execArgv, modulePath, ...args], {
    env: options.env,
    serialization: options.serialization,
    stdio: options.stdio,
    windowsHide: options.windowsHide
  });
}

function boundedPositiveInteger(value: number | undefined, maximum: number) {
  if (value === undefined || !Number.isFinite(value)) return maximum;
  return Math.min(maximum, Math.max(1, Math.trunc(value)));
}

function validChildSuccess(
  message: unknown,
  maxPages: number,
  maxTextChars: number
): message is { ok: true } & PdfTextExtractionResult {
  if (!message || typeof message !== 'object') return false;
  const result = message as Partial<{ ok: boolean } & PdfTextExtractionResult>;
  return result.ok === true &&
    typeof result.text === 'string' && result.text.length <= maxTextChars &&
    typeof result.totalPages === 'number' && Number.isFinite(result.totalPages) && result.totalPages >= 0 &&
    typeof result.parsedPages === 'number' && Number.isFinite(result.parsedPages) &&
      result.parsedPages >= 0 && result.parsedPages <= maxPages &&
    typeof result.truncated === 'boolean';
}

type ExtractionOutcome =
  | { result: PdfTextExtractionResult }
  | { error: unknown };

async function extractWithChild(
  bytes: Uint8Array,
  options: PdfTextExtractionOptions,
  timeoutMs: number
) {
  if (options.signal?.aborted) throw abortError();
  const maxPages = boundedPositiveInteger(options.maxPages, defaultMaxPages);
  const maxTextChars = boundedPositiveInteger(options.maxTextChars, defaultMaxTextChars);
  const script = childScript();
  const childFactory = options.childFactory ?? defaultChildFactory;
  const child = childFactory(script.path, [], {
    execArgv: script.execArgv,
    env: childEnvironment(),
    serialization: 'advanced',
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    windowsHide: true
  });

  return new Promise<PdfTextExtractionResult>((resolve, reject) => {
    let settled = false;
    let pendingOutcome: ExtractionOutcome | undefined;
    let terminationOutcome: ExtractionOutcome | undefined;
    let killGraceTimeout: ReturnType<typeof setTimeout> | undefined;

    const cleanup = () => {
      clearTimeout(timeout);
      clearTimeout(killGraceTimeout);
      options.signal?.removeEventListener('abort', onAbort);
      child.removeListener('message', onMessage);
      child.removeListener('error', onError);
      child.removeListener('exit', onExit);
    };
    const finalize = (outcome: ExtractionOutcome) => {
      if (settled) return;
      settled = true;
      cleanup();
      if ('result' in outcome) resolve(outcome.result);
      else reject(outcome.error);
    };
    const requestTermination = (outcome: ExtractionOutcome) => {
      if (settled || terminationOutcome) return;
      terminationOutcome = outcome;
      clearTimeout(timeout);
      try {
        child.kill('SIGKILL');
      } catch {
        finalize(outcome);
        return;
      }
      if (child.exitCode !== null || child.pid === undefined) {
        finalize(outcome);
        return;
      }
      killGraceTimeout = setTimeout(() => finalize(outcome), childKillGraceMs);
      killGraceTimeout.unref?.();
    };
    const onMessage = (message: unknown) => {
      if (settled || terminationOutcome || pendingOutcome) return;
      const result = message as PdfTextChildResult;
      if (validChildSuccess(result, maxPages, maxTextChars)) {
        pendingOutcome = {
          result: {
            text: result.text,
            totalPages: result.totalPages,
            parsedPages: result.parsedPages,
            truncated: result.truncated
          }
        };
        return;
      }
      if (result && typeof result === 'object' && result.ok === false && result.error === 'parse_failed') {
        pendingOutcome = { error: new PdfTextExtractionError('parse_failed') };
        return;
      }
      requestTermination({ error: new PdfTextExtractionError('child_failed') });
    };
    const onError = () => {
      requestTermination({ error: new PdfTextExtractionError('child_failed') });
    };
    const onExit = (exitCode: number | null) => {
      if (terminationOutcome) {
        finalize(terminationOutcome);
        return;
      }
      if (exitCode === 0 && pendingOutcome) {
        finalize(pendingOutcome);
        return;
      }
      finalize({ error: new PdfTextExtractionError('child_failed') });
    };
    const onAbort = () => requestTermination({ error: abortError() });
    const timeout = setTimeout(
      () => requestTermination({ error: new PdfTextExtractionError('timed_out') }),
      Math.max(1, timeoutMs)
    );

    child.once('message', onMessage);
    child.once('error', onError);
    child.once('exit', onExit);
    if (options.signal?.aborted) onAbort();
    else options.signal?.addEventListener('abort', onAbort, { once: true });
    if (!terminationOutcome) {
      try {
        child.send({ bytes, maxPages, maxTextChars }, (error) => {
          if (error) requestTermination({ error: new PdfTextExtractionError('child_failed') });
        });
      } catch {
        requestTermination({ error: new PdfTextExtractionError('child_failed') });
      }
    }
  });
}

export async function extractPdfText(bytes: Uint8Array, options: PdfTextExtractionOptions = {}) {
  if (bytes.byteLength > maximumPdfBytes) throw new PdfTextExtractionError('too_large');
  const timeoutMs = boundedPositiveInteger(options.timeoutMs, defaultTimeoutMs);
  const deadlineAtMs = Date.now() + timeoutMs;
  const release = await acquireChildSlot(options.signal, deadlineAtMs);
  try {
    const remainingMs = deadlineAtMs - Date.now();
    if (remainingMs <= 0) throw new PdfTextExtractionError('timed_out');
    return await extractWithChild(bytes, options, remainingMs);
  } finally {
    release();
  }
}
