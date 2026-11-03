import { setTimeout as delay } from 'node:timers/promises';

type JsonObject = Record<string, unknown>;

const outputFormat = { type: 'json_schema', schema: {
  type: 'object', additionalProperties: false,
  properties: {
    answer: { type: 'string', description: 'Ответ покупателю, без ссылок на карточки каталога: ссылки будут показаны в виджете.' },
    selected: { type: 'array', items: { type: 'string' }, description: 'product_id всех подтвержденно подходящих товаров полного списка search_products.' },
    rejected: { type: 'array', items: { type: 'string' }, description: 'product_id неподходящих товаров полного списка.' },
    uncertain: { type: 'array', items: { type: 'string' }, description: 'product_id товаров полного списка, соответствие которых не подтверждено.' }
  }, required: ['answer', 'selected', 'rejected', 'uncertain']
} };

const contract = '\n\nСлужебная инструкция для виджета заменяет прежние указания о выдаче только текущей страницы: перед ответом собери ВСЕ страницы группы matches search_products, последовательно вызывая инструмент с next_cursor до has_more=false. Каждый товар всех страниц отнеси ровно в один массив product_id: selected (подтверждённо подходит), rejected (не подходит), uncertain (соответствие не подтверждено). Верни JSON с полями answer, selected, rejected, uncertain. Не включай спорные и отклонённые товары в selected. Если поиска не было, верни пустые массивы. В answer кратко ответь покупателю, не перечисляй больше первых 10 товаров и не вставляй ссылки на карточки: виджет сам покажет все выбранные карточки по 10. Не проси покупателя ждать поиска по кнопке: весь список должен быть готов до ответа.';

function object(value: unknown): JsonObject | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : undefined;
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
    if (!response.ok) throw new Error(`Platform agent request failed (${response.status})`);
    const text = await response.text();
    return text ? object(JSON.parse(text)) ?? {} : {};
  }

  async run(input: { message: string; sessionId?: string; idempotencyKey: string; signal?: AbortSignal;
    onSession?: (sessionId: string) => Promise<void> }) {
    let sessionId = input.sessionId;
    let previousTurnId: unknown;
    if (sessionId) {
      const turns = await this.request(`/agents/sessions/${encodeURIComponent(sessionId)}/turns?limit=1&order=desc`, input.signal);
      previousTurnId = object(Array.isArray(turns.data) ? turns.data[0] : undefined)?.id;
      await this.request(`/agents/sessions/${encodeURIComponent(sessionId)}/events`, input.signal, {
        events: [{ type: 'agent.session.input.message', input: [{ role: 'user', content: [{ type: 'input_text', text: input.message + contract }] }] }]
      }, input.idempotencyKey);
    } else {
      const saved = await this.request(`/agents/${encodeURIComponent(this.agentId)}`, input.signal);
      if (typeof saved.instructions !== 'string') throw new Error('Saved agent instructions are unavailable');
      const session = await this.request('/agents/sessions', input.signal, {
        agent_id: this.agentId, agent: { instructions: `${saved.instructions}\n\n${contract}`, text: { format: outputFormat } }, environment: { type: 'none' }, input: input.message + contract,
        ...(this.vaultIds.length ? { vault_ids: this.vaultIds } : {})
      }, input.idempotencyKey);
      if (typeof session.id !== 'string' || !session.id) throw new Error('Platform agent session ID missing');
      sessionId = session.id;
      await input.onSession?.(sessionId);
    }
    const path = `/agents/sessions/${encodeURIComponent(sessionId)}`;
    while (!input.signal?.aborted) {
      const [session, turns] = await Promise.all([
        this.request(path, input.signal), this.request(`${path}/turns?limit=1&order=desc`, input.signal)
      ]);
      if (Array.isArray(session.required_actions) && session.required_actions.length) throw new Error('Platform agent requires an unsupported action');
      const turn = object(Array.isArray(turns.data) ? turns.data[0] : undefined);
      if (turn && turn.id !== previousTurnId && ['completed', 'failed', 'cancelled'].includes(String(turn.status))) {
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
