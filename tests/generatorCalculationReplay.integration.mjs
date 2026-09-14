import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
const target=new URL(process.env.DATABASE_URL||'file:///missing');
assert.ok(['127.0.0.1','localhost','[::1]'].includes(target.hostname)&&target.pathname.startsWith('/bakaut_acceptance_'));
process.env.NODE_ENV='test';
const {pool}=await import('../src/db/pool.ts');
const {ConversationRepository}=await import('../src/db/repositories.ts');
const {buildGeneratorLoadToolPayload}=await import('../src/ai/agentManagerGeneratorLoad.ts');
const {validateToolRequest,validateToolResultOutput}=await import('../src/ai/agentManagerToolRegistry.ts');
const {compactToolResultsForModel}=await import('../src/ai/agentManagerModelContext.ts');
const repo=new ConversationRepository();
const session=await repo.createSession({visitorId:randomUUID()});
const load=(kind,extra)=>({kind,count:1,source:'explicit_user',runningSource:'explicit_user',startingSource:'explicit_user',operationMode:'continuous',evidence:'isolated independently specified load',...extra});
const cases=[
 {id:'kw-kva-known-pf',loads:[load('pump',{runningApparentPower:{kva:2.5,powerFactor:0.8,evidence:'2.5 kVA PF0.8'},startingApparentPower:{kva:5,powerFactor:0.6,evidence:'5 kVA PF0.6'}})],check:p=>{assert.equal(p.profile.totalRunningKw,2);assert.equal(p.profile.requiredNominalKw,3);assert.ok(p.profile.calculation.includes('2.5 kVA × 0.8 = 2 kW'));}},
 {id:'kw-kva-unknown-pf',loads:[load('pump',{runningApparentPower:{kva:2.5,powerFactor:null,evidence:'PF unknown'},startingSource:'not_provided'}),load('lighting',{runningKw:0.5,startingKw:0.5})],check:p=>{assert.equal(p.loads.length,2);assert.equal(p.profile.requiredNominalKw,undefined);assert.ok(p.warnings.includes('generator_load_power_factor_unconfirmed'));}},
 {id:'running-starting',loads:[load('pump',{runningKw:1,startingKw:3}),load('lighting',{runningKw:0.5,startingKw:0.5})],check:p=>{assert.equal(p.profile.totalRunningKw,1.5);assert.equal(p.profile.requiredNominalKw,3.5);}},
 {id:'simultaneous-separate',loads:[load('pump',{runningKw:1,startingKw:3}),load('compressor',{runningKw:2,startingKw:4})],check:p=>{assert.equal(p.profile.requiredNominalKw,7);}}
];
try{
 for(const test of cases){
  const request=validateToolRequest({id:test.id,tool:'calculator.generatorLoad',args:{loads:test.loads,simultaneousRunning:true,simultaneousStarting:test.id==='simultaneous-separate',simultaneousStartingKinds:[],estimateBasis:'exact_or_user_provided'},rationale:'controlled calculation input, no model inference',required:true});
  const p=buildGeneratorLoadToolPayload({request,userMessage:'Use these supplied load facts.'});test.check(p);
  if(test.id==='simultaneous-separate'){
   const separate=buildGeneratorLoadToolPayload({request:{...request,args:{...request.args,simultaneousStarting:false}},userMessage:'Starts are separate.'});assert.equal(separate.profile.requiredNominalKw,5);
  }
  const result=validateToolResultOutput({requestId:test.id,tool:request.tool,status:'ok',payload:{loads:p.loads,profile:p.profile,estimateBasis:p.estimateBasis},warnings:p.warnings});
  await repo.addMessage({sessionId:session.id,role:'assistant',content:'isolated calculation artifact',metadata:{toolResults:[result]}});
 }
 const restored=await new ConversationRepository().listMessages(session.id,100);
 assert.equal(restored.length,cases.length);
 for(let i=0;i<cases.length;i++){
  const original=restored[i].metadata.toolResults;
  const compact=compactToolResultsForModel(original,[]);
  assert.deepEqual(compact,original,'calculation source and warnings survive durable replay and model compaction');
  const r=validateToolResultOutput(compact[0]);cases[i].check({...r.payload,warnings:r.warnings});
 }
 console.log(JSON.stringify({status:'PASS',level:'I',checks:cases.map(c=>c.id),scope:'actual schema -> calculator -> output validation -> PostgreSQL message -> replay -> model context; controlled inputs, no model judgement',modelCalls:0}));
}finally{await pool.query('DELETE FROM conversation_sessions WHERE id=$1',[session.id]);await pool.end();}
