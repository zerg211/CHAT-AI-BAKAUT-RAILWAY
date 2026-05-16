export const expectedRemediationContractVersion =
  process.env.EXPECTED_REMEDIATION_CONTRACT_VERSION || '2026-05-16-agent-contract-stack-v6';

export const expectedRemediationRuntimeArtifacts = [
  'executionContract',
  'requirementLedger',
  'cardManifest',
  'factClaimPlanner',
  'factClaimAudit',
  'leadStateMachine',
  'postAnswerVerification'
];

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
  const actualRuntimeArtifacts = Array.isArray(health.parsed?.remediation?.runtimeArtifacts)
    ? health.parsed.remediation.runtimeArtifacts
    : [];
  const missingRuntimeArtifacts = expectedRemediationRuntimeArtifacts.filter(
    (artifact) => !actualRuntimeArtifacts.includes(artifact)
  );
  if (!health.ok || actualVersion !== expectedRemediationContractVersion || missingRuntimeArtifacts.length) {
    const error = new Error(
      `Production remediation marker mismatch: expected ${expectedRemediationContractVersion}, got ${actualVersion ?? 'null'}`
    );
    error.name = 'ProductionRemediationMarkerError';
    error.details = {
      status: health.status,
      expectedRemediationContractVersion,
      actualRemediationContractVersion: actualVersion,
      expectedRemediationRuntimeArtifacts,
      actualRemediationRuntimeArtifacts: actualRuntimeArtifacts,
      missingRemediationRuntimeArtifacts: missingRuntimeArtifacts,
      body: health.body
    };
    throw error;
  }
  return { health, actualVersion, actualRuntimeArtifacts };
}
