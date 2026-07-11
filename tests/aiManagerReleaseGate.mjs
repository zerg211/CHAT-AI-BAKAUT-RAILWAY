import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const rootDir = process.cwd();
const baselineProjectPath = 'scripts/no-regex-baseline.json';
const baselineRef = normalizedBaselineRef(process.env.AI_MANAGER_REGEX_BASELINE_REF) || 'HEAD';
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const commandEnvironment = {
  ...process.env,
  CI: process.env.CI || '1'
};
const nodeMajor = Number(String(process.versions.node).split('.')[0]);

if (!Number.isSafeInteger(nodeMajor) || nodeMajor < 22) {
  console.error(`[release-gate] FAIL Node.js >=22 runtime: found ${process.versions.node}`);
  process.exit(1);
}
console.log(`[release-gate] PASS Node.js >=22 runtime (${process.versions.node})`);

function normalizedBaselineRef(value) {
  const normalized = String(value || '').trim();
  if (!normalized || [...normalized].every((character) => character === '0')) return '';
  if (normalized.startsWith('-')) throw new Error('AI_MANAGER_REGEX_BASELINE_REF must be a Git revision, not an option.');
  return normalized;
}

function commandResult(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: rootDir,
    env: commandEnvironment,
    encoding: options.encoding,
    maxBuffer: options.maxBuffer,
    shell: process.platform === 'win32' && command === npmCommand,
    stdio: options.stdio,
    timeout: options.timeout
  });
}

function readBaselineAtRef(ref) {
  const result = commandResult('git', ['show', `${ref}:${baselineProjectPath}`], {
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60_000
  });
  if (result.status !== 0 || !result.stdout) {
    const details = String(result.stderr || result.error || 'unknown git show failure').trim();
    throw new Error(`Cannot read ${baselineProjectPath} from ${ref}: ${details}`);
  }
  return result.stdout;
}

function parseBaseline(text, source) {
  const parsed = JSON.parse(text);
  if (!parsed || !Array.isArray(parsed.findings)) {
    throw new Error(`Invalid no-regex baseline from ${source}.`);
  }
  return parsed;
}

function assertBaselineDidNotGrow(referenceText) {
  const currentPath = path.join(rootDir, baselineProjectPath);
  const currentText = fs.readFileSync(currentPath, 'utf8');
  const reference = parseBaseline(referenceText, baselineRef);
  const current = parseBaseline(currentText, currentPath);
  const referenceIds = new Set(reference.findings.map((finding) => finding.id));
  const addedIds = current.findings
    .map((finding) => finding.id)
    .filter((id) => !referenceIds.has(id));
  if (addedIds.length) {
    throw new Error(
      `No-regex baseline grew by ${addedIds.length} entries relative to ${baselineRef}. ` +
      'Remove the new regex constructs instead of accepting them into the baseline.'
    );
  }
}

function prepareReferenceBaseline() {
  const referenceText = readBaselineAtRef(baselineRef);
  assertBaselineDidNotGrow(referenceText);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatai-release-gate-'));
  const tempBaselinePath = path.join(tempDir, 'no-regex-baseline.json');
  fs.writeFileSync(tempBaselinePath, referenceText, 'utf8');
  return { tempDir, tempBaselinePath };
}

function runGate(gate) {
  console.log(`\n[release-gate] ${gate.label}`);
  const result = commandResult(gate.command, gate.args, {
    stdio: 'inherit',
    timeout: gate.timeout
  });
  if (result.status === 0) {
    console.log(`[release-gate] PASS ${gate.label}`);
    return { label: gate.label, ok: true };
  }
  const reason = result.error
    ? result.error.message
    : result.signal
      ? `signal ${result.signal}`
      : `exit code ${result.status}`;
  console.error(`[release-gate] FAIL ${gate.label}: ${reason}`);
  return { label: gate.label, ok: false, reason };
}

let referenceBaseline;
try {
  referenceBaseline = prepareReferenceBaseline();
} catch (error) {
  console.error(`[release-gate] FAIL no-regex baseline integrity: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

const gates = [
  {
    label: `no new regex constructs relative to ${baselineRef}`,
    command: process.execPath,
    args: ['scripts/no-regex-guard.mjs'],
    timeout: 2 * 60_000,
    environment: { NO_REGEX_BASELINE_PATH: referenceBaseline.tempBaselinePath }
  },
  {
    label: 'production dependency audit (high severity)',
    command: npmCommand,
    args: ['audit', '--omit=dev', '--audit-level=high'],
    timeout: 3 * 60_000
  },
  {
    label: 'TypeScript typecheck',
    command: npmCommand,
    args: ['run', 'typecheck'],
    timeout: 8 * 60_000
  },
  {
    label: 'full test suite',
    command: npmCommand,
    args: ['test'],
    timeout: 20 * 60_000
  },
  {
    label: 'agentic eval suite',
    command: npmCommand,
    args: ['run', 'test:eval:agentic'],
    timeout: 8 * 60_000
  },
  {
    label: 'production build',
    command: npmCommand,
    args: ['run', 'build'],
    timeout: 10 * 60_000
  }
];

const results = [];
try {
  for (const gate of gates) {
    const previousEnvironment = commandEnvironment.NO_REGEX_BASELINE_PATH;
    if (gate.environment?.NO_REGEX_BASELINE_PATH) {
      commandEnvironment.NO_REGEX_BASELINE_PATH = gate.environment.NO_REGEX_BASELINE_PATH;
    } else {
      delete commandEnvironment.NO_REGEX_BASELINE_PATH;
    }
    results.push(runGate(gate));
    if (previousEnvironment === undefined) delete commandEnvironment.NO_REGEX_BASELINE_PATH;
    else commandEnvironment.NO_REGEX_BASELINE_PATH = previousEnvironment;
  }
} finally {
  fs.rmSync(referenceBaseline.tempDir, { recursive: true, force: true });
}

const failed = results.filter((result) => !result.ok);
console.log('\n[release-gate] summary');
for (const result of results) {
  console.log(`- ${result.ok ? 'PASS' : 'FAIL'}: ${result.label}${result.reason ? ` (${result.reason})` : ''}`);
}
if (failed.length) {
  console.error(`[release-gate] BLOCKED: ${failed.length} gate(s) failed.`);
  process.exit(1);
}
console.log('[release-gate] PASS: all local release checks succeeded.');
