import { describe, expect, it } from 'vitest';
import type { AgentIntentContract } from '../src/ai/agentManagerContracts.js';
import { evaluateAgentManagerPolicyGate } from '../src/ai/agentManagerPolicyGate.js';

function intent(overrides: Partial<AgentIntentContract> = {}): AgentIntentContract {
  return {
    userMessageSummary: 'buyer turn',
    dialogueUnderstanding: 'typed buyer intent',
    nextStepRationale: 'answer safely',
    requiresTools: false,
    toolRequests: [],
    grounding: {
      taskType: 'technical_answer',
      buyerRequestedWeb: false,
      catalogRequirement: 'none',
      responseMode: 'answer',
      sourcePolicy: 'conversation_only',
      webPurpose: 'none',
      webRequirement: 'none',
      requiredToolKinds: [],
      technicalAttributes: [],
      rationale: 'conversation context is sufficient'
    },
    productMentions: [],
    selectionPolicy: {
      targetProductClass: 'plate',
      canonicalProductClass: 'plate',
      selectionGoal: 'preliminary_fit',
      needAction: 'open',
      alternativePolicy: 'same_class_only',
      reusePreviousCards: false,
      maxCards: null,
      powerSource: 'any',
      phase: 'any',
      requirements: [],
      rankingObjectives: [],
      rationale: 'selection context is retained for the dialogue ledger'
    },
    policyRuleIds: [],
    mustNotAskQuestionIds: [],
    riskFlags: [],
    ...overrides
  };
}

describe('AgentManager policy gate', () => {
  it.each(['product_selection', 'comparison'] as const)('allows conversation-only qualification within %s', (taskType) => {
    const candidate = intent();
    candidate.grounding = { ...candidate.grounding!, taskType, responseMode: 'clarify' };
    const result = evaluateAgentManagerPolicyGate({ intent: candidate });
    expect(result.ok).toBe(true);
    expect(result.requiredActions).toEqual([]);
    expect(result.blockedReasons).toEqual([]);
    expect(result.answerConstraints).toContain('no_unsupported_factual_claims');
  });

  it('does not erase a declared catalog requirement when the current step clarifies', () => {
    const candidate = intent();
    candidate.grounding = { ...candidate.grounding!, taskType: 'product_selection', responseMode: 'clarify', catalogRequirement: 'required' };
    expect(evaluateAgentManagerPolicyGate({ intent: candidate }).blockedReasons).toContain('required_catalog_tool_missing');
  });

  it.each(['technical_answer', 'comparison'] as const)('preserves a web-owned named-model lookup for %s when no separate catalog step was declared', (taskType) => {
    const candidate = intent();
    candidate.requiresTools = true;
    candidate.toolRequests = [{
      id: 'web-facts', tool: 'web.researchProductFacts', required: true,
      args: { productNames: ['MODEL X100'], canonicalProductIntent: 'plate' },
      rationale: 'The web tool resolves model identity and external technical facts.', coversRequirementIds: []
    }];
    candidate.grounding = {
      ...candidate.grounding!, taskType, responseMode: taskType === 'comparison' ? 'compare' : 'answer',
      sourcePolicy: 'web_required', webRequirement: 'independent_required', requiredToolKinds: ['web.researchProductFacts']
    };
    const result = evaluateAgentManagerPolicyGate({ intent: candidate });
    expect(result.ok).toBe(true);
    expect(result.requiredActions).toEqual(['web.researchProductFacts']);
  });

  it('does not require catalog for a conversation-only technical answer', () => {
    const result = evaluateAgentManagerPolicyGate({ intent: intent() });

    expect(result.ok).toBe(true);
    expect(result.requiredActions).toEqual([]);
    expect(result.blockedReasons).toEqual([]);
  });

  it('does not turn a conditional availability handoff into a catalog hard block', () => {
    const result = evaluateAgentManagerPolicyGate({
      intent: intent({
        grounding: {
          taskType: 'availability_or_delivery',
          buyerRequestedWeb: false,
          catalogRequirement: 'conditional',
          responseMode: 'handoff',
          sourcePolicy: 'specialist_required',
          webPurpose: 'none',
          webRequirement: 'none',
          requiredToolKinds: [],
          technicalAttributes: [],
          rationale: 'stock and delivery require an operational check'
        }
      })
    });

    expect(result.ok).toBe(true);
    expect(result.requiredActions).toEqual([]);
    expect(result.blockedReasons).toEqual([]);
  });

  it('still requires catalog for product selection without a catalog tool', () => {
    const result = evaluateAgentManagerPolicyGate({
      intent: intent({
        grounding: {
          taskType: 'product_selection',
          buyerRequestedWeb: false,
          catalogRequirement: 'none',
          responseMode: 'recommend',
          sourcePolicy: 'conversation_only',
          webPurpose: 'none',
          webRequirement: 'none',
          requiredToolKinds: [],
          technicalAttributes: [],
          rationale: 'concrete products require current catalog evidence'
        }
      })
    });

    expect(result.ok).toBe(false);
    expect(result.requiredActions).toEqual(['catalog.search']);
    expect(result.blockedReasons).toEqual(['required_catalog_tool_missing']);
  });
});
