import type { ProductElectricalLoadItem, ProductGeneratorLoadProfile, ProductGeneratorLoadScenario } from '../shared/types.js';

function roundKw(value: number, step = 0.1) {
  return Number((Math.round(value / step) * step).toFixed(6));
}

function ceilKw(value: number, step = 0.5) {
  return Number((Math.ceil(value / step) * step).toFixed(6));
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
  if (['welding_inverter', 'inverter_welder', 'сварочный_инвертор', 'инверторный_сварочный_аппарат'].includes(key)) return 'welding_inverter';
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
  'welding_inverter',
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

function positiveFinite(value: number | undefined) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

function normalizeLoadItem(item: ProductElectricalLoadItem): ProductElectricalLoadItem {
  const runningKw = positiveFinite(item.runningKw);
  const providedStartingKw = positiveFinite(item.startingKw);
  const startingKw = providedStartingKw === undefined
    ? runningKw
    : runningKw === undefined
      ? providedStartingKw
      : Math.max(providedStartingKw, runningKw);
  return {
    ...item,
    count: Math.max(1, Math.min(12, Math.round(item.count || 1))),
    runningKw,
    startingKw
  };
}

function itemScenarioKey(item: ProductElectricalLoadItem) {
  const kind = canonicalElectricalLoadKind(item.kind);
  const name = normalizeKey(item.name);
  return name ? `${kind}:${name}` : kind;
}

function isScenarioOnlyLoad(
  item: ProductElectricalLoadItem,
  simultaneousRunning: boolean
) {
  if (simultaneousRunning) return false;
  return item.operationMode === 'occasional' || item.operationMode === 'separate';
}

function calculateFlatScenario(
  id: string,
  label: string,
  items: ProductElectricalLoadItem[],
  options: {
    simultaneousRunning?: boolean;
    simultaneousStarting?: boolean;
    simultaneousStartingKinds?: string[];
  } = {}
): ProductGeneratorLoadScenario {
  const running = items.reduce((sum, item) => sum + (item.runningKw ?? 0) * item.count, 0);
  const startingExtraByItem = items.map((item) => Math.max(0, (item.startingKw ?? item.runningKw ?? 0) - (item.runningKw ?? 0)));
  const maxStartingExtra = startingExtraByItem.length
    ? Math.max(...items.map((item, index) => startingExtraByItem[index] * item.count))
    : 0;
  const simultaneousKinds = new Set(
    options.simultaneousStarting ? (options.simultaneousStartingKinds ?? []).map(canonicalElectricalLoadKind) : []
  );
  const selectedStartingExtra = simultaneousKinds.size
    ? items.reduce((sum, item, index) => (
        simultaneousKinds.has(canonicalElectricalLoadKind(item.kind))
          ? sum + startingExtraByItem[index] * item.count
          : sum
      ), 0)
    : 0;
  const allStartingExtra = items.reduce((sum, item, index) => sum + startingExtraByItem[index] * item.count, 0);
  const startingExtra = simultaneousKinds.size
    ? Math.max(maxStartingExtra, selectedStartingExtra)
    : options.simultaneousStarting
      ? allStartingExtra
      : maxStartingExtra;
  const requiredStartingKw = running + startingExtra;
  const calculation = items
    .map((item) => `${item.name ?? item.kind}: ${item.count} x ${item.runningKw ?? '?'} kW run / ${item.startingKw ?? item.runningKw ?? '?'} kW start`)
    .join('; ');
  return {
    id,
    label,
    itemKinds: items.map(itemScenarioKey),
    totalRunningKw: roundKw(running),
    requiredStartingKw: roundKw(requiredStartingKw),
    requiredNominalKw: ceilKw(requiredStartingKw, 0.5),
    calculation
  };
}

function withStartingFloor(scenario: ProductGeneratorLoadScenario, floor: number) {
  if (scenario.requiredStartingKw >= floor) return scenario;
  return {
    ...scenario,
    requiredStartingKw: roundKw(floor),
    requiredNominalKw: ceilKw(floor, 0.5),
    calculation: `${scenario.calculation}; floor from base startup scenario ${roundKw(floor)} kW`
  };
}

function strongestScenario(scenarios: ProductGeneratorLoadScenario[]) {
  return scenarios.reduce((best, current) => {
    if (current.requiredNominalKw !== best.requiredNominalKw) {
      return current.requiredNominalKw > best.requiredNominalKw ? current : best;
    }
    if (current.requiredStartingKw !== best.requiredStartingKw) {
      return current.requiredStartingKw > best.requiredStartingKw ? current : best;
    }
    return current.totalRunningKw > best.totalRunningKw ? current : best;
  }, scenarios[0]);
}

export function calculateGeneratorLoadProfile(
  items: ProductElectricalLoadItem[],
  options: {
    simultaneousRunning?: boolean;
    simultaneousStarting?: boolean;
    simultaneousStartingKinds?: string[];
    confidence?: number;
  } = {}
): ProductGeneratorLoadProfile | undefined {
  const usable = items
    .map(normalizeLoadItem)
    .filter((item) => item.count > 0 && (item.runningKw || item.startingKw));
  if (!usable.length) return undefined;

  const simultaneousKinds = new Set(
    options.simultaneousStarting ? (options.simultaneousStartingKinds ?? []).map(canonicalElectricalLoadKind) : []
  );
  const aggregateLoad = usable.find((item) => canonicalElectricalLoadKind(item.kind) === 'aggregate_load');
  if (aggregateLoad) {
    const aggregateScenario = calculateFlatScenario('aggregate_load', 'explicit aggregate load', [aggregateLoad], {
      simultaneousStarting: options.simultaneousStarting,
      simultaneousStartingKinds: [...simultaneousKinds]
    });
    return {
      items: [aggregateLoad],
      totalRunningKw: aggregateScenario.totalRunningKw,
      requiredStartingKw: aggregateScenario.requiredStartingKw,
      requiredNominalKw: aggregateScenario.requiredNominalKw,
      simultaneousRunning: Boolean(options.simultaneousRunning),
      simultaneousStarting: Boolean(options.simultaneousStarting),
      simultaneousStartingKinds: [...simultaneousKinds],
      scenarios: [aggregateScenario],
      primaryScenarioId: aggregateScenario.id,
      calculation: aggregateScenario.calculation,
      confidence: options.confidence ?? (aggregateLoad.source === 'explicit_user' ? 0.9 : 0.62)
    };
  }

  const scenarioOnly = usable.filter((item) => isScenarioOnlyLoad(
    item,
    Boolean(options.simultaneousRunning)
  ));
  const base = usable.filter((item) => !scenarioOnly.includes(item));
  const baseScenarioItems = base.length ? base : [];
  const scenarios: ProductGeneratorLoadScenario[] = [];
  if (baseScenarioItems.length) {
    scenarios.push(calculateFlatScenario('base', 'base continuous load', baseScenarioItems, {
      simultaneousStarting: options.simultaneousStarting,
      simultaneousStartingKinds: [...simultaneousKinds]
    }));
  }

  const baseStartupFloor = scenarios[0]?.requiredStartingKw ?? 0;
  const scenarioGroups = new Map<string, ProductElectricalLoadItem[]>();
  for (const item of scenarioOnly) {
    const explicitGroup = item.coRunningGroup?.trim();
    const groupKey = explicitGroup ? `group:${explicitGroup}` : `item:${itemScenarioKey(item)}`;
    scenarioGroups.set(groupKey, [...(scenarioGroups.get(groupKey) ?? []), item]);
  }
  for (const [groupKey, groupItems] of scenarioGroups) {
    const label = groupItems.map((item) => item.name ?? item.kind).join(' + ');
    const scenario = calculateFlatScenario(
      `scenario_${normalizeKey(groupKey)}`,
      `${label} scenario`,
      [...baseScenarioItems, ...groupItems],
      {
        simultaneousStarting: false,
        simultaneousStartingKinds: []
      }
    );
    scenarios.push(withStartingFloor(scenario, baseStartupFloor));
  }
  if (!scenarios.length) {
    scenarios.push(calculateFlatScenario('base', 'base load', usable, {
      simultaneousStarting: options.simultaneousStarting,
      simultaneousStartingKinds: [...simultaneousKinds]
    }));
  }

  const primary = strongestScenario(scenarios);
  const calculation = scenarios.length > 1
    ? `primary ${primary.id}: ${primary.calculation}; scenarios: ${scenarios.map((scenario) => `${scenario.id}=${scenario.requiredNominalKw} kW nominal/${scenario.requiredStartingKw} kW start`).join(', ')}`
    : primary.calculation;

  return {
    items: usable,
    totalRunningKw: primary.totalRunningKw,
    requiredStartingKw: primary.requiredStartingKw,
    requiredNominalKw: primary.requiredNominalKw,
    simultaneousRunning: Boolean(options.simultaneousRunning),
    simultaneousStarting: Boolean(options.simultaneousStarting),
    simultaneousStartingKinds: [...simultaneousKinds],
    scenarios,
    primaryScenarioId: primary.id,
    calculation,
    confidence: options.confidence ?? (usable.some((item) => item.source === 'explicit_user') ? 0.82 : 0.58)
  };
}
