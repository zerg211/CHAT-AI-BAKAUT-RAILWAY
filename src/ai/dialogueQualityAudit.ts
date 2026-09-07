export interface QualityAuditTurn {
  turnId:string; sessionId:string; status:string; createdAt:Date|string; deadlineAt:Date|string;
  hasAnswer:boolean; errorCode:string|null; errorClass:string|null; buildCommit:string|null;
  wallTimeMs:number|null; modelCalls:number|null; recovered:boolean; rating:string|null;
  tools:Array<{tool:string;status:string;priceUnavailable?:boolean}>; reviewIssues:string[];
}

const safeCode=(value:string)=>value.length<=160 && [...value].every(c=>'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_.-'.includes(c));
function percentile(values:number[],fraction:number){return values.length?values[Math.min(values.length-1,Math.floor(values.length*fraction))]:null;}

/** Execution signals create a review queue; absence of a signal never certifies answer quality. */
export function buildDialogueQualityAudit(rows:QualityAuditTurn[],input:{hours:number;limit:number;now?:Date}){
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
      wallTimeMs:row.wallTimeMs,modelCalls:row.modelCalls,signals:[...reasons],
      customerQuality:reasons.size?'NEEDS_REVIEW':'NOT_JUDGED'};
  });
  const durations=rows.flatMap(row=>Number.isFinite(row.wallTimeMs)&&row.wallTimeMs!==null&&row.wallTimeMs>=0?[row.wallTimeMs]:[]).sort((a,b)=>a-b);
  return {schemaVersion:'dialogue-quality-audit-v1',generatedAt:now.toISOString(),windowHours:input.hours,limit:input.limit,
    possiblyTruncated:rows.length>=input.limit,turnCount:rows.length,answerCount:rows.filter(r=>r.hasAnswer).length,
    latency:{sampleCount:durations.length,medianMs:percentile(durations,.5),p95Ms:percentile(durations,.95)},
    qualityVerdict:'NOT_PROVEN',reviewQueue:[...groups.values()].sort((a,b)=>b.count-a.count),turns};
}
