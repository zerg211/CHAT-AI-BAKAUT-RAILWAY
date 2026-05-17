const blockingRuntimeClasses = new Set([
  'authentication',
  'provider_access_region',
  'quota_or_billing',
  'model_project_or_org_access',
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
  timeoutMs = 30_000
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
    return {
      ok: response.ok && payload?.ok === true && runtimeClass === 'ok',
      status: response.status,
      class: runtimeClass,
      code: payload?.error?.code ?? payload?.code ?? null,
      answerModel: payload?.answerModel ?? null,
      plannerModel: payload?.plannerModel ?? null,
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

export async function requireProductionOpenAiRuntimeReady(options = {}) {
  const result = await checkProductionOpenAiRuntime(options);
  if (result.ok) return result;

  const runtimeClass = result.class ?? 'unknown';
  const error = new Error('production_openai_runtime_preflight_blocked');
  error.details = {
    ...result,
    blocking: blockingRuntimeClasses.has(runtimeClass),
    policy: 'Production live widget dialogs require a healthy Railway OpenAI runtime before browser launch.'
  };
  throw error;
}
