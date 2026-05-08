import { withRetry } from '../src/ai/openaiClient.js';

describe('OpenAI retry handling', () => {
  it('retries plain API connection errors from the SDK', async () => {
    vi.useFakeTimers();
    try {
      let attempts = 0;
      const result = withRetry(async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('Connection error.');
        return 'ok';
      }, 1);

      await vi.advanceTimersByTimeAsync(2_000);
      await expect(result).resolves.toBe('ok');
      expect(attempts).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not retry unsupported-region errors as transient network failures', async () => {
    let attempts = 0;
    await expect(withRetry(async () => {
      attempts += 1;
      throw new Error('unsupported_country_region_territory');
    }, 2)).rejects.toThrow('unsupported_country_region_territory');
    expect(attempts).toBe(1);
  });
});
