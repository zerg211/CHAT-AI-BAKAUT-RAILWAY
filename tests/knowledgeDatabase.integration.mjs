// Explicit, real PostgreSQL regression checks. Never run on the working catalog.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
const url = new URL(process.env.DATABASE_URL || 'file:///missing');
assert.ok(['127.0.0.1','localhost','[::1]'].includes(url.hostname) && url.pathname.startsWith('/bakaut_acceptance_'),
  'An explicit isolated loopback bakaut_acceptance_* database is required');
process.env.NODE_ENV='test';
process.env.CATALOG_BASE_URL='https://fixtures.bakaut.invalid';
const {pool}=await import('../src/db/pool.ts');
const {ProductRepository,ConversationRepository}=await import('../src/db/repositories.ts');
const {buildDialogueQualityAudit}=await import('../src/ai/dialogueQualityAudit.ts');
const {processKnowledgeEnrichment}=await import('../src/ai/knowledgeEnrichment.ts');
const {validateToolResultOutput}=await import('../src/ai/agentManagerToolRegistry.ts');
const repo=new ProductRepository();
const checks=[];
const run=async(id,fn)=>{await fn();checks.push({id,status:'PASS'});};
const key=randomUUID();
let p;
const input={name:`BAKAUT-TEST KNOWLEDGE ${key}`,sourceUrl:`https://fixtures.bakaut.invalid/${key}`,
  externalId:key,price:100,specs:{'Масса':'70 кг'},raw:{acceptanceFixture:'bakaut-v2',pageType:'product'},currency:'RUB'};
const fact={productName:input.name,attribute:'Масса',value:'70 кг',sourceType:'manual',
  sourceUrl:`https://fixtures.bakaut.invalid/manual/${key}`,sourceTitle:input.name,
  evidence:`${input.name}: масса 70 кг.`,sourceTier:'official_manual',sourceAuthority:'manufacturer',
  confidence:'high',observedAt:new Date(Date.now()-86400000).toISOString()};
