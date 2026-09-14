// Public catalog snapshot only. Never copy sessions, leads or private knowledge.
import assert from 'node:assert/strict';
import fs from 'node:fs';
const target=new URL(process.env.DATABASE_URL||'file:///missing');
assert.ok(['127.0.0.1','localhost','[::1]'].includes(target.hostname)&&target.pathname.startsWith('/bakaut_acceptance_'));
const snapshot=JSON.parse(fs.readFileSync(process.env.BAKAUT_LEGACY_SNAPSHOT,'utf8'));
const rows=snapshot.data.products;
assert.ok(rows.length>=50&&new Set(rows.map(p=>p.category)).size>=3,'declared multi-category legacy sample');
process.env.NODE_ENV='test';
const {pool}=await import('../src/db/pool.ts');
const {ProductRepository}=await import('../src/db/repositories.ts');
const {config}=await import('../src/config.ts');
const repo=new ProductRepository(),ids=[];
try{
 for(const p of rows){
  const inserted=await pool.query(`INSERT INTO products(source_url,name,brand,category,price,currency,specs,raw,is_active,technical_version,source_content_hash)
   VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10,$11) RETURNING id`,
   // Admin projection intentionally omits internal raw. Declare reconstruction;
   // this is a public catalog replay, not a verbatim production DB dump.
   [p.sourceUrl,p.name,p.brand,p.category,p.price,p.currency,p.specs,{...p.raw,pageType:'product'},p.isActive,p.technicalVersion,p.sourceContentHash]);
  ids.push(inserted.rows[0].id);
 }
 const visible=[];
 for(let i=0;i<rows.length;i++){
  const p=rows[i],actual=await repo.getProductBySourceUrl(p.sourceUrl);
  if(!actual)continue; // Existing catalog eligibility also excludes accessories/nonproducts.
  assert.equal(actual.id,ids[i]);assert.equal(actual.name,p.name);assert.equal(actual.price,p.price);
  visible.push(actual);
 }
 assert.ok(visible.length>=20,'legacy real equipment remains eligible');
 const vector=Array(1536).fill(0.01);
 const selected=visible[0];
 await pool.query('UPDATE products SET embedding=$2::vector,embedding_model=$3 WHERE id=$1',[selected.id,`[${vector}]`,config.OPENAI_EMBEDDING_MODEL]);
 assert.ok((await repo.vectorSearch(vector,100)).some(p=>p.id===selected.id));
 assert.equal((await repo.getEmbeddingCoverage('products')).usable,1,'partial index is reported as partial');
 const refreshed=await repo.upsertProduct({...selected,raw:{pageType:'product'},description:(selected.description||'')+'\nUpdated public source fixture.'});
 assert.equal(refreshed.id,selected.id);
 assert.equal((await repo.getProductBySourceUrl(selected.sourceUrl)).name,selected.name);
 assert.ok((await repo.searchProducts(selected.name,100)).some(p=>p.id===selected.id),'normal refresh retains lexical identity');
 console.log(JSON.stringify({status:'PASS',level:'I',sample:'first 100 public admin products by repository order; no manual exclusions',categories:[...new Set(rows.map(p=>p.category))],rows:rows.length,eligible:visible.length,checks:['public-projection-replay','partial-index','normal-refresh-after-fix'],scope:'product catalog; company restart separately tested',reconstructedFields:['raw.pageType'],verbatimDatabaseSnapshot:false,modelCalls:0}));
}finally{await pool.query('DELETE FROM products WHERE id=ANY($1::uuid[])',[ids]);await pool.end();}
