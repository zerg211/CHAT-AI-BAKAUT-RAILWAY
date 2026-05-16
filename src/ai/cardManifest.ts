import type {
  CardConstraintStatus,
  CardManifest,
  CardManifestRole,
  ExecutionContract,
  ProductCard,
  ProductSelectionClass,
  ProductSelectionCriteria
} from '../shared/types.js';

function normalized(value: unknown) {
  return String(value ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function cardText(card: ProductCard) {
  return normalized([
    card.name,
    card.brand,
    card.category,
    ...Object.entries(card.specs ?? {}).flatMap(([key, value]) => [key, value])
  ].join(' '));
}

function classifyCard(card: ProductCard): ProductSelectionClass {
  const text = cardText(card);
  if (/(генератор|электростанц|generator)/iu.test(text)) return 'generator';
  if (/(виброплит|plate compactor)/iu.test(text)) return 'plate';
  if (/(вибротрамб|трамбов|rammer)/iu.test(text)) return 'rammer';
  if (/(швонарез|резчик|cutter)/iu.test(text)) return 'cutter';
  if (/(затироч|trowel)/iu.test(text)) return 'trowel';
  if (/(сварочн|welding)/iu.test(text)) return 'weldingGenerator';
  if (/(коронк|diamond core)/iu.test(text)) return 'diamondCore';
  return 'unknown';
}

function hasFuel(card: ProductCard, fuel: ProductSelectionCriteria['fuel']) {
  if (!fuel || fuel === 'any' || fuel === 'unknown') return true;
  const text = cardText(card);
  if (fuel === 'gasoline') return /(бензин|gasoline|petrol)/iu.test(text) && !/(дизел|diesel)/iu.test(text);
  if (fuel === 'diesel') return /(дизел|diesel)/iu.test(text);
  return true;
}

function hasSinglePhase220(card: ProductCard, singlePhase220: boolean | null | undefined) {
  if (singlePhase220 === null || typeof singlePhase220 === 'undefined') return true;
  const text = cardText(card);
  const has220 = /(?:220\s*в|220\s*v|230\s*в|230\s*v|1[-\s]?ф|однофаз)/iu.test(text);
  const has380 = /(?:380\s*в|380\s*v|400\s*в|400\s*v|3[-\s]?ф|тр[её]хфаз)/iu.test(text);
  return singlePhase220 ? has220 && !has380 : has380;
}

function hardConstraintViolations(card: ProductCard, constraints?: ProductSelectionCriteria) {
  if (!constraints) return [];
  const violations: string[] = [];
  const text = cardText(card);
  const intent = constraints.productIntent;

  if (intent && intent !== 'unknown') {
    const cardClass = classifyCard(card);
    if (cardClass !== 'unknown' && cardClass !== intent) violations.push(`productIntent:${intent}`);
  }
  if (constraints.brandConstraint) {
    const expectedBrand = normalized(constraints.brandConstraint);
    const actualBrand = normalized(card.brand);
    if (actualBrand ? actualBrand !== expectedBrand : !text.includes(expectedBrand)) {
      violations.push(`brandConstraint:${constraints.brandConstraint}`);
    }
  }
  if (constraints.exactModelConstraint && !text.includes(normalized(constraints.exactModelConstraint))) {
    violations.push(`exactModelConstraint:${constraints.exactModelConstraint}`);
  }
  for (const token of constraints.exactModelTokens ?? []) {
    if (token && !text.includes(normalized(token))) violations.push(`exactModelToken:${token}`);
  }
  if (!hasFuel(card, constraints.fuel)) violations.push(`fuel:${constraints.fuel}`);
  if (!hasSinglePhase220(card, constraints.singlePhase220)) {
    violations.push(`singlePhase220:${constraints.singlePhase220}`);
  }
  return violations;
}

function roleForCard(input: {
  rank: number;
  visible: boolean;
  policy: ExecutionContract['cardsPolicy'];
}): CardManifestRole {
  if (!input.visible) return 'hidden';
  if (input.policy === 'primary' || (input.policy === 'selected_only' && input.rank === 1)) return 'primary';
  if (input.policy === 'supporting' || input.policy === 'selected_only') return 'supporting';
  return input.rank === 1 ? 'primary' : 'alternative';
}

function constraintStatus(violations: string[], constraints?: ProductSelectionCriteria): CardConstraintStatus {
  if (violations.length) return 'violates_hard_constraints';
  if (!constraints || constraints.productIntent === 'unknown') return 'unchecked';
  return 'satisfies_hard_constraints';
}

export function buildCardManifest(input: {
  executionContract: ExecutionContract;
  cards: ProductCard[];
  visibleProductIds: string[];
  hiddenProductIds: string[];
}): CardManifest {
  const visibleIds = new Set(input.visibleProductIds);
  const warnings: string[] = [];
  const items = input.cards.map((card, index) => {
    const visible = visibleIds.has(card.id);
    const violations = visible ? hardConstraintViolations(card, input.executionContract.activeConstraints) : [];
    if (visible && violations.length) warnings.push(`visible_card_constraint_violation:${card.id}`);
    return {
      productId: card.id,
      name: card.name,
      rank: index + 1,
      visible,
      role: roleForCard({ rank: index + 1, visible, policy: input.executionContract.cardsPolicy }),
      constraintStatus: visible
        ? constraintStatus(violations, input.executionContract.activeConstraints)
        : 'unchecked',
      violations
    };
  });

  return {
    version: 1,
    source: 'execution_contract',
    cardsPolicy: input.executionContract.cardsPolicy,
    visibleProductIds: [...input.visibleProductIds],
    hiddenProductIds: [...input.hiddenProductIds],
    items,
    warnings
  };
}

export function visibleCardConstraintViolationIds(manifest: CardManifest) {
  return manifest.items
    .filter((item) => item.visible && item.constraintStatus === 'violates_hard_constraints')
    .map((item) => item.productId);
}

export function enforceVisibleCardConstraints(input: {
  manifest: CardManifest;
  cards: ProductCard[];
}) {
  const suppressedProductIds = visibleCardConstraintViolationIds(input.manifest);
  if (!suppressedProductIds.length) {
    return { cards: input.cards, suppressedProductIds, enforced: false };
  }
  const suppressed = new Set(suppressedProductIds);
  return {
    cards: input.cards.filter((card) => !suppressed.has(card.id)),
    suppressedProductIds,
    enforced: true
  };
}
