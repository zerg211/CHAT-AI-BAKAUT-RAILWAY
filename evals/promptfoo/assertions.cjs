'use strict';
// Compatibility entry points; the authoritative suite is evals/acceptance.
const E=require('../acceptance/engine.cjs');
function parse(output){try{return typeof output==='string'?JSON.parse(output):output;}catch{return null;}}
function conf(context){return context?.config??context?.assert?.config??{};}
function verdict(pass,reason,status=pass?'PASS':'FAIL'){return {pass,score:pass?1:0,reason,status};}
function incomplete(reason){return verdict(false,`INCONCLUSIVE: ${reason}`,'INCONCLUSIVE');}
function assertNoRuntimeFailure(output,context={}){
 const r=parse(output),c=conf(context);if(!r||!Array.isArray(r.turns))return incomplete('invalid transcript');
 if(r.turns.length<(c.minTurns??1))return verdict(false,'Dialogue incomplete');
 if(r.harnessError)return incomplete('collection failed');
 for(const t of r.turns)if(t.ok!==true||typeof t.answer!=='string'||!t.answer.trim())return verdict(false,'A turn did not deliver a nonempty response');
 return verdict(true,'Runtime completion only, NOT behavioral acceptance');
}
function assertToolCallCorrectness(output,context={}){
 const r=parse(output),c=conf(context),t=r?.turns?.[c.turnIndex??r.turns.length-1];
 if(!t?.metadata||!Array.isArray(t.metadata.toolResults))return incomplete('no executed tool artifacts for current turn');
 const results=E.executed(t);const level=c.outcome??'succeeded';
 const hit=name=>results.some(x=>x.tool===E.toolName(name)&&E.provesTool(x,level));
 for(const name of c.requiredToolsAll??[])if(!hit(name))return verdict(false,`Missing executed ${level} ${name}`);
 if(c.requiredToolsAny?.length&&!c.requiredToolsAny.some(hit))return verdict(false,'No required current-turn tool succeeded');
 if((c.requiredSourcesAll??[]).includes('web')&&!results.some(r=>E.provesTool(r,'fact')))return verdict(false,'No verified current-turn web evidence');
 if(c.expectedTaskTypes||c.expectedLeadPolicies||c.expectedFactPolicies)return incomplete('semantic policy labels must be checked by independent acceptance criteria, not inferred from tool names');
 return verdict(true,'Current-turn executed tool obligation only');
}
function assertRetrievalGrounding(output,context={}){
 const r=parse(output),c=conf(context),t=r?.turns?.[c.turnIndex??r.turns.length-1];
 if(!Array.isArray(t?.productCards))return incomplete('no current card array');
 if(c.expectCards&&t.productCards.length<(c.minCards??1))return verdict(false,'Current requested cards missing; earlier cards do not count');
 if(c.expectNoCards&&t.productCards.length)return verdict(false,'Unexpected current cards');
 if(c.expectWebRequired&&!E.executed(t).some(x=>E.provesTool(x,'fact')))return verdict(false,'Plan/error/URL alone is not verified web research');
 if(t.productCards.length)return assertAcceptance(output,context);
 return verdict(true,'No-card structural condition only');
}
function assertAcceptance(output,context={}){
 const run=parse(output),independent=context.independent;
 if(!independent?.scenario||!independent.world)return incomplete('independent scenario and data required; app metadata is not an oracle');
 const r=E.evaluate(run,independent.scenario,independent.world,independent.semantic??null);
 return verdict(r.pass,r.issues.map(i=>`${i.code}: ${i.message}`).join('; ')||'Independent acceptance passed',r.status);
}
// No min character count, keyword pattern or broad "not enough data" waiver.
const assertSupportAnswerQuality=assertAcceptance;
const assertBusinessRules=assertAcceptance;
const assertAgentTaskCompletion=assertAcceptance;
module.exports={assertNoRuntimeFailure,assertToolCallCorrectness,assertRetrievalGrounding,assertSupportAnswerQuality,assertBusinessRules,assertAgentTaskCompletion,assertAcceptance};
