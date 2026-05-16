import fs from 'node:fs/promises';
import path from 'node:path';
import dotenv from 'dotenv';

dotenv.config({ quiet: true });

const artifactPath = path.join('local-live-tests', 'remediation-railway-source-readiness.json');
const projectId = process.env.RAILWAY_PROJECT || '5ac0190c-6520-4612-853b-4884c9198fd9';
const environmentId = process.env.RAILWAY_ENVIRONMENT || 'f7b10ae1-f095-4304-832f-3bad1826dd37';
const serviceId = process.env.RAILWAY_SERVICE || 'cb87b747-a33b-41a8-895c-de507a96d5d1';

function truncate(value, maxLength = 1600) {
  const text = String(value ?? '');
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

function classifyGraphqlError(status, bodyOrError) {
  const text = `${status ?? ''} ${bodyOrError ?? ''}`;
  if (/Not Authorized|Unauthorized|invalid_grant|railway login/iu.test(text)) return 'railway_auth_or_scope';
  if (/backboard\.railway\.com|timed out|timeout|ECONNRESET|connection|Connect|network|reset/iu.test(text)) return 'railway_network';
  return 'railway_unknown';
}

async function writeArtifact(data) {
  await fs.mkdir('local-live-tests', { recursive: true });
  await fs.writeFile(artifactPath, JSON.stringify({
    generatedAt: new Date().toISOString(),
    projectId,
    environmentId,
    serviceId,
    ...data
  }, null, 2), 'utf8');
}

async function railwayGraphql(query, variables) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetch('https://backboard.railway.com/graphql/v2', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${process.env.RAILWAY_TOKEN}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ query, variables }),
      signal: controller.signal
    });
    const body = await response.text();
    let parsed = null;
    try {
      parsed = JSON.parse(body);
    } catch {
      // Keep raw body in the artifact.
    }
    return {
      ok: response.ok && !parsed?.errors?.length,
      status: response.status,
      data: parsed?.data,
      errors: parsed?.errors?.map((error) => ({
        message: error.message,
        path: error.path,
        code: error.extensions?.code
      })),
      body: parsed?.errors?.length ? undefined : response.ok ? undefined : truncate(body),
      class: response.ok && !parsed?.errors?.length ? 'ok' : classifyGraphqlError(response.status, body)
    };
  } catch (error) {
    return {
      ok: false,
      code: 'railway_graphql_request_failed',
      class: classifyGraphqlError(undefined, error),
      error: truncate(error)
    };
  } finally {
    clearTimeout(timer);
  }
}

function connectionNodes(connection) {
  return (connection?.edges ?? []).map((edge) => edge.node).filter(Boolean);
}

function summarize(result) {
  const serviceInstance = result.data?.serviceInstance;
  const autoDeploy = result.data?.serviceInstanceAutoDeployStatus;
  const deploymentTriggers = connectionNodes(result.data?.deploymentTriggers);
  const serviceRepoTriggers = connectionNodes(result.data?.service?.repoTriggers);
  const sourceRepo = serviceInstance?.source?.repo ?? null;
  const sourceImage = serviceInstance?.source?.image ?? null;
  const knownRepositories = [...deploymentTriggers, ...serviceRepoTriggers]
    .map((trigger) => trigger.repository)
    .filter(Boolean);
  const knownBranches = [...deploymentTriggers, ...serviceRepoTriggers]
    .map((trigger) => trigger.branch)
    .filter(Boolean);

  return {
    serviceName: serviceInstance?.serviceName ?? result.data?.service?.name ?? null,
    builder: serviceInstance?.builder ?? null,
    dockerfilePath: serviceInstance?.dockerfilePath ?? null,
    railwayConfigFile: serviceInstance?.railwayConfigFile ?? null,
    rootDirectory: serviceInstance?.rootDirectory ?? null,
    sourceRepo,
    sourceImage,
    autoDeploy,
    deploymentTriggers,
    serviceRepoTriggers,
    uniqueRepositories: [...new Set(knownRepositories)],
    uniqueBranches: [...new Set(knownBranches)]
  };
}

async function main() {
  if (!process.env.RAILWAY_TOKEN) {
    await writeArtifact({ ok: false, stage: 'missing_token', blocker: 'RAILWAY_TOKEN is required.' });
    console.log(JSON.stringify({ ok: false, artifactPath, stage: 'missing_token' }, null, 2));
    process.exitCode = 1;
    return;
  }

  const query = `query($projectId:String!,$environmentId:String!,$serviceId:String!){
    service(id:$serviceId){
      id
      name
      repoTriggers(first:20){
        edges{ node{ id repository branch provider checkSuites validCheckSuites environmentId projectId serviceId } }
      }
    }
    serviceInstance(environmentId:$environmentId,serviceId:$serviceId){
      id
      serviceId
      serviceName
      environmentId
      builder
      dockerfilePath
      railwayConfigFile
      rootDirectory
      source{ repo image }
      latestDeployment{ id status createdAt meta }
    }
    serviceInstanceAutoDeployStatus(projectId:$projectId,environmentId:$environmentId,serviceId:$serviceId){
      canEnable
      enabled
      reason
    }
    deploymentTriggers(projectId:$projectId,environmentId:$environmentId,serviceId:$serviceId,first:20){
      edges{ node{ id repository branch provider checkSuites validCheckSuites environmentId projectId serviceId } }
    }
  }`;

  const result = await railwayGraphql(query, { projectId, environmentId, serviceId });
  if (!result.ok) {
    await writeArtifact({
      ok: false,
      stage: 'railway_source_query',
      class: result.class,
      status: result.status,
      code: result.code,
      errors: result.errors,
      body: result.body,
      error: result.error
    });
    console.log(JSON.stringify({
      ok: false,
      artifactPath,
      stage: 'railway_source_query',
      class: result.class,
      status: result.status,
      errors: result.errors
    }, null, 2));
    process.exitCode = 1;
    return;
  }

  const source = summarize(result);
  const githubAutodeployKnown = source.uniqueRepositories.length > 0 && source.uniqueBranches.length > 0;
  await writeArtifact({
    ok: githubAutodeployKnown,
    stage: githubAutodeployKnown ? 'complete' : 'source_unknown',
    source
  });
  console.log(JSON.stringify({
    ok: githubAutodeployKnown,
    artifactPath,
    stage: githubAutodeployKnown ? 'complete' : 'source_unknown',
    repositories: source.uniqueRepositories,
    branches: source.uniqueBranches
  }, null, 2));
  if (!githubAutodeployKnown) process.exitCode = 1;
}

await main();
