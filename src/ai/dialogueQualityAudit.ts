export interface QualityAuditTurn {
  turnId:string; sessionId:string; status:string; createdAt:Date|string; deadlineAt:Date|string;
  hasAnswer:boolean; errorCode:string|null; errorClass:string|null; buildCommit:string|null;
  wallTimeMs:number|null; modelCalls:number|null; recovered:boolean; rating:string|null;
  estimatedCostUsd?:number|null; totalTokens?:number|null;
  resolutionStatus?:'resolved'|'unresolved'|'unknown';
  recoveryAttempts?:number|null; serverAnswerMs?:number|null; knowledgeReuseHits?:number|null;
  firstUsefulContentMs?:number|null;
  autonomyObservations?:Array<{eventType:string;round?:number|null;action?:string|null;stopReason?:string|null}>;
  tools:Array<{tool:string;status:string;priceUnavailable?:boolean}>; reviewIssues:string[];
}

const safeCode=(value:string)=>value.length<=160 && [...value].every(c=>'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_.-'.includes(c));
function finiteNumber(value:unknown){if(value===null||value===undefined||value==='')return null;const number=Number(value);return Number.isFinite(number)?number:null;}
function percentile(values:number[],fraction:number){return values.length?values[Math.min(values.length-1,Math.floor(values.length*fraction))]:null;}

