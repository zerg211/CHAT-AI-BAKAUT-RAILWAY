import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { config } from '../config.js';
import { pool } from '../db/pool.js';
import { ConversationRepository } from '../db/repositories.js';
import type { ChatResponsePayload, ProductCard } from '../shared/types.js';
import { PlatformAgentClient } from './platformAgentClient.js';
import { selectsAllCatalogMatches } from './catalogDecision.js';
import { readFullCatalogSnapshot } from './fullCatalogClient.js';
import { readSitePriceObservation } from '../catalog/currentSitePrice.js';
import { assertOpenAIUsageBudget, bindOpenAIUsageReservation, recordOpenAIUsageOnce } from './openaiUsageGuard.js';
import { TurnExecutionInProgressError, type AgentManagerGenerateInput, type AgentManagerRecoverInput } from './agentManagerOrchestrator.js';

function cardsFromPage(page: Record<string, unknown> | undefined): ProductCard[] {
  if (!page || !Array.isArray(page.items)) return [];
  if (page.items.length > 4324) throw new Error('Catalog result exceeds indexed catalog size');
  return page.items.map((raw): ProductCard => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid catalog product');
    const p = raw as Record<string, unknown>;
    if (typeof p.product_id !== 'string' || typeof p.name !== 'string') throw new Error('Catalog product identity missing');
    let sourceUrl: string | undefined;
    if (typeof p.url === 'string') {
      const url = new URL(p.url);
      if (url.protocol !== 'https:' || url.hostname !== 'bakautprof.ru') throw new Error('Invalid catalog product URL');
      sourceUrl = url.href;
    }
    const powers = Array.isArray(p.nominal_electrical_power) ? p.nominal_electrical_power : [];
    const reasons = powers.flatMap((value) => {
      const power = value && typeof value === 'object' ? value as Record<string, unknown> : {};
      return typeof power.field === 'string' && typeof power.raw === 'string' ? [`${power.field}: ${power.raw}`] : [];
    });
    return { id: p.product_id, name: p.name, category: typeof p.category === 'string' ? p.category : null,
      price: typeof p.price_rub === 'number' && Number.isFinite(p.price_rub) && p.price_rub > 0 ? p.price_rub : null,
      priceSource: typeof p.price_rub === 'number' && Number.isFinite(p.price_rub) && p.price_rub > 0 ? 'catalog' : undefined,
      currency: 'RUB', sourceUrl, specs: { article: typeof p.sku === 'string' ? p.sku : '' }, reasons,
      caveats: Array.isArray(p.conditions) ? p.conditions.filter((x): x is string => typeof x === 'string') : [] };
  });
}

async function enrichMissingPrices(cards: ProductCard[], signal?: AbortSignal): Promise<ProductCard[]> {
  const result = cards.slice();
  let cursor = 0;
  const worker = async () => {
    while (cursor < cards.length) {
      const index = cursor++;
      const card = cards[index];
      if (typeof card.price === 'number' && Number.isFinite(card.price) && card.price > 0) continue;
      const observation = await readSitePriceObservation({ id: card.id, name: card.name, sourceUrl: card.sourceUrl, specs: card.specs }, signal);
      if (observation.status === 'priced') result[index] = { ...card, price: observation.price, priceSource: 'site', priceObservedAt: observation.observedAt, sourceUrl: observation.sourceUrl };
      else if (observation.status === 'on_request') result[index] = { ...card, priceOnRequest: true, priceSource: 'site', priceObservedAt: observation.observedAt, sourceUrl: observation.sourceUrl };
    }
  };
  await Promise.all(Array.from({ length: Math.min(8, cards.length) }, worker));
  return result;
}

function isLetterOrDigit(character: string) {
  return !!character && ((character >= '0' && character <= '9') || character.toLocaleLowerCase('ru') !== character.toLocaleUpperCase('ru'));
}

