import type { Product } from '../shared/types.js';
import type { ToolResult } from './agentManagerContracts.js';
import { textMatchesTargetName } from './modelTextMatching.js';

export interface ProductEvidenceConflict {
  attribute: string;
  keys: string[];
  values: string[];
}

export type ResolvedProduct = Product & {
  evidenceConflicts?: ProductEvidenceConflict[];
};

export interface ProductEvidenceResolution {
  products: ResolvedProduct[];
  conflictsByProductId: Record<string, ProductEvidenceConflict[]>;
  caveatsByProductId: Record<string, string[]>;
  warnings: string[];
}

type SpecEntry = {
  index: number;
  key: string;
  value: unknown;
  normalized: string;
  base: string;
  unit?: string;
};

type EvidenceFact = {
  productId?: unknown;
  productName?: unknown;
  attribute?: unknown;
  value?: unknown;
  sourceType?: unknown;
  confidence?: unknown;
  sourceUrl?: unknown;
};

type EvidenceConflict = {
  productName?: unknown;
  attribute?: unknown;
  catalogValue?: unknown;
  webValues?: unknown;
};

const measurementSuffixes = [
  'квтч',
  'kwh',
  'ква',
  'kva',
  'квт',
  'kw',
  'кн',
  'kn',
  'кг',
  'kg',
  'мм',
  'mm',
  'см',
  'cm',
  'гц',
  'hz',
  'дб',
  'db',
  'м3',
  'm3'
] as const;

function isAsciiLetterOrDigit(value: string) {
  const code = value.codePointAt(0) ?? 0;
  return (code >= 48 && code <= 57) ||
    (code >= 97 && code <= 122) ||
    (code >= 0x0430 && code <= 0x044f) ||
    code === 0x0451;
}

function compactLabel(value: unknown) {
  let output = '';
  for (const character of String(value ?? '').toLocaleLowerCase('ru-RU')) {
    const normalized = character === 'ё' ? 'е' : character;
    if (isAsciiLetterOrDigit(normalized)) output += normalized;
  }
  return output;
}

function labelParts(value: unknown) {
  const normalized = compactLabel(value);
  const suffix = measurementSuffixes.find((candidate) =>
    normalized.length > candidate.length + 1 && normalized.endsWith(candidate)
  );
  return {
    normalized,
    base: suffix ? normalized.slice(0, -suffix.length) : normalized,
    unit: suffix
  };
}

function labelsAreAliases(left: string, right: string) {
  const leftParts = labelParts(left);
  const rightParts = labelParts(right);
  if (!leftParts.normalized || !rightParts.normalized) return false;
  if (leftParts.normalized === rightParts.normalized) return true;
  if (leftParts.base.length < 4 || leftParts.base !== rightParts.base) return false;
  if (leftParts.unit && rightParts.unit && leftParts.unit !== rightParts.unit) return false;
  return true;
}

function valueKey(value: unknown) {
  if (value === null) return 'null';
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value) ?? String(value);
    } catch {
      return String(value);
    }
  }
  return `${typeof value}:${String(value).trim().toLocaleLowerCase('ru-RU')}`;
}

