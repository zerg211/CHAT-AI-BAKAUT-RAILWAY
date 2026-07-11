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

const productAttributeKeys: ProductAttributeKey[] = [
  'weightKg',
  'voltageV',
  'powerKw',
  'starterType',
  'centrifugalForceKn',
  'plateSizeMm'
];

function isWhitespace(value: string) {
  return value.length > 0 && value.trim() === '';
}

function isAsciiDigit(value: string) {
  const code = value.codePointAt(0) ?? 0;
  return code >= 48 && code <= 57;
}

function isLetterOrDigit(value: string | undefined) {
  if (!value) return false;
  const code = value.toLocaleLowerCase('ru').codePointAt(0) ?? 0;
  return isAsciiDigit(value) || (code >= 97 && code <= 122) || (code >= 0x0430 && code <= 0x044f) || code === 0x0451;
}

function compactWhitespace(value: string) {
  let output = '';
  let pendingSpace = false;
  for (const character of value) {
    if (isWhitespace(character)) {
      pendingSpace = output.length > 0;
      continue;
    }
    if (pendingSpace) output += ' ';
    output += character;
    pendingSpace = false;
  }
  return output;
}

function firstOrderedIndex(value: string, alternatives: string[], fromIndex: number) {
  let selected = -1;
  let selectedLength = 0;
  for (const alternative of alternatives) {
    const foundAt = value.indexOf(alternative, fromIndex);
    if (foundAt < 0 || (selected >= 0 && foundAt >= selected)) continue;
    selected = foundAt;
    selectedLength = alternative.length;
  }
  return selected < 0 ? null : { index: selected, length: selectedLength };
}

function containsInOrder(value: string, groups: string[][]) {
  let cursor = 0;
  for (const alternatives of groups) {
    const found = firstOrderedIndex(value, alternatives, cursor);
    if (!found) return false;
    cursor = found.index + found.length;
  }
  return true;
}

function startsAtTextOrWhitespaceBoundary(value: string, term: string) {
  let cursor = 0;
  while (cursor < value.length) {
    const foundAt = value.indexOf(term, cursor);
    if (foundAt < 0) return -1;
    if (foundAt === 0 || isWhitespace(value[foundAt - 1])) return foundAt;
    cursor = foundAt + 1;
  }
  return -1;
}

function containsWithEndBoundary(value: string, term: string) {
  let cursor = 0;
  while (cursor < value.length) {
    const foundAt = value.indexOf(term, cursor);
    if (foundAt < 0) return false;
    if (!isLetterOrDigit(value[foundAt + term.length])) return true;
    cursor = foundAt + 1;
  }
  return false;
}

function specKeyMatches(attribute: ProductAttributeKey, rawKey: string) {
  const key = compactWhitespace(rawKey).toLocaleLowerCase('ru');
  if (attribute === 'weightKg') {
    if (containsInOrder(key, [['рабоч', 'эксплуатац', 'снаряж', 'общ'], ['масса'], ['кг']])) return true;
    for (const term of ['масса', 'вес']) {
      const termIndex = startsAtTextOrWhitespaceBoundary(key, term);
      if (termIndex >= 0 && key.indexOf('кг', termIndex + term.length) >= 0) return true;
    }
    return false;
  }
  if (attribute === 'voltageV') {
    return ['напряж', 'вольт'].some((term) => key.includes(term)) ||
      containsWithEndBoundary(key, 'v') || containsWithEndBoundary(key, 'в');
  }
  if (attribute === 'powerKw') {
    return containsInOrder(key, [['мощн'], ['квт']]) || ['kw', 'кw', 'квт'].some((term) => key.includes(term));
  }
  if (attribute === 'starterType') {
    return ['стартер', 'запуск', 'пуск'].some((term) => key.includes(term));
  }
  if (attribute === 'centrifugalForceKn') {
    return containsInOrder(key, [['центробеж', 'вынуждающ', 'сила'], ['кн']]) ||
      ['кн', 'kn'].some((term) => key.includes(term));
  }
  return containsInOrder(key, [['размер', 'габарит', 'длина', 'ширина'], ['основан']]) ||
    containsInOrder(key, [['плит', 'основан'], ['мм']]);
}