function containsExact(text: string, value: string) {
  const source = text.normalize('NFKC').toLocaleLowerCase('ru');
  const target = value.normalize('NFKC').toLocaleLowerCase('ru').trim();
  if (!target) return false;
  let offset = 0;
  while (offset < source.length) {
    const index = source.indexOf(target, offset);
    if (index < 0) return false;
    if (!isLetterOrDigit(source[index - 1] ?? '') && !isLetterOrDigit(source[index + target.length] ?? '')) return true;
    offset = index + 1;
  }
  return false;
}

function citedByIdentity(line: string, card: ProductCard, candidates: ProductCard[]) {
  const sku = typeof card.specs.article === 'string' ? card.specs.article.trim() : '';
  if (sku.length < 3 || candidates.filter((item) => item.specs.article === sku).length !== 1 || !containsExact(line, sku)) return false;
  return card.name.split(' ').some((part) => {
    const token = Array.from(part).filter(isLetterOrDigit).join('');
    const letters = Array.from(token).some((ch) => ch.toLocaleLowerCase('ru') !== ch.toLocaleUpperCase('ru'));
    const digits = Array.from(token).some((ch) => ch >= '0' && ch <= '9');
    return token.length >= 4 && letters && digits && token.toLocaleLowerCase('ru') !== sku.toLocaleLowerCase('ru') && containsExact(line, token);
  });
}

function reconcileCitations(answer: string, candidates: ProductCard[]) {
  return answer.split('\n').map((line) => {
    const matching = candidates.filter((card) => citedByIdentity(line, card, candidates));
    if (matching.length !== 1 || !matching[0].sourceUrl) return line;
    const start = line.indexOf('](');
    const end = start < 0 ? -1 : line.indexOf(')', start + 2);
    if (start < 0 || end < 0 || !line.slice(start + 2, end).startsWith('https://bakautprof.ru/catalog/')) return line;
    return line.slice(0, start + 2) + matching[0].sourceUrl + line.slice(end);
  }).join('\n');
}

class CatalogClassificationError extends Error {}

async function currentCatalogRevision(signal?: AbortSignal): Promise<string> {
  const base = new URL(config.BAKAUT_CATALOG_URL);
  if (base.protocol !== 'https:' || base.hostname !== 'catalog-search-production.up.railway.app') {
    throw new Error('Catalog URL is not allowed');
  }
  const response = await fetch(new URL('/health', base), {
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000)
  });
  if (!response.ok) throw new Error('Catalog revision is unavailable');
  const health = await response.json() as { status?: unknown; revision?: unknown };
  if (health.status !== 'ok' || typeof health.revision !== 'string' || !health.revision) throw new Error('Catalog revision is unavailable');
  return health.revision;
}

function classifyPage(raw: string, candidates: ProductCard[], history: ProductCard[], hasSearch: boolean, shownIds: Set<string>) {
  let result: Record<string, unknown>;
  try { result = JSON.parse(raw) as Record<string, unknown>; } catch { throw new Error('Agent classification is not valid JSON'); }
  if (!result || typeof result !== 'object' || typeof result.answer !== 'string' || !result.answer.trim()) throw new Error('Agent answer is invalid');
  const groups = [result.selected, result.rejected, result.uncertain];
  if (groups.some((group) => !Array.isArray(group) || group.some((id: unknown) => typeof id !== 'string'))) throw new Error('Agent classification is invalid');
  if (selectsAllCatalogMatches(raw)) return { answer: reconcileCitations(result.answer, candidates), cards: candidates };
  const classified = (groups as string[][]).flat();
  const pageIds = new Set(candidates.map((card) => card.id));
  const historicalIds = new Set(history.map((card) => card.id));
  const selected = new Set(result.selected as string[]);
  // A new search is authoritative for suitability: older IDs can be mentioned as
  // rejected or uncertain but cannot become matches outside the new snapshot.
  if (new Set(classified).size !== classified.length ||
      classified.some((id) => !pageIds.has(id) && !historicalIds.has(id)) ||
      (hasSearch && ([...pageIds].some((id) => !classified.includes(id)) ||
        [...selected].some((id) => !pageIds.has(id)))) ||
      (!hasSearch && [...selected].some((id) => !shownIds.has(id)))) {
    throw new CatalogClassificationError('Agent classification does not account for the catalog page');
  }
  const cards = (hasSearch ? candidates : history).filter((card) => selected.has(card.id));
  return { answer: reconcileCitations(result.answer, cards), cards };
}

