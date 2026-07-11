import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  CATALOG_MUTATION_LOCK_IDENTITY,
  CATALOG_SYNC_HEARTBEAT_INTERVAL_MS,
  DEFAULT_CATALOG_FRESHNESS_THRESHOLDS,
  DEFAULT_CATALOG_INVENTORY_COVERAGE_THRESHOLDS,
  canDeactivateMissingCatalogRecords,
  catalogSourceContentHash,
  catalogFreshnessThresholds,
  catalogSyncLockIdentity,
  createCatalogSyncHeartbeat,
  evaluateCatalogDeactivationEligibility,
  evaluateCatalogInventoryCoverage,
  evaluateCatalogRecordFreshness,
  evaluateCatalogSyncHealth,
  type CatalogSyncRunSummary
} from '../src/catalog/catalogFreshness.js';

const hour = 60 * 60 * 1000;
const now = '2026-07-10T12:00:00.000Z';

function run(overrides: Partial<CatalogSyncRunSummary> = {}): CatalogSyncRunSummary {
  return {
    syncMode: 'full',
    status: 'completed',
    coverageComplete: true,
    failedItemCount: 0,
    startedAt: '2026-07-10T10:00:00.000Z',
    heartbeatAt: '2026-07-10T10:30:00.000Z',
    finishedAt: '2026-07-10T11:00:00.000Z',
    ...overrides
  };
}

describe('catalog freshness helpers', () => {
  it('classifies active records from the newest successful source timestamp', () => {
    const thresholds = catalogFreshnessThresholds({ recordStaleAfterMs: 24 * hour });

    expect(evaluateCatalogRecordFreshness({
      now,
      lastSeenAt: '2026-07-10T10:00:00.000Z',
      lastSyncedAt: '2026-07-08T10:00:00.000Z',
      isActive: true
    }, thresholds)).toMatchObject({
      status: 'fresh',
      referenceAt: '2026-07-10T10:00:00.000Z',
      ageMs: 2 * hour
    });

    expect(evaluateCatalogRecordFreshness({
      now,
      lastSeenAt: '2026-07-08T10:00:00.000Z',
      lastSyncedAt: '2026-07-08T11:00:00.000Z',
      isActive: true
    }, thresholds).status).toBe('stale');
  });

  it('keeps inactive and timestamp-less records explicit', () => {
    expect(evaluateCatalogRecordFreshness({
      now,
      lastSeenAt: null,
      lastSyncedAt: null,
      isActive: false
    }).status).toBe('inactive');

    expect(evaluateCatalogRecordFreshness({
      now,
      lastSeenAt: null,
      lastSyncedAt: null,
      isActive: true
    }).status).toBe('unknown');
  });

  it('reports healthy, degraded, overdue, running, stuck, failed, and missing sync states', () => {
    const thresholds = catalogFreshnessThresholds({
      successfulSyncOverdueAfterMs: 24 * hour,
      runningSyncStuckAfterMs: hour
    });

    expect(evaluateCatalogSyncHealth({ now, latestRun: run() }, thresholds).status).toBe('healthy');
    expect(evaluateCatalogSyncHealth({
      now,
      latestRun: run({ finishedAt: '2026-07-08T11:00:00.000Z' })
    }, thresholds).status).toBe('overdue');
    expect(evaluateCatalogSyncHealth({
      now,
      latestRun: run({ failedItemCount: 1 })
    }, thresholds).status).toBe('degraded');
    expect(evaluateCatalogSyncHealth({
      now,
      latestRun: run({ coverageComplete: false })
    }, thresholds).status).toBe('degraded');
    expect(evaluateCatalogSyncHealth({
      now,
      latestRun: run({ status: 'running', finishedAt: null, heartbeatAt: '2026-07-10T11:30:00.000Z' })
    }, thresholds).status).toBe('running');
    expect(evaluateCatalogSyncHealth({
      now,
      latestRun: run({ status: 'running', finishedAt: null, heartbeatAt: '2026-07-10T09:00:00.000Z' })
    }, thresholds).status).toBe('stuck');
    expect(evaluateCatalogSyncHealth({
      now,
      latestRun: run({ status: 'failed' })
    }, thresholds).status).toBe('failed');
    expect(evaluateCatalogSyncHealth({ now, latestRun: null }, thresholds).status).toBe('never_synced');
  });

  it('allows missing-record deactivation only after a complete failure-free full sync', () => {
    expect(canDeactivateMissingCatalogRecords(run())).toBe(true);
    expect(evaluateCatalogDeactivationEligibility(run({ syncMode: 'partial' }))).toEqual({
      eligible: false,
      reason: 'sync_is_not_full'
    });
    expect(canDeactivateMissingCatalogRecords(run({ status: 'running', finishedAt: null }))).toBe(false);
    expect(canDeactivateMissingCatalogRecords(run({ status: 'failed' }))).toBe(false);
    expect(canDeactivateMissingCatalogRecords(run({ coverageComplete: false }))).toBe(false);
    expect(canDeactivateMissingCatalogRecords(run({ failedItemCount: 1 }))).toBe(false);
    expect(canDeactivateMissingCatalogRecords(run({ finishedAt: null }))).toBe(false);
  });

  it('uses one advisory-lock identity across URL, redirect, and CSV aliases', () => {
    const identities = [
      catalogSyncLockIdentity('site_crawl', 'https://bakautprof.ru/sitemap.xml'),
      catalogSyncLockIdentity('site_crawl', 'http://www.bakautprof.ru/sitemap.xml?redirect=1'),
      catalogSyncLockIdentity('site_crawl', 'https://bakautprof.ru/redirected-sitemap.xml'),
      catalogSyncLockIdentity('csv_import', 'catalog-imports/catalog.csv')
    ];

    expect(new Set(identities)).toEqual(new Set([CATALOG_MUTATION_LOCK_IDENTITY]));
    expect(() => catalogSyncLockIdentity('', 'https://bakautprof.ru/sitemap.xml')).toThrow('sourceType is required');
    expect(() => catalogSyncLockIdentity('site_crawl', '')).toThrow('sourceLocation is required');
  });

  it('fails closed on sharply incomplete inventory while preserving bootstrap', () => {
    const thresholds = { minimumRatio: 0.8, minimumFloor: 100 };

    expect(evaluateCatalogInventoryCoverage({
      activeItems: 1_000,
      discoveredItems: 799
    }, thresholds)).toMatchObject({ safe: false, requiredItems: 800, reason: 'discovered_inventory_below_minimum' });
    expect(evaluateCatalogInventoryCoverage({
      activeItems: 1_000,
      discoveredItems: 800
    }, thresholds)).toMatchObject({ safe: true, requiredItems: 800, reason: 'discovered_inventory_sufficient' });
    expect(evaluateCatalogInventoryCoverage({
      activeItems: 50,
      discoveredItems: 49
    }, thresholds)).toMatchObject({ safe: false, requiredItems: 50 });
    expect(evaluateCatalogInventoryCoverage({
      activeItems: 0,
      discoveredItems: 1
    }, thresholds)).toMatchObject({ safe: true, requiredItems: 0, reason: 'initial_catalog_bootstrap' });
    expect(DEFAULT_CATALOG_INVENTORY_COVERAGE_THRESHOLDS.minimumRatio).toBeGreaterThan(0);
    expect(DEFAULT_CATALOG_INVENTORY_COVERAGE_THRESHOLDS.minimumFloor).toBeGreaterThan(0);

    expect(() => catalogFreshnessThresholds({ recordStaleAfterMs: 0 })).toThrow(
      'recordStaleAfterMs must be a positive finite number'
    );
    expect(DEFAULT_CATALOG_FRESHNESS_THRESHOLDS.recordStaleAfterMs).toBeGreaterThan(0);
  });

  it('throttles concurrent catalog heartbeats and makes a DB failure sticky', async () => {
    let now = 0;
    let releaseHeartbeat!: () => void;
    const writeHeartbeat = vi.fn(() => new Promise<void>((resolve) => {
      releaseHeartbeat = resolve;
    }));
    const heartbeat = createCatalogSyncHeartbeat(writeHeartbeat, { now: () => now });

    await heartbeat();
    now = CATALOG_SYNC_HEARTBEAT_INTERVAL_MS;
    const concurrentCalls = [heartbeat(), heartbeat(), heartbeat()];
    await Promise.resolve();
    expect(writeHeartbeat).toHaveBeenCalledOnce();
    releaseHeartbeat();
    await Promise.all(concurrentCalls);

    now += CATALOG_SYNC_HEARTBEAT_INTERVAL_MS - 1;
    await heartbeat();
    expect(writeHeartbeat).toHaveBeenCalledOnce();

    const dbError = new Error('heartbeat database unavailable');
    writeHeartbeat.mockRejectedValueOnce(dbError);
    now += 1;
    await expect(heartbeat()).rejects.toBe(dbError);
    now += CATALOG_SYNC_HEARTBEAT_INTERVAL_MS;
    await expect(heartbeat()).rejects.toBe(dbError);
    expect(writeHeartbeat).toHaveBeenCalledTimes(2);
  });

  it('hashes equivalent source objects independently of property order', () => {
    expect(catalogSourceContentHash({ name: 'A', specs: { power: 5, phase: 1 } })).toBe(
      catalogSourceContentHash({ specs: { phase: 1, power: 5 }, name: 'A' })
    );
  });
});

