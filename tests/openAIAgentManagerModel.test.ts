import { beforeEach, describe, expect, it, vi } from 'vitest';

const createStructuredJsonResponse = vi.hoisted(() => vi.fn());

vi.mock('../src/ai/openaiStructured.js', () => ({
  createStructuredJsonResponse
}));

import { OpenAIAgentManagerModel } from '../src/ai/agentManagerOrchestrator.js';
import { reduceDialogueLedger } from '../src/ai/dialogueLedgerReducer.js';
import { emptyNeedState } from '../src/ai/needState.js';
import type { AgentIntentContract } from '../src/ai/agentManagerContracts.js';
import type { ConversationSession, Message } from '../src/shared/types.js';

describe('OpenAIAgentManagerModel semantic inputs', () => {
  beforeEach(() => {
    createStructuredJsonResponse.mockReset();
  });

  it('serializes the same redacted pending lead draft for the parallel reducer and planner', async () => {
    const now = new Date('2026-07-15T10:00:00.000Z').toISOString();
    const session: ConversationSession = {
      id: '11111111-1111-4111-8111-111111111111',
      status: 'active',
      conversationNumber: 1,
      title: 'Dialog #1',
      needState: emptyNeedState(),
      createdAt: now,
      updatedAt: now,
      lastHeartbeatAt: now
    };
    const history: Message[] = [{
      id: '22222222-2222-4222-8222-222222222222',
      sessionId: session.id,
      role: 'user',
      content: 'Алексей, лучше напишите.',
      metadata: {},
      createdAt: now
    }];
    const pendingLeadCaptureDraft = {
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      purpose: 'confirm a technical fact',
      buyerQuestion: 'Can you confirm the technical fact?',
      preferredContact: 'message' as const,
      hasName: false,
      hasPhone: true,
      hasEmail: false,
      missingFields: ['name' as const],
      expiresAt: now
    };
    const pendingExhaustedTechnicalHandoffs = [{
      handoffOfferMessageId: '33333333-3333-4333-8333-333333333333',
      buyerQuestion: 'Can you confirm the technical fact?',
      technicalAttributes: ['electric start'],
      sourceAttemptTiers: ['catalog', 'official_page', 'official_manual', 'reliable_secondary'] as const,
      offeredAt: now
    }];
    const intentContract: AgentIntentContract = {
      turnId: null,
      userMessageSummary: 'buyer supplied the missing name and preferred contact method',
      dialogueUnderstanding: 'continue the same pending technical handoff',
      nextStepRationale: 'capture the pending draft with current-message evidence',
      requiresTools: false,
      toolRequests: [],
      productMentions: [],
      selectionPolicy: {
        targetProductClass: null,
        canonicalProductClass: null,
        selectionGoal: 'browse_catalog',
        needAction: 'continue',
        alternativePolicy: 'unknown',
        reusePreviousCards: false,
        maxCards: 0,
        powerSource: null,
        phase: null,
        requirements: [],
        rationale: 'no product selection in this turn'
      },
      leadCaptureAuthorization: {
        authorized: false,
        contactSource: 'none',
        handoffKind: 'none',
        purpose: null,
        buyerQuestion: null,
        evidence: null,
        pendingDraftId: null
      },
      policyRuleIds: [],
      grounding: {
        taskType: 'lead_handoff',
        sourcePolicy: 'conversation_only',
        webPurpose: 'none',
        requiredToolKinds: [],
        technicalAttributes: [],
        rationale: 'the pending draft is trusted session state'
      },
      mustNotAskQuestionIds: [],
      riskFlags: []
    };
    createStructuredJsonResponse
      .mockResolvedValueOnce({ parsed: { rationale: 'continue the pending handoff', events: [] } })
      .mockResolvedValueOnce({ parsed: intentContract });
    const model = new OpenAIAgentManagerModel();
    const ledgerState = reduceDialogueLedger([]);

    await model.proposeLedgerDelta({
      session,
      history,
      userMessage: history[0]!.content,
      ledgerEvents: [],
      ledgerState,
      pendingLeadCaptureDraft,
      pendingExhaustedTechnicalHandoffs: pendingExhaustedTechnicalHandoffs.map((context) => ({
        ...context,
        sourceAttemptTiers: [...context.sourceAttemptTiers]
      }))
    });
    await model.planTurn({
      session,
      history,
      userMessage: history[0]!.content,
      ledgerEvents: [],
      ledgerState,
      pendingLeadCaptureDraft,
      pendingExhaustedTechnicalHandoffs: pendingExhaustedTechnicalHandoffs.map((context) => ({
        ...context,
        sourceAttemptTiers: [...context.sourceAttemptTiers]
      }))
    });

    expect(createStructuredJsonResponse).toHaveBeenCalledTimes(2);
    expect(createStructuredJsonResponse.mock.calls.map((call) => call[0]?.stage)).toEqual([
      'agent_ledger_delta',
      'agent_intent_contract'
    ]);
    for (const call of createStructuredJsonResponse.mock.calls) {
      const request = call[0]?.request as { input?: Array<{ role?: string; content?: string }> } | undefined;
      const userInput = JSON.parse(
        request?.input?.find((item) => item.role === 'user')?.content ?? '{}'
      ) as {
        pendingLeadCaptureDraft?: Record<string, unknown>;
        pendingExhaustedTechnicalHandoffs?: unknown;
      };
      expect(userInput.pendingLeadCaptureDraft).toEqual(pendingLeadCaptureDraft);
      expect(userInput.pendingLeadCaptureDraft).not.toHaveProperty('phone');
      expect(userInput.pendingLeadCaptureDraft).not.toHaveProperty('email');
      if (call[0]?.stage === 'agent_intent_contract') {
        expect(userInput.pendingExhaustedTechnicalHandoffs).toEqual(pendingExhaustedTechnicalHandoffs);
      }
    }
    const plannerCall = createStructuredJsonResponse.mock.calls.find((call) => call[0]?.stage === 'agent_intent_contract');
    const plannerRequest = plannerCall?.[0]?.request as { input?: Array<{ role?: string; content?: string }> } | undefined;
    const plannerPrompt = plannerRequest?.input?.find((item) => item.role === 'system')?.content ?? '';
    expect(plannerPrompt).toContain('Обычное упоминание поверхности или материала работы');
    expect(plannerPrompt).toContain('не должно создавать strict hard requirement');
    expect(plannerPrompt).toContain('выдуманную совместимость/аксессуар');
  });
});
