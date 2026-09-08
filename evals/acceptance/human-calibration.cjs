'use strict';
const fs=require('node:fs');

function ordinalAlpha(pairs) {
  if(pairs.length<2)return null;
  const counts=Array(6).fill(0);for(const pair of pairs)for(const score of pair)counts[score]++;
  const n=pairs.length*2;
  const distance=(a,b)=>{if(a===b)return 0;let sum=0;for(let k=Math.min(a,b);k<=Math.max(a,b);k++)sum+=counts[k];return (sum-(counts[a]+counts[b])/2)**2;};
  const observed=pairs.reduce((sum,[a,b])=>sum+distance(a,b),0)/pairs.length;
  let expected=0;for(let a=1;a<=5;a++)for(let b=1;b<=5;b++)expected+=counts[a]*counts[b]*distance(a,b);
  expected/=n*(n-1);return expected>0?1-observed/expected:null;
}

function assessHumanCalibration(rows,{minimumHoldout=100}={}) {
  if(!Array.isArray(rows))throw new Error('Expected an array of reviewed cases');
  const invalid=rows.some(row=>!row || typeof row.caseId!=='string' || !row.caseId ||
    typeof row.sessionHash!=='string' || !row.sessionHash || !['development','holdout'].includes(row.split) ||
    typeof row.humanCritical!=='boolean' || typeof row.judgeCritical!=='boolean');
  if(invalid)return {status:'NOT_PROVEN',reason:'invalid_review_record'};
  const sessions=new Map();let leakage=false;
  for(const row of rows){const previous=sessions.get(row.sessionHash);if(previous&&previous!==row.split)leakage=true;sessions.set(row.sessionHash,row.split);}
  const reviewed=rows.filter(row=>row.split==='holdout' && row.source==='production' && row.labelOrigin==='human_review' &&
    typeof row.auditReference==='string' && row.auditReference && typeof row.reviewer==='string' && row.reviewer &&
    Number.isFinite(Date.parse(row.reviewedAt)) && row.judgeModel && row.judgePromptHash);
  let tp=0,tn=0,fp=0,fn=0;
  for(const row of reviewed){if(row.humanCritical){if(row.judgeCritical)tp++;else fn++;}else if(row.judgeCritical)fp++;else tn++;}
  const n=reviewed.length,recall=tp+fn?tp/(tp+fn):null,precision=tp+fp?tp/(tp+fp):null;
  const agreement=n?(tp+tn)/n:null;
  const expected=n?((tp+fn)*(tp+fp)+(tn+fp)*(tn+fn))/(n*n):null;
  const kappa=agreement!==null&&expected!==null&&expected<1?(agreement-expected)/(1-expected):null;
  const ratingPairs=reviewed.flatMap(row=>Array.isArray(row.humanNaturalnessRatings)&&row.humanNaturalnessRatings.length===2&&
    row.humanNaturalnessRatings.every(score=>Number.isInteger(score)&&score>=1&&score<=5)?[row.humanNaturalnessRatings]:[]);
  const alpha=ordinalAlpha(ratingPairs);
  const duplicateCases=new Set(rows.map(row=>row.caseId)).size!==rows.length;
  const versions=new Set(reviewed.map(row=>`${row.judgeModel}|${row.judgePromptHash}`));
  const adequate=n>=minimumHoldout && new Set(reviewed.map(row=>row.sessionHash)).size>=minimumHoldout &&
    tp+fn>=20 && tn+fp>=20 && ratingPairs.length>=minimumHoldout;
  const pass=!leakage&&!duplicateCases&&versions.size===1&&adequate&&recall>=.98&&precision>=.90&&kappa>=.80&&alpha!==null&&alpha>=.70;
  return {status:pass?'PASS':'NOT_PROVEN',scope:'production human calibration; supplied audit references require source verification',
    sampleCount:n,minimumHoldout,excludedCount:rows.length-n,sessionLeakage:leakage,duplicateCases,
    judgeVersionCount:versions.size,adequateSample:adequate,critical:{tp,tn,fp,fn,recall,precision,cohenKappa:kappa},
    naturalness:{pairedHumanSampleCount:ratingPairs.length,krippendorffOrdinalAlpha:alpha}};
}
if(require.main===module){
  try{const input=process.argv[2];if(!input)throw new Error('Supply a reviewed production calibration JSON file');
    const report=assessHumanCalibration(JSON.parse(fs.readFileSync(input,'utf8')));console.log(JSON.stringify(report,null,2));process.exitCode=report.status==='PASS'?0:2;
  }catch(error){console.error(error.message);process.exitCode=2;}
}
module.exports={assessHumanCalibration,ordinalAlpha};
