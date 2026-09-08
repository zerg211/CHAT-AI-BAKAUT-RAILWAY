// Real PostgreSQL lease/atomicity checks; no provider network access or actual mail.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
const target=new URL(process.env.DATABASE_URL || 'file:///missing');
assert.ok(['127.0.0.1','localhost','[::1]'].includes(target.hostname) && target.pathname.startsWith('/bakaut_acceptance_'),
 'An explicit isolated loopback bakaut_acceptance_* database is required');
process.env.NODE_ENV='test';
const {pool}=await import('../src/db/pool.ts');
const {LeadRepository}=await import('../src/db/repositories.ts');
const repo=new LeadRepository(), other=new LeadRepository();
const session=randomUUID(),lead=randomUUID(),id=randomUUID();
try {
 await pool.query('INSERT INTO conversation_sessions(id) VALUES($1)',[session]);
 await pool.query("INSERT INTO leads(id,session_id,name) VALUES($1,$2,'isolated delivery fixture')",[lead,session]);
 await pool.query("INSERT INTO lead_outbox(id,lead_id,session_id,destination,payload,status) VALUES($1,$2,$3,'lead_email','{}','pending')",[id,lead,session]);
 const claims=(await Promise.all([repo.claimDueLeadOutbox(1),other.claimDueLeadOutbox(1)])).flat();
 assert.equal(claims.length,1);const first=claims[0];assert.equal(first.id,id);assert.ok(first.leaseToken);
 const snapshot={version:1,url:'https://api.resend.com/emails',method:'POST',provider:'resend',idempotencyKey:`bakaut-lead-${lead}`,body:'{"text":"original bytes"}'};
 const prepared=await repo.prepareLeadOutboxDispatch({id,leaseToken:first.leaseToken,snapshot});
 assert.deepEqual(prepared.requestSnapshot,snapshot);assert.ok(prepared.firstAttemptAt);
 const attemptedMutation=await repo.prepareLeadOutboxDispatch({id,leaseToken:first.leaseToken,snapshot:{...snapshot,body:'changed'}});
 assert.deepEqual(attemptedMutation.requestSnapshot,snapshot);assert.equal(attemptedMutation.firstAttemptAt,prepared.firstAttemptAt);
 const accepted=new Map();let businessSends=0;
 function provider(request){if(!accepted.has(request.idempotencyKey)){accepted.set(request.idempotencyKey,request.body);businessSends++;}
   assert.equal(accepted.get(request.idempotencyKey),request.body);return {ok:true,response:{id:'isolated-provider-operation'}};}
 provider(prepared.requestSnapshot); // Simulated process loss before database completion.
 await pool.query("UPDATE lead_outbox SET leased_until=now()-interval '1 second' WHERE id=$1",[id]);
 const [second]=await other.claimDueLeadOutbox(1);assert.ok(second);assert.notEqual(second.leaseToken,first.leaseToken);
 assert.equal(await repo.markLeadOutboxSent(id,first.leaseToken,{ok:true}),null);
 assert.equal(await repo.markLeadOutboxFailed({id,leaseToken:first.leaseToken,error:'stale writer',dead:true}),null);
 assert.equal((await pool.query('SELECT status FROM leads WHERE id=$1',[lead])).rows[0].status,'pending_email');
 const retry=await other.prepareLeadOutboxDispatch({id,leaseToken:second.leaseToken,snapshot:{...snapshot,body:'new configuration'}});
 assert.deepEqual(retry.requestSnapshot,snapshot);assert.equal(retry.firstAttemptAt,prepared.firstAttemptAt);
 assert.ok(await other.markLeadOutboxSent(id,second.leaseToken,provider(retry.requestSnapshot)));
 assert.equal(businessSends,1);
 const final=(await pool.query('SELECT o.status,o.provider_operation_id,l.status AS lead_status FROM lead_outbox o JOIN leads l ON l.id=o.lead_id WHERE o.id=$1',[id])).rows[0];
 assert.deepEqual(final,{status:'sent',provider_operation_id:'isolated-provider-operation',lead_status:'sent_email'});
 assert.equal(await repo.markLeadOutboxFailed({id,leaseToken:first.leaseToken,error:'late failure'}),null);
 console.log('PASS competing claims, immutable snapshot, post-acceptance crash replay, stale-owner fencing, atomic lead/outbox completion');
} finally {
 await pool.query('DELETE FROM leads WHERE id=$1',[lead]);
 await pool.query('DELETE FROM conversation_sessions WHERE id=$1',[session]);
 await pool.end();
}
