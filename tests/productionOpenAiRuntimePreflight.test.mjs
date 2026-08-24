import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
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
  it('keeps the headless live-test budget above the final scenario burn rate', () => {
    const configSource = readFileSync(new URL('../src/config.ts', import.meta.url), 'utf8');

    expect(configSource).toContain('OPENAI_DAILY_TOKEN_BUDGET: defaultPositiveInt(6000000)');
  });

  it('passes when the admin runtime probe is healthy', async () => {
    const result = await checkProductionOpenAiRuntime({
      token: 'admin',
      fetchImpl: async () => response(200, {
        ok: true,
        class: 'ok',
        answerModel: 'gpt-5.6-luna',
        plannerModel: 'gpt-5.6-luna',
        factModel: 'gpt-5.6-luna',
        outputPresent: true
      })
    });

    expect(result).toMatchObject({
      ok: true,
      class: 'ok',
      answerModel: 'gpt-5.6-luna',
      plannerModel: 'gpt-5.6-luna',
      factModel: 'gpt-5.6-luna',
      expectedModel: 'gpt-5.6-luna'
    });
  });

  it('blocks a healthy runtime that still reports the legacy mini manager model', async () => {
    const result = await checkProductionOpenAiRuntime({
      token: 'admin',
      fetchImpl: async () => response(200, {
        ok: true,
        class: 'ok',
        answerModel: 'gpt-5.4-mini',
        plannerModel: 'gpt-5.4-mini',
        factModel: 'gpt-5.4-mini',
        outputPresent: true
      })
    });

    expect(result).toMatchObject({
      ok: false,
      class: 'model_mismatch',
      code: 'production_manager_model_mismatch',
      expectedModel: 'gpt-5.6-luna'
    });
  });

  it('blocks a legacy GPT-5.4 fact/reviewer model even when planner and answer use Terra', async () => {
    const result = await checkProductionOpenAiRuntime({
      token: 'admin',
      fetchImpl: async () => response(200, {
        ok: true,
        class: 'ok',
        answerModel: 'gpt-5.6-luna',
        plannerModel: 'gpt-5.6-luna',
        factModel: 'gpt-5.4',
        outputPresent: true
      })
    });

    expect(result).toMatchObject({
      ok: false,
      class: 'model_mismatch',
      code: 'production_manager_model_mismatch',
      factModel: 'gpt-5.4',
      expectedModel: 'gpt-5.6-luna'
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
          dailyTokenBudget: 160000,
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
      code: 'production_live_test_budget_insufficient_for_scenario',
      usedTokens: 144321,
      budget: 160000,
      reserveTokens: 16000
    });
  });

  it('blocks when remaining budget is positive but too small for the planned scenario', async () => {
    const result = await checkProductionLiveTestBudget({
      token: 'admin',
      requiredRemainingTokens: 400000,
      fetchImpl: async () => response(200, {
        budget: {
          dailyTokenBudget: 600000,
          guardReserveTokens: 16000
        },
        rows: [
          { totalTokens: 250000 }
        ]
      })
    });

    expect(result).toMatchObject({
      ok: false,
      class: 'budget_guard',
      code: 'production_live_test_budget_insufficient_for_scenario',
      remainingAfterReserve: 334000,
      requiredRemainingTokens: 400000
    });
  });

  it('passes only when runtime and live-test budget are healthy', async () => {
    let call = 0;
    const result = await requireProductionOpenAiRuntimeReady({
      token: 'admin',
      fetchImpl: async () => {
        call += 1;
        if (call === 1) {
          return response(200, {
            ok: true,
            class: 'ok',
            answerModel: 'gpt-5.6-luna',
            plannerModel: 'gpt-5.6-luna',
            factModel: 'gpt-5.6-luna',
            outputPresent: true
          });
        }
        return response(200, {
          budget: { dailyTokenBudget: 160000, guardReserveTokens: 16000 },
          rows: [{ totalTokens: 25000 }]
        });
      }
    });

    expect(result.ok).toBe(true);
    expect(result.budget.requiredRemainingTokens).toBe(0);
    expect(result.budget.remainingAfterReserve).toBe(119000);
  });
});
