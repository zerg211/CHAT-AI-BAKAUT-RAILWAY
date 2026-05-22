import type {
  CardConstraintStatus,
  CardManifest,
  CardManifestRole,
  ExecutionContract,
  ProductCard,
  ProductSelectionClass,
  ProductSelectionCriteria
} from '../shared/types.js';
import { hasElectricStartSignal } from './productClassifier.js';

function isWhitespace(char: string) {
  return char === ' ' || char === '\n' || char === '\r' || char === '\t';
}

function compactWhitespace(value: string) {
  let result = '';
  let pendingSpace = false;
  for (const char of value.trim()) {
    if (isWhitespace(char)) {
      pendingSpace = result.length > 0;
      continue;
    }
    if (pendingSpace) {
      result += ' ';
      pendingSpace = false;
    }
    result += char;
  }
  return result;
}

function normalized(value: unknown) {
  return compactWhitespace(String(value ?? '').toLocaleLowerCase('ru-RU'));
}

function cardText(card: ProductCard) {
  return normalized([
    card.name,
    card.brand,
    card.category,
    ...Object.entries(card.specs ?? {}).flatMap(([key, value]) => [key, value])
  ].join(' '));
}

function containsAny(text: string, signals: string[]) {
  return signals.some((signal) => text.includes(signal));
}

function classifyCard(card: ProductCard): ProductSelectionClass {
  const text = cardText(card);
  if (containsAny(text, ['генератор', 'электростанц', 'generator'])) return 'generator';
  if (containsAny(text, ['виброплит', 'plate compactor'])) return 'plate';
  if (containsAny(text, ['вибротрамб', 'трамбов', 'rammer'])) return 'rammer';
  if (containsAny(text, ['швонарез', 'резчик', 'cutter'])) return 'cutter';
  if (containsAny(text, ['затироч', 'trowel'])) return 'trowel';
  if (containsAny(text, ['сварочн', 'welding'])) return 'weldingGenerator';
  if (containsAny(text, ['коронк', 'diamond core'])) return 'diamondCore';
  return 'unknown';
}

function hasFuel(card: ProductCard, fuel: ProductSelectionCriteria['fuel']) {
  if (!fuel || fuel === 'any' || fuel === 'unknown') return true;
  const text = cardText(card);
  if (fuel === 'gasoline') return containsAny(text, ['бензин', 'gasoline', 'petrol']) && !containsAny(text, ['дизел', 'diesel']);
  if (fuel === 'diesel') return containsAny(text, ['дизел', 'diesel']);
  return true;
}

function hasAnyVoltageSignal(text: string, numbers: string[], units: string[]) {
  return numbers.some((number) =>
    units.some((unit) => text.includes(`${number}${unit}`) || text.includes(`${number} ${unit}`))
  );
}

function hasSinglePhase220(card: ProductCard, singlePhase220: boolean | null | undefined) {
  if (singlePhase220 === null || typeof singlePhase220 === 'undefined') return true;
  const text = cardText(card);
  const has220 = hasAnyVoltageSignal(text, ['220', '230'], ['в', 'v']) ||
    containsAny(text, ['1ф', '1 ф', '1-ф', 'однофаз']);
  const has380 = hasAnyVoltageSignal(text, ['380', '400'], ['в', 'v']) ||
    containsAny(text, ['3ф', '3 ф', '3-ф', 'трехфаз', 'трёхфаз']);
  return singlePhase220 ? has220 && !has380 : has380;
}

function hasStartType(card: ProductCard, startType: ProductSelectionCriteria['startType']) {
  if (!startType || startType === 'any' || startType === 'unknown') return true;
  const text = cardText(card);
  if (startType === 'electric') return hasElectricStartSignal(text);
  if (startType === 'manual') {
    return containsAny(text, [
      '\u0440\u0443\u0447\u043d',
      'manual',
      'recoil'
    ]);
  }
  return true;
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
  if (!hasStartType(card, constraints.startType)) violations.push(`startType:${constraints.startType}`);
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
