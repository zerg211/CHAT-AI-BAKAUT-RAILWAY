'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {evaluate}=require('../../evals/acceptance/engine.cjs');
const {fixture,copy}=require('./helpers.cjs');
for(const key of ['G3','G5','G5R','G6','P60','P85','P110']) {
  test(`price-boundary metamorphism keeps the same model and changes only the current limit: ${key}`,()=>{
    const sample=fixture({keys:[key]});const price=sample.world.products.find(p=>p.key===key).price;
    const outcomes=[];
    for(const delta of [1,0,-1,5000,-5000]) {
      const changed=copy(sample);changed.scenario.steps[0].expect.constraints={priceMax:price+delta};
      const verdict=evaluate(changed.run,changed.scenario,changed.world);
      assert.equal(verdict.status,delta>=0?'PASS':'FAIL');
      if(delta<0)assert.ok(verdict.issues.some(issue=>issue.code==='CARD_CONSTRAINT'));
      outcomes.push(verdict.status);
    }
    assert.deepEqual(outcomes,['PASS','PASS','FAIL','PASS','FAIL']);
  });
}
test('requirement order and removing an optional limit preserve suitability',()=>{
  const base=fixture({keys:['G5'],expect:{constraints:{priceMax:90000,nominalMin:5,voltage:220}}});
  for(const constraints of [{voltage:220,priceMax:90000,nominalMin:5},{nominalMin:5,voltage:220}]) {
    const transformed=copy(base);transformed.scenario.steps[0].expect.constraints=constraints;
    assert.equal(evaluate(transformed.run,transformed.scenario,transformed.world).status,'PASS');
  }
});
test('a fresh turn cannot inherit a successful tool from an earlier turn after a provider or web failure',()=>{
  for(const status of ['error','timeout']) {
    const sample=fixture({users:['Сравните модели','Перепроверьте сейчас'],expect:{tools:[{tool:'catalog.search',outcome:'succeeded'}]}});
    sample.run.turns[1].metadata.toolResults=sample.run.turns[0].metadata.toolResults.map(result=>({...result,status}));
    sample.scenario.steps[1].expect.tools=[{tool:'catalog.search',outcome:'succeeded'}];
    const verdict=evaluate(sample.run,sample.scenario,sample.world);
    assert.equal(verdict.status,'FAIL');assert.ok(verdict.issues.some(issue=>issue.code==='TOOL_OBLIGATION'));
  }
});
