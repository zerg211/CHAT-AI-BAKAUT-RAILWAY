'use strict';
const {makeWorld}=require('../../evals/acceptance/world.cjs');
const {hash}=require('../../evals/acceptance/engine.cjs');
const copy=x=>structuredClone(x);
function fixture({expect={},answer='Масса — 85 кг.',keys=[],criteria=[],users}={}){
 const world=makeWorld();
 const step={user:'Какая масса у тестовой P85?',expect:{audit:true,...expect},criteria};
 const scenario={id:'UNIT_ORACLE',steps:users?users.map(u=>({...copy(step),user:u})): [step]};
 const run={scenarioId:scenario.id,sessionId:'session-1',worldHash:hash(world),turns:scenario.steps.map((st,i)=>({
  ok:true,user:st.user,turnId:`turn-${i}`,assistantMessageId:`assistant-${i}`,answer,elapsedMs:500,firstUsefulMs:490,leadRequested:false,
  productCards:keys.map(key=>{const p=world.products.find(p=>p.key===key);return {id:p.id,name:p.name,price:p.price,currency:'RUB',specs:copy(p.specs),reasons:[],caveats:[]};}),
  audit:{turnId:`turn-${i}`,assistantMessageId:`assistant-${i}`,leads:[]},
  metadata:{turnId:`turn-${i}`,toolResults:[{requestId:`catalog-${i}`,tool:'catalog.search',status:'ok',payload:{products:copy(world.products)}}],ledgerState:{factsByKey:{}}}
 }))};
 return {run,scenario,world};
}
function semanticFor(f,verdict='pass'){return {inputHash:hash({scenario:f.scenario,world:f.world,turns:f.run.turns}),checks:f.scenario.steps.flatMap(st=>st.criteria.map(c=>({id:c.id,verdict,reason:'Test-only semantic double; not an actual model evaluation.',quotes:[],sourceIds:[]})))};}
module.exports={fixture,semanticFor,copy};
