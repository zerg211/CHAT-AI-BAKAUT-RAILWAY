import crypto from 'node:crypto';
import { config } from '../config.js';
import type { EmbeddingMetadata } from '../shared/types.js';

function normalizeCrlf(value: string) {
  let result = '';
  let index = 0;
  while (index < value.length) {
    const char = value[index];
    if (char === '\r' && value[index + 1] === '\n') {
      result += '\n';
      index += 2;
      continue;
    }
    result += char;
    index += 1;
  }
  return result;
}

export function embeddingInputText(text: string) {
  return normalizeCrlf(text.slice(0, 8000));
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
