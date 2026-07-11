export const catalogSyncModes = ['full', 'partial'] as const;
export const catalogSyncRunStatuses = ['running', 'completed', 'failed'] as const;
export const catalogRecordFreshnessStatuses = ['fresh', 'stale', 'inactive', 'unknown'] as const;
export const catalogSyncHealthStatuses = ['healthy', 'degraded', 'overdue', 'running', 'stuck', 'failed', 'never_synced'] as const;

export type CatalogSyncMode = typeof catalogSyncModes[number];
export type CatalogSyncRunStatus = typeof catalogSyncRunStatuses[number];
export type CatalogRecordFreshnessStatus = typeof catalogRecordFreshnessStatuses[number];
export type CatalogSyncHealthStatus = typeof catalogSyncHealthStatuses[number];
export type CatalogTimestamp = string | number | Date | null | undefined;

export interface CatalogFreshnessThresholds {
  recordStaleAfterMs: number;
  successfulSyncOverdueAfterMs: number;
  runningSyncStuckAfterMs: number;
}

export interface CatalogInventoryCoverageThresholds {
  minimumRatio: number;
  minimumFloor: number;
}

export interface CatalogInventoryCoverageEvaluation {
  safe: boolean;
  activeItems: number;
  discoveredItems: number;
  requiredItems: number;
  reason:
    | 'initial_catalog_bootstrap'
    | 'discovered_inventory_sufficient'
    | 'discovered_inventory_below_minimum';
}

export interface CatalogSyncRunSummary {
  syncMode: CatalogSyncMode;
  status: CatalogSyncRunStatus;
  coverageComplete: boolean;
  failedItemCount: number;
  startedAt: CatalogTimestamp;
  heartbeatAt?: CatalogTimestamp;
  finishedAt?: CatalogTimestamp;
}

export interface CatalogRecordFreshnessEvaluation {
  status: CatalogRecordFreshnessStatus;
  referenceAt: string | null;
  ageMs: number | null;
  reason:
    | 'record_active_and_recently_seen'
    | 'record_active_but_stale'
    | 'record_inactive'
    | 'record_has_no_freshness_timestamp';
}

export interface CatalogSyncHealthEvaluation {
  status: CatalogSyncHealthStatus;
  referenceAt: string | null;
  ageMs: number | null;
  reason:
    | 'latest_sync_completed_recently'
    | 'latest_sync_completed_with_incomplete_coverage_or_failures'
    | 'latest_successful_sync_is_overdue'
    | 'sync_is_running'
    | 'sync_heartbeat_is_stale'
    | 'latest_sync_failed'
    | 'no_sync_run_recorded';
}

export type CatalogDeactivationIneligibilityReason =
  | 'sync_is_not_full'
  | 'sync_is_not_completed'
  | 'sync_coverage_is_incomplete'
  | 'sync_has_failed_items'
  | 'sync_has_no_finished_timestamp';

export type CatalogDeactivationEvaluation =
  | { eligible: true; reason: 'full_sync_completed_without_failures' }
  | { eligible: false; reason: CatalogDeactivationIneligibilityReason };

export const DEFAULT_CATALOG_FRESHNESS_THRESHOLDS: Readonly<CatalogFreshnessThresholds> = Object.freeze({
  recordStaleAfterMs: 48 * 60 * 60 * 1000,
  successfulSyncOverdueAfterMs: 36 * 60 * 60 * 1000,
  runningSyncStuckAfterMs: 2 * 60 * 60 * 1000
});

export const DEFAULT_CATALOG_INVENTORY_COVERAGE_THRESHOLDS: Readonly<CatalogInventoryCoverageThresholds> = Object.freeze({
  minimumRatio: 0.8,
  minimumFloor: 100
});

export const CATALOG_MUTATION_LOCK_IDENTITY = 'catalog-sync:global-mutation';
export const CATALOG_SYNC_HEARTBEAT_INTERVAL_MS = 20_000;

