import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
const target = new URL(process.env.DATABASE_URL || 'file:///missing');
assert.ok(['127.0.0.1','localhost','[::1]'].includes(target.hostname) && target.pathname.startsWith('/bakaut_acceptance_'));
process.env.NODE_ENV='test';
process.env.CATALOG_BASE_URL='https://fixtures.bakaut.invalid';
const { pool } = await import('../src/db/pool.ts');
const { ProductRepository } = await import('../src/db/repositories.ts');
const repo = new ProductRepository(), key=randomUUID();
const time = n => new Date(Date.now()-100000+n*1000).toISOString();
const input={name:`price-${key}`,sourceUrl:`https://fixtures.bakaut.invalid/${key}`,price:100,currency:'RUB',
  specs:{mass:'70 kg'},raw:{sourceType:'site',pageType:'product'},priceObservedAt:time(1)};
let product;
const read=async()=> (await pool.query('SELECT * FROM products WHERE id=$1',[product.id])).rows[0];
const proof=async(price,observedAt)=>repo.updateVerifiedSitePrice({productId:product.id,productName:input.name,sourceUrl:input.sourceUrl,price,currency:'RUB',observedAt});
const mirrors=async()=> (await pool.query("SELECT value,unit,source_type FROM product_facts WHERE product_id=$1 AND attribute='price'",[product.id])).rows.map(row=>({...row,value:Number(row.value)}));
try {
  product=await repo.upsertProduct(input);
  const verifiedTime=time(3);
  assert.ok(await proof(150,verifiedTime));
  await repo.upsertProduct({...input,price:110,priceObservedAt:time(2)});
  let row=await read(); assert.equal(Number(row.price),150); assert.equal(new Date(row.price_verified_at).toISOString(),verifiedTime);
  assert.deepEqual(await mirrors(),[{value:150,unit:'RUB',source_type:'site'}]);
  await repo.upsertProduct({...input,price:undefined,currency:'USD',priceObservedAt:time(4)});
  row=await read(); assert.equal(Number(row.price),150); assert.equal(row.currency,'RUB');
  assert.equal(new Date(row.price_verified_at).toISOString(),verifiedTime);
  await repo.upsertProduct({...input,price:190,priceObservedAt:time(5)});
  row=await read(); assert.equal(Number(row.price),190); assert.equal(row.price_verified_at,null); assert.equal(row.price_source_url,null);
  assert.equal(await proof(160,time(4)),null);
  assert.ok(await proof(200,time(6)));
  await repo.upsertProduct({...input,price:50,priceObservedAt:undefined,raw:{sourceType:'csv'}});
  assert.equal(Number((await read()).price),200);
  await repo.upsertProduct({...input,price:undefined,priceOnRequest:true,priceObservedAt:time(7)});
  row=await read(); assert.equal(row.price,null); assert.equal(row.price_on_request,true); assert.equal(row.price_verified_at,null);
  assert.deepEqual(await mirrors(),[]);
  assert.equal(await proof(180,time(5)),null);
  assert.ok(await proof(220,time(8)));
  assert.equal((await read()).price_on_request,false);
  console.log(JSON.stringify({status:'PASS',level:'I',checks:['Y02/verify-then-old-sync','Y02/sync-then-verify','Y02/missing-field-not-tombstone','price-mirrors','explicit-tombstone','unobserved-csv']}));
} finally {
  if(product) await pool.query('DELETE FROM products WHERE id=$1',[product.id]);
  await pool.end();
}
