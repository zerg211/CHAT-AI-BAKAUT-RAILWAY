import { setTimeout as delay } from 'node:timers/promises';
import { ALL_CATALOG_MATCHES, selectsAllCatalogMatches } from './catalogDecision.js';

type JsonObject = Record<string, unknown>;

export class PlatformAgentRequestError extends Error {
  constructor(readonly statusCode: number) { super(`Platform agent request failed (${statusCode})`); }
}

const outputFormat = { type: 'json_schema', schema: {
  type: 'object', additionalProperties: false,
  properties: {
    answer: { type: 'string', description: 'Ответ покупателю, без ссылок на карточки каталога: ссылки будут показаны в виджете.' },
    selected: { type: 'array', items: { type: 'string' }, description: `Подтверждённые product_id либо единственный маркер ${ALL_CATALOG_MATCHES}, если каталог полностью проверил все обязательные условия.` },
    rejected: { type: 'array', items: { type: 'string' }, description: 'product_id неподходящих товаров полного списка.' },
    uncertain: { type: 'array', items: { type: 'string' }, description: 'product_id товаров полного списка, соответствие которых не подтверждено.' }
  }, required: ['answer', 'selected', 'rejected', 'uncertain']
} };

const contract = `\n\nСлужебная инструкция виджета заменяет прежние указания о постраничной выдаче. Для подбора используй search_products. Точно выбирай категорию: если покупатель просит инверторный генератор, category="Инверторные генераторы", для всех генераторов — "генераторы". Числовые пределы укажи отдельными полями, а query оставь пустым, когда категория уже выражает все требования к типу; непустой query в числовом поиске каталог НЕ применяет. Если каталог сообщил unsupported_filters, не считай такие условия проверенными: уточни поиск или проверь недостающий признак. Если поиск по категории и числовым полям полностью проверил ВСЕ обязательные условия покупателя (включая тип, топливо, напряжение, фазу, назначение и любые дополнительные требования) и unsupported_filters пуст, НЕ загружай остальные страницы и НЕ переписывай идентификаторы: верни selected=["${ALL_CATALOG_MATCHES}"], rejected=[], uncertain=[]. В противном случае, когда для ответа нужно оценить отдельные товары, собери все страницы matches и классифицируй КАЖДЫЙ product_id ровно в один из selected/rejected/uncertain, проверяя существенные неизвестные признаки по карточкам или в сети. Если поиска не было, верни пустые массивы. Не читай повторно уже возвращённые характеристики; при недостающих полях используй get_products_batch с точными product_id и source_revision, если инструмент доступен. Не исключай товары только из-за неизвестного факта и не показывай спорные как подтверждённые. Верни JSON answer, selected, rejected, uncertain. Цена из базы — основной источник: когда цена есть в базе, используй её и не проверяй повторно на сайте. Если цены в базе нет, обязательно проверь страницу точного артикула на сайте; подтверждённую цену сайта показывай как актуальную без оговорок. Если на странице точно подтверждено отсутствие цены, сообщи, что товар под заказ, сроки уточняет менеджер, и предложи оформить заявку, не обещая, что она уже передана. Если сайт недоступен или точный артикул не подтверждён, сообщи, что цену нужно уточнить, и не утверждай, что товар под заказ. Не считай товар с неподтверждённой ценой подходящим под заданный бюджет. В answer кратко ответь покупателю, не перечисляй больше первых 10 товаров и не вставляй ссылки на карточки: виджет сам покажет точные данные из каталога. Не проси покупателя ждать поиска по кнопке: весь список будет готов до ответа.`;

function object(value: unknown): JsonObject | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : undefined;
}