function parseNumber(value: string): number | null {
  for (let start = 0; start < value.length; start += 1) {
    if (!isAsciiDigit(value[start])) continue;
    let end = start;
    while (end < value.length && isAsciiDigit(value[end])) end += 1;
    if ((value[end] === ',' || value[end] === '.') && isAsciiDigit(value[end + 1] ?? '')) {
      end += 1;
      while (end < value.length && isAsciiDigit(value[end])) end += 1;
    }
    const parsed = Number(value.slice(start, end).split(',').join('.'));
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function compactRaw(value: unknown): string {
  return compactWhitespace(String(value ?? ''));
}

function normalizePlateSize(value: string): string | null {
  let normalized = '';
  for (const character of value) {
    if (isWhitespace(character)) continue;
    normalized += character === '×' || character === 'х' || character === 'Х' || character === 'X'
      ? 'x'
      : character;
  }
  for (let start = 0; start < normalized.length; start += 1) {
    if (!isAsciiDigit(normalized[start])) continue;
    let separator = start;
    while (separator < normalized.length && separator - start < 4 && isAsciiDigit(normalized[separator])) separator += 1;
    const leftLength = separator - start;
    if (leftLength < 2 || normalized[separator] !== 'x') continue;
    const rightStart = separator + 1;
    let rightEnd = rightStart;
    while (rightEnd < normalized.length && rightEnd - rightStart < 4 && isAsciiDigit(normalized[rightEnd])) rightEnd += 1;
    if (rightEnd - rightStart < 2) continue;
    return `${Number(normalized.slice(start, separator))}x${Number(normalized.slice(rightStart, rightEnd))}`;
  }
  return null;
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

function isUnitBoundary(value: string | undefined) {
  return value === undefined || isWhitespace(value) || value === ',' || value === ';' || value === ')';
}

function findNumberWithUnit(input: {
  text: string;
  units: string[];
  minIntegerDigits?: number;
  maxIntegerDigits?: number;
  allowDecimal?: boolean;
}) {
  const lower = input.text.toLocaleLowerCase('ru');
  const minimumDigits = input.minIntegerDigits ?? 1;
  for (let start = 0; start < input.text.length; start += 1) {
    if (!isAsciiDigit(input.text[start])) continue;
    let numberEnd = start;
    while (
      numberEnd < input.text.length &&
      isAsciiDigit(input.text[numberEnd]) &&
      (input.maxIntegerDigits === undefined || numberEnd - start < input.maxIntegerDigits)
    ) {
      numberEnd += 1;
    }
    if (numberEnd - start < minimumDigits) continue;
    if (input.allowDecimal && (input.text[numberEnd] === ',' || input.text[numberEnd] === '.') && isAsciiDigit(input.text[numberEnd + 1] ?? '')) {
      numberEnd += 1;
      while (numberEnd < input.text.length && isAsciiDigit(input.text[numberEnd])) numberEnd += 1;
    }
    let unitStart = numberEnd;
    while (unitStart < input.text.length && isWhitespace(input.text[unitStart])) unitStart += 1;
    for (const unit of input.units) {
      if (!lower.startsWith(unit, unitStart)) continue;
      const end = unitStart + unit.length;
      if (isUnitBoundary(input.text[end])) return input.text.slice(start, end);
    }
  }
  return null;
}

function findPlateSizeRaw(value: string) {
  for (let start = 0; start < value.length; start += 1) {
    if (!isAsciiDigit(value[start])) continue;
    let separator = start;
    while (separator < value.length && separator - start < 4 && isAsciiDigit(value[separator])) separator += 1;
    if (separator - start < 2) continue;
    let separatorStart = separator;
    while (separatorStart < value.length && isWhitespace(value[separatorStart])) separatorStart += 1;
    if (!['x', 'х', 'Х', 'X'].includes(value[separatorStart])) continue;
    let rightStart = separatorStart + 1;
    while (rightStart < value.length && isWhitespace(value[rightStart])) rightStart += 1;
    let rightEnd = rightStart;
    while (rightEnd < value.length && rightEnd - rightStart < 4 && isAsciiDigit(value[rightEnd])) rightEnd += 1;
    if (rightEnd - rightStart >= 2) return value.slice(start, rightEnd);
  }
  return null;
}

export function extractAttributesFromProductName(product: Product): ExtractedProductAttributes {
  const name = product.name;
  const result: ExtractedProductAttributes = {};

  const weightMatch = findNumberWithUnit({ text: name, units: ['кг'], allowDecimal: true });
  if (weightMatch) {
    const item = extracted('weightKg', weightMatch, 'name');
    if (item) result.weightKg = item;
  }

  const forceMatch = findNumberWithUnit({ text: name, units: ['кн', 'kn'], allowDecimal: true });
  if (forceMatch) {
    const item = extracted('centrifugalForceKn', forceMatch, 'name');
    if (item) result.centrifugalForceKn = item;
  }

  const plateMatch = findPlateSizeRaw(name);
  if (plateMatch) {
    const item = extracted('plateSizeMm', plateMatch, 'name');
    if (item) result.plateSizeMm = item;
  }

  const voltageMatch = findNumberWithUnit({
    text: name,
    units: ['в', 'v'],
    minIntegerDigits: 2,
    maxIntegerDigits: 3
  });
  if (voltageMatch) {
    const item = extracted('voltageV', voltageMatch, 'name');
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
    const length = entries.find((entry) => containsInOrder(entry.keyText.toLocaleLowerCase('ru'), [['длина'], ['основан', 'плит']]));
    const width = entries.find((entry) => containsInOrder(entry.keyText.toLocaleLowerCase('ru'), [['ширина'], ['основан', 'плит']]));
    const lengthNumber = length ? parseNumber(length.valueText) : null;
    const widthNumber = width ? parseNumber(width.valueText) : null;
    if (lengthNumber && widthNumber) return { raw: `${lengthNumber}x${widthNumber}`, key: `${length?.keyText}/${width?.keyText}` };
  }

  const direct = entries.find((entry) => specKeyMatches(attribute, entry.keyText));
  if (direct) return { raw: direct.valueText, key: direct.keyText };

  return null;
}

export function extractStructuredProductAttributes(product: Product): ExtractedProductAttributes {
  const result: ExtractedProductAttributes = {};
  for (const attribute of productAttributeKeys) {
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
