import type { ProductElectricalLoadItem, ProductGeneratorLoadProfile } from '../shared/types.js';

function roundKw(value: number, step = 0.1) {
  return Math.round(value / step) * step;
}

function ceilKw(value: number, step = 0.5) {
  return Math.ceil(value / step) * step;
}

function normalizeKey(value: string | undefined) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_')
    .replace(/[^a-zа-яё0-9_]+/giu, '');
}

export function canonicalElectricalLoadKind(kind: string | undefined) {
  const key = normalizeKey(kind);
  if (['fridge', 'refrigerator', 'холодильник'].includes(key)) return 'refrigerator';
  if (['light', 'lights', 'lighting', 'led', 'led_light', 'освещение', 'свет'].includes(key)) return 'lighting';
  if (['pump', 'well_pump', 'borehole_pump', 'surface_pump', 'submersible_pump', 'circulation_pump', 'drainage_pump', 'насос'].includes(key)) return 'pump';
  if (['tool', 'power_tool', 'handheld_tool', 'angle_grinder', 'grinder', 'drill', 'saw', 'болгарка', 'инструмент'].includes(key)) return 'handheld_tool';
  if (['boiler', 'котел', 'котёл'].includes(key)) return 'boiler';
  if (['tv', 'television', 'телевизор'].includes(key)) return 'television';
  if (['router', 'роутер'].includes(key)) return 'router';
  if (['laptop', 'notebook', 'ноутбук'].includes(key)) return 'laptop';
  if (['aggregate', 'aggregate_load', 'total_load', 'суммарная_нагрузка'].includes(key)) return 'aggregate_load';
  return key || 'unknown_load';
}

const singleActiveLoadKinds = new Set([
  'refrigerator',
  'lighting',
  'pump',
  'handheld_tool',
  'boiler',
  'television',
  'router',
  'laptop',
  'aggregate_load'
]);

function loadIdentity(item: ProductElectricalLoadItem) {
  const kind = canonicalElectricalLoadKind(item.kind);
  if (singleActiveLoadKinds.has(kind)) return kind;
  return `${kind}:${normalizeKey(item.name)}`;
}

function sourceRank(source: ProductElectricalLoadItem['source']) {
  if (source === 'explicit_user') return 4;
  if (source === 'catalog_fact') return 3;
  if (source === 'web_average') return 2;
  return 1;
}

function isGenericName(kind: string, name: string | undefined) {
  const normalizedName = normalizeKey(name);
  return !normalizedName || normalizedName === kind || normalizedName === 'unknown';
}

function mergeSameLoadItem(existing: ProductElectricalLoadItem, incoming: ProductElectricalLoadItem) {
  const existingRank = sourceRank(existing.source);
  const incomingRank = sourceRank(incoming.source);
  if (existingRank > incomingRank) {
    const kind = canonicalElectricalLoadKind(existing.kind);
    return {
      ...existing,
      name: isGenericName(kind, existing.name) && !isGenericName(kind, incoming.name) ? incoming.name : existing.name,
      evidence: incoming.evidence || existing.evidence
    };
  }
  return incoming;
}

export function mergeElectricalLoadItems(input: {
  currentItems?: ProductElectricalLoadItem[];
  updateItems?: ProductElectricalLoadItem[];
  removedKinds?: string[];
}) {
  const removed = new Set((input.removedKinds ?? []).map(canonicalElectricalLoadKind));
  const byIdentity = new Map<string, ProductElectricalLoadItem>();

  for (const item of input.currentItems ?? []) {
    const identity = loadIdentity(item);
    if (removed.has(canonicalElectricalLoadKind(item.kind)) || removed.has(identity)) continue;
    const existing = byIdentity.get(identity);
    byIdentity.set(identity, existing ? mergeSameLoadItem(existing, item) : item);
  }

  for (const item of input.updateItems ?? []) {
    const identity = loadIdentity(item);
    const existing = byIdentity.get(identity);
    byIdentity.set(identity, existing ? mergeSameLoadItem(existing, item) : item);
  }

  return [...byIdentity.values()].slice(-16);
}

export function calculateGeneratorLoadProfile(
  items: ProductElectricalLoadItem[],
  options: {
    simultaneousStarting?: boolean;
    simultaneousStartingKinds?: string[];
    confidence?: number;
  } = {}
): ProductGeneratorLoadProfile | undefined {
  const usable = items.filter((item) => item.count > 0 && (item.runningKw || item.startingKw));
  if (!usable.length) return undefined;

  const running = usable.reduce((sum, item) => sum + (item.runningKw ?? 0) * item.count, 0);
  const startingExtraByItem = usable.map((item) => Math.max(0, (item.startingKw ?? item.runningKw ?? 0) - (item.runningKw ?? 0)));
  const maxStartingExtra = startingExtraByItem.length
    ? Math.max(...usable.map((item, index) => startingExtraByItem[index] * item.count))
    : 0;
  const simultaneousKinds = new Set(
    options.simultaneousStarting ? (options.simultaneousStartingKinds ?? []).map(canonicalElectricalLoadKind) : []
  );
  const selectedStartingExtra = simultaneousKinds.size
    ? usable.reduce((sum, item, index) => {
        return simultaneousKinds.has(canonicalElectricalLoadKind(item.kind))
          ? sum + startingExtraByItem[index] * item.count
          : sum;
      }, 0)
    : 0;
  const allStartingExtra = usable.reduce((sum, item, index) => sum + startingExtraByItem[index] * item.count, 0);
  const startingExtra = simultaneousKinds.size
    ? Math.max(maxStartingExtra, selectedStartingExtra)
    : options.simultaneousStarting
      ? allStartingExtra
      : maxStartingExtra;
  const requiredStartingKw = running + startingExtra;
  const requiredNominalKw = ceilKw(requiredStartingKw, 0.5);
  const calculation = usable
    .map((item) => `${item.name ?? item.kind}: ${item.count} x ${item.runningKw ?? '?'} kW run / ${item.startingKw ?? item.runningKw ?? '?'} kW start`)
    .join('; ');

  return {
    items: usable,
    totalRunningKw: roundKw(running),
    requiredStartingKw: roundKw(requiredStartingKw),
    requiredNominalKw,
    simultaneousStarting: Boolean(options.simultaneousStarting),
    simultaneousStartingKinds: [...simultaneousKinds],
    calculation,
    confidence: options.confidence ?? (usable.some((item) => item.source === 'explicit_user') ? 0.82 : 0.58)
  };
}
