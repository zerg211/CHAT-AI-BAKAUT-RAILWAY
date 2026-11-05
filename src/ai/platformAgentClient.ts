import { setTimeout as delay } from 'node:timers/promises';
import { diagnosticAbortSource, diagnosticError, diagnosticEvent, diagnosticSpan } from '../observability/diagnostics.js';
import { ALL_CATALOG_MATCHES, selectsAllCatalogMatches } from './catalogDecision.js';

type JsonObject = Record<string, unknown>;

export class PlatformAgentRequestError extends Error {
  constructor(readonly statusCode: number, readonly errorCode = 'unknown', readonly errorType = 'unknown',
    readonly providerRequestId?: string) {
    super(`Platform agent request failed (${statusCode})`);
    this.name = 'PlatformAgentRequestError';
  }
}

const providerCodes = ['insufficient_quota', 'rate_limit_exceeded', 'invalid_api_key', 'invalid_request_error',
  'model_not_found', 'context_length_exceeded', 'server_error', 'internal_server_error', 'permission_denied',
  'billing_hard_limit_reached', 'unsupported_country_region_territory', 'resource_not_found'];
const providerTypes = ['invalid_request_error', 'authentication_error', 'permission_error', 'not_found_error',
  'rate_limit_error', 'server_error', 'api_error', 'insufficient_quota'];
const remoteStatuses = ['queued', 'in_progress', 'running', 'completed', 'failed', 'cancelled', 'cancelling',
  'incomplete', 'requires_action', 'expired'];
const itemTypes = ['message', 'reasoning', 'mcp_call', 'mcp_list_tools', 'mcp_approval_request', 'function_call',
  'function_call_output', 'web_search_call', 'file_search_call', 'computer_call', 'code_interpreter_call'];
const toolNames = ['search_products', 'get_product', 'get_products_batch', 'semantic_rank_products', 'semantic_select_products',
  'web_search', 'file_search'];
function known(value: unknown, allowed: string[]): string {
  return typeof value === 'string' && allowed.includes(value) ? value : 'unknown';
}
/** Missing error data is not evidence of an error; reported values remain classified. */
function reportedErrorFields(value: unknown): Record<string, string> {
  if (value === undefined || value === null) return {};
  const error = object(value);
  return { errorCode: known(error?.code, providerCodes), errorType: known(error?.type, providerTypes) };
}
function digits(value: string): boolean {
  return value.length > 0 && [...value].every(c => c >= '0' && c <= '9');
}
function decimal(value: string): boolean {
  const parts = value.split('.');
  return parts.length <= 2 && parts.every(digits);
}
function providerId(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 128) return undefined;
  const uuid = value.split('-');
  if (uuid.map(part => part.length).join(',') === '8,4,4,4,12' &&
      uuid.every(part => [...part.toLowerCase()].every(c => '0123456789abcdef'.includes(c)))) return value;
  const prefix = ['req_', 'sess_', 'session_', 'turn_', 'item_', 'call_', 'msg_', 'resp_', 'fc_', 'rs_', 'mcp_', 'req-']
    .find(candidate => value.startsWith(candidate));
  if (!prefix) return undefined;
  const suffix = value.slice(prefix.length);
  return suffix.length > 0 && suffix.length <= 120 && [...suffix].every(c =>
    (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') ||
    c === '-' || (c === '_' && prefix !== 'req-')) ? value : undefined;
}
function endpointTemplate(path: string): string {
  const parts = path.split('?')[0].split('/');
  if (parts[0] !== '' || parts[1] !== 'agents') return 'unknown';
  if (parts.length === 3 && parts[2] === 'sessions') return '/agents/sessions';
  if (parts.length === 3 && parts[2]) return '/agents/:agentId';
  if (parts[2] !== 'sessions' || !parts[3]) return 'unknown';
  if (parts.length === 4) return '/agents/sessions/:sessionId';
  if (parts.length === 5 && parts[4] === 'events') return '/agents/sessions/:sessionId/events';
  if (parts.length === 5 && parts[4] === 'turns') return '/agents/sessions/:sessionId/turns';
  if (parts.length === 6 && parts[4] === 'turns' && parts[5]) return '/agents/sessions/:sessionId/turns/:turnId';
  if (parts.length === 7 && parts[4] === 'turns' && parts[5] && parts[6] === 'items') return '/agents/sessions/:sessionId/turns/:turnId/items';
  return 'unknown';
}
function documentedModel(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 100) return false;
  const parts = value.split('-');
  if (parts.length >= 4) {
    const date = parts.slice(-3);
    if (date.map(part => part.length).join(',') === '4,2,2' && date.every(digits)) parts.splice(-3);
  }
  if (parts[0] === 'gpt') return parts.length >= 2 && decimal(parts[1]) &&
    parts.slice(2).every(part => ['mini', 'nano', 'luna', 'pro', 'chat', 'latest'].includes(part));
  return parts[0].length === 2 && parts[0][0] === 'o' && '123456789'.includes(parts[0][1]) &&
    (parts.length === 1 || (parts.length === 2 && ['mini', 'pro'].includes(parts[1])));
}

