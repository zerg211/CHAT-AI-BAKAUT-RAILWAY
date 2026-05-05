import OpenAI from 'openai';
import { config } from '../config.js';

export function createOpenAIClient() {
  if (!config.OPENAI_API_KEY) return null;
  return new OpenAI({ apiKey: config.OPENAI_API_KEY, maxRetries: 0 }) as any;
}

function isRetryableError(error: unknown): boolean {
  if (error instanceof OpenAI.APIError) {
    return error.status === 429 || error.status === 500 || error.status === 502 || error.status === 503;
  }
  if (error instanceof Error && error.name === 'AbortError') return false;
  if (error instanceof Error && (error.message.includes('ECONNRESET') || error.message.includes('ETIMEDOUT'))) return true;
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
    const response = await client.embeddings.create({
      model: config.OPENAI_EMBEDDING_MODEL,
      input: text.slice(0, 8000)
    }, signal ? { signal } : undefined);
    return response.data?.[0]?.embedding as number[] | undefined;
  }, 2, signal);
}
