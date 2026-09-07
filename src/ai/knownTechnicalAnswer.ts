import type { AgentIntentContract } from './agentManagerContracts.js';
import type { Product, VerifiedProductFact } from '../shared/types.js';
import { canonicalFactAttribute } from './verifiedFactNormalization.js';

// The planner decides the request's meaning. This gate only establishes that
// every explicitly requested slot is present before skipping a redundant observer.
// Writer and factual/business review remain mandatory.
export function knownTechnicalAnswerReady(input: {
  intent: AgentIntentContract; products: Product[]; facts: VerifiedProductFact[]; conflicts: VerifiedProductFact[];
}) {
  const g = input.intent.grounding;
  if (!g || g.taskType !== 'technical_answer' || g.responseMode !== 'answer' || g.buyerRequestedWeb ||
    g.sourcePolicy !== 'catalog_required' || !g.technicalAttributes.length ||
    !input.products.length || input.conflicts.length || input.intent.leadCaptureAuthorization?.authorized) return false;
  if (input.intent.toolRequests.some(request => request.tool !== 'catalog.getProductDetails')) return false;
  return input.products.every(product => g.technicalAttributes.every(attribute => {
    const key = canonicalFactAttribute(attribute);
    const catalog = Object.entries(product.specs).some(([name,value]) =>
      canonicalFactAttribute(name) === key && value !== null && value !== undefined && String(value).trim() !== '');
    return catalog || input.facts.some(fact => fact.productId === product.id && canonicalFactAttribute(fact.attribute) === key);
  }));
}
