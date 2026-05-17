import OpenAI from 'openai';
import { config } from '../config.js';
import { assertOpenAIUsageBudget, recordOpenAIUsageOnce } from './openaiUsageGuard.js';

export function createOpenAIClient() {
  if (!config.OPENAI_API_KEY) return null;
  const client = new OpenAI({ apiKey: config.OPENAI_API_KEY, maxRetries: 0 }) as any;
  const createResponse = client.responses.create.bind(client.responses);
  client.responses.create = async (body: Record<string, unknown>, options?: unknown) => {
    await assertOpenAIUsageBudget('openai_response', String(body?.model ?? config.OPENAI_MODEL));
    return createResponse(body, options);
  };
  return client;
}

function isRetryableError(error: unknown): boolean {
  if (error instanceof OpenAI.APIError) {
    return error.status === 408 ||
      error.status === 429 ||
      error.status === 500 ||
      error.status === 502 ||
      error.status === 503 ||
      error.status === 504;
  }
  if (error instanceof OpenAI.APIConnectionError) return true;
  if (error instanceof Error && error.name === 'AbortError') return false;
  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    return message.includes('connection error') ||
      message.includes('fetch failed') ||
      message.includes('econnreset') ||
      message.includes('etimedout') ||
      message.includes('und_err') ||
      message.includes('socket hang up');
  }
  return false;
}

export async function withRetry<T>(fn: () => Promise<T>, maxRetries = 3, signal?: AbortSignal): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (signal?.aborted) throw new Error('Request aborted');
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (!isRetryableError(error) || attempt === maxRetries) throw error;
      const delayMs = Math.min(1000 * Math.pow(2, attempt) + Math.random() * 500, 16000);
      console.warn(`[OpenAI] Retryable error (attempt ${attempt + 1}/${maxRetries}): ${error instanceof Error ? error.message : String(error)}. Retrying in ${Math.round(delayMs)}ms`);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, delayMs);
        signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
      });
    }
  }
  throw lastError;
}

export async function createEmbedding(text: string, signal?: AbortSignal) {
  if (config.NODE_ENV === 'test') return null;
  const client = createOpenAIClient();
  if (!client) return null;
  return withRetry(async () => {
    await assertOpenAIUsageBudget('embedding', config.OPENAI_EMBEDDING_MODEL);
    const response = await client.embeddings.create({
      model: config.OPENAI_EMBEDDING_MODEL,
      input: text.slice(0, 8000)
    }, signal ? { signal } : undefined);
    await recordOpenAIUsageOnce('embedding', config.OPENAI_EMBEDDING_MODEL, response);
    return response.data?.[0]?.embedding as number[] | undefined;
  }, 2, signal);
}
