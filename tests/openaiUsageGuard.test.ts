import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { lunaPricing } from '../src/ai/modelPricing.js';
import { config } from '../src/config.js';
import { pool } from '../src/db/pool.js';
import {
  extractOpenAIUsage,
  estimateRecordedUsageCost,
  requestSourceFromContext,
  runWithOpenAIUsageContext,
  currentOpenAIUsageContext,
  reconcilePlatformAgentUsage
} from '../src/ai/openaiUsageGuard.js';

describe('OpenAI usage guard', () => {
  beforeEach(() => vi.spyOn(Date, 'now').mockReturnValue(Date.parse(lunaPricing.verifiedAt)));
  afterEach(() => vi.restoreAllMocks());
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

  it('keeps usage but refuses a monetary estimate when the saved rates are stale', () => {
    vi.mocked(Date.now).mockReturnValue(Date.parse(lunaPricing.verifiedAt) + 31 * 86_400_000);
    expect(estimateRecordedUsageCost('gpt-5.6-luna', {
      service_tier: 'default',
      usage: { input_tokens: 1000, input_tokens_details: { cached_tokens: 500 }, output_tokens: 100 }
    })).toMatchObject({ costUsd: null, costBasis: 'unavailable', cachedInputTokens: 500 });
  });

  it('does not invent standard prices for missing usage, missing cache or unsupported tiers', () => {
    for (const response of [ {}, { usage: { input_tokens: null, output_tokens: 0 } },
      { service_tier: 'default', usage: { input_tokens: 100, output_tokens: 10 } },
      { service_tier: 'priority', usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 0 }, output_tokens: 10 } }
    ]) expect(estimateRecordedUsageCost('gpt-5.6-luna', response).costUsd).toBeNull();
    expect(extractOpenAIUsage({usage: {input_tokens: null, output_tokens: -1, total_tokens: false}}))
      .toMatchObject({inputTokens: null, outputTokens: null, totalTokens: null});
  });

  it('reconciles a late platform usage value into the existing event and its own message', async () => {
    const previousKey = config.OPENAI_API_KEY, previousAgent = config.OPENAI_PLATFORM_AGENT_ID;
    config.OPENAI_API_KEY = 'test-key'; config.OPENAI_PLATFORM_AGENT_ID = 'test-agent';
    try {
      vi.spyOn(pool, 'query').mockResolvedValue({ rows: [{ id: 'event', session_id: 'session', turn_id: 'turn',
        response_id: 'provider-turn', agent_session_id: 'provider-session', model: 'gpt-6-luna' }], rowCount: 1 } as never);
      const query = vi.fn().mockResolvedValue({ rowCount: 1, rows: [] });
      const release = vi.fn();
      vi.spyOn(pool, 'connect').mockResolvedValue({ query, release } as never);
      const transport = vi.fn(async () => new Response(JSON.stringify({ id: 'provider-turn', usage: {
        input_tokens: 100, input_tokens_details: { cached_tokens: 40 }, output_tokens: 20,
        output_tokens_details: { reasoning_tokens: 10 }, total_tokens: 120
      } }), { status: 200 })) as unknown as typeof fetch;
      await reconcilePlatformAgentUsage(transport);
      const eventUpdate = query.mock.calls.find((call: unknown[]) => String(call[0]).includes('UPDATE openai_usage_events'));
      expect(eventUpdate?.[1]).toEqual(expect.arrayContaining(['event', 100, 20, 10, 120, 'provider-turn']));
      expect(query.mock.calls.some((call: unknown[]) => String(call[0]).includes('UPDATE messages'))).toBe(true);
      expect(query.mock.calls.some((call: unknown[]) => String(call[0]).includes('UPDATE openai_usage_reservations'))).toBe(true);
      expect(query.mock.calls.some((call: unknown[]) => call[0] === 'COMMIT')).toBe(true);
      expect(release).toHaveBeenCalledOnce();
    } finally { config.OPENAI_API_KEY = previousKey; config.OPENAI_PLATFORM_AGENT_ID = previousAgent; }
  });

  it('keeps missing or mismatched platform usage pending', async () => {
    const previousKey = config.OPENAI_API_KEY, previousAgent = config.OPENAI_PLATFORM_AGENT_ID;
    config.OPENAI_API_KEY = 'test-key'; config.OPENAI_PLATFORM_AGENT_ID = 'test-agent';
    try {
      vi.spyOn(pool, 'query').mockResolvedValue({ rows: [{ id: 'event', session_id: 'session', turn_id: 'turn',
        response_id: 'provider-turn', agent_session_id: 'provider-session', model: 'gpt-6-luna' }], rowCount: 1 } as never);
      const connect = vi.spyOn(pool, 'connect');
      for (const body of [{ id: 'provider-turn', usage: null }, { id: 'other-turn', usage: { total_tokens: 5 } }]) {
        await reconcilePlatformAgentUsage(vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch);
      }
      expect(connect).not.toHaveBeenCalled();
    } finally { config.OPENAI_API_KEY = previousKey; config.OPENAI_PLATFORM_AGENT_ID = previousAgent; }
  });
});
