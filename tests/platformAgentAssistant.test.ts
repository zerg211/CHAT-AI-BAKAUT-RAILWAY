import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  price: vi.fn(), history: vi.fn(), run: vi.fn(), wait: vi.fn(), settle: vi.fn(), submit: vi.fn(), full: vi.fn(), checkpoints: vi.fn(), renew: vi.fn(), query: vi.fn(), transactionQuery: vi.fn(), release: vi.fn(),
  commitMessage: vi.fn(), listMessages: vi.fn(), claim: vi.fn(), releaseLease: vi.fn(), getTurn: vi.fn(), getSession: vi.fn()
}));
vi.mock('../src/config.js', () => ({ config: { OPENAI_API_KEY: 'test', OPENAI_PLATFORM_AGENT_ID: 'agent-test' } }));
vi.mock('../src/db/pool.js', () => ({ pool: { query: state.query, connect: vi.fn(async () => ({ query: state.transactionQuery, release: state.release })) } }));
vi.mock('../src/db/repositories.js', () => ({ ConversationRepository: class {
  addAssistantMessageForTurn = state.commitMessage;
} }));
vi.mock('../src/ai/platformAgentClient.js', () => ({ PlatformAgentClient: class { run = state.run; findHistoricalCandidates = state.history; waitForTurn = state.wait; settleAtDeadline = state.settle; submitMessage = state.submit; } }));
vi.mock('../src/catalog/currentSitePrice.js', () => ({ readSitePriceObservation: state.price }));
vi.mock('../src/ai/fullCatalogClient.js', () => ({ readFullCatalogSnapshot: state.full }));
vi.mock('../src/ai/openaiUsageGuard.js', () => ({ assertOpenAIUsageBudget: vi.fn(async () => 'reservation'), bindOpenAIUsageReservation: vi.fn(), recordOpenAIUsageOnce: vi.fn(async () => undefined) }));
vi.mock('../src/ai/agentManagerOrchestrator.js', () => ({ TurnExecutionInProgressError: class extends Error {} }));
import { PlatformAgentAssistant } from '../src/ai/platformAgentAssistant.js';
import { config } from '../src/config.js';
import type { ConversationRepository } from '../src/db/repositories.js';

