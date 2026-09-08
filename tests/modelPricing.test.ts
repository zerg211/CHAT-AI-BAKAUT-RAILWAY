import { describe, expect, it } from 'vitest';
import { estimateLunaStandardTokenCost, isPricingStale, lunaPricing } from '../src/ai/modelPricing.js';

describe('versioned Luna standard pricing', () => {
  it('records current rates with an official source and a fresh verification date', () => {
    expect(lunaPricing.source).toBe('https://developers.openai.com/api/docs/models/gpt-5.6-luna');
    expect(isPricingStale(lunaPricing.verifiedAt)).toBe(false);
    expect(estimateLunaStandardTokenCost({inputTokens: 100_000, cachedInputTokens: 0, outputTokens: 100_000})).toBeCloseTo(0.14);
  });
  it('separates cache reads, writes and output', () => {
    expect(estimateLunaStandardTokenCost({inputTokens: 100_000, cachedInputTokens: 50_000, cacheWriteTokens: 10_000, outputTokens: 10_000})).toBeCloseTo(0.0235);
  });
  it('applies long-context pricing to the full request only above the threshold', () => {
    expect(estimateLunaStandardTokenCost({inputTokens: 272_000, cachedInputTokens: 0, outputTokens: 1000})).toBeCloseTo(0.0556);
    expect(estimateLunaStandardTokenCost({inputTokens: 1_000_000, cachedInputTokens: 0, outputTokens: 1_000_000})).toBeCloseTo(2.2);
  });
  it('rejects invalid counters rather than reporting a negative or invented cost', () => {
    for (const cachedInputTokens of [-1, 101, NaN, 0.5]) {
      expect(estimateLunaStandardTokenCost({inputTokens: 100, cachedInputTokens, outputTokens: 1})).toBeNull();
    }
  });
  it('detects stale, invalid and future pricing dates deterministically', () => {
    expect(isPricingStale('invalid')).toBe(true);
    expect(isPricingStale('2026-09-08T00:00:00Z', Date.parse('2026-10-09T00:00:00Z'))).toBe(true);
    expect(isPricingStale('2026-09-08T00:00:00Z', Date.parse('2026-09-07T00:00:00Z'))).toBe(true);
  });
});
