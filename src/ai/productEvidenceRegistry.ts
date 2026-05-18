import type {
  CardConstraintStatus,
  CardManifest,
  ExecutionContract,
  Product,
  ProductCard,
  ProductEvidenceItem,
  ProductEvidenceRegistry,
  ProductSelectionRejection
} from '../shared/types.js';

function normalized(value: unknown) {
  return String(value ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function unique<T>(items: T[]) {
  return [...new Set(items)];
}

function roleForManifestItem(role: string): ProductEvidenceItem['role'] {
  if (role === 'primary') return 'primary';
  if (role === 'supporting') return 'supporting';
  if (role === 'hidden') return 'hidden';
  return 'alternative';
}

function itemAllowsText(status: CardConstraintStatus, visible: boolean, role: ProductEvidenceItem['role']) {
  return (visible || role === 'hidden') && status !== 'violates_hard_constraints';
}

function itemAllowsVisibleCard(status: CardConstraintStatus, visible: boolean) {
  return visible && status !== 'violates_hard_constraints';
}

export function buildProductEvidenceRegistry(input: {
  executionContract: ExecutionContract;
  cardManifest: CardManifest;
  cards: ProductCard[];
  catalogProducts?: Product[];
  rejectedProducts?: ProductSelectionRejection[];
}): ProductEvidenceRegistry {
  const cardsById = new Map(input.cards.map((card) => [card.id, card]));
  const catalogProductNameById = new Map((input.catalogProducts ?? []).map((product) => [product.id, product.name]));
  const rejectionById = new Map((input.rejectedProducts ?? []).map((item) => [item.productId, item.reason]));
  const warnings: string[] = [];
  const items: ProductEvidenceItem[] = [];

  for (const manifestItem of input.cardManifest.items) {
    const card = cardsById.get(manifestItem.productId);
    if (!card) {
      warnings.push(`manifest_product_missing_card:${manifestItem.productId}`);
      continue;
    }
    const visible = manifestItem.visible;
    const role = roleForManifestItem(manifestItem.role);
    const allowedInAnswerText = itemAllowsText(manifestItem.constraintStatus, visible, role);
    const allowedAsVisibleCard = itemAllowsVisibleCard(manifestItem.constraintStatus, visible);
    if (visible && !allowedAsVisibleCard) warnings.push(`visible_product_not_allowed:${manifestItem.productId}`);
    items.push({
      productId: card.id,
      name: card.name,
      source: 'visible_card',
      role,
      allowedInAnswerText,
      allowedAsVisibleCard,
      rejectionReason: rejectionById.get(card.id),
      constraintStatus: manifestItem.constraintStatus,
      evidence: [
        `cardsPolicy:${input.executionContract.cardsPolicy}`,
        `manifestRole:${manifestItem.role}`,
        `constraintStatus:${manifestItem.constraintStatus}`
      ]
    });
  }

  for (const rejected of input.rejectedProducts ?? []) {
    if (items.some((item) => item.productId === rejected.productId)) continue;
    items.push({
      productId: rejected.productId,
      name: catalogProductNameById.get(rejected.productId) ?? rejected.productId,
      source: 'catalog',
      role: 'rejected',
      allowedInAnswerText: false,
      allowedAsVisibleCard: false,
      rejectionReason: rejected.reason,
      constraintStatus: 'violates_hard_constraints',
      evidence: [`rejected:${rejected.reason}`]
    });
  }

  const visibleProductIds = items
    .filter((item) => item.allowedAsVisibleCard && input.cardManifest.visibleProductIds.includes(item.productId))
    .map((item) => item.productId);
  const hiddenProductIds = input.cardManifest.hiddenProductIds.filter((id) =>
    items.some((item) => item.productId === id)
  );
  const rejectedProductIds = unique([
    ...items.filter((item) => item.role === 'rejected' || item.constraintStatus === 'violates_hard_constraints').map((item) => item.productId),
    ...(input.rejectedProducts ?? []).map((item) => item.productId)
  ]);
  const allowedProductIdsForText = items
    .filter((item) => item.allowedInAnswerText)
    .map((item) => item.productId);

  if (input.executionContract.cardsPolicy === 'primary' && visibleProductIds.length === 0) {
    warnings.push('primary_cards_policy_without_allowed_visible_cards');
  }

  return {
    version: 1,
    items,
    visibleProductIds,
    hiddenProductIds,
    rejectedProductIds,
    allowedProductIdsForText,
    warnings: unique([...warnings, ...input.cardManifest.warnings])
  };
}

export function compactProductEvidenceRegistry(registry: ProductEvidenceRegistry) {
  return {
    version: registry.version,
    visibleProductIds: registry.visibleProductIds,
    hiddenProductIds: registry.hiddenProductIds,
    rejectedProductIds: registry.rejectedProductIds.slice(0, 20),
    allowedProductIdsForText: registry.allowedProductIdsForText,
    warnings: registry.warnings,
    items: registry.items.map((item) => ({
      productId: item.productId,
      name: item.name,
      role: item.role,
      allowedInAnswerText: item.allowedInAnswerText,
      allowedAsVisibleCard: item.allowedAsVisibleCard,
      constraintStatus: item.constraintStatus,
      rejectionReason: item.rejectionReason
    }))
  };
}

export function answerProductReferenceViolations(input: {
  answer: string;
  registry: ProductEvidenceRegistry;
}) {
  const answer = normalized(input.answer);
  const allowed = new Set(input.registry.allowedProductIdsForText);
  return input.registry.items
    .filter((item) => item.name && !allowed.has(item.productId))
    .filter((item) => {
      const name = normalized(item.name);
      if (!name || name.length < 4) return false;
      if (answer.includes(name)) return true;
      const tokens = name.split(/[^a-z0-9\u0430-\u044f\u0451]+/iu).filter((token) => token.length >= 4);
      return tokens.length >= 2 && tokens.every((token) => answer.includes(token));
    })
    .map((item) => item.productId);
}
