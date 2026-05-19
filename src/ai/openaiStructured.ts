import { config } from '../config.js';
import { createOpenAIClient, withRetry } from './openaiClient.js';
import { recordOpenAIUsageOnce } from './openaiUsageGuard.js';
import { extractResponseText, safeError } from './responseUtils.js';

const JSON_RETRY_OUTPUT_TOKEN_MIN = 1800;

export function parseJsonObject(text: string, stage: string): Record<string, unknown> {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  const candidate = fenced || trimmed;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error(`${stage} did not return a JSON object`);
  const raw = candidate.slice(start, end + 1);
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${stage} JSON root must be an object`);
  }
  return parsed as Record<string, unknown>;
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
    console.warn(`[${input.stage}] Structured JSON parse failed; retrying with larger output budget`, safeError(error));
    const currentMax = Number(input.request.max_output_tokens ?? 0);
    const retryRequest: Record<string, unknown> = {
      ...input.request,
      max_output_tokens: Math.max(currentMax * 2, JSON_RETRY_OUTPUT_TOKEN_MIN)
    };
    const retryResponse = await send(retryRequest);
    await recordOpenAIUsageOnce(`${input.stage}_retry`, String(retryRequest.model ?? config.OPENAI_MODEL), retryResponse);
    return { response: retryResponse, parsed: parseJsonObject(responseTextForJson(retryResponse), input.stage) };
  }
}
