import {beforeEach, describe, expect, it, vi} from 'vitest';
import type {LeadOutboxItem} from '../src/db/repositories.js';
const {prepareLeadEmailRequest, sendPreparedLeadEmail} = vi.hoisted(() => ({prepareLeadEmailRequest: vi.fn(), sendPreparedLeadEmail: vi.fn()}));
vi.mock('../src/email/httpEmail.js', () => ({prepareLeadEmailRequest, sendPreparedLeadEmail}));
const {processLeadOutboxItem} = await import('../src/ai/leadOutbox.js');
const snapshot = {version: 1 as const, url:'https://api.resend.com/emails', method:'POST',
  body:'{"text":"immutable original message"}', idempotencyKey:'bakaut-lead-lead-id', provider:'resend' as const};
function fixture(overrides: Partial<LeadOutboxItem> = {}) {
  const item: LeadOutboxItem = {id:'outbox-id',leadId:'lead-id',sessionId:'session-id',turnId:null,destination:'lead_email',
    status:'sending',attemptCount:1,leaseToken:'current-lease',payload:{},
    createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),...overrides};
  const conversations={getSession:vi.fn(async()=>({id:'session-id'})),listMessages:vi.fn(async()=>[])};
  const leads={getLead:vi.fn(async()=>({id:'lead-id'})),
    prepareLeadOutboxDispatch:vi.fn(async(input)=>({...item,requestSnapshot:item.requestSnapshot??input.snapshot})),
    markLeadOutboxSent:vi.fn(async()=>({...item,status:'sent'})),markLeadOutboxFailed:vi.fn(async()=>({...item,status:'failed'}))};
  const run=()=>processLeadOutboxItem({item,conversations:conversations as never,leads:leads as never});
  return {item,conversations,leads,run};
}
describe('durable lead delivery failure boundaries',()=>{
  beforeEach(()=>{vi.clearAllMocks();prepareLeadEmailRequest.mockReturnValue(snapshot);sendPreparedLeadEmail.mockResolvedValue({ok:true,response:{id:'provider-id'}});});
  it('persists before dispatch and replays identical bytes after acceptance followed by DB failure',async()=>{
    const f=fixture();const accepted=new Map<string,string>();let deliveries=0;
    sendPreparedLeadEmail.mockImplementation(async(request)=>{if(!accepted.has(request.idempotencyKey)){accepted.set(request.idempotencyKey,request.body);deliveries++;}
      expect(accepted.get(request.idempotencyKey)).toBe(request.body);return {ok:true,response:{id:'provider-id'}};});
    f.leads.markLeadOutboxSent.mockRejectedValueOnce(new Error('process lost after acceptance'));
    await expect(f.run()).rejects.toThrow('process lost');
    expect(f.leads.prepareLeadOutboxDispatch.mock.invocationCallOrder[0]).toBeLessThan(sendPreparedLeadEmail.mock.invocationCallOrder[0]!);
    const retry=fixture({attemptCount:2,requestSnapshot:snapshot,firstAttemptAt:new Date().toISOString(),leaseToken:'new-lease'});
    prepareLeadEmailRequest.mockReturnValue({...snapshot,body:'changed transcript'});
    expect(await retry.run()).toEqual({ok:true});expect(deliveries).toBe(1);
    expect(retry.conversations.listMessages).not.toHaveBeenCalled();
    expect(sendPreparedLeadEmail).toHaveBeenLastCalledWith(snapshot);
  });
  it.each([
    {attemptCount:2},
    {attemptCount:2,requestSnapshot:snapshot,firstAttemptAt:new Date(Date.now()-24*60*60_000).toISOString()},
    {attemptCount:2,requestSnapshot:{...snapshot,provider:'other' as const},firstAttemptAt:new Date().toISOString()}
  ])('quarantines uncertain retries without sending: %j',async(overrides)=>{
    const f=fixture(overrides);expect(await f.run()).toMatchObject({ok:false,dead:true,error:expect.stringContaining('reconciliation_required')});
    expect(sendPreparedLeadEmail).not.toHaveBeenCalled();
  });
  it('does not dispatch after losing the database lease',async()=>{
    const f=fixture();f.leads.prepareLeadOutboxDispatch.mockResolvedValueOnce(null as never);
    expect(await f.run()).toMatchObject({ok:false,error:'lease_lost'});expect(sendPreparedLeadEmail).not.toHaveBeenCalled();
  });
  it('never reports success when a stale owner cannot commit completion',async()=>{
    const f=fixture();f.leads.markLeadOutboxSent.mockResolvedValueOnce(null as never);
    expect(await f.run()).toMatchObject({ok:false,error:'lease_lost_after_send'});
  });
});
