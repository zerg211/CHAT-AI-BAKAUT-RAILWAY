import crypto from 'node:crypto';
import { config } from '../config.js';
import type { EmbeddingMetadata } from '../shared/types.js';

export function embeddingInputText(text: string) {
  return text.slice(0, 8000).replace(/\r\n/g, '\n');
}

export function embeddingSourceHash(text: string) {
  return crypto.createHash('sha256').update(embeddingInputText(text), 'utf8').digest('hex');
}

export function embeddingMetadataForText(text: string, model = config.OPENAI_EMBEDDING_MODEL): EmbeddingMetadata {
  return {
    model,
    sourceHash: embeddingSourceHash(text)
  };
}
