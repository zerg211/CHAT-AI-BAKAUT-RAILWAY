import type {AgentIntentContract,ToolResult} from './agentManagerContracts.js';
import {CONTINUATION_MAX_ROUNDS,continuationReadTools,type ContinuationDecision} from './agentManagerContinuation.js';

export function admitReadContinuation(input:{
  intent:AgentIntentContract; decision:ContinuationDecision; results:ToolResult[]; round:number;
  completedToolCalls:number; completedWebCalls:number; maxToolCalls:number; maxWebCalls:number;
  remainingMs:number; allReadsAlreadyPersisted:boolean;
}) {
  const {decision}=input;
  const state={version:1,goal:input.intent.grounding?.taskType??'unknown',
    known:input.results.filter(result=>result.status==='ok').map(result=>result.requestId).slice(-32),
    missing:decision.missingFacts.slice(0,12),selectedAction:decision.action,
    requests:decision.toolRequests.map(request=>({id:request.id,tool:request.tool})),
    requiredConsent:'none_for_read_only_continuation',round:input.round};
  let stopReason:string|null=null;
  if(decision.action==='continue') {
    if(decision.toolRequests.some(request=>!continuationReadTools.has(request.tool))) stopReason='continuation_requires_read_only';
    else if(input.round>CONTINUATION_MAX_ROUNDS)stopReason='continuation_round_limit';
    else if(!input.allReadsAlreadyPersisted && (
      input.completedToolCalls+decision.toolRequests.length>input.maxToolCalls ||
      input.completedWebCalls+decision.toolRequests.filter(request=>request.tool==='web.researchProductFacts').length>input.maxWebCalls ||
      input.remainingMs<36_000))stopReason='continuation_budget_reserve';
  }
  return {state:{...state,stopReason},action:stopReason?'stop' as const:decision.action==='continue'?'execute' as const:decision.action,
    stopReason};
}
