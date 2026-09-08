import { describe, expect, it, vi } from 'vitest';
const create = vi.hoisted(() => vi.fn());
vi.mock('openai', () => ({ default: class { responses = { create }; } }));
vi.mock('../src/config.js', () => ({ config: { OPENAI_API_KEY: 'test-only', OPENAI_MODEL: 'gpt-5.6-luna' } }));
vi.mock('../src/ai/openaiUsageGuard.js', () => ({
  assertOpenAIUsageBudget: vi.fn().mockResolvedValue('reservation'),
  bindOpenAIUsageReservation: vi.fn(), releaseOpenAIUsageReservation: vi.fn(), recordOpenAIUsageOnce: vi.fn()
}));
import { createOpenAIClient } from '../src/ai/openaiClient.js';
import { AgentManagerTurnBudget, runWithAgentManagerTurnBudget } from '../src/ai/agentManagerTurnBudget.js';

describe('Responses transport turn reservation', () => {
  it('settles successful usage but retains the reserve of a failed attempt', async () => {
    const budget = new AgentManagerTurnBudget();
    create.mockResolvedValueOnce({ usage: { input_tokens: 80, output_tokens: 20, total_tokens: 100 } })
      .mockRejectedValueOnce(new Error('connection lost'));
    await runWithAgentManagerTurnBudget(budget, async () => {
      const client = createOpenAIClient()!;
      const request = { model: 'gpt-5.6-luna', input: 'test', max_output_tokens: 100 };
      await client.responses.create(request);
      expect(budget.snapshot().usage).toMatchObject({ providerCalls: 1, providerReconciledCalls: 1,
        providerEstimatedInputTokens: 80, providerReservedOutputTokens: 20, providerEstimatedTotalTokens: 100 });
      await expect(client.responses.create(request)).rejects.toThrow('connection lost');
      expect(budget.snapshot().usage).toMatchObject({ providerCalls: 2, providerReconciledCalls: 1 });
      expect(budget.snapshot().usage.providerEstimatedTotalTokens).toBeGreaterThan(200);
    });
  });
});
