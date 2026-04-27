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
    return parsed.pathname.replace(/^\/|\/$/g, '').split('/').filter(Boolean).join('/');
  } catch {
    return undefined;
  }
}

export function parsePrice(value: string | undefined) {
  if (!value) return undefined;
  const normalized = value.replace(/\s+/g, '').replace(',', '.');
  const match = normalized.match(/(\d+(?:\.\d+)?)/);
  if (!match) return undefined;
  return Number(match[1]);
}

export function normalizeSpecKey(value: string) {
  return value
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/:$/, '')
    .toLowerCase();
}

export function cleanText(value: string | undefined | null) {
  return (value ?? '').replace(/\s+/g, ' ').trim();
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
  return header.trim().toLowerCase().replace(/\s+/g, '_');
}
