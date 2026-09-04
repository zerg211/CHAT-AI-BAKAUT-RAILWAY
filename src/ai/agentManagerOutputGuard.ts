import type { CardDisplayOptions, ChatResponsePayload, ProductCard } from '../shared/types.js';

export interface PublicCustomerResponsePayload {
  turnId?: string;
  answer: string;
  productCards: ProductCard[];
  cardDisplay?: CardDisplayOptions;
  leadRequested?: boolean;
  assistantMessageId?: string;
}

export interface CustomerOutputGuardIssue {
  code: 'customer_output_internal_vocabulary' | 'customer_output_empty';
  message: string;
  evidence: string;
}

export interface CustomerOutputGuardResult {
  ok: boolean;
  issues: CustomerOutputGuardIssue[];
}

// Runtime identifiers and error telemetry retain a deterministic boundary.
// Source attribution and search/check completion require buyer context and are
// owned by the mandatory, fail-closed semantic reviewer. See the independent
// missing/malformed-review and disclosure regressions before changing this list.
const forbiddenCustomerFragments = [
  'agent_manager',
  'turncontract',
  'turn contract',
  'planner',
  'tool result',
  'web tool',
  'search tool',
  'research tool',
  'tool call',
  'tool execution',
  'the tool failed',
  'timeout',
  'тайм-аут',
  'таймаут',
  'recovery',
  'retry',
  'pipeline',
  'internal error',
  'поисковый инструмент',
  'исследовательский инструмент',
  'инструмент поиска',
  'инструмент не сработал',
  'пайплайн'
] as const;

/**
 * Last-mile text boundary. Factual grounding and card fit are checked by the
 * existing evidence guards; this boundary deals only with customer-facing
 * leakage that must never be repaired into a visible answer.
 */
export function guardCustomerOutput(input: {
  answerText: string;
  productCards: ProductCard[];
}): CustomerOutputGuardResult {
  const answerText = input.answerText.trim();
  const issues: CustomerOutputGuardIssue[] = [];
  if (!answerText) {
    issues.push({
      code: 'customer_output_empty',
      message: 'Customer answer must contain non-empty text.',
      evidence: 'answerText is empty'
    });
    return { ok: false, issues };
  }

  const normalized = [answerText, ...input.productCards.flatMap((card) => [...card.reasons, ...card.caveats])]
    .join('\n').toLowerCase();
  const leaked = forbiddenCustomerFragments.filter((fragment) => normalized.includes(fragment));
  if (leaked.length) {
    issues.push({
      code: 'customer_output_internal_vocabulary',
      message: 'Customer answer contains internal runtime vocabulary.',
      evidence: leaked.join(', ')
    });
  }
  return { ok: issues.length === 0, issues };
}

function publicCard(card: ProductCard): ProductCard {
  return {
    id: card.id,
    name: card.name,
    ...(card.brand !== undefined ? { brand: card.brand } : {}),
    ...(card.category !== undefined ? { category: card.category } : {}),
    ...(card.price !== undefined ? { price: card.price } : {}),
    ...(card.currency !== undefined ? { currency: card.currency } : {}),
    ...(card.imageUrl !== undefined ? { imageUrl: card.imageUrl } : {}),
    ...(card.sourceUrl !== undefined ? { sourceUrl: card.sourceUrl } : {}),
    specs: card.specs,
    reasons: [...card.reasons],
    caveats: [...card.caveats]
  };
}

/**
 * Converts the server-side response into the only payload allowed over the
 * customer SSE/history boundary. Rich metadata remains available to the
 * protected admin trace and persisted assistant message.
 */
export function buildPublicCustomerResponse(
  payload: ChatResponsePayload
): PublicCustomerResponsePayload {
  return {
    ...(payload.turnId ? { turnId: payload.turnId } : {}),
    answer: payload.answer,
    productCards: payload.productCards.map(publicCard),
    ...(payload.cardDisplay ? { cardDisplay: payload.cardDisplay } : {}),
    ...(payload.leadRequested !== undefined ? { leadRequested: payload.leadRequested } : {}),
    ...(payload.assistantMessageId ? { assistantMessageId: payload.assistantMessageId } : {})
  };
}
