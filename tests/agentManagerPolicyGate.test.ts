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
