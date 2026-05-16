import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import dotenv from 'dotenv';

dotenv.config({ quiet: true });

const npmExecPath = process.env.npm_execpath;
const nodeCommand = process.execPath;
const artifactPath = path.join('local-live-tests', 'remediation-railway-deploy.json');
const deploymentMessage = process.env.REMEDIATION_DEPLOY_MESSAGE || 'agent-contract-stack-v1 remediation';
const deploymentMode = process.env.REMEDIATION_RAILWAY_MODE || 'detach';
const deploymentPath = process.env.REMEDIATION_RAILWAY_PATH;

function npmCommand(args, label) {
  if (npmExecPath) return { command: nodeCommand, args: [npmExecPath, ...args], label };
  return { command: process.platform === 'win32' ? 'npm.cmd' : 'npm', args, label, shell: process.platform === 'win32' };
}

function railwayCommand(args, label) {
  return {
    command: process.platform === 'win32' ? 'powershell.exe' : 'railway',
    args: process.platform === 'win32'
      ? ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ['railway', ...args].join(' ')]
      : args,
    label
  };
}

function truncate(value, maxLength = 3000) {
  const text = String(value ?? '');
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

function normalizePath(value) {
  return value.split(path.sep).join('/');
}

function globPatternToRegExp(pattern) {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/gu, '\\$&')
    .replace(/\*\*/gu, '::DOUBLE_STAR::')
    .replace(/\*/gu, '[^/]*')
    .replace(/::DOUBLE_STAR::/gu, '.*');
  return new RegExp(`^${escaped}$`, 'u');
}

function matchesIgnorePattern(relativePath, pattern, isDirectory) {
  let rawPattern = pattern.trim();
  if (!rawPattern || rawPattern.startsWith('#')) return false;
  if (rawPattern.startsWith('!')) rawPattern = rawPattern.slice(1);
  rawPattern = rawPattern.replace(/^\/+/u, '').replace(/\\/gu, '/');
  const directoryOnly = rawPattern.endsWith('/');
  const cleanPattern = directoryOnly ? rawPattern.replace(/\/+$/u, '') : rawPattern;
  if (!cleanPattern) return false;
  if (directoryOnly && !isDirectory && !relativePath.startsWith(`${cleanPattern}/`)) return false;

  if (!cleanPattern.includes('*')) {
    return relativePath === cleanPattern || relativePath.startsWith(`${cleanPattern}/`) || relativePath.endsWith(`/${cleanPattern}`);
  }

  const pathParts = relativePath.split('/');
  const candidates = cleanPattern.includes('/')
    ? [relativePath]
    : pathParts.map((_, index) => pathParts.slice(index).join('/'));
  const regexp = globPatternToRegExp(cleanPattern);
  return candidates.some((candidate) => regexp.test(candidate));
}

function applyIgnorePatterns(relativePath, isDirectory, patterns) {
  let ignored = false;
  for (const pattern of patterns) {
    const trimmed = pattern.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const negated = trimmed.startsWith('!');
    if (matchesIgnorePattern(relativePath, trimmed, isDirectory)) {
      ignored = !negated;
    }
  }
  return ignored;
}

