import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  run: vi.fn(), query: vi.fn(), transactionQuery: vi.fn(), release: vi.fn(),
  commitMessage: vi.fn(), claim: vi.fn(), releaseLease: vi.fn(), getTurn: vi.fn(), getSession: vi.fn()
}));
vi.mock('../src/config.js', () => ({ config: { OPENAI_API_KEY: 'test', OPENAI_PLATFORM_AGENT_ID: 'agent-test' } }));
vi.mock('../src/db/pool.js', () => ({ pool: { query: state.query, connect: vi.fn(async () => ({ query: state.transactionQuery, release: state.release })) } }));
vi.mock('../src/db/repositories.js', () => ({ ConversationRepository: class {
  addAssistantMessageForTurn = state.commitMessage;
} }));
vi.mock('../src/ai/platformAgentClient.js', () => ({ PlatformAgentClient: class { run = state.run; } }));
vi.mock('../src/ai/openaiUsageGuard.js', () => ({ assertOpenAIUsageBudget: vi.fn(async () => 'reservation'), bindOpenAIUsageReservation: vi.fn(), recordOpenAIUsageOnce: vi.fn(async () => undefined) }));
vi.mock('../src/ai/agentManagerOrchestrator.js', () => ({ TurnExecutionInProgressError: class extends Error {} }));
import { PlatformAgentAssistant } from '../src/ai/platformAgentAssistant.js';
import type { ConversationRepository } from '../src/db/repositories.js';

describe('site chat and platform agent', () => {
  const repo = { getTurn: state.getTurn, getSession: state.getSession, claimTurnExecution: state.claim, releaseTurnExecution: state.releaseLease } as unknown as ConversationRepository;
  beforeEach(() => {
    vi.clearAllMocks();
    state.getTurn.mockResolvedValue(null);
    state.getSession.mockResolvedValue({ id: 'chat', status: 'active', needState: {} });
    state.claim.mockResolvedValue({ id: 'turn' });
    state.releaseLease.mockResolvedValue(null);
    state.query.mockResolvedValue({ rows: [{ agent_session_id: 'agent-session', next_cursor: 'cursor-1', seen_product_ids: ['old'] }] });
    state.transactionQuery.mockResolvedValue({ rows: [], rowCount: 1 });
    state.commitMessage.mockResolvedValue({ id: 'assistant-message' });
  });
  it('uses the saved cursor, records the page and returns cards from the agent answer', async () => {
    const url = 'https://bakautprof.ru/catalog/item/';
    state.run.mockResolvedValue({ sessionId: 'agent-session', turnId: 'agent-turn', pageCursor: 'cursor-1',
      answer: JSON.stringify({ answer: 'Подходит', selected: ['new'], rejected: [], uncertain: [] }), usage: { total_tokens: 100 }, page: { has_more: true, next_cursor: 'cursor-2',
        items: [{ product_id: 'new', name: 'Товар', url, price_rub: 9000 }] } });
    const answer = await new PlatformAgentAssistant(repo).generateAnswer({ sessionId: 'chat', turnId: 'turn', userMessage: 'ещё', catalogPage: true });
    expect(state.run.mock.calls[0][0]).toMatchObject({ sessionId: 'agent-session', idempotencyKey: 'turn' });
    expect(state.run.mock.calls[0][0].message).toContain('cursor-1');
    expect(answer.productCards.map((card) => card.id)).toEqual(['new']);
    expect(answer.cardDisplay?.hasMore).toBe(true);
    expect(state.transactionQuery).toHaveBeenCalledWith(expect.stringContaining('UPDATE platform_agent_sessions'), ['chat', 'cursor-2', '["old","new"]']);
    expect(state.commitMessage).toHaveBeenCalledOnce();
  });
  it('rejects a page if the agent did not use the stored cursor', async () => {
    state.run.mockResolvedValue({ sessionId: 'agent-session', turnId: 'agent-turn', pageCursor: 'other', answer: '{}', page: { items: [] } });
    await expect(new PlatformAgentAssistant(repo).generateAnswer({ sessionId: 'chat', turnId: 'turn', userMessage: 'ещё', catalogPage: true })).rejects.toThrow('requested catalog cursor');
    expect(state.commitMessage).not.toHaveBeenCalled();
  });
  it('does not publish a repeated product as a new page', async () => {
    state.run.mockResolvedValue({ sessionId: 'agent-session', turnId: 'agent-turn', pageCursor: 'cursor-1', answer: JSON.stringify({ answer: 'Ответ', selected: ['old'], rejected: [], uncertain: [] }),
      page: { items: [{ product_id: 'old', name: 'Товар', url: 'https://bakautprof.ru/catalog/item/' }] } });
    await expect(new PlatformAgentAssistant(repo).generateAnswer({ sessionId: 'chat', turnId: 'turn', userMessage: 'ещё', catalogPage: true })).rejects.toThrow('Duplicate catalog product page');
    expect(state.commitMessage).not.toHaveBeenCalled();
  });
  it('uses the catalog URL for a selected product even if the prose has a malformed link', async () => {
    const url = 'https://bakautprof.ru/catalog/generator_a_ipower_a5500/';
    state.run.mockResolvedValue({ sessionId: 'agent-session', turnId: 'agent-turn', pageCursor: 'cursor-1',
      answer: JSON.stringify({ answer: '[A5500](https://bakautprof.ru/catalog/broken link/) артикул 20105', selected: ['new'], rejected: [], uncertain: [] }),
      page: { has_more: false, items: [{ product_id: 'new', name: 'Генератор A5500', sku: '20105', url }] } });
    const answer = await new PlatformAgentAssistant(repo).generateAnswer({ sessionId: 'chat', turnId: 'turn', userMessage: 'ещё', catalogPage: true });
    expect(answer.productCards.map((card) => card.sourceUrl)).toEqual([url]);
    expect(answer.answer).toContain(`](${url})`);
  });
  it('never presents a rejected item as suitable even when the answer links to it', async () => {
    const url = 'https://bakautprof.ru/catalog/plate/';
    state.run.mockResolvedValue({ sessionId: 'agent-session', turnId: 'agent-turn', pageCursor: 'cursor-1',
      answer: JSON.stringify({ answer: `Не подходит ${url}`, selected: [], rejected: ['new'], uncertain: [] }),
      page: { items: [{ product_id: 'new', name: 'Виброплита 5100024696', sku: '5100024696', url }] } });
    const answer = await new PlatformAgentAssistant(repo).generateAnswer({ sessionId: 'chat', turnId: 'turn', userMessage: 'ещё', catalogPage: true });
    expect(answer.productCards).toEqual([]);
  });
  it('refuses an incomplete classification without advancing the cursor', async () => {
    state.run.mockResolvedValue({ sessionId: 'agent-session', turnId: 'agent-turn', pageCursor: 'cursor-1',
      answer: JSON.stringify({ answer: 'Ответ', selected: [], rejected: [], uncertain: [] }),
      page: { items: [{ product_id: 'new', name: 'Товар', url: 'https://bakautprof.ru/catalog/item/' }] } });
    await expect(new PlatformAgentAssistant(repo).generateAnswer({ sessionId: 'chat', turnId: 'turn', userMessage: 'ещё', catalogPage: true })).rejects.toThrow('does not account');
    expect(state.transactionQuery).not.toHaveBeenCalled();
  });
});
