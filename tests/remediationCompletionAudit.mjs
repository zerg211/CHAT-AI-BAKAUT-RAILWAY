import fs from 'node:fs/promises';
import path from 'node:path';
import {
  expectedRemediationContractVersion,
  expectedRemediationRuntimeArtifacts
} from './remediationProductionMarker.mjs';

const artifactPath = path.join('local-live-tests', 'remediation-completion-audit.json');
const backupRoot = process.env.REMEDIATION_BACKUP_ROOT || 'C:\\Projects\\chatAI-backups';
const expectedBackupName = process.env.REMEDIATION_BACKUP_NAME || 'chatAI-backup-20260516-141548';
const expectedProtocolDate = process.env.REMEDIATION_COMPLETION_DATE || new Date().toISOString().slice(0, 10);

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readJson(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch (error) {
    return { __readError: error instanceof Error ? error.message : String(error) };
  }
}

async function listProductionProtocols() {
  try {
    const entries = await fs.readdir('local-live-tests', { withFileTypes: true });
    const protocols = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.production.md')) continue;
      const fullPath = path.join('local-live-tests', entry.name);
      const stat = await fs.stat(fullPath);
      protocols.push({
        path: fullPath,
        bytes: stat.size,
        modifiedAt: stat.mtime.toISOString()
      });
    }
    return protocols.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
  } catch {
    return [];
  }
}

async function listReleaseBundles() {
  try {
    const entries = await fs.readdir('local-live-tests', { withFileTypes: true });
    const manifests = entries
      .filter((entry) => entry.isFile() && /^chatAI-remediation-deploy-context-.+\.manifest\.json$/u.test(entry.name))
      .map((entry) => path.join('local-live-tests', entry.name));
    const bundles = [];
    for (const manifestPath of manifests) {
      const manifest = await readJson(manifestPath);
      const bundlePath = manifest.bundlePath;
      const stat = bundlePath ? await fs.stat(bundlePath).catch(() => null) : null;
      bundles.push({
        manifestPath,
        bundlePath,
        generatedAt: manifest.generatedAt,
        sourceFileCount: manifest.sourceFileCount,
        sourceTotalMiB: manifest.sourceTotalMiB,
        bundleBytes: stat?.size ?? manifest.bundleBytes ?? 0,
        exists: Boolean(stat)
      });
    }
    return bundles.sort((a, b) => String(b.generatedAt).localeCompare(String(a.generatedAt)));
  } catch {
    return [];
  }
}

function runtimeArtifactsComplete(actual) {
  const items = Array.isArray(actual) ? actual : [];
  return expectedRemediationRuntimeArtifacts.every((artifact) => items.includes(artifact));
}

function markerEvidenceFromPostdeploy(postdeploy) {
  return {
    source: 'postdeploy',
    artifact: 'local-live-tests/remediation-postdeploy.json',
    generatedAt: postdeploy.generatedAt,
    actualRemediationContractVersion: postdeploy.actualRemediationContractVersion ?? null,
    actualRemediationRuntimeArtifacts: postdeploy.actualRemediationRuntimeArtifacts ?? [],
    missingRemediationRuntimeArtifacts: postdeploy.missingRemediationRuntimeArtifacts ?? [],
    stage: postdeploy.stage,
    ok: postdeploy.actualRemediationContractVersion === expectedRemediationContractVersion &&
      runtimeArtifactsComplete(postdeploy.actualRemediationRuntimeArtifacts)
  };
}

function markerEvidenceFromExternalReadiness(externalReadiness) {
  const productionHealth = externalReadiness?.checks?.productionHealth ?? {};
  return {
    source: 'external_readiness.productionHealth',
    artifact: 'local-live-tests/remediation-external-readiness.json',
    generatedAt: externalReadiness.generatedAt,
    actualRemediationContractVersion: productionHealth.actualRemediationContractVersion ?? null,
    actualRemediationRuntimeArtifacts: productionHealth.actualRemediationRuntimeArtifacts ?? [],
    missingRemediationRuntimeArtifacts: productionHealth.missingRemediationRuntimeArtifacts ?? [],
    status: productionHealth.status,
    ok: productionHealth.ok === true &&
      productionHealth.actualRemediationContractVersion === expectedRemediationContractVersion &&
      runtimeArtifactsComplete(productionHealth.actualRemediationRuntimeArtifacts)
  };
}

function selectBestMarkerEvidence(candidates) {
  const sorted = candidates
    .filter((item) => item.actualRemediationContractVersion || item.actualRemediationRuntimeArtifacts.length || item.generatedAt)
    .sort((a, b) => {
      if (a.ok !== b.ok) return a.ok ? -1 : 1;
      return String(b.generatedAt ?? '').localeCompare(String(a.generatedAt ?? ''));
    });
  return sorted[0] ?? candidates[0];
}

