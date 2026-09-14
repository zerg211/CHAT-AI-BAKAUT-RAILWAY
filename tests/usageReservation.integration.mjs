import assert from 'node:assert/strict';
const target=new URL(process.env.DATABASE_URL||'file:///missing');
assert.ok(['127.0.0.1','localhost','[::1]'].includes(target.hostname)&&target.pathname.startsWith('/bakaut_acceptance_'));
Object.assign(process.env,{NODE_ENV:'test',OPENAI_USAGE_GUARD_ENABLED:'true',OPENAI_DAILY_TOKEN_BUDGET:'1000',OPENAI_BUDGET_GUARD_RESERVE_TOKENS:'1'});
const {pool}=await import('../src/db/pool.ts');
const {assertOpenAIUsageBudget,bindOpenAIUsageReservation,recordOpenAIUsage,releaseOpenAIUsageReservation}=await import('../src/ai/openaiUsageGuard.ts');
const reservations=[];
const model='gpt-5.6-luna',stage='isolated-reservation-test';
try{
 assert.equal((await pool.query('SELECT count(*)::int AS n FROM openai_usage_reservations')).rows[0].n,0,'clean isolated usage ledger');
 const attempts=await Promise.allSettled(Array.from({length:5},()=>assertOpenAIUsageBudget(stage,model,250)));
 reservations.push(...attempts.filter(r=>r.status==='fulfilled').map(r=>r.value));
 assert.equal(reservations.length,4);assert.equal(attempts.filter(r=>r.status==='rejected').length,1);
 const state=(await pool.query("SELECT sum(reserved_tokens)::int AS tokens,min(expires_at-created_at)>=interval '23 hours' AS full_window FROM openai_usage_reservations WHERE status='reserved'")).rows[0];
 assert.deepEqual(state,{tokens:1000,full_window:true});
 const unknown={id:'isolated-unknown-usage'};
 bindOpenAIUsageReservation(unknown,reservations[0]);
 await recordOpenAIUsage(stage,model,unknown);
 assert.equal((await pool.query('SELECT status FROM openai_usage_reservations WHERE id=$1',[reservations[0]])).rows[0].status,'reserved');
 assert.equal((await pool.query('SELECT total_tokens,cost_usd FROM openai_usage_events WHERE response_id=$1',[unknown.id])).rows[0].total_tokens,null);
 await assert.rejects(assertOpenAIUsageBudget(stage,model,1));
 const known={id:'isolated-known-usage',usage:{input_tokens:80,output_tokens:20,total_tokens:100}};
 bindOpenAIUsageReservation(known,reservations[1]);
 await recordOpenAIUsage(stage,model,known);
 assert.deepEqual((await pool.query('SELECT status,actual_tokens FROM openai_usage_reservations WHERE id=$1',[reservations[1]])).rows[0],{status:'reconciled',actual_tokens:100});
 reservations.push(await assertOpenAIUsageBudget(stage,model,150));
 await assert.rejects(assertOpenAIUsageBudget(stage,model,1));
 await releaseOpenAIUsageReservation(reservations.at(-1)); // Explicit known cancellation, no provider call was made.
 assert.equal((await pool.query('SELECT status FROM openai_usage_reservations WHERE id=$1',[reservations.at(-1)])).rows[0].status,'released');
 console.log(JSON.stringify({status:'PASS',level:'I',checks:['five-concurrent-reservations','daily-hard-ceiling','unknown-retained-full-window','missing-usage-not-zero','known-usage-settled','explicit-undispatched-release'],modelCalls:0}));
}finally{await pool.query('DELETE FROM openai_usage_events WHERE stage=$1',[stage]);await pool.query('DELETE FROM openai_usage_reservations WHERE id=ANY($1::uuid[])',[reservations]);await pool.end();}
