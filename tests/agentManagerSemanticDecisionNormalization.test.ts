import { describe, expect, it } from 'vitest';
import {
  AgentIntentContractSchema,
  AgentSemanticDecisionSchema,
  LedgerStateDeltaSchema,
  normalizeAgentIntentContractDraft,
  normalizeLedgerStateDeltaDraft,
  normalizeSemanticDecisionDraft
} from '../src/ai/agentManagerContracts.js';

describe('semantic decision draft normalization', () => {
  it('fills empty planner rationale fields so a greeting does not fail the contract', () => {
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
    const parsed = AgentSemanticDecisionSchema.parse(normalizeSemanticDecisionDraft(draft));
    expect(parsed.ledgerDelta.rationale.length).toBeGreaterThan(0);
    expect(parsed.intent.userMessageSummary.length).toBeGreaterThan(0);
    expect(parsed.intent.dialogueUnderstanding.length).toBeGreaterThan(0);
    expect(parsed.intent.nextStepRationale.length).toBeGreaterThan(0);
    expect(parsed.intent.grounding!.rationale.length).toBeGreaterThan(0);
    expect(parsed.intent.selectionPolicy!.rationale.length).toBeGreaterThan(0);
  });

  it('keeps already valid drafts unchanged', () => {
    const draft = {
      ledgerDelta: { rationale: 'ok', events: [] },
      intent: {
        userMessageSummary: 's',
        dialogueUnderstanding: 'u',
        nextStepRationale: 'n',
        requiresTools: false,
        toolRequests: []
      }
    };
    expect(AgentSemanticDecisionSchema.safeParse(draft).success).toBe(true);
    expect(normalizeSemanticDecisionDraft(draft)).toEqual(draft);
  });

  it('normalizes standalone ledger delta and intent drafts with fallback evidence and tool rationale', () => {
    const delta = LedgerStateDeltaSchema.parse(normalizeLedgerStateDeltaDraft({
      rationale: '',
      events: [{
        eventType: 'fact.observed',
        scope: 'dialogue',
        payload: { factKey: 'x' },
        evidence: '',
        source: 'llm_state_delta',
        status: 'active'
      }]
    }));
    expect(delta.rationale.length).toBeGreaterThan(0);
    expect(delta.events[0]!.evidence.length).toBeGreaterThan(0);

    const intent = AgentIntentContractSchema.parse(normalizeAgentIntentContractDraft({
      userMessageSummary: '',
      dialogueUnderstanding: '',
      nextStepRationale: '',
      requiresTools: true,
      grounding: undefined,
      toolRequests: [{
        id: 'r1',
        tool: 'catalog.search',
        args: {},
        rationale: ''
      }],
      selectionPolicy: undefined
    }));
    expect(intent.toolRequests[0]!.rationale).toContain('catalog.search');
  });
});
