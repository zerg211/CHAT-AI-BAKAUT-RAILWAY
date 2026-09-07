'use strict';
// Real API/DB contracts, zero requests to model endpoints. Requires isolated app.ts.
const {equivalent}=require('./engine.cjs');
async function backendAudit(client){const checks=[],sessions=[];
 async function check(id,fn){try{const ok=await fn();checks.push({id,status:ok?'PASS':'FAIL'});}catch(e){checks.push({id,status:'INCONCLUSIVE',errorCode:e.code??e.message});}}
 try{
  const a=await client.start(),b=await client.start();sessions.push(a,b);
  await check('SESSION_OWNER_HISTORY',async()=>{const r=await client.json(`/api/chat/sessions/${a.id}/messages`,{visitorId:a.visitorId});return Array.isArray(r.messages);});
  await check('CROSS_SESSION_HISTORY_ISOLATION',async()=>{try{await client.json(`/api/chat/sessions/${a.id}/messages`,{visitorId:b.visitorId});return false;}catch(e){if(e.code==='HTTP_404')return true;throw e;}});
  await check('ADMIN_REQUIRES_AUTH',async()=>{try{await client.json('/api/admin/health');return false;}catch(e){if(e.code==='HTTP_401'||e.code==='HTTP_403')return true;throw e;}});
  await client.control({action:'reset',seedMemory:true});
  await check('VERIFIED_FACT_RETRIEVABLE',async()=>{const r=await client.control({action:'facts',key:'G5'});return r.facts.some(f=>f.attribute==='Масса'&&equivalent(f.value,'',70,'кг'));});
  await client.control({action:'set-price',key:'G5',price:84000});
  await check('PRICE_CHANGE_PRESERVES_TECHNICAL_MEMORY',async()=>{const r=await client.control({action:'facts',key:'G5'});return r.facts.some(f=>f.attribute==='Масса'&&equivalent(f.value,'',70,'кг'));});
 }catch(e){checks.push({id:'BACKEND_SETUP',status:'INCONCLUSIVE',errorCode:e.code??e.message});}
 finally{try{await client.control({action:'reset'});}catch(e){checks.push({id:'BACKEND_RESET',status:'INCONCLUSIVE',errorCode:e.code??e.message});}for(const s of sessions)try{await client.close(s);}catch(e){checks.push({id:'BACKEND_SESSION_CLEANUP',status:'INCONCLUSIVE',errorCode:e.code??e.message});}}
 return {mode:'real-backend-no-model',paidCalls:0,pass:checks.length>=5&&checks.every(c=>c.status==='PASS'),checks};
}
if(require.main===module){const fs=require('node:fs');const {HttpClient}=require('./http.cjs');const file=process.argv[2]||'.private/acceptance-target.json';(async()=>{const target=JSON.parse(fs.readFileSync(file));const u=new URL(target.baseUrl);if(!['127.0.0.1','localhost','[::1]'].includes(u.hostname))throw new Error('Isolated loopback target required');const c=new HttpClient({...target,maxRequests:30});const r=await backendAudit(c);console.log(JSON.stringify(r,null,2));process.exitCode=r.pass?0:1;})().catch(e=>{console.error(e.code??e.message);process.exitCode=2;});}
module.exports={backendAudit};