function nonBlockingExternalReadinessBlocker(blocker, productionMarkerVerified) {
  if (!productionMarkerVerified) return false;
  if (blocker.name === 'railway' || blocker.name === 'railwayGraphqlPost') return true;
  if (blocker.name === 'productionOpenAiRuntime' && blocker.class === 'quota_or_billing') return true;
  return false;
}

function evaluate(name, ok, evidence, required = true) {
  return {
    name,
    required,
    status: ok ? 'proven' : 'missing_or_failed',
    ok,
    evidence
  };
}

const backupPath = path.join(backupRoot, expectedBackupName);
const backupMetadataPath = path.join(backupPath, 'BACKUP-METADATA.json');
const predeploy = await readJson(path.join('local-live-tests', 'remediation-predeploy.json'));
const dockerProof = await readJson(path.join('local-live-tests', 'remediation-docker-image-proof.json'));
const railwayDeploy = await readJson(path.join('local-live-tests', 'remediation-railway-deploy.json'));
const railwaySource = await readJson(path.join('local-live-tests', 'remediation-railway-source-readiness.json'));
const externalReadiness = await readJson(path.join('local-live-tests', 'remediation-external-readiness.json'));
const postdeploy = await readJson(path.join('local-live-tests', 'remediation-postdeploy.json'));
const productionLiveFailure = await readJson(path.join('local-live-tests', 'production-agent-cycle-failure.json'));
const productionProtocols = await listProductionProtocols();
const releaseBundles = await listReleaseBundles();
const latestReleaseBundle = releaseBundles[0];
const freshProductionProtocols = productionProtocols.filter((item) =>
  item.path.includes(expectedProtocolDate) &&
  item.bytes > 0
);
const markerEvidenceCandidates = [
  markerEvidenceFromPostdeploy(postdeploy),
  markerEvidenceFromExternalReadiness(externalReadiness)
];
const bestMarkerEvidence = selectBestMarkerEvidence(markerEvidenceCandidates);
const productionMarkerVerified = bestMarkerEvidence.ok === true;
const externalBlockers = Array.isArray(externalReadiness.blockers) ? externalReadiness.blockers : [];
const blockingExternalReadiness = externalBlockers.filter(
  (blocker) => !nonBlockingExternalReadinessBlocker(blocker, productionMarkerVerified)
);
const productionOpenAiRuntime = externalReadiness?.checks?.productionOpenAiRuntime ?? {};
const productionOpenAiQuotaBlocked = productionOpenAiRuntime.class === 'quota_or_billing' ||
  externalBlockers.some((blocker) => blocker.name === 'productionOpenAiRuntime' && blocker.class === 'quota_or_billing');
const liveGatePassed = postdeploy.ok === true && postdeploy.stage === 'complete' && freshProductionProtocols.length > 0;
const currentPostdeployLiveAttempted = ['live_gates_started', 'complete'].includes(postdeploy.stage);
const postdeployLiveEvidence = currentPostdeployLiveAttempted
  ? {
      liveFailureArtifact: 'local-live-tests/production-agent-cycle-failure.json',
      liveFailureSessionId: productionLiveFailure.sessionId,
      liveFailureError: productionLiveFailure.error,
      liveFailureTurn: productionLiveFailure.adminDetail?.turns?.[0]
        ? {
            id: productionLiveFailure.adminDetail.turns[0].id,
            status: productionLiveFailure.adminDetail.turns[0].status,
            stage: productionLiveFailure.adminDetail.turns[0].stage,
            errorCode: productionLiveFailure.adminDetail.turns[0].errorCode,
            errorMessage: productionLiveFailure.adminDetail.turns[0].errorMessage,
            plannerContractPresent: Boolean(productionLiveFailure.adminDetail.turns[0].plannerContract),
            assistantMessageId: productionLiveFailure.adminDetail.turns[0].assistantMessageId
          }
        : null
    }
  : {
      liveGatePolicy: postdeploy.liveGatePolicy,
      requiredEnvForLiveGates: postdeploy.requiredEnvForLiveGates,
      optionalEnvForFixedReplays: postdeploy.optionalEnvForFixedReplays
    };

