import type { CatalogProductInput, Product } from '../shared/types.js';

export function absoluteUrl(value: string | undefined, baseUrl: string) {
  if (!value) return undefined;
  try {
    return new URL(value, baseUrl).toString();
  } catch {
    return undefined;
  }
}

export function slugFromUrl(url: string | undefined) {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    return parsed.pathname.split('/').filter(Boolean).join('/');
  } catch {
    return undefined;
  }
}

function isWhitespace(char: string) {
  return char.trim().length === 0;
}

function removeWhitespace(value: string) {
  let output = '';
  for (const char of value) {
    if (!isWhitespace(char)) output += char;
  }
  return output;
}

function collapseWhitespace(value: string, separator: string) {
  let output = '';
  let pendingSeparator = false;
  for (const char of value.trim()) {
    if (isWhitespace(char)) {
      pendingSeparator = output.length > 0;
      continue;
    }
    if (pendingSeparator) {
      output += separator;
      pendingSeparator = false;
    }
    output += char;
  }
  return output;
}

function replaceFirstComma(value: string) {
  let output = '';
  let replaced = false;
  for (const char of value) {
    if (char === ',' && !replaced) {
      output += '.';
      replaced = true;
      continue;
    }
    output += char;
  }
  return output;
}

function isDigit(char: string) {
  return char >= '0' && char <= '9';
}

function firstPriceNumber(value: string) {
  let index = 0;
  while (index < value.length && !isDigit(value[index])) index += 1;
  if (index >= value.length) return undefined;

  let numberText = '';
  while (index < value.length && isDigit(value[index])) {
    numberText += value[index];
    index += 1;
  }

  if (value[index] === '.' && isDigit(value[index + 1])) {
    numberText += '.';
    index += 1;
    while (index < value.length && isDigit(value[index])) {
      numberText += value[index];
      index += 1;
    }
  }

  return Number(numberText);
}

export function parsePrice(value: string | undefined) {
  if (!value) return undefined;
  return firstPriceNumber(replaceFirstComma(removeWhitespace(value)));
}

export function normalizeSpecKey(value: string) {
  const collapsed = collapseWhitespace(value, ' ');
  const withoutTrailingColon = collapsed.endsWith(':') ? collapsed.slice(0, -1) : collapsed;
  return withoutTrailingColon.toLowerCase();
}

export function cleanText(value: string | undefined | null) {
  return collapseWhitespace(value ?? '', ' ');
}

export function productToEmbeddingText(product: CatalogProductInput | Product) {
  const specs = 'specs' in product ? JSON.stringify(product.specs ?? {}) : '';
  return [
    product.name,
    product.brand,
    product.category,
    product.description,
    specs
  ]
    .filter(Boolean)
    .join('\n')
    .slice(0, 8000);
}

export function normalizeCsvHeader(header: string) {
  return collapseWhitespace(header, '_').toLowerCase();
}
