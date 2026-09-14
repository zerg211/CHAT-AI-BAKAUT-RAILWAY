import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
const target = new URL(process.env.DATABASE_URL || 'file:///missing');
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname) && target.pathname.startsWith('/bakaut_acceptance_'));
process.env.NODE_ENV = 'test';
const { pool } = await import('../src/db/pool.ts');
const { ProductRepository } = await import('../src/db/repositories.ts');
const repo = new ProductRepository(), key = randomUUID(), name = 'Concurrent ' + key;
const fact = { productName: name, attribute: 'weight', value: '10 kg', sourceType: 'manual',
  sourceUrl: 'https://fixtures.bakaut.invalid/manual/' + key, sourceTitle: name, evidence: name + ': 10 kg',
  sourceTier: 'official_manual', sourceAuthority: 'manufacturer', confidence: 'high', observedAt: new Date(Date.now() - 60000).toISOString() };
const lock = await pool.connect();
try {
  const first = await repo.upsertVerifiedProductFact(fact);
  await lock.query('BEGIN');
  await lock.query('SELECT id FROM verified_product_facts WHERE id=$1 FOR UPDATE', [first.id]);
  const newer = { ...fact, value: '12 kg', evidence: name + ': 12 kg', observedAt: new Date(Date.now() - 10000).toISOString() };
  const older = { ...fact, value: '11 kg', evidence: name + ': 11 kg', observedAt: new Date(Date.now() - 30000).toISOString() };
  const pending = [repo.upsertVerifiedProductFact(newer), repo.upsertVerifiedProductFact(older)];
  let waiting = 0;
  for (let i = 0; i < 100; i++) {
    waiting = (await pool.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'")).rows[0].n;
    if (waiting >= 2) break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.ok(waiting >= 2, 'Both real SQL writers must overlap at the held lock');
  await lock.query('COMMIT');
  await Promise.all(pending);
  const active = await repo.searchVerifiedProductFacts({ productNames: [name], sourceTypes: ['manual'] });
  assert.deepEqual(active.map(row => row.value), ['12 kg']);
  // Curation of the original evidence after a replacement also revokes that source slot.
  await pool.query("UPDATE verified_product_facts SET status='rejected' WHERE id=$1", [first.id]);
  assert.deepEqual(await repo.searchVerifiedProductFacts({ productNames: [name], sourceTypes: ['manual'] }), []);
  assert.equal(await repo.upsertVerifiedProductFact({ ...newer, observedAt: new Date().toISOString() }), null);
  await repo.upsertVerifiedProductFact({ ...newer, sourceUrl: fact.sourceUrl + '-independent' });
  assert.equal((await repo.searchVerifiedProductFacts({ productNames: [name], sourceTypes: ['manual'] })).length, 1);
  console.log(JSON.stringify({ status: 'PASS', level: 'I', checks: ['overlapping-source-writers-preserve-newest',
    'curation-after-replacement-revokes-slot', 'ordinary-write-cannot-unrevoke', 'independent-source-preserved'], modelCalls: 0 }));
} finally {
  await lock.query('ROLLBACK'); lock.release();
  await pool.query('DELETE FROM verified_product_facts WHERE product_name=$1', [name]);
  await pool.end();
}
