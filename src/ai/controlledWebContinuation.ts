import type { Message } from '../shared/types.js';
import type { ExactMentionPrefetch } from './fullCatalogClient.js';
import type { ControlledRequest, ControlledResponsesClient } from './controlledResponsesClient.js';
import { webStepKey, type SearchReceipt } from './controlledWebSearch.js';
import type { ConversationRepository } from '../db/repositories.js';
import { assertOpenAIUsageBudget, bindOpenAIUsageReservation, currentOpenAIUsageContext, recordOpenAIUsageOnce } from './openaiUsageGuard.js';
import { config } from '../config.js';
import { readCatalogReviewState, reviewContext, reviewDigest, reviewSources, type CatalogReviewState } from './catalogReviewState.js';

export type WebContinuationCheckpoint = { sessionId: string; turnId: string; searchResponseId: string; attempted: boolean; responseId: string | null;
  reservationId: string; plan: ControlledRequest; step?: number };

/** The caller owns the turn lease and supplies the persisted search receipt. */
export async function continueAfterWebSearch(input: { sessionId: string; turnId: string; ownerId: string; message: string;
  history: Message[]; prefetch: ExactMentionPrefetch; receipt: SearchReceipt; priorReceipts?: SearchReceipt[]; classificationIds?: string[];
  catalogReview?: CatalogReviewState; step?: number; signal?: AbortSignal },
  deps: { client: Pick<ControlledResponsesClient, 'prepare' | 'submit' | 'wait'>; conversations: ConversationRepository },
  saved?: WebContinuationCheckpoint) {
  const context = currentOpenAIUsageContext();
  if (!input.ownerId || context.sessionId !== input.sessionId || context.turnId !== input.turnId) throw new Error('Trusted continuation context unavailable');
  let state: WebContinuationCheckpoint;
  if (saved) {
    if ((saved.step ?? 0) !== (input.step ?? 0) || saved.sessionId !== input.sessionId || saved.turnId !== input.turnId || saved.searchResponseId !== input.receipt.responseId || !saved.reservationId ||
      typeof saved.attempted !== 'boolean' || (saved.responseId && !saved.attempted)) throw new Error('Invalid web continuation checkpoint');
    state = structuredClone(saved);
    if (state.plan.review) {
      if (input.catalogReview) readCatalogReviewState(input.catalogReview);
      const history = [...input.history];
      if (history.at(-1)?.role === 'user' && history.at(-1)?.content === input.message) history.pop();
      if (!input.classificationIds || reviewDigest(state.plan.review.context) !== reviewDigest(reviewContext(input.classificationIds, input.prefetch, input.message, history)) ||
          reviewDigest(state.plan.review.sources) !== reviewDigest(reviewSources([...input.priorReceipts ?? [], input.receipt])) ||
          (state.plan.review.base && state.plan.review.base.digest !== input.catalogReview?.digest)) throw new Error('Saved catalog review context changed');
    }
  } else {
    const plan = await deps.client.prepare({ message: input.message, history: input.history, prefetch: input.prefetch,
      webSearchReceipt: input.receipt, priorWebSearchReceipts: input.priorReceipts, classificationIds: input.classificationIds,
      classificationScope: input.message, catalogReview: input.catalogReview, signal: input.signal });
    const reservationId = await assertOpenAIUsageBudget('platform_agent', plan.model, plan.reserveTokens, webStepKey('web_continuation', input.step));
    if (!reservationId) throw new Error('Web continuation reservation unavailable');
    state = { sessionId: input.sessionId, turnId: input.turnId, searchResponseId: input.receipt.responseId, attempted: false, responseId: null, reservationId, plan,
      ...(input.step ? { step: input.step } : {}) };
    await save();
  }
  async function save() {
    await deps.conversations.upsertTurnCheckpoint({ sessionId: input.sessionId, turnId: input.turnId, executionOwner: input.ownerId,
      checkpoint: webStepKey('controlled_web_continuation', input.step), status: 'running', payload: structuredClone(state) });
  }
  if (!state.responseId) {
    if (saved && config.OPENAI_MONETARY_GUARD_ENABLED) throw new Error('Saved monetary submission requires reconciliation');
    if (state.attempted) throw new Error('Web continuation submission outcome is unknown');
    state.attempted = true;
    await save();
    state.responseId = await deps.client.submit(state.plan, webStepKey(`${input.turnId}-web-continuation`, input.step), input.signal);
    if (!state.responseId) throw new Error('Web continuation response identity unavailable');
    await save();
  }
  const result = await deps.client.wait(state.plan, state.responseId, input.signal);
  const usage = { id: result.turnId, usage: result.usage, service_tier: result.service_tier };
  bindOpenAIUsageReservation(usage, state.reservationId);
  await recordOpenAIUsageOnce('platform_agent', result.model, usage);
  return result;
}
