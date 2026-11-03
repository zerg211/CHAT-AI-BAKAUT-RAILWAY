import { describe, expect, it, vi } from 'vitest';
import { extractAgentResult, PlatformAgentClient } from '../src/ai/platformAgentClient.js';
import { normalizePublicCardDisplay, normalizePublicProductCards } from '../src/shared/publicChatHistory.js';

describe('Platform agent result', () => {
  it('collects all pages of the current turn and ignores earlier turns', () => {
    const first = { group: 'matches', count: 2, source_revision: 'r1', items: [{ product_id: 'p1' }], has_more: true, next_cursor: 'next' };
    const last = { ...first, items: [{ product_id: 'p2' }], has_more: false, next_cursor: null };
    const call = (page: unknown, args: unknown) => ({ turn_id: 'new', type: 'mcp_call', name: 'search_products', arguments: args, status: 'completed', output: { content: [{ type: 'text', text: JSON.stringify(page) }] } });
    const result = extractAgentResult([
      { turn_id: 'old', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: 'old' }] },
      call(first, {}), call(last, { cursor: 'next' }),
      { turn_id: 'new', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: 'Найдены товары' }] }
    ], 'new');
    expect(result.answer).toBe('Найдены товары');
    expect(result.page?.items).toEqual([{ product_id: 'p1' }, { product_id: 'p2' }]);
    expect(result.page?.has_more).toBe(false);
  });
  it('fails instead of presenting an incomplete list as complete', () => {
    const page = { group: 'matches', count: 20, items: [{ product_id: 'p1' }], has_more: true, next_cursor: 'next' };
    expect(() => extractAgentResult([{ turn_id: 'new', type: 'mcp_call', name: 'search_products', arguments: {}, status: 'completed', output: { structuredContent: page } }], 'new')).toThrow('incomplete');
  });

  it('continues the same agent session with an idempotency key', async () => {
    const replies = [
      { data: [{ id: 'turn-old' }] }, {}, {},
      { data: [{ id: 'turn-new', status: 'completed', usage: { total_tokens: 12 } }] },
      { data: [{ turn_id: 'turn-new', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: 'Готово' }] }] }
    ];
    const transport = vi.fn(async () => new Response(JSON.stringify(replies.shift()), { status: 200, headers: { 'content-type': 'application/json' } }));
    const client = new PlatformAgentClient('test-key', 'agent-id', [], transport as typeof fetch);
    const result = await client.run({ sessionId: 'session-id', message: 'Дальше', idempotencyKey: 'message-id' });
    expect(result.sessionId).toBe('session-id');
    expect(result.answer).toBe('Готово');
    const [, options] = transport.mock.calls[1] as unknown as [string, RequestInit];
    expect((options.headers as Record<string, string>)['Idempotency-Key']).toBe('message-id');
    expect(JSON.parse(String(options.body)).events[0].input[0].content[0].text).toContain('Дальше');
  });

  it('creates a session using the saved agent and stores its ID before polling', async () => {
    const replies = [
      { instructions: 'Исходные инструкции агента' }, { id: 'new-session' }, {}, { data: [{ id: 'new-turn', status: 'completed' }] },
      { data: [{ turn_id: 'new-turn', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: 'Ответ' }] }] }
    ];
    const transport = vi.fn(async () => new Response(JSON.stringify(replies.shift()), { status: 200, headers: { 'content-type': 'application/json' } }));
    const onSession = vi.fn(async () => undefined);
    const client = new PlatformAgentClient('test-key', 'saved-agent', ['vault-id'], transport as typeof fetch);
    const result = await client.run({ message: 'Подберите генератор', idempotencyKey: 'local-turn', onSession });
    const [, options] = transport.mock.calls[1] as unknown as [string, RequestInit];
    expect(JSON.parse(String(options.body))).toMatchObject({ agent_id: 'saved-agent', vault_ids: ['vault-id'], agent: { instructions: expect.stringContaining('Исходные инструкции агента'), text: { format: { type: 'json_schema' } } } });
    expect(onSession).toHaveBeenCalledWith('new-session');
    expect(result.answer).toBe('Ответ');
  });

  it('keeps the next-page control when restoring chat history', () => {
    expect(normalizePublicCardDisplay({ initialVisibleCount: 10, hasMore: true })).toEqual({ initialVisibleCount: 10, hasMore: true });
  });

  it('preserves more than 50 preloaded cards in chat history', () => {
    const cards = Array.from({ length: 70 }, (_, id) => ({ id: String(id), name: `Генератор ${id}`, specs: {}, reasons: [], caveats: [] }));
    expect(normalizePublicProductCards(cards)).toHaveLength(70);
  });
});
