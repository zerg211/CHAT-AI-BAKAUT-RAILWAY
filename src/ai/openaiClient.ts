import OpenAI from 'openai';
import { config } from '../config.js';

export function createOpenAIClient() {
  if (!config.OPENAI_API_KEY) return null;
  return new OpenAI({ apiKey: config.OPENAI_API_KEY }) as any;
}

export async function createEmbedding(text: string, signal?: AbortSignal) {
  const client = createOpenAIClient();
  if (!client) return null;
  const response = await client.embeddings.create({
    model: config.OPENAI_EMBEDDING_MODEL,
    input: text.slice(0, 8000)
  }, signal ? { signal } : undefined);
  return response.data?.[0]?.embedding as number[] | undefined;
}
