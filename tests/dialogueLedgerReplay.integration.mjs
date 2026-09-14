import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
const target=new URL(process.env.DATABASE_URL||'file:///missing');
assert.ok(['127.0.0.1','localhost','[::1]'].includes(target.hostname)&&target.pathname.startsWith('/bakaut_acceptance_'));
process.env.NODE_ENV='test';
const {pool}=await import('../src/db/pool.ts');
const {ConversationRepository,ProductRepository,LeadRepository}=await import('../src/db/repositories.ts');
const {AgentManagerOrchestrator}=await import('../src/ai/agentManagerOrchestrator.ts');
const {deriveNeedStateSnapshotFromLedger}=await import('../src/ai/dialogueLedgerReducer.ts');
const {budgetMaxFromNeedState}=await import('../src/ai/agentManagerCardSelection.ts');
const repo=new ConversationRepository(),visitor=randomUUID(),session=await repo.createSession({visitorId:visitor});
const owner=randomUUID(),turn=await repo.createTurnWithUserMessage({sessionId:session.id,visitorCapability:visitor,clientMessageId:randomUUID(),requestHash:randomUUID(),content:'Controlled semantic event bindings',deadlineAt:new Date(Date.now()+60000).toISOString()});
await repo.claimTurnExecution({sessionId:session.id,turnId:turn.id,ownerId:owner,leaseMs:60000});
const manager=()=>new AgentManagerOrchestrator(new ConversationRepository(),new ProductRepository(),new LeadRepository(),{});
let index=0;
const append=(eventType,payload)=>repo.upsertDialogueLedgerEvent({sessionId:session.id,turnId:turn.id,executionOwner:owner,
 eventId:'fixture-'+index++,eventType,payload,scope:'need',source:'llm_state_delta',evidence:'controlled semantic binding; not real model judgement',status:'active'});
const checkpoint=async()=>{
 const current=manager(),context=await current.loadDialogueLedgerContext(session.id),needState=deriveNeedStateSnapshotFromLedger(context.state);
 await current.persistDialogueLedgerState({sessionId:session.id,turnId:turn.id,executionOwner:owner,state:context.state,recentEvents:context.events,needState});
 const replay=await manager().loadDialogueLedgerContext(session.id);
 assert.deepEqual(replay.state.factsByKey,JSON.parse(JSON.stringify(context.state.factsByKey)));
 assert.deepEqual(replay.state.needsById,JSON.parse(JSON.stringify(context.state.needsById)));
 return deriveNeedStateSnapshotFromLedger(replay.state);
};
try{
 await append('need.opened',{needId:'generator',productClass:'generator',activate:true});
 await append('fact.confirmed',{needId:'generator',productClass:'generator',factKey:'budget.max_rub',value:120000,role:'hard_requirement'});
 assert.equal(budgetMaxFromNeedState(await checkpoint()),120000);
 await append('need.opened',{needId:'plate',productClass:'plate',activate:true});
 let state=await checkpoint();assert.equal(state.selectionState.currentProductClass,'plate');assert.equal(budgetMaxFromNeedState(state),undefined);
 await append('need.updated',{needId:'generator',activate:true});
 state=await checkpoint();assert.equal(state.selectionState.currentProductClass,'generator');assert.equal(budgetMaxFromNeedState(state),120000);
 await append('fact.confirmed',{needId:'generator',productClass:'generator',factKey:'budget.max_rub',value:150000,role:'hard_requirement'});
 assert.equal(budgetMaxFromNeedState(await checkpoint()),150000);
 await append('fact.negated',{needId:'generator',targetEventIds:['fixture-4']});
 assert.equal(budgetMaxFromNeedState(await checkpoint()),undefined);
 // A worker that lost its lease cannot revive the previous constraint or snapshot.
 await pool.query("UPDATE conversation_turns SET execution_lease_expires_at=now()-interval '1 second' WHERE id=$1",[turn.id]);
 const newOwner=randomUUID();assert.ok(await repo.claimTurnExecution({sessionId:session.id,turnId:turn.id,ownerId:newOwner,leaseMs:60000}));
 await assert.rejects(append('fact.confirmed',{needId:'generator',factKey:'budget.max_rub',value:120000,role:'hard_requirement'}),e=>e.code==='turn_mutation_not_owner_or_not_live');
 assert.equal(budgetMaxFromNeedState(deriveNeedStateSnapshotFromLedger((await manager().loadDialogueLedgerContext(session.id)).state)),undefined);
 console.log(JSON.stringify({status:'PASS',level:'I',checks:['topic-switch','return-topic','change-constraint','cancel-constraint','actual-snapshot-tail-replay','stale-owner-cannot-revive'],modelCalls:0,scope:'actual PG events -> production orchestrator ledger loader/persister -> reducer; controlled semantic bindings, no claim of LLM topic judgement'}));
}finally{await pool.query('DELETE FROM conversation_sessions WHERE id=$1',[session.id]);await pool.end();}
