import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { pool } from '../db/pool.js';
import { ConversationRepository } from '../db/repositories.js';
import type { ChatResponsePayload, ProductCard } from '../shared/types.js';
import { PlatformAgentClient } from './platformAgentClient.js';
import { assertOpenAIUsageBudget, bindOpenAIUsageReservation, recordOpenAIUsageOnce } from './openaiUsageGuard.js';
import { TurnExecutionInProgressError, type AgentManagerGenerateInput, type AgentManagerRecoverInput } from './agentManagerOrchestrator.js';

function cardsFromPage(page: Record<string, unknown> | undefined): ProductCard[] {
  if (!page || !Array.isArray(page.items)) return [];
  if (page.items.length > 10) throw new Error('Catalog page exceeds ten products');
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
      price: typeof p.price_rub === 'number' && Number.isFinite(p.price_rub) ? p.price_rub : null,
      currency: 'RUB', sourceUrl, specs: { article: typeof p.sku === 'string' ? p.sku : '' }, reasons,
      caveats: Array.isArray(p.conditions) ? p.conditions.filter((x): x is string => typeof x === 'string') : [] };
  });
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

function classifyPage(raw: string, candidates: ProductCard[]) {
  let result: Record<string, unknown>;
  try { result = JSON.parse(raw) as Record<string, unknown>; } catch { throw new Error('Agent classification is not valid JSON'); }
  if (!result || typeof result !== 'object' || typeof result.answer !== 'string' || !result.answer.trim()) throw new Error('Agent answer is invalid');
  const groups = [result.selected, result.rejected, result.uncertain];
  if (groups.some((group) => !Array.isArray(group) || group.some((id: unknown) => typeof id !== 'string'))) throw new Error('Agent classification is invalid');
  const classified = (groups as string[][]).flat();
  const pageIds = new Set(candidates.map((card) => card.id));
  if (classified.length !== pageIds.size || new Set(classified).size !== classified.length || classified.some((id) => !pageIds.has(id))) {
    throw new Error('Agent classification does not account for the catalog page');
  }
  const selected = new Set(result.selected as string[]);
  const cards = candidates.filter((card) => selected.has(card.id));
  return { answer: reconcileCitations(result.answer, cards), cards };
}

export class PlatformAgentAssistant {
  constructor(private readonly conversations: ConversationRepository) {}

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

  async generateAnswer(input: AgentManagerGenerateInput & { catalogPage?: boolean }): Promise<ChatResponsePayload> {
    if (!input.turnId) throw new Error('Turn ID required');
    const old = await this.completed(input.sessionId, input.turnId);
    if (old) return old;
    const session = await this.conversations.getSession(input.sessionId);
    if (!session || session.status !== 'active') throw new Error('Conversation session is not active');
    if (!config.OPENAI_API_KEY || !config.OPENAI_PLATFORM_AGENT_ID) throw new Error('Platform agent is not configured');
    const ownerId = randomUUID();
    const claimed = await this.conversations.claimTurnExecution({ sessionId: input.sessionId, turnId: input.turnId, ownerId, leaseMs: 160_000 });
    if (!claimed) throw new TurnExecutionInProgressError();
    try {
      const stored = await pool.query('SELECT agent_session_id, next_cursor, seen_product_ids FROM platform_agent_sessions WHERE session_id=$1', [input.sessionId]);
      const row = stored.rows[0];
      const cursor = input.catalogPage ? row?.next_cursor : null;
      if (input.catalogPage && typeof cursor !== 'string') throw new Error('No next catalog page');
      const client = new PlatformAgentClient(config.OPENAI_API_KEY, config.OPENAI_PLATFORM_AGENT_ID,
        config.OPENAI_PLATFORM_AGENT_VAULT_ID ? [config.OPENAI_PLATFORM_AGENT_VAULT_ID] : []);
      const reservation = await assertOpenAIUsageBudget('platform_agent', 'platform_agent', 50_000);
      const result = await client.run({ sessionId: row?.agent_session_id, idempotencyKey: input.turnId, signal: input.signal,
        message: input.catalogPage ? `Покажите следующую десятку найденных товаров. Для search_products используйте именно cursor: ${cursor}. Не показывайте курсор покупателю.` : input.userMessage,
        onSession: async (id) => { await pool.query('INSERT INTO platform_agent_sessions(session_id,agent_session_id) VALUES($1,$2) ON CONFLICT(session_id) DO NOTHING', [input.sessionId, id]); } });
      const usageRecord = { id: result.turnId, usage: result.usage };
      bindOpenAIUsageReservation(usageRecord, reservation);
      await recordOpenAIUsageOnce('platform_agent', result.model, usageRecord);
      if (input.catalogPage && (!result.page || result.pageCursor !== cursor)) throw new Error('Agent did not use the requested catalog cursor');
      const candidates = cardsFromPage(result.page);
      const { answer, cards } = classifyPage(result.answer, candidates);
      const prior = input.catalogPage && Array.isArray(row?.seen_product_ids) ? row.seen_product_ids as string[] : [];
      const ids = candidates.map((card) => card.id);
      if (new Set(ids).size !== ids.length || ids.some((id) => prior.includes(id))) throw new Error('Duplicate catalog product page');
      if (result.page?.has_more === true && typeof result.page.next_cursor !== 'string') throw new Error('Catalog continuation cursor missing');
      const next = result.page?.has_more === true && typeof result.page.next_cursor === 'string' ? result.page.next_cursor : null;
      const cardDisplay = cards.length || next ? { initialVisibleCount: Math.max(1, cards.length), hasMore: Boolean(next) } : undefined;
      const metadata = { productCards: cards, cardDisplay, needStateSnapshot: session.needState,
        platformAgentUsage: result.usage, platformAgentTurnId: result.turnId, usedWebSearch: result.usedWebSearch };
      const responsePayload: ChatResponsePayload = { turnId: input.turnId, answer,
        needState: session.needState, productCards: cards, cardDisplay, usedWebSearch: result.usedWebSearch, metadata };
      const db = await pool.connect();
      try {
        await db.query('BEGIN');
        await db.query('UPDATE platform_agent_sessions SET next_cursor=$2, seen_product_ids=$3::jsonb, updated_at=now() WHERE session_id=$1',
          [input.sessionId, next, JSON.stringify([...prior, ...ids])]);
        const repository = new ConversationRepository(db);
        const message = await repository.addAssistantMessageForTurn({ sessionId: input.sessionId, turnId: input.turnId,
          executionOwner: ownerId, content: answer, metadata, answerContract: { source: 'platform_agent' }, responsePayload });
        await db.query('COMMIT');
        await input.onDelta?.(answer);
        return { ...responsePayload, assistantMessageId: message.id };
      } catch (error) { await db.query('ROLLBACK'); throw error; } finally { db.release(); }
    } finally {
      await this.conversations.releaseTurnExecution({ sessionId: input.sessionId, turnId: input.turnId, ownerId }).catch(() => undefined);
    }
  }

  async recoverTurn(input: AgentManagerRecoverInput): Promise<ChatResponsePayload> {
    const completed = await this.completed(input.sessionId, input.turnId);
    if (completed) { await input.onDelta?.(completed.answer); return completed; }
    throw new TurnExecutionInProgressError();
  }
}
