import { describe, expect, it } from 'vitest';
import {
  extractOpenAIUsage,
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
      outputTokens: 40,
      reasoningTokens: 12,
      totalTokens: 140
    });
  });
});
