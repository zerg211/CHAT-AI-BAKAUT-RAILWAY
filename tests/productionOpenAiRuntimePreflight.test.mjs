import { describe, expect, it } from 'vitest';
import {
  checkProductionLiveTestBudget,
  checkProductionOpenAiRuntime,
  requireProductionOpenAiRuntimeReady
} from './productionOpenAiRuntimePreflight.mjs';

function response(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body)
  };
}

describe('production OpenAI runtime preflight', () => {
  it('passes when the admin runtime probe is healthy', async () => {
    const result = await checkProductionOpenAiRuntime({
      token: 'admin',
      fetchImpl: async () => response(200, {
        ok: true,
        class: 'ok',
        answerModel: 'gpt-answer',
        plannerModel: 'gpt-planner',
        outputPresent: true
      })
    });

    expect(result).toMatchObject({
      ok: true,
      class: 'ok',
      answerModel: 'gpt-answer',
      plannerModel: 'gpt-planner'
    });
  });

  it('blocks missing admin token before production live', async () => {
    const result = await checkProductionOpenAiRuntime({
      token: '',
      fetchImpl: async () => response(200, { ok: true })
    });

    expect(result).toMatchObject({
      ok: false,
      class: 'authentication',
      code: 'missing_admin_token'
    });
  });

  it('blocks quota or billing runtime failures before browser launch', async () => {
    await expect(requireProductionOpenAiRuntimeReady({
      token: 'admin',
      fetchImpl: async () => response(200, {
        ok: false,
        error: {
          class: 'quota_or_billing',
          code: 'insufficient_quota',
          message: 'quota exhausted'
        }
      })
    })).rejects.toMatchObject({
      message: 'production_openai_runtime_preflight_blocked',
      details: {
        class: 'quota_or_billing',
        code: 'insufficient_quota',
        blocking: true
      }
    });
  });

  it('blocks exhausted production live test token budget before browser launch', async () => {
    const result = await checkProductionLiveTestBudget({
      token: 'admin',
      fetchImpl: async () => response(200, {
        budget: {
          headlessDailyTokenBudget: 160000,
          guardReserveTokens: 16000
        },
        rows: [
          { totalTokens: 144321 }
        ]
      })
    });

    expect(result).toMatchObject({
      ok: false,
      class: 'budget_guard',
      code: 'production_live_test_budget_exhausted',
      usedTokens: 144321,
      budget: 160000,
      reserveTokens: 16000
    });
  });

  it('passes only when runtime and live-test budget are healthy', async () => {
    let call = 0;
    const result = await requireProductionOpenAiRuntimeReady({
      token: 'admin',
      fetchImpl: async () => {
        call += 1;
        if (call === 1) {
          return response(200, { ok: true, class: 'ok', outputPresent: true });
        }
        return response(200, {
          budget: { headlessDailyTokenBudget: 160000, guardReserveTokens: 16000 },
          rows: [{ totalTokens: 25000 }]
        });
      }
    });

    expect(result.ok).toBe(true);
    expect(result.budget.remainingAfterReserve).toBe(119000);
  });
});
