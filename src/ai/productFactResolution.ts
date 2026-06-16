import { normalizeAttributeValue, type ProductAttributeConflict, type ProductAttributeKey } from './productAttributeExtraction.js';

export type ProductFactSourceType = 'manufacturer' | 'manual' | 'dealer' | 'marketplace' | 'other';

export interface ProductFactEvidenceSource {
  url: string;
  title: string;
  sourceType: ProductFactSourceType;
  attribute: ProductAttributeKey;
  value: string | number;
  evidence: string;
}

export type ProductFactResolutionStatus =
  | 'confirmed'
  | 'conflicting_sources'
  | 'not_enough_evidence'
  | 'not_found_after_search'
  | 'not_required';

export interface ProductFactValueGroup {
  normalizedValue: number | string;
  sources: ProductFactEvidenceSource[];
  strongestSourceRank: number;
}

export interface ProductFactResolution {
  status: ProductFactResolutionStatus;
  attribute: ProductAttributeKey;
  confirmedValue?: number | string;
  conflict?: ProductAttributeConflict;
  sources: ProductFactEvidenceSource[];
  valueGroups: ProductFactValueGroup[];
  rationale: string;
}

export interface ProductFactSearchPlanInput {
  productName: string;
  attribute: ProductAttributeKey;
  article?: string | null;
  brand?: string | null;
}

export interface ProductFactSearchPlan {
  queries: string[];
  requiredSourceClasses: ProductFactSourceType[];
}

const attributeRuTerms: Record<ProductAttributeKey, string[]> = {
  weightKg: ['масса кг', 'вес кг'],
  voltageV: ['напряжение В'],
  powerKw: ['мощность кВт'],
  starterType: ['тип запуска', 'стартер'],
  centrifugalForceKn: ['центробежная сила кН'],
  plateSizeMm: ['размер основания', 'плита мм']
};

const attributeEnTerms: Record<ProductAttributeKey, string[]> = {
  weightKg: ['weight specs'],
  voltageV: ['voltage specs'],
  powerKw: ['power kW specs'],
  starterType: ['starter type specs'],
  centrifugalForceKn: ['centrifugal force kN specs'],
  plateSizeMm: ['plate size specs']
};

export function sourceCredibilityRank(sourceType: ProductFactSourceType): number {
  switch (sourceType) {
    case 'manufacturer': return 5;
    case 'manual': return 5;
    case 'dealer': return 4;
    case 'marketplace': return 2;
    default: return 1;
  }
}

function hostname(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLocaleLowerCase('ru');
  } catch {
    return url.toLocaleLowerCase('ru');
  }
}

function independentSources(sources: ProductFactEvidenceSource[]): ProductFactEvidenceSource[] {
  const seen = new Set<string>();
  const result: ProductFactEvidenceSource[] = [];
  for (const source of sources) {
    const key = `${hostname(source.url)}:${source.sourceType}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(source);
  }
  return result;
}

function valueKey(value: number | string): string {
  return typeof value === 'number' ? String(Math.round(value * 1000) / 1000) : value.toLocaleLowerCase('ru');
}

function groupEvidence(attribute: ProductAttributeKey, sources: ProductFactEvidenceSource[]): ProductFactValueGroup[] {
  const groups = new Map<string, ProductFactValueGroup>();
  for (const source of sources) {
    if (source.attribute !== attribute) continue;
    const normalized = normalizeAttributeValue(attribute, source.value);
    if (normalized === null) continue;
    const key = valueKey(normalized);
    const existing = groups.get(key) ?? {
      normalizedValue: normalized,
      sources: [],
      strongestSourceRank: 0
    };
    existing.sources.push(source);
    existing.strongestSourceRank = Math.max(existing.strongestSourceRank, sourceCredibilityRank(source.sourceType));
    groups.set(key, existing);
  }
  return Array.from(groups.values()).map((group) => ({
    ...group,
    sources: independentSources(group.sources)
  }));
}

function hasTwoCredibleIndependentSources(group: ProductFactValueGroup): boolean {
  const credible = group.sources.filter((source) => sourceCredibilityRank(source.sourceType) >= 4);
  return credible.length >= 2;
}

export function resolveProductFactCandidate(input: {
  conflict?: ProductAttributeConflict;
  attribute?: ProductAttributeKey;
  sources: ProductFactEvidenceSource[];
}): ProductFactResolution {
  const attribute = input.conflict?.attribute ?? input.attribute;
  if (!attribute) throw new Error('resolveProductFactCandidate requires conflict or attribute');

  const groups = groupEvidence(attribute, input.sources);
  const credibleGroups = groups.filter((group) => group.sources.some((source) => sourceCredibilityRank(source.sourceType) >= 4));

  if (credibleGroups.length >= 2 && new Set(credibleGroups.map((group) => valueKey(group.normalizedValue))).size > 1) {
    return {
      status: 'conflicting_sources',
      attribute,
      conflict: input.conflict,
      sources: input.sources,
      valueGroups: groups,
      rationale: 'Credible sources disagree on the attribute value.'
    };
  }

  const confirmableGroups = groups.filter(hasTwoCredibleIndependentSources);

  if (confirmableGroups.length === 1) {
    const confirmed = confirmableGroups[0];
    return {
      status: 'confirmed',
      attribute,
      confirmedValue: confirmed.normalizedValue,
      conflict: input.conflict,
      sources: confirmed.sources.slice(0, 2),
      valueGroups: groups,
      rationale: 'Two credible independent sources confirm the same value.'
    };
  }

  if (credibleGroups.length >= 2 && new Set(credibleGroups.map((group) => valueKey(group.normalizedValue))).size > 1) {
    return {
      status: 'conflicting_sources',
      attribute,
      conflict: input.conflict,
      sources: input.sources,
      valueGroups: groups,
      rationale: 'Credible sources disagree on the attribute value.'
    };
  }

  return {
    status: input.sources.length === 0 ? 'not_found_after_search' : 'not_enough_evidence',
    attribute,
    conflict: input.conflict,
    sources: input.sources,
    valueGroups: groups,
    rationale: input.sources.length === 0
      ? 'No relevant evidence sources were found after search.'
      : 'Evidence exists but does not meet the two credible independent sources requirement.'
  };
}

function extractModelToken(productName: string): string {
  const tokens = productName.match(/[A-Za-zА-Яа-я]+[-_][A-Za-z0-9А-Яа-я-]+|[A-Za-z]{2,}[-_]?[A-Za-z0-9-]*\d[A-Za-z0-9-]*/g) ?? [];
  return tokens.find((token) => /\d/.test(token) && /[A-Za-z]/.test(token)) ?? productName;
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.replace(/\s+/g, ' ').trim()).filter(Boolean)));
}

export function buildProductFactSearchPlan(input: ProductFactSearchPlanInput): ProductFactSearchPlan {
  const model = extractModelToken(input.productName);
  const article = input.article?.trim();
  const base = article ? `${model} ${article}` : model;
  const ruTerms = attributeRuTerms[input.attribute] ?? [];
  const enTerms = attributeEnTerms[input.attribute] ?? [];

  return {
    queries: unique([
      ...ruTerms.map((term) => `${base} ${term}`),
      `${base} инструкция`,
      `${base} паспорт`,
      `${base} характеристики`,
      `${base} specs`,
      ...enTerms.map((term) => `${base} ${term}`),
      ...(article ? enTerms.map((term) => `${model} ${term}`) : []),
      input.brand ? `${input.brand} ${base} ${ruTerms[0] ?? 'характеристики'}` : ''
    ]),
    requiredSourceClasses: ['manual', 'manufacturer', 'dealer', 'marketplace']
  };
}
