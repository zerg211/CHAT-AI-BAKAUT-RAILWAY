import { describe, expect, it, vi } from 'vitest';

const coverageCalls = vi.hoisted(() => vi.fn(async (target: string) => {
  const rows: Record<string, { total: number; embedded: number; usable: number; coverage: number }> = {
    products: { total: 100, embedded: 12, usable: 12, coverage: 0.12 },
    catalog_pages: { total: 20, embedded: 0, usable: 0, coverage: 0 },
    troubleshooting_cases: { total: 1, embedded: 1, usable: 1, coverage: 1 }
  };
  return { target, ...rows[target] };
}));

process.env.ADMIN_PASSWORD = 'test-admin-secret';

vi.mock('../src/db/repositories.js', () => ({
  ProductRepository: class {
    getEmbeddingCoverage = coverageCalls;
    listProducts = vi.fn(async () => []);
    listOpenConflicts = vi.fn(async () => []);
  },
  ConversationRepository: class {
    listSessions = vi.fn(async () => []);
    listSessionStats = vi.fn(async () => ({}));
    getSession = vi.fn(async () => null);
    listMessages = vi.fn(async () => []);
    listTurns = vi.fn(async () => []);
    deleteSession = vi.fn(async () => null);
    expireInactiveSessions = vi.fn(async () => 0);
    deleteOldEmptyWidgetSessions = vi.fn(async () => 0);
    deleteEmptyNonWidgetSessions = vi.fn(async () => 0);
  },
  LeadRepository: class {
    listLeads = vi.fn(async () => []);
  }
}));

const { buildApp } = await import('../src/app.js');

describe('admin embedding coverage endpoint', () => {
  it('requires admin authorization', async () => {
    const app = await buildApp();
    const response = await app.inject({ method: 'GET', url: '/api/admin/embedding-coverage' });
    await app.close();

    expect(response.statusCode).toBe(401);
  }, 12_000);

  it('returns coverage for all embedding targets', async () => {
    const app = await buildApp();
    const response = await app.inject({
      method: 'GET',
      url: '/api/admin/embedding-coverage',
      headers: { authorization: 'Bearer test-admin-secret' }
    });
    await app.close();

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      model: 'text-embedding-3-small',
      minCoverage: 0.05,
      targets: {
        products: { total: 100, embedded: 12, usable: 12, coverage: 0.12, ready: true },
        catalog_pages: { total: 20, embedded: 0, usable: 0, coverage: 0, ready: false },
        troubleshooting_cases: { total: 1, embedded: 1, usable: 1, coverage: 1, ready: true }
      },
      finalReady: false
    });
    expect(coverageCalls).toHaveBeenCalledWith('products', 'text-embedding-3-small');
    expect(coverageCalls).toHaveBeenCalledWith('catalog_pages', 'text-embedding-3-small');
    expect(coverageCalls).toHaveBeenCalledWith('troubleshooting_cases', 'text-embedding-3-small');
  }, 12_000);
});
