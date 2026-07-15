import { describe, expect, it } from 'vitest';
import {
  AssistantFeedbackQueueItemSchema,
  AssistantFeedbackRegressionFixtureSchema,
  buildAssistantFeedbackRegressionCandidate,
  redactFeedbackText,
  serializeAssistantFeedbackRegressionCandidates
} from '../src/ai/assistantFeedbackQueue.js';

const queueItem = {
  id: '11111111-1111-4111-8111-111111111111',
  sessionId: '22222222-2222-4222-8222-222222222222',
  turnId: '33333333-3333-4333-8333-333333333333',
  userMessageId: '44444444-4444-4444-8444-444444444444',
  assistantMessageId: '55555555-5555-4555-8555-555555555555',
  rating: 'wrong_cards' as const,
  status: 'pending' as const,
  buyerMessage: 'Меня зовут Алексей. Телефон +7 900 123-45-67, почта buyer@example.test. Нужна виброплита.',
  assistantAnswer: 'Посмотрите https://example.test/card?visitor=secret и позвоните +7 (495) 000-00-00.',
  policyEvidence: {
    version: 'sales-manager-v3',
    hash: 'policy-hash',
    selectedRuleIds: ['cards-hard-constraints'],
    reviewMode: 'risk',
    reviewReason: 'visible cards'
  },
  modelEvidence: {
    plannerModel: 'gpt-5.6-terra',
    answerModel: 'gpt-5.6-terra',
    reviewerModel: 'gpt-5.6-terra',
    responseIds: ['resp-private-id']
  },
  toolEvidence: [{
    requestId: 'catalog-search-1',
    tool: 'catalog.search',
    status: 'ok' as const,
    warnings: ['contact buyer@example.test was ignored'],
    payload: { query: 'raw payload must not be exported', phone: '+79001234567' }
  }],
  cardEvidence: [{
    productId: 'plate-1',
    name: 'Виброплита 72 кг',
    position: 0,
    price: 50_000,
    currency: 'RUB',
    visible: true,
    sourceUrl: 'https://example.test/card?visitor=secret'
  }],
  diagnosticMetadata: {
    visitorId: 'visitor-private',
    arbitrarySecret: 'must not be exported'
  },
  feedbackCreatedAt: '2026-07-10T12:00:00.000Z',
  createdAt: '2026-07-10T12:00:01.000Z',
  updatedAt: '2026-07-10T12:00:01.000Z'
};

describe('assistant feedback review/eval queue', () => {
  it('accepts only negative review-queue ratings and strict typed evidence', () => {
    expect(AssistantFeedbackQueueItemSchema.parse(queueItem).rating).toBe('wrong_cards');
    expect(() => AssistantFeedbackQueueItemSchema.parse({ ...queueItem, rating: 'positive' })).toThrow();
    expect(() => AssistantFeedbackQueueItemSchema.parse({ ...queueItem, unexpected: true })).toThrow();
    expect(() => AssistantFeedbackQueueItemSchema.parse({
      ...queueItem,
      toolEvidence: [{ ...queueItem.toolEvidence[0], unknown: true }]
    })).toThrow();
  });

  it('redacts known values, email, phone, and URLs without a regex-based exporter', () => {
    const result = redactFeedbackText(
      'Алексей: alex@example.test, +7 900 123-45-67, https://example.test/private',
      ['Алексей']
    );

    expect(result.text).toBe('[PII]: [EMAIL], [PHONE], [URL]');
    expect(result.applied).toEqual(['known_value', 'url', 'email', 'phone']);
  });

  it('exports a PII-reduced wrong-card regression candidate with policy, model, tool, and card evidence', () => {
    const fixture = buildAssistantFeedbackRegressionCandidate(queueItem, { knownPiiValues: ['Алексей'] });
    const serialized = JSON.stringify(fixture);

    expect(AssistantFeedbackRegressionFixtureSchema.parse(fixture)).toEqual(fixture);
    expect(fixture.review).toMatchObject({
      focus: 'card_relevance_and_constraints',
      requiresHumanReview: true
    });
    expect(fixture.redaction).toMatchObject({
      rawDatabaseIdentifiersOmitted: true,
      residualPiiStatus: 'best_effort_redaction_not_verified',
      residualPiiReviewRequired: true
    });
    expect(fixture.runtime.policy.version).toBe('sales-manager-v3');
    expect(fixture.runtime.model.answerModel).toBe('gpt-5.6-terra');
    expect(fixture.runtime.tools[0]).toMatchObject({ tool: 'catalog.search', status: 'ok' });
    expect(fixture.observed.productCards[0]).toMatchObject({ productId: 'plate-1', name: 'Виброплита 72 кг' });
    expect(fixture.input.buyerMessage).toContain('[PII]');
    expect(fixture.input.buyerMessage).toContain('[PHONE]');
    expect(fixture.input.buyerMessage).toContain('[EMAIL]');
    expect(serialized).not.toContain(queueItem.sessionId);
    expect(serialized).not.toContain(queueItem.turnId);
    expect(serialized).not.toContain(queueItem.assistantMessageId);
    expect(serialized).not.toContain('visitor-private');
    expect(serialized).not.toContain('raw payload must not be exported');
    expect(serialized).not.toContain('resp-private-id');
    expect(serialized).not.toContain('buyer@example.test');
    expect(serialized).not.toContain('+7 900 123-45-67');
    expect(serialized).not.toContain('visitor=secret');
  });

  it('uses answer-quality review checks for negative feedback and serializes validated fixtures', () => {
    const fixture = buildAssistantFeedbackRegressionCandidate({ ...queueItem, rating: 'negative' }, {
      knownPiiValues: ['Алексей']
    });
    const serialized = serializeAssistantFeedbackRegressionCandidates([fixture]);
    const parsed = JSON.parse(serialized);

    expect(fixture.review.focus).toBe('answer_quality_and_grounding');
    expect(parsed).toEqual([fixture]);
  });
});
