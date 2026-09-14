import assert from 'node:assert/strict';
const target = new URL(process.env.DATABASE_URL || 'file:///missing');
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname) && target.pathname.startsWith('/bakaut_acceptance_'));
process.env.NODE_ENV = 'test';
process.env.OPENAI_API_KEY = 'isolated-placeholder-never-called';
const { pool } = await import('../src/db/pool.ts');
const { buildApp } = await import('../src/app.ts');
const { createReadinessProbe } = await import('../src/db/readiness.ts');
const { agentManagerToolRegistry } = await import('../src/ai/agentManagerToolRegistry.ts');
const app = await buildApp();
const deadUrl = new URL(target); deadUrl.port = '1';
const unavailable = createReadinessProbe(deadUrl.href, () => true);
const missingCapability = createReadinessProbe(target.href, () => false);
const fresh = createReadinessProbe(target.href, () => true);
try {
  assert.ok(Object.keys(agentManagerToolRegistry).length > 0);
  assert.equal((await app.inject('/api/health')).statusCode, 200);
  const response = await app.inject('/api/ready');
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { ready: true });
  assert.equal(process.env.OPENAI_API_KEY, 'isolated-placeholder-never-called');
  assert.equal(await unavailable.check(), false);
  assert.equal(await missingCapability.check(), false);
  await pool.query("UPDATE schema_migrations SET filename='isolated-test-temporarily-incompatible' WHERE filename='039_catalog_page_embedding_revision.sql'");
  assert.equal(await fresh.check(), false);
  console.log(JSON.stringify({ level: 'I', status: 'PASS', checks: ['Y09/db-unavailable', 'Y09/schema-incompatible', 'Y09/external-degraded', 'Y09/healthy-readiness-safe-probe'], externalProviderCalls: 0 }));
} finally {
  await pool.query("UPDATE schema_migrations SET filename='039_catalog_page_embedding_revision.sql' WHERE filename='isolated-test-temporarily-incompatible'");
  await Promise.all([app.close(), unavailable.close(), missingCapability.close(), fresh.close()]);
  await pool.end();
}
