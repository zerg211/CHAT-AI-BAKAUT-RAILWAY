#!/usr/bin/env node
'use strict';
const fs=require('node:fs'),path=require('node:path');
const {hash,evaluate,releaseVerdict}=require('./engine.cjs');
const {sourceHash,currentCommit}=require('./fingerprint.cjs');
const {HttpClient,HarnessError,collectCase}=require('./http.cjs');
const {backendAudit}=require('./backend.cjs');
const {Judge}=require('./judge.cjs');const {calibrate}=require('./calibration.cjs');
const {scenarios}=require('./scenarios.cjs');const {materializeScenario}=require('./world.cjs');
function parseArgs(argv){const o={};const flags=new Set(['list','run','approve-paid','release']);const valued=new Set(['ids','max-agent-turns','max-judge-calls','max-http-requests','target','output','report','repeat']);for(let i=0;i<argv.length;i++){const a=argv[i];if(!a.startsWith('--'))throw new HarnessError('BAD_ARGUMENT',a);const k=a.slice(2);if(flags.has(k)){o[k]=true;continue;}if(!valued.has(k)||!argv[i+1]||argv[i+1].startsWith('--'))throw new HarnessError('BAD_ARGUMENT',a);o[k]=argv[++i];}return o;}
function positive(value,name){const n=Number(value);if(!Number.isSafeInteger(n)||n<1)throw new HarnessError('INVALID_BUDGET',name);return n;}
function suiteHash(){return hash(['engine.cjs','http.cjs','judge.cjs','calibration.cjs','scenarios.cjs','world.cjs','app.ts','backend.cjs','runner.cjs','fingerprint.cjs'].map(f=>[f,fs.readFileSync(path.join(__dirname,f),'utf8')]));}
function save(file,data){fs.mkdirSync(path.dirname(file),{recursive:true});const tmp=file+'.tmp';fs.writeFileSync(tmp,JSON.stringify(data,null,2)+'\n',{mode:0o600});fs.renameSync(tmp,file);}
function plan(o){const ids=o.ids?o.ids.split(','):scenarios.map(s=>s.id);if(new Set(ids).size!==ids.length||ids.some(id=>!scenarios.some(s=>s.id===id)))throw new HarnessError('UNKNOWN_OR_DUPLICATE_SCENARIO');const selected=ids.map(id=>scenarios.find(s=>s.id===id));const repeat=o.repeat?positive(o.repeat,'repeat'):1;return {selected,repeat,agentTurns:selected.reduce((n,s)=>n+s.steps.length+(s.transport==='replay-same-id'?1:0),0)*repeat,judgeCalls:1+selected.length*repeat};}
async function runLive(o){
 const p=plan(o);
 if(!o['approve-paid'])throw new HarnessError('PAID_NOT_APPROVED','No model calls: add --approve-paid and explicit budgets to run.');
 const maxAgent=positive(o['max-agent-turns'],'max-agent-turns'),maxJudge=positive(o['max-judge-calls'],'max-judge-calls'),maxHttp=positive(o['max-http-requests'],'max-http-requests');
 if(p.agentTurns>maxAgent||p.judgeCalls>maxJudge)throw new HarnessError('PLAN_EXCEEDS_BUDGET',`Plan: ${p.agentTurns} agent HTTP turns (including deliberate replay), at most ${p.judgeCalls} judge calls. No paid calls started.`);
 const target=JSON.parse(fs.readFileSync(o.target||'.private/acceptance-target.json','utf8'));
 const u=new URL(target.baseUrl);
 if(!['localhost','127.0.0.1','[::1]'].includes(u.hostname))throw new HarnessError('NON_TEST_TARGET','This runner never contacts production. Use the isolated app.ts host.');
 const client=new HttpClient({baseUrl:target.baseUrl,adminToken:target.adminToken,maxRequests:maxHttp});
 const snap=await client.control({action:'snapshot'});
 if(snap.nodeEnv!=='test'||snap.emailWorker!==false)throw new HarnessError('UNSAFE_TEST_HOST');
 if(snap.codeHash!==sourceHash()||snap.commit!==currentCommit()||target.commit!==snap.commit)throw new HarnessError('STALE_TEST_HOST');
 const judge=new Judge({apiKey:process.env.BAKAUT_EVAL_JUDGE_API_KEY,model:process.env.BAKAUT_EVAL_JUDGE_MODEL,maxCalls:maxJudge});
 const report={schemaVersion:2,mode:'real-agent',scope:'isolated real app + real OpenAI + fixed synthetic catalogue; not live-site production certification',suiteHash:suiteHash(),codeHash:snap.codeHash,commit:snap.commit,worldHash:hash(snap.world),startedAt:new Date().toISOString(),calibration:null,reports:[],budgets:{maxAgentTurns:maxAgent,maxJudgeCalls:maxJudge,maxHttpRequests:maxHttp},agentTurnsRequested:0};
 const file=o.output||path.join('.private','acceptance',`run-${Date.now()}.json`);
 try {
  report.backend=await backendAudit(client);save(file,report);if(!report.backend.pass)throw new HarnessError('BACKEND_CONTRACTS_FAILED','Backend tests failed without model calls; fix the reported app defect before expensive evals.');
  report.calibration=await calibrate(judge);save(file,report);
  if(!report.calibration.pass)throw new HarnessError('JUDGE_CALIBRATION_FAILED','Judge confused known-good/known-bad examples; agent run stopped before further spending.');
  for(const base of p.selected){const attempts=[];
   for(let repetition=0;repetition<p.repeat;repetition++){
    const setup=await client.control({action:'reset',seedMemory:['seed-memory','equivalent-memory'].includes(base.setup),equivalentMemory:base.setup==='equivalent-memory'});
    if(setup.codeHash!==report.codeHash||setup.commit!==report.commit||hash(setup.world)!==report.worldHash)throw new HarnessError('FIXTURE_OR_CODE_CHANGED');
    const scenario=materializeScenario(base,setup.world);
    const requestCount=scenario.steps.length+(base.transport==='replay-same-id'?1:0);
    if(report.agentTurnsRequested+requestCount>maxAgent)throw new HarnessError('AGENT_TURN_BUDGET');
    report.agentTurnsRequested+=requestCount;
    const transcript=await collectCase(client,scenario,setup.world,{maxAgentTurns:maxAgent,replay:base.transport==='replay-same-id'});
    const current=await client.control({action:'snapshot'});if(current.codeHash!==report.codeHash||current.commit!==report.commit)transcript.harnessError={code:'SOURCE_CHANGED_DURING_TEST'};
    let semantic=null;
    let evaluated=evaluate(transcript,scenario,setup.world);
    // Known deterministic failures short-circuit expensive semantic grading.
    const deterministic=evaluated.issues.filter(i=>i.code!=='JUDGE_MISSING_OR_STALE');
    if(deterministic.every(i=>i.code==='LATENCY_USEFUL'||i.code==='LATENCY_FINAL')){try{semantic=await judge.grade(transcript,scenario,setup.world);}catch(e){transcript.harnessError={code:e.code??'JUDGE_ERROR',message:e.message};}evaluated=evaluate(transcript,scenario,setup.world,semantic);}
    const entry={repetition:repetition+1,scenarioId:scenario.id,mode:'real-agent',commit:transcript.commit,codeHash:report.codeHash,worldHash:report.worldHash,suiteHash:report.suiteHash,finishedAt:new Date().toISOString(),result:evaluated,transcript,semantic};
    attempts.push(entry);save(file,{...report,inProgress:{scenarioId:base.id,attempts}});
    console.log(`${base.id} attempt ${repetition+1}: ${evaluated.status} (${evaluated.issues.map(x=>x.code).join(', ')||'all checks passed'})`);
   }
   const last=attempts[attempts.length-1];report.reports.push({...last,attempts});save(file,report);
  }
 }catch(e){report.harnessError={code:e.code??'RUN_ERROR',message:e.message};}
 finally{
  report.finishedAt=new Date().toISOString();report.judgeCalls=judge.calls;report.judgeUsage=judge.usage;report.httpRequests=client.requests;
  report.release=decideRelease(report);save(file,report);console.log(`Report: ${file}\nRelease: ${report.release.status}`);
 }
 return report;
}
function decideRelease(r){const v=releaseVerdict({requiredIds:scenarios.filter(s=>s.required).map(s=>s.id),reports:r.reports??[],commit:r.commit,worldHash:r.worldHash,suiteHash:suiteHash()});if(r.harnessError||r.backend?.pass!==true||r.calibration?.pass!==true||r.suiteHash!==suiteHash())return {...v,status:'NOT_PROVEN',reason:'Missing/failed calibration, changed suite, or harness error'};if(r.reports.some(x=>x.codeHash!==r.codeHash))return {...v,status:'NOT_PROVEN',reason:'Mixed code fingerprints'};return v;}
async function main(argv=process.argv.slice(2)){const o=parseArgs(argv);if(o.release){if(!o.report)throw new HarnessError('REPORT_REQUIRED');const r=JSON.parse(fs.readFileSync(o.report));const v=decideRelease(r);if(sourceHash()!==r.codeHash||currentCommit()!==r.commit)v.status='NOT_PROVEN';console.log(JSON.stringify(v,null,2));return v.status==='READY_FOR_THIS_SUITE'?0:1;}
 if(o.run){const r=await runLive(o);return r.release.status==='READY_FOR_THIS_SUITE'?0:1;}
 const p=plan(o);console.log(JSON.stringify({scenarios:p.selected.map(s=>({id:s.id,family:s.family,turns:s.steps.length})),agentTurns:p.agentTurns,maxJudgeCalls:p.judgeCalls,paidCallsMade:0,usage:'--run --approve-paid --max-agent-turns N --max-judge-calls N --max-http-requests N [--ids A01,A02] [--repeat 3]'},null,2));return 0;
}
if(require.main===module)main().then(code=>{process.exitCode=code;}).catch(e=>{console.error(`${e.code??'HARNESS_ERROR'}: ${e.message}`);process.exitCode=2;});
module.exports={parseArgs,plan,suiteHash,sourceHash,runLive,decideRelease,main};
