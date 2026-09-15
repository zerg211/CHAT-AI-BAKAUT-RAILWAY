import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
const target = new URL(process.env.DATABASE_URL || 'file:///missing');
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname) && target.pathname.startsWith('/bakaut_acceptance_'));
process.env.NODE_ENV = 'test';
const { pool } = await import('../src/db/pool.ts');
const { ProductRepository } = await import('../src/db/repositories.ts');
const { processKnowledgeEnrichment } = await import('../src/ai/knowledgeEnrichment.ts');
const repo = new ProductRepository(), key = randomUUID();
const name = `enrichment-${key}`;
const fact = index => ({ productName: name, attribute: `attribute-${index}`, value: '70 kg', sourceType: 'manual',
  sourceUrl: `https://fixtures.bakaut.invalid/${key}`, sourceTitle: name, sourceTier: 'official_manual',
  sourceAuthority: 'manufacturer', confidence: 'high', observedAt: new Date(Date.now()-60000).toISOString(),
  evidence: `Manual ${name}: 70 kg`, evidenceVerifiedExact: true });
const jobs = [];
const enqueue = async (suffix, facts) => {
  await repo.enqueueVerifiedProductFacts(`${key}-${suffix}`, facts);
  const row = (await pool.query('SELECT * FROM verified_fact_enrichment_jobs WHERE dedupe_key=$1', [`${key}-${suffix}`])).rows[0];
  jobs.push(row.id); return row.id;
};
const reload = async id => (await pool.query('SELECT * FROM verified_fact_enrichment_jobs WHERE id=$1', [id])).rows[0];
const count = async attribute => (await pool.query("SELECT count(*)::int AS n FROM verified_product_facts WHERE product_name=$1 AND attribute=$2 AND status='active'", [name, attribute])).rows[0].n;
const checks = [];
try {
  const malformed = await enqueue('malformed-subject', [{ ...fact(11), productId: 'not-a-uuid' }, fact(12)]);
  assert.equal((await reload(malformed)).facts.length, 2, 'enqueue must preserve every independent item');
  await processKnowledgeEnrichment(repo);
  assert.equal((await reload(malformed)).item_outcomes['0'].status, 'rejected');
  assert.ok((await reload(malformed)).item_outcomes['1'], 'valid following item must receive an outcome');
  assert.equal((await reload(malformed)).item_outcomes['1'].status, 'published');
  assert.equal(await count('attribute-12'), 1);
  checks.push('Y04/poison-subject-at-enqueue');
  const first = await enqueue('invalid-first', [{ ...fact(0), evidence: '' }, fact(1)]);
  await processKnowledgeEnrichment(repo);
  assert.equal(await count('attribute-1'), 1, 'valid item after a poison item must publish');
  assert.equal((await reload(first)).item_outcomes['0'].status, 'rejected');
  assert.equal((await reload(first)).status, 'completed');
  checks.push('Y04/invalid-first');
  const middle = await enqueue('middle', [fact(2), { ...fact(3), observedAt: 'invalid' }, fact(4)]);
  await processKnowledgeEnrichment(repo);
  assert.equal(await count('attribute-2'), 1); assert.equal(await count('attribute-4'), 1);
  assert.equal(Object.keys((await reload(middle)).item_outcomes).length, 3);
  checks.push('Y04/valid-invalid-valid');
  const coupled = await enqueue('coupled', [{ ...fact(5), atomicGroup: 'ratings' }, { ...fact(6), atomicGroup: 'ratings', evidence: '' }]);
  await processKnowledgeEnrichment(repo);
  assert.equal(await count('attribute-5'), 0); assert.equal(await count('attribute-6'), 0);
  assert.equal((await reload(coupled)).item_outcomes['0'].status, 'rejected');
  checks.push('Y04/coupled-group');
  const leaseId = await enqueue('lease', [fact(7), fact(8)]);
  const old = await repo.claimVerifiedFactEnrichmentJob(); assert.equal(old.id, leaseId);
  await repo.publishVerifiedFactEnrichmentGroup(old, [0]);
  await pool.query("UPDATE verified_fact_enrichment_jobs SET available_at=now()-interval '1 second' WHERE id=$1", [leaseId]);
  const current = await repo.claimVerifiedFactEnrichmentJob(); assert.equal(current.id, leaseId);
  assert.deepEqual(await repo.publishVerifiedFactEnrichmentGroup(old, [1]), { leaseLost: true, outcomes: [] });
  assert.equal(await count('attribute-8'), 0);
  assert.equal(await repo.finishVerifiedFactEnrichmentJob(old), false);
  await repo.publishVerifiedFactEnrichmentGroup(current, [1]);
  assert.equal(await repo.finishVerifiedFactEnrichmentJob(current), true);
  assert.equal(await count('attribute-8'), 1);
  checks.push('Y05/lease-lost-before-write', 'Y05/takeover-mid-batch', 'Y05/current-owner-success');
  const reuseId = await enqueue('reuse', [fact(1)]);
  await processKnowledgeEnrichment(repo);
  assert.equal((await reload(reuseId)).item_outcomes['0'].status, 'reused');
  assert.equal(await count('attribute-1'), 1);
  checks.push('Y03/legitimate-reuse');
  const newer = { ...fact(9), observedAt: new Date().toISOString() }; await repo.upsertVerifiedProductFact(newer);
  const staleId = await enqueue('stale', [fact(9)]);
  await processKnowledgeEnrichment(repo);
  assert.equal((await reload(staleId)).item_outcomes['0'].status, 'superseded');
  checks.push('Y03/all-superseded');
  const noWriteId = await enqueue('noop', [fact(10)]);
  await pool.query(`CREATE OR REPLACE FUNCTION isolated_drop_attribute_10() RETURNS trigger AS $$
    BEGIN IF NEW.attribute='attribute-10' THEN RETURN NULL; END IF; RETURN NEW; END $$ LANGUAGE plpgsql`);
  await pool.query(`CREATE TRIGGER isolated_drop_attribute_10 BEFORE INSERT ON verified_product_facts
    FOR EACH ROW EXECUTE FUNCTION isolated_drop_attribute_10()`);
  await processKnowledgeEnrichment(repo);
  assert.equal((await reload(noWriteId)).item_outcomes['0'].status, 'retryable_failure');
  assert.equal((await reload(noWriteId)).status, 'pending');
  assert.equal(await count('attribute-10'), 0);
  checks.push('Y03/all-null-unclassified');
  console.log(JSON.stringify({ status: 'PASS', level: 'I', checks }));
} finally {
  await pool.query('DROP TRIGGER IF EXISTS isolated_drop_attribute_10 ON verified_product_facts');
  await pool.query('DROP FUNCTION IF EXISTS isolated_drop_attribute_10()');
  await pool.query('DELETE FROM verified_fact_enrichment_jobs WHERE id=ANY($1::uuid[])', [jobs]);
  await pool.query('DELETE FROM verified_product_facts WHERE product_name=$1', [name]);
  await pool.end();
}
