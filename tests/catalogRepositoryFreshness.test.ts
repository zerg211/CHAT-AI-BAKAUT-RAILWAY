import { describe, expect, it, vi } from 'vitest';
import { CATALOG_MUTATION_LOCK_IDENTITY } from '../src/catalog/catalogFreshness.js';
import { ProductRepository } from '../src/db/repositories.js';

describe('ProductRepository catalog freshness integration', () => {
  it('excludes inactive products and pages from buyer-facing retrieval', async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 0, rows: [] });
    const repository = new ProductRepository({ query } as never);

    await repository.searchProducts('generator', 4);
    await repository.vectorSearch([0.1, 0.2], 4);
    await repository.searchCatalogPages('delivery', 4);
    await repository.vectorSearchCatalogPages([0.1, 0.2], 4);

    expect(query.mock.calls[0][0]).toContain('is_active IS NOT FALSE');
    expect(query.mock.calls[1][0]).toContain('is_active IS NOT FALSE');
    expect(query.mock.calls[2][0]).toContain('is_active IS NOT FALSE');
    expect(query.mock.calls[3][0]).toContain('is_active IS NOT FALSE');
  });

  it('holds an advisory lock for a sync and deactivates only inside an eligible full finalize', async () => {
    const clientQuery = vi.fn()
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ acquired: true }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 'sync-run-id' }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ unlocked: true }] });
    const release = vi.fn();
    const db = {
      connect: vi.fn(async () => ({ query: clientQuery, release })),
      query: vi.fn()
    };
    const repository = new ProductRepository(db as never);

    const runId = await repository.startCatalogSource({
      type: 'site_crawl',
      location: 'https://bakautprof.ru/sitemap.xml',
      syncMode: 'full'
    });
    await repository.finishCatalogSource(runId, 'completed', { importedProducts: 10 }, undefined, {
      coverageComplete: true,
      discoveredItemCount: 10,
      syncedItemCount: 10,
      failedItemCount: 0,
      deactivateProducts: true,
      deactivatePages: false
    });

    expect(clientQuery.mock.calls[0][0]).toContain('pg_try_advisory_lock');
    expect(clientQuery.mock.calls[0][1]).toEqual([CATALOG_MUTATION_LOCK_IDENTITY]);
    expect(clientQuery.mock.calls[1][0]).toContain('INSERT INTO catalog_sync_runs');
    expect(clientQuery.mock.calls[2][0]).toContain('deactivation_eligible');
    expect(clientQuery.mock.calls[2][0]).toContain("products.raw->>'sourceType' = 'site'");
    expect(clientQuery.mock.calls[2][1]).toEqual([
      'sync-run-id',
      'completed',
      { importedProducts: 10 },
      null,
      true,
      10,
      10,
      0,
      true,
      false
    ]);
    expect(clientQuery.mock.calls[3][0]).toContain('pg_advisory_unlock');
    expect(release).toHaveBeenCalledOnce();
  });

  it('counts exactly the active records that a full sitemap run may deactivate', async () => {
    const query = vi.fn().mockResolvedValue({
      rowCount: 1,
      rows: [{ active_products: 240, active_pages: 35 }]
    });
    const repository = new ProductRepository({ query } as never);

    await expect(repository.getActiveCatalogInventoryCounts()).resolves.toEqual({ products: 240, pages: 35 });
    expect(query.mock.calls[0][0]).toContain("raw->>'sourceType' = 'site'");
    expect(query.mock.calls[0][0]).toContain('FROM catalog_pages');
    expect(query.mock.calls[0][0]).toContain('is_active');
  });

  it('fails closed when a heartbeat does not update a running sync row', async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 0, rows: [] });
    const repository = new ProductRepository({ query } as never);

    await expect(repository.heartbeatCatalogSource('missing-run')).rejects.toThrow(
      'catalog_sync_heartbeat_not_updated:missing-run'
    );
  });

  it('reports stale source state with active/inactive counts', async () => {
    const query = vi.fn().mockResolvedValue({
      rowCount: 1,
      rows: [{
        id: 'sync-run-id',
        source_type: 'site_crawl',
        source_location: 'https://bakautprof.ru/sitemap.xml',
        sync_mode: 'full',
        status: 'failed',
        coverage_complete: false,
        discovered_item_count: 10,
        synced_item_count: 8,
        failed_item_count: 2,
        started_at: new Date('2026-07-10T10:00:00.000Z'),
        heartbeat_at: new Date('2026-07-10T10:30:00.000Z'),
        finished_at: new Date('2026-07-10T11:00:00.000Z'),
        last_successful_sync_at: new Date('2026-07-09T11:00:00.000Z'),
        active_products: 100,
        inactive_products: 5,
        stale_products: 3,
        active_pages: 20,
        inactive_pages: 1,
        stale_pages: 0
      }]
    });
    const repository = new ProductRepository({ query } as never);

    const report = await repository.getCatalogFreshness(48);

    expect(report).toMatchObject({
      status: 'stale',
      syncHealth: { status: 'failed' },
      products: { active: 100, inactive: 5, stale: 3 },
      pages: { active: 20, inactive: 1, stale: 0 }
    });
  });
});
