import { describe, it, expect } from 'vitest';
import { knownTechnicalAnswerReady } from '../src/ai/knownTechnicalAnswer.js';
import type { AgentIntentContract } from '../src/ai/agentManagerContracts.js';
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
