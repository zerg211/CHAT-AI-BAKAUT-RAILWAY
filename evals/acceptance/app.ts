/** Isolated real-application test host. No mocks of planner/writer/reviewer.
 * NEVER deploy this file. Uses the project's existing dependencies and migrations.
 */
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { makeWorld } = require('./world.cjs');
const { sourceHash, currentCommit } = require('./fingerprint.cjs');
const explicitDb=process.env.DATABASE_URL;
if(process.env.BAKAUT_EVAL_ISOLATED_DB!=='YES' || !explicitDb) throw new Error('Set BAKAUT_EVAL_ISOLATED_DB=YES and an explicit disposable DATABASE_URL.');
const dbUrl=new URL(explicitDb);
if(!['localhost','127.0.0.1','[::1]'].includes(dbUrl.hostname) || !(dbUrl.pathname.startsWith('/bakaut_acceptance_') && dbUrl.pathname.length>19 && [...dbUrl.pathname.slice(19)].every(c=>'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_'.includes(c)))) throw new Error('Only a loopback bakaut_acceptance_* database is allowed. No production DB.');
if(!process.env.OPENAI_API_KEY || !process.env.BAKAUT_EVAL_AGENT_MODEL)throw new Error('Explicit OPENAI_API_KEY and BAKAUT_EVAL_AGENT_MODEL are required. Starting this host does not call the model.');
process.env.NODE_ENV='test';
const token=randomBytes(32).toString('hex');
process.env.ADMIN_API_KEY=token;process.env.ADMIN_PASSWORD='';
for(const key of ['EMAIL_HTTP_URL','EMAIL_HTTP_AUTH_HEADER','EMAIL_FROM','LEADS_TO_EMAIL','RESEND_API_KEY','RESEND_FROM','LEAD_EMAIL_TO','LEAD_EMAIL'])process.env[key]='';
// Mirror production role settings explicitly, without changing production variables.
for(const key of ['OPENAI_MODEL','OPENAI_ANSWER_MODEL','OPENAI_PLANNER_MODEL','OPENAI_FACT_MODEL','OPENAI_DEEP_REASONING_MODEL'])process.env[key]=process.env.BAKAUT_EVAL_AGENT_MODEL;
process.env.OPENAI_MAX_OUTPUT_TOKENS='4000';process.env.OPENAI_PLANNER_MAX_OUTPUT_TOKENS='9000';
process.env.OPENAI_ANSWER_REASONING_EFFORT='medium';process.env.OPENAI_PLANNER_REASONING_EFFORT='low';process.env.OPENAI_FACT_REASONING_EFFORT='xhigh';
const commit=currentCommit();
const loadedCodeHash=sourceHash();
process.env.GIT_COMMIT_SHA=commit;
const port=Number(process.env.BAKAUT_EVAL_PORT||4310);
if(!Number.isSafeInteger(port)||port<1024||port>65535)throw new Error('Invalid port');
process.env.PUBLIC_BASE_URL=`http://127.0.0.1:${port}`;
const {pool}=await import('../../src/db/pool.js');
const {ProductRepository}=await import('../../src/db/repositories.js');
const lease=await pool.connect();
const lock=await lease.query('SELECT pg_try_advisory_lock(87395121) AS ok');
if(!lock.rows[0]?.ok)throw new Error('Another acceptance host owns this fixture database.');
const repo=new ProductRepository();
function categoryFor(c:string){return ({generator:'Генераторы',plate:'Виброплиты',rammer:'Вибротрамбовки',plateAccessory:'Коврики для виброплит',cutter:'Швонарезчики'} as Record<string,string>)[c]??c;}
async function resetWorld(seedMemory=false,equivalentMemory=false) {
 const unexpected=await pool.query("SELECT count(*)::int AS n FROM products WHERE coalesce(raw->>'acceptanceFixture','') <> 'bakaut-v2'");
 if(unexpected.rows[0].n)throw new Error('Database is not empty/fixture-only. Refusing to modify it.');
 const world=makeWorld();
 for(const p of world.products){const saved=await repo.upsertProduct({externalId:`acceptance-${p.key}`,sourceUrl:p.sourceUrl,name:p.name,brand:'BAKAUT-TEST',category:categoryFor(p.class),price:p.price,currency:'RUB',specs:p.specs,description:'Синтетический товар только для изолированных тестов. Не для продажи.',raw:{pageType:'product',sourceType:'csv',acceptanceFixture:'bakaut-v2'}});p.id=saved.id;}
 const ids=world.products.map((p:any)=>p.id);
 await pool.query('DELETE FROM verified_product_facts WHERE product_id=ANY($1::uuid[])',[ids]);
 await pool.query("DELETE FROM product_facts WHERE product_id=ANY($1::uuid[]) AND source_type='web'",[ids]);
 if(seedMemory)for(const [key,attribute,value] of [['G5','Масса','70 кг'],['G5','Автоматический запуск АВР','Нет'],['P85','Совместимый коврик','Коврик для виброплиты BAKAUT-TEST MAT85']]){
  const p=world.products.find((p:any)=>p.key===key),source=world.sources.find((s:any)=>s.id===`manual:${key}`);
  await repo.upsertVerifiedProductFact({productId:p.id,productName:p.name,attribute,value,sourceType:'manual',sourceUrl:source.url,sourceTitle:source.title,evidence:source.text,sourceTier:'official_manual',sourceAuthority:'manufacturer',confidence:'high',observedAt:new Date().toISOString()});
 }
 if(equivalentMemory){const p=world.products.find((p:any)=>p.key==='G5');await repo.upsertVerifiedProductFact({productId:p.id,productName:p.name,attribute:'Масса',value:'70000 г',sourceType:'manual',sourceUrl:'https://fixtures.bakaut.invalid/manual/G5-alt',sourceTitle:'BAKAUT-TEST G5 alternate test manual',evidence:'Тестовый BAKAUT-TEST G5: масса 70000 г.',sourceTier:'official_manual',sourceAuthority:'manufacturer',confidence:'high',observedAt:new Date().toISOString()});}
 return world;
}
let world=await resetWorld();
const {buildApp}=await import('../../src/app.js');
const app=await buildApp();
app.post('/__acceptance/control',async(req:any,reply:any)=>{
 if(req.headers.authorization!==`Bearer ${token}`)return reply.code(403).send({error:'forbidden'});
 const b=req.body??{};
 if(sourceHash()!==loadedCodeHash||currentCommit()!==commit)return reply.code(409).send({error:'Restart acceptance host after changing code or commit'});
 if(b.action==='reset'){world=await resetWorld(b.seedMemory===true,b.equivalentMemory===true);return {world,codeHash:loadedCodeHash,commit,nodeEnv:'test',emailWorker:false};}
 if(b.action==='set-price'){
  const p=world.products.find((p:any)=>p.key===b.key);if(!p||!Number.isFinite(b.price)||b.price<=0||b.price>10000000)return reply.code(400).send({error:'invalid price'});
  p.price=b.price;await repo.upsertProduct({externalId:`acceptance-${p.key}`,sourceUrl:p.sourceUrl,name:p.name,brand:'BAKAUT-TEST',category:categoryFor(p.class),price:p.price,currency:'RUB',specs:p.specs,description:'Синтетический товар только для изолированных тестов. Не для продажи.',raw:{pageType:'product',sourceType:'csv',acceptanceFixture:'bakaut-v2'}});return {world};
 }
 if(b.action==='facts'){
  const p=world.products.find((p:any)=>p.key===b.key);if(!p)return reply.code(400).send({error:'unknown fixture'});
  const facts=await repo.searchVerifiedProductFacts({productIds:[p.id],sourceTypes:['web','manual'],limit:100});return {facts};
 }
 if(b.action==='outbox'){
  if(typeof b.sessionId!=='string'||b.sessionId.length!==36||![...b.sessionId].every(c=>'0123456789abcdef-'.includes(c)))return reply.code(400).send({error:'bad session'});
  const rows=await pool.query('SELECT id, lead_id, session_id, status FROM lead_outbox WHERE session_id=$1::uuid',[b.sessionId]);return {outbox:rows.rows};
 }
 if(b.action==='snapshot')return {world,codeHash:loadedCodeHash,commit,nodeEnv:'test',emailWorker:false};
 return reply.code(400).send({error:'unknown action'});
});
await app.listen({host:'127.0.0.1',port});
fs.mkdirSync('.private',{recursive:true});
fs.writeFileSync('.private/acceptance-target.json',JSON.stringify({baseUrl:`http://127.0.0.1:${port}`,adminToken:token,commit,codeHash:sourceHash(),label:'isolated test host, real OpenAI calls only after explicit runner approval'}),{mode:0o600});
console.log(`Isolated acceptance host listening on 127.0.0.1:${port}. Token stored ONLY in .private/acceptance-target.json. No email worker. No model calls made by startup.`);
let closing=false;
async function stop(){if(closing)return;closing=true;await app.close();await lease.query('SELECT pg_advisory_unlock(87395121)');lease.release();await pool.end();try{fs.unlinkSync('.private/acceptance-target.json');}catch{}process.exit(0);}
process.on('SIGINT',()=>void stop());process.on('SIGTERM',()=>void stop());
