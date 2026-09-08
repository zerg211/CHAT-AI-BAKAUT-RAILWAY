import { describe, expect, it } from 'vitest';
import { continuationValidationIssues, parseContinuationDecision } from '../src/ai/agentManagerContinuation.js';
import { AgentIntentContractSchema, type ToolRequest } from '../src/ai/agentManagerContracts.js';
import { observationDecisionFormatForRequirements, answerContractFormatForEvidenceSources } from '../src/ai/agentManagerOrchestrator.js';

const search = (id: string, query: string): ToolRequest => ({
  id, tool: 'catalog.search', args: { query }, rationale: 'Find a suitable catalog candidate', required: true, coversRequirementIds: []
});
const intent = AgentIntentContractSchema.parse({
  userMessageSummary: 'Find equipment', dialogueUnderstanding: 'A product consultation',
  nextStepRationale: 'Search then evaluate', requiresTools: true, toolRequests: [search('first', 'initial query')]
});
const decision = (toolRequests: ToolRequest[]) => ({
  action: 'continue' as const, rationale: 'Initial catalog result needs a more specific query',
  missingFacts: ['matching model'], candidateProductIds: [], toolRequests
});

describe('observation-driven continuation boundary', () => {
  it('restricts generated candidate identities to the supplied product evidence', () => {
    const productId = '96c772d3-ae4b-4414-9bce-d0ab22a9dc5c';
    const schema = observationDecisionFormatForRequirements([], [productId, productId]).format.schema.properties;
    expect(schema.candidateProductIds).toMatchObject({ items: { type: 'string', enum: [productId] } });
    expect(observationDecisionFormatForRequirements([], []).format.schema.properties.candidateProductIds).toMatchObject({ maxItems: 0 });
  });
  it('restricts writer selection to eligible product IDs, including an empty eligible set', () => {
    const schema = answerContractFormatForEvidenceSources(['source'], ['eligible']).format.schema.properties;
    expect(schema.selectedProductIds.items).toEqual({ type: 'string', enum: ['eligible'] });
    expect(answerContractFormatForEvidenceSources([], []).format.schema.properties.selectedProductIds.maxItems).toBe(0);
  });
  it('allows a new read after an unhelpful initial catalog query', () => {
    expect(continuationValidationIssues({ decision: decision([search('next', 'refined query')]), intent, products: [] })).toEqual([]);
  });
  it('rejects replaying an identical read under a new request id', () => {
    expect(continuationValidationIssues({ decision: decision([search('renamed', 'initial query')]), intent, products: [] }))
      .toContain('continuation_duplicate_read:renamed');
  });
  it('never grants contact capture from observation planning', () => {
    const lead: ToolRequest = { id: 'lead', tool: 'lead.capture', args: {}, rationale: 'handoff', required: true };
    expect(continuationValidationIssues({ decision: decision([lead]), intent, products: [] }))
      .toContain('continuation_tool_not_read_only:lead.capture');
  });
  it('does not allow invented product identities or unknown requirement bindings', () => {
    const next = search('next', 'refined query');
    next.coversRequirementIds = ['invented'];
    const issues = continuationValidationIssues({ decision: { ...decision([next]), candidateProductIds: ['fake'] }, intent, products: [] });
    expect(issues).toContain('continuation_unknown_candidate:fake');
    expect(issues).toContain('continuation_unknown_requirement:invented');
  });
  it('requires actions to match the continuation state', () => {
    expect(() => parseContinuationDecision({ ...decision([]) })).toThrow();
    expect(() => parseContinuationDecision({ ...decision([search('next', 'next')]), action: 'answer' })).toThrow();
    expect(parseContinuationDecision({ ...decision([]), action: 'clarify' }).action).toBe('clarify');
  });
});