export class PlatformAgentAssistant {
  constructor(private readonly conversations: ConversationRepository) {}

  private keepLease(sessionId: string, turnId: string, ownerId: string) {
    const timer = setInterval(() => {
      void this.conversations.renewTurnExecution({ sessionId, turnId, ownerId, leaseMs: 10_000 }).catch(() => undefined);
    }, 3_000);
    timer.unref();
    return () => clearInterval(timer);
  }

  private async completed(sessionId: string, turnId: string): Promise<ChatResponsePayload | null> {
    const turn = await this.conversations.getTurn(sessionId, turnId);
    if (!turn?.assistantMessageId || !['completed', 'recovered'].includes(turn.status)) return null;
    const [session, messages] = await Promise.all([this.conversations.getSession(sessionId), this.conversations.listMessages(sessionId, 80)]);
    const message = messages.find((m) => m.id === turn.assistantMessageId);
    if (!session || !message) return null;
    return { turnId, answer: message.content, needState: session.needState,
      productCards: (message.metadata.productCards as ProductCard[] | undefined) ?? [],
      cardDisplay: message.metadata.cardDisplay as ChatResponsePayload['cardDisplay'],
      usedWebSearch: Boolean(message.metadata.usedWebSearch), assistantMessageId: message.id };
  }

  private async saveResult(input: {
    sessionId: string; turnId: string; ownerId: string; result: Awaited<ReturnType<PlatformAgentClient['waitForTurn']>>;
    reservation: string | null; prior: string[]; needState: ChatResponsePayload['needState']; recovered?: boolean; signal?: AbortSignal;
    onDelta?: (text: string) => void | Promise<void>;
  }): Promise<ChatResponsePayload> {
    const { result } = input;
    const usageRecord = { id: result.turnId, usage: result.usage };
    bindOpenAIUsageReservation(usageRecord, input.reservation);
    await recordOpenAIUsageOnce('platform_agent', result.model, usageRecord);
    const page = selectsAllCatalogMatches(result.answer)
      ? await readFullCatalogSnapshot(result.page ?? {}, input.signal)
      : result.page;
    const candidates = cardsFromPage(page);
    const parsed = JSON.parse(result.answer) as { selected?: unknown; rejected?: unknown; uncertain?: unknown };
    const classifiedIds = [parsed.selected, parsed.rejected, parsed.uncertain].flatMap((value) => Array.isArray(value) ? value : []);
    const currentIds = new Set(candidates.map((card) => card.id));
    let history: ProductCard[] = [];
    const shownIds = new Set<string>();
    const shownRevisions = new Map<string, string>();
    if (!selectsAllCatalogMatches(result.answer) && classifiedIds.some((id) => !currentIds.has(id))) {
      // All previously delivered results belong to this session. Use the most
      // recent copy of each card, while never inventing unknown identities.
      const messages = await this.conversations.listMessages(input.sessionId, 80);
      const byId = new Map<string, ProductCard>();
      for (const message of [...messages].reverse()) {
        const shown = message.metadata?.productCards;
        if (Array.isArray(shown)) for (const card of shown as ProductCard[]) {
          if (card && typeof card.id === 'string' && !shownIds.has(card.id)) {
            shownIds.add(card.id);
            if (typeof message.metadata?.catalogRevision === 'string') shownRevisions.set(card.id, message.metadata.catalogRevision);
          }
        }
        const savedGroups = [message.metadata?.productCards, message.metadata?.catalogCandidates];
        for (const saved of savedGroups) {
          if (!Array.isArray(saved)) continue;
          for (const card of saved as ProductCard[]) {
            if (card && typeof card.id === 'string' && !byId.has(card.id)) byId.set(card.id, card);
          }
        }
      }
      const missing = classifiedIds.filter((id): id is string => typeof id === 'string' && !currentIds.has(id) && !byId.has(id));
      if (missing.length && config.OPENAI_API_KEY && config.OPENAI_PLATFORM_AGENT_ID) {
        const client = new PlatformAgentClient(config.OPENAI_API_KEY, config.OPENAI_PLATFORM_AGENT_ID,
          config.OPENAI_PLATFORM_AGENT_VAULT_ID ? [config.OPENAI_PLATFORM_AGENT_VAULT_ID] : []);
        const recovered = await client.findHistoricalCandidates(result.sessionId, result.turnId, missing, input.signal);
        for (const card of cardsFromPage({ items: recovered })) if (!byId.has(card.id)) byId.set(card.id, card);
      }
      history = [...byId.values()];
    }
    const classified = classifyPage(result.answer, candidates, history, Boolean(page), shownIds);
    let catalogRevision = typeof page?.source_revision === 'string' ? page.source_revision : undefined;
    if (!page && classified.cards.length && config.BAKAUT_CATALOG_URL) {
      catalogRevision = await currentCatalogRevision(input.signal);
      if (classified.cards.some((card) => shownRevisions.get(card.id) !== catalogRevision)) {
        throw new CatalogClassificationError('Agent classification does not account for the catalog page: catalog revision changed or unknown');
      }
    }
    let answer = classified.answer;
    let cards = await enrichMissingPrices(classified.cards, input.signal);
    const pendingPage = page && Array.isArray(page.pending_price_items) ? { items: page.pending_price_items } : undefined;
    const pending = await enrichMissingPrices(cardsFromPage(pendingPage), input.signal);
    const criteria = page && page.criteria && typeof page.criteria === 'object' ? page.criteria as Record<string, unknown> : undefined;
    const budget = typeof criteria?.max_price_rub === 'number' && Number.isFinite(criteria.max_price_rub) ? criteria.max_price_rub : null;
    if (budget !== null && selectsAllCatalogMatches(result.answer)) {
      const additional = pending.filter((card) => typeof card.price === 'number' && card.price <= budget);
      cards = [...cards, ...additional];
      if (additional.length) answer += `\n\nПосле проверки цен на сайте дополнительно подходят товаров: ${additional.length}.`;
      const onRequest = pending.filter((card) => card.priceOnRequest);
      cards = [...cards, ...onRequest];
      const unknown = pending.filter((card) => !card.priceOnRequest && card.price == null).length;
      if (onRequest.length) answer += `\n\nТовары под заказ: ${onRequest.length}. Их цена и соответствие бюджету не подтверждены; сроки уточнит менеджер. Предлагаем оформить заявку.`;
      if (unknown) answer += `\n\nНе удалось проверить цену ещё ${unknown} товаров, поэтому их соответствие бюджету неизвестно.`;
    }
    const ids = [...candidates, ...pending].map((card) => card.id);
    if (new Set(ids).size !== ids.length || ids.some((id) => input.prior.includes(id))) throw new Error('Duplicate catalog product page');
    if (page?.has_more === true && typeof page.next_cursor !== 'string') throw new Error('Catalog continuation cursor missing');
    if (Buffer.byteLength(JSON.stringify(cards), 'utf8') > 4_000_000) throw new Error('Complete catalog result exceeds response size');
    const cardDisplay = cards.length ? { initialVisibleCount: Math.min(10, cards.length), hasMore: false } : undefined;
    const checkedById = new Map([...cards, ...pending].map((card) => [card.id, card]));
    const priceAudit = [...classified.cards, ...pending].map((original) => {
      const checked = checkedById.get(original.id) ?? original;
      return { productId: checked.id, status: checked.priceSource === 'site' ? (checked.priceOnRequest ? 'on_request' : 'priced') : checked.priceSource === 'catalog' ? 'catalog' : 'unknown',
        sourceUrl: checked.priceSource === 'site' ? checked.sourceUrl : undefined, observedAt: checked.priceObservedAt };
    });
    const metadata = { runtimeMode: 'openai_platform_agent' as const, runtimeModeReason: 'sole_runtime', productCards: cards,
      catalogCandidates: page && !selectsAllCatalogMatches(result.answer) ? candidates : undefined, catalogRevision, priceAudit, cardDisplay, needStateSnapshot: input.needState,
      platformAgentUsage: result.usage, platformAgentTurnId: result.turnId, usedWebSearch: result.usedWebSearch };
    const responsePayload: ChatResponsePayload = { turnId: input.turnId, answer, needState: input.needState,
      productCards: cards, cardDisplay, usedWebSearch: result.usedWebSearch, metadata };
    const db = await pool.connect();
    try {
      await db.query('BEGIN');
      await db.query('UPDATE platform_agent_sessions SET next_cursor=$2, seen_product_ids=$3::jsonb, updated_at=now() WHERE session_id=$1',
        [input.sessionId, null, JSON.stringify([...input.prior, ...ids])]);
      const repository = new ConversationRepository(db);
      const message = await repository.addAssistantMessageForTurn({ sessionId: input.sessionId, turnId: input.turnId,
        executionOwner: input.ownerId, content: answer, metadata, answerContract: { source: 'platform_agent' },
        recovered: input.recovered, responsePayload });
      await db.query('COMMIT');
      await input.onDelta?.(answer);
      return { ...responsePayload, assistantMessageId: message.id };
    } catch (error) { await db.query('ROLLBACK'); throw error; } finally { db.release(); }
  }