/** Preserve every saved tool and widen only the existing catalog MCP allowlist. */
export function enableCatalogBatchTool(value: unknown): unknown[] | undefined {
  if (!Array.isArray(value)) return undefined;
  let changed = false;
  const updated = value.map((item) => {
    const tool = object(item);
    if (!tool || tool.type !== 'mcp' || tool.server_label !== 'bakaut_catalog' || !Array.isArray(tool.allowed_tools)) return item;
    if (!tool.allowed_tools.every((name) => typeof name === 'string') || tool.allowed_tools.includes('get_products_batch')) return item;
    changed = true;
    return { ...tool, allowed_tools: [...tool.allowed_tools, 'get_products_batch'] };
  });
  return changed ? updated : undefined;
}

/** Extract the catalog page belonging to the completed turn, never another turn. */
export function extractAgentResult(items: unknown[], turnId: string) {
  const own = items.map(object).filter((item): item is JsonObject => !!item && item.turn_id === turnId);
  const messages = own.filter((item) => item.role === 'assistant');
  const final = messages.filter((item) => item.phase === 'final_answer');
  const selected = final.length ? final : messages.slice(-1);
  const answer = selected.flatMap((item) => Array.isArray(item.content) ? item.content : [])
    .map(object).filter((part): part is JsonObject => !!part && (part.type === 'output_text' || part.type === 'text'))
    .map((part) => typeof part.text === 'string' ? part.text : '').join('\n').trim();
  let page: JsonObject | undefined;
  let pageCursor: unknown;
  const pages: Array<{ page: JsonObject; cursor: unknown }> = [];
  for (const item of own) {
    if (item.type !== 'mcp_call' || item.name !== 'search_products' || item.status !== 'completed') continue;
    const output = object(item.output);
    let candidate = object(output?.structuredContent);
    if (!candidate && Array.isArray(output?.content)) {
      for (const part of output.content) {
        const text = object(part)?.text;
        if (typeof text !== 'string') continue;
        try { candidate = object(JSON.parse(text)); } catch { /* Ignore non-JSON MCP content. */ }
        if (candidate) break;
      }
    }
    if (candidate?.group === 'matches' && Array.isArray(candidate.items)) {
      let args = object(item.arguments);
      if (!args && typeof item.arguments === 'string') {
        try { args = object(JSON.parse(item.arguments)); } catch { /* Invalid arguments are rejected by the caller. */ }
      }
      pages.push({ page: candidate, cursor: args?.cursor });
    }
  }
  if (pages.length) {
    const root = [...pages].reverse().find((entry) => !entry.cursor);
    if (!root) throw new Error('Catalog pages are incomplete');
    const first = root.page;
    if (selectsAllCatalogMatches(answer)) return { answer, page: first, pageCursor: root.cursor, usedWebSearch: own.some((item) => item.type === 'web_search_call') };
    const decodeCursor = (cursor: unknown): JsonObject | undefined => {
      if (typeof cursor !== 'string' || !cursor) return undefined;
      try { return object(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))); } catch { return undefined; }
    };
    const firstNext = decodeCursor(first.next_cursor);
    if (first.has_more === true && !firstNext) throw new Error('Invalid catalog cursor');
    const sequence = [{ entry: root, offset: 0 }, ...pages.flatMap((entry) => {
      const token = decodeCursor(entry.cursor);
      if (!token || !firstNext || token.snapshot !== firstNext.snapshot || token.revision !== firstNext.revision ||
          token.group !== 'matches' || typeof token.offset !== 'number') return [];
      return [{ entry, offset: token.offset }];
    })].sort((a, b) => a.offset - b.offset);
    let expectedOffset = 0;
    for (const part of sequence) {
      if (part.offset !== expectedOffset || part.entry.page.count !== first.count ||
          part.entry.page.source_revision !== first.source_revision ||
          JSON.stringify(part.entry.page.criteria) !== JSON.stringify(first.criteria)) {
        throw new Error('Catalog pages are incomplete or inconsistent');
      }
      expectedOffset += (part.entry.page.items as unknown[]).length;
      const next = decodeCursor(part.entry.page.next_cursor);
      if (part.entry.page.has_more === true && (!next || next.snapshot !== firstNext?.snapshot || next.offset !== expectedOffset)) {
        throw new Error('Catalog continuation is inconsistent');
      }
    }
    const last = sequence[sequence.length - 1].entry.page;
    const all = sequence.flatMap((part) => part.entry.page.items as unknown[]);
    if (last.has_more === true || typeof first.count !== 'number' || all.length !== first.count) {
      throw new Error('Catalog result is incomplete or changed while loading');
    }
    page = { ...first, items: all, has_more: false, next_cursor: null };
    pageCursor = root.cursor;
  }
  return { answer, page, pageCursor, usedWebSearch: own.some((item) => item.type === 'web_search_call') };
}