function displayValue(value: unknown) {
  if (typeof value === 'string') return value.trim();
  if (value === null || value === undefined) return '';
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function isHttpUrl(value: unknown) {
  if (typeof value !== 'string' || !value.trim()) return false;
  try {
    const protocol = new URL(value).protocol;
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

function exactProductFactMatches(product: Product, fact: EvidenceFact) {
  if (typeof fact.productId === 'string' && fact.productId.trim()) {
    return fact.productId.trim() === product.id;
  }
  if (typeof fact.productName !== 'string' || !fact.productName.trim()) return false;
  return textMatchesTargetName(product.name, fact.productName) ||
    textMatchesTargetName(fact.productName, product.name);
}

function sourceFactIsUsable(fact: EvidenceFact) {
  if (fact.sourceType !== 'web' && fact.sourceType !== 'catalog') return false;
  if (fact.confidence !== 'high' && fact.confidence !== 'medium') return false;
  if (typeof fact.attribute !== 'string' || !fact.attribute.trim()) return false;
  if (fact.value === null || fact.value === undefined || !displayValue(fact.value)) return false;
  return fact.sourceType !== 'web' || isHttpUrl(fact.sourceUrl);
}

function evidenceFactsForProduct(product: Product, toolResults: ToolResult[]) {
  const facts: EvidenceFact[] = [];
  const conflicts: Array<{ conflict: EvidenceConflict; adjudicated: boolean }> = [];
  for (const result of toolResults) {
    if (result.tool !== 'web.researchProductFacts' || result.status !== 'ok') continue;
    const payload = result.payload && typeof result.payload === 'object'
      ? result.payload as Record<string, unknown>
      : {};
    if (payload.searchDisposition === 'not_needed') continue;
    const rawFacts = Array.isArray(payload.facts) ? payload.facts : [];
    for (const rawFact of rawFacts) {
      if (!rawFact || typeof rawFact !== 'object') continue;
      const fact = rawFact as EvidenceFact;
      if (exactProductFactMatches(product, fact) && sourceFactIsUsable(fact)) facts.push(fact);
    }
    const rawConflicts = Array.isArray(payload.conflicts) ? payload.conflicts : [];
    for (const rawConflict of rawConflicts) {
      if (!rawConflict || typeof rawConflict !== 'object') continue;
      const conflict = rawConflict as EvidenceConflict;
      const productName = conflict.productName;
      if (typeof productName !== 'string' || !productName.trim()) continue;
      if (!textMatchesTargetName(product.name, productName) && !textMatchesTargetName(productName, product.name)) continue;
      conflicts.push({
        conflict,
        adjudicated: Array.isArray(result.warnings) && result.warnings.includes('source_conflict_adjudicated')
      });
    }
  }
  const uniqueFacts = new Map<string, EvidenceFact>();
  for (const fact of facts) {
    uniqueFacts.set([
      fact.attribute,
      fact.value,
      fact.sourceUrl ?? ''
    ].join('|'), fact);
  }
  return {
    facts: [...uniqueFacts.values()],
    conflicts
  };
}

function specGroups(specs: Record<string, unknown>) {
  const entries: SpecEntry[] = Object.entries(specs).map(([key, value], index) => ({
    index,
    key,
    value,
    ...labelParts(key)
  }));
  const byBase = new Map<string, SpecEntry[]>();
  for (const entry of entries) {
    if (!entry.base) continue;
    const group = byBase.get(entry.base) ?? [];
    group.push(entry);
    byBase.set(entry.base, group);
  }

  const groups: SpecEntry[][] = [];
  for (const baseEntries of byBase.values()) {
    const byUnit = new Map<string, SpecEntry[]>();
    for (const entry of baseEntries) {
      const unit = entry.unit ?? '';
      const group = byUnit.get(unit) ?? [];
      group.push(entry);
      byUnit.set(unit, group);
    }
    const explicitUnits = [...byUnit.keys()].filter(Boolean);
    const unitless = byUnit.get('') ?? [];
    if (unitless.length && explicitUnits.length === 1) {
      const explicit = byUnit.get(explicitUnits[0]!) ?? [];
      groups.push([...unitless, ...explicit].sort((left, right) => left.index - right.index));
      byUnit.delete('');
      byUnit.delete(explicitUnits[0]!);
    }
    for (const group of byUnit.values()) {
      groups.push(group.sort((left, right) => left.index - right.index));
    }
  }
  return groups.sort((left, right) => (left[0]?.index ?? 0) - (right[0]?.index ?? 0));
}

function uniqueStrings(values: string[]) {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

function specsEqual(left: Record<string, unknown>, right: Record<string, unknown>) {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return leftKeys.length === rightKeys.length && leftKeys.every((key) =>
    Object.prototype.hasOwnProperty.call(right, key) && valueKey(left[key]) === valueKey(right[key])
  );
}

function resolveProduct(input: {
  product: Product;
  toolResults: ToolResult[];
}) {
  const specs = input.product.specs ?? {};
  const sourceEvidence = evidenceFactsForProduct(input.product, input.toolResults);
  const outputSpecs: Record<string, unknown> = {};
  const conflicts: ProductEvidenceConflict[] = [];
  const handledIndexes = new Set<number>();

  for (const group of specGroups(specs)) {
    const first = group[0];
    if (!first) continue;
    group.forEach((entry) => handledIndexes.add(entry.index));
    const groupFacts = sourceEvidence.facts.filter((fact) =>
      typeof fact.attribute === 'string' && group.some((entry) => labelsAreAliases(entry.key, fact.attribute as string))
    );
    const groupSourceConflicts = sourceEvidence.conflicts.filter(({ conflict }) =>
      typeof conflict.attribute === 'string' && group.some((entry) => labelsAreAliases(entry.key, conflict.attribute as string))
    );
    const factValues = new Map<string, EvidenceFact>();
    for (const fact of groupFacts) factValues.set(valueKey(fact.value), fact);
    const rawValues = new Map<string, unknown>();
    for (const entry of group) rawValues.set(valueKey(entry.value), entry.value);
    const unresolvedSourceConflict = groupSourceConflicts.some(({ adjudicated }) => !adjudicated);

    if (factValues.size === 1 && !unresolvedSourceConflict) {
      const fact = [...factValues.values()][0]!;
      const exactFactKey = group.find((entry) => compactLabel(entry.key) === compactLabel(fact.attribute));
      outputSpecs[exactFactKey?.key ?? first.key] = fact.value;
      continue;
    }

    if (factValues.size > 1 || unresolvedSourceConflict || rawValues.size > 1) {
      const conflictValues = uniqueStrings([
        ...[...rawValues.values()].map(displayValue),
        ...groupSourceConflicts.flatMap(({ conflict }) => [
          displayValue(conflict.catalogValue),
          ...(Array.isArray(conflict.webValues) ? conflict.webValues.map(displayValue) : [])
        ])
      ]);
      conflicts.push({
        attribute: first.key,
        keys: group.map((entry) => entry.key),
        values: conflictValues
      });
      continue;
    }

    outputSpecs[first.key] = first.value;
  }

  for (const [indexText, [key, value]] of Object.entries(specs).entries()) {
    const index = Number(indexText);
    if (handledIndexes.has(index)) continue;
    outputSpecs[key] = value;
  }

  if (!conflicts.length && specsEqual(specs, outputSpecs)) {
    return { product: input.product as ResolvedProduct, conflicts: [] as ProductEvidenceConflict[], caveats: [] as string[] };
  }

  const caveats = conflicts.map((conflict) =>
    `Характеристика «${conflict.attribute}» указана в нескольких вариантах; точное значение нужно уточнить.`
  );
  return {
    product: {
      ...input.product,
      specs: outputSpecs,
      ...(conflicts.length ? { evidenceConflicts: conflicts } : {})
    },
    conflicts,
    caveats
  };
}

export function resolveProductsForEvidence(input: {
  products: Product[];
  toolResults?: ToolResult[];
}): ProductEvidenceResolution {
  const conflictsByProductId: Record<string, ProductEvidenceConflict[]> = {};
  const caveatsByProductId: Record<string, string[]> = {};
  const warnings: string[] = [];
  const products = input.products.map((product) => {
    const resolved = resolveProduct({ product, toolResults: input.toolResults ?? [] });
    if (resolved.conflicts.length) {
      conflictsByProductId[product.id] = resolved.conflicts;
      caveatsByProductId[product.id] = resolved.caveats;
      warnings.push(`product_evidence_conflict:${product.id}:${resolved.conflicts.length}`);
    }
    return resolved.product;
  });
  return {
    products,
    conflictsByProductId,
    caveatsByProductId,
    warnings: uniqueStrings(warnings)
  };
}
