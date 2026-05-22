import type {
  CustomerNeedState,
  ProductSelectionCriteria,
  ProductSelectionState,
  RequirementLedger,
  RequirementLedgerItem,
  SemanticMemory,
  SemanticRequirementKind,
  SemanticRequirementStrictness
} from '../shared/types.js';

const STRICT: SemanticRequirementStrictness = 'strictOnly';
const SELECTION_PREFIX = 'selection:';

function hasValue(value: unknown) {
  if (Array.isArray(value)) return value.length > 0;
  return value !== undefined && value !== null && value !== '' && value !== 'unknown' && value !== 'any';
}

function criterionValue(criteria: ProductSelectionCriteria, key: keyof ProductSelectionCriteria) {
  return criteria[key];
}

function selectionItem(
  id: string,
  kind: RequirementLedgerItem['kind'],
  value: Record<string, unknown>
): RequirementLedgerItem {
  return {
    id,
    kind,
    value,
    status: 'derived',
    strictness: STRICT,
    source: 'selection_state',
    evidence: 'active selection hard constraint'
  };
}

function hardConstraintItems(criteria: ProductSelectionCriteria): RequirementLedgerItem[] {
  const items: RequirementLedgerItem[] = [];
  const mappings: Array<{
    key: keyof ProductSelectionCriteria;
    kind: RequirementLedgerItem['kind'];
    valueKey?: string;
  }> = [
    { key: 'productIntent', kind: 'productClass', valueKey: 'productIntent' },
    { key: 'budgetMax', kind: 'budgetRub' },
    { key: 'nominalPowerKwMin', kind: 'powerKw' },
    { key: 'nominalPowerKwMax', kind: 'powerKw' },
    { key: 'maxPowerKwMin', kind: 'powerKw' },
    { key: 'maxPowerKwMax', kind: 'powerKw' },
    { key: 'weightKgMin', kind: 'weightKg' },
    { key: 'weightKgMax', kind: 'weightKg' },
    { key: 'diameterMmMin', kind: 'diameterMm' },
    { key: 'diameterMmMax', kind: 'diameterMm' },
    { key: 'fuel', kind: 'fuel' },
    { key: 'singlePhase220', kind: 'phase' },
    { key: 'brandConstraint', kind: 'brand' },
    { key: 'exactModelConstraint', kind: 'exactModel' },
    { key: 'startType', kind: 'startType' },
    { key: 'enclosure', kind: 'enclosure' }
  ];

  for (const mapping of mappings) {
    const raw = criterionValue(criteria, mapping.key);
    if (!hasValue(raw)) continue;
    const id = `selection:${String(mapping.key)}`;
    const valueKey = mapping.valueKey ?? String(mapping.key);
    items.push(selectionItem(id, mapping.kind, { [valueKey]: raw }));
  }

  if ((criteria.exactModelTokens ?? []).length) {
    items.push(selectionItem('selection:exactModelTokens', 'exactModel', {
      exactModelTokens: criteria.exactModelTokens
    }));
  }

  return items;
}

function activeSemanticItems(memory: SemanticMemory | undefined): RequirementLedgerItem[] {
  const activeIds = new Set(memory?.activeRequirementIds ?? []);
  return (memory?.requirements ?? [])
    .filter((item) => item.status === 'active' || activeIds.has(item.id))
    .map((item) => ({
      id: item.id,
      kind: item.kind,
      value: item.value,
      status: item.status,
      strictness: item.strictness,
      source: item.source,
      evidence: item.evidence
    }));
}

function dedupeItems(items: RequirementLedgerItem[]) {
  const byKey = new Map<string, RequirementLedgerItem>();
  for (const item of items) {
    const key = `${item.kind}:${JSON.stringify(item.value)}`;
    const existing = byKey.get(key);
    if (!existing || existing.source === 'selection_state') byKey.set(key, item);
  }
  return [...byKey.values()];
}

function kindFromSelectionKey(key: string): SemanticRequirementKind | undefined {
  if (key.includes('brand')) return 'brand';
  if (key.includes('fuel')) return 'fuel';
  if (key.includes('PowerKw')) return 'powerKw';
  if (key.includes('weightKg')) return 'weightKg';
  if (key.includes('diameterMm')) return 'diameterMm';
  if (key.includes('singlePhase')) return 'phase';
  if (key.includes('productIntent')) return 'productClass';
  return undefined;
}

function stripSelectionPrefix(id: string) {
  return id.startsWith(SELECTION_PREFIX) ? id.slice(SELECTION_PREFIX.length) : id;
}

export function buildRequirementLedger(input: {
  needState: CustomerNeedState;
  selectionState?: ProductSelectionState;
}): RequirementLedger {
  const memory = input.needState.semanticMemory;
  const hardConstraints = input.selectionState?.hardConstraints ?? input.needState.selectionState.hardConstraints;
  const hardItems = hardConstraintItems(hardConstraints);
  const semanticItems = activeSemanticItems(memory);
  const items = dedupeItems([...semanticItems, ...hardItems]);
  const hardConstraintKeys = hardItems.map((item) => stripSelectionPrefix(item.id));
  const semanticKinds = new Set(semanticItems.map((item) => item.kind));
  const warnings: string[] = [];

  for (const key of hardConstraintKeys) {
    const kind = kindFromSelectionKey(key);
    if (kind && !semanticKinds.has(kind)) warnings.push(`hard_constraint_without_active_semantic_requirement:${key}`);
  }
  for (const id of memory.activeRequirementIds ?? []) {
    if (!items.some((item) => item.id === id)) warnings.push(`active_requirement_id_missing_item:${id}`);
  }

  return {
    version: 1,
    activeRequirementIds: [...(memory.activeRequirementIds ?? [])],
    primaryRequirementIds: [...(memory.selectionPolicy?.primaryRequirementIds ?? [])],
    alternativeMode: memory.selectionPolicy?.alternativeMode ?? 'none',
    items,
    hardConstraintKeys,
    warnings
  };
}