export class PlatformAgentClient {
  constructor(private readonly apiKey: string, private readonly agentId: string,
    private readonly vaultIds: string[] = [], private readonly transport: typeof fetch = fetch) {}

  private async request(path: string, signal: AbortSignal | undefined, body?: unknown, key?: string) {
    const response = await this.transport(`https://api.openai.com/v1${path}`, {
      method: body === undefined ? 'GET' : 'POST', signal,
      headers: { Authorization: `Bearer ${this.apiKey}`, 'OpenAI-Beta': 'agents=v1',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(key ? { 'Idempotency-Key': key } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    if (!response.ok) throw new PlatformAgentRequestError(response.status);
    const text = await response.text();
    return text ? object(JSON.parse(text)) ?? {} : {};
  }

  async run(input: { message: string; sessionId?: string; idempotencyKey: string; signal?: AbortSignal;
    onSession?: (sessionId: string) => Promise<void>;
    onBeforeSubmit?: (sessionId: string, previousTurnId: string | null, submitted: boolean, submittedText: string) => Promise<void>;
    onSubmitted?: (sessionId: string, previousTurnId: string | null) => Promise<void> }) {
    let sessionId = input.sessionId;
    let previousTurnId: unknown;
    try {
    if (sessionId) {
      const active = await this.request(`/agents/sessions/${encodeURIComponent(sessionId)}`, input.signal);
      const updatedTools = enableCatalogBatchTool(object(active.agent)?.tools);
      if (updatedTools) await this.request(`/agents/sessions/${encodeURIComponent(sessionId)}`, input.signal, { agent: { tools: updatedTools } });
      const turns = await this.request(`/agents/sessions/${encodeURIComponent(sessionId)}/turns?limit=1&order=desc`, input.signal);
      previousTurnId = object(Array.isArray(turns.data) ? turns.data[0] : undefined)?.id;
      const previous = typeof previousTurnId === 'string' ? previousTurnId : null;
      await input.onBeforeSubmit?.(sessionId, previous, false, input.message + contract);
      await this.submitMessage(sessionId, input.message + contract, input.idempotencyKey, input.signal);
      await input.onSubmitted?.(sessionId, previous);
    } else {
      const saved = await this.request(`/agents/${encodeURIComponent(this.agentId)}`, input.signal);
      if (typeof saved.instructions !== 'string') throw new Error('Saved agent instructions are unavailable');
      const updatedTools = enableCatalogBatchTool(saved.tools);
      const session = await this.request('/agents/sessions', input.signal, {
        agent_id: this.agentId, agent: { instructions: `${saved.instructions}\n\n${contract}`, text: { format: outputFormat },
          ...(updatedTools ? { tools: updatedTools } : {}) }, environment: { type: 'none' }, input: input.message + contract,
        ...(this.vaultIds.length ? { vault_ids: this.vaultIds } : {})
      }, input.idempotencyKey);
      if (typeof session.id !== 'string' || !session.id) throw new Error('Platform agent session ID missing');
      sessionId = session.id;
      try {
        await input.onSession?.(sessionId);
        await input.onBeforeSubmit?.(sessionId, null, true, input.message + contract);
      } catch (error) {
        // The initial input has already started, so failure to durably record its
        // identity must not leave an unobservable paid run behind.
        await this.cancelTurn(sessionId).catch(() => undefined);
        throw error;
      }
    }
      return await this.waitForTurn({ sessionId, previousTurnId: typeof previousTurnId === 'string' ? previousTurnId : null, signal: input.signal });
    } catch (error) {
      // Deadline reconciliation is handled by the assistant, which checks whether
      // the exact remote turn already completed before issuing a cancellation.
      throw error;
    }
  }

  async cancelTurn(sessionId: string) {
    await this.request(`/agents/sessions/${encodeURIComponent(sessionId)}/events`, AbortSignal.timeout(5000), {
      events: [{ type: 'agent.session.input.cancel' }]
    });
  }

  async latestTurn(sessionId: string, signal: AbortSignal = AbortSignal.timeout(5000)) {
    const response = await this.request(`/agents/sessions/${encodeURIComponent(sessionId)}/turns?limit=1&order=desc`, signal);
    const turn = object(Array.isArray(response.data) ? response.data[0] : undefined);
    return typeof turn?.id === 'string' ? { id: turn.id, status: String(turn.status ?? '') } : null;
  }

  async settleAtDeadline(input: { sessionId: string; previousTurnId: string | null; signal: AbortSignal }) {
    const isNew = (turn: { id: string; status: string } | null) => turn && turn.id !== input.previousTurnId;
    let turn = await this.latestTurn(input.sessionId, input.signal);
    if (!isNew(turn) || (turn?.status !== 'completed' && turn?.status !== 'failed' && turn?.status !== 'cancelled')) {
      await this.cancelTurn(input.sessionId).catch(() => undefined);
      turn = await this.latestTurn(input.sessionId, input.signal);
    }
    if (!isNew(turn) || turn?.status !== 'completed') return null;
    return this.waitForTurn({ sessionId: input.sessionId, previousTurnId: input.previousTurnId, signal: input.signal });
  }

  async submitMessage(sessionId: string, message: string, idempotencyKey: string, signal?: AbortSignal) {
    await this.request(`/agents/sessions/${encodeURIComponent(sessionId)}/events`, signal, {
      events: [{ type: 'agent.session.input.message', input: [{ role: 'user', content: [{ type: 'input_text', text: message }] }] }]
    }, idempotencyKey);
  }

  async waitForTurn(input: { sessionId: string; previousTurnId: string | null; signal?: AbortSignal }) {
    const sessionId = input.sessionId;
    const path = `/agents/sessions/${encodeURIComponent(sessionId)}`;
    while (!input.signal?.aborted) {
      const [session, turns] = await Promise.all([
        this.request(path, input.signal), this.request(`${path}/turns?limit=1&order=desc`, input.signal)
      ]);
      if (Array.isArray(session.required_actions) && session.required_actions.length) throw new Error('Platform agent requires an unsupported action');
      const turn = object(Array.isArray(turns.data) ? turns.data[0] : undefined);
      if (turn && turn.id !== input.previousTurnId && ['completed', 'failed', 'cancelled'].includes(String(turn.status))) {
        if (turn.status !== 'completed' || typeof turn.id !== 'string') throw new Error('Platform agent turn did not complete');
        const collected: unknown[] = [];
        let after = '';
        for (;;) {
          const result = await this.request(`${path}/turns/${encodeURIComponent(turn.id)}/items?limit=100&order=asc${after ? `&after=${encodeURIComponent(after)}` : ''}`, input.signal);
          const entries = Array.isArray(result.data) ? result.data : [];
          collected.push(...entries);
          if (result.has_more !== true) break;
          const lastId = object(entries[entries.length - 1])?.id;
          if (typeof lastId !== 'string' || !lastId || lastId === after) throw new Error('Agent items pagination failed');
          after = lastId;
        }
        const parsed = extractAgentResult(collected, turn.id);
        if (!parsed.answer) throw new Error('Platform agent returned an empty answer');
        const agent = object(session.agent);
        return { sessionId, turnId: turn.id, usage: turn.usage,
          model: typeof agent?.model === 'string' ? agent.model : 'unknown', ...parsed };
      }
      await delay(750, undefined, { signal: input.signal });
    }
    throw new Error('Platform agent request aborted');
  }
}
