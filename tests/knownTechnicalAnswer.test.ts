import { describe, it, expect } from 'vitest';
import { knownTechnicalAnswerReady } from '../src/ai/knownTechnicalAnswer.js';
import type { AgentIntentContract, ToolResult } from '../src/ai/agentManagerContracts.js';
import type { Product, VerifiedProductFact } from '../src/shared/types.js';

function fixture() {
  return {
    intent: { grounding: { taskType: 'technical_answer', responseMode: 'answer', sourcePolicy: 'catalog_required',
      technicalAttributes: ['вес'], buyerRequestedWeb: false }, toolRequests: [{ tool: 'catalog.getProductDetails' }] } as AgentIntentContract,
    products: [{ id: 'model-a', name: 'Exact model A', specs: { Масса: '70 кг' } }] as Product[],
    facts: [] as VerifiedProductFact[], conflicts: [] as VerifiedProductFact[]
  };
}
describe('known technical evidence path', () => {
  it.each(['weight_kg','working_weight_kg','working_mass_kg'])('accepts planner field %s while keeping transport mass separate',(attribute)=>{
    const f=fixture();f.intent.grounding!.technicalAttributes=[attribute];
    f.products[0].specs={'рабочая масса, кг':'91'};
    expect(knownTechnicalAnswerReady(f)).toBe(true);
    f.intent.grounding!.technicalAttributes=['transport_weight_kg'];
    expect(knownTechnicalAnswerReady(f)).toBe(false);
    f.products[0].specs['транспортный вес. кг']='93';
    expect(knownTechnicalAnswerReady(f)).toBe(true);
  });
  it('requires current independently verified price instead of merely a catalog number',()=>{
    const f=fixture();f.intent.grounding!.technicalAttributes=['price_rub'];
    f.products[0].price=165000;f.products[0].currency='RUB';
    expect(knownTechnicalAnswerReady(f)).toBe(false);
    const proof={productId:'model-a',price:165000,currency:'RUB',status:'verified'};
    const result:ToolResult={requestId:'price',warnings:[],tool:'catalog.getProductDetails',status:'ok',payload:{priceVerifications:[proof]}};
    expect(knownTechnicalAnswerReady({...f,toolResults:[result]})).toBe(true);
    proof.price=160000;
    expect(knownTechnicalAnswerReady({...f,toolResults:[result]})).toBe(false);
  });
  it('allows a complete catalog slot but never infers an absent attribute', () => {
    const f = fixture();
    expect(knownTechnicalAnswerReady(f)).toBe(true);
    f.intent.grounding!.technicalAttributes.push('тип запуска');
    expect(knownTechnicalAnswerReady(f)).toBe(false);
  });
  it('requires matching evidence for every product and exact product-bound memory', () => {
    const f = fixture();
    f.products.push({ id: 'model-b', specs: {} } as Product);
    f.facts.push({ productId: 'model-a', attribute: 'масса', value: '70 кг' } as VerifiedProductFact);
    expect(knownTechnicalAnswerReady(f)).toBe(false);
    f.facts.push({ productId: 'model-b', attribute: 'масса', value: '71 кг' } as VerifiedProductFact);
    expect(knownTechnicalAnswerReady(f)).toBe(true);
    f.conflicts.push(f.facts[1]);
    expect(knownTechnicalAnswerReady(f)).toBe(false);
  });
  it('cannot override planner-requested clarification or web checking', () => {
    const f = fixture();
    f.intent.grounding!.buyerRequestedWeb = true;
    expect(knownTechnicalAnswerReady(f)).toBe(false);
    f.intent.grounding!.buyerRequestedWeb = false;
    f.intent.grounding!.responseMode = 'clarify';
    expect(knownTechnicalAnswerReady(f)).toBe(false);
    f.intent.grounding = undefined;
    expect(knownTechnicalAnswerReady(f)).toBe(false);
  });
});
