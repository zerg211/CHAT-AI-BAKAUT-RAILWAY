import type { ProductElectricalLoadItem, ProductGeneratorLoadProfile, ProductGeneratorLoadScenario } from '../shared/types.js';

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

function positiveFinite(value: number | undefined) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

function itemText(item: ProductElectricalLoadItem) {
  return `${item.kind} ${item.name ?? ''} ${item.evidence ?? ''}`.toLowerCase();
}

function itemLabelText(item: ProductElectricalLoadItem) {
  return `${item.kind} ${item.name ?? ''}`.toLowerCase();
}

function hasExplicitStartingEvidence(item: ProductElectricalLoadItem) {
  return item.source === 'explicit_user' &&
    positiveFinite(item.startingKw) !== undefined &&
    /(?:(?:\u043f\u0443\u0441\u043a\w*|starting|surge)[^\d]{0,24}\d|\d[^\n.;]{0,24}(?:\u043f\u0443\u0441\u043a\w*|starting|surge))/iu.test(itemText(item));
}

function minimumStartingKw(item: ProductElectricalLoadItem) {
  const runningKw = positiveFinite(item.runningKw);
  if (!runningKw || hasExplicitStartingEvidence(item)) return positiveFinite(item.startingKw);
  const kind = canonicalElectricalLoadKind(item.kind);
  const label = itemLabelText(item);
  if (kind === 'pump') return roundKw(Math.max(runningKw * 2.6, runningKw + 1.2));
  if (kind === 'compressor' || /(?:\u043a\u043e\u043c\u043f\u0440\u0435\u0441\u0441\u043e\u0440|compressor)/iu.test(label)) {
    return roundKw(Math.max(runningKw * 3, runningKw + 2));
  }
  if (kind === 'refrigerator') return roundKw(Math.max(runningKw * 3, 1));
  if (kind === 'freezer') return roundKw(Math.max(runningKw * 3, 1.2));
  if (['pressure_washer', 'vacuum', 'concrete_mixer'].includes(kind)) {
    return roundKw(Math.max(runningKw * 2, runningKw + 0.8));
  }
  return positiveFinite(item.startingKw) ?? runningKw;
}

