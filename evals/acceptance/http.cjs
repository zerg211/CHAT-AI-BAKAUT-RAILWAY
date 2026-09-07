'use strict';
const {randomUUID}=require('node:crypto');
const {hash}=require('./engine.cjs');
class HarnessError extends Error { constructor(code,message=code){super(message);this.code=code;} }
function parseSse(text) {
 const out=[];
 for(const block of text.split('\r\n').join('\n').split('\r').join('\n').split('\n\n')) {
  let event='message'; const data=[];
  for(const line of block.split('\n')) {if(line.startsWith('event:'))event=line.slice(6).trim();if(line.startsWith('data:'))data.push(line.slice(5).startsWith(' ')?line.slice(6):line.slice(5));}
  if(!data.length)continue;
  let value;try{value=JSON.parse(data.join('\n'));}catch{throw new HarnessError('MALFORMED_SSE','Malformed JSON in SSE event');}
  out.push({event,data:value});
 }
 return out;
}
class HttpClient {
 constructor({baseUrl,adminToken,timeoutMs=160000,maxBytes=8*1024*1024,maxRequests=500,fetchImpl=globalThis.fetch}) {
  const u=new URL(baseUrl);
  if(!['http:','https:'].includes(u.protocol)||u.username||u.password||u.search||u.hash||u.pathname!=='/')throw new HarnessError('INVALID_BASE_URL','Use an origin without credentials/path/query');
  this.baseUrl=u.origin;this.token=adminToken;this.timeoutMs=timeoutMs;this.maxBytes=maxBytes;this.maxRequests=maxRequests;this.fetchImpl=fetchImpl;this.requests=0;
 }
 async request(path,{method='GET',body,admin=false,visitorId,timeoutMs=this.timeoutMs}={}) {
  if(this.requests>=this.maxRequests)throw new HarnessError('HTTP_BUDGET');this.requests++;
  if(!path.startsWith('/')||path.startsWith('//'))throw new HarnessError('INVALID_PATH');
  const controller=new AbortController();const start=performance.now();
  const timer=setTimeout(()=>controller.abort(),timeoutMs);
  try {
   const headers={'content-type':'application/json'};
   if(admin){if(!this.token)throw new HarnessError('ADMIN_TOKEN_MISSING');headers.authorization=`Bearer ${this.token}`;}
   if(visitorId)headers['x-bakaut-visitor-id']=visitorId;
   const response=await this.fetchImpl(this.baseUrl+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body),signal:controller.signal,redirect:'error'});
   const reader=response.body?.getReader();let text='',bytes=0,firstUsefulMs=null;const decoder=new TextDecoder();
   if(reader){try{for(;;){const chunk=await reader.read();if(chunk.done)break;bytes+=chunk.value.byteLength;if(bytes>this.maxBytes){await reader.cancel();throw new HarnessError('BODY_TOO_LARGE');}text+=decoder.decode(chunk.value,{stream:true});
    // Only complete delta events count. Status/typing events never count as useful.
    const normalized=text.split('\r\n').join('\n').split('\r').join('\n');const last=normalized.lastIndexOf('\n\n');
    if(firstUsefulMs===null&&last>=0)for(const e of parseSseIfSse(normalized.slice(0,last+2),response.headers.get('content-type')))if(e.event==='delta'&&typeof e.data?.delta==='string'&&e.data.delta.trim())firstUsefulMs=performance.now()-start;
   }text+=decoder.decode();}finally{reader.releaseLock();}}
   else{text=await response.text();if(Buffer.byteLength(text)>this.maxBytes)throw new HarnessError('BODY_TOO_LARGE');}
   const elapsedMs=performance.now()-start;
   if(!response.ok)throw new HarnessError(`HTTP_${response.status}`,`HTTP ${response.status} at ${path.split('?')[0]}`);
   return {text,elapsedMs,firstUsefulMs,status:response.status};
  } catch(e){if(controller.signal.aborted)throw new HarnessError('HTTP_DEADLINE',`Body/header deadline exceeded at ${path.split('?')[0]}`);throw e;}
  finally{clearTimeout(timer);}
 }
 async json(path,options){const r=await this.request(path,options);try{return JSON.parse(r.text);}catch{throw new HarnessError('MALFORMED_JSON',path);}}
 async health(){const h=await this.json('/api/admin/health',{admin:true});if(!h.runtime?.commitSha)throw new HarnessError('COMMIT_MARKER_MISSING');return h;}
 async control(action){return this.json('/__acceptance/control',{method:'POST',admin:true,body:action});}
 async start(){const visitorId=randomUUID();const r=await this.json('/api/chat/sessions',{method:'POST',body:{visitorId,pageUrl:`${this.baseUrl}/widget?acceptance=1`}});if(!r.session?.id)throw new HarnessError('SESSION_MISSING');return {id:r.session.id,visitorId};}
 async send(session,user,clientMessageId=randomUUID()) {
  const r=await this.request(`/api/chat/sessions/${session.id}/messages`,{method:'POST',visitorId:session.visitorId,body:{message:user,clientMessageId}});
  const events=parseSse(r.text),done=events.filter(e=>e.event==='done'),err=events.find(e=>e.event==='error');
  if(done.length!==1||err)return {ok:false,user,turnId:events.find(e=>e.event==='turn')?.data?.turnId??randomUUID(),answer:'',productCards:[],elapsedMs:r.elapsedMs,firstUsefulMs:r.firstUsefulMs,error:err?.data?.error??'MISSING_DONE',events};
  const d=done[0].data;
  const t={ok:true,user,clientMessageId,turnId:d.turnId,assistantMessageId:d.assistantMessageId,answer:d.answer,productCards:d.productCards,leadRequested:d.leadRequested===true,elapsedMs:r.elapsedMs,firstUsefulMs:r.firstUsefulMs??r.elapsedMs,publicPayload:d};
  if(!t.turnId||!t.assistantMessageId)throw new HarnessError('PUBLIC_ID_MISSING');
  // Diagnostics are intentionally private. Do not expect them in public SSE.
  const detail=await this.json(`/api/admin/conversations/${session.id}`,{admin:true});
  const turn=detail.turns?.find(x=>x.id===t.turnId);
  const msg=detail.messages?.find(x=>x.id===t.assistantMessageId&&x.role==='assistant');
  if(!turn||turn.assistantMessageId!==t.assistantMessageId||!msg||msg.content!==t.answer)throw new HarnessError('AUDIT_JOIN_MISMATCH');
  t.metadata=typeof msg.metadata==='string'?JSON.parse(msg.metadata):msg.metadata;
  if(!t.metadata||t.metadata.turnId!==t.turnId)throw new HarnessError('AUDIT_METADATA_MISSING');
  t.audit={turnId:t.turnId,assistantMessageId:t.assistantMessageId};return t;
 }
 async close(session){return this.json(`/api/chat/sessions/${session.id}/close`,{method:'POST',visitorId:session.visitorId,body:{}});}
}
function parseSseIfSse(text,type){return type?.includes('text/event-stream')?parseSse(text):[];}
async function collectCase(client,scenario,world,{maxAgentTurns=50,replay=false}={}) {
 if(scenario.steps.length+(replay?1:0)>maxAgentTurns)throw new HarnessError('AGENT_TURN_BUDGET');
 const before=await client.health();const session=await client.start();
 const run={scenarioId:scenario.id,sessionId:session.id,worldHash:hash(world),commit:before.runtime.commitSha,models:{answer:before.answerModel,planner:before.plannerModel,fact:before.factModel},startedAt:new Date().toISOString(),turns:[]};
 try {
  for(const step of scenario.steps){if(step.before)await client.control(step.before);const id=randomUUID();const t=await client.send(session,step.user,id);
   if(step.expect?.leadCount!==undefined){const l=await client.json('/api/admin/leads?limit=500',{admin:true});if(!Array.isArray(l.leads)||l.leads.length>=500)throw new HarnessError('LEAD_SNAPSHOT_INCOMPLETE');t.audit??={};t.audit.leads=l.leads.filter(l=>l.sessionId===session.id);}
   if(step.expect?.outboxCount!==undefined){const observed=await client.control({action:'outbox',sessionId:session.id});t.audit??={};t.audit.outbox=observed.outbox;}
   if(replay&&t.ok&&step===scenario.steps[scenario.steps.length-1]){const repeated=await client.send(session,step.user,id);t.replay={first:t.publicPayload,second:repeated.publicPayload};t.transportRecovered=true;}
   run.turns.push(t);if(!t.ok)break;
  }
  const after=await client.health();if(after.runtime.commitSha!==run.commit || after.answerModel!==run.models.answer || after.plannerModel!==run.models.planner || after.factModel!==run.models.fact)throw new HarnessError('DEPLOYMENT_CHANGED_DURING_TEST');
 }catch(e){run.harnessError={code:e.code??'COLLECTION_ERROR',message:e.message};}
 finally{try{await client.close(session);}catch(e){run.cleanupError={code:e.code??'CLEANUP_ERROR'};}}
 run.finishedAt=new Date().toISOString();return run;
}
module.exports={HarnessError,parseSse,HttpClient,collectCase};
