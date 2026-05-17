import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import dotenv from 'dotenv';
import {
  assertProductionRemediationMarker,
  expectedRemediationContractVersion,
  expectedRemediationRuntimeArtifacts
} from './remediationProductionMarker.mjs';
import { requireProductionLiveApproval } from './productionLiveGate.mjs';

dotenv.config({ quiet: true });

const npmExecPath = process.env.npm_execpath;
const nodeCommand = process.execPath;
const productionApiBase = process.env.PRODUCTION_API_BASE || 'https://chat-ai-production-3057.up.railway.app';
const artifactPath = path.join('local-live-tests', 'remediation-postdeploy.json');
const markerWaitMs = Number(process.env.REMEDIATION_MARKER_WAIT_MS ?? 600_000);
const markerPollMs = Number(process.env.REMEDIATION_MARKER_POLL_MS ?? 15_000);
const runProductionLiveGates = process.env.RUN_REMEDIATION_POSTDEPLOY_LIVE === '1';

function npmCommand(args, label) {
  if (npmExecPath) return { command: nodeCommand, args: [npmExecPath, ...args], label };
  return { command: process.platform === 'win32' ? 'npm.cmd' : 'npm', args, label, shell: process.platform === 'win32' };
}

function runCommand(check) {
  return new Promise((resolve, reject) => {
    console.log(`\n[postdeploy] ${check.label}`);
    const child = spawn(check.command, check.args, {
      cwd: process.cwd(),
      env: process.env,
      shell: Boolean(check.shell),
      stdio: 'inherit'
    });
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${check.label} failed with ${signal ? `signal ${signal}` : `exit code ${code}`}`));
    });
  });
}

async function writeArtifact(data) {
  await fs.mkdir('local-live-tests', { recursive: true });
  await fs.writeFile(artifactPath, JSON.stringify({
    generatedAt: new Date().toISOString(),
    productionApiBase,
    expectedRemediationContractVersion,
    ...data
  }, null, 2), 'utf8');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForProductionMarker() {
  const startedAt = Date.now();
  const attempts = [];
  let lastError = null;
  let attempt = 0;
  while (Date.now() - startedAt <= markerWaitMs) {
    attempt += 1;
    try {
      const marker = await assertProductionRemediationMarker(productionApiBase);
      attempts.push({
        attempt,
        ok: true,
        atMs: Date.now() - startedAt,
        actualRemediationContractVersion: marker.actualVersion,
        actualRemediationRuntimeArtifacts: marker.actualRuntimeArtifacts
      });
      return {
        ok: true,
        marker,
        attempts
      };
    } catch (error) {
      const details = error?.details ?? {};
      lastError = error;
      attempts.push({
        attempt,
        ok: false,
        atMs: Date.now() - startedAt,
        errorName: error?.name,
        errorMessage: error?.message,
        status: details.status,
        actualRemediationContractVersion: details.actualRemediationContractVersion ?? null,
        actualRemediationRuntimeArtifacts: details.actualRemediationRuntimeArtifacts ?? [],
        missingRemediationRuntimeArtifacts: details.missingRemediationRuntimeArtifacts ?? expectedRemediationRuntimeArtifacts,
        body: details.body
      });
      if (Date.now() - startedAt + markerPollMs > markerWaitMs) break;
      await sleep(markerPollMs);
    }
  }
  return {
    ok: false,
    error: lastError,
    attempts
  };
}

let actualVersion = null;
let actualRuntimeArtifacts = [];
const markerWait = await waitForProductionMarker();
if (!markerWait.ok) {
  const lastAttempt = markerWait.attempts.at(-1) ?? {};
  const missingRuntimeArtifacts = lastAttempt.missingRemediationRuntimeArtifacts ?? expectedRemediationRuntimeArtifacts;
  await writeArtifact({
    ok: false,
    stage: 'production_marker',
    markerWaitMs,
    markerPollMs,
    markerAttempts: markerWait.attempts,
    errorName: lastAttempt.errorName,
    errorMessage: lastAttempt.errorMessage,
    status: lastAttempt.status,
    expectedRemediationRuntimeArtifacts,
    actualRemediationRuntimeArtifacts: lastAttempt.actualRemediationRuntimeArtifacts ?? [],
    actualRemediationContractVersion: lastAttempt.actualRemediationContractVersion ?? null,
    missingRemediationRuntimeArtifacts: lastAttempt.missingRemediationRuntimeArtifacts ?? missingRuntimeArtifacts,
    body: lastAttempt.body
  });
  console.log(JSON.stringify({
    ok: false,
    artifactPath,
    stage: 'production_marker',
    expectedRemediationContractVersion,
    actualRemediationContractVersion: lastAttempt.actualRemediationContractVersion ?? null,
    missingRemediationRuntimeArtifacts: lastAttempt.missingRemediationRuntimeArtifacts ?? missingRuntimeArtifacts
  }, null, 2));
  process.exit(1);
}
({ actualVersion, actualRuntimeArtifacts } = markerWait.marker);

const adminTokenAvailable = Boolean(process.env.ADMIN_PASSWORD || process.env.ADMIN_API_KEY);
if (!adminTokenAvailable) {
  await writeArtifact({
    ok: false,
    stage: 'admin_metadata_token',
    actualRemediationContractVersion: actualVersion,
    message: 'ADMIN_PASSWORD or ADMIN_API_KEY is required for production metadata audit.'
  });
  console.log(JSON.stringify({
    ok: false,
    artifactPath,
    stage: 'admin_metadata_token'
  }, null, 2));
  process.exit(1);
}

if (!runProductionLiveGates) {
  await writeArtifact({
    ok: true,
    stage: 'production_marker_complete_live_skipped',
    actualRemediationContractVersion: actualVersion,
    actualRemediationRuntimeArtifacts: actualRuntimeArtifacts,
    liveGatePolicy: 'Production live dialogs are skipped by default. Run them only once for the final pre-launch gate with varied non-repeating buyer wording and manual audit.',
    requiredEnvForLiveGates: {
      RUN_REMEDIATION_POSTDEPLOY_LIVE: '1',
      ALLOW_PRODUCTION_LIVE_TESTS: '1',
      FINAL_RELEASE_LIVE_GATE: '1',
      ALLOW_FIXED_PRODUCTION_REPLAY: '1'
    }
  });
  console.log(JSON.stringify({
    ok: true,
    artifactPath,
    stage: 'production_marker_complete_live_skipped',
    actualRemediationContractVersion: actualVersion
  }, null, 2));
  process.exit(0);
}

requireProductionLiveApproval({ scriptName: 'remediationPostdeploy fixed production live gates' });

await writeArtifact({
  ok: false,
  stage: 'live_gates_started',
  actualRemediationContractVersion: actualVersion,
  actualRemediationRuntimeArtifacts: actualRuntimeArtifacts
});

await runCommand(npmCommand(['run', 'test:live:production'], 'production live agent cycle'));
await runCommand(npmCommand(['run', 'test:live:production:876'], 'production #876 live agent cycle'));

await writeArtifact({
  ok: true,
  stage: 'complete',
  actualRemediationContractVersion: actualVersion,
  actualRemediationRuntimeArtifacts: actualRuntimeArtifacts
});

console.log(JSON.stringify({
  ok: true,
  artifactPath,
  actualRemediationContractVersion: actualVersion
}, null, 2));