/** Error inspection has its own byte/time budget; never delays failures indefinitely. */
async function readErrorEnvelope(response: Response): Promise<{ text: string; bytes: number; truncated?: boolean }> {
  const reader = response.body?.getReader();
  if (!reader) return { text: '', bytes: 0 };
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let finished = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new DOMException('Error envelope inspection timed out', 'TimeoutError')), 1000);
  });
  try {
    while (bytes < 16_384) {
      const { value, done } = await Promise.race([reader.read(), deadline]);
      if (done) { finished = true; return { text: new TextDecoder().decode(Buffer.concat(chunks)), bytes }; }
      const chunk = value.subarray(0, 16_384 - bytes);
      chunks.push(chunk);
      bytes += chunk.byteLength;
    }
    // A truncated envelope is not parsed, even if its prefix resembles JSON.
    return { text: '', bytes, truncated: true };
  } finally {
    clearTimeout(timer);
    if (!finished) void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
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

const contract = `\n\nСлужебные правила виджета имеют приоритет над прежними противоречащими инструкциями агента. Для нового подбора с требованием к назначению, материалу, свойству или совместимости вызови semantic_select_products по одному разу для каждой нужной категории: requirement содержит только обязательный смысловой признак, а category указывает точный вид товара. Передай все полученные snapshot в selection_snapshots. Числовые ограничения передай отдельными полями. Если категорию не знаешь, используй semantic_rank_products только для её определения. Слова «недорогой» без суммы не означают ценовой предел; показывай подходящие товары по возрастанию цены. Когда semantic_select_products полностью проверил все нужные категории, верни selected=["${ALL_CATALOG_MATCHES}"], rejected=[], uncertain=[] и все их snapshot в selection_snapshots. Карточки и сомнительные варианты сервер загрузит сам; не перебирай их повторно. Для подбора только по категории и числам используй search_products с пустым query. Маркер полного списка допустим лишь когда каталог подтвердил проверку всех обязательных условий. Если условие неизвестно или существенно противоречиво, отмечай сомнение, не выдавай товар за подтверждённый. Без нового подбора отвечай с учётом показанных ранее товаров. Товарный список не сокращай по своей инициативе: виджет показывает готовые результаты порциями по 10. В answer дай короткий ответ без перечисления карточек и ссылок. Не добавляй общую оговорку о неактуальности цен.`;

const selectionHistoryContract = `\n\nТолько товары из ответов, показанных покупателю, составляют историю подбора. При новом подборе используй актуальный каталог. Для semantic_select_products укажи snapshot каждой нужной категории и маркер полного списка; сервер объединит выбранные и сомнительные товары без повторов. Для числового search_products классифицируй все страницы, если маркер полного списка неприменим. При вопросе о прежних товарах сохраняй контекст; если нового подбора нет, selection_snapshots пуст. Не делай повторных проверок уже известных решающих характеристик. При существенном конфликте точной модификации проверь источник; отсутствие второстепенного поля само по себе не основание исключать товар.`;

const pricePolicy = `\n\nЦена, указанная в точной карточке базы, используется в ответе без общих оговорок о возможной неактуальности. Если покупатель сам спрашивает, изменилась ли цена, или есть доказанное расхождение, проверь сайт точного артикула. При отсутствии цены в базе проверь сайт: найденную цену показывай без оговорок; если на сайте цены нет, сообщи, что товар под заказ, сроки уточняет менеджер. Если сайт недоступен или артикул не подтверждён, цену нужно уточнить; не выдавай отсутствие подтверждения за товар под заказ.`;
const coveragePolicy = `\n\nОхвати все виды товара, которые покупатель явно допускает. Семантический отбор проверяет каждую карточку выбранной категории, а не первые результаты поиска. Не заменяй полную проверку синонимами или первой страницей эмбеддингов. Не придумывай покупателю бюджет или другие условия. Если запрос состоит из нескольких самостоятельных видов товара, не ограничивай поиск одной категорией.`;

function object(value: unknown): JsonObject | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : undefined;
}