try {
 await run('REAL_AUDIT_RETRIEVES_FAILED_AND_COMPLETED_TURNS_WITHOUT_BUYER_TEXT',async()=>{
  const sessionId=randomUUID(),failedId=randomUUID(),completeId=randomUUID(),messageId=randomUUID();
  await pool.query('INSERT INTO conversation_sessions(id) VALUES($1)',[sessionId]);
  try {
   await pool.query("INSERT INTO messages(id,session_id,role,content,metadata) VALUES($1,$2,'assistant','private fixture', $3)",
    [messageId,sessionId,JSON.stringify({build:{commitSha:'test-build'},turnBudget:{usage:{wallTimeMs:40000,modelCalls:4}},
      toolResults:[{tool:'catalog.getProductDetails',status:'ok',payload:{priceVerifications:[{status:'unavailable'}]}}]})]);
   await pool.query(`INSERT INTO conversation_turns(id,session_id,status,request_hash,deadline_at,error_code)
      VALUES($1::uuid,$2,'failed',$1::text,now()-interval '1 minute','generation_failed')`,[failedId,sessionId]);
   await pool.query(`INSERT INTO conversation_turns(id,session_id,status,request_hash,deadline_at,assistant_message_id)
      VALUES($1::uuid,$2,'completed',$1::text,now(),$3)`,[completeId,sessionId,messageId]);
   const rows=(await new ConversationRepository().listQualityAuditTurns(1,500)).filter(r=>r.sessionId===sessionId);
   assert.equal(rows.length,2);
   const report=buildDialogueQualityAudit(rows,{hours:1,limit:500});
   assert.equal(report.qualityVerdict,'NOT_PROVEN');
   assert.ok(report.reviewQueue.some(g=>g.reason==='expired_without_answer'));
   assert.ok(report.reviewQueue.some(g=>g.reason==='company_price_unavailable'));
   assert.equal(report.turns.find(t=>t.turnId===completeId).buildCommit,'test-build');
   assert.equal(report.latency.medianMs,40000);
   assert.ok(!JSON.stringify(report).includes('private fixture'));
   const conversations=new ConversationRepository();
   assert.equal(rows.find(t=>t.turnId===completeId).resolutionStatus,'unknown');
   assert.equal(await conversations.annotateConversationOutcome({sessionId:randomUUID(),turnId:completeId,resolutionStatus:'resolved',actor:'test-reviewer'}),false);
   assert.equal(await conversations.annotateConversationOutcome({sessionId,turnId:failedId,resolutionStatus:'resolved',actor:'test-reviewer'}),false);
   assert.equal(await conversations.annotateConversationOutcome({sessionId,turnId:completeId,resolutionStatus:'resolved',actor:'test-reviewer'}),true);
   const annotated=(await conversations.listQualityAuditTurns(1,500)).find(t=>t.turnId===completeId);
   assert.equal(annotated.resolutionStatus,'resolved');
   assert.equal(await conversations.recordAnswerDelivery({sessionId:randomUUID(),messageId,firstUsefulContentMs:123}),false);
   assert.equal(await conversations.recordAnswerDelivery({sessionId,messageId,firstUsefulContentMs:123}),true);
   assert.equal(await conversations.recordAnswerDelivery({sessionId,messageId,firstUsefulContentMs:999}),true);
   const delivered=(await conversations.listQualityAuditTurns(1,500)).find(t=>t.turnId===completeId);
   assert.equal(delivered.firstUsefulContentMs,123);
   for(const event of ['autonomy_decision','autonomy_decision','observation_cycle_stopped']) {
    await pool.query(`INSERT INTO agent_traces(session_id,turn_id,phase,event_type,payload)
      VALUES($1,$2,'tools',$3,$4::jsonb)`,[sessionId,completeId,event,JSON.stringify({round:2,selectedAction:'continue',
        stopReason:'continuation_round_limit',rationale:'private fixture reasoning'})]);
   }
   const traced=(await conversations.listQualityAuditTurns(1,500)).filter(t=>t.sessionId===sessionId);
   assert.equal(traced.find(t=>t.turnId===completeId).autonomyObservations.length,3);
   assert.ok(!JSON.stringify(traced).includes('private fixture reasoning'));
   const autonomy=buildDialogueQualityAudit(traced,{hours:1,limit:500}).operations.autonomy;
   assert.equal(autonomy.observedTurnCount,1);
   assert.equal(autonomy.decisionRoundCount,1);
   assert.equal(autonomy.stoppedTurnCount,1);
   assert.equal(autonomy.roundLimitTurnCount,1);
  } finally {await pool.query('DELETE FROM conversation_sessions WHERE id=$1',[sessionId]);}
 });
 await run('TECHNICAL_FACT_PUBLISHED_WITH_ORIGINAL_VERIFICATION_TIME',async()=>{
  p=await repo.upsertProduct(input,Array(1536).fill(0.01));
  fact.productId=p.id;
  for(const tool of ['catalog.search','catalog.getProductDetails'])validateToolResultOutput({
    requestId:'real-db-shape',tool,status:'ok',warnings:[],payload:{productIds:[p.id],products:[p]}
  });
  const saved=await repo.upsertVerifiedProductFact(fact);
  assert.equal(Date.parse(saved.lastVerifiedAt),Date.parse(fact.observedAt));
  assert.equal(Date.parse(saved.validUntil),Date.parse(fact.observedAt)+90*86400000);
 });
 await run('PRICE_ONLY_PRESERVES_MEMORY_AND_EMBEDDING',async()=>{
  const before=await pool.query('SELECT * FROM products WHERE id=$1',[p.id]);
  p=await repo.upsertProduct({...input,price:165,raw:{...input.raw,price:165},imageUrl:'https://fixtures.bakaut.invalid/new.jpg'});
  const after=await pool.query('SELECT * FROM products WHERE id=$1',[p.id]);
  const reloaded=await repo.getProductsByIds([p.id]);
  assert.equal(reloaded.length,1);
  validateToolResultOutput({requestId:'real-db-readback',tool:'catalog.getProductDetails',status:'ok',warnings:[],
    payload:{products:reloaded,productIds:[p.id]}});
  assert.equal(after.rows[0].technical_version,before.rows[0].technical_version);
  assert.notEqual(after.rows[0].commercial_version,before.rows[0].commercial_version);
  assert.notEqual(after.rows[0].source_content_hash,before.rows[0].source_content_hash);
  assert.ok(after.rows[0].embedding);
  const facts=await repo.searchVerifiedProductFacts({productIds:[p.id],sourceTypes:['manual']});
  assert.equal(facts.length,1);assert.equal(Date.parse(facts[0].lastVerifiedAt),Date.parse(fact.observedAt));
  await repo.markVerifiedProductFactsUsed([facts[0].id]);
  const reused=await repo.searchVerifiedProductFacts({productIds:[p.id],sourceTypes:['manual']});
  assert.equal(reused[0].lastVerifiedAt,facts[0].lastVerifiedAt);
 });
 await run('VERIFIED_SITE_PRICE_PERSISTS_WITHOUT_ERASING_TECHNICAL_MEMORY',async()=>{
  const before=(await pool.query('SELECT * FROM products WHERE id=$1',[p.id])).rows[0];
  const checked={productId:p.id,productName:p.name,sourceUrl:input.sourceUrl,price:165000,currency:'RUB',observedAt:new Date().toISOString()};
  const updated=await repo.updateVerifiedSitePrice(checked);
  assert.equal(updated.price,165000);
  assert.equal((await repo.getProductsByIds([p.id]))[0].price,165000);
  const after=(await pool.query('SELECT * FROM products WHERE id=$1',[p.id])).rows[0];
  assert.equal(after.technical_version,before.technical_version);
  assert.equal(after.embedding,before.embedding);
  assert.ok((await repo.searchVerifiedProductFacts({productIds:[p.id],sourceTypes:['manual']})).some(f=>f.attribute==='Масса'));
  assert.equal(await repo.updateVerifiedSitePrice({...checked,price:160000,observedAt:fact.observedAt}),null);
  assert.equal(await repo.updateVerifiedSitePrice({...checked,productName:p.name+'-E'}),null);
  assert.equal(await repo.updateVerifiedSitePrice({...checked,sourceUrl:'https://untrusted.invalid/product'}),null);
  assert.equal((await repo.getProductsByIds([p.id]))[0].price,165000);
 });
 await run('REQUESTED_SLOT_SURVIVES_40_NEWER_UNRELATED_FACTS',async()=>{
  for(let i=0;i<40;i++)await repo.upsertVerifiedProductFact({...fact,attribute:`Unrelated ${i}`,value:String(i),observedAt:new Date().toISOString()});
  const facts=await repo.searchVerifiedProductFacts({productIds:[p.id],sourceTypes:['manual'],attributes:['weight'],limit:32});
  assert.ok(facts.some(f=>f.attribute==='Масса'));
 });
 await run('DURABLE_JOB_DEDUPLICATION_AND_ORIGINAL_EVIDENCE_TIME',async()=>{
  const queued={...fact,attribute:'Частота',value:'50 Гц',expectedTechnicalVersion:p.technicalVersion};
  assert.equal(await repo.enqueueVerifiedProductFacts(key,[queued]),1);
  assert.equal(await repo.enqueueVerifiedProductFacts(key,[queued]),0);
  assert.equal((await processKnowledgeEnrichment(repo)).saved,1);
  const facts=await repo.searchVerifiedProductFacts({productIds:[p.id],sourceTypes:['manual'],attributes:['frequency']});
  assert.equal(Date.parse(facts.find(f=>f.attribute==='Частота').lastVerifiedAt),Date.parse(fact.observedAt));
 });
 await run('WORKER_RESTART_FENCES_OLD_LEASE',async()=>{
  await repo.enqueueVerifiedProductFacts(key+'-restart',[{...fact,attribute:'Напряжение',value:'220 В'}]);
  const first=await repo.claimVerifiedFactEnrichmentJob();assert.ok(first);
  await pool.query("UPDATE verified_fact_enrichment_jobs SET available_at=now()-interval '1 minute' WHERE id=$1",[first.id]);
  const second=await repo.claimVerifiedFactEnrichmentJob();assert.equal(second.id,first.id);assert.notEqual(second.leaseToken,first.leaseToken);
  await repo.finishVerifiedFactEnrichmentJob(first);
  assert.equal((await pool.query('SELECT status FROM verified_fact_enrichment_jobs WHERE id=$1',[first.id])).rows[0].status,'processing');
  await repo.finishVerifiedFactEnrichmentJob(second);
 });
 await run('LATE_OLD_EVIDENCE_CANNOT_REPLACE_NEWER_SOURCE_REVISION',async()=>{
  const previous=(await repo.searchVerifiedProductFacts({productIds:[p.id],sourceTypes:['manual'],attributes:['frequency']})).find(f=>f.attribute==='Частота');
  const newest={...fact,attribute:'Частота',value:'60 Гц',observedAt:new Date().toISOString()};
  const replacement=await repo.upsertVerifiedProductFact(newest);
  assert.ok(replacement);
  assert.ok(replacement.supersedesFactIds.includes(previous.id));
  assert.equal((await pool.query('SELECT status FROM verified_product_facts WHERE id=$1',[previous.id])).rows[0].status,'superseded');
  assert.equal(await repo.upsertVerifiedProductFact({...fact,attribute:'Частота',value:'50 Гц'}),null);
  const rows=await repo.searchVerifiedProductFacts({productIds:[p.id],sourceTypes:['manual'],attributes:['frequency']});
  assert.deepEqual(rows.filter(f=>f.attribute==='Частота').map(f=>f.value),['60 Гц']);
 });
 await run('SLOT_LIMIT_NEVER_HIDES_CONTRADICTORY_SOURCE',async()=>{
  const conflicting=await repo.upsertVerifiedProductFact({...fact,attribute:'Частота',value:'50 Гц',sourceUrl:fact.sourceUrl+'-independent',observedAt:fact.observedAt});
  assert.ok(conflicting);
  const rows=await repo.searchVerifiedProductFacts({productIds:[p.id],sourceTypes:['manual'],attributes:['frequency'],limit:1});
  assert.deepEqual(rows.filter(f=>f.attribute==='Частота').map(f=>f.value).sort(),['50 Гц','60 Гц']);
 });
 await run('REPEATED_WORKER_CRASH_HAS_BOUNDED_RETRIES',async()=>{
  await repo.enqueueVerifiedProductFacts(key+'-crash',[{...fact,attribute:'Напряжение',value:'220 В'}]);
  await pool.query("UPDATE verified_fact_enrichment_jobs SET status='processing',attempts=6,available_at=now()-interval '1 minute' WHERE dedupe_key=$1",[key+'-crash']);
  assert.equal(await repo.claimVerifiedFactEnrichmentJob(),null);
  assert.equal((await pool.query('SELECT status FROM verified_fact_enrichment_jobs WHERE dedupe_key=$1',[key+'-crash'])).rows[0].status,'failed');
 });
 await run('CHANGED_MODIFICATION_INVALIDATES_FACTS_AND_PENDING_JOB',async()=>{
  await repo.enqueueVerifiedProductFacts(key+'-stale',[{...fact,attribute:'Напряжение',value:'220 В'}]);
  p=await repo.upsertProduct({...input,name:input.name+'-E'});
  assert.equal((await repo.searchVerifiedProductFacts({productIds:[p.id],sourceTypes:['manual']})).length,0);
  assert.equal((await processKnowledgeEnrichment(repo)).saved,0);
  assert.equal((await pool.query('SELECT embedding FROM products WHERE id=$1',[p.id])).rows[0].embedding,null);
 });
 console.log(JSON.stringify({mode:'real-postgresql-no-model',checks,pass:true,modelCalls:0},null,2));
} catch(error) {
 console.log(JSON.stringify({mode:'real-postgresql-no-model',checks,pass:false,error:String(error)},null,2));
 process.exitCode=1;
} finally {await pool.end();}
