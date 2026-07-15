const blockingRuntimeClasses = new Set([
  'authentication',
  'provider_access_region',
  'quota_or_billing',
  'model_project_or_org_access',
  'model_mismatch',
  'rate_limit',
  'network_or_timeout',
  'network_or_runtime'
]);

function classifyRuntimePayload(payload, status) {
  const runtimeClass = payload?.error?.class ?? payload?.class;
  if (payload?.ok === true && runtimeClass === 'ok') return 'ok';
  if (runtimeClass) return runtimeClass;
  if (status === 401 || status === 403) return 'authentication';
  if (status === 429) return 'rate_limit';
  return 'unknown';
}

export async function checkProductionOpenAiRuntime({
  productionApiBase = process.env.PRODUCTION_API_BASE || 'https://chat-ai-production-3057.up.railway.app',
  token = process.env.ADMIN_PASSWORD || process.env.ADMIN_API_KEY,
  fetchImpl = fetch,
  timeoutMs = 30_000,
  expectedModel = process.env.PRODUCTION_EXPECTED_OPENAI_MODEL || 'gpt-5.6-terra'
} = {}) {
  if (!token) {
    return {
      ok: false,
      class: 'authentication',
      code: 'missing_admin_token',
      message: 'ADMIN_PASSWORD or ADMIN_API_KEY is required before production live OpenAI runtime preflight.'
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${productionApiBase}/api/admin/runtime/openai`, {
      headers: { authorization: `Bearer ${token}` },
      signal: controller.signal
    });
    const body = await response.text();
    let payload = null;
    try {
      payload = JSON.parse(body);
    } catch {
      // Keep raw text in the result.
    }
    const runtimeClass = classifyRuntimePayload(payload, response.status);
    const answerModel = payload?.answerModel ?? null;
    const plannerModel = payload?.plannerModel ?? null;
    const factModel = payload?.factModel ?? null;
    const modelsMatch = answerModel === expectedModel
      && plannerModel === expectedModel
      && factModel === expectedModel;
    return {
      ok: response.ok && payload?.ok === true && runtimeClass === 'ok' && modelsMatch,
      status: response.status,
      class: runtimeClass === 'ok' && !modelsMatch ? 'model_mismatch' : runtimeClass,
      code: runtimeClass === 'ok' && !modelsMatch
        ? 'production_manager_model_mismatch'
        : payload?.error?.code ?? payload?.code ?? null,
      answerModel,
      plannerModel,
      factModel,
      expectedModel,
      outputPresent: payload?.outputPresent ?? null,
      error: payload?.error ?? null,
      body: response.ok ? undefined : body.slice(0, 1200)
    };
  } catch (error) {
    return {
      ok: false,
      class: 'network_or_runtime',
      code: 'production_openai_runtime_preflight_failed',
      message: error instanceof Error ? error.message : String(error)
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function checkProductionLiveTestBudget({
  productionApiBase = process.env.PRODUCTION_API_BASE || 'https://chat-ai-production-3057.up.railway.app',
  token = process.env.ADMIN_PASSWORD || process.env.ADMIN_API_KEY,
  requiredRemainingTokens = Number(process.env.PRODUCTION_LIVE_REQUIRED_REMAINING_TOKENS ?? 0),
  fetchImpl = fetch,
  timeoutMs = 30_000
} = {}) {
  if (!token) {
    return {
      ok: false,
      class: 'authentication',
      code: 'missing_admin_token',
      message: 'ADMIN_PASSWORD or ADMIN_API_KEY is required before production live budget preflight.'
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${productionApiBase}/api/admin/openai-usage?hours=24`, {
      headers: { authorization: `Bearer ${token}` },
      signal: controller.signal
    });
    const body = await response.text();
    let payload = null;
    try {
      payload = JSON.parse(body);
    } catch {
      // Keep raw text in result.
    }
    const rows = Array.isArray(payload?.rows) ? payload.rows : [];
    const usedTokens = rows.reduce((sum, row) => sum + Number(row.totalTokens ?? row.total_tokens ?? 0), 0);
    const budget = Number(payload?.budget?.dailyTokenBudget ?? 0);
    const reserve = Number(payload?.budget?.guardReserveTokens ?? 0);
    const budgetConfigured = Number.isFinite(budget) && budget > 0;
    const remainingAfterReserve = budgetConfigured ? budget - usedTokens - reserve : null;
    const requiredTokens = Math.max(0, Number(requiredRemainingTokens) || 0);
    const enoughForScenario = !budgetConfigured || remainingAfterReserve >= requiredTokens;
    return {
      ok: response.ok && enoughForScenario,
      status: response.status,
      class: response.ok ? (!enoughForScenario ? 'budget_guard' : 'ok') : 'unknown',
      code: !enoughForScenario ? 'production_live_test_budget_insufficient_for_scenario' : null,
      usedTokens,
      budget: budgetConfigured ? budget : null,
      reserveTokens: Number.isFinite(reserve) ? reserve : 0,
      remainingAfterReserve,
      requiredRemainingTokens: requiredTokens,
      rows: rows.slice(0, 10),
      body: response.ok ? undefined : body.slice(0, 1200)
    };
  } catch (error) {
    return {
      ok: false,
      class: 'network_or_runtime',
      code: 'production_live_budget_preflight_failed',
      message: error instanceof Error ? error.message : String(error)
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function requireProductionOpenAiRuntimeReady(options = {}) {
  const runtime = await checkProductionOpenAiRuntime(options);
  if (!runtime.ok) {
    const runtimeClass = runtime.class ?? 'unknown';
    const error = new Error('production_openai_runtime_preflight_blocked');
    error.details = {
      ...runtime,
      stage: 'runtime_probe',
      blocking: blockingRuntimeClasses.has(runtimeClass),
      policy: 'Production live widget dialogs require a healthy Railway OpenAI runtime before browser launch.'
    };
    throw error;
  }

  const budget = await checkProductionLiveTestBudget(options);
  if (budget.ok) return { ok: true, runtime, budget };

  const error = new Error('production_openai_runtime_preflight_blocked');
  error.details = {
    ...budget,
    stage: 'production_live_test_budget',
    blocking: true,
    runtime,
    policy: 'Production live widget dialogs require remaining capacity in the same global OpenAI budget enforced for every caller.'
  };
  throw error;
}