const checks = [
  evaluate('backup_exists', await exists(backupPath), { backupPath }),
  evaluate('backup_metadata_exists', await exists(backupMetadataPath), { backupMetadataPath }),
  evaluate('predeploy_gate_passed', predeploy.ok === true, {
    artifact: 'local-live-tests/remediation-predeploy.json',
    generatedAt: predeploy.generatedAt,
    checks: predeploy.checks,
    error: predeploy.error
  }),
  evaluate('docker_image_marker_passed', dockerProof.ok === true &&
    dockerProof.actualRemediationContractVersion === expectedRemediationContractVersion &&
    runtimeArtifactsComplete(dockerProof.actualRemediationRuntimeArtifacts), {
      artifact: 'local-live-tests/remediation-docker-image-proof.json',
      generatedAt: dockerProof.generatedAt,
      actualRemediationContractVersion: dockerProof.actualRemediationContractVersion,
      actualRemediationRuntimeArtifacts: dockerProof.actualRemediationRuntimeArtifacts,
      missingRemediationRuntimeArtifacts: dockerProof.missingRemediationRuntimeArtifacts
    }),
  evaluate('railway_deploy_completed', (railwayDeploy.ok === true && railwayDeploy.stage === 'complete') || productionMarkerVerified, {
    artifact: 'local-live-tests/remediation-railway-deploy.json',
    generatedAt: railwayDeploy.generatedAt,
    stage: railwayDeploy.stage,
    deploymentMode: railwayDeploy.deploymentMode,
    railwayClass: railwayDeploy.deploy?.class ?? railwayDeploy.railwayStatus?.class,
    deployStdout: railwayDeploy.deploy?.stdout,
    deployStderr: railwayDeploy.deploy?.stderr,
    productionMarkerVerified,
    productionMarkerEvidence: bestMarkerEvidence,
    markerEvidenceCandidates
  }),
  evaluate('railway_github_source_known', railwaySource.ok === true && railwaySource.stage === 'complete', {
    artifact: 'local-live-tests/remediation-railway-source-readiness.json',
    generatedAt: railwaySource.generatedAt,
    stage: railwaySource.stage,
    class: railwaySource.class,
    status: railwaySource.status,
    errors: railwaySource.errors,
    source: railwaySource.source
  }, false),
  evaluate('release_bundle_available', latestReleaseBundle?.exists === true && latestReleaseBundle.bundleBytes > 0, {
    latestReleaseBundle,
    recentReleaseBundles: releaseBundles.slice(0, 5)
  }, false),
  evaluate('external_readiness_passed', externalReadiness.ok === true || (productionMarkerVerified && blockingExternalReadiness.length === 0), {
    artifact: 'local-live-tests/remediation-external-readiness.json',
    generatedAt: externalReadiness.generatedAt,
    blockers: externalReadiness.blockers,
    blockingExternalReadiness,
    ignoredBecauseProductionMarkerIsVerified: externalBlockers.filter((blocker) =>
      nonBlockingExternalReadinessBlocker(blocker, productionMarkerVerified)
    ),
    productionOpenAiQuotaBlocked
  }),
  evaluate('postdeploy_live_gates_passed', liveGatePassed, {
    artifact: 'local-live-tests/remediation-postdeploy.json',
    generatedAt: postdeploy.generatedAt,
    stage: postdeploy.stage,
    actualRemediationContractVersion: postdeploy.actualRemediationContractVersion,
    missingRemediationRuntimeArtifacts: postdeploy.missingRemediationRuntimeArtifacts,
    currentPostdeployLiveAttempted,
    ...postdeployLiveEvidence,
    productionOpenAiQuotaBlocked
  }),
  evaluate('fresh_production_live_protocol_exists', freshProductionProtocols.length > 0, {
    expectedDate: expectedProtocolDate,
    freshProductionProtocols,
    latestExistingProductionProtocols: productionProtocols.slice(0, 5)
  }, false),
  evaluate('production_marker_has_runtime_artifacts', productionMarkerVerified, {
    expectedRemediationContractVersion,
    expectedRemediationRuntimeArtifacts,
    bestMarkerEvidence,
    markerEvidenceCandidates
  })
];

const requiredFailures = checks.filter((check) => check.required && !check.ok);
const artifact = {
  generatedAt: new Date().toISOString(),
  ok: requiredFailures.length === 0,
  expectedRemediationContractVersion,
  expectedRemediationRuntimeArtifacts,
  checks,
  requiredFailures: requiredFailures.map((check) => check.name)
};

await fs.mkdir('local-live-tests', { recursive: true });
await fs.writeFile(artifactPath, JSON.stringify(artifact, null, 2), 'utf8');

console.log(JSON.stringify({
  ok: artifact.ok,
  artifactPath,
  requiredFailures: artifact.requiredFailures
}, null, 2));

if (!artifact.ok) process.exit(1);
