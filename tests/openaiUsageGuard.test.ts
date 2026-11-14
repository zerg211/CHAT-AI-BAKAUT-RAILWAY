import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { lunaPricing } from '../src/ai/modelPricing.js';
import { config } from '../src/config.js';
import { pool } from '../src/db/pool.js';
import {
  extractOpenAIUsage,
  estimateRecordedUsageCost,
  requestSourceFromContext,
  runWithOpenAIUsageContext,
  currentOpenAIUsageContext,
  reconcilePlatformAgentUsage,
  bindOpenAIUsageReservation,
  recordOpenAIUsageOnce
  , assertOpenAIUsageBudget
} from '../src/ai/openaiUsageGuard.js';

describe('OpenAI usage guard', () => {
  beforeEach(() => vi.spyOn(Date, 'now').mockReturnValue(Date.parse(lunaPricing.verifiedAt)));
  afterEach(() => vi.restoreAllMocks());
  it('accounts for all stages and rejects a second owner of the same operation', async () => {
    const oldEnabled = config.OPENAI_USAGE_GUARD_ENABLED, oldBudget = config.OPENAI_DAILY_TOKEN_BUDGET;
    const oldMinimum = config.OPENAI_BUDGET_GUARD_RESERVE_TOKENS;
    config.OPENAI_USAGE_GUARD_ENABLED = true; config.OPENAI_DAILY_TOKEN_BUDGET = 100; config.OPENAI_BUDGET_GUARD_RESERVE_TOKENS = 1;
    const rows: { key: string; reserved: number; actual: number | null }[] = [];
    let tail = Promise.resolve();
    vi.spyOn(pool, 'connect').mockImplementation(async () => {
      let unlock = () => {};
      const query = async (sql: string, args: unknown[] = []) => {
        if (sql.includes('pg_advisory_xact_lock')) {
          const prior = tail; tail = new Promise<void>(resolve => { unlock = resolve; }); await prior;
        } else if (sql.includes('matching_operations')) {
          return { rows: [{ committed_tokens: rows.reduce((sum, row) => sum + (row.actual ?? row.reserved), 0), matching_operations: rows.filter(row => row.key === args[2]).length }] };
        } else if (sql.includes('AS used_tokens')) {
          return { rows: [{ used_tokens: rows.reduce((sum, row) => sum + (row.actual ?? 0), 0), reserved_tokens: rows.reduce((sum, row) => sum + (row.actual === null ? row.reserved : 0), 0) }] };
        } else if (sql.includes('INSERT INTO openai_usage_reservations')) {
          rows.push({ key: String(args[8]), reserved: Number(args[6]), actual: null }); return { rows: [{ id: String(rows.length) }] };
        } else if (sql === 'COMMIT' || sql === 'ROLLBACK') unlock();
        return { rows: [] };
      };
      return { query, release: () => {} } as never;
    });
    try {
      const run = <T>(fn: () => Promise<T>) => runWithOpenAIUsageContext({ sessionId: 's', turnId: 't' }, fn);
      await run(() => assertOpenAIUsageBudget('platform_agent', 'model', 30, 'initial'));
      rows[0].actual = 20;
      await run(() => assertOpenAIUsageBudget('platform_agent', 'model', 50, 'catalog_recompose'));
      rows[1].actual = 40;
      const owners = await Promise.allSettled([run(() => assertOpenAIUsageBudget('platform_agent', 'model', 40, 'catalog_price_recompose')),
        run(() => assertOpenAIUsageBudget('platform_agent', 'model', 40, 'catalog_price_recompose'))]);
      expect(owners.filter(result => result.status === 'fulfilled')).toHaveLength(1);
      expect(rows.reduce((sum, row) => sum + (row.actual ?? row.reserved), 0)).toBe(100);
      await expect(run(() => assertOpenAIUsageBudget('platform_agent', 'model', 1, 'another'))).rejects.toThrow('turn reservation unavailable');
      expect(rows).toHaveLength(3);
    } finally {
      config.OPENAI_USAGE_GUARD_ENABLED = oldEnabled; config.OPENAI_DAILY_TOKEN_BUDGET = oldBudget; config.OPENAI_BUDGET_GUARD_RESERVE_TOKENS = oldMinimum;
    }
  });
  it('classifies production headless browser traffic as production live tests', () => {
    expect(requestSourceFromContext({
      pageUrl: 'https://bakautprof.ru/catalog/generatory/',
      userAgent: 'Mozilla/5.0 HeadlessChrome/124.0'
    })).toBe('production_live_test');
  });

  it('keeps normal production widget traffic separate from test traffic', () => {
    expect(requestSourceFromContext({
      pageUrl: 'https://bakautprof.ru/',
      userAgent: 'Mozilla/5.0 Chrome/124.0'
    })).toBe('production_widget');
    expect(requestSourceFromContext({
      pageUrl: 'https://bakautprof.ru.evil.example/',
      userAgent: 'HeadlessChrome/124.0'
    })).toBe('automated_browser');
  });

  it('propagates session and turn context across async work', async () => {
    await runWithOpenAIUsageContext({ sessionId: 'session-1', turnId: 'turn-1' }, async () => {
      await Promise.resolve();
      expect(currentOpenAIUsageContext()).toMatchObject({ sessionId: 'session-1', turnId: 'turn-1' });
    });
  });

  it('extracts token usage including reasoning tokens', () => {
    expect(extractOpenAIUsage({
      usage: {
        input_tokens: 100,
        output_tokens: 40,
        total_tokens: 140,
        output_tokens_details: { reasoning_tokens: 12 }
      }
    })).toEqual({
      inputTokens: 100,
      cachedInputTokens: null,
      outputTokens: 40,
      reasoningTokens: 12,
      totalTokens: 140
    });
  });

  it('records standard cached-token pricing separately from reservation ceilings', () => {
    expect(estimateRecordedUsageCost('gpt-5.6-luna', {
      service_tier: 'default',
      usage: { input_tokens: 1000, input_tokens_details: { cached_tokens: 500 }, output_tokens: 100 }
    })).toMatchObject({ costUsd: 0.00023, costBasis: 'standard_token_rate_estimate', cachedInputTokens: 500 });
  });

  it('keeps usage but refuses a monetary estimate when the saved rates are stale', () => {
    vi.mocked(Date.now).mockReturnValue(Date.parse(lunaPricing.verifiedAt) + 31 * 86_400_000);
    expect(estimateRecordedUsageCost('gpt-5.6-luna', {
      service_tier: 'default',
      usage: { input_tokens: 1000, input_tokens_details: { cached_tokens: 500 }, output_tokens: 100 }
    })).toMatchObject({ costUsd: null, costBasis: 'unavailable', cachedInputTokens: 500 });
  });

  it('does not invent standard prices for missing usage, missing cache or unsupported tiers', () => {
    for (const response of [ {}, { usage: { input_tokens: null, output_tokens: 0 } },
      { service_tier: 'default', usage: { input_tokens: 100, output_tokens: 10 } },
      { service_tier: 'priority', usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 0 }, output_tokens: 10 } }
    ]) expect(estimateRecordedUsageCost('gpt-5.6-luna', response).costUsd).toBeNull();
    expect(extractOpenAIUsage({usage: {input_tokens: null, output_tokens: -1, total_tokens: false}}))
      .toMatchObject({inputTokens: null, outputTokens: null, totalTokens: null});
  });

  it('reconciles a late platform usage value into the existing event and its own message', async () => {
    const previousKey = config.OPENAI_API_KEY, previousAgent = config.OPENAI_PLATFORM_AGENT_ID;
    config.OPENAI_API_KEY = 'test-key'; config.OPENAI_PLATFORM_AGENT_ID = 'test-agent';
    try {
      vi.spyOn(pool, 'query').mockResolvedValue({ rows: [{ id: 'event', session_id: 'session', turn_id: 'turn',
        response_id: 'provider-turn', agent_session_id: 'provider-session', model: 'gpt-6-luna' }], rowCount: 1 } as never);
      const query = vi.fn().mockResolvedValue({ rowCount: 1, rows: [] });
      const release = vi.fn();
      vi.spyOn(pool, 'connect').mockResolvedValue({ query, release } as never);
      const transport = vi.fn(async () => new Response(JSON.stringify({ id: 'provider-turn', usage: {
        input_tokens: 100, input_tokens_details: { cached_tokens: 40 }, output_tokens: 20,
        output_tokens_details: { reasoning_tokens: 10 }, total_tokens: 120
      } }), { status: 200 })) as unknown as typeof fetch;
      await reconcilePlatformAgentUsage(transport);
      const eventUpdate = query.mock.calls.find((call: unknown[]) => String(call[0]).includes('UPDATE openai_usage_events'));
      expect(eventUpdate?.[1]).toEqual(expect.arrayContaining(['event', 100, 20, 10, 120, 'provider-turn']));
      expect(query.mock.calls.some((call: unknown[]) => String(call[0]).includes('UPDATE messages'))).toBe(true);
      expect(query.mock.calls.some((call: unknown[]) => String(call[0]).includes('UPDATE openai_usage_reservations'))).toBe(true);
      expect(query.mock.calls.some((call: unknown[]) => call[0] === 'COMMIT')).toBe(true);
      expect(release).toHaveBeenCalledOnce();
    } finally { config.OPENAI_API_KEY = previousKey; config.OPENAI_PLATFORM_AGENT_ID = previousAgent; }
  });

  it('keeps missing or mismatched platform usage pending', async () => {
    const previousKey = config.OPENAI_API_KEY, previousAgent = config.OPENAI_PLATFORM_AGENT_ID;
    config.OPENAI_API_KEY = 'test-key'; config.OPENAI_PLATFORM_AGENT_ID = 'test-agent';
    try {
      vi.spyOn(pool, 'query').mockResolvedValue({ rows: [{ id: 'event', session_id: 'session', turn_id: 'turn',
        response_id: 'provider-turn', agent_session_id: 'provider-session', model: 'gpt-6-luna' }], rowCount: 1 } as never);
      const connect = vi.spyOn(pool, 'connect');
      for (const body of [{ id: 'provider-turn', usage: null }, { id: 'other-turn', usage: { total_tokens: 5 } }]) {
        await reconcilePlatformAgentUsage(vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch);
      }
      expect(connect).not.toHaveBeenCalled();
    } finally { config.OPENAI_API_KEY = previousKey; config.OPENAI_PLATFORM_AGENT_ID = previousAgent; }
  });

  it('upgrades one pending event with late actual usage and retains its reservation until then', async () => {
    let eventCount = 0;
    const query = vi.fn(async (sql: string, _args?: unknown[]) => {
      if (sql.startsWith('SELECT 1 FROM openai_usage_events')) return { rowCount: eventCount, rows: eventCount ? [{ exists: 1 }] : [] };
      if (sql.includes('INSERT INTO openai_usage_events')) eventCount++;
      return { rowCount: 1, rows: [] };
    });
    vi.spyOn(pool, 'connect').mockResolvedValue({ query, release: vi.fn() } as never);
    const response: { id: string; service_tier: string; usage: Record<string, unknown> | null } = {
      id: 'resp_late', service_tier: 'default', usage: null };
    bindOpenAIUsageReservation(response, 'own-reservation');
    await runWithOpenAIUsageContext({ sessionId: 'own-session', turnId: 'own-turn' }, async () => {
      await recordOpenAIUsageOnce('platform_agent', lunaPricing.model, response);
      expect(eventCount).toBe(1);
      expect(query.mock.calls.some(([sql]) => sql.includes('UPDATE openai_usage_reservations'))).toBe(false);
      response.usage = { input_tokens: 1000, input_tokens_details: { cached_tokens: 500 }, output_tokens: 100, total_tokens: 1100 };
      await recordOpenAIUsageOnce('platform_agent', lunaPricing.model, response);
      await recordOpenAIUsageOnce('platform_agent', lunaPricing.model, { ...response });
    });
    expect(eventCount).toBe(1);
    const update = query.mock.calls.find(([sql]) => sql.includes('UPDATE openai_usage_events'));
    expect(update?.[0]).toContain('WHERE stage=$1 AND response_id=$2');
    expect(update?.[1]).toEqual(expect.arrayContaining(['platform_agent', 'resp_late', 1000, 100, 1100]));
    const metadata = JSON.parse(String(update?.[1]?.[7]));
    expect(metadata).toMatchObject({ hasUsage: true, cachedInputTokens: 500, reservationId: 'own-reservation', costBasis: 'standard_token_rate_estimate' });
    const reserveUpdate = query.mock.calls.find(([sql]) => sql.includes('UPDATE openai_usage_reservations'));
    expect(reserveUpdate?.[1]).toEqual(['own-reservation', 1100]);
  });

  it('records a recovered catalog web-search receipt only once per provider response', async () => {
    let eventCount = 0;
    const query = vi.fn(async (sql: string) => {
      if (sql.startsWith('SELECT 1 FROM openai_usage_events')) return { rowCount: eventCount, rows: [] };
      if (sql.includes('INSERT INTO openai_usage_events')) eventCount++;
      return { rowCount: 1, rows: [] };
    });
    vi.spyOn(pool, 'connect').mockResolvedValue({ query, release: vi.fn() } as never);
    await runWithOpenAIUsageContext({ sessionId: 'session', turnId: 'turn' }, async () => {
      for (let i = 0; i < 2; i++) {
        const receipt = { id: 'same-search', usage: { input_tokens: 30, output_tokens: 10, total_tokens: 40 } };
        bindOpenAIUsageReservation(receipt, 'fixture-reservation');
        await recordOpenAIUsageOnce('catalog_web_search', 'test-model', receipt);
      }
    });
    expect(eventCount).toBe(1);
  });

  it('reconciles cancelled controlled responses without an agent session through GET only and settles their exact reservation', async () => {
    const previousKey = config.OPENAI_API_KEY, previousAgent = config.OPENAI_PLATFORM_AGENT_ID;
    config.OPENAI_API_KEY = 'test-key'; config.OPENAI_PLATFORM_AGENT_ID = 'test-agent';
    try {
      const candidates = vi.spyOn(pool, 'query').mockResolvedValue({ rows: [{ id: 'event', session_id: 'own-session', turn_id: 'own-turn',
        response_id: 'resp_cancelled', agent_session_id: '', model: lunaPricing.model, reservation_id: 'own-reservation' }], rowCount: 1 } as never);
      let inserted = 0;
      const query = vi.fn(async (sql: string, _args?: unknown[]) => {
        if (sql.startsWith('SELECT 1 FROM openai_usage_events')) return { rowCount: inserted, rows: inserted ? [{ exists: 1 }] : [] };
        if (sql.includes('INSERT INTO openai_usage_events')) inserted++;
        return { rowCount: 1, rows: [] };
      });
      const connect = vi.spyOn(pool, 'connect').mockResolvedValue({ query, release: vi.fn() } as never);
      const pending = { id: 'resp_cancelled', service_tier: 'default', usage: null };
      bindOpenAIUsageReservation(pending, 'own-reservation');
      await runWithOpenAIUsageContext({ sessionId: 'own-session', turnId: 'own-turn' }, async () =>
        recordOpenAIUsageOnce('platform_agent', lunaPricing.model, pending));
      expect(inserted).toBe(1);
      let usage: Record<string, unknown> | null = null;
      const transport = vi.fn(async (_url: string | URL, _init?: RequestInit) => Response.json({ id: 'resp_cancelled', status: 'cancelled',
        service_tier: 'default', usage }));
      await reconcilePlatformAgentUsage(transport as typeof fetch);
      expect(connect).toHaveBeenCalledTimes(1);
      expect(query.mock.calls.some(([sql]) => sql.includes('UPDATE openai_usage_reservations'))).toBe(false);
      usage = { input_tokens: 100, input_tokens_details: { cached_tokens: 40 }, output_tokens: 20, total_tokens: 120 };
      await reconcilePlatformAgentUsage(transport as typeof fetch);
      expect(transport.mock.calls).toHaveLength(2);
      for (const [url, init] of transport.mock.calls) {
        expect(new URL(url).pathname).toBe('/v1/responses/resp_cancelled'); expect(init?.method).toBe('GET');
      }
      expect(String(candidates.mock.calls[0]?.[0])).toContain('LEFT JOIN platform_agent_sessions');
      const update = query.mock.calls.find(([sql]) => sql.includes('UPDATE openai_usage_reservations'));
      expect(update?.[0]).toContain('WHERE id::text=$1 AND session_id=$3 AND turn_id=$4');
      expect(update?.[1]).toEqual(['own-reservation', 120, 'own-session', 'own-turn']);
      expect(inserted).toBe(1);
      expect(query.mock.calls.some(([sql, args]) => sql.includes('UPDATE messages') && args?.[3] === 'resp_cancelled')).toBe(true);
    } finally { config.OPENAI_API_KEY = previousKey; config.OPENAI_PLATFORM_AGENT_ID = previousAgent; }
  });

  it('recovers a missing pending event from its durable controlled checkpoint without a duplicate or raw error disclosure', async () => {
    const previousKey = config.OPENAI_API_KEY, previousAgent = config.OPENAI_PLATFORM_AGENT_ID;
    config.OPENAI_API_KEY = 'test-key'; config.OPENAI_PLATFORM_AGENT_ID = 'test-agent';
    try {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const failedQuery = vi.fn(async (sql: string) => {
        if (sql.includes('INSERT INTO openai_usage_events')) throw new Error('sensitive-buyer@example.org database detail');
        return { rowCount: 0, rows: [] };
      });
      const connect = vi.spyOn(pool, 'connect').mockResolvedValueOnce({ query: failedQuery, release: vi.fn() } as never);
      const pending = { id: 'resp_checkpoint', usage: null };
      bindOpenAIUsageReservation(pending, 'checkpoint-reservation');
      await recordOpenAIUsageOnce('platform_agent', lunaPricing.model, pending);
      expect(JSON.stringify(warn.mock.calls)).not.toContain('sensitive-buyer');
      expect(failedQuery.mock.calls.some(([sql]) => sql.includes('UPDATE openai_usage_reservations'))).toBe(false);
      const candidates = vi.spyOn(pool, 'query').mockResolvedValue({ rows: [{ id: null, session_id: 'checkpoint-session', turn_id: 'checkpoint-turn',
        response_id: 'resp_checkpoint', agent_session_id: '', model: lunaPricing.model, reservation_id: 'checkpoint-reservation' }], rowCount: 1 } as never);
      let eventId: string | null = null;
      let inserted = 0;
      const query = vi.fn(async (sql: string, _args?: unknown[]) => {
        if (sql.startsWith('SELECT id FROM openai_usage_events')) return { rowCount: eventId ? 1 : 0, rows: eventId ? [{ id: eventId }] : [] };
        if (sql.includes('INSERT INTO openai_usage_events')) { inserted++; eventId = 'recovered-event'; return { rowCount: 1, rows: [{ id: eventId }] }; }
        return { rowCount: 1, rows: [] };
      });
      connect.mockResolvedValue({ query, release: vi.fn() } as never);
      const transport = vi.fn(async (_url: string | URL, _init?: RequestInit) => Response.json({ id: 'resp_checkpoint', status: 'cancelled',
        service_tier: 'default', usage: { input_tokens: 10, input_tokens_details: { cached_tokens: 0 }, output_tokens: 2, total_tokens: 12 } }));
      await reconcilePlatformAgentUsage(transport as typeof fetch);
      await reconcilePlatformAgentUsage(transport as typeof fetch); // The second worker may hold an already selected stale candidate.
      expect(inserted).toBe(1);
      const sql = String(candidates.mock.calls[0]?.[0]);
      expect(sql).toContain("cp.payload->>'kind'='controlled_response'"); expect(sql).toContain('NOT EXISTS');
      const lock = query.mock.calls.findIndex(([sql]) => sql.includes('pg_advisory_xact_lock'));
      const lookup = query.mock.calls.findIndex(([sql]) => sql.startsWith('SELECT id FROM openai_usage_events'));
      expect(lock).toBeGreaterThanOrEqual(0); expect(lookup).toBeGreaterThan(lock);
      expect(query.mock.calls.filter(([sql]) => sql.includes('UPDATE openai_usage_events')).every(([, args]) => args?.[0] === 'recovered-event')).toBe(true);
      expect(query.mock.calls.filter(([sql]) => sql.includes('UPDATE openai_usage_reservations')).every(([, args]) => args?.[0] === 'checkpoint-reservation')).toBe(true);
      expect(transport.mock.calls.every(([url, init]) => new URL(url).pathname === '/v1/responses/resp_checkpoint' && init?.method === 'GET')).toBe(true);
    } finally { config.OPENAI_API_KEY = previousKey; config.OPENAI_PLATFORM_AGENT_ID = previousAgent; }
  });

  it('retains original and repair usage after the submission checkpoint has been replaced', async () => {
    const previousKey = config.OPENAI_API_KEY, previousAgent = config.OPENAI_PLATFORM_AGENT_ID;
    config.OPENAI_API_KEY = 'test-key'; config.OPENAI_PLATFORM_AGENT_ID = 'test-agent';
    try {
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const failedQuery = vi.fn(async (sql: string) => {
        if (sql.includes('INSERT INTO openai_usage_events')) throw new Error('temporary ledger outage');
        return { rows: [], rowCount: 0 };
      });
      const connect = vi.spyOn(pool, 'connect').mockResolvedValueOnce({ query: failedQuery, release: vi.fn() } as never);
      const original = { id: 'turn_original', usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 } };
      bindOpenAIUsageReservation(original, 'original-reservation');
      await runWithOpenAIUsageContext({ sessionId: 'same-session', turnId: 'same-turn' }, async () =>
        recordOpenAIUsageOnce('platform_agent', 'gpt-6-luna', original));
      expect(failedQuery.mock.calls.some(([sql]) => sql.includes('ROLLBACK'))).toBe(true);

      // The durable per-response receipt retains the original identity/session;
      // the mutable submission checkpoint now belongs to resp_repair.
      const candidates = vi.spyOn(pool, 'query').mockResolvedValue({ rows: [
        { id: null, session_id: 'same-session', turn_id: 'same-turn', response_id: 'turn_original',
          agent_session_id: 'original-agent-session', model: 'gpt-6-luna', reservation_id: 'original-reservation' },
        { id: null, session_id: 'same-session', turn_id: 'same-turn', response_id: 'resp_repair',
          agent_session_id: '', model: 'gpt-6-luna', reservation_id: 'repair-reservation' }
      ], rowCount: 2 } as never);
      const events = new Map<string, string>();
      const reservations = new Map([['original-reservation', 'reserved'], ['repair-reservation', 'reserved']]);
      const settlements: unknown[][] = [];
      const query = vi.fn(async (sql: string, args: unknown[] = []) => {
        if (sql.startsWith('SELECT id FROM openai_usage_events')) {
          const id = events.get(String(args[0]));
          return { rows: id ? [{ id }] : [], rowCount: id ? 1 : 0 };
        }
        if (sql.includes('INSERT INTO openai_usage_events')) {
          const responseId = String(args[3]);
          expect(events.has(responseId)).toBe(false);
          const id = `event-${responseId}`;
          events.set(responseId, id);
          return { rows: [{ id }], rowCount: 1 };
        }
        if (sql.includes('UPDATE openai_usage_reservations')) {
          expect(sql).toContain("stage='platform_agent' AND status='reserved'");
          const id = String(args[0]);
          if (reservations.get(id) !== 'reserved') return { rows: [], rowCount: 0 };
          reservations.set(id, 'reconciled');
          settlements.push(args);
        }
        return { rows: [], rowCount: 1 };
      });
      connect.mockResolvedValue({ query, release: vi.fn() } as never);
      const transport = vi.fn(async (url: string | URL, _init?: RequestInit) => {
        const original = new URL(url).pathname.includes('turn_original');
        return Response.json({ id: original ? 'turn_original' : 'resp_repair', status: 'completed', model: 'gpt-6-luna',
          service_tier: 'default', usage: { input_tokens: original ? 100 : 200, input_tokens_details: { cached_tokens: 0 },
            output_tokens: 20, total_tokens: original ? 120 : 220 } });
      });
      await reconcilePlatformAgentUsage(transport as typeof fetch);
      await reconcilePlatformAgentUsage(transport as typeof fetch); // A second worker can have a stale candidate set.
      expect(events.size).toBe(2);
      expect(settlements).toEqual([
        ['original-reservation', 120, 'same-session', 'same-turn'],
        ['repair-reservation', 220, 'same-session', 'same-turn']
      ]);
      expect([...reservations.values()]).toEqual(['reconciled', 'reconciled']);
      expect(transport.mock.calls.map(([url, init]) => [new URL(url).pathname, init?.method])).toEqual([
        ['/v1/agents/sessions/original-agent-session/turns/turn_original', 'GET'], ['/v1/responses/resp_repair', 'GET'],
        ['/v1/agents/sessions/original-agent-session/turns/turn_original', 'GET'], ['/v1/responses/resp_repair', 'GET']
      ]);
      const sql = String(candidates.mock.calls[0]?.[0]);
      expect(sql).toContain('SELECT DISTINCT ON (response_id)');
      expect(sql).toContain("receipt.checkpoint='platform_agent_usage:' || e.response_id");
      expect(sql).toContain("receipt.payload->>'reservation'");
      expect(sql).toContain("cp.payload->>'kind'='platform_usage_response'");
      expect(sql).toContain("cp.checkpoint='platform_agent_usage:' || (cp.payload->>'responseId')");
      expect(query.mock.calls.filter(([sql]) => sql.includes('UPDATE messages'))
        .every(([, args]) => args?.[0] === 'same-turn' && args?.[1] === 'same-session' &&
          ['turn_original', 'resp_repair'].includes(String(args?.[3])))).toBe(true);
    } finally { config.OPENAI_API_KEY = previousKey; config.OPENAI_PLATFORM_AGENT_ID = previousAgent; }
  });
});