function catalogToolPayload(value: unknown, depth = 0): JsonObject | undefined {
  const output = object(value);
  if (!output || depth > 4 || output.isError === true) return undefined;
  if (Array.isArray(output.items) ||
      (typeof output.status === 'string' && output.status !== 'ok')) return output;
  const structured = catalogToolPayload(output.structuredContent, depth + 1);
  if (structured) return structured;
  if (!Array.isArray(output.content)) return undefined;
  for (const part of output.content) {
    const text = object(part)?.text;
    if (typeof text !== 'string') continue;
    try {
      const payload = catalogToolPayload(JSON.parse(text), depth + 1);
      if (payload) return payload;
    } catch { /* Ignore non-JSON MCP content. */ }
  }
  return undefined;
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
    const missing = ['get_products_batch', 'semantic_rank_products', 'semantic_select_products'].filter((name) => !allowed.includes(name));
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
  let declared: JsonObject | undefined;
  try { declared = object(JSON.parse(answer)); } catch { /* Earlier turns may contain plain text. */ }
  const snapshots = Array.isArray(declared?.selection_snapshots) &&
    declared.selection_snapshots.every((id) => typeof id === 'string') ? declared.selection_snapshots as string[] : [];
  const semantic = own.filter((item) => item.type === 'mcp_call' && item.name === 'semantic_select_products' && item.status === 'completed')
    .map((item) => catalogToolPayload(item.output));
  if (semantic.some((result) => !result)) throw new Error('Semantic catalog output is malformed');
  if (semantic.length && snapshots.length) {
    if (new Set(snapshots).size !== snapshots.length) throw new Error('Duplicate semantic catalog snapshot');
    const matches = snapshots.map((snapshot) => {
      const found = semantic.filter((result) => result?.status === 'ok' && result.snapshot === snapshot);
      if (found.length !== 1) throw new Error('Selected semantic snapshot is unavailable or ambiguous');
      return found[0]!;
    });
    if (matches.some((page) => page.source_revision !== matches[0].source_revision)) {
      throw new Error('Catalog revision changed between semantic selections');
    }
    if (!selectsAllCatalogMatches(answer)) throw new Error('Semantic selection requires complete catalog marker');
    return { answer, page: matches.length === 1 ? matches[0] : {
      status: 'ok', selection_mode: 'semantic_multi', selections: matches,
      source_revision: matches[0].source_revision }, pageCursor: undefined,
      usedWebSearch: own.some((item) => item.type === 'web_search_call') };
  }
  let page: JsonObject | undefined;
  let pageCursor: unknown;
  const pages: Array<{ page: JsonObject; cursor: unknown }> = [];
  for (const item of own) {
    if (item.type !== 'mcp_call' || item.name !== 'search_products' || item.status !== 'completed') continue;
    const candidate = catalogToolPayload(item.output);
    if (!candidate) throw new Error('Catalog tool output is malformed');
    if (candidate.group === 'matches' && Array.isArray(candidate.items)) {
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
    const method = body === undefined ? 'GET' : 'POST';
    const endpoint = endpointTemplate(path);
    return diagnosticSpan('provider.http', async () => {
      const started = performance.now();
      const segments = path.split('?')[0].split('/');
      const metrics: Record<string, unknown> = { method, endpoint, headersMs: 0, bodyMs: 0, parseMs: 0,
        agentSessionId: providerId(segments[3]), agentTurnId: providerId(segments[5]) };
      let phase = 'headers';
      let phaseStarted = started;
      try {
        const response = await this.transport(`https://api.openai.com/v1${path}`, {
          method, signal,
          headers: { Authorization: `Bearer ${this.apiKey}`, 'OpenAI-Beta': 'agents=v1',
            ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
            ...(key ? { 'Idempotency-Key': key } : {}) },
          ...(body === undefined ? {} : { body: JSON.stringify(body) })
        });
        metrics.headersMs = performance.now() - phaseStarted;
        metrics.statusCode = response.status;
        metrics.providerRequestId = providerId(response.headers.get('x-request-id'));
        for (const [header, field] of [['retry-after', 'retryAfterSeconds'],
          ['x-ratelimit-remaining-requests', 'rateLimitRemainingRequests'],
          ['x-ratelimit-remaining-tokens', 'rateLimitRemainingTokens']]) {
          const value = response.headers.get(header);
          if (value && decimal(value) && Number.isFinite(Number(value))) metrics[field] = Number(value);
        }
        phase = 'body';
        phaseStarted = performance.now();
        if (!response.ok) {
          let envelope: unknown;
          try {
            const bounded = await readErrorEnvelope(response);
            metrics.bodyMs = performance.now() - phaseStarted;
            metrics.responseBytes = bounded.bytes;
            if (bounded.truncated) diagnosticEvent('provider.error_envelope.unavailable', { ...metrics, outcome: 'truncated' });
            phase = 'parse';
            phaseStarted = performance.now();
            if (bounded.text) envelope = JSON.parse(bounded.text);
          } catch (error) {
            diagnosticError('provider.error_envelope.failure', error, { ...metrics, stage: phase });
            diagnosticEvent('provider.error_envelope.unavailable', { ...metrics, stage: phase,
              outcome: error instanceof Error && error.name === 'TimeoutError' ? 'timeout' : 'failure' });
          } finally { metrics[`${phase}Ms`] = performance.now() - phaseStarted; }
          const details = object(object(envelope)?.error);
          metrics.errorCode = known(details?.code, providerCodes);
          metrics.errorType = known(details?.type, providerTypes);
          throw new PlatformAgentRequestError(response.status, metrics.errorCode as string,
            metrics.errorType as string, metrics.providerRequestId as string | undefined);
        }
        const text = await response.text();
        metrics.bodyMs = performance.now() - phaseStarted;
        metrics.responseBytes = Buffer.byteLength(text);
        phase = 'parse';
        phaseStarted = performance.now();
        const result = text ? object(JSON.parse(text)) ?? {} : {};
        metrics.parseMs = performance.now() - phaseStarted;
        phase = 'complete';
        if (endpoint === '/agents/sessions') metrics.agentSessionId = providerId(result.id);
        const agent = object(result.agent);
        const model = agent?.model ?? result.model;
        if (documentedModel(model)) {
          diagnosticEvent('provider.model.observed', { model });
        }
        const entries = Array.isArray(result.data) ? result.data : [];
        if (endpoint.endsWith('/turns')) for (const raw of entries) {
          const turn = object(raw);
          diagnosticEvent('provider.turn.observed', { agentTurnId: providerId(turn?.id),
            remoteStatus: known(turn?.status, remoteStatuses),
            ...reportedErrorFields(turn?.error) });
        }
        if (endpoint.endsWith('/items')) for (const raw of entries) {
          const item = object(raw);
          diagnosticEvent('provider.item.observed', { itemId: providerId(item?.id), callId: providerId(item?.call_id),
            agentTurnId: providerId(item?.turn_id), itemType: known(item?.type, itemTypes),
            tool: known(item?.name, toolNames), remoteStatus: known(item?.status, remoteStatuses),
            ...reportedErrorFields(item?.error) });
        }
        metrics.outcome = 'success';
        return result;
      } catch (error) {
        if (phase !== 'complete') metrics[`${phase}Ms`] = performance.now() - phaseStarted;
        metrics.outcome = signal?.aborted ? 'aborted' : 'failure';
        diagnosticError('provider.http.failure', error, { ...metrics, stage: phase,
          aborted: signal?.aborted === true, abortSource: diagnosticAbortSource(signal) });
        throw error;
      } finally {
        diagnosticEvent('provider.http.response', { ...metrics, durationMs: performance.now() - started });
      }
    }, { method, endpoint });
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
        const causalEventId = diagnosticError('provider.checkpoint.failure', error);
        await this.cancelTurn(sessionId).catch((cancelError) => { diagnosticError('provider.cancel.failure', cancelError, { causalEventId }); });
        throw error;
      }
    }
      return await this.waitForTurn({ sessionId, previousTurnId: typeof previousTurnId === 'string' ? previousTurnId : null, signal: input.signal });
    } catch (error) {
      diagnosticError('provider.run.failure', error, { aborted: input.signal?.aborted === true,
        abortSource: diagnosticAbortSource(input.signal) });
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
            const page = catalogToolPayload(item.output);
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

  async readTurn(sessionId: string, turnId: string, signal?: AbortSignal) {
    return this.request(`/agents/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(turnId)}`,signal);
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
      await this.cancelTurn(input.sessionId).catch((cancelError) => { diagnosticError('provider.cancel.failure', cancelError); });
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
    let pollCount = 0;
    while (!input.signal?.aborted) {
      diagnosticEvent('provider.turn.poll', { pollCount: ++pollCount, agentSessionId: providerId(sessionId) });
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
