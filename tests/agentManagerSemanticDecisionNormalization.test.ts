import { describe, expect, it } from 'vitest';

import {
  AgentIntentContractSchema,
  AgentSemanticDecisionSchema,
  LedgerStateDeltaSchema
} from '../src/ai/agentManagerContracts.js';

describe('strict semantic decision contracts', () => {
  it('rejects blank planner semantics instead of filling canned defaults', () => {
    const draft = {
      ledgerDelta: { rationale: '', events: [] },
      intent: {
        userMessageSummary: '',
        dialogueUnderstanding: '   ',
        nextStepRationale: '',
        requiresTools: false,
        toolRequests: [],
        grounding: {
          taskType: 'offtopic',
          sourcePolicy: 'conversation_only',
          webPurpose: 'none',
          requiredToolKinds: [],
          technicalAttributes: [],
          rationale: ''
        },
        selectionPolicy: {
          targetProductClass: null,
          canonicalProductClass: null,
          needAction: 'none',
          alternativePolicy: 'unknown',
          reusePreviousCards: false,
          maxCards: null,
          powerSource: null,
          phase: null,
          requirements: [],
          rationale: ''
        },
        policyRuleIds: [],
        mustNotAskQuestionIds: [],
        riskFlags: []
      }
    };

    expect(AgentSemanticDecisionSchema.safeParse(draft).success).toBe(false);
  });

  it('rejects missing ledger evidence and tool rationale', () => {
    expect(LedgerStateDeltaSchema.safeParse({
      rationale: '',
      events: [{
        eventType: 'fact.observed',
        scope: 'dialogue',
        payload: { factKey: 'x' },
        evidence: '',
        source: 'llm_state_delta',
        status: 'active'
      }]
    }).success).toBe(false);

    expect(AgentIntentContractSchema.safeParse({
      userMessageSummary: 'buyer asks for generator candidates',
      dialogueUnderstanding: 'the buyer supplied enough context for a preliminary catalog search',
      nextStepRationale: 'search the generator catalog',
      requiresTools: true,
      toolRequests: [{
        id: 'catalog-search',
        tool: 'catalog.search',
        args: { query: 'generators' },
        rationale: '',
        required: true
      }],
      mustNotAskQuestionIds: [],
      riskFlags: []
    }).success).toBe(false);
  });

  it('treats blank optional tool arguments as omitted', () => {
    const intent = AgentIntentContractSchema.parse({
      userMessageSummary: 'buyer asks for generator candidates',
      dialogueUnderstanding: 'the buyer supplied enough context for a preliminary catalog search',
      nextStepRationale: 'search the generator catalog',
      requiresTools: true,
      toolRequests: [{
        id: 'catalog-search',
        tool: 'catalog.search',
        args: {
          query: 'generators',
          reason: '',
          notes: '   '
        },
        rationale: 'search the current catalog',
        required: true
      }],
      mustNotAskQuestionIds: [],
      riskFlags: []
    });

    expect(intent.toolRequests[0]!.args.reason).toBeUndefined();
    expect(intent.toolRequests[0]!.args.notes).toBeUndefined();
  });
});
