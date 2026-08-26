import { beforeEach, describe, expect, it, vi } from 'vitest';

const responseCreate = vi.hoisted(() => vi.fn());

vi.mock('../src/ai/openaiClient.js', () => ({
  createOpenAIClient: () => ({ responses: { create: responseCreate } }),
  withRetry: (fn: () => Promise<unknown>) => fn()
}));

vi.mock('../src/ai/openaiUsageGuard.js', () => ({
  recordOpenAIUsageOnce: vi.fn(async () => undefined)
}));

import {
  createStructuredJsonResponse,
  StructuredJsonDeadlineExceededError,
  StructuredJsonRetrySkippedError
} from '../src/ai/openaiStructured.js';

describe('createStructuredJsonResponse output-limit retries', () => {
  beforeEach(() => {
    responseCreate.mockReset();
  });

  it('does not repeat an incomplete structured request with the same output cap', async () => {
    responseCreate.mockResolvedValue({
      status: 'incomplete',
      incomplete_details: { reason: 'max_output_tokens' },
      usage: { output_tokens: 3200 },
      output_text: '{"unfinished":'
    });

    const error = await createStructuredJsonResponse({
      request: { model: 'gpt-5.6-terra', max_output_tokens: 3200 },
      stage: 'test_stage'
    }).then(() => null, (caught: unknown) => caught);

    expect(error).toBeInstanceOf(StructuredJsonRetrySkippedError);
    expect(error).toMatchObject({
      retryReason: 'output_limit_exhausted'
    });
    expect(responseCreate).toHaveBeenCalledTimes(1);
  });

  it('retries only when the caller explicitly reserves a larger output cap', async () => {
    responseCreate
      .mockResolvedValueOnce({
        status: 'incomplete',
        incomplete_details: { reason: 'max_output_tokens' },
        usage: { output_tokens: 3200 },
        output_text: '{"unfinished":'
      })
      .mockResolvedValueOnce({
        status: 'completed',
        usage: { output_tokens: 3400 },
        output_text: '{"ok":true}'
      });

    await expect(createStructuredJsonResponse({
      request: { model: 'gpt-5.6-terra', max_output_tokens: 3200 },
      stage: 'test_stage',
      retryOutputTokenCap: 4000
    })).resolves.toMatchObject({ parsed: { ok: true } });
    expect(responseCreate).toHaveBeenCalledTimes(2);
    expect(responseCreate.mock.calls[1]?.[0]).toMatchObject({ max_output_tokens: 4000 });
  });

  it('aborts a structured request at the caller deadline', async () => {
    responseCreate.mockImplementation((_body: unknown, options: { signal?: AbortSignal } = {}) =>
      new Promise((_resolve, reject) => {
        const signal = options.signal;
        if (!signal) return reject(new Error('missing request signal'));
        if (signal.aborted) return reject(signal.reason);
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      })
    );

    const error = await createStructuredJsonResponse({
      request: { model: 'gpt-5.6-terra', max_output_tokens: 3200 },
      stage: 'test_stage',
      deadlineAtMs: Date.now() + 20
    }).then(() => null, (caught: unknown) => caught);

    expect(error).toBeInstanceOf(StructuredJsonDeadlineExceededError);
    expect(responseCreate).toHaveBeenCalledTimes(1);
  });
});
