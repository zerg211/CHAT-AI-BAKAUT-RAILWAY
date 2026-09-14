// Real repository/SQL, isolated loopback database only; no OpenAI or external IO.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
const target = new URL(process.env.DATABASE_URL || 'file:///missing');
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname) && target.pathname.startsWith('/bakaut_acceptance_'));
process.env.NODE_ENV = 'test';
const { pool } = await import('../src/db/pool.ts');
const { ProductRepository } = await import('../src/db/repositories.ts');
const { config } = await import('../src/config.ts');
const repo = new ProductRepository();
const key = randomUUID();
const sourceUrl = `https://fixtures.bakaut.invalid/${key}`;
const vector = Array(1536).fill(0.01);
const initial = { sourceUrl, pageType: 'company', title: 'Контакты', content: 'Москва офис Первая улица', summary: 'Первый офис' };
const checks = [];
try {
  const first = await repo.upsertCatalogPage(initial, vector, { model: config.OPENAI_EMBEDDING_MODEL, sourceHash: 'text-v1' });
  const originalRevision = first.sourceContentHash;
  assert.ok((await repo.vectorSearchCatalogPages(vector, 100)).some(p => p.id === first.id));
  const usableBefore = (await repo.getEmbeddingCoverage('catalog_pages')).usable;
  await pool.query("UPDATE catalog_pages SET embedding_source_revision='legacy-unknown' WHERE id=$1", [first.id]);
  assert.equal((await repo.getEmbeddingCoverage('catalog_pages')).usable, usableBefore - 1);
  assert.ok(!(await repo.vectorSearchCatalogPages(vector, 100)).some(p => p.id === first.id));
  await pool.query('UPDATE catalog_pages SET embedding_source_revision=source_content_hash WHERE id=$1', [first.id]);
  checks.push('Y10/legacy-vector-coverage');
  await repo.upsertCatalogPage({ ...initial, content: 'Москва офис Новая улица', summary: 'Новый офис' });
  const changed = (await pool.query('SELECT * FROM catalog_pages WHERE id=$1', [first.id])).rows[0];
  assert.notEqual(changed.source_content_hash, originalRevision);
  assert.equal(changed.embedding, null);
  assert.equal(changed.embedding_source_revision, null);
  assert.ok(!(await repo.vectorSearchCatalogPages(vector, 100)).some(p => p.id === first.id));
  checks.push('Y01/revision-change');
  assert.equal(await repo.updateCatalogPageEmbedding(first.id, vector, {
    model: config.OPENAI_EMBEDDING_MODEL, sourceHash: 'text-v1', expectedSourceRevision: originalRevision
  }), false);
  assert.equal(await repo.touchCatalogPageEmbeddingMetadata(first.id, {
    model: config.OPENAI_EMBEDDING_MODEL, sourceHash: 'text-v1', expectedSourceRevision: originalRevision
  }), false);
  assert.equal((await pool.query('SELECT embedding FROM catalog_pages WHERE id=$1', [first.id])).rows[0].embedding, null);
  checks.push('Y01/late-backfill');
  assert.ok((await repo.searchCatalogPages('Новая улица', 100)).some(p => p.id === first.id));
  assert.equal(await repo.updateCatalogPageEmbedding(first.id, vector, {
    model: config.OPENAI_EMBEDDING_MODEL, sourceHash: 'text-v2', expectedSourceRevision: changed.source_content_hash
  }), true);
  assert.ok((await repo.vectorSearchCatalogPages(vector, 100)).some(p => p.id === first.id));
  await repo.upsertCatalogPage({ ...initial, content: 'Москва офис Новая улица', summary: 'Новый офис' });
  assert.ok((await repo.vectorSearchCatalogPages(vector, 100)).some(p => p.id === first.id));
  checks.push('Y01/fallback-while-rebuilding-and-normal-refresh');
  const product = await repo.upsertProduct({ sourceUrl: sourceUrl + '/product', name: 'Revision fixture', specs: { power: '5 kW' } }, vector,
    { model: config.OPENAI_EMBEDDING_MODEL, sourceHash: 'product-v1' });
  try {
    const newer = await repo.upsertProduct({ sourceUrl: sourceUrl + '/product', name: 'Revision fixture', specs: { power: '7 kW' } });
    assert.notEqual(newer.technicalVersion, product.technicalVersion);
    assert.equal(await repo.updateProductEmbedding(product.id, vector, {
      model: config.OPENAI_EMBEDDING_MODEL, sourceHash: 'product-v1', expectedSourceRevision: product.technicalVersion
    }), false);
    assert.equal(await repo.touchProductEmbeddingMetadata(product.id, {
      model: config.OPENAI_EMBEDDING_MODEL, sourceHash: 'product-v1', expectedSourceRevision: product.technicalVersion
    }), false);
    assert.equal((await pool.query('SELECT embedding FROM products WHERE id=$1', [product.id])).rows[0].embedding, null);
    assert.equal(await repo.updateProductEmbedding(product.id, vector, {
      model: config.OPENAI_EMBEDDING_MODEL, sourceHash: 'product-v2', expectedSourceRevision: newer.technicalVersion
    }), true);
    checks.push('Y01/product-late-backfill');
  } finally { await pool.query('DELETE FROM products WHERE id=$1', [product.id]); }
  console.log(JSON.stringify({ level: 'I', checks, status: 'PASS' }));
} finally {
  await pool.query('DELETE FROM catalog_pages WHERE source_url=$1', [sourceUrl]);
  await pool.end();
}
