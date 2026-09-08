import {describe,it,expect} from 'vitest';
import {admitReadContinuation} from '../src/ai/readContinuationController.js';
import type {AgentIntentContract,ToolRequest} from '../src/ai/agentManagerContracts.js';
const request=(tool:string)=>({id:'next',tool}) as ToolRequest;
const input=()=>({intent:{grounding:{taskType:'technical_answer'}} as AgentIntentContract,
  decision:{action:'continue' as const,rationale:'check missing detail',missingFacts:['exact accessory'],candidateProductIds:[],toolRequests:[request('catalog.getProductDetails')]},
  results:[],round:1,completedToolCalls:1,completedWebCalls:0,maxToolCalls:5,maxWebCalls:2,remainingMs:60_000,allReadsAlreadyPersisted:false});
describe('executable read continuation admission',()=>{
  it('honors the model stop and never invents a next action',()=>{
    const test=input();const result=admitReadContinuation({...test,decision:{...test.decision,action:'answer',toolRequests:[]}});
    expect(result.action).toBe('answer');expect(result.state.requests).toEqual([]);
  });
  it('stops before a side effect or a read that consumes the answer reserve',()=>{
    const test=input();
    expect(admitReadContinuation({...test,remainingMs:20_000}).action).toBe('stop');
    expect(admitReadContinuation({...test,decision:{...test.decision,toolRequests:[request('lead.capture')]}}).stopReason).toBe('continuation_requires_read_only');
    expect(admitReadContinuation({...test,completedToolCalls:5}).action).toBe('stop');
    expect(admitReadContinuation(test).action).toBe('execute');
  });
  it('can replay saved observations without granting new network budget',()=>{
    const test=input();
    expect(admitReadContinuation({...test,remainingMs:20_000,allReadsAlreadyPersisted:true}).action).toBe('execute');
    expect(admitReadContinuation({...test,round:3,allReadsAlreadyPersisted:true}).stopReason).toBe('continuation_round_limit');
  });
});
