export const expectedAiManagerContractVersion =
  process.env.EXPECTED_AI_MANAGER_CONTRACT_VERSION ||
  '2026-07-10.manager-contract-v1';

export const expectedAiManagerRuntimeVersion =
  process.env.EXPECTED_AI_MANAGER_RUNTIME_VERSION ||
  '2026-07-15.gpt-5-6-terra-search-handoff-v13';

export async function fetchProductionHealth(productionApiBase, timeoutMs = 30_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${productionApiBase}/api/health`, { signal: controller.signal });
    const body = await response.text();
    let parsed = null;
    try {
      parsed = JSON.parse(body);
    } catch {
      // The caller receives the raw body for diagnostics.
    }
    return { ok: response.ok, status: response.status, body, parsed };
  } finally {
    clearTimeout(timer);
  }
}

export async function assertProductionRuntimeMarker(productionApiBase) {
  const health = await fetchProductionHealth(productionApiBase);
  const runtime = health.parsed?.runtime;
  if (
    !health.ok ||
    runtime?.contractVersion !== expectedAiManagerContractVersion ||
    runtime?.version !== expectedAiManagerRuntimeVersion ||
    runtime?.productionRuntime !== 'agent_manager'
  ) {
    const error = new Error(
      `Production runtime marker mismatch: expected ${expectedAiManagerRuntimeVersion}/${expectedAiManagerContractVersion}`
    );
    error.name = 'ProductionRuntimeMarkerError';
    error.details = { status: health.status, expectedAiManagerRuntimeVersion, expectedAiManagerContractVersion, runtime, body: health.body };
    throw error;
  }
  return { health, runtime };
}