function positiveFiniteThreshold(name: keyof CatalogFreshnessThresholds, value: number) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive finite number`);
  }
  return value;
}

export function catalogFreshnessThresholds(
  overrides: Partial<CatalogFreshnessThresholds> = {}
): CatalogFreshnessThresholds {
  const values = {
    ...DEFAULT_CATALOG_FRESHNESS_THRESHOLDS,
    ...overrides
  };
  return {
    recordStaleAfterMs: positiveFiniteThreshold('recordStaleAfterMs', values.recordStaleAfterMs),
    successfulSyncOverdueAfterMs: positiveFiniteThreshold(
      'successfulSyncOverdueAfterMs',
      values.successfulSyncOverdueAfterMs
    ),
    runningSyncStuckAfterMs: positiveFiniteThreshold('runningSyncStuckAfterMs', values.runningSyncStuckAfterMs)
  };
}

function timestampMs(value: CatalogTimestamp) {
  if (value === null || value === undefined || value === '') return null;
  const milliseconds = value instanceof Date
    ? value.getTime()
    : typeof value === 'number'
      ? value
      : Date.parse(value);
  return Number.isFinite(milliseconds) ? milliseconds : null;
}

function timestampEvaluation(now: CatalogTimestamp, value: CatalogTimestamp) {
  const nowMs = timestampMs(now);
  if (nowMs === null) throw new Error('now must be a valid timestamp');
  const valueMs = timestampMs(value);
  if (valueMs === null) return { referenceAt: null, ageMs: null };
  return {
    referenceAt: new Date(valueMs).toISOString(),
    ageMs: Math.max(0, nowMs - valueMs)
  };
}

function newestTimestamp(left: CatalogTimestamp, right: CatalogTimestamp) {
  const leftMs = timestampMs(left);
  const rightMs = timestampMs(right);
  if (leftMs === null) return rightMs;
  if (rightMs === null) return leftMs;
  return Math.max(leftMs, rightMs);
}

export function evaluateCatalogRecordFreshness(
  input: {
    now: CatalogTimestamp;
    lastSeenAt: CatalogTimestamp;
    lastSyncedAt: CatalogTimestamp;
    isActive: boolean;
  },
  thresholds: CatalogFreshnessThresholds = DEFAULT_CATALOG_FRESHNESS_THRESHOLDS
): CatalogRecordFreshnessEvaluation {
  if (!input.isActive) {
    return {
      status: 'inactive',
      referenceAt: null,
      ageMs: null,
      reason: 'record_inactive'
    };
  }
  const normalizedThresholds = catalogFreshnessThresholds(thresholds);
  const reference = newestTimestamp(input.lastSeenAt, input.lastSyncedAt);
  const timing = timestampEvaluation(input.now, reference);
  if (timing.ageMs === null) {
    return {
      status: 'unknown',
      ...timing,
      reason: 'record_has_no_freshness_timestamp'
    };
  }
  if (timing.ageMs <= normalizedThresholds.recordStaleAfterMs) {
    return {
      status: 'fresh',
      ...timing,
      reason: 'record_active_and_recently_seen'
    };
  }
  return {
    status: 'stale',
    ...timing,
    reason: 'record_active_but_stale'
  };
}

export function evaluateCatalogSyncHealth(
  input: {
    now: CatalogTimestamp;
    latestRun?: CatalogSyncRunSummary | null;
  },
  thresholds: CatalogFreshnessThresholds = DEFAULT_CATALOG_FRESHNESS_THRESHOLDS
): CatalogSyncHealthEvaluation {
  const run = input.latestRun;
  if (!run) {
    return {
      status: 'never_synced',
      referenceAt: null,
      ageMs: null,
      reason: 'no_sync_run_recorded'
    };
  }
  const normalizedThresholds = catalogFreshnessThresholds(thresholds);
  if (run.status === 'failed') {
    const timing = timestampEvaluation(input.now, run.finishedAt ?? run.heartbeatAt ?? run.startedAt);
    return {
      status: 'failed',
      ...timing,
      reason: 'latest_sync_failed'
    };
  }
  if (run.status === 'running') {
    const timing = timestampEvaluation(input.now, run.heartbeatAt ?? run.startedAt);
    const stuck = timing.ageMs === null || timing.ageMs > normalizedThresholds.runningSyncStuckAfterMs;
    return {
      status: stuck ? 'stuck' : 'running',
      ...timing,
      reason: stuck ? 'sync_heartbeat_is_stale' : 'sync_is_running'
    };
  }
  const timing = timestampEvaluation(input.now, run.finishedAt);
  const degraded = run.failedItemCount !== 0 || (run.syncMode === 'full' && !run.coverageComplete);
  if (degraded) {
    return {
      status: 'degraded',
      ...timing,
      reason: 'latest_sync_completed_with_incomplete_coverage_or_failures'
    };
  }
  const overdue = timing.ageMs === null || timing.ageMs > normalizedThresholds.successfulSyncOverdueAfterMs;
  return {
    status: overdue ? 'overdue' : 'healthy',
    ...timing,
    reason: overdue ? 'latest_successful_sync_is_overdue' : 'latest_sync_completed_recently'
  };
}

export function evaluateCatalogDeactivationEligibility(
  run: CatalogSyncRunSummary
): CatalogDeactivationEvaluation {
  if (run.syncMode !== 'full') return { eligible: false, reason: 'sync_is_not_full' };
  if (run.status !== 'completed') return { eligible: false, reason: 'sync_is_not_completed' };
  if (!run.coverageComplete) return { eligible: false, reason: 'sync_coverage_is_incomplete' };
  if (run.failedItemCount !== 0) return { eligible: false, reason: 'sync_has_failed_items' };
  if (timestampMs(run.finishedAt) === null) return { eligible: false, reason: 'sync_has_no_finished_timestamp' };
  return { eligible: true, reason: 'full_sync_completed_without_failures' };
}

export function canDeactivateMissingCatalogRecords(run: CatalogSyncRunSummary) {
  return evaluateCatalogDeactivationEligibility(run).eligible;
}

export function evaluateCatalogInventoryCoverage(
  input: { activeItems: number; discoveredItems: number },
  thresholds: CatalogInventoryCoverageThresholds = DEFAULT_CATALOG_INVENTORY_COVERAGE_THRESHOLDS
): CatalogInventoryCoverageEvaluation {
  if (!Number.isInteger(input.activeItems) || input.activeItems < 0) {
    throw new Error('activeItems must be a non-negative integer');
  }
  if (!Number.isInteger(input.discoveredItems) || input.discoveredItems < 0) {
    throw new Error('discoveredItems must be a non-negative integer');
  }
  if (!Number.isFinite(thresholds.minimumRatio) || thresholds.minimumRatio <= 0 || thresholds.minimumRatio > 1) {
    throw new Error('minimumRatio must be greater than 0 and at most 1');
  }
  if (!Number.isInteger(thresholds.minimumFloor) || thresholds.minimumFloor < 0) {
    throw new Error('minimumFloor must be a non-negative integer');
  }
  if (input.activeItems === 0) {
    return {
      safe: true,
      activeItems: 0,
      discoveredItems: input.discoveredItems,
      requiredItems: 0,
      reason: 'initial_catalog_bootstrap'
    };
  }
  const requiredItems = Math.min(
    input.activeItems,
    Math.max(thresholds.minimumFloor, Math.ceil(input.activeItems * thresholds.minimumRatio))
  );
  const safe = input.discoveredItems >= requiredItems;
  return {
    safe,
    activeItems: input.activeItems,
    discoveredItems: input.discoveredItems,
    requiredItems,
    reason: safe ? 'discovered_inventory_sufficient' : 'discovered_inventory_below_minimum'
  };
}

export function createCatalogSyncHeartbeat(
  writeHeartbeat: () => Promise<void>,
  options: { intervalMs?: number; now?: () => number } = {}
) {
  const intervalMs = options.intervalMs ?? CATALOG_SYNC_HEARTBEAT_INTERVAL_MS;
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new Error('catalog heartbeat intervalMs must be a positive finite number');
  }
  const now = options.now ?? Date.now;
  const initialTime = now();
  if (!Number.isFinite(initialTime)) throw new Error('catalog heartbeat clock must return a finite number');
  let lastHeartbeatAt = initialTime;
  let inFlight: Promise<void> | null = null;
  let failure: { error: unknown } | null = null;

  return async () => {
    if (failure) throw failure.error;
    if (inFlight) return inFlight;
    const currentTime = now();
    if (!Number.isFinite(currentTime)) throw new Error('catalog heartbeat clock must return a finite number');
    if (currentTime < lastHeartbeatAt) {
      lastHeartbeatAt = currentTime;
      return;
    }
    if (currentTime - lastHeartbeatAt < intervalMs) return;

    lastHeartbeatAt = currentTime;
    const operation = Promise.resolve()
      .then(writeHeartbeat)
      .catch((error) => {
        failure = { error };
        throw error;
      })
      .finally(() => {
        if (inFlight === operation) inFlight = null;
      });
    inFlight = operation;
    return operation;
  };
}

export function catalogSyncLockIdentity(sourceType: string, sourceLocation: string) {
  if (!sourceType.trim()) throw new Error('sourceType is required');
  if (!sourceLocation.trim()) throw new Error('sourceLocation is required');
  return CATALOG_MUTATION_LOCK_IDENTITY;
}

function stableSourceValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableSourceValue).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableSourceValue(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function catalogSourceContentHash(value: unknown) {
  return createHash('sha256').update(stableSourceValue(value)).digest('hex');
}
import { createHash } from 'node:crypto';
