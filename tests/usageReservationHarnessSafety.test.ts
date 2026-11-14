import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => { vi.unstubAllEnvs(); vi.doUnmock('../src/db/pool.js'); vi.doUnmock('../src/config.js'); vi.doUnmock('../src/ai/openaiUsageGuard.js'); vi.resetModules(); });

describe('disposable reservation harness cleanup', () => {
  it.each(['wrong endpoint', 'endpoint error', 'connect error'] as const)('performs no cleanup writes on %s', async mode => {
    vi.stubEnv('BAKAUT_TEST_DATABASE_URL', 'postgresql://fixture@127.0.0.1:55432/bakaut_acceptance_test');
    vi.stubEnv('BAKAUT_TEST_DATABASE_CONFIRM', 'bakaut_acceptance_test');
    const clientQuery = vi.fn(async (sql: string) => {
      if (sql.startsWith('SELECT current_database')) {
        if (mode === 'endpoint error') throw new Error('endpoint read failed');
        return { rows: [{ db: 'foreign', address: '127.0.0.1' }] };
      }
      return { rows: [] };
    });
    const release = vi.fn();
    const poolQuery = vi.fn();
    const end = vi.fn(async () => undefined);
    const connect = vi.fn(async () => {
      if (mode === 'connect error') throw new Error('connect failed');
      return { query: clientQuery, release };
    });
    vi.doMock('../src/db/pool.js', () => ({ pool: { connect, query: poolQuery, end } }));
    vi.doMock('../src/config.js', () => ({ config: {} }));
    vi.doMock('../src/ai/openaiUsageGuard.js', () => ({ assertOpenAIUsageBudget: vi.fn() }));
    await expect(import('./usageReservationPostgresConcurrency.integration.js')).rejects.toThrow();
    expect(poolQuery).not.toHaveBeenCalled();
    expect(clientQuery.mock.calls.every(([sql]) => !/\b(INSERT|UPDATE|DELETE)\b/i.test(sql))).toBe(true);
    expect(end).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledTimes(mode === 'connect error' ? 0 : 1);
  });

  it('ends the pool when a cleanup write fails after the fixture was written', async () => {
    vi.stubEnv('BAKAUT_TEST_DATABASE_URL', 'postgresql://fixture@127.0.0.1:55432/bakaut_acceptance_test');
    vi.stubEnv('BAKAUT_TEST_DATABASE_CONFIRM', 'bakaut_acceptance_test');
    const clientQuery = vi.fn(async (sql: string) => sql.startsWith('SELECT current_database')
      ? { rows: [{ db: 'bakaut_acceptance_test', address: '127.0.0.1' }] } : { rows: [] });
    const release = vi.fn();
    const poolQuery = vi.fn(async (sql: string) => {
      if (sql.startsWith('SELECT')) return { rows: [{ events: 0, reservations: 0 }] };
      if (sql.includes('DELETE FROM openai_usage_events')) throw new Error('cleanup failed');
      return { rows: [] };
    });
    const end = vi.fn(async () => undefined);
    const reserve = vi.fn().mockResolvedValueOnce('reservation').mockRejectedValue(new Error('budget exceeded'));
    vi.doMock('../src/db/pool.js', () => ({ pool: { connect: async () => ({ query: clientQuery, release }), query: poolQuery, end } }));
    vi.doMock('../src/config.js', () => ({ config: {} }));
    vi.doMock('../src/ai/openaiUsageGuard.js', () => ({ assertOpenAIUsageBudget: reserve }));
    await expect(import('./usageReservationPostgresConcurrency.integration.js')).rejects.toThrow('cleanup failed');
    expect(poolQuery.mock.calls.some(([sql]) => sql.includes('DELETE FROM openai_usage_reservations'))).toBe(true);
    expect(release).toHaveBeenCalledOnce();
    expect(end).toHaveBeenCalledOnce();
  });
});