describe('site chat and platform agent', () => {
  const repo = { listMessages: state.listMessages, getTurn: state.getTurn, getSession: state.getSession, claimTurnExecution: state.claim, releaseTurnExecution: state.releaseLease, upsertTurnCheckpoint: vi.fn(async () => undefined), listTurnCheckpoints: state.checkpoints, renewTurnExecution: state.renew } as unknown as ConversationRepository;
  beforeEach(() => {
    vi.clearAllMocks();
    state.price.mockImplementation(async (product: { id: string }) => ({ status: 'unknown', productId: product.id }));
    state.listMessages.mockResolvedValue([]);
    state.history.mockResolvedValue([]);
    state.getTurn.mockResolvedValue(null);
    state.getSession.mockResolvedValue({ id: 'chat', status: 'active', needState: {} });
    state.claim.mockResolvedValue({ id: 'turn' });
    state.releaseLease.mockResolvedValue(null);
    state.renew.mockResolvedValue({ id: 'turn' });
    state.checkpoints.mockResolvedValue([]);
    state.query.mockResolvedValue({ rows: [{ agent_session_id: 'agent-session', next_cursor: 'cursor-1', seen_product_ids: ['old'] }] });
    state.transactionQuery.mockResolvedValue({ rows: [], rowCount: 1 });
    state.commitMessage.mockResolvedValue({ id: 'assistant-message' });
  });
  it('retries an undisplayed selection with a new catalog search and shows only the new checked result', async () => {
    state.run
      .mockResolvedValueOnce({ sessionId: 'agent-session', turnId: 'failed-list',
        answer: JSON.stringify({ answer: 'Старый список', selected: ['unshown'], rejected: [], uncertain: [] }) })
      .mockResolvedValueOnce({ sessionId: 'agent-session', turnId: 'fresh-list',
        page: { items: [{ product_id: 'fresh', name: 'Проверенный товар', price_rub: 100 }] },
        answer: JSON.stringify({ answer: 'Новый результат', selected: ['fresh'], rejected: [], uncertain: [] }) });
    const answer = await new PlatformAgentAssistant(repo).generateAnswer({ sessionId: 'chat', turnId: 'turn', userMessage: 'Найди диск' });
    expect(state.run).toHaveBeenCalledTimes(2);
    expect(state.run.mock.calls[1][0]).toMatchObject({ sessionId: 'agent-session', idempotencyKey: 'turn-catalog-retry' });
    expect(state.run.mock.calls[1][0].message).toContain('заново вызови search_products');
    expect(answer.answer).toBe('Новый результат');
    expect(answer.productCards.map((card) => card.id)).toEqual(['fresh']);
  });
  it('refreshes a shown selection after the catalog revision changes', async () => {
    Object.assign(config, { BAKAUT_CATALOG_URL: 'https://catalog-search-production.up.railway.app' });
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ status: 'ok', revision: 'new-revision' }) })));
    state.listMessages.mockResolvedValue([{ metadata: { catalogRevision: 'old-revision', productCards: [
      { id: 'shown', name: 'Товар', price: 100, specs: {}, currency: 'RUB' }
    ] } }]);
    state.run
      .mockResolvedValueOnce({ sessionId: 'agent-session', turnId: 'old-result',
        answer: JSON.stringify({ answer: 'Старые данные', selected: ['shown'], rejected: [], uncertain: [] }) })
      .mockResolvedValueOnce({ sessionId: 'agent-session', turnId: 'fresh-result',
        page: { source_revision: 'new-revision', items: [{ product_id: 'shown', name: 'Товар', price_rub: 120 }] },
        answer: JSON.stringify({ answer: 'Актуальные данные', selected: ['shown'], rejected: [], uncertain: [] }) });
    try {
      const answer = await new PlatformAgentAssistant(repo).generateAnswer({ sessionId: 'chat', turnId: 'turn', userMessage: 'Подойдёт этот?' });
      expect(answer.answer).toBe('Актуальные данные');
      expect(answer.productCards[0].price).toBe(120);
      expect(state.run).toHaveBeenCalledTimes(2);
    } finally {
      Object.assign(config, { BAKAUT_CATALOG_URL: undefined });
      vi.unstubAllGlobals();
    }
  });
  it('keeps shown products in a follow-up when the catalog revision has not changed', async () => {
    Object.assign(config, { BAKAUT_CATALOG_URL: 'https://catalog-search-production.up.railway.app' });
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ status: 'ok', revision: 'same' }) })));
    state.listMessages.mockResolvedValue([{ metadata: { catalogRevision: 'same', productCards: [
      { id: 'shown', name: 'Товар', price: 100, specs: {}, currency: 'RUB' }
    ] } }]);
    state.run.mockResolvedValue({ sessionId: 'agent-session', turnId: 'follow-up',
      answer: JSON.stringify({ answer: 'Из показанных — этот.', selected: ['shown'], rejected: [], uncertain: [] }) });
    try {
      const answer = await new PlatformAgentAssistant(repo).generateAnswer({ sessionId: 'chat', turnId: 'turn', userMessage: 'Какой дешевле?' });
      expect(answer.productCards.map((card) => card.id)).toEqual(['shown']);
      expect(state.run).toHaveBeenCalledOnce();
    } finally {
      Object.assign(config, { BAKAUT_CATALOG_URL: undefined });
      vi.unstubAllGlobals();
    }
  });
  it('preloads all verified catalog matches without asking the model to list product IDs', async () => {
    const first = { items: [{ product_id: 'p1', name: 'Товар 1' }], count: 2 };
    state.run.mockResolvedValue({ sessionId: 'agent-session', turnId: 'agent-turn', page: first,
      answer: JSON.stringify({ answer: 'Найдено два товара', selected: ['__ALL_CATALOG_MATCHES__'], rejected: [], uncertain: [] }) });
    state.full.mockResolvedValue({ ...first, items: [{ product_id: 'p1', name: 'Товар 1' }, { product_id: 'p2', name: 'Товар 2' }] });
    const answer = await new PlatformAgentAssistant(repo).generateAnswer({ sessionId: 'chat', turnId: 'turn', userMessage: 'Подберите генератор' });
    expect(state.full).toHaveBeenCalledOnce();
    expect(answer.productCards.map((item) => item.id)).toEqual(['p1', 'p2']);
  });
  it('saves the original completed response when the deadline races completion', async () => {
    const controller = new AbortController();
    state.run.mockImplementation(async (input: { onBeforeSubmit: (id: string, prev: string, submitted: boolean, text: string) => Promise<void> }) => {
      await input.onBeforeSubmit('agent-session', 'old-turn', true, 'Запрос');
      controller.abort();
      throw new Error('deadline');
    });
    state.settle.mockResolvedValue({ sessionId: 'agent-session', turnId: 'new-turn', answer: JSON.stringify({ answer: 'Готово', selected: [], rejected: [], uncertain: [] }) });
    const answer = await new PlatformAgentAssistant(repo).generateAnswer({ sessionId: 'chat', turnId: 'turn', userMessage: 'Запрос', signal: controller.signal });
    expect(answer.answer).toBe('Готово');
    expect(state.settle).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'agent-session', previousTurnId: 'old-turn' }));
    expect(state.run).toHaveBeenCalledOnce();
  });
  it('does not recover an explicitly cancelled turn', async () => {
    state.getTurn.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'turn', errorCode: 'cancelled_by_user' });
    await expect(new PlatformAgentAssistant(repo).recoverTurn({ sessionId: 'chat', turnId: 'turn' })).rejects.toThrow('cancelled');
    expect(state.wait).not.toHaveBeenCalled();
    expect(state.submit).not.toHaveBeenCalled();
  });
  it('recovers the already submitted agent turn without sending another message', async () => {
    const url = 'https://bakautprof.ru/catalog/item/';
    state.getTurn.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'turn', status: 'answering', deadlineAt: new Date(Date.now() + 60_000).toISOString() });
    state.checkpoints.mockResolvedValue([{ checkpoint: 'platform_agent_submission', payload: { agentSessionId: 'agent-session', previousTurnId: 'turn-before', reservation: 'reservation' } }]);
    state.wait.mockResolvedValue({ sessionId: 'agent-session', turnId: 'agent-turn', answer: JSON.stringify({ answer: 'Подходит', selected: ['new'], rejected: [], uncertain: [] }),
      usage: { total_tokens: 100 }, page: { items: [{ product_id: 'new', name: 'Товар', url, price_rub: 9000 }] } });
    const answer = await new PlatformAgentAssistant(repo).recoverTurn({ sessionId: 'chat', turnId: 'turn' });
    expect(state.wait).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'agent-session', previousTurnId: 'turn-before' }));
    expect(state.run).not.toHaveBeenCalled();
    expect(answer.productCards.map((card) => card.id)).toEqual(['new']);
    expect(state.commitMessage).toHaveBeenCalledWith(expect.objectContaining({ recovered: true }));
  });
  it('retries only the uncertain submission with the saved idempotency key and exact text', async () => {
    state.getTurn.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'turn', status: 'answering', deadlineAt: new Date(Date.now() + 60_000).toISOString() });
    state.checkpoints.mockResolvedValue([{ checkpoint: 'platform_agent_submission', payload: { agentSessionId: 'agent-session', previousTurnId: 'turn-before', submitted: false, submittedText: 'Точный сохранённый ввод' } }]);
    state.wait.mockResolvedValue({ sessionId: 'agent-session', turnId: 'agent-turn', answer: JSON.stringify({ answer: 'Готово', selected: [], rejected: [], uncertain: [] }) });
    await new PlatformAgentAssistant(repo).recoverTurn({ sessionId: 'chat', turnId: 'turn' });
    expect(state.submit).toHaveBeenCalledWith('agent-session', 'Точный сохранённый ввод', 'turn', undefined);
    expect(state.run).not.toHaveBeenCalled();
  });
  it('recovers a catalog retry with its own idempotency key', async () => {
    state.getTurn.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'turn', status: 'answering', deadlineAt: new Date(Date.now() + 60_000).toISOString() });
    state.checkpoints.mockResolvedValue([{ checkpoint: 'platform_agent_submission', payload: {
      agentSessionId: 'agent-session', previousTurnId: 'first-attempt', submitted: false,
      submittedText: 'Повторный поиск', idempotencyKey: 'turn-catalog-retry'
    } }]);
    state.wait.mockResolvedValue({ sessionId: 'agent-session', turnId: 'retry', page: { items: [] },
      answer: JSON.stringify({ answer: 'Ничего не найдено', selected: [], rejected: [], uncertain: [] }) });
    await new PlatformAgentAssistant(repo).recoverTurn({ sessionId: 'chat', turnId: 'turn' });
    expect(state.submit).toHaveBeenCalledWith('agent-session', 'Повторный поиск', 'turn-catalog-retry', undefined);
  });
  it('uses the catalog URL for a selected product even if the prose has a malformed link', async () => {
    const url = 'https://bakautprof.ru/catalog/generator_a_ipower_a5500/';
    state.run.mockResolvedValue({ sessionId: 'agent-session', turnId: 'agent-turn', pageCursor: 'cursor-1',
      answer: JSON.stringify({ answer: '[A5500](https://bakautprof.ru/catalog/broken link/) артикул 20105', selected: ['new'], rejected: [], uncertain: [] }),
      page: { has_more: false, items: [{ product_id: 'new', name: 'Генератор A5500', sku: '20105', url }] } });
    const answer = await new PlatformAgentAssistant(repo).generateAnswer({ sessionId: 'chat', turnId: 'turn', userMessage: 'ещё' });
    expect(answer.productCards.map((card) => card.sourceUrl)).toEqual([url]);
    expect(answer.answer).toContain(`](${url})`);
  });
  it('never presents a rejected item as suitable even when the answer links to it', async () => {
    const url = 'https://bakautprof.ru/catalog/plate/';
    state.run.mockResolvedValue({ sessionId: 'agent-session', turnId: 'agent-turn', pageCursor: 'cursor-1',
      answer: JSON.stringify({ answer: `Не подходит ${url}`, selected: [], rejected: ['new'], uncertain: [] }),
      page: { items: [{ product_id: 'new', name: 'Виброплита 5100024696', sku: '5100024696', url }] } });
    const answer = await new PlatformAgentAssistant(repo).generateAnswer({ sessionId: 'chat', turnId: 'turn', userMessage: 'ещё' });
    expect(answer.productCards).toEqual([]);
  });
  it('accepts only previously shown product identities in a follow-up without a new search', async () => {
    state.listMessages.mockResolvedValue([{ metadata: { productCards: [
      { id: 'first', name: 'Первая', price: 100, specs: {}, currency: 'RUB' },
      { id: 'second', name: 'Вторая', price: 200, specs: {}, currency: 'RUB' }
    ] } }]);
    state.run.mockResolvedValue({ sessionId: 'agent-session', turnId: 'agent-turn',
      answer: JSON.stringify({ answer: 'Самая лёгкая — первая.', selected: ['first'], rejected: [], uncertain: [] }) });
    const result = await new PlatformAgentAssistant(repo).generateAnswer({ sessionId: 'chat', turnId: 'turn', userMessage: 'Какая из них самая лёгкая?' });
    expect(result.productCards.map((card) => card.id)).toEqual(['first']);
    state.run.mockResolvedValue({ sessionId: 'agent-session', turnId: 'agent-turn',
      answer: JSON.stringify({ answer: 'Ответ', selected: ['not-shown'], rejected: [], uncertain: [] }) });
    await expect(new PlatformAgentAssistant(repo).generateAnswer({ sessionId: 'chat', turnId: 'turn', userMessage: 'Какая?' })).rejects.toThrow('did not return a fresh search');
  });
  it('resolves older product results across later selections in the same session', async () => {
    state.listMessages.mockResolvedValue([
      { metadata: { productCards: [{ id: 'plate', name: 'Виброплита', price: 100, specs: {}, currency: 'RUB' }], catalogCandidates: [{ id: 'reviewed', name: 'Проверенная', price: 150, specs: {}, currency: 'RUB' }] } },
      { metadata: { productCards: [{ id: 'generator', name: 'Генератор', price: 200, specs: {}, currency: 'RUB' }] } }
    ]);
    state.run.mockResolvedValue({ sessionId: 'agent-session', turnId: 'agent-turn',
      answer: JSON.stringify({ answer: 'Виброплита', selected: ['plate'], rejected: ['reviewed'], uncertain: [] }) });
    const result = await new PlatformAgentAssistant(repo).generateAnswer({ sessionId: 'chat', turnId: 'turn', userMessage: 'Какие были виброплиты?' });
    expect(state.listMessages).toHaveBeenCalledWith('chat', 80);
    expect(result.productCards.map((card) => card.id)).toEqual(['plate']);
  });
  it('recovers rejected candidates from the same Platform session when old chat messages did not save them', async () => {
    state.listMessages.mockResolvedValue([{ metadata: { productCards: [{ id: 'selected', name: 'Виброплита', price: 100, specs: {}, currency: 'RUB' }] } }]);
    state.history.mockResolvedValue([{ product_id: 'previously-rejected', name: 'Проверенная плита', price_rub: 100 }]);
    state.run.mockResolvedValue({ sessionId: 'agent-session', turnId: 'agent-turn',
      answer: JSON.stringify({ answer: 'Найдена одна', selected: ['selected'], rejected: ['previously-rejected'], uncertain: [] }) });
    const result = await new PlatformAgentAssistant(repo).generateAnswer({ sessionId: 'chat', turnId: 'turn', userMessage: 'Какие были виброплиты?' });
    expect(state.history).toHaveBeenCalledWith('agent-session', 'agent-turn', ['previously-rejected'], undefined);
    expect(result.productCards.map((card) => card.id)).toEqual(['selected']);
  });
  it('requires complete new-search coverage and never selects an old product outside that search', async () => {
    state.listMessages.mockResolvedValue([{ metadata: { productCards: [{ id: 'old', name: 'Старый товар', price: 100, specs: {}, currency: 'RUB' }] } }]);
    const page = { items: [{ product_id: 'new', name: 'Новый товар', price_rub: 100 }] };
    state.run.mockResolvedValue({ sessionId: 'agent-session', turnId: 'agent-turn', page,
      answer: JSON.stringify({ answer: 'Новый', selected: ['new'], rejected: ['old'], uncertain: [] }) });
    const result = await new PlatformAgentAssistant(repo).generateAnswer({ sessionId: 'chat', turnId: 'turn', userMessage: 'Найди новый товар' });
    expect(result.productCards.map((card) => card.id)).toEqual(['new']);
    state.run.mockResolvedValue({ sessionId: 'agent-session', turnId: 'agent-turn', page,
      answer: JSON.stringify({ answer: 'Старый', selected: ['old'], rejected: ['new'], uncertain: [] }) });
    await expect(new PlatformAgentAssistant(repo).generateAnswer({ sessionId: 'chat', turnId: 'turn', userMessage: 'Найди новый товар' })).rejects.toThrow('does not account');
    state.run.mockResolvedValue({ sessionId: 'agent-session', turnId: 'agent-turn', page,
      answer: JSON.stringify({ answer: 'Старый', selected: [], rejected: ['old'], uncertain: [] }) });
    await expect(new PlatformAgentAssistant(repo).generateAnswer({ sessionId: 'chat', turnId: 'turn', userMessage: 'Найди новый товар' })).rejects.toThrow('does not account');
  });
  it('refuses an incomplete classification without advancing the cursor', async () => {
    state.run.mockResolvedValue({ sessionId: 'agent-session', turnId: 'agent-turn', pageCursor: 'cursor-1',
      answer: JSON.stringify({ answer: 'Ответ', selected: [], rejected: [], uncertain: [] }),
      page: { items: [{ product_id: 'new', name: 'Товар', url: 'https://bakautprof.ru/catalog/item/' }] } });
    await expect(new PlatformAgentAssistant(repo).generateAnswer({ sessionId: 'chat', turnId: 'turn', userMessage: 'ещё' })).rejects.toThrow('does not account');
    expect(state.transactionQuery).not.toHaveBeenCalled();
  });
  it('returns the full preloaded list while requesting the first ten to be shown', async () => {
    const items = Array.from({ length: 70 }, (_, id) => ({ product_id: `p${id}`, name: `Генератор ${id}`, url: `https://bakautprof.ru/catalog/p${id}/` }));
    state.run.mockResolvedValue({ sessionId: 'agent-session', turnId: 'agent-turn',
      answer: JSON.stringify({ answer: 'Найдено 70 товаров', selected: items.map((item) => item.product_id), rejected: [], uncertain: [] }), page: { items } });
    const answer = await new PlatformAgentAssistant(repo).generateAnswer({ sessionId: 'chat', turnId: 'turn', userMessage: 'Подберите генератор' });
    expect(answer.productCards).toHaveLength(70);
    expect(answer.cardDisplay).toEqual({ initialVisibleCount: 10, hasMore: false });
  });
  it('keeps the catalog price authoritative and leaves absent prices unknown', async () => {
    state.run.mockResolvedValue({ sessionId: 'agent-session', turnId: 'agent-turn',
      answer: JSON.stringify({ answer: 'Варианты', selected: ['known', 'unknown'], rejected: [], uncertain: [] }),
      page: { items: [
        { product_id: 'known', name: 'Товар 1', price_rub: 1000, website_price_rub: 2000 },
        { product_id: 'unknown', name: 'Товар 2', price_rub: 0, website_price_rub: 3000 }
      ] } });
    const answer = await new PlatformAgentAssistant(repo).generateAnswer({ sessionId: 'chat', turnId: 'turn', userMessage: 'Подберите товар' });
    expect(answer.productCards.map((card) => card.price)).toEqual([1000, null]);
  });
  it('checks missing prices, includes budget matches, and does not check known catalog prices', async () => {
    const url = 'https://bakautprof.ru/catalog/real/';
    const first = { items: [{ product_id: 'known', name: 'Known', price_rub: 500 }], count: 1 };
    state.run.mockResolvedValue({ sessionId: 'agent-session', turnId: 'agent-turn', page: first,
      answer: JSON.stringify({ answer: 'Подобрал', selected: ['__ALL_CATALOG_MATCHES__'], rejected: [], uncertain: [] }) });
    state.full.mockResolvedValue({ ...first, criteria: { max_price_rub: 1000 }, pending_price_items: [
      { product_id: 'below', name: 'Below', sku: '1', url }, { product_id: 'above', name: 'Above', sku: '2', url },
      { product_id: 'order', name: 'Order', sku: '3', url }, { product_id: 'unknown', name: 'Unknown', sku: '4', url }
    ] });
    state.price.mockImplementation(async (product: { id: string }) => product.id === 'below'
      ? { status: 'priced', productId: product.id, price: 900, sourceUrl: url, observedAt: '2026-11-03T00:00:00Z' }
      : product.id === 'above' ? { status: 'priced', productId: product.id, price: 1100, sourceUrl: url, observedAt: '2026-11-03T00:00:00Z' }
      : product.id === 'order' ? { status: 'on_request', productId: product.id, sourceUrl: url, observedAt: '2026-11-03T00:00:00Z' }
      : { status: 'unknown', productId: product.id });
    const answer = await new PlatformAgentAssistant(repo).generateAnswer({ sessionId: 'chat', turnId: 'turn', userMessage: 'До 1000 рублей' });
    expect(answer.productCards.map((card) => card.id)).toEqual(['known', 'below', 'order']);
    expect(answer.productCards[2]).toMatchObject({ priceOnRequest: true, price: null });
    expect(answer.productCards[1]).toMatchObject({ price: 900, priceSource: 'site', priceObservedAt: '2026-11-03T00:00:00Z' });
    expect(state.price).toHaveBeenCalledTimes(4);
    expect(answer.answer).toContain('под заказ');
    expect(answer.answer).toContain('соответствие бюджету неизвестно');
  });

});
