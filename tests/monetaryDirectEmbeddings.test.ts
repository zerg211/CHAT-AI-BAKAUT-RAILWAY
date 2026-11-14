import { afterEach, describe, expect, it, vi } from 'vitest';

const sdk = vi.hoisted(() => ({ embedding: vi.fn(), response: vi.fn() }));
vi.mock('openai', () => ({ default: class { responses = { create: sdk.response }; embeddings = { create: sdk.embedding }; } }));
import { config } from '../src/config.js';
import { createOpenAIClient } from '../src/ai/openaiClient.js';

describe('direct embedding monetary boundary', () => {
  const oldKey = config.OPENAI_API_KEY;
  const oldMode = config.OPENAI_MONETARY_GUARD_ENABLED;
  afterEach(() => { config.OPENAI_API_KEY = oldKey; config.OPENAI_MONETARY_GUARD_ENABLED = oldMode; vi.clearAllMocks(); });
  it('does not call SDK in monetary mode and preserves direct off-mode behavior', async () => {
    config.OPENAI_API_KEY = 'fixture-key';
    sdk.embedding.mockResolvedValue({ data: [{ embedding: [1] }] });
    const client = createOpenAIClient()!;
    config.OPENAI_MONETARY_GUARD_ENABLED = true;
    await expect(client.embeddings.create({ model: 'fixture', input: 'test' })).rejects.toThrow('direct embeddings');
    expect(sdk.embedding).not.toHaveBeenCalled();
    config.OPENAI_MONETARY_GUARD_ENABLED = false;
    expect(await client.embeddings.create({ model: 'fixture', input: 'test' })).toEqual({ data: [{ embedding: [1] }] });
    expect(sdk.embedding).toHaveBeenCalledOnce();
  });
});
