'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');
const {assessHumanCalibration,ordinalAlpha}=require('../../evals/acceptance/human-calibration.cjs');
const sample=()=>Array.from({length:100},(_,i)=>({caseId:`case-${i}`,sessionHash:`session-${i}`,split:'holdout',
  source:'production',labelOrigin:'human_review',auditReference:`audit-${i}`,reviewer:'fixture-only',reviewedAt:'2026-09-08',
  judgeModel:'fixture-model',judgePromptHash:'fixture-prompt',humanCritical:i%2===0,judgeCritical:i%2===0,
  humanNaturalnessRatings:[i%5+1,i%5+1]}));
test('calibration computes known perfect agreement on controlled calculator fixtures',()=>{
  const result=assessHumanCalibration(sample());assert.equal(result.critical.cohenKappa,1);assert.equal(result.naturalness.krippendorffOrdinalAlpha,1);
  // This is a calculator fixture, not evidence of production human calibration.
  assert.equal(result.status,'PASS');
});
test('synthetic calibration cannot replace human production labels',()=>{
  const result=assessHumanCalibration(sample().map(row=>({...row,source:'synthetic'})));
  assert.equal(result.status,'NOT_PROVEN');assert.equal(result.sampleCount,0);assert.equal(result.critical.recall,null);
});
test('session leakage and duplicate cases cannot inflate a holdout',()=>{
  const data=sample();data.push({...data[0],caseId:'different-case',split:'development'});assert.equal(assessHumanCalibration(data).status,'NOT_PROVEN');
  const duplicated=sample();duplicated.push({...duplicated[0]});assert.equal(assessHumanCalibration(duplicated).status,'NOT_PROVEN');
});
test('critical false negatives and constant labels cannot pass through average quality',()=>{
  assert.equal(assessHumanCalibration(sample().map(row=>({...row,judgeCritical:false}))).status,'NOT_PROVEN');
  const result=assessHumanCalibration(sample().map(row=>({...row,humanCritical:false,judgeCritical:false})));
  assert.equal(result.status,'NOT_PROVEN');assert.equal(result.critical.recall,null);
  assert.equal(ordinalAlpha([[1,5],[5,1],[1,5]])<0,true);
});
