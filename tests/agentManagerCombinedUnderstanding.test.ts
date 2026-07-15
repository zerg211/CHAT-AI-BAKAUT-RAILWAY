import { beforeEach, describe, expect, it, vi } from 'vitest';

const createStructuredJsonResponse = vi.hoisted(() => vi.fn());

vi.mock('../src/ai/openaiStructured.js', () => ({
  createStructuredJsonResponse
}));

import { OpenAIAgentManagerModel } from '../src/ai/agentManagerOrchestrator.js';
import { reduceDialogueLedger } from '../src/ai/dialogueLedgerReducer.js';
import { emptyNeedState } from '../src/ai/needState.js';
import type { ConversationSession, Message } from '../src/shared/types.js';

describe('OpenAIAgentManagerModel combined understanding', () => {
  beforeEach(() => {
    createStructuredJsonResponse.mockReset();
  });

  it('returns both contracts from one structured Responses call and includes redacted pending draft context', async () => {
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
    const ledgerDelta = {
      rationale: 'the reply continues the pending handoff',
      events: []
    };
    const intentContract = {
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
    createStructuredJsonResponse.mockResolvedValueOnce({
      parsed: { ledgerDelta, intentContract }
    });
    const model = new OpenAIAgentManagerModel();

    const result = await model.understandTurn({
      session,
      history,
      userMessage: history[0]!.content,
      ledgerEvents: [],
      ledgerState: reduceDialogueLedger([]),
      pendingLeadCaptureDraft: {
        id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        purpose: 'confirm a technical fact',
        buyerQuestion: 'Can you confirm the technical fact?',
        preferredContact: 'message',
        hasName: false,
        hasPhone: true,
        hasEmail: false,
        missingFields: ['name'],
        expiresAt: now
      }
    });

    expect(result).toEqual({ ledgerDelta, intentContract });
    expect(createStructuredJsonResponse).toHaveBeenCalledTimes(1);
    const call = createStructuredJsonResponse.mock.calls[0]![0] as {
      stage?: string;
      request?: { input?: Array<{ role?: string; content?: string }>; text?: { format?: { name?: string } } };
    };
    expect(call.stage).toBe('agent_turn_understanding');
    expect(call.request?.text?.format?.name).toBe('agent_turn_understanding');
    const userInput = JSON.parse(call.request?.input?.find((item) => item.role === 'user')?.content ?? '{}') as {
      pendingLeadCaptureDraft?: Record<string, unknown>;
    };
    expect(userInput.pendingLeadCaptureDraft).toMatchObject({
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      purpose: 'confirm a technical fact',
      buyerQuestion: 'Can you confirm the technical fact?',
      hasName: false,
      hasPhone: true,
      missingFields: ['name']
    });
    expect(userInput.pendingLeadCaptureDraft).not.toHaveProperty('phone');
  });
});
