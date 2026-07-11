export const expectedRemediationContractVersion =
  process.env.EXPECTED_AI_MANAGER_CONTRACT_VERSION ||
  process.env.EXPECTED_REMEDIATION_CONTRACT_VERSION ||
  '2026-07-10.manager-contract-v1';

export const expectedAiManagerRuntimeVersion =
  process.env.EXPECTED_AI_MANAGER_RUNTIME_VERSION ||
  '2026-07-10.manager-runtime-v1';

// Kept as an empty compatibility export for historical remediation scripts.
// Internal artifact names moved to authenticated /api/admin/health.
export const expectedRemediationRuntimeArtifacts = [];

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
      // Caller can inspect the raw body.
    }
    return { ok: response.ok, status: response.status, body, parsed };
  } finally {
    clearTimeout(timer);
  }
}

export async function assertProductionRemediationMarker(productionApiBase) {
  const health = await fetchProductionHealth(productionApiBase);
  const actualVersion = health.parsed?.remediation?.contractVersion ?? null;
  const actualRuntimeVersion = health.parsed?.runtime?.version ?? null;
  const actualProductionRuntime = health.parsed?.runtime?.productionRuntime ?? null;
  const actualRuntimeArtifacts = [];
  const missingRuntimeArtifacts = [];
  if (
    !health.ok ||
    actualVersion !== expectedRemediationContractVersion ||
    actualRuntimeVersion !== expectedAiManagerRuntimeVersion ||
    actualProductionRuntime !== 'agent_manager'
  ) {
    const error = new Error(
      `Production remediation marker mismatch: expected ${expectedRemediationContractVersion}, got ${actualVersion ?? 'null'}`
    );
    error.name = 'ProductionRemediationMarkerError';
    error.details = {
      status: health.status,
      expectedRemediationContractVersion,
      actualRemediationContractVersion: actualVersion,
      expectedAiManagerRuntimeVersion,
      actualAiManagerRuntimeVersion: actualRuntimeVersion,
      actualProductionRuntime,
      expectedRemediationRuntimeArtifacts,
      actualRemediationRuntimeArtifacts: actualRuntimeArtifacts,
      missingRemediationRuntimeArtifacts: missingRuntimeArtifacts,
      body: health.body
    };
    throw error;
  }
  return { health, actualVersion, actualRuntimeArtifacts };
}
