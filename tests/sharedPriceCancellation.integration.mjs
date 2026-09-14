import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {once} from 'node:events';
const target=new URL(process.env.DATABASE_URL||'file:///missing');
assert.ok(['127.0.0.1','localhost','[::1]'].includes(target.hostname)&&target.pathname.startsWith('/bakaut_acceptance_'));
process.env.NODE_ENV='test';
const {pool}=await import('../src/db/pool.ts');
const {ProductRepository}=await import('../src/db/repositories.ts');
const {singleflightPriceReader}=await import('../src/catalog/priceSingleflight.ts');
const {verifyBudgetPrices}=await import('../src/catalog/verifyBudgetPrices.ts');
const repo=new ProductRepository();let product,release,started,requests=0,firstWrites=0,secondWrites=0;
const began=new Promise(resolve=>{started=resolve;});
const ready=new Promise(resolve=>{release=resolve;});
const server=createServer(async(_request,response)=>{requests++;started();await ready;response.end('120');});
try{
 server.listen(0,'127.0.0.1');await once(server,'listening');
 const key=randomUUID();
 product=await repo.upsertProduct({name:'Shared price fixture '+key,sourceUrl:'https://bakautprof.ru/catalog/'+key,
  price:100,currency:'RUB',specs:{power:'5 kW'},raw:{pageType:'product'},priceObservedAt:new Date(Date.now()-10000).toISOString()});
 const broker=singleflightPriceReader(async p=>({productId:p.id,productName:p.name,previousPrice:p.price,
  price:Number(await (await fetch(`http://127.0.0.1:${server.address().port}/price`)).text()),currency:'RUB',sourceUrl:p.sourceUrl,observedAt:new Date().toISOString(),evidence:'120 RUB'}));
 const abort=new AbortController();
 const first=verifyBudgetPrices({products:[product],signal:abort.signal,read:broker,persist:proof=>{firstWrites++;return repo.updateVerifiedSitePrice(proof);}});
 const second=verifyBudgetPrices({products:[product],read:broker,persist:proof=>{secondWrites++;return repo.updateVerifiedSitePrice(proof);}});
 await began;abort.abort();
 const cancelled=await first;assert.equal(cancelled.proofs[0].status,'unavailable');assert.equal(firstWrites,0);
 release();const completed=await second;
 assert.equal(requests,1);assert.equal(secondWrites,1);assert.equal(completed.proofs[0].status,'verified');
 assert.equal((await repo.getProductBySourceUrl(product.sourceUrl)).price,120);
 console.log(JSON.stringify({status:'PASS',level:'I',checks:['one-shared-HTTP-operation','one-waiter-cancelled','cancelled-no-publication','other-waiter-real-PG-publication'],modelCalls:0,scope:'actual singleflight and verification pipeline; loopback controlled price provider, actual PostgreSQL'}));
}finally{release();server.closeAllConnections();server.close();if(product)await pool.query('DELETE FROM products WHERE id=$1',[product.id]);await pool.end();}
