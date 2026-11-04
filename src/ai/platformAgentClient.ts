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
    uncertain: { type: 'array', items: { type: 'string' }, description: 'product_id товаров полного списка, соответствие которых не подтверждено.' },
    selection_snapshots: { type: 'array', items: { type: 'string' }, description: 'snapshot только тех завершённых поисков, из которых сформирована текущая подборка. Справочные поиски не включать.' }
  }, required: ['answer', 'selected', 'rejected', 'uncertain', 'selection_snapshots']
} };

const contract = `

Служебная инструкция виджета имеет приоритет над прежними указаниями агента о поиске. Для нового подбора используй смысловой индекс каталога: вызови semantic_concepts для product_type и сопоставь ВСЕ возвращённые понятия со смыслом запроса покупателя. Для каждого key укажи match, exclude или uncertain; не исключай понятие из-за отсутствия точного слова или синонима. Если у покупателя есть обязательные условия по назначению, материалу, свойству, совместимости или размеру, запроси соответствующие словари и так же оцени каждый key. Не добавляй условия по бренду, конструкции или категории, которых покупатель не задавал и которые не нужны для применения. Затем вызови search_products с semantic_requirements=[{kind,decisions}] и нужными числовыми пределами; category не задавай. query оставь пустым лишь если в semantic_requirements и числовых полях отражены ВСЕ обязательные условия. Если решающий параметр модели нужен для совместимости, сначала прочитай её точную карточку. Если смысловой индекс пока недоступен, используй прежний поиск, но не объявляй непроверенную выдачу полной. Если каталог полностью проверил структурированные требования, semantic_scan_complete=true, unsupported_filters пуст и нет других условий, верни selected=["${ALL_CATALOG_MATCHES}"], rejected=[], uncertain=[]: сервер сам загрузит ВСЕ совпадения и отдельно пометит неясные варианты. Не переписывай тысячи идентификаторов и не загружай страницы при этом маркере. В остальных случаях классифицируй каждый товар выбранной выдачи ровно в один из selected/rejected/uncertain. Не скрывай неизвестный решающий факт и не считай его подтверждением. Проверяй только обязательные и действительно существенные условия; если согласованных данных карточки достаточно, не повторяй чтение и не обращайся в сеть. Существенное противоречие или отсутствие решающего факта уточняй для точной модификации. При вопросе о ранее показанных товарах используй только реально показанную выдачу этого диалога; для нового подбора сделай новый поиск. Цена из базы используется без общей оговорки; при её отсутствии проверь страницу точного артикула и покажи найденную цену сайта как актуальную. Если цены нет и на сайте, товар под заказ, сроки уточнит менеджер после заявки. Не считай неподтверждённую цену выполнением бюджета. В answer кратко ответь покупателю без ссылок и без перечисления более первых 10 моделей: виджет показывает полный сохранённый список по 10, кнопка только раскрывает уже загруженные карточки.`;

const selectionHistoryContract = `\n\nТолько товары из ответов, действительно показанных покупателю, являются показанной подборкой. Результаты незавершённых, отменённых и не показанных попыток не являются показанными. Для нового подбора и после неудачной попытки обязательно выполни новый search_products в актуальном каталоге. При вопросе о ранее показанных товарах сохраняй контекст. Для любых товаров используй доступные факты из точной карточки и сопоставляй только характеристики, которые действительно влияют на запрос покупателя. Если необходимые известные условия совпадают и нет существенного противоречия, отвечай и показывай товары без повторных проверок или искусственных сомнений. Отсутствие второстепенного поля само по себе не причина исключать товар, обращаться в интернет или требовать уточнение. Если решающий для выбора факт неизвестен или данные существенно противоречат друг другу, проверь точную модификацию в доступных источниках или кратко уточни нужное; не выдумывай значение и не называй неподтверждённое подтверждённым. Явно установленное несовпадение обязательного условия учитывай. Показывай предварительные варианты отдельно от подтверждённых, если без неизвестного факта нельзя окончательно подтвердить соответствие. В selection_snapshots укажи snapshot каждого поиска, товары которого образуют новую подборку. Не включай поиски для справки или уточнения характеристик. При обычной классификации загрузи все страницы каждого выбранного snapshot и классифицируй товары без повторов. При маркере полного каталога укажи ровно один snapshot: сервер загрузит его целиком без дополнительных вызовов модели. Для ответа без нового подбора верни пустой selection_snapshots.`;