function normalizeLoadItem(item: ProductElectricalLoadItem): ProductElectricalLoadItem {
  const runningKw = positiveFinite(item.runningKw);
  const providedStartingKw = positiveFinite(item.startingKw);
  const minimumStarting = minimumStartingKw(item);
  const startingKw = providedStartingKw && minimumStarting
    ? Math.max(providedStartingKw, minimumStarting)
    : providedStartingKw ?? minimumStarting ?? runningKw;
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

function hasOccasionalOrSeparateEvidence(item: ProductElectricalLoadItem) {
  return /(?:\u0438\u043d\u043e\u0433\u0434\u0430|\u043f\u0435\u0440\u0438\u043e\u0434\u0438\u0447\u0435\u0441\u043a\u0438|\u0432\u0440\u0435\u043c\u044f\s+\u043e\u0442\s+\u0432\u0440\u0435\u043c\u0435\u043d\u0438|\u043f\u043e\s+\u043d\u0435\u043e\u0431\u0445\u043e\u0434\u0438\u043c\u043e\u0441\u0442\u0438|\u0431\u044b\u0432\u0430\u0435\u0442|\u043e\u0442\u0434\u0435\u043b\u044c\u043d\u043e|\u043d\u0435\s+\u0432\u043c\u0435\u0441\u0442\u0435|\u043d\u0435\s+\u043e\u0434\u043d\u043e\u0432\u0440\u0435\u043c\u0435\u043d\u043d\u043e|\u043d\u0435\s+\u0432\s+\u043e\u0434\u0438\u043d\s+\u043c\u043e\u043c\u0435\u043d\u0442|occasionally|sometimes|from\s+time\s+to\s+time|as\s+needed|optional|separate|not\s+together|not\s+simultaneously)/iu.test(itemText(item));
}

function hasContinuousEvidence(item: ProductElectricalLoadItem) {
  return /(?:\u043f\u043e\u0441\u0442\u043e\u044f\u043d\u043d\u043e|\u0434\u043e\u043b\u0436\u0435\u043d\s+\u0440\u0430\u0431\u043e\u0442\u0430\u0442\u044c|\u0434\u043e\u043b\u0436\u043d\u044b\s+\u0440\u0430\u0431\u043e\u0442\u0430\u0442\u044c|\u0431\u0430\u0437\u043e\u0432|always|continuously|constant|base\s+load)/iu.test(itemText(item));
}

function isKitchenComfortKind(item: ProductElectricalLoadItem) {
  const kind = canonicalElectricalLoadKind(item.kind);
  if (['kettle', 'microwave', 'induction', 'induction_cooktop', 'induction_hob', 'electric_stove', 'stove', 'heating_resistive'].includes(kind)) {
    return true;
  }
  return /(?:\u0447\u0430\u0439\u043d\u0438\u043a|\u043c\u0438\u043a\u0440\u043e\u0432\u043e\u043b\u043d|\u0438\u043d\u0434\u0443\u043a\u0446|\u043f\u043b\u0438\u0442\u043a|\u0432\u0430\u0440\u043e\u0447|kettle|microwave|induction|cooktop|hob)/iu.test(itemLabelText(item));
}

function isWorkshopKind(item: ProductElectricalLoadItem) {
  const kind = canonicalElectricalLoadKind(item.kind);
  if (['compressor', 'handheld_tool', 'pressure_washer', 'vacuum', 'concrete_mixer'].includes(kind)) return true;
  return /(?:\u043a\u043e\u043c\u043f\u0440\u0435\u0441\u0441\u043e\u0440|\u0438\u043d\u0441\u0442\u0440\u0443\u043c\u0435\u043d\u0442|\u0431\u043e\u043b\u0433\u0430\u0440\u043a|\u0434\u0440\u0435\u043b|compressor|tool|grinder|drill|saw)/iu.test(itemLabelText(item));
}

function isScenarioOnlyLoad(
  item: ProductElectricalLoadItem,
  simultaneousStarting: boolean,
  simultaneousKinds: Set<string>
) {
  const kind = canonicalElectricalLoadKind(item.kind);
  const stagedCandidate = isKitchenComfortKind(item) || isWorkshopKind(item);
  if (stagedCandidate && hasOccasionalOrSeparateEvidence(item)) return true;
  if (simultaneousStarting && (!simultaneousKinds.size || simultaneousKinds.has(kind))) return false;
  if (stagedCandidate && !hasContinuousEvidence(item)) return true;
  return false;
}

function calculateFlatScenario(
  id: string,
  label: string,
  items: ProductElectricalLoadItem[],
  options: {
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
      simultaneousStarting: Boolean(options.simultaneousStarting),
      simultaneousStartingKinds: [...simultaneousKinds],
      scenarios: [aggregateScenario],
      primaryScenarioId: aggregateScenario.id,
      calculation: aggregateScenario.calculation,
      confidence: options.confidence ?? (aggregateLoad.source === 'explicit_user' ? 0.9 : 0.62)
    };
  }

  const scenarioOnly = usable.filter((item) => isScenarioOnlyLoad(item, Boolean(options.simultaneousStarting), simultaneousKinds));
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
  for (const item of scenarioOnly) {
    const scenario = calculateFlatScenario(
      `scenario_${itemScenarioKey(item)}`,
      `${item.name ?? item.kind} scenario`,
      [...baseScenarioItems, item],
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
    simultaneousStarting: Boolean(options.simultaneousStarting),
    simultaneousStartingKinds: [...simultaneousKinds],
    scenarios,
    primaryScenarioId: primary.id,
    calculation,
    confidence: options.confidence ?? (usable.some((item) => item.source === 'explicit_user') ? 0.82 : 0.58)
  };
}
