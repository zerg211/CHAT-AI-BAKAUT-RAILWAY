import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const npmExecPath = process.env.npm_execpath;
const nodeCommand = process.execPath;
const artifactPath = path.join('local-live-tests', 'remediation-predeploy.json');

function npmCheck(args, label) {
  if (npmExecPath) {
    return { command: nodeCommand, args: [npmExecPath, ...args], label };
  }
  return { command: npmCommand, args, label, shell: process.platform === 'win32' };
}

const checks = [
  npmCheck(['run', 'typecheck'], 'typecheck'),
  npmCheck(['test'], 'unit and integration tests'),
  npmCheck(['run', 'test:eval:agentic'], 'agentic eval suite'),
  npmCheck(['run', 'build'], 'production build'),
  { command: nodeCommand, args: ['--check', 'tests/liveAgentCycle.production.mjs'], label: 'production live script syntax' },
  { command: nodeCommand, args: ['--check', 'tests/liveAgentCycle.876.production.mjs'], label: 'production #876 live script syntax' },
  { command: nodeCommand, args: ['--check', 'tests/liveAgentCycle.diverse.production.mjs'], label: 'diverse production live script syntax' },
  { command: nodeCommand, args: ['--check', 'tests/liveAgentCycle.local-llm-full.mjs'], label: 'local LLM live script syntax' },
  { command: nodeCommand, args: ['--check', 'tests/prepareProductionLiveDialogueScenario.mjs'], label: 'production live scenario preparation syntax' },
  { command: nodeCommand, args: ['--check', 'tests/productionOpenAiRuntimePreflight.mjs'], label: 'production OpenAI runtime preflight syntax' },
  { command: nodeCommand, args: ['--check', 'tests/remediationExternalReadiness.mjs'], label: 'external readiness script syntax' },
  { command: nodeCommand, args: ['--check', 'tests/remediationRailwaySourceReadiness.mjs'], label: 'Railway source readiness script syntax' },
  { command: nodeCommand, args: ['--check', 'tests/remediationProductionMarker.mjs'], label: 'production marker helper syntax' },
  { command: nodeCommand, args: ['--check', 'tests/remediationPostdeploy.mjs'], label: 'postdeploy script syntax' },
  { command: nodeCommand, args: ['--check', 'tests/remediationDockerImageProof.mjs'], label: 'Docker image proof script syntax' },
  { command: nodeCommand, args: ['--check', 'tests/remediationCompletionAudit.mjs'], label: 'completion audit script syntax' },
  { command: nodeCommand, args: ['--check', 'tests/remediationRailwayDeploy.mjs'], label: 'Railway deploy script syntax' }
];

function runCheck(check) {
  return new Promise((resolve, reject) => {
    console.log(`\n[predeploy] ${check.label}`);
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

const completedChecks = [];
try {
  for (const check of checks) {
    await runCheck(check);
    completedChecks.push(check.label);
  }
  await fs.mkdir('local-live-tests', { recursive: true });
  await fs.writeFile(artifactPath, JSON.stringify({
    generatedAt: new Date().toISOString(),
    ok: true,
    checks: completedChecks
  }, null, 2), 'utf8');
  console.log('\n[predeploy] PASS remediation predeploy gate');
} catch (error) {
  await fs.mkdir('local-live-tests', { recursive: true });
  await fs.writeFile(artifactPath, JSON.stringify({
    generatedAt: new Date().toISOString(),
    ok: false,
    checks: completedChecks,
    error: error instanceof Error ? error.message : String(error)
  }, null, 2), 'utf8');
  throw error;
}