const pricePolicy = `\n\nЦена, указанная в точной карточке базы, используется в ответе без общих оговорок о возможной неактуальности. Если покупатель сам спрашивает, изменилась ли цена, или есть доказанное расхождение, проверь сайт точного артикула. При отсутствии цены в базе проверь сайт: найденную цену показывай без оговорок; если на сайте цены нет, сообщи, что товар под заказ, сроки уточняет менеджер. Если сайт недоступен или артикул не подтверждён, цену нужно уточнить; не выдавай отсутствие подтверждения за товар под заказ.`;
const coveragePolicy = `\n\nЕсли запрос допускает несколько видов товара, не ограничивай подбор одним видом без основания в запросе: классифицируй все понятия product_type и учитывай пересекающиеся виды. Синонимы помогают интерпретации, но не заменяют оценку полного словаря и учёт товаров без распознанного признака. Учитывай совместимость и явные требования покупателя, не угадывая отсутствующие ограничения. Если индекс понятий недоступен, для смыслового запроса один раз вызови semantic_rank_products как карту возможных категорий, затем проверь точные условия через search_products. Ранжирование не является границей отбора: товары ниже первой страницы не исключены. Не повторяй поиск с теми же условиями и не называй непроверенный текстовый результат полным.`;

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
    if (!tool.allowed_tools.every((name) => typeof name === 'string')) return item;
    const allowed = tool.allowed_tools as string[];
    const missing = ['get_products_batch', 'semantic_concepts', 'semantic_rank_products'].filter((name) => !allowed.includes(name));
    if (!missing.length) return item;
    changed = true;
    return { ...tool, allowed_tools: [...tool.allowed_tools, ...missing] };
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
    const roots = pages.filter((entry) => !entry.cursor);
    if (!roots.length) throw new Error('Catalog pages are incomplete');
    let explicitSnapshots: string[] | undefined;
    try {
      const result = object(JSON.parse(answer));
      if (Array.isArray(result?.selection_snapshots) && result.selection_snapshots.every((id) => typeof id === 'string')) {
        explicitSnapshots = result.selection_snapshots as string[];
      }
    } catch { /* Old sessions may use the previous response format. */ }
    const chosen = explicitSnapshots === undefined ? [roots[roots.length - 1]] : explicitSnapshots.map((id) => {
      const matches = roots.filter((entry) => entry.page.snapshot === id);
      if (!matches.length) throw new Error('Selected catalog search is unavailable');
      return matches[matches.length - 1];
    });
    if (new Set(chosen).size !== chosen.length) throw new Error('Duplicate selected catalog search');
    if (!chosen.length) return { answer, page: undefined, pageCursor: undefined, usedWebSearch: own.some((item) => item.type === 'web_search_call') };
    const root = chosen[chosen.length - 1];
    const first = root.page;
    if (selectsAllCatalogMatches(answer)) {
      if (chosen.length !== 1) throw new Error('Complete catalog marker requires exactly one search');
      return { answer, page: first, pageCursor: root.cursor, usedWebSearch: own.some((item) => item.type === 'web_search_call') };
    }
    const decodeCursor = (cursor: unknown): JsonObject | undefined => {
      if (typeof cursor !== 'string' || !cursor) return undefined;
      try { return object(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))); } catch { return undefined; }
    };
    const combined = new Map<string, unknown>();
    for (const selectedRoot of chosen) {
    const first = selectedRoot.page;
    if (first.source_revision !== root.page.source_revision) throw new Error('Catalog revision changed between searches');
    const firstNext = decodeCursor(first.next_cursor);
    if (first.has_more === true && !firstNext) throw new Error('Invalid catalog cursor');
    const sequence = [{ entry: selectedRoot, offset: 0 }, ...pages.flatMap((entry) => {
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
    for (const item of all) {
      const id = object(item)?.product_id;
      if (typeof id !== 'string' || !id) throw new Error('Invalid catalog product identity');
      if (!combined.has(id)) combined.set(id, item);
    }
    }
    const incompleteTextSearch = chosen.some(({ page }) => Array.isArray(page.unsupported_filters) &&
      page.unsupported_filters.includes('semantic_query_completeness'));
    page = { ...first, items: [...combined.values()], has_more: false, next_cursor: null, incomplete_text_search: incompleteTextSearch };
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
      await input.onBeforeSubmit?.(sessionId, previous, false, input.message + contract + selectionHistoryContract + pricePolicy + coveragePolicy);
      await this.submitMessage(sessionId, input.message + contract + selectionHistoryContract + pricePolicy + coveragePolicy, input.idempotencyKey, input.signal);
      await input.onSubmitted?.(sessionId, previous);
    } else {
      const saved = await this.request(`/agents/${encodeURIComponent(this.agentId)}`, input.signal);
      if (typeof saved.instructions !== 'string') throw new Error('Saved agent instructions are unavailable');
      const updatedTools = enableCatalogBatchTool(saved.tools);
      const session = await this.request('/agents/sessions', input.signal, {
        agent_id: this.agentId, agent: { instructions: `${saved.instructions}\n\n${contract}${selectionHistoryContract}${pricePolicy}${coveragePolicy}`, text: { format: outputFormat },
          ...(updatedTools ? { tools: updatedTools } : {}) }, environment: { type: 'none' }, input: input.message + contract + selectionHistoryContract + pricePolicy + coveragePolicy,
        ...(this.vaultIds.length ? { vault_ids: this.vaultIds } : {})
      }, input.idempotencyKey);
      if (typeof session.id !== 'string' || !session.id) throw new Error('Platform agent session ID missing');
      sessionId = session.id;
      try {
        await input.onSession?.(sessionId);
        await input.onBeforeSubmit?.(sessionId, null, true, input.message + contract + selectionHistoryContract + pricePolicy + coveragePolicy);
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

  /** Recover previously searched candidates only from this Platform session's own tool outputs. */
  async findHistoricalCandidates(sessionId: string, currentTurnId: string, identifiers: string[], signal?: AbortSignal) {
    const wanted = new Set(identifiers);
    const found = new Map<string, Record<string, unknown>>();
    if (!wanted.size) return [];
    const base = `/agents/sessions/${encodeURIComponent(sessionId)}`;
    let after = '';
    let checked = 0;
    while (wanted.size && checked < 80) {
      const turns = await this.request(`${base}/turns?limit=100&order=desc${after ? `&after=${encodeURIComponent(after)}` : ''}`, signal);
      const entries = Array.isArray(turns.data) ? turns.data : [];
      for (const entry of entries) {
        const turn = object(entry);
        if (typeof turn?.id !== 'string' || turn.id === currentTurnId || turn.status !== 'completed') continue;
        if (++checked > 80) break;
        let itemAfter = '';
        do {
          const response = await this.request(`${base}/turns/${encodeURIComponent(turn.id)}/items?limit=100&order=asc${itemAfter ? `&after=${encodeURIComponent(itemAfter)}` : ''}`, signal);
          const items = Array.isArray(response.data) ? response.data : [];
          for (const raw of items) {
            const item = object(raw);
            if (item?.turn_id !== turn.id || item.type !== 'mcp_call' || item.name !== 'search_products' || item.status !== 'completed') continue;
            const output = object(item.output);
            let page = object(output?.structuredContent);
            if (!page && Array.isArray(output?.content)) for (const part of output.content) {
              const value = object(part)?.text;
              if (typeof value !== 'string') continue;
              try { page = object(JSON.parse(value)); } catch { continue; }
              if (page) break;
            }
            if (page?.status !== 'ok' || !Array.isArray(page.items)) continue;
            for (const rawProduct of page.items) {
              const product = object(rawProduct);
              if (typeof product?.product_id !== 'string' || !wanted.has(product.product_id)) continue;
              found.set(product.product_id, product);
              wanted.delete(product.product_id);
            }
          }
          if (response.has_more !== true) break;
          const next = object(items[items.length - 1])?.id;
          if (typeof next !== 'string' || !next || next === itemAfter) throw new Error('Agent historical items pagination failed');
          itemAfter = next;
        } while (wanted.size);
        if (!wanted.size) break;
      }
      if (!wanted.size || turns.has_more !== true || checked >= 80) break;
      const next = object(entries[entries.length - 1])?.id;
      if (typeof next !== 'string' || !next || next === after) throw new Error('Agent historical turns pagination failed');
      after = next;
    }
    return [...found.values()];
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
