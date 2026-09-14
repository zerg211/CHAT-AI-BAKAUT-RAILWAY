// Public production catalog shapes replayed before upgrading 038 -> current.
// The source snapshot never contains sessions, leads, credentials or embeddings.
import assert from 'node:assert/strict';
import fs from 'node:fs';
const target=new URL(process.env.DATABASE_URL||'file:///missing');
assert.ok(['127.0.0.1','localhost','[::1]'].includes(target.hostname)&&target.pathname.startsWith('/bakaut_acceptance_'));
const snapshot=JSON.parse(fs.readFileSync(process.env.BAKAUT_LEGACY_SNAPSHOT,'utf8'));
assert.equal(snapshot.readOnly,true);assert.ok(snapshot.inventory.length>=10&&snapshot.products.length>=100);
process.env.NODE_ENV='test';
const {pool}=await import('../src/db/pool.ts');
const {runMigrations}=await import('../src/db/migrate.ts');
const {ProductRepository}=await import('../src/db/repositories.ts');
const {config}=await import('../src/config.ts');
const repo=new ProductRepository(),vector=Array(1536).fill(0.01);
try{
 assert.equal((await pool.query("SELECT to_regclass('public.schema_migrations') AS existing")).rows[0].existing,null,'fresh dedicated database only');
 await pool.query('CREATE TABLE schema_migrations(filename text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())');
 for(const file of fs.readdirSync('sql').filter(f=>f.endsWith('.sql')&&Number(f.slice(0,3))<=38).sort()){
  await pool.query(fs.readFileSync('sql/'+file,'utf8'));await pool.query('INSERT INTO schema_migrations(filename) VALUES($1)',[file]);
 }
 for(const p of snapshot.products)await pool.query(`INSERT INTO products(id,source_url,name,brand,category,price,currency,description,specs,raw,is_active,technical_version,source_content_hash,price_verified_at,price_source_url)
  VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11,$12,$13,$14,$15)`,[p.id,p.source_url,p.name,p.brand,p.category,p.price,p.currency,p.description,p.specs,p.raw,p.is_active,p.technical_version,p.source_content_hash,p.price_verified_at,p.price_source_url]);
 for(const p of snapshot.pages)await pool.query(`INSERT INTO catalog_pages(id,source_url,page_type,title,summary,content,source_content_hash,is_active)
  VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[p.id,p.source_url,p.page_type,p.title,p.summary,p.content,p.source_content_hash,p.is_active]);
 const before=(await pool.query('SELECT id,name,price,currency,description,specs,raw,is_active FROM products ORDER BY id')).rows;
 const pagesBefore=(await pool.query('SELECT id,source_url,page_type,title,summary,content,is_active FROM catalog_pages ORDER BY id')).rows;
 await pool.query('UPDATE catalog_pages SET embedding=$1::vector,embedding_model=$2',[`[${vector}]`,config.OPENAI_EMBEDDING_MODEL]);
 await runMigrations();
 assert.deepEqual((await pool.query('SELECT id,name,price,currency,description,specs,raw,is_active FROM products ORDER BY id')).rows,before);
 assert.deepEqual((await pool.query('SELECT id,source_url,page_type,title,summary,content,is_active FROM catalog_pages ORDER BY id')).rows,pagesBefore);
 assert.equal((await repo.vectorSearchCatalogPages(vector,200)).length,0,'legacy page vectors with unknown source revision are not current evidence');
 const eligible=[];
 for(const p of snapshot.products){const actual=await repo.getProductBySourceUrl(p.source_url);if(actual){assert.equal(actual.id,p.id);assert.deepEqual(actual.specs,p.specs);eligible.push(actual);}}
 assert.ok(eligible.length>=20);
 const chosen=eligible[0];
 await pool.query('UPDATE products SET embedding=$2::vector,embedding_model=$3 WHERE id=$1',[chosen.id,`[${vector}]`,config.OPENAI_EMBEDDING_MODEL]);
 assert.equal((await repo.getEmbeddingCoverage('products')).usable,1,'partial product index is reported honestly');
 assert.ok((await repo.vectorSearch(vector,200)).some(p=>p.id===chosen.id));
 const refreshed=await repo.upsertProduct({...chosen,raw:snapshot.products.find(p=>p.id===chosen.id).raw,description:(chosen.description||'')+'\nPublic fixture refresh.'});
 assert.equal(refreshed.id,chosen.id);
 assert.ok((await repo.searchProducts(chosen.name,200)).some(p=>p.id===chosen.id));
 const company=await repo.searchCatalogPages('контакты',200);
 assert.ok(company.length>0&&company.some(p=>p.content?.length>0),'public company source remains searchable while vectors rebuild');
 console.log(JSON.stringify({status:'PASS',level:'I',checks:['legacy-shapes','partial-index','normal-refresh-after-fix','migration-038-to-043-preserves-public-data','company-lexical-fallback'],products:snapshot.products.length,categories:snapshot.inventory.length,pages:snapshot.pages.length,eligible:eligible.length,source:'actual production public catalog fields, unmodified raw/specs; derived embeddings excluded',modelCalls:0}));
}finally{await pool.end();}
