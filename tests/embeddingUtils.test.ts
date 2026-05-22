import { describe, expect, it } from 'vitest';
import { embeddingInputText, embeddingMetadataForText, embeddingSourceHash } from '../src/ai/embeddingUtils.js';

describe('embedding utils', () => {
  it('normalizes CRLF pairs to LF without regex', () => {
    expect(embeddingInputText('one\r\ntwo\r\nthree')).toBe('one\ntwo\nthree');
  });

  it('preserves lone CR characters', () => {
    expect(embeddingInputText('one\rtwo')).toBe('one\rtwo');
  });

  it('keeps truncation before newline normalization', () => {
    const input = `${'a'.repeat(7999)}\r\nx`;

    expect(embeddingInputText(input)).toBe(`${'a'.repeat(7999)}\r`);
  });

  it('hashes CRLF and LF inputs identically after normalization', () => {
    expect(embeddingSourceHash('one\r\ntwo')).toBe(embeddingSourceHash('one\ntwo'));
  });

  it('keeps metadata model override and normalized source hash', () => {
    expect(embeddingMetadataForText('one\r\ntwo', 'test-embedding-model')).toEqual({
      model: 'test-embedding-model',
      sourceHash: embeddingSourceHash('one\ntwo')
    });
  });
});
