import { describe, expect, it, vi } from 'vitest';
import { CATALOG_MUTATION_LOCK_IDENTITY } from '../src/catalog/catalogFreshness.js';
import { ProductRepository } from '../src/db/repositories.js';

describe('ProductRepository catalog freshness integration', () => {
  it('replaces a same-source product snapshot instead of retaining removed specs and raw fields', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('INSERT INTO products')) {
        return {
        rowCount: 1,
        rows: [{
          id: 'product-1',
          name: 'Current product',
          specs: { current: 'yes' },
          raw: { sourceType: 'site', pageType: 'product' },
          created_at: new Date(),
          updated_at: new Date()
        }]
        };
      }
      return { rowCount: 0, rows: [] };
    });
    const release = vi.fn();
    const repository = new ProductRepository({
      connect: vi.fn(async () => ({ query, release }))
    } as never);

    await repository.upsertProduct({
      sourceUrl: 'https://bakautprof.ru/catalog/generators/current-product/',
      name: 'Current product',
      description: undefined,
      specs: { current: 'yes' },
      raw: { sourceType: 'site', pageType: 'product' }
    });

    const upsertSql = String(query.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO products'))?.[0]);
    expect(upsertSql).toContain('specs = EXCLUDED.specs');
    expect(upsertSql).toContain('raw = EXCLUDED.raw');
    expect(upsertSql).not.toContain('products.specs || EXCLUDED.specs');
    expect(upsertSql).not.toContain('products.raw || EXCLUDED.raw');
    expect(upsertSql).toContain('description = EXCLUDED.description');
    expect(upsertSql).toContain('price = EXCLUDED.price');
    expect(upsertSql).toContain('products.source_content_hash IS DISTINCT FROM EXCLUDED.source_content_hash');
    expect(query.mock.calls[0]?.[0]).toBe('BEGIN');
    expect(query.mock.calls.at(-1)?.[0]).toBe('COMMIT');
    expect(release).toHaveBeenCalledOnce();
    const productWriteIndex = query.mock.calls.findIndex(([sql]) => String(sql).includes('INSERT INTO products'));
    const factDeleteIndex = query.mock.calls.findIndex(([sql]) => String(sql).includes('DELETE FROM product_facts'));
    const conflictRefreshIndex = query.mock.calls.findIndex(([sql]) =>
      String(sql).includes('SELECT attribute') && String(sql).includes('FROM product_facts')
    );
    expect(productWriteIndex).toBeGreaterThan(0);
    expect(factDeleteIndex).toBeGreaterThan(productWriteIndex);
    expect(conflictRefreshIndex).toBeGreaterThan(factDeleteIndex);
  });

  it('rolls back the product snapshot when source-fact replacement fails', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('INSERT INTO products')) {
        return {
          rowCount: 1,
          rows: [{
            id: 'product-rollback',
            name: 'Rollback product',
            specs: { power: '5 kW' },
            raw: { sourceType: 'site', pageType: 'product' },
            created_at: new Date(),
            updated_at: new Date()
          }]
        };
      }
      if (sql.includes('INSERT INTO product_facts')) throw new Error('fact write failed');
      return { rowCount: 0, rows: [] };
    });
    const release = vi.fn();
    const repository = new ProductRepository({
      connect: vi.fn(async () => ({ query, release }))
    } as never);

    await expect(repository.upsertProduct({
      sourceUrl: 'https://bakautprof.ru/catalog/generators/rollback-product/',
      name: 'Rollback product',
      specs: { power: '5 kW' },
      raw: { sourceType: 'site', pageType: 'product' }
    })).rejects.toThrow('fact write failed');

    expect(query.mock.calls[0]?.[0]).toBe('BEGIN');
    expect(query.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');
    expect(query.mock.calls.some(([sql]) => sql === 'COMMIT')).toBe(false);
    expect(release).toHaveBeenCalledOnce();
  });

  it('binds verified facts to the current catalog snapshot and supersedes an older value from the same source atomically', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('INSERT INTO verified_product_facts')) {
        return {
          rowCount: 1,
          rows: [{
            id: 'verified-fact-1',
            product_id: '11111111-1111-4111-8111-111111111111',
            product_key: 'current product',
            product_name: 'Current product',
            attribute: 'nominal power',
            value: '5 kW',
            source_type: 'web',
            source_url: 'https://manufacturer.example/current-product',
            source_title: 'Official specification',
            evidence: 'Nominal power 5 kW',
            confidence: 'high',
            status: 'active',
            catalog_source_hash: 'catalog-hash-current',
            source_fingerprint: 'source-fingerprint-current',
            first_seen_at: new Date(),
            last_verified_at: new Date(),
            hit_count: 0,
            created_at: new Date(),
            updated_at: new Date()
          }]
        };
      }
      return { rowCount: 0, rows: [] };
    });
    const release = vi.fn();
    const repository = new ProductRepository({
      connect: vi.fn(async () => ({ query, release }))
    } as never);

    const saved = await repository.upsertVerifiedProductFact({
      productId: '11111111-1111-4111-8111-111111111111',
      productName: 'Current product',
      attribute: 'nominal power',
      value: '5 kW',
      sourceType: 'web',
      sourceUrl: 'https://manufacturer.example/current-product',
      sourceTitle: 'Official specification',
      evidence: 'Nominal power 5 kW',
      confidence: 'high'
    });

    const writeSql = String(query.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO verified_product_facts'))?.[0]);
    expect(query.mock.calls[0]?.[0]).toBe('BEGIN');
    expect(writeSql).toContain('source_content_hash');
    expect(writeSql).toContain('catalog_source_hash');
    expect(writeSql).toContain('source_fingerprint');
    expect(writeSql).toContain("status = 'superseded'");
    expect(writeSql).toContain('coalesce(source_url');
    expect(query.mock.calls.at(-1)?.[0]).toBe('COMMIT');
    expect(release).toHaveBeenCalledOnce();
    expect(saved).toMatchObject({
      catalogSourceHash: 'catalog-hash-current',
      sourceFingerprint: 'source-fingerprint-current'
    });
  });

  it('does not return a product-bound verified fact after its catalog fingerprint changes', async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 0, rows: [] });
    const repository = new ProductRepository({ query } as never);

    await repository.searchVerifiedProductFacts({
      productIds: ['11111111-1111-4111-8111-111111111111'],
      sourceTypes: ['web']
    });

    const lookupSql = String(query.mock.calls[0]?.[0]);
    expect(lookupSql).toContain('LEFT JOIN products');
    expect(lookupSql).toContain('catalog_source_hash = product.source_content_hash');
    const emptyExactIdsGuard = lookupSql.indexOf("$2::uuid[] = '{}'::uuid[]");
    const nameOnlyFactFallback = lookupSql.indexOf('fact.product_id IS NULL');
    expect(emptyExactIdsGuard).toBeGreaterThanOrEqual(0);
    expect(nameOnlyFactFallback).toBeGreaterThan(emptyExactIdsGuard);
    expect(lookupSql).toContain("$2::uuid[] <> '{}'::uuid[]");
    expect(lookupSql).toContain('fact.product_id = ANY($2::uuid[])');
  });

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

  it('cancels an aborted product search on its leased pool client', async () => {
    let resolveQueryStarted!: () => void;
    const queryStarted = new Promise<void>((resolve) => {
      resolveQueryStarted = resolve;
    });
    const query = vi.fn((submitted: { callback?: (error: Error) => void }) => {
      resolveQueryStarted();
      return submitted;
    });
    const cancel = vi.fn((_client: unknown, submitted: { callback?: (error: Error) => void }) => {
      submitted.callback?.(new Error('query cancelled'));
    });
    const release = vi.fn();
    const repository = new ProductRepository({
      totalCount: 1,
      idleCount: 1,
      connect: vi.fn(async () => ({ query, cancel, release }))
    } as never);
    const controller = new AbortController();
    const pending = repository.searchProducts('generator', 4, { signal: controller.signal });

    await queryStarted;
    controller.abort();

    await expect(pending).rejects.toThrow('query cancelled');
    expect(cancel).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledWith(false);
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
