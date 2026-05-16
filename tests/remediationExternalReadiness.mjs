import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import dotenv from 'dotenv';
import pg from 'pg';
import {
  expectedRemediationContractVersion,
  expectedRemediationRuntimeArtifacts
} from './remediationProductionMarker.mjs';

dotenv.config({ quiet: true });

const { Client } = pg;
const artifactPath = path.join('local-live-tests', 'remediation-external-readiness.json');
const productionApiBase = process.env.PRODUCTION_API_BASE || 'https://chat-ai-production-3057.up.railway.app';

function truncate(value, maxLength = 1600) {
  const text = String(value ?? '');
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

function commandCheck(command, args, timeoutMs = 30_000, options = {}) {
  return new Promise((resolve) => {
    const shellCommand = [command, ...args].join(' ');
    const child = spawn(
      options.powershell ? 'powershell.exe' : command,
      options.powershell
        ? ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', shellCommand]
        : args,
      {
      cwd: process.cwd(),
      env: process.env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe']
      }
    );
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      resolve({
        ok: false,
        code: 'timeout',
        stdout: truncate(stdout),
        stderr: truncate(stderr)
      });
    }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ ok: false, code: 'spawn_error', error: String(error), stdout: truncate(stdout), stderr: truncate(stderr) });
    });
    child.on('exit', (exitCode, signal) => {
      clearTimeout(timer);
      resolve({
        ok: exitCode === 0,
        code: signal ? `signal:${signal}` : `exit:${exitCode}`,
        stdout: truncate(stdout),
        stderr: truncate(stderr)
      });
    });
  });
}

function errorSummary(error) {
  if (error?.errors && Array.isArray(error.errors)) {
    return error.errors.map((item) => `${item.code ?? item.name ?? 'error'} ${item.address ?? ''}:${item.port ?? ''}`.trim()).join('; ');
  }
  return truncate(error?.message || error);
}

function classifyOpenAi(status, body) {
  const text = `${status ?? ''} ${body ?? ''}`;
  if (/unsupported_country_region_territory/iu.test(text)) return 'provider_access_region';
  if (/invalid_api_key|incorrect api key|401/iu.test(text)) return 'authentication';
  if (/insufficient_quota|quota|billing|credits/iu.test(text)) return 'quota_or_billing';
  if (/rate_limit|429/iu.test(text)) return 'rate_limit';
  if (/model_not_found|permission|403/iu.test(text)) return 'model_project_or_org_access';
  return status && status >= 200 && status < 300 ? 'ok' : 'unknown';
}

function classifyRailway(result) {
  const text = `${result?.stdout ?? ''}\n${result?.stderr ?? ''}\n${result?.error ?? ''}`;
  if (result?.ok) return 'ok';
  if (/invalid_grant|Unauthorized|railway login/iu.test(text)) return 'railway_auth';
  if (/graphql|backboard\.railway\.com|timed out|timeout|ECONNRESET|connection|Connect|network/iu.test(text)) return 'railway_network';
  if (/not linked|link/iu.test(text)) return 'railway_project_link';
  return 'railway_unknown';
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function railwayStatusCheckWithRetry(maxAttempts = 3) {
  const attempts = [];
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const result = await commandCheck('railway', ['status'], 60_000, { powershell: process.platform === 'win32' });
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

async function checkRailwayGraphqlPost() {
  if (!process.env.RAILWAY_TOKEN) {
    return { ok: false, code: 'missing_railway_token', class: 'railway_auth' };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetch('https://backboard.railway.com/graphql/v2', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${process.env.RAILWAY_TOKEN}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ query: 'query { me { name } }' }),
      signal: controller.signal
    });
    const body = await response.text();
    return {
      ok: response.ok,
      status: response.status,
      class: response.ok ? 'ok' : classifyRailway({ stderr: body }),
      body: response.ok ? undefined : truncate(body)
    };
  } catch (error) {
    const text = String(error);
    return {
      ok: false,
      code: 'railway_graphql_post_failed',
      class: /reset|ECONNRESET|terminated|aborted|Connect|network/iu.test(text) ? 'railway_network' : 'railway_unknown',
      error: truncate(text)
    };
  } finally {
    clearTimeout(timer);
  }
}