describe('catalog freshness migration', () => {
  it('adds record freshness fields and an advisory-lockable sync lifecycle ledger', async () => {
    const schema = await fs.readFile(path.join(process.cwd(), 'sql', '014_catalog_freshness.sql'), 'utf8');

    expect(schema).toContain('ALTER TABLE products');
    expect(schema).toContain('ALTER TABLE catalog_pages');
    expect(schema).toContain('last_seen_at timestamptz');
    expect(schema).toContain('last_synced_at timestamptz');
    expect(schema).toContain('is_active boolean NOT NULL DEFAULT true');
    expect(schema).toContain('source_content_hash text');
    expect(schema).toContain('CREATE TABLE IF NOT EXISTS catalog_sync_runs');
    expect(schema).toContain("sync_mode text NOT NULL CHECK (sync_mode IN ('full', 'partial'))");
    expect(schema).toContain('deactivation_eligible boolean GENERATED ALWAYS AS');
    expect(schema).toContain("status = 'completed'");
    expect(schema).toContain('coverage_complete');
    expect(schema).toContain('failed_item_count = 0');
    expect(schema).toContain('catalog_sync_advisory_key');
    expect(schema).toContain('catalog_sync_runs_running_lock_idx');
  });

  it('does not deactivate records during migration or a partial/failed run', async () => {
    const schema = (await fs.readFile(path.join(process.cwd(), 'sql', '014_catalog_freshness.sql'), 'utf8'))
      .toLocaleLowerCase('en-US');

    expect(schema).not.toContain('set is_active = false');
    expect(schema).toContain("sync_mode = 'full'");
    expect(schema).toContain("status = 'completed'");
    expect(schema).toContain('failed_item_count = 0');
    expect(schema).toContain('deactivation_applied_at is null');
  });
});
