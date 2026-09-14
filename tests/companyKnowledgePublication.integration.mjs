import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const target = new URL(process.env.DATABASE_URL || 'file:///missing');
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname) && target.pathname.startsWith('/bakaut_acceptance_'));
process.env.NODE_ENV = 'test';
process.env.CATALOG_BASE_URL = 'https://fixtures.bakaut.invalid';
const { pool } = await import('../src/db/pool.ts');
const { ProductRepository } = await import('../src/db/repositories.ts');
const { readFirstPartyPage } = await import('../src/ai/siteFirstParty.ts');
const repo = new ProductRepository(), id = randomUUID();
const url = process.env.CATALOG_BASE_URL + '/contacts/' + id;
const checks = [], jobIds = [];
const child = async code => {
  const result = await promisify(execFile)(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code],
    { cwd: process.cwd(), env: process.env, timeout: 20000, windowsHide: true });
  return result.stdout.trim().split('\n').findLast(line => line.startsWith('{'));
};
const worker = () => child("import {processKnowledgeEnrichment} from './src/ai/knowledgeEnrichment.ts'; import {pool} from './src/db/pool.ts'; console.log(JSON.stringify(await processKnowledgeEnrichment())); await pool.end();");
const read = (text, observedAt) => readFirstPartyPage(url, { baseUrl: process.env.CATALOG_BASE_URL, now: () => observedAt,
  fetchBytes: async target => ({ url: target, status: 200, headers: new Headers({ 'content-type': 'text/html' }),
    bytes: new TextEncoder().encode('<body><h1>Контакты</h1><main>' + 'Описание '.repeat(1300) +
      '</main><footer><p>' + text + '</p></footer></body>') }) });
try {
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM verified_fact_enrichment_jobs WHERE status IN ('pending','processing')")).rows[0].n, 0,
    'Use a clean isolated queue for this integration test');
  const older = await read('Офис Москва', new Date(Date.now() - 60000).toISOString());
  const newer = await read('Офис Иркутск', new Date(Date.now() - 30000).toISOString());
  assert.ok(older.ok && newer.ok);
  assert.ok(newer.page.cacheCandidate.content.includes('Иркутск'));
  assert.equal(newer.page.readRange.complete, false, 'model sees a bounded range, durable candidate retains the full source');
  assert.equal(await repo.enqueuePublicCompanyPage(older.page.cacheCandidate), true);
  assert.equal(await repo.enqueuePublicCompanyPage(newer.page.cacheCandidate), true);
  assert.equal(await repo.enqueuePublicCompanyPage({ ...newer.page.cacheCandidate, sourceUrl: url + '?token=private' }), false);
  assert.equal(await repo.enqueuePublicCompanyPage({ ...newer.page.cacheCandidate, sourceUrl: 'https://foreign.invalid/contacts' }), false);
  const jobs = (await pool.query('SELECT id,page_payload FROM verified_fact_enrichment_jobs WHERE page_payload->>\'sourceUrl\'=$1', [url])).rows;
  jobIds.push(...jobs.map(job => job.id));
  const newestJob = jobs.find(job => job.page_payload.sourceObservedAt === newer.page.observedAt);
  await pool.query("UPDATE verified_fact_enrichment_jobs SET available_at=now()-interval '1 minute' WHERE id=$1", [newestJob.id]);
  assert.equal(JSON.parse(await worker()).saved, 1);
  assert.equal(JSON.parse(await worker()).outcomes[0].status, 'superseded');
  const found = JSON.parse(await child("import {ProductRepository} from './src/db/repositories.ts'; import {pool} from './src/db/pool.ts'; const rows=await new ProductRepository().searchCatalogPages('Иркутск'); console.log(JSON.stringify({urls:rows.map(row=>row.sourceUrl)})); await pool.end();"));
  assert.ok(found.urls.includes(url));
  checks.push('company-source-footer-to-job-to-worker-to-new-process-search', 'newer-before-older-publication', 'query-private-and-origin-boundary');
  const pending = await read('Офис Томск', new Date().toISOString());
  assert.ok(pending.ok);
  await repo.enqueuePublicCompanyPage(pending.page.cacheCandidate);
  const lease = await repo.claimVerifiedFactEnrichmentJob(); jobIds.push(lease.id);
  await pool.query("UPDATE verified_fact_enrichment_jobs SET available_at=now()-interval '1 minute' WHERE id=$1", [lease.id]);
  assert.equal(JSON.parse(await worker()).saved, 1);
  assert.equal((await repo.publishCompanyPageJob(lease)).leaseLost, true);
  checks.push('company-worker-restart-fences-old-lease');
  console.log(JSON.stringify({ status: 'PASS', level: 'I', checks, modelCalls: 0 }));
} finally {
  await pool.query('DELETE FROM verified_fact_enrichment_jobs WHERE id=ANY($1::uuid[])', [jobIds]);
  await pool.query('DELETE FROM catalog_pages WHERE source_url=$1', [url]);
  await pool.end();
}
