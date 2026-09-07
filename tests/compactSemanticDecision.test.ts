import {describe,it,expect} from 'vitest';
import {compactSemanticDecisionFormat,expandCompactSemanticDecision} from '../src/ai/compactSemanticDecision.js';
import {agentManagerStructuredFormats} from '../src/ai/agentManagerOrchestrator.js';

describe('compact planner wire',()=>{
  it('has one action list and no model-owned event identity or source',()=>{
    const original=agentManagerStructuredFormats.semanticDecisionFormat;
    const compact=compactSemanticDecisionFormat(original) as any;
    const schema=compact.format.schema;
    expect(schema.properties.intent.properties).not.toHaveProperty('requiresTools');
    expect(schema.properties.intent.properties.grounding.properties).not.toHaveProperty('requiredToolKinds');
    expect(schema.properties.ledgerDelta.properties.events.items.properties).not.toHaveProperty('source');
    expect(original.format.schema.properties.intent.properties).toHaveProperty('requiresTools');
    expect(JSON.stringify(compact).length).toBeLessThan(JSON.stringify(original).length);
  });
  it('derives required kinds only from real selected requests and preserves semantic payloads',()=>{
    const input={wireVersion:'semantic-actions-v1',ledgerDelta:{rationale:'changed budget',events:[{
      eventType:'fact.confirmed',scope:'need',status:'active',evidence:'до 90000',payload:{needId:'n',factKey:'budget',value:90000}}]},
      intent:{toolRequests:[{id:'a',tool:'catalog.search',required:true},{id:'b',tool:'web.researchProductFacts',required:false}],
        grounding:{sourcePolicy:'catalog_required'}}};
    const expanded=expandCompactSemanticDecision(input) as any;
    expect(expanded.intent.requiresTools).toBe(true);
    expect(expanded.intent.grounding.requiredToolKinds).toEqual(['catalog.search']);
    expect(expanded.ledgerDelta.events[0]).toEqual({...input.ledgerDelta.events[0],source:'llm_state_delta'});
    expect(expanded).not.toHaveProperty('wireVersion');
  });
  it('does not invent missing required actions or change legacy checkpoints',()=>{
    const legacy={intent:{requiresTools:true},ledgerDelta:{events:[]}};
    expect(expandCompactSemanticDecision(legacy)).toBe(legacy);
    const wire={wireVersion:'semantic-actions-v1',ledgerDelta:{events:[]},intent:{toolRequests:[],grounding:{webRequirement:'required'}}};
    const result=expandCompactSemanticDecision(wire) as any;
    expect(result.intent).toMatchObject({requiresTools:false,toolRequests:[],grounding:{webRequirement:'required',requiredToolKinds:[]}});
  });
  it('rejects a wire that tries to set execution-owned source or flags',()=>{
    expect(()=>expandCompactSemanticDecision({wireVersion:'semantic-actions-v1',ledgerDelta:{events:[{source:'admin_curation'}]},
      intent:{toolRequests:[],grounding:{}}})).toThrow('compact_wire_derived_field:source');
  });
});
