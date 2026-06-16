import type { Product } from '../shared/types.js';

export type ProductAttributeKey =
  | 'weightKg'
  | 'voltageV'
  | 'powerKw'
  | 'starterType'
  | 'centrifugalForceKn'
  | 'plateSizeMm';

export interface ExtractedProductAttribute {
  value: number | string;
  raw: string;
  source: 'name' | 'specs';
}

export type ExtractedProductAttributes = Partial<Record<ProductAttributeKey, ExtractedProductAttribute>>;

export interface ProductAttributeConflict {
  productId: string;
  productName: string;
  productUrl?: string | null;
  attribute: ProductAttributeKey;
  nameValue: number | string;
  specsValue: number | string;
  nameRaw: string;
  specsRaw: string;
}

const attributeSpecKeyPatterns: Record<ProductAttributeKey, RegExp[]> = {
  weightKg: [/(?:рабоч|эксплуатац|снаряж|общ).*масса.*кг/i, /(?:^|\s)(?:масса|вес).*кг/i],
  voltageV: [/(?:напряж|вольт|v\b|в\b)/i],
  powerKw: [/(?:мощн).*квт/i, /kw|кw|квт/i],
  starterType: [/(?:стартер|запуск|пуск)/i],
  centrifugalForceKn: [/(?:центробеж|вынуждающ|сила).*кн/i, /(?:кн|kn)/i],
  plateSizeMm: [/(?:размер|габарит|длина|ширина).*основан/i, /(?:плит|основан).*мм/i]
};

function parseNumber(value: string): number | null {
  const match = value.replace(/\s+/g, ' ').match(/\d+(?:[,.]\d+)?/);
  if (!match) return null;
  const parsed = Number(match[0].replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : null;
}

function compactRaw(value: unknown): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function normalizePlateSize(value: string): string | null {
  const normalized = value
    .replace(/[×хХX]/g, 'x')
    .replace(/\s+/g, '')
    .trim();
  const match = normalized.match(/(\d{2,4})x(\d{2,4})/);
  if (!match) return null;
  return `${Number(match[1])}x${Number(match[2])}`;
}

export function normalizeAttributeValue(attribute: ProductAttributeKey | string, value: unknown): number | string | null {
  const raw = compactRaw(value);
  if (!raw) return null;

  if (attribute === 'plateSizeMm') return normalizePlateSize(raw);
  if (attribute === 'starterType') return raw.toLocaleLowerCase('ru');

  return parseNumber(raw);
}

function extracted(attribute: ProductAttributeKey, value: unknown, source: 'name' | 'specs', rawOverride?: string): ExtractedProductAttribute | null {
  const raw = rawOverride ?? compactRaw(value);
  const normalized = normalizeAttributeValue(attribute, raw);
  if (normalized === null || normalized === '') return null;
  return { value: normalized, raw, source };
}

export function extractAttributesFromProductName(product: Product): ExtractedProductAttributes {
  const name = product.name;
  const result: ExtractedProductAttributes = {};

  const weightMatch = name.match(/(\d+(?:[,.]\d+)?)\s*кг(?=$|[\s,;)])/i);
  if (weightMatch) {
    const item = extracted('weightKg', weightMatch[0], 'name');
    if (item) result.weightKg = item;
  }

  const forceMatch = name.match(/(\d+(?:[,.]\d+)?)\s*(?:кн|kn)(?=$|[\s,;)])/i);
  if (forceMatch) {
    const item = extracted('centrifugalForceKn', forceMatch[0], 'name');
    if (item) result.centrifugalForceKn = item;
  }

  const plateMatch = name.match(/\d{2,4}\s*[xхХX]\s*\d{2,4}/);
  if (plateMatch) {
    const item = extracted('plateSizeMm', plateMatch[0], 'name');
    if (item) result.plateSizeMm = item;
  }

  const voltageMatch = name.match(/(\d{2,3})\s*(?:в|v)(?=$|[\s,;)])/i);
  if (voltageMatch) {
    const item = extracted('voltageV', voltageMatch[0], 'name');
    if (item) result.voltageV = item;
  }

  return result;
}

function specEntries(product: Product) {
  return Object.entries(product.specs ?? {}).map(([key, value]) => ({ key, keyText: compactRaw(key), value, valueText: compactRaw(value) }));
}

function findSpecValue(product: Product, attribute: ProductAttributeKey): { raw: string; key: string } | null {
  const entries = specEntries(product);

  if (attribute === 'plateSizeMm') {
    const combined = entries.find((entry) => normalizePlateSize(entry.valueText));
    if (combined) return { raw: combined.valueText, key: combined.keyText };
    const length = entries.find((entry) => /длина.*основан|длина.*плит/i.test(entry.keyText));
    const width = entries.find((entry) => /ширина.*основан|ширина.*плит/i.test(entry.keyText));
    const lengthNumber = length ? parseNumber(length.valueText) : null;
    const widthNumber = width ? parseNumber(width.valueText) : null;
    if (lengthNumber && widthNumber) return { raw: `${lengthNumber}x${widthNumber}`, key: `${length?.keyText}/${width?.keyText}` };
  }

  const patterns = attributeSpecKeyPatterns[attribute];
  const direct = entries.find((entry) => patterns.some((pattern) => pattern.test(entry.keyText)));
  if (direct) return { raw: direct.valueText, key: direct.keyText };

  return null;
}

export function extractStructuredProductAttributes(product: Product): ExtractedProductAttributes {
  const result: ExtractedProductAttributes = {};
  for (const attribute of Object.keys(attributeSpecKeyPatterns) as ProductAttributeKey[]) {
    const spec = findSpecValue(product, attribute);
    if (!spec) continue;
    const item = extracted(attribute, spec.raw, 'specs');
    if (item) result[attribute] = item;
  }
  return result;
}

function valuesEqual(left: number | string, right: number | string): boolean {
  if (typeof left === 'number' && typeof right === 'number') return Math.abs(left - right) < 0.0001;
  return String(left).toLocaleLowerCase('ru') === String(right).toLocaleLowerCase('ru');
}

export function detectProductAttributeConflicts(
  product: Product,
  criticalAttributes: Array<ProductAttributeKey | string>
): ProductAttributeConflict[] {
  const nameAttributes = extractAttributesFromProductName(product);
  const specsAttributes = extractStructuredProductAttributes(product);
  const conflicts: ProductAttributeConflict[] = [];

  for (const attribute of criticalAttributes) {
    const key = attribute as ProductAttributeKey;
    const nameAttribute = nameAttributes[key];
    const specsAttribute = specsAttributes[key];
    if (!nameAttribute || !specsAttribute) continue;
    if (valuesEqual(nameAttribute.value, specsAttribute.value)) continue;

    conflicts.push({
      productId: product.id,
      productName: product.name,
      productUrl: product.sourceUrl,
      attribute: key,
      nameValue: nameAttribute.value,
      specsValue: specsAttribute.value,
      nameRaw: nameAttribute.raw,
      specsRaw: specsAttribute.raw
    });
  }

  return conflicts;
}
