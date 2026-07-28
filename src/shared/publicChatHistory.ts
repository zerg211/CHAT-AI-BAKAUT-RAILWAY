import type { CardDisplayOptions, ProductCard } from './types.js';

export const PUBLIC_HISTORY_MAX_CARDS = 50;
export const PUBLIC_HISTORY_MAX_RESPONSE_BYTES = 512_000;
const MAX_MESSAGE_CONTENT = 100_000;
const MAX_CARD_ID = 200;
const MAX_CARD_NAME = 500;
const MAX_CARD_LABEL = 200;
const MAX_CURRENCY = 16;
const MAX_URL = 2_048;
const MAX_CARD_LIST_ITEMS = 20;
const MAX_CARD_LIST_ITEM = 500;
const MAX_SPEC_ENTRIES = 50;
const MAX_SPEC_KEY = 100;
const MAX_SPEC_STRING = 500;
const BLOCKED_SPEC_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

export interface PublicChatHistoryMessage {
  id?: string;
  role: 'user' | 'assistant';
  content: string;
  products?: ProductCard[];
  cardDisplay?: CardDisplayOptions;
  leadRequested?: boolean;
  createdAt?: string;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function boundedString(value: unknown, maxLength: number, allowEmpty = false) {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().slice(0, maxLength);
  return normalized || allowEmpty ? normalized : undefined;
}

function safePublicUrl(value: unknown) {
  const normalized = boundedString(value, MAX_URL);
  if (!normalized) return undefined;
  try {
    const parsed = new URL(normalized);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;
    return normalized;
  } catch {
    return undefined;
  }
}

function boundedStringArray(value: unknown) {
  if (!Array.isArray(value)) return [];
  const result: string[] = [];
  for (const item of value) {
    const normalized = boundedString(item, MAX_CARD_LIST_ITEM);
    if (normalized) result.push(normalized);
    if (result.length >= MAX_CARD_LIST_ITEMS) break;
  }
  return result;
}

function normalizeSpecs(value: unknown) {
  const source = record(value);
  if (!source) return {};
  const result: Record<string, string | number | boolean> = {};
  for (const [rawKey, rawValue] of Object.entries(source)) {
    const key = boundedString(rawKey, MAX_SPEC_KEY);
    if (!key || BLOCKED_SPEC_KEYS.has(key)) continue;
    if (typeof rawValue === 'string') {
      const normalized = boundedString(rawValue, MAX_SPEC_STRING, true);
      if (normalized !== undefined) result[key] = normalized;
    } else if (typeof rawValue === 'number' && Number.isFinite(rawValue)) {
      result[key] = rawValue;
    } else if (typeof rawValue === 'boolean') {
      result[key] = rawValue;
    }
    if (Object.keys(result).length >= MAX_SPEC_ENTRIES) break;
  }
  return result;
}

export function normalizePublicProductCard(value: unknown): ProductCard | null {
  const source = record(value);
  if (!source) return null;
  const id = boundedString(source.id, MAX_CARD_ID);
  const name = boundedString(source.name, MAX_CARD_NAME);
  if (!id || !name) return null;

  const card: ProductCard = {
    id,
    name,
    specs: normalizeSpecs(source.specs),
    reasons: boundedStringArray(source.reasons),
    caveats: boundedStringArray(source.caveats)
  };
  const brand = boundedString(source.brand, MAX_CARD_LABEL);
  const category = boundedString(source.category, MAX_CARD_LABEL);
  const currency = boundedString(source.currency, MAX_CURRENCY);
  const imageUrl = safePublicUrl(source.imageUrl);
  const sourceUrl = safePublicUrl(source.sourceUrl);
  if (brand) card.brand = brand;
  if (category) card.category = category;
  if (typeof source.price === 'number' && Number.isFinite(source.price) && source.price >= 0 && source.price <= 1_000_000_000_000) {
    card.price = source.price;
  }
  if (currency) card.currency = currency;
  if (imageUrl) card.imageUrl = imageUrl;
  if (sourceUrl) card.sourceUrl = sourceUrl;
  return card;
}

export function normalizePublicProductCards(value: unknown) {
  if (!Array.isArray(value)) return [];
  const cards: ProductCard[] = [];
  for (const candidate of value) {
    const card = normalizePublicProductCard(candidate);
    if (card) cards.push(card);
    if (cards.length >= PUBLIC_HISTORY_MAX_CARDS) break;
  }
  return cards;
}

export function normalizePublicCardDisplay(value: unknown): CardDisplayOptions | undefined {
  const source = record(value);
  if (!source || typeof source.initialVisibleCount !== 'number' || !Number.isFinite(source.initialVisibleCount)) {
    return undefined;
  }
  const initialVisibleCount = Math.max(
    1,
    Math.min(PUBLIC_HISTORY_MAX_CARDS, Math.floor(source.initialVisibleCount))
  );
  return { initialVisibleCount };
}

export function normalizePublicHistoryMessage(value: unknown): PublicChatHistoryMessage | null {
  const source = record(value);
  if (!source || (source.role !== 'user' && source.role !== 'assistant')) return null;
  const content = boundedString(source.content, MAX_MESSAGE_CONTENT);
  if (!content) return null;

  const result: PublicChatHistoryMessage = { role: source.role, content };
  const id = boundedString(source.id, MAX_CARD_ID);
  const createdAt = boundedString(source.createdAt, 100);
  if (id) result.id = id;
  if (createdAt) result.createdAt = createdAt;

  if (source.role === 'assistant') {
    const products = normalizePublicProductCards(source.products);
    const cardDisplay = normalizePublicCardDisplay(source.cardDisplay);
    if (products.length) result.products = products;
    if (cardDisplay) result.cardDisplay = cardDisplay;
    if (source.leadRequested === true) result.leadRequested = true;
  }
  return result;
}

export function normalizePublicHistoryMessages(value: unknown) {
  if (!Array.isArray(value)) return [];
  const messages: PublicChatHistoryMessage[] = [];
  for (const candidate of value) {
    const message = normalizePublicHistoryMessage(candidate);
    if (message) messages.push(message);
    if (messages.length >= 80) break;
  }
  return messages;
}

function utf8ByteLength(value: string) {
  return new TextEncoder().encode(value).byteLength;
}

export function limitPublicHistoryResponse(
  messages: PublicChatHistoryMessage[],
  maxBytes = PUBLIC_HISTORY_MAX_RESPONSE_BYTES
) {
  const limited: PublicChatHistoryMessage[] = [];
  let encodedBytes = utf8ByteLength('{"messages":[]}');
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message) continue;
    const separatorBytes = limited.length > 0 ? 1 : 0;
    const nextBytes = encodedBytes + separatorBytes + utf8ByteLength(JSON.stringify(message));
    if (nextBytes > maxBytes) continue;
    limited.unshift(message);
    encodedBytes = nextBytes;
  }
  return limited;
}
