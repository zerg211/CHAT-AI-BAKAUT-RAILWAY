import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  expectedRemediationContractVersion,
  expectedRemediationRuntimeArtifacts
} from './remediationProductionMarker.mjs';

const artifactPath = path.join('local-live-tests', 'remediation-docker-image-proof.json');
const imageTag = process.env.REMEDIATION_DOCKER_IMAGE || 'chat-ai-remediation:local-proof';

function truncate(value, maxLength = 5000) {
  const text = String(value ?? '');
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

function runCaptured(command, args, timeoutMs = 15 * 60_000) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env: process.env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      resolve({ ok: false, code: 'timeout', stdout: truncate(stdout), stderr: truncate(stderr) });
    }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
      process.stdout.write(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
      process.stderr.write(chunk);
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ ok: false, code: 'spawn_error', error: String(error), stdout: truncate(stdout), stderr: truncate(stderr) });
    });
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({
        ok: code === 0,
        code: signal ? `signal:${signal}` : `exit:${code}`,
        stdout: truncate(stdout),
        stderr: truncate(stderr)
      });
    });
  });
}

async function writeArtifact(data) {
  await fs.mkdir('local-live-tests', { recursive: true });
  await fs.writeFile(artifactPath, JSON.stringify({
    generatedAt: new Date().toISOString(),
    imageTag,
    expectedRemediationContractVersion,
    expectedRemediationRuntimeArtifacts,
    ...data
  }, null, 2), 'utf8');
}

function parseLastJsonLine(stdout) {
  const lines = String(stdout ?? '').split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  for (const line of lines.toReversed()) {
    if (!line.startsWith('{')) continue;
    try {
      return JSON.parse(line);
    } catch {
      // Continue looking for the final JSON line.
    }
  }
  return null;
}

const build = await runCaptured('docker', ['build', '-t', imageTag, '.'], 15 * 60_000);
if (!build.ok) {
  await writeArtifact({ ok: false, stage: 'docker_build', build });
  console.log(JSON.stringify({ ok: false, artifactPath, stage: 'docker_build' }, null, 2));
  process.exit(1);
}

const injectionCode = [
  "import('./dist/server/app.js').then(async ({ buildApp }) => {",
  '  const app = await buildApp();',
  "  const res = await app.inject({ method: 'GET', url: '/api/health' });",
  '  console.log(JSON.stringify({ statusCode: res.statusCode, payload: JSON.parse(res.payload) }));',
  '  await app.close();',
  "}).catch((error) => { console.error(error); process.exit(1); });"
].join('\n');

const health = await runCaptured('docker', [
  'run',
  '--rm',
  '--entrypoint',
  'node',
  imageTag,
  '--input-type=module',
  '-e',
  injectionCode
], 2 * 60_000);
const parsedHealth = parseLastJsonLine(health.stdout);
const actualVersion = parsedHealth?.payload?.remediation?.contractVersion ?? null;
const actualRuntimeArtifacts = Array.isArray(parsedHealth?.payload?.remediation?.runtimeArtifacts)
  ? parsedHealth.payload.remediation.runtimeArtifacts
  : [];
const missingRuntimeArtifacts = expectedRemediationRuntimeArtifacts.filter(
  (artifact) => !actualRuntimeArtifacts.includes(artifact)
);
const markerOk = health.ok &&
  parsedHealth?.statusCode === 200 &&
  actualVersion === expectedRemediationContractVersion &&
  missingRuntimeArtifacts.length === 0;

await writeArtifact({
  ok: markerOk,
  stage: markerOk ? 'complete' : 'container_health_marker',
  build,
  health,
  actualRemediationContractVersion: actualVersion,
  actualRemediationRuntimeArtifacts: actualRuntimeArtifacts,
  missingRemediationRuntimeArtifacts: missingRuntimeArtifacts
});

console.log(JSON.stringify({
  ok: markerOk,
  artifactPath,
  actualRemediationContractVersion: actualVersion,
  missingRemediationRuntimeArtifacts: missingRuntimeArtifacts
}, null, 2));

if (!markerOk) process.exit(1);
