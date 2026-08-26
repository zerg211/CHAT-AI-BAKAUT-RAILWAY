import { config } from '../config.js';
import { createOpenAIClient, withRetry } from './openaiClient.js';
import { recordOpenAIUsageOnce } from './openaiUsageGuard.js';
import { extractResponseText, safeError } from './responseUtils.js';

const JSON_RETRY_OUTPUT_TOKEN_MIN = 1800;

export type StructuredJsonRetryDecision =
  | { retry: true; reason: 'retry_allowed'; remainingMs?: number }
  | { retry: false; reason: 'signal_aborted' | 'insufficient_time_budget' | 'output_limit_exhausted'; remainingMs?: number };

export function structuredJsonRetryDecision(input: {
  signalAborted?: boolean;
  deadlineAtMs?: number;
  minRemainingMs?: number;
  nowMs?: number;
}): StructuredJsonRetryDecision {
  if (input.signalAborted) return { retry: false, reason: 'signal_aborted' };
  if (input.deadlineAtMs === undefined) return { retry: true, reason: 'retry_allowed' };
  const remainingMs = Math.max(0, input.deadlineAtMs - (input.nowMs ?? Date.now()));
  if (remainingMs < Math.max(1, input.minRemainingMs ?? 1)) {
    return { retry: false, reason: 'insufficient_time_budget', remainingMs };
  }
  return { retry: true, reason: 'retry_allowed', remainingMs };
}

export class StructuredJsonRetrySkippedError extends Error {
  readonly code = 'structured_json_retry_skipped';

  constructor(
    readonly retryReason: Exclude<StructuredJsonRetryDecision['reason'], 'retry_allowed'>,
    readonly remainingMs: number | undefined,
    options?: { cause?: unknown }
  ) {
    super(`Structured JSON retry skipped: ${retryReason}`, options);
    this.name = 'StructuredJsonRetrySkippedError';
  }
}

export class StructuredJsonDeadlineExceededError extends Error {
  readonly code = 'structured_json_deadline_exceeded';

  constructor(readonly deadlineAtMs: number, options?: { cause?: unknown }) {
    super('Structured JSON request exceeded its deadline', options);
    this.name = 'StructuredJsonDeadlineExceededError';
  }
}

export function structuredJsonRetryOutputTokenLimit(currentValue: unknown, configuredCap?: number) {
  const current = Number(currentValue);
  const normalizedCurrent = Number.isFinite(current) && current > 0
    ? Math.floor(current)
    : JSON_RETRY_OUTPUT_TOKEN_MIN;
  const normalizedCap = Number.isFinite(configuredCap) && Number(configuredCap) > 0
    ? Math.floor(Number(configuredCap))
    : normalizedCurrent;
  if (normalizedCap <= normalizedCurrent) return normalizedCurrent;
  return Math.min(
    Math.max(JSON_RETRY_OUTPUT_TOKEN_MIN, Math.ceil(normalizedCurrent * 1.5)),
    normalizedCap
  );
}

export function structuredJsonOutputLimitExhausted(response: unknown, requestedMaxOutputTokens: unknown) {
  const value = response && typeof response === 'object'
    ? response as {
        status?: unknown;
        incomplete_details?: { reason?: unknown } | null;
        usage?: { output_tokens?: unknown } | null;
      }
    : {};
  if (value.incomplete_details?.reason === 'max_output_tokens') return true;
  const requested = Number(requestedMaxOutputTokens);
  const used = Number(value.usage?.output_tokens);
  return value.status === 'incomplete' &&
    Number.isFinite(requested) && requested > 0 &&
    Number.isFinite(used) && used >= requested;
}

function stripMarkdownJsonFence(text: string) {
  const trimmed = text.trim();
  if (!trimmed.startsWith('```')) return trimmed;
  const firstLineEnd = trimmed.indexOf('\n');
  if (firstLineEnd < 0) return trimmed;
  const closingFence = trimmed.lastIndexOf('```');
  const bodyEnd = closingFence > firstLineEnd ? closingFence : trimmed.length;
  return trimmed.slice(firstLineEnd + 1, bodyEnd).trim();
}

function findBalancedJsonObject(text: string, start: number) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  return null;
}