/** Execution signals create a review queue; absence of a signal never certifies answer quality. */
export function buildDialogueQualityAudit(rows:QualityAuditTurn[],input:{hours:number;limit:number;now?:Date;
  delivery?:{operationDenominator:number;attemptCount:number;retryCount:number;observedDuplicateOperations:number;unknownOperations:number;legacyOperations:number;duplicatesPer100Operations:number|null;basis:string}}){
  const now=input.now??new Date();
  const groups=new Map<string,{reason:string;count:number;turns:Array<{sessionId:string;turnId:string;buildCommit:string|null}>}>();
  const turns=rows.map(row=>{
    const reasons=new Set<string>();
    if(!row.hasAnswer && new Date(row.deadlineAt).getTime()<now.getTime())reasons.add('expired_without_answer');
    if(row.errorCode)reasons.add(`turn_error:${safeCode(row.errorCode)?row.errorCode:'unclassified'}`);
    if(row.errorClass)reasons.add(`failure_class:${safeCode(row.errorClass)?row.errorClass:'unclassified'}`);
    if(row.recovered)reasons.add('recovered_answer');
    if(row.rating==='negative'||row.rating==='wrong_cards')reasons.add(`customer_feedback:${row.rating}`);
    for(const tool of row.tools){
      if(tool.status==='error'||tool.status==='timeout')reasons.add(`tool_${tool.status}:${safeCode(tool.tool)?tool.tool:'unclassified'}`);
      if(tool.priceUnavailable)reasons.add('company_price_unavailable');
    }
    for(const issue of row.reviewIssues){const category=issue.split(':')[0];if(safeCode(category))reasons.add(`review:${category}`);}
    for(const reason of reasons){
      const group=groups.get(reason)??{reason,count:0,turns:[]};group.count++;
      group.turns.push({sessionId:row.sessionId,turnId:row.turnId,buildCommit:row.buildCommit});groups.set(reason,group);
    }
    return {sessionId:row.sessionId,turnId:row.turnId,status:row.status,hasAnswer:row.hasAnswer,buildCommit:row.buildCommit,
      wallTimeMs:finiteNumber(row.wallTimeMs),modelCalls:finiteNumber(row.modelCalls),signals:[...reasons],
      estimatedCostUsd:finiteNumber(row.estimatedCostUsd),totalTokens:finiteNumber(row.totalTokens),
      resolutionStatus:row.resolutionStatus ?? 'unknown',
      customerQuality:reasons.size?'NEEDS_REVIEW':'NOT_JUDGED'};
  });
  const durations=rows.flatMap(row=>{const duration=finiteNumber(row.wallTimeMs);return duration!==null&&duration>=0?[duration]:[];}).sort((a,b)=>a-b);
  const latestBySession = new Map<string, QualityAuditTurn>();
  for (const row of rows) {
    const previous = latestBySession.get(row.sessionId);
    if (!previous || new Date(row.createdAt).getTime() > new Date(previous.createdAt).getTime()) {
      latestBySession.set(row.sessionId, row);
    }
  }
  const conversationRows = [...latestBySession.values()];
  const resolvedConversationCount = conversationRows.filter(row => row.resolutionStatus === 'resolved').length;
  const unresolvedConversationCount = conversationRows.filter(row => row.resolutionStatus === 'unresolved').length;
  const unknownConversationCount = conversationRows.filter(row => !row.resolutionStatus || row.resolutionStatus === 'unknown').length;
  const totalEstimatedCostUsd = rows.reduce((sum, row) => sum + (finiteNumber(row.estimatedCostUsd) ?? 0), 0);
  const completeCost=rows.length>0 && rows.length<input.limit && rows.every(row=>finiteNumber(row.estimatedCostUsd)!==null);
  const measured=(values:Array<number|null>)=>{const present=values.filter((n):n is number=>n!==null && n>=0);
    return {sampleCount:present.length,turnDenominator:rows.length,total:present.length?present.reduce((sum,n)=>sum+n,0):null};};
  const answerTimes=rows.map(row=>finiteNumber(row.serverAnswerMs)).filter((n):n is number=>n!==null&&n>=0).sort((a,b)=>a-b);
  const deliveryTimes=rows.map(row=>finiteNumber(row.firstUsefulContentMs)).filter((n):n is number=>n!==null&&n>=0&&n<=600_000).sort((a,b)=>a-b);
  const stopCodes=new Set(['continuation_requires_read_only','continuation_round_limit','continuation_budget_reserve',
    'answer_time_reserve','invalid_continuation','observation_failed','wall_time_budget_exceeded',
    'model_call_budget_exceeded','provider_call_budget_exceeded','tool_call_budget_exceeded','web_call_budget_exceeded',
    'tool_result_budget_exceeded','provider_input_token_budget_exceeded','provider_output_token_budget_exceeded',
    'provider_total_token_budget_exceeded','estimated_cost_budget_exceeded']);
  let observedTurnCount=0,decisionRoundCount=0,stoppedTurnCount=0,roundLimitTurnCount=0;
  const stops=new Map<string,number>();
  for(const row of rows){
    const observations=(row.autonomyObservations??[]).filter(item=>
      item.eventType==='autonomy_decision'||item.eventType==='observation_cycle_stopped');
    if(!observations.length)continue;
    observedTurnCount++;
    const rounds=new Set<number>(),reasons=new Set<string>();
    for(const item of observations){
      if(item.eventType==='autonomy_decision'&&typeof item.round==='number'&&Number.isSafeInteger(item.round)&&item.round>0)rounds.add(item.round);
      if(item.stopReason)reasons.add(stopCodes.has(item.stopReason)?item.stopReason:'unclassified');
      else if(item.eventType==='observation_cycle_stopped')reasons.add('unclassified');
    }
    decisionRoundCount+=rounds.size;
    if(reasons.size)stoppedTurnCount++;
    if(reasons.has('continuation_round_limit'))roundLimitTurnCount++;
    for(const reason of reasons)stops.set(reason,(stops.get(reason)??0)+1);
  }
  return {schemaVersion:'dialogue-quality-audit-v1',generatedAt:now.toISOString(),windowHours:input.hours,limit:input.limit,
    possiblyTruncated:rows.length>=input.limit,turnCount:rows.length,answerCount:rows.filter(r=>r.hasAnswer).length,
    latency:{sampleCount:durations.length,medianMs:percentile(durations,.5),p95Ms:percentile(durations,.95)},
    outcomes:{confirmedDenominator:resolvedConversationCount+unresolvedConversationCount,
      resolvedRate:resolvedConversationCount+unresolvedConversationCount?resolvedConversationCount/(resolvedConversationCount+unresolvedConversationCount):null},
    operations:{recoveryAttempts:measured(rows.map(row=>finiteNumber(row.recoveryAttempts))),
      autonomy:{observedTurnCount,turnDenominator:rows.length,unobservedTurnCount:rows.length-observedTurnCount,
        decisionRoundCount:observedTurnCount?decisionRoundCount:null,stoppedTurnCount:observedTurnCount?stoppedTurnCount:null,
        roundLimitTurnCount:observedTurnCount?roundLimitTurnCount:null,
        stopReasons:[...stops].map(([reason,turnCount])=>({reason,turnCount})),
        basis:'observed_trace_rounds_deduplicated_per_turn; missing_traces_not_zero; stops_not_outcome_labels'},
      recoveredTurns:rows.filter(row=>row.recovered).length,turnDenominator:rows.length,
      toolCalls:measured(rows.map(row=>row.tools.length)),
      knowledgeReuse:measured(rows.map(row=>finiteNumber(row.knowledgeReuseHits))),
      duplicateBusinessActions:input.delivery??null,
      firstUsefulContentMs:{sampleCount:deliveryTimes.length,turnDenominator:rows.length,medianMs:percentile(deliveryTimes,.5),p95Ms:percentile(deliveryTimes,.95),basis:'client_reported_visible_render_opportunity; initial_submit_only'},
      serverAnswerLatency:{sampleCount:answerTimes.length,medianMs:percentile(answerTimes,.5),p95Ms:percentile(answerTimes,.95)}},
    cost:{currency:'USD',basis:'estimated_token_rate',turnCostSampleCount:rows.filter(row => finiteNumber(row.estimatedCostUsd)!==null).length,
      conversationCount:conversationRows.length,resolvedConversationCount,unresolvedConversationCount,unknownConversationCount,
      totalEstimatedCostUsd:Number(totalEstimatedCostUsd.toFixed(6)),
      complete:completeCost,unknownCostTurnCount:rows.filter(row=>finiteNumber(row.estimatedCostUsd)===null).length,
      costPerResolvedConversationUsd:completeCost && resolvedConversationCount
        ? Number((totalEstimatedCostUsd / resolvedConversationCount).toFixed(6))
        : null},
    qualityVerdict:'NOT_PROVEN',reviewQueue:[...groups.values()].sort((a,b)=>b.count-a.count),turns};
}
