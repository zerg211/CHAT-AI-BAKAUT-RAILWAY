import OpenAI from 'openai';
import { config } from '../config.js';
import {
  assertOpenAIUsageBudget,
  bindOpenAIUsageReservation,
  recordOpenAIUsageOnce,
  releaseOpenAIUsageReservation
} from './openaiUsageGuard.js';
import { embeddingInputText } from './embeddingUtils.js';
import {
  AgentManagerTurnBudgetExceededError,
  consumeCurrentAgentManagerProviderCall,
  hasCurrentAgentManagerTurnBudget
} from './agentManagerTurnBudget.js';
import {
  ProviderBudgetEstimationError,
  estimateEmbeddingProviderCall,
  estimateResponsesProviderCall,
  type ProviderCallEstimate
} from './openaiRequestBudget.js';

function reserveCurrentTurnProviderCall(buildEstimate: () => ProviderCallEstimate) {
  if (!hasCurrentAgentManagerTurnBudget()) return undefined;
  try {
    const estimate = buildEstimate();
    consumeCurrentAgentManagerProviderCall(estimate);
    return estimate;
  } catch (error) {
    if (error instanceof ProviderBudgetEstimationError) {
      throw new AgentManagerTurnBudgetExceededError(error.stopReason);
    }
    throw error;
  }
}

export function createOpenAIClient() {
  if (!config.OPENAI_API_KEY) return null;
  const client = new OpenAI({ apiKey: config.OPENAI_API_KEY, maxRetries: 0 }) as any;
  const createResponse = client.responses.create.bind(client.responses);
  client.responses.create = async (body: Record<string, unknown>, options?: unknown) => {
    const maxOutputTokens = Number(body?.max_output_tokens ?? 0);
    const turnEstimate = reserveCurrentTurnProviderCall(() => estimateResponsesProviderCall(body));
    const reservationId = await assertOpenAIUsageBudget(
      'openai_response',
      String(body?.model ?? config.OPENAI_MODEL),
      turnEstimate?.estimatedTotalTokens ?? Math.max(0, maxOutputTokens) + 8000
    );
    try {
      const response = await createResponse(body, options);
      bindOpenAIUsageReservation(response, reservationId);
      return response;
    } catch (error) {
      await releaseOpenAIUsageReservation(reservationId);
      throw error;
    }
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
    const value = embeddingInputText(text);
    const turnEstimate = reserveCurrentTurnProviderCall(() => estimateEmbeddingProviderCall({
      model: config.OPENAI_EMBEDDING_MODEL,
      values: [value]
    }));
    const reservationId = await assertOpenAIUsageBudget(
      'embedding',
      config.OPENAI_EMBEDDING_MODEL,
      turnEstimate?.estimatedTotalTokens ?? 4000
    );
    try {
      const response = await client.embeddings.create({
        model: config.OPENAI_EMBEDDING_MODEL,
        input: value
      }, signal ? { signal } : undefined);
      bindOpenAIUsageReservation(response, reservationId);
      await recordOpenAIUsageOnce('embedding', config.OPENAI_EMBEDDING_MODEL, response);
      return response.data?.[0]?.embedding as number[] | undefined;
    } catch (error) {
      await releaseOpenAIUsageReservation(reservationId);
      throw error;
    }
  }, 2, signal);
}

export async function createEmbeddings(texts: string[], signal?: AbortSignal) {
  if (texts.length === 0) return [];
  if (config.NODE_ENV === 'test') return texts.map(() => null);
  const client = createOpenAIClient();
  if (!client) return texts.map(() => null);
  return withRetry(async () => {
    const values = texts.map((text) => embeddingInputText(text));
    const turnEstimate = reserveCurrentTurnProviderCall(() => estimateEmbeddingProviderCall({
      model: config.OPENAI_EMBEDDING_MODEL,
      values
    }));
    const reservationId = await assertOpenAIUsageBudget(
      'embedding',
      config.OPENAI_EMBEDDING_MODEL,
      turnEstimate?.estimatedTotalTokens ?? Math.max(4000, texts.length * 2000)
    );
    try {
      const response = await client.embeddings.create({
        model: config.OPENAI_EMBEDDING_MODEL,
        input: values
      }, signal ? { signal } : undefined);
      bindOpenAIUsageReservation(response, reservationId);
      await recordOpenAIUsageOnce('embedding', config.OPENAI_EMBEDDING_MODEL, response);
      const byIndex = new Map<number, number[]>();
      for (const item of response.data ?? []) {
        if (typeof item.index === 'number' && Array.isArray(item.embedding)) {
          byIndex.set(item.index, item.embedding as number[]);
        }
      }
      return texts.map((_, index) => byIndex.get(index) ?? null);
    } catch (error) {
      await releaseOpenAIUsageReservation(reservationId);
      throw error;
    }
  }, 2, signal);
}
