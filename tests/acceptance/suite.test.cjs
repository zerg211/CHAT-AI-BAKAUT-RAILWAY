'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {scenarios}=require('../../evals/acceptance/scenarios.cjs');const {makeWorld,materializeScenario}=require('../../evals/acceptance/world.cjs');
const {validateScenario,productViolations,releaseVerdict}=require('../../evals/acceptance/engine.cjs');
const {parseArgs,plan,runLive}=require('../../evals/acceptance/runner.cjs');
const w=makeWorld();
for(const s of scenarios)test(`executable scenario preconditions ${s.id} (${s.family})`,()=>{const c=materializeScenario(s,w);validateScenario(c);for(const st of c.steps){const e=st.expect;assert.equal(st.user.includes('{{'),false);if(e.minCards){const eligible=w.products.filter(p=>productViolations(p,e.constraints).length===0 && (!e.exactKeys||e.exactKeys.includes(p.key)));assert.ok(eligible.length>=e.minCards,`${c.id}: fixture cannot satisfy expected card count`);}if(e.noSuitable)assert.equal(w.products.filter(p=>!productViolations(p,e.constraints).length).length,0);}});
test('unknown constraints fail loudly instead of being ignored',()=>assert.throws(()=>validateScenario({id:'bad',steps:[{user:'test',expect:{constraints:{newUnimplemented:1}}}]})));
test('all criterion IDs are globally unique',()=>{const ids=scenarios.flatMap(s=>s.steps.flatMap(st=>st.criteria.map(c=>c.id)));assert.equal(new Set(ids).size,ids.length);});
test('paid execution requires explicit approval before calls',async()=>await assert.rejects(()=>runLive({ids:'A01'}),{code:'PAID_NOT_APPROVED'}));
test('budget must cover the selected plan before calls',async()=>await assert.rejects(()=>runLive({ids:'A34','approve-paid':true,'max-agent-turns':'1','max-judge-calls':'1','max-http-requests':'1'}),{code:'PLAN_EXCEEDS_BUDGET'}));
test('unknown CLI switch cannot silently weaken tests',()=>assert.throws(()=>parseArgs(['--ignore-failures']),{code:'BAD_ARGUMENT'}));
test('unknown or duplicate test IDs rejected',()=>{assert.throws(()=>plan({ids:'A01,A01'}));assert.throws(()=>plan({ids:'not-a-case'}));});
const baseReport={scenarioId:'A01',mode:'real-agent',commit:'c',worldHash:'w',suiteHash:'s',finishedAt:new Date().toISOString(),result:{status:'PASS',pass:true},attempts:[{result:{status:'PASS'}}]};
function release(reports){return releaseVerdict({requiredIds:['A01'],reports,commit:'c',worldHash:'w',suiteHash:'s'});}
test('only genuine completed matching evidence can authorize this suite',()=>assert.equal(release([baseReport]).status,'READY_FOR_THIS_SUITE'));
for(const [name,change]of [['mock',{mode:'offline'}],['different commit',{commit:'other'}],['changed data',{worldHash:'other'}],['changed tests',{suiteHash:'other'}],['failed',{result:{status:'FAIL',pass:false}}],['unknown',{result:{status:'INCONCLUSIVE',pass:false}}],['not run',{result:{status:'NOT_RUN',pass:false}}],['stale',{finishedAt:'2000-01-01T00:00:00Z'}],['earlier failed attempt',{attempts:[{result:{status:'FAIL'}},{result:{status:'PASS'}}]}]])test(`${name} cannot authorize release`,()=>assert.notEqual(release([{...baseReport,...change}]).status,'READY_FOR_THIS_SUITE'));
test('absent evidence is not green',()=>assert.equal(release([]).status,'NOT_PROVEN'));
