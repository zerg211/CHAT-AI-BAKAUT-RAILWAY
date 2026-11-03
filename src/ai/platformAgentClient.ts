import { setTimeout as delay } from 'node:timers/promises';

type JsonObject = Record<string, unknown>;

const outputFormat = { type: 'json_schema', schema: {
  type: 'object', additionalProperties: false,
  properties: {
    answer: { type: 'string', description: 'Ответ покупателю, без ссылок на карточки каталога: ссылки будут показаны в виджете.' },
    selected: { type: 'array', items: { type: 'string' }, description: 'product_id подтвержденно подходящих товаров текущей страницы search_products.' },
    rejected: { type: 'array', items: { type: 'string' }, description: 'product_id неподходящих товаров текущей страницы.' },
    uncertain: { type: 'array', items: { type: 'string' }, description: 'product_id товаров текущей страницы, соответствие которых не подтверждено.' }
  }, required: ['answer', 'selected', 'rejected', 'uncertain']
} };

const contract = '\n\nСлужебный формат ответа: верни JSON с полями answer (текст для покупателя), selected, rejected, uncertain (массивы product_id). Каждый товар из последней страницы search_products отнеси ровно в один массив. В selected только товары, которые подходят запросу; спорные и исключённые туда не включай. Если поиска не было, верни пустые массивы. Не вставляй ссылки на товары каталога в answer: виджет покажет точные ссылки из каталога.';

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
      page = candidate;
      let args = object(item.arguments);
      if (!args && typeof item.arguments === 'string') {
        try { args = object(JSON.parse(item.arguments)); } catch { /* Invalid arguments are rejected by the caller. */ }
      }
      pageCursor = args?.cursor;
    }
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
      const session = await this.request('/agents/sessions', input.signal, {
        agent_id: this.agentId, agent: { text: { format: outputFormat } }, environment: { type: 'none' }, input: input.message + contract,
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
        const result = await this.request(`${path}/items?limit=100&order=desc`, input.signal);
        if (result.has_more === true && Array.isArray(result.data) && result.data.every((item) => object(item)?.turn_id === turn.id)) {
          throw new Error('Platform agent turn contains too many items to read safely');
        }
        const parsed = extractAgentResult(Array.isArray(result.data) ? [...result.data].reverse() : [], turn.id);
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