async function readIgnorePatterns(fileName) {
  try {
    const content = await fs.readFile(fileName, 'utf8');
    return content.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

async function estimateDeployContext() {
  const root = process.cwd();
  const patterns = [
    '.git',
    'node_modules',
    ...(await readIgnorePatterns('.gitignore')),
    ...(await readIgnorePatterns('.railwayignore'))
  ];
  const largestFiles = [];
  let fileCount = 0;
  let totalBytes = 0;

  async function visit(directory) {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(directory, entry.name);
      const relativePath = normalizePath(path.relative(root, fullPath));
      if (!relativePath) continue;
      const isDirectory = entry.isDirectory();
      if (applyIgnorePatterns(relativePath, isDirectory, patterns)) continue;
      if (isDirectory) {
        await visit(fullPath);
        continue;
      }
      if (!entry.isFile()) continue;
      const stat = await fs.stat(fullPath);
      fileCount += 1;
      totalBytes += stat.size;
      largestFiles.push({ path: relativePath, bytes: stat.size });
      largestFiles.sort((a, b) => b.bytes - a.bytes);
      if (largestFiles.length > 20) largestFiles.pop();
    }
  }

  await visit(root);
  return {
    fileCount,
    totalBytes,
    totalMiB: Number((totalBytes / 1024 / 1024).toFixed(2)),
    largestFiles
  };
}

function classifyRailway(result) {
  const text = `${result.stdout ?? ''}\n${result.stderr ?? ''}\n${result.error ?? ''}`;
  if (result.ok) return 'ok';
  if (/invalid_grant|Unauthorized|railway login/iu.test(text)) return 'railway_auth';
  if (/graphql|backboard\.railway\.com|timed out|timeout|ECONNRESET|connection|Connect|network/iu.test(text)) return 'railway_network';
  if (/not linked|link/iu.test(text)) return 'railway_project_link';
  return 'railway_unknown';
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function writeArtifact(data) {
  await fs.mkdir('local-live-tests', { recursive: true });
  await fs.writeFile(artifactPath, JSON.stringify({
    generatedAt: new Date().toISOString(),
    deploymentMessage,
    deploymentMode,
    deploymentPath: deploymentPath ?? null,
    pathAsRoot: process.env.REMEDIATION_RAILWAY_PATH_AS_ROOT === '1',
    ...data
  }, null, 2), 'utf8');
}

function runCaptured(check, timeoutMs = 15 * 60_000) {
  return new Promise((resolve) => {
    console.log(`\n[deploy] ${check.label}`);
    const child = spawn(check.command, check.args, {
      cwd: process.cwd(),
      env: process.env,
      shell: Boolean(check.shell),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      resolve({ ok: false, code: 'timeout', stdout: truncate(stdout), stderr: truncate(stderr) });
    }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      stdout += text;
      process.stdout.write(text);
    });
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      stderr += text;
      process.stderr.write(text);
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

async function runRailwayWithRetry(args, label, timeoutMs, maxAttempts = 3) {
  const attempts = [];
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const result = await runCaptured(railwayCommand(args, `${label} (attempt ${attempt}/${maxAttempts})`), timeoutMs);
    result.class = classifyRailway(result);
    attempts.push(result);
    if (result.ok || result.class !== 'railway_network' || attempt === maxAttempts) {
      return {
        ...result,
        attempts: attempts.map((item, index) => ({
          attempt: index + 1,
          ok: item.ok,
          code: item.code,
          class: item.class,
          stderr: item.stderr
        }))
      };
    }
    await sleep(10_000);
  }
  return attempts.at(-1);
}

const railwayVersion = await runCaptured(railwayCommand(['--version'], 'Railway CLI version'), 30_000);
const deployContext = await estimateDeployContext();
const skipRailwayStatus = process.env.REMEDIATION_SKIP_RAILWAY_STATUS === '1';
const railwayStatus = skipRailwayStatus
  ? {
      ok: true,
      code: 'skipped',
      stdout: '',
      stderr: '',
      class: 'skipped',
      reason: 'REMEDIATION_SKIP_RAILWAY_STATUS=1'
    }
  : await runRailwayWithRetry(['status'], 'Railway status', 90_000);
if (!railwayStatus.ok) {
  await writeArtifact({ ok: false, stage: 'railway_status', railwayVersion, deployContext, railwayStatus });
  console.log(JSON.stringify({ ok: false, artifactPath, stage: 'railway_status', railwayClass: railwayStatus.class }, null, 2));
  process.exit(1);
}
if (skipRailwayStatus) {
  console.log('\n[deploy] Railway status skipped by REMEDIATION_SKIP_RAILWAY_STATUS=1');
}

const predeploy = await runCaptured(npmCommand(['run', 'test:remediation:predeploy'], 'local predeploy gate'), 8 * 60_000);
if (!predeploy.ok) {
  await writeArtifact({ ok: false, stage: 'predeploy', railwayVersion, deployContext, railwayStatus, predeploy });
  console.log(JSON.stringify({ ok: false, artifactPath, stage: 'predeploy' }, null, 2));
  process.exit(1);
}

const deployArgs = ['up'];
if (deploymentMode === 'detach') deployArgs.push('--detach');
else if (deploymentMode === 'ci') deployArgs.push('--ci');
else if (deploymentMode === 'json') deployArgs.push('--json');
else {
  await writeArtifact({
    ok: false,
    stage: 'deploy_config',
    railwayVersion,
    deployContext,
    railwayStatus,
    predeploy,
    error: `Unsupported REMEDIATION_RAILWAY_MODE=${deploymentMode}. Use detach, ci, or json.`
  });
  console.log(JSON.stringify({ ok: false, artifactPath, stage: 'deploy_config' }, null, 2));
  process.exit(1);
}
deployArgs.push('--message', JSON.stringify(deploymentMessage));
if (process.env.REMEDIATION_RAILWAY_VERBOSE !== '0') deployArgs.push('--verbose');
if (process.env.RAILWAY_PROJECT) deployArgs.push('--project', JSON.stringify(process.env.RAILWAY_PROJECT));
if (process.env.RAILWAY_SERVICE) deployArgs.push('--service', JSON.stringify(process.env.RAILWAY_SERVICE));
if (process.env.RAILWAY_ENVIRONMENT) deployArgs.push('--environment', JSON.stringify(process.env.RAILWAY_ENVIRONMENT));
if (process.env.REMEDIATION_RAILWAY_PATH_AS_ROOT === '1') deployArgs.push('--path-as-root');
if (deploymentPath) deployArgs.push(JSON.stringify(deploymentPath));
const deploy = await runRailwayWithRetry(deployArgs, 'Railway deploy', 15 * 60_000, 2);
if (!deploy.ok) {
  await writeArtifact({ ok: false, stage: 'railway_deploy', railwayVersion, deployContext, railwayStatus, predeploy, deploy });
  console.log(JSON.stringify({ ok: false, artifactPath, stage: 'railway_deploy', railwayClass: deploy.class }, null, 2));
  process.exit(1);
}

const postdeploy = await runCaptured(npmCommand(['run', 'test:remediation:postdeploy'], 'postdeploy marker and live verification'), 20 * 60_000);
if (!postdeploy.ok) {
  await writeArtifact({ ok: false, stage: 'postdeploy', railwayVersion, deployContext, railwayStatus, predeploy, deploy, postdeploy });
  console.log(JSON.stringify({ ok: false, artifactPath, stage: 'postdeploy' }, null, 2));
  process.exit(1);
}

await writeArtifact({ ok: true, stage: 'complete', railwayVersion, deployContext, railwayStatus, predeploy, deploy, postdeploy });
console.log(JSON.stringify({ ok: true, artifactPath, stage: 'complete' }, null, 2));
