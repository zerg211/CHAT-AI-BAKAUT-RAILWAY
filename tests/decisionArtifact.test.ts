import { describe, expect, it } from 'vitest';
import { AgentIntentContractSchema, type AnswerContract, type ToolResult } from '../src/ai/agentManagerContracts.js';
import { buildDecisionArtifact, DECISION_LOOP_STAGES } from '../src/ai/decisionArtifact.js';

const intent = AgentIntentContractSchema.parse({
  userMessageSummary: 'Нужен генератор',
  dialogueUnderstanding: 'Покупатель выбирает генератор',
  nextStepRationale: 'Проверить каталог',
  requiresTools: true,
  toolRequests: [{
    id: 'catalog-1',
    tool: 'catalog.search',
    args: { query: 'генератор', semanticQuery: null, productIntent: 'generator', canonicalProductIntent: 'generator', powerSource: 'any', phase: 'any', limit: 4, comparisonAttributes: [], reason: 'подбор', notes: null },
    rationale: 'Проверить товары',
    required: true
  }],
  productMentions: [],
  grounding: {
    taskType: 'product_selection',
    buyerRequestedWeb: false,
    catalogRequirement: 'required',
    responseMode: 'recommend',
    sourcePolicy: 'catalog_required',
    webPurpose: 'none',
    webRequirement: 'none',
    requiredToolKinds: ['catalog.search'],
    technicalAttributes: [],
    rationale: 'Нужен каталог'
  },
  policyRuleIds: [],
  mustNotAskQuestionIds: [],
  riskFlags: []
});

const answer: AnswerContract = {
  answerText: 'Нужны уточнения по мощности.',
  factsUsed: [{ factKey: 'product_class', sourceEventIds: ['event-1'], value: 'generator' }],
  questionsAsked: [],
  toolResultIds: [],
  selectedProductIds: [],
  selectionRationale: null,
  leadAction: 'none',
  riskFlags: [],
  selectionReadiness: {
    productClass: 'generator',
    status: 'needs_more_info',
    canShowProductCards: false,
    missingFacts: ['пусковая нагрузка'],
    rationale: 'Нужно уточнение'
  }
};

const toolResult: ToolResult = {
  requestId: 'catalog-1',
  tool: 'catalog.search',
  status: 'ok',
  observationStatus: 'success',
  payload: { products: [] },
  warnings: []
};

describe('decision artifact', () => {
  it('records the bounded loop, evidence references, blockers and consent state', () => {
    const artifact = buildDecisionArtifact({
      intent,
      toolResults: [toolResult],
      answer,
      policyGate: { ok: true, blockedReasons: [], requiredActions: ['catalog.search'] },
      review: { verdict: 'pass', issues: [] }
    });

    expect(artifact.loop).toEqual([...DECISION_LOOP_STAGES]);
    expect(artifact.knownFacts).toContain('tool:catalog-1:success');
    expect(artifact.blockingUnknowns).toContain('пусковая нагрузка');
    expect(artifact.selectedAction).toBe('recommend');
    expect(artifact.requiredConsent).toBe('none');
    expect(artifact.risk).toBe('medium');
    expect(artifact.rationale).toContain('blockers=1');
  });

  it('requires buyer consent before an unauthorised lead action', () => {
    const leadAnswer = { ...answer, leadAction: 'offer_form' as const, selectionReadiness: undefined };
    const artifact = buildDecisionArtifact({
      intent,
      toolResults: [],
      answer: leadAnswer,
      policyGate: { ok: true, blockedReasons: [], requiredActions: [] },
      review: { verdict: 'pass', issues: [] }
    });

    expect(artifact.requiredConsent).toBe('buyer');
    expect(artifact.stopCondition).toBe('stop_before_contact_capture_without_buyer_authorization');
  });
});