export function parseJsonObject(text: string, stage: string): Record<string, unknown> {
  const candidate = stripMarkdownJsonFence(text);
  let start = candidate.indexOf('{');
  let lastError: unknown;
  while (start >= 0) {
    const raw = findBalancedJsonObject(candidate, start);
    if (!raw) break;
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error(`${stage} JSON root must be an object`);
      }
      return parsed as Record<string, unknown>;
    } catch (error) {
      lastError = error;
      start = candidate.indexOf('{', start + 1);
    }
  }
  if (lastError) throw lastError;
  throw new Error(`${stage} did not return a JSON object`);
}

function responseTextForJson(response: unknown) {
  const value = response as { output_text?: string; output?: Array<{ content?: Array<{ text?: string }> }> };
  try {
    if (typeof value.output_text === 'string' && value.output_text.trim()) return value.output_text;
  } catch {
    // Some SDK response helpers throw when the response was incomplete.
  }
  const directText = value.output?.[0]?.content?.[0]?.text;
  if (typeof directText === 'string' && directText.trim()) return directText;
  return extractResponseText(response);
}

export async function createStructuredJsonResponse(input: {
  request: Record<string, unknown>;
  stage: string;
  signal?: AbortSignal;
  retryOutputTokenCap?: number;
  deadlineAtMs?: number;
  minRetryRemainingMs?: number;
  transportMaxRetries?: number;
}) {
  const client = createOpenAIClient();
  if (!client) throw new Error('OpenAI client is not configured');
  const deadlineSignal = input.deadlineAtMs === undefined
    ? undefined
    : AbortSignal.timeout(Math.max(1, input.deadlineAtMs - Date.now()));
  const requestSignal = deadlineSignal && input.signal
    ? AbortSignal.any([input.signal, deadlineSignal])
    : deadlineSignal ?? input.signal;
  const send = (body: Record<string, unknown>) =>
    withRetry(
      () => client.responses.create(body as any, requestSignal ? { signal: requestSignal } : undefined),
      input.transportMaxRetries ?? 2,
      requestSignal
    );
  const sendWithinDeadline = async (body: Record<string, unknown>) => {
    try {
      return await send(body);
    } catch (error) {
      if (deadlineSignal?.aborted && !input.signal?.aborted) {
        throw new StructuredJsonDeadlineExceededError(input.deadlineAtMs!, { cause: error });
      }
      throw error;
    }
  };

  const response = await sendWithinDeadline(input.request);
  await recordOpenAIUsageOnce(input.stage, String(input.request.model ?? config.OPENAI_MODEL), response);
  try {
    return { response, parsed: parseJsonObject(responseTextForJson(response), input.stage) };
  } catch (error) {
    if (deadlineSignal?.aborted && !input.signal?.aborted) {
      throw new StructuredJsonDeadlineExceededError(input.deadlineAtMs!, { cause: error });
    }
    const retryOutputTokens = structuredJsonRetryOutputTokenLimit(
      input.request.max_output_tokens,
      input.retryOutputTokenCap
    );
    const currentOutputTokens = Number(input.request.max_output_tokens);
    if (
      structuredJsonOutputLimitExhausted(response, input.request.max_output_tokens) &&
      (!Number.isFinite(currentOutputTokens) || retryOutputTokens <= currentOutputTokens)
    ) {
      throw new StructuredJsonRetrySkippedError('output_limit_exhausted', undefined, { cause: error });
    }
    const retryDecision = structuredJsonRetryDecision({
      signalAborted: input.signal?.aborted,
      deadlineAtMs: input.deadlineAtMs,
      minRemainingMs: input.minRetryRemainingMs
    });
    if (!retryDecision.retry) {
      throw new StructuredJsonRetrySkippedError(
        retryDecision.reason,
        retryDecision.remainingMs,
        { cause: error }
      );
    }
    console.warn(`[${input.stage}] Structured JSON parse failed; retrying within the configured output budget`, safeError(error));
    const retryRequest: Record<string, unknown> = {
      ...input.request,
      max_output_tokens: retryOutputTokens
    };
    const retryResponse = await sendWithinDeadline(retryRequest);
    await recordOpenAIUsageOnce(`${input.stage}_retry`, String(retryRequest.model ?? config.OPENAI_MODEL), retryResponse);
    return { response: retryResponse, parsed: parseJsonObject(responseTextForJson(retryResponse), input.stage) };
  }
}
