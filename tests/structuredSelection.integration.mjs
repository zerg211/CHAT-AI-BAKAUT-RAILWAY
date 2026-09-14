import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
const target=new URL(process.env.DATABASE_URL||'file:///missing');
assert.ok(['127.0.0.1','localhost','[::1]'].includes(target.hostname)&&target.pathname.startsWith('/bakaut_acceptance_'));
process.env.NODE_ENV='test';
const {pool}=await import('../src/db/pool.ts');
const {ProductRepository}=await import('../src/db/repositories.ts');
const {AgentManagerOrchestrator}=await import('../src/ai/agentManagerOrchestrator.ts');
const {AgentIntentContractSchema}=await import('../src/ai/agentManagerContracts.ts');
const {generatorMeetsRequiredLoad}=await import('../src/ai/agentManagerCardSelection.ts');
const repo=new ProductRepository(),ids=[],key=randomUUID();
const make=async(name,specs)=>{const p=await repo.upsertProduct({name,sourceUrl:`https://bakautprof.ru/catalog/${key}/${ids.length}`,category:'Генераторы',specs,raw:{pageType:'product'}});ids.push(p.id);return p;};
const manager=new AgentManagerOrchestrator({},repo,{}, {},async()=>{throw Error('Fixture has no embeddings; no model permitted');});
const requirement=(kind,value,unit,relation)=>({id:kind,kind,value,unit,relation,role:'hard_constraint',strictness:'strict',evidence:'controlled buyer requirement',verification:{mode:'product_attribute'}});
try{
 const yes=await make('Генератор V4Fit automatic',{'Номинальная мощность':'6 кВт',Autostart:'yes'});
 const no=await make('Генератор V4Fit manual',{'Номинальная мощность':'6 кВт',Autostart:'no'});
 for(let i=0;i<205;i++)await make(`Генератор V4Fit distractor ${i}`,{'Номинальная мощность':'2 кВт',Autostart:'yes'});
 const initial=await repo.searchProducts('генератор',200);
 assert.ok(!initial.some(p=>p.id===yes.id||p.id===no.id),'positive candidates deliberately outside initial retrieval');
 const variants=[['must-have',true,'must_have',[yes.id]],['must-not-have',false,'must_not_have',[no.id]],['not-required',false,'not_required',[yes.id,no.id]]];
 for(const [id,value,relation,expected] of variants){
  const intent=AgentIntentContractSchema.parse({userMessageSummary:id,dialogueUnderstanding:'controlled semantic policy',nextStepRationale:'verify catalog mechanics',requiresTools:true,
   toolRequests:[{id:'catalog-search',tool:'catalog.search',args:{productIntent:'generator',query:'генератор'},rationale:'fixture',required:true}],
   selectionPolicy:{targetProductClass:'generator',canonicalProductClass:'generator',needAction:'continue',alternativePolicy:'same_class_only',reusePreviousCards:false,maxCards:4,powerSource:'any',phase:'any',
    requirements:[requirement('nominal_power_min_kw',5,'kW','must_have'),requirement('autostart_required',value,null,relation)],rationale:'supplied policy, not model inference'},mustNotAskQuestionIds:[],riskFlags:[]});
  const result=await manager.searchCatalogProducts({query:'генератор',limit:4,productIntent:'generator',intent});
  assert.deepEqual(result.products.map(p=>p.id).sort(),expected.sort(),id);
  assert.ok(result.primaryExpansion,'bounded expansion reached the older qualifying candidate');
 }
 const peak=await make('Генератор V4Fit peak',{'Номинальная мощность':'4 кВт','Максимальная мощность':'7 кВт'});
 const unknown=await make('Генератор V4Fit unknown nominal',{'Максимальная мощность':'7 кВт'});
 assert.equal(generatorMeetsRequiredLoad(await repo.getProductBySourceUrl(peak.sourceUrl),5),false);
 assert.equal(generatorMeetsRequiredLoad(await repo.getProductBySourceUrl(unknown.sourceUrl),5),undefined);
 assert.equal(generatorMeetsRequiredLoad(await repo.getProductBySourceUrl(yes.sourceUrl),5),true);
 const browse=await manager.searchCatalogProducts({query:'генератор',limit:4,productIntent:'generator'});
 assert.ok(browse.products.length>0);
 assert.ok(browse.products.every(product=>product.category==='Генераторы'));
 const unknownClass=await manager.searchCatalogProducts({query:`неизвестный-класс-${key}`,limit:4,productIntent:`неизвестный-класс-${key}`});
 assert.equal(unknownClass.products.length,0,'an unknown product class is not silently replaced with generators');
 const impossibleIntent=AgentIntentContractSchema.parse({userMessageSummary:'100 kW required',dialogueUnderstanding:'no fixture product can match',nextStepRationale:'retain an auditable no-fit result',requiresTools:true,
  toolRequests:[{id:'catalog-no-fit',tool:'catalog.search',args:{productIntent:'generator',query:'генератор'},rationale:'fixture',required:true}],
  selectionPolicy:{targetProductClass:'generator',canonicalProductClass:'generator',needAction:'continue',alternativePolicy:'same_class_only',reusePreviousCards:false,maxCards:4,powerSource:'any',phase:'any',
   requirements:[requirement('nominal_power_min_kw',100,'kW','must_have')],rationale:'controlled no-fit policy'},mustNotAskQuestionIds:[],riskFlags:[]});
 const noFit=await manager.searchCatalogProducts({query:'генератор',limit:4,productIntent:'generator',intent:impossibleIntent});
 assert.deepEqual(noFit.products.map(product=>product.id),[unknown.id],'missing nominal evidence stays preliminary instead of becoming a false conflict');
 assert.ok(noFit.candidateTiers.some(candidate=>candidate.productId===unknown.id&&candidate.tier==='preliminary_match'));
 assert.ok(noFit.candidateTiers.some(candidate=>candidate.tier==='rejected'&&candidate.tradeoffs?.some(value=>value.startsWith('nominal_power_kw:'))));
 console.log(JSON.stringify({status:'PASS',level:'I',checks:['Z02/known-browse-and-unknown-class','Z03/must-have','Z03/must-not-have','Z03/not-required','Z03/beyond-top-k','Z05/nominal-vs-peak','Z07/no-fit-tradeoff'],initialTopK:200,distractors:205,modelCalls:0,scope:'actual PG catalog -> production structured search/expansion/filter and active nominal proof; controlled semantic policy'}));
}finally{await pool.query('DELETE FROM products WHERE id=ANY($1::uuid[])',[ids]);await pool.end();}
