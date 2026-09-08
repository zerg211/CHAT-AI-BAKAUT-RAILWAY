import {describe,it,expect,vi} from 'vitest';
import {AgentManagerOrchestrator} from '../src/ai/agentManagerOrchestrator.js';
describe('semantic memory eligibility',()=>{
  it.each(['2020-01-01T00:00:00Z','not-a-date'])('never gives expired or invalid-date evidence to slot matching: %s',async lastVerifiedAt=>{
    const matchVerifiedFactMemory=vi.fn(async()=>[{factId:'stale',productName:'UNIT AX100',attribute:'requested_slot'}]);
    const products={searchVerifiedProductFacts:vi.fn(async()=>[{
      id:'stale',productName:'UNIT AX100',productKey:'unitax100',productId:null,
      attribute:'different_label',value:'70 kg',status:'active',confidence:'high',sourceType:'manual',
      sourceUrl:'https://manufacturer.example/manual',lastVerifiedAt
    }])};
    const orchestrator=new AgentManagerOrchestrator({} as never,products as never,{} as never,{matchVerifiedFactMemory} as never);
    const access=orchestrator as unknown as {researchFromVerifiedFactMemory:(input:unknown)=>Promise<{attributesCovered?:boolean}|null>};
    const result=await access.researchFromVerifiedFactMemory({sessionId:'session',turnId:'turn',
      targetProductNames:['UNIT AX100'],comparisonAttributes:['requested_slot'],selectedProducts:[]});
    expect(matchVerifiedFactMemory).not.toHaveBeenCalled();
    expect(result?.attributesCovered).not.toBe(true);
  });
});
