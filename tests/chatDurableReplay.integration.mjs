// Real HTTP, route, orchestrator replay and PostgreSQL. No model generation.
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import Fastify from 'fastify';
const target=new URL(process.env.DATABASE_URL||'file:///missing');
assert.ok(['127.0.0.1','localhost','[::1]'].includes(target.hostname)&&target.pathname.startsWith('/bakaut_acceptance_'));
process.env.NODE_ENV='test';
const {pool}=await import('../src/db/pool.ts');
const {ConversationRepository,ProductRepository,LeadRepository}=await import('../src/db/repositories.ts');
const {AgentManagerOrchestrator}=await import('../src/ai/agentManagerOrchestrator.ts');
const {registerChatRoutes}=await import('../src/routes/chat.ts');
const {emptyNeedState}=await import('../src/ai/needState.ts');
const repo=new ConversationRepository(),visitor=randomUUID(),sessions=[];
const app=Fastify({logger:false});
let modelCalls=0;
const forbidden=new Proxy({}, {get:()=>()=>{modelCalls++;throw Error('Replay must not call a model');}});
const assistant=new AgentManagerOrchestrator(new ConversationRepository(),new ProductRepository(),new LeadRepository(),forbidden,
 async()=>{throw Error('Replay must not embed');},async()=>{throw Error('Replay must not read prices');});
const hash=(session,message)=>createHash('sha256').update(`${session}\n${message.trim()}`).digest('hex');
try{
 const session=await repo.createSession({visitorId:visitor});sessions.push(session.id);
 const clientMessageId=randomUUID(),content='Durable answer transport fixture',owner=randomUUID();
 const turn=await repo.createTurnWithUserMessage({sessionId:session.id,visitorCapability:visitor,clientMessageId,
  requestHash:hash(session.id,content),content,deadlineAt:new Date(Date.now()+60000).toISOString()});
 await repo.claimTurnExecution({sessionId:session.id,turnId:turn.id,ownerId:owner,leaseMs:60000});
 const answer='Persisted answer with exact source conditions.';
 const payload={turnId:turn.id,answer,needState:emptyNeedState(),productCards:[],usedWebSearch:false};
 const message=await repo.addAssistantMessageForTurn({sessionId:session.id,turnId:turn.id,executionOwner:owner,content:answer,
  answerContract:{answerText:answer},responsePayload:payload,metadata:{needStateSnapshot:payload.needState,productCards:[]}});
 // The answer committed before transport delivery. New route/repository instances
 // recover it without generating a replacement (the disconnect/restart boundary).
 await registerChatRoutes(app,{conversations:new ConversationRepository(),assistant});
 const base=await app.listen({host:'127.0.0.1',port:0});
 const url=`${base}/api/chat/sessions/${session.id}/messages`;
 const headers={'content-type':'application/json','x-bakaut-visitor-id':visitor};
 const post=(id=clientMessageId,text=content)=>fetch(url,{method:'POST',headers,body:JSON.stringify({message:text,clientMessageId:id})});
 const responses=await Promise.all([post(),post()]);
 const streams=await Promise.all(responses.map(async response=>{assert.equal(response.status,200);assert.equal(response.headers.get('x-chat-turn-id'),turn.id);return response.text();}));
 for(const stream of streams){
  const done=stream.split('\n\n').find(event=>event.startsWith('event: done\n'));
  assert.ok(done,'actual SSE done event');
  const actual=JSON.parse(done.slice(done.indexOf('data: ')+6));
  assert.equal(actual.answer,answer);assert.equal(actual.assistantMessageId,message.id);assert.deepEqual(actual.productCards,[]);
 }
 const history=await (await fetch(url,{headers})).json();
 assert.equal(history.messages.filter(item=>item.role==='assistant').length,1);
 assert.equal(history.messages.find(item=>item.role==='assistant').content,answer);
 assert.equal((await post(clientMessageId,'Different payload under same retry id')).status,409);
 assert.equal((await fetch(url,{headers:{...headers,'x-bakaut-visitor-id':randomUUID()}})).status,404);
 const newId=randomUUID();
 const next=await repo.createTurnWithUserMessage({sessionId:session.id,visitorCapability:visitor,clientMessageId:newId,
  requestHash:hash(session.id,content),content,deadlineAt:new Date(Date.now()+60000).toISOString()});
 assert.notEqual(next.id,turn.id,'an intentional repeated phrase with a new client id is a new turn');
 const second=await repo.createSession({visitorId:visitor});sessions.push(second.id);
 assert.deepEqual((await repo.getHistorySnapshot(second.id)).messages,[]);
 assert.equal(modelCalls,0);
 console.log(JSON.stringify({status:'PASS',level:'I',checks:['committed-answer-new-instance-replay','concurrent-retry-SSE','public-history-agrees','new-operation-distinct','visitor-isolation','new-session-empty'],modelCalls,
  scope:'real loopback HTTP and production route/orchestrator/repository; committed fixture models transport loss, not an end-to-end generated answer or browser reload'}));
}finally{await app.close();await pool.query('DELETE FROM conversation_sessions WHERE id=ANY($1::uuid[])',[sessions]);await pool.end();}
