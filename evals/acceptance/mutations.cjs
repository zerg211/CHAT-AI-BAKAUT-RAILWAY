#!/usr/bin/env node
'use strict';
// Deliberately break the NEW oracle. A mutant is killed only by real assertions,
// never by an import/syntax failure. No OpenAI and no application runtime calls.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'../..');
const variants=[
 ['ALWAYS_ACCEPT',"  const issues=[];","  return {status:'PASS',pass:true,score:1,issues:[]};\n  const issues=[];"],
 ['ALWAYS_REJECT',"  const issues=[];","  return {status:'FAIL',pass:false,score:0,issues:[{code:'FORCED_REJECT',kind:'behavior'}]};\n  const issues=[];"],
 ['IGNORE_BUDGET_AND_CONSTRAINTS','if(bad.length) {','if(false) {'],
 ['IGNORE_CURRENT_CARDS',"if(own(e,'minCards') &&",'if(false &&'],
 ['IGNORE_MODIFICATION',"if(norm(card.name)!==norm(p.name))",'if(false)'],
 ['ERROR_AS_TOOL_SUCCESS',"if(r.status!=='ok') return false;","if(r.status!=='ok') return true;"],
 ['BORROW_OLD_TOOLS','const results=executed(t);','const results=turns.flatMap(executed);'],
 ['IGNORE_JUDGE_FAIL',"if(j.verdict==='fail')",'if(false)'],
 ['IGNORE_JUDGE_UNKNOWN',"if(j.verdict==='unknown')",'if(false)'],
 ['IGNORE_USEFUL_LATENCY',"if(own(e,'maxUsefulMs') &&",'if(false &&'],
 ['IGNORE_PRICE_REVISION',"if(p.price!=null && (typeof card.price",'if(false && (typeof card.price'],
 ['IGNORE_MEMORY_REQUIREMENT',"if(expected.absent ? matches.length!==0 : !matches.some",'if(false ? matches.length!==0 : false && !matches.some']
];
function execute(){const temp=fs.mkdtempSync(path.join(os.tmpdir(),'bakaut-oracle-mutants-'));const results=[];
 try{for(const [id,from,to]of variants){const target=path.join(temp,id);fs.mkdirSync(path.join(target,'evals'),{recursive:true});fs.mkdirSync(path.join(target,'tests'),{recursive:true});fs.cpSync(path.join(root,'evals/acceptance'),path.join(target,'evals/acceptance'),{recursive:true});fs.cpSync(path.join(root,'tests/acceptance'),path.join(target,'tests/acceptance'),{recursive:true});fs.mkdirSync(path.join(target,'evals/promptfoo'),{recursive:true});fs.copyFileSync(path.join(root,'evals/promptfoo/assertions.cjs'),path.join(target,'evals/promptfoo/assertions.cjs'));
 const file=path.join(target,'evals/acceptance/engine.cjs');let text=fs.readFileSync(file,'utf8');if(text.split(from).length!==2)throw new Error(`Mutation site changed: ${id}`);fs.writeFileSync(file,text.replace(from,to));
 const syntax=spawnSync(process.execPath,['--check',file],{encoding:'utf8'});if(syntax.status!==0)throw new Error(`Invalid mutation ${id}: ${syntax.stderr}`);
 const r=spawnSync(process.execPath,['--require',path.join(target,'evals/acceptance/network-guard.cjs'),'--test','--test-reporter=tap',path.join(target,'tests/acceptance/engine.test.cjs'),path.join(target,'tests/acceptance/calibration.test.cjs')],{encoding:'utf8',timeout:20000});
 const lines=String(r.stdout).split('\n'),count=prefix=>Number(lines.find(l=>l.startsWith(prefix))?.slice(prefix.length)??0);const total=count('# tests '),failed=count('# fail ');
 const killed=r.status===1&&total>=100&&failed>0&&!String(r.stderr).includes('Cannot find module');results.push({id,killed,tests:total,failed,status:r.status});console.log(`${killed?'KILLED':'SURVIVED/INVALID'} ${id}: ${failed}/${total} failed as expected`);
 }}finally{fs.rmSync(temp,{recursive:true,force:true});}
 const report={scope:'Seeded oracle mutations; not comprehensive mutation coverage and not live-agent tests',results,pass:results.every(r=>r.killed)};fs.mkdirSync(path.join(root,'.private/acceptance'),{recursive:true});fs.writeFileSync(path.join(root,'.private/acceptance/oracle-mutations.json'),JSON.stringify(report,null,2)+'\n');return report;}
if(require.main===module){try{process.exitCode=execute().pass?0:1;}catch(e){console.error(e.message);process.exitCode=2;}}
module.exports={execute};
