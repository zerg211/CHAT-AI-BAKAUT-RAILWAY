import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
const target = new URL(process.env.DATABASE_URL || 'file:///missing');
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname) && target.pathname.startsWith('/bakaut_acceptance_'));
process.env.NODE_ENV = 'test';
const { pool } = await import('../src/db/pool.ts');
const { ProductRepository } = await import('../src/db/repositories.ts');
const repo = new ProductRepository();
const name = `Evidence quality ${randomUUID()}`;
const oldTime = new Date(Date.now() - 60000).toISOString();
const fact = { productName: name, attribute: 'Масса', value: '70 кг', sourceType: 'manual',
  sourceUrl: `https://fixtures.bakaut.invalid/${randomUUID()}`, sourceTitle: name,
  sourceTier: 'official_manual', sourceAuthority: 'manufacturer', confidence: 'high',
  observedAt: oldTime, evidence: 'Manufacturer manual: mass 70 kg.' };
try {
  const strong = await repo.upsertVerifiedProductFact(fact);
  assert.ok(strong);
  const independent = await repo.upsertVerifiedProductFact({ ...fact, sourceUrl: fact.sourceUrl + '/independent' });
  assert.ok(independent);
  const weak = await repo.upsertVerifiedProductFact({ ...fact, confidence: 'low', sourceTier: 'reliable_secondary',
    sourceAuthority: 'secondary', evidence: 'Uncertain indexed value: 70 kg', observedAt: new Date().toISOString() });
  assert.equal(weak.confidence, 'low');
  assert.equal(weak.sourceAuthority, 'secondary');
  assert.equal((await pool.query('SELECT confidence FROM verified_product_facts WHERE id=$1', [independent.id])).rows[0].confidence, 'high');
  await pool.query("UPDATE verified_product_facts SET status='rejected' WHERE id=$1", [weak.id]);
  assert.equal(await repo.upsertVerifiedProductFact({ ...fact, observedAt: new Date().toISOString() }), null);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM verified_product_facts WHERE product_name=$1 AND status='active'", [name])).rows[0].n, 1);
  console.log(JSON.stringify({ level: 'I', status: 'PASS', checks: ['Y06/weaker-new-evidence', 'Y06/revoked-old-evidence', 'Y06/two-valid-independent-sources'] }));
} finally {
  await pool.query('DELETE FROM verified_product_facts WHERE product_name=$1', [name]);
  await pool.end();
}
