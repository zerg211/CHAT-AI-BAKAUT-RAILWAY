import { z } from 'zod';
import type { Message } from '../shared/types.js';
import { knownProductContext } from './platformProductContext.js';

function hasTextControl(value: string): boolean {
  return [...value].some(char => {
    const code = char.charCodeAt(0);
    return code < 32 || (code >= 127 && code <= 159) || code === 8232 || code === 8233;
  });
}

function savedName(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim() || Array.from(value).length > 500 ||
      hasTextControl(value)) return null;
  return value;
}

function savedUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 2048 || !value.startsWith('https://bakautprof.ru/catalog/') ||
      value.includes(' ') || hasTextControl(value)) return null;
  try {
    const url = new URL(value);
    return url.origin === 'https://bakautprof.ru' && !url.username && !url.password && !url.port &&
      !url.search && !url.hash && url.pathname.startsWith('/catalog/') && url.pathname.length > '/catalog/'.length ? value : null;
  } catch {
    return null;
  }
}

const productId = z.string().length(24).refine(value => [...value].every(char => '0123456789abcdef'.includes(char)));
const revision = z.string().min(1).max(200).refine(value => value === value.trim());
const referenceSchema = z.discriminatedUnion('status', [
  z.object({ productId, status: z.literal('saved_card'), sourceMessageId: z.string().uuid(), catalogRevision: revision,
    name: z.unknown().default(null).transform(savedName), sourceUrl: z.unknown().default(null).transform(savedUrl) }).strict(),
  z.object({ productId, status: z.literal('unavailable'),
    reason: z.enum(['missing_card', 'ambiguous_card', 'unverified_card', 'invalid_reference']) }).strict()
]);

export type LeadProductReference = z.infer<typeof referenceSchema>;

function unavailable(id: string, reason: Extract<LeadProductReference, { status: 'unavailable' }>['reason']): LeadProductReference {
  return { productId: id, status: 'unavailable', reason };
}

export function normalizeLeadProductReferences(value: unknown, ids: readonly string[]): LeadProductReference[] | undefined {
  if (value === undefined) return undefined;
  return ids.map(id => {
    const matches = Array.isArray(value) ? value.filter(item => item?.productId === id) : [];
    if (matches.length > 1) return unavailable(id, 'ambiguous_card');
    const parsed = referenceSchema.safeParse(matches[0]);
    return parsed.success ? parsed.data : unavailable(id, 'invalid_reference');
  });
}

export function buildLeadProductReferences(input: {
  messages: readonly Message[]; requestId: string; productIds: readonly string[];
}): LeadProductReference[] {
  const matchesRequest = (message: Message) => {
    const request = message.metadata.availabilityRequest;
    return message.role === 'assistant' && request !== null && typeof request === 'object' &&
      'id' in request && request.id === input.requestId;
  };
  const requestIndex = input.messages.findIndex(matchesRequest);
  const anchor = input.messages[requestIndex];
  const ambiguousAnchor = anchor && input.messages.some(message => message.id !== anchor.id &&
    message.createdAt === anchor.createdAt && matchesRequest(message));
  const history = requestIndex < 0 ? input.messages : input.messages.slice(0, requestIndex + 1);
  return input.productIds.map(id => {
    if (ambiguousAnchor) return unavailable(id, 'ambiguous_card');
    const anchorHasCard = anchor && Array.isArray(anchor.metadata.productCards) && anchor.metadata.productCards.some(card => card?.id === id);
    if (anchor && !anchorHasCard && input.messages.some(message => message.id !== anchor.id &&
        message.role === 'assistant' && message.createdAt === anchor.createdAt && Array.isArray(message.metadata.productCards) &&
        message.metadata.productCards.some(card => card?.id === id))) return unavailable(id, 'ambiguous_card');
    for (let index = history.length - 1; index >= 0; index--) {
      const message = history[index];
      if (message.role !== 'assistant' || !Array.isArray(message.metadata.productCards)) continue;
      const cards = message.metadata.productCards.filter(card => card?.id === id);
      if (!cards.length) continue;
      if (cards.length !== 1) return unavailable(id, 'ambiguous_card');
      if (message.id !== anchor?.id && input.messages.some(other => other.id !== message.id && other.role === 'assistant' &&
            other.createdAt === message.createdAt && Array.isArray(other.metadata.productCards) &&
            other.metadata.productCards.some(card => card?.id === id))) return unavailable(id, 'ambiguous_card');
      const known = knownProductContext(message.metadata.knownProducts);
      if (!['openai_platform_agent', 'openai_responses_saved_agent'].includes(String(message.metadata.runtimeMode)) ||
          !known?.product_ids.includes(id) || known.source_revision !== message.metadata.catalogRevision) {
        return unavailable(id, 'unverified_card');
      }
      const card = cards[0];
      const parsed = referenceSchema.safeParse({ productId: id, status: 'saved_card', sourceMessageId: message.id,
        catalogRevision: message.metadata.catalogRevision, name: card.name, sourceUrl: card.sourceUrl });
      return parsed.success ? parsed.data : unavailable(id, 'unverified_card');
    }
    return unavailable(id, 'missing_card');
  });
}
