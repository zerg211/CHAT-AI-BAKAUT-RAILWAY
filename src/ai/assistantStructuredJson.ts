import type { Message } from '../shared/types.js';
import { withRetry } from './openaiClient.js';
import { extractResponseText, safeError } from './responseUtils.js';

const MIN_JSON_OUTPUT_TOKENS = 2400;
const JSON_RETRY_OUTPUT_TOKEN_MIN = 12000;

type AssistantStructuredJsonClient = {
  responses: {
    create: (body: Record<string, unknown>, options?: { signal?: AbortSignal }) => Promise<unknown>;
  };
} | null;

export function jsonOutputTokenLimit(value: number) {
  return Math.max(value, MIN_JSON_OUTPUT_TOKENS);
}

export function truncateForAI(value: unknown, contentLimit: number) {
  const content = String(value ?? '').trim();
  return content.length > contentLimit
    ? `${content.slice(0, contentLimit).trim()}...`
    : content;
}

export function compactHistoryForAI(history: Message[], limit: number, contentLimit: number) {
  return history.slice(-limit).map((message) => ({
    role: message.role,
    content: truncateForAI(message.content, contentLimit)
  }));
}

function stripMarkdownJsonFence(value: string) {
  let cleaned = value.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.slice(3);
    if (cleaned.slice(0, 4).toLowerCase() === 'json') {
      cleaned = cleaned.slice(4);
    }
    cleaned = cleaned.trimStart();
  }
  if (cleaned.endsWith('```')) {
    cleaned = cleaned.slice(0, -3).trimEnd();
  }
  return cleaned.trim();
}

export function parseJsonObject(outputText: string | undefined, stage: string) {
  const cleaned = stripMarkdownJsonFence(String(outputText ?? ''));
  if (!cleaned) throw new Error(`${stage} returned empty JSON`);
  try {
    return JSON.parse(cleaned);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    throw new Error(`${stage} returned invalid JSON: ${message}`);
  }
}

export function responseTextForJson(response: unknown) {
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

export async function createStructuredJsonResponse(
  client: AssistantStructuredJsonClient,
  request: Record<string, unknown>,
  stage: string,
  signal?: AbortSignal
) {
  if (!client) throw new Error('OpenAI client is not configured');
  const send = (body: Record<string, unknown>) =>
    withRetry(() => client.responses.create(body, signal ? { signal } : undefined), 2, signal);
  const response = await send(request);
  try {
    return { response, parsed: parseJsonObject(responseTextForJson(response), stage) };
  } catch (error) {
    if (signal?.aborted) throw error;
    console.warn(`[${stage}] Structured JSON parse failed; retrying with a larger output budget`, safeError(error));
    const currentMax = Number(request.max_output_tokens ?? 0);
    const retryResponse = await send({
      ...request,
      max_output_tokens: Math.max(currentMax * 2, JSON_RETRY_OUTPUT_TOKEN_MIN)
    });
    return { response: retryResponse, parsed: parseJsonObject(responseTextForJson(retryResponse), stage) };
  }
}