  async generateAnswer(input: AgentManagerGenerateInput): Promise<ChatResponsePayload> {
    if (!input.turnId) throw new Error('Turn ID required');
    const old = await this.completed(input.sessionId, input.turnId);
    if (old) return old;
    const session = await this.conversations.getSession(input.sessionId);
    if (!session || session.status !== 'active') throw new Error('Conversation session is not active');
    if (!config.OPENAI_API_KEY || !config.OPENAI_PLATFORM_AGENT_ID) throw new Error('Platform agent is not configured');
    const ownerId = randomUUID();
    const claimed = await this.conversations.claimTurnExecution({ sessionId: input.sessionId, turnId: input.turnId, ownerId, leaseMs: 10_000 });
    if (!claimed) throw new TurnExecutionInProgressError();
    const stopLease = this.keepLease(input.sessionId, input.turnId, ownerId);
    try {
      const stored = await pool.query('SELECT agent_session_id FROM platform_agent_sessions WHERE session_id=$1', [input.sessionId]);
      const row = stored.rows[0];
      const client = new PlatformAgentClient(config.OPENAI_API_KEY, config.OPENAI_PLATFORM_AGENT_ID,
        config.OPENAI_PLATFORM_AGENT_VAULT_ID ? [config.OPENAI_PLATFORM_AGENT_VAULT_ID] : []);
      let reservation = await assertOpenAIUsageBudget('platform_agent', 'platform_agent', 50_000);
      let submittedText = '';
      let submissionKey = input.turnId;
      const submission: { current: { sessionId: string; previousTurnId: string | null } | null } = { current: null };
      const checkpoint = async (id: string, previousTurnId: string | null, submitted: boolean) => {
        await this.conversations.upsertTurnCheckpoint({ sessionId: input.sessionId, turnId: input.turnId!, executionOwner: ownerId,
          checkpoint: 'platform_agent_submission', status: 'running',
          payload: { agentSessionId: id, previousTurnId, reservation, submitted, submittedText, idempotencyKey: submissionKey } });
      };
      let result: Awaited<ReturnType<PlatformAgentClient['waitForTurn']>> | null = null;
      try {
      result = await client.run({ sessionId: row?.agent_session_id, idempotencyKey: input.turnId, signal: input.signal,
        message: input.userMessage,
        onSession: async (id) => { await pool.query('INSERT INTO platform_agent_sessions(session_id,agent_session_id) VALUES($1,$2) ON CONFLICT(session_id) DO NOTHING', [input.sessionId, id]); },
        onBeforeSubmit: async (id, previousTurnId, submitted, text) => { submission.current = { sessionId: id, previousTurnId }; submittedText = text; await checkpoint(id, previousTurnId, submitted); },
        onSubmitted: async (id, previousTurnId) => checkpoint(id, previousTurnId, true) });
      try {
        return await this.saveResult({ sessionId: input.sessionId, turnId: input.turnId, ownerId, result, reservation, prior: [],
          needState: session.needState, onDelta: input.onDelta, signal: input.signal });
      } catch (error) {
        if (!(error instanceof CatalogClassificationError) || input.signal?.aborted) throw error;
        // Retry once with a new catalog search. A failed, undisplayed selection
        // is not buyer-visible history and must never be treated as confirmed.
        reservation = await assertOpenAIUsageBudget('platform_agent', 'platform_agent', 50_000);
        const agentSessionId = result.sessionId;
        submissionKey = `${input.turnId}-catalog-retry`;
        result = null;
        result = await client.run({ sessionId: agentSessionId, idempotencyKey: submissionKey, signal: input.signal,
          message: `Предыдущий ответ не был показан покупателю: его список товаров не прошёл проверку. Для ответа на исходный вопрос заново вызови search_products, проверь актуальные карточки и классифицируй все товары новой выдачи. Не считай товары предыдущих неудачных попыток показанными. Исходный вопрос покупателя: ${input.userMessage}`,
          onBeforeSubmit: async (id, previousTurnId, submitted, text) => { submission.current = { sessionId: id, previousTurnId }; submittedText = text; await checkpoint(id, previousTurnId, submitted); },
          onSubmitted: async (id, previousTurnId) => checkpoint(id, previousTurnId, true) });
        if (!result.page) {
          const usageRecord = { id: result.turnId, usage: result.usage };
          bindOpenAIUsageReservation(usageRecord, reservation);
          await recordOpenAIUsageOnce('platform_agent', result.model, usageRecord);
          throw new CatalogClassificationError('Catalog retry did not return a fresh search');
        }
        return await this.saveResult({ sessionId: input.sessionId, turnId: input.turnId, ownerId, result, reservation, prior: [],
          needState: session.needState, onDelta: input.onDelta, signal: input.signal });
      }
      } catch (error) {
        if (!input.signal?.aborted || input.signal.reason === 'platform_agent_explicit_cancel' || !submission.current) throw error;
        const alreadySaved = await this.completed(input.sessionId, input.turnId);
        if (alreadySaved) return alreadySaved;
        const graceSignal = AbortSignal.timeout(25_000);
        result ??= await client.settleAtDeadline({ ...submission.current, signal: graceSignal });
        if (!result) throw error;
        if (submissionKey !== input.turnId && !result.page) {
          const usageRecord = { id: result.turnId, usage: result.usage };
          bindOpenAIUsageReservation(usageRecord, reservation);
          await recordOpenAIUsageOnce('platform_agent', result.model, usageRecord);
          throw new CatalogClassificationError('Catalog retry did not return a fresh search');
        }
        return await this.saveResult({ sessionId: input.sessionId, turnId: input.turnId, ownerId, result, reservation, prior: [],
          needState: session.needState, recovered: true, onDelta: input.onDelta, signal: graceSignal });
      }
    } finally {
      stopLease();
      await this.conversations.releaseTurnExecution({ sessionId: input.sessionId, turnId: input.turnId, ownerId }).catch(() => undefined);
    }
  }

