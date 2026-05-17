import { describe, expect, it } from 'vitest';
import {
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
});
