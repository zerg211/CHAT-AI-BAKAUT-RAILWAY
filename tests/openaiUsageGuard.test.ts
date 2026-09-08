import { describe, expect, it } from 'vitest';
import {
  extractOpenAIUsage,
  estimateRecordedUsageCost,
  requestSourceFromContext,
  runWithOpenAIUsageContext,
  currentOpenAIUsageContext
} from '../src/ai/openaiUsageGuard.js';

describe('OpenAI usage guard', () => {
  it('classifies production headless browser traffic as production live tests', () => {
    expect(requestSourceFromContext({
      pageUrl: 'https://bakautprof.ru/catalog/generatory/',
      userAgent: 'Mozilla/5.0 HeadlessChrome/124.0'
    })).toBe('production_live_test');
  });

  it('keeps normal production widget traffic separate from test traffic', () => {
    expect(requestSourceFromContext({
      pageUrl: 'https://bakautprof.ru/',
      userAgent: 'Mozilla/5.0 Chrome/124.0'
    })).toBe('production_widget');
    expect(requestSourceFromContext({
      pageUrl: 'https://bakautprof.ru.evil.example/',
      userAgent: 'HeadlessChrome/124.0'
    })).toBe('automated_browser');
  });

  it('propagates session and turn context across async work', async () => {
    await runWithOpenAIUsageContext({ sessionId: 'session-1', turnId: 'turn-1' }, async () => {
      await Promise.resolve();
      expect(currentOpenAIUsageContext()).toMatchObject({ sessionId: 'session-1', turnId: 'turn-1' });
    });
  });

  it('extracts token usage including reasoning tokens', () => {
    expect(extractOpenAIUsage({
      usage: {
        input_tokens: 100,
        output_tokens: 40,
        total_tokens: 140,
        output_tokens_details: { reasoning_tokens: 12 }
      }
    })).toEqual({
      inputTokens: 100,
      cachedInputTokens: null,
      outputTokens: 40,
      reasoningTokens: 12,
      totalTokens: 140
    });
  });

  it('records standard cached-token pricing separately from reservation ceilings', () => {
    expect(estimateRecordedUsageCost('gpt-5.6-luna', {
      service_tier: 'default',
      usage: { input_tokens: 1000, input_tokens_details: { cached_tokens: 500 }, output_tokens: 100 }
    })).toMatchObject({ costUsd: 0.00023, costBasis: 'standard_token_rate_estimate', cachedInputTokens: 500 });
  });

  it('does not invent standard prices for missing usage, missing cache or unsupported tiers', () => {
    for (const response of [ {}, { usage: { input_tokens: null, output_tokens: 0 } },
      { service_tier: 'default', usage: { input_tokens: 100, output_tokens: 10 } },
      { service_tier: 'priority', usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 0 }, output_tokens: 10 } }
    ]) expect(estimateRecordedUsageCost('gpt-5.6-luna', response).costUsd).toBeNull();
    expect(extractOpenAIUsage({usage: {input_tokens: null, output_tokens: -1, total_tokens: false}}))
      .toMatchObject({inputTokens: null, outputTokens: null, totalTokens: null});
  });
});