  async recoverTurn(input: AgentManagerRecoverInput): Promise<ChatResponsePayload> {
    while (!input.signal?.aborted) {
      const completed = await this.completed(input.sessionId, input.turnId);
      if (completed) { await input.onDelta?.(completed.answer); return completed; }
      const turn = await this.conversations.getTurn(input.sessionId, input.turnId);
      if (turn?.errorCode === 'cancelled_by_user') throw new Error('Turn was cancelled by the user');
      if (!turn || (turn.deadlineAt && Date.parse(turn.deadlineAt) + 30_000 <= Date.now())) throw new Error('Turn deadline expired');
      const deadlineExpired = Boolean(turn.deadlineAt && Date.parse(turn.deadlineAt) <= Date.now());
      const ownerId = randomUUID();
      const claimed = await this.conversations.claimTurnExecution({ sessionId: input.sessionId, turnId: input.turnId, ownerId, leaseMs: 10_000 });
      if (!claimed) { await delay(1000, undefined, { signal: input.signal }); continue; }
      const stopLease = this.keepLease(input.sessionId, input.turnId, ownerId);
      try {
        const rows = await this.conversations.listTurnCheckpoints(input.sessionId, input.turnId);
        const checkpoint = rows.find((row) => row.checkpoint === 'platform_agent_submission');
        const data = checkpoint?.payload as Record<string, unknown> | undefined;
        if (!data || typeof data.agentSessionId !== 'string' || !(data.previousTurnId === null || typeof data.previousTurnId === 'string')) {
          throw new Error('Agent submission is not recoverable without a saved identity');
        }
        const session = await this.conversations.getSession(input.sessionId);
        if (!session || !config.OPENAI_API_KEY || !config.OPENAI_PLATFORM_AGENT_ID) throw new Error('Platform agent is not configured');
        const client = new PlatformAgentClient(config.OPENAI_API_KEY, config.OPENAI_PLATFORM_AGENT_ID,
          config.OPENAI_PLATFORM_AGENT_VAULT_ID ? [config.OPENAI_PLATFORM_AGENT_VAULT_ID] : []);
        let result;
        try {
          if (deadlineExpired) {
            result = await client.settleAtDeadline({ sessionId: data.agentSessionId, previousTurnId: data.previousTurnId, signal: AbortSignal.timeout(25_000) });
            if (!result) throw new Error('Agent turn did not complete before the deadline');
          } else {
          if (data.submitted === false) {
            if (typeof data.submittedText !== 'string') throw new Error('Saved agent submission is incomplete');
            await client.submitMessage(data.agentSessionId, data.submittedText,
              typeof data.idempotencyKey === 'string' ? data.idempotencyKey : input.turnId, input.signal);
          }
          result = await client.waitForTurn({ sessionId: data.agentSessionId, previousTurnId: data.previousTurnId, signal: input.signal });
          }
        } catch (error) {
          if (!input.signal?.aborted || input.signal.reason === 'platform_agent_explicit_cancel') throw error;
          result = await client.settleAtDeadline({ sessionId: data.agentSessionId, previousTurnId: data.previousTurnId, signal: AbortSignal.timeout(25_000) });
          if (!result) throw error;
        }
        if (data.idempotencyKey === `${input.turnId}-catalog-retry` && !result.page) {
          const usageRecord = { id: result.turnId, usage: result.usage };
          bindOpenAIUsageReservation(usageRecord, typeof data.reservation === 'string' ? data.reservation : null);
          await recordOpenAIUsageOnce('platform_agent', result.model, usageRecord);
          throw new CatalogClassificationError('Catalog retry did not return a fresh search');
        }
        return await this.saveResult({ sessionId: input.sessionId, turnId: input.turnId, ownerId, result,
          reservation: typeof data.reservation === 'string' ? data.reservation : null,
          prior: Array.isArray(data.prior) ? data.prior.filter((id): id is string => typeof id === 'string') : [],
          needState: session.needState, recovered: true, onDelta: input.onDelta, signal: deadlineExpired || input.signal?.aborted ? AbortSignal.timeout(25_000) : input.signal });
      } finally {
        stopLease();
        await this.conversations.releaseTurnExecution({ sessionId: input.sessionId, turnId: input.turnId, ownerId }).catch(() => undefined);
      }
    }
    throw new Error('Recovery was aborted');
  }
}
