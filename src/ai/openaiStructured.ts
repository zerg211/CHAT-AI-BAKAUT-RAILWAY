import { config } from '../config.js';
import { createOpenAIClient, withRetry } from './openaiClient.js';
import { recordOpenAIUsageOnce } from './openaiUsageGuard.js';
import { extractResponseText, safeError } from './responseUtils.js';

const JSON_RETRY_OUTPUT_TOKEN_MIN = 1800;

export function structuredJsonRetryOutputTokenLimit(currentValue: unknown, configuredCap?: number) {
  const current = Number(currentValue);
  const normalizedCurrent = Number.isFinite(current) && current > 0
    ? Math.floor(current)
    : JSON_RETRY_OUTPUT_TOKEN_MIN;
  const normalizedCap = Number.isFinite(configuredCap) && Number(configuredCap) > 0
    ? Math.floor(Number(configuredCap))
    : normalizedCurrent;
  return Math.min(Math.max(normalizedCurrent, JSON_RETRY_OUTPUT_TOKEN_MIN), normalizedCap);
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
}) {
  const client = createOpenAIClient();
  if (!client) throw new Error('OpenAI client is not configured');
  const send = (body: Record<string, unknown>) =>
    withRetry(() => client.responses.create(body as any, input.signal ? { signal: input.signal } : undefined), 2, input.signal);

  const response = await send(input.request);
  await recordOpenAIUsageOnce(input.stage, String(input.request.model ?? config.OPENAI_MODEL), response);
  try {
    return { response, parsed: parseJsonObject(responseTextForJson(response), input.stage) };
  } catch (error) {
    if (input.signal?.aborted) throw error;
    console.warn(`[${input.stage}] Structured JSON parse failed; retrying within the configured output budget`, safeError(error));
    const retryRequest: Record<string, unknown> = {
      ...input.request,
      max_output_tokens: structuredJsonRetryOutputTokenLimit(
        input.request.max_output_tokens,
        input.retryOutputTokenCap
      )
    };
    const retryResponse = await send(retryRequest);
    await recordOpenAIUsageOnce(`${input.stage}_retry`, String(retryRequest.model ?? config.OPENAI_MODEL), retryResponse);
    return { response: retryResponse, parsed: parseJsonObject(responseTextForJson(retryResponse), input.stage) };
  }
}