async function checkOpenAi() {
  if (!process.env.OPENAI_API_KEY) {
    return { ok: false, code: 'missing_openai_api_key', class: 'authentication' };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch('https://api.openai.com/v1/models', {
      headers: { authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      signal: controller.signal
    });
    const body = await response.text();
    return {
      ok: response.ok,
      status: response.status,
      class: classifyOpenAi(response.status, body),
      body: response.ok ? undefined : truncate(body)
    };
  } catch (error) {
    return { ok: false, code: 'request_failed', class: 'network_or_runtime', error: String(error) };
  } finally {
    clearTimeout(timer);
  }
}

async function checkPostgres() {
  const connectionString = process.env.DATABASE_URL || 'postgres://chat_ai:chat_ai@localhost:5432/chat_ai';
  const client = new Client({ connectionString, connectionTimeoutMillis: 5000 });
  try {
    await client.connect();
    await client.query('select 1 as ok');
    return { ok: true };
  } catch (error) {
    return { ok: false, code: 'postgres_unavailable', error: errorSummary(error) };
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function checkProductionHealth() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(`${productionApiBase}/api/health`, { signal: controller.signal });
    const body = await response.text();
    let parsed = null;
    try {
      parsed = JSON.parse(body);
    } catch {
      // Keep raw body in the artifact.
    }
    const actualVersion = parsed?.remediation?.contractVersion;
    const actualRuntimeArtifacts = Array.isArray(parsed?.remediation?.runtimeArtifacts)
      ? parsed.remediation.runtimeArtifacts
      : [];
    const missingRuntimeArtifacts = expectedRemediationRuntimeArtifacts.filter(
      (artifact) => !actualRuntimeArtifacts.includes(artifact)
    );
    const markerOk = actualVersion === expectedRemediationContractVersion && missingRuntimeArtifacts.length === 0;
    return {
      ok: response.ok && markerOk,
      status: response.status,
      code: response.ok && !markerOk ? 'production_remediation_marker_mismatch' : undefined,
      expectedRemediationContractVersion,
      actualRemediationContractVersion: actualVersion ?? null,
      expectedRemediationRuntimeArtifacts,
      actualRemediationRuntimeArtifacts: actualRuntimeArtifacts,
      missingRemediationRuntimeArtifacts: missingRuntimeArtifacts,
      body: truncate(body)
    };
  } catch (error) {
    return { ok: false, code: 'production_health_unavailable', error: String(error) };
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  await fs.mkdir('local-live-tests', { recursive: true });
  const railway = await railwayStatusCheckWithRetry();
  const checks = {
    railway,
    railwayGraphqlPost: await checkRailwayGraphqlPost(),
    docker: await commandCheck('docker', ['info']),
    postgres: await checkPostgres(),
    openai: await checkOpenAi(),
    productionHealth: await checkProductionHealth()
  };
  const blockers = Object.entries(checks)
    .filter(([name, result]) => {
      if (result.ok) return false;
      return !(name === 'openai' && result.class === 'provider_access_region' && checks.productionHealth.ok);
    })
    .map(([name, result]) => ({ name, code: result.code ?? result.class ?? 'failed', class: result.class, status: result.status }));
  const warnings = Object.entries(checks)
    .filter(([name, result]) => name === 'openai' && !result.ok && result.class === 'provider_access_region' && checks.productionHealth.ok)
    .map(([name, result]) => ({ name, code: result.code ?? result.class ?? 'failed', class: result.class, status: result.status }));
  const artifact = {
    generatedAt: new Date().toISOString(),
    productionApiBase,
    ok: blockers.length === 0,
    blockers,
    warnings,
    checks
  };
  await fs.writeFile(artifactPath, JSON.stringify(artifact, null, 2), 'utf8');
  console.log(JSON.stringify({
    ok: artifact.ok,
    artifactPath,
    blockers
  }, null, 2));
  if (blockers.length) process.exit(1);
}

await main();
