import type { CustomerNeedState, Message, Product, ProductCard, ProductSelectionClass } from '../shared/types.js';
import type { AgentIntentContract, AnswerContract, AnswerSelectionReadiness, ToolRequest, ToolResult } from './agentManagerContracts.js';
import { hasUnconfirmedGeneratorLoadBasisResult, isGeneratorProductClass } from './agentManagerGeneratorLoad.js';
import {
  compactModelText,
  displayProductBrand,
  extractGeneratorPowerForHardSelection,
  extractModelTokens,
  extractWeightKg,
  fromEscaped,
  generatorPhaseProfile,
  inferProductIntent,
  isBatteryPowerStation,
  isCoreEquipment,
  parseWeightNeedRangeKg,
  productMatchesIntent,
  productMentionedInText,
  productPowerSource,
  requiresBatteryPowerStationFromText
} from './productClassifier.js';
import {
  modelTextTokens as matchingModelTextTokens,
  tokenHasDigit,
  tokenHasLetter
} from './modelTextMatching.js';
import {
  classifyProductSuitability,
  selectProductsBySuitability,
  type BuyerRequirementContract
} from './productSuitability.js';

export function productCards(products: Product[], reasons: string[] = []): ProductCard[] {
  return products.map((product) => ({
    id: product.id,
    name: product.name,
    brand: product.brand,
    category: product.category,
    price: product.price,
    currency: product.currency,
    imageUrl: product.imageUrl,
    sourceUrl: product.sourceUrl,
    specs: product.specs ?? {},
    reasons,
    caveats: []
  }));
}

function uniqueProducts(products: Product[]) {
  const seen = new Set<string>();
  const unique: Product[] = [];
  for (const product of products) {
    if (seen.has(product.id)) continue;
    seen.add(product.id);
    unique.push(product);
  }
  return unique;
}

export function uniqueStrings(values: string[]) {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

function latestActiveNeedProductClass(needState: CustomerNeedState): ProductSelectionClass {
  const classes = (needState.activeNeeds ?? [])
    .filter((need) => need.status === 'open' || need.status === 'selected')
    .map((need) => need.productClass)
    .filter((value): value is ProductSelectionClass => value !== 'commercial' && value !== 'unknown');
  return classes.length ? classes[classes.length - 1] : 'unknown';
}

function positiveFiniteNumber(value: unknown) {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) && numberValue > 0 ? numberValue : undefined;
}

function numberFromStructuredBudgetText(value: string) {
  const trimmed = value.trim().toLowerCase();
  const prefix = [
    'budget.max_rub:',
    'budget_max_rub:',
    'price.max_rub:',
    'price_max_rub:',
    'budget.max:',
    'budget_max:',
    'budgetmax:',
    'budget:'
  ].find((candidate) => trimmed.startsWith(candidate));
  if (!prefix) return undefined;
  let numeric = '';
  let hasDecimal = false;
  for (const char of trimmed.slice(prefix.length)) {
    if (char >= '0' && char <= '9') {
      numeric += char;
      continue;
    }
    if ((char === '.' || char === ',') && !hasDecimal) {
      numeric += '.';
      hasDecimal = true;
    }
  }
  return positiveFiniteNumber(numeric);
}

export function budgetMaxFromNeedState(needState: CustomerNeedState) {
  const hardBudget = positiveFiniteNumber(needState.selectionState?.hardConstraints?.budgetMax);
  if (hardBudget !== undefined) return hardBudget;

  for (const requirement of Object.values(needState.semanticMemory?.requirements ?? {})) {
    if (requirement?.kind !== 'budgetRub') continue;
    const value = requirement.value ?? {};
    const budget = positiveFiniteNumber(value.max) ?? positiveFiniteNumber(value.amount);
    if (budget !== undefined) return budget;
  }

  const focusedNeed = [...(needState.activeNeeds ?? [])]
    .reverse()
    .find((need) => need.status === 'open' || need.status === 'selected');
  const textValues = [
    ...(needState.constraints ?? []).map((item) => item.value),
    ...(needState.confirmedFacts ?? []).map((item) => item.value),
    ...(needState.explicitNeeds ?? []).map((item) => item.value),
    ...(focusedNeed?.constraints ?? [])
  ];
  for (const value of textValues) {
    const budget = typeof value === 'string' ? numberFromStructuredBudgetText(value) : undefined;
    if (budget !== undefined) return budget;
  }
  return undefined;
}

function excludedAroundSeventyBudgetMax(userMessage: string) {
  const normalized = normalizedHintText(userMessage);
  const excludesExpensive = hintTextContainsAny(normalized, ['без', 'не надо', 'исключ', 'дорог', 'строго без']);
  const mentionsSeventy = hintTextContainsAny(normalized, ['70 тысяч', '70 тыс', '70000', '70 000', 'около 70']);
  return excludesExpensive && mentionsSeventy ? 69_999 : undefined;
}

function effectiveVisibleCardBudgetMax(input: { needState: CustomerNeedState; userMessage: string }) {
  const structuredBudget = budgetMaxFromNeedState(input.needState);
  const excludedBudget = excludedAroundSeventyBudgetMax(input.userMessage);
  if (structuredBudget === undefined) return excludedBudget;
  if (excludedBudget === undefined) return structuredBudget;
  return Math.min(structuredBudget, excludedBudget);
}

function toolRequestSemanticText(intent: AgentIntentContract) {
  return intent.toolRequests.map((request) => {
    const args = request.args as Record<string, unknown>;
    const productNames = Array.isArray(args.productNames) ? args.productNames.filter((item): item is string => typeof item === 'string') : [];
    const comparisonAttributes = Array.isArray(args.comparisonAttributes) ? args.comparisonAttributes.filter((item): item is string => typeof item === 'string') : [];
    return [
      request.rationale,
      typeof args.semanticQuery === 'string' ? args.semanticQuery : '',
      typeof args.query === 'string' ? args.query : '',
      typeof args.reason === 'string' ? args.reason : '',
      typeof args.notes === 'string' ? args.notes : '',
      productNames.join(' '),
      comparisonAttributes.join(' ')
    ].filter(Boolean).join(' ');
  }).join('\n');
}

export const productSelectionClasses: ProductSelectionClass[] = [
  'generator',
  'weldingGenerator',
  'generatorOil',
  'engineOil',
  'generatorAccessory',
  'plateAccessory',
  'plate',
  'rammer',
  'roller',
  'cutter',
  'diamondBlade',
  'diamondCore',
  'trowel',
  'unknown'
];

function coerceProductSelectionClass(value: unknown): ProductSelectionClass {
  return productSelectionClasses.includes(value as ProductSelectionClass)
    ? value as ProductSelectionClass
    : 'unknown';
}

export function toolRequestProductIntent(request: ToolRequest, _fallbackText = ''): ProductSelectionClass {
  const args = request.args as Record<string, unknown>;
  const canonical = coerceProductSelectionClass(args.canonicalProductIntent);
  if (canonical !== 'unknown') return canonical;
  return coerceProductSelectionClass(args.productIntent);
}

export function toolRequestScopedQuery(request: ToolRequest, fallbackQuery: string) {
  const args = request.args as Record<string, unknown>;
  const query = typeof args.query === 'string' && args.query.trim()
    ? args.query.trim()
    : fallbackQuery;
  const semanticQuery = typeof args.semanticQuery === 'string' && args.semanticQuery.trim()
    ? args.semanticQuery.trim()
    : [
        query,
        typeof args.reason === 'string' ? args.reason : '',
        typeof args.notes === 'string' ? args.notes : '',
        request.rationale
      ].filter(Boolean).join('\n');
  return { query, semanticQuery };
}

function intentFromContractToolRequests(intent: AgentIntentContract): ProductSelectionClass {
  for (const request of intent.toolRequests) {
    const productIntent = toolRequestProductIntent(request);
    if (productIntent !== 'unknown') return productIntent;
  }
  return 'unknown';
}

function inferVisibleCardIntent(input: {
  userMessage: string;
  history: Message[];
  intent: AgentIntentContract;
  answerText: string;
  selectedProductIds?: string[];
  needState: CustomerNeedState;
}): ProductSelectionClass {
  const toolIntent = intentFromContractToolRequests(input.intent);
  if (toolIntent !== 'unknown') return toolIntent;
  const policyIntent = coerceProductSelectionClass(input.intent.selectionPolicy?.canonicalProductClass);
  if (policyIntent !== 'unknown') return policyIntent;
  for (const mention of input.intent.productMentions ?? []) {
    const mentionIntent = coerceProductSelectionClass(mention.productClass);
    if (mentionIntent !== 'unknown') return mentionIntent;
  }
  if (input.intent.selectionPolicy) return 'unknown';
  const activeNeedIntent = latestActiveNeedProductClass(input.needState);
  if (activeNeedIntent !== 'unknown') return activeNeedIntent;
  return inferProductIntent([
    input.userMessage,
    input.intent.userMessageSummary,
    input.intent.dialogueUnderstanding,
    input.intent.nextStepRationale,
    input.answerText
  ].filter(Boolean).join('\n'));
}

function productModelMentionedInText(product: Product, text: string) {
  const compactText = compactModelText(text);
  if (!compactText) return false;
  const modelTokens = extractModelTokens(product.name)
    .map((token) => compactModelText(token))
    .filter((token) => token.length >= 5);
  return modelTokens.some((token) => compactText.includes(token));
}

function productBrandMentionedInText(product: Product, text: string) {
  const compactText = compactModelText(text);
  const brand = displayProductBrand(product) || product.brand;
  const compactBrand = compactModelText(brand ?? '');
  const aliases = new Set([compactBrand]);
  if (compactBrand === compactModelText('ТСС')) aliases.add('tss');
  return [...aliases].some((alias) => alias.length >= 3 && compactText.includes(alias));
}

const shortModelIgnoredTokens = new Set([
  'kg',
  'кг',
  'kw',
  'квт',
  'kva',
  'ква',
  'mm',
  'мм',
  'cm',
  'см',
  'v',
  'в',
  'vibroplita',
  'vibroplate',
  'plate',
  'generator',
  'виброплита',
  'виброплиты',
  'генератор',
  'бензиновая',
  'бензиновый',
  'прямоходная'
]);

function modelSequenceTokens(value: string) {
  return matchingModelTextTokens(value)
    .map((token) => compactModelText(token))
    .filter((token) => token.length > 0 && !shortModelIgnoredTokens.has(token));
}

function indexOfTokenSequence(haystack: string[], sequence: string[]) {
  if (!sequence.length || sequence.length > haystack.length) return -1;
  for (let start = 0; start <= haystack.length - sequence.length; start += 1) {
    let matches = true;
    for (let offset = 0; offset < sequence.length; offset += 1) {
      if (haystack[start + offset] !== sequence[offset]) {
        matches = false;
        break;
      }
    }
    if (matches) return start;
  }
  return -1;
}

function containsTokenSequence(haystack: string[], sequence: string[]) {
  return indexOfTokenSequence(haystack, sequence) >= 0;
}

function shortModelSequenceCandidates(productName: string) {
  const tokens = modelSequenceTokens(productName);
  const candidates: string[][] = [];
  for (let start = 0; start < tokens.length; start += 1) {
    for (const size of [4, 3, 2]) {
      const sequence = tokens.slice(start, start + size);
      if (sequence.length !== size) continue;
      if (!tokenHasLetter(sequence[0])) continue;
      if (!sequence.some(tokenHasDigit) || !sequence.some(tokenHasLetter)) continue;
      candidates.push(sequence);
    }
  }
  return candidates;
}

function productShortModelSequenceMentionedInText(product: Product, text: string) {
  if (!productBrandMentionedInText(product, text)) return false;
  const answerTokens = modelSequenceTokens(text);
  return shortModelSequenceCandidates(product.name).some((sequence) =>
    containsTokenSequence(answerTokens, sequence)
  );
}

function productMentionIndexInText(product: Product, text: string) {
  const answerTokens = modelSequenceTokens(text);
  const sequenceIndexes = shortModelSequenceCandidates(product.name)
    .map((sequence) => indexOfTokenSequence(answerTokens, sequence))
    .filter((index) => index >= 0);
  if (sequenceIndexes.length) return Math.min(...sequenceIndexes);

  const modelTokenIndexes = extractModelTokens(product.name)
    .map((token) => compactModelText(token))
    .filter((token) => token.length >= 5)
    .map((token) => answerTokens.indexOf(token))
    .filter((index) => index >= 0);
  if (modelTokenIndexes.length) return Math.min(...modelTokenIndexes);

  const compactText = compactModelText(text);
  const brand = displayProductBrand(product) || product.brand;
  const compactBrand = compactModelText(brand ?? '');
  const brandIndex = compactBrand.length >= 3 ? compactText.indexOf(compactBrand) : -1;
  return brandIndex >= 0 ? brandIndex + answerTokens.length : Number.MAX_SAFE_INTEGER;
}

function sortByAnswerMentionOrder(products: Product[], answerText: string) {
  return products
    .map((product, index) => ({ product, index, mentionIndex: productMentionIndexInText(product, answerText) }))
    .sort((left, right) => left.mentionIndex - right.mentionIndex || left.index - right.index)
    .map((item) => item.product);
}

function answerMentionedProducts(products: Product[], answerText: string) {
  const exactModelMatches = products.filter((product) =>
    productModelMentionedInText(product, answerText) ||
    productShortModelSequenceMentionedInText(product, answerText)
  );
  const exactWithBrand = exactModelMatches.filter((product) => productBrandMentionedInText(product, answerText));
  if (exactWithBrand.length) return sortByAnswerMentionOrder(exactWithBrand, answerText);
  if (exactModelMatches.length) return sortByAnswerMentionOrder(exactModelMatches, answerText);
  return sortByAnswerMentionOrder(products.filter((product) => productMentionedInText(product, answerText)), answerText);
}

function parseKw(value: string) {
  const parsed = Number(value.replace(',', '.'));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function isWhitespaceChar(char: string | undefined) {
  return char !== undefined && char.trim() === '';
}

function skipWhitespace(value: string, index: number) {
  let cursor = index;
  while (cursor < value.length && isWhitespaceChar(value[cursor])) cursor += 1;
  return cursor;
}

function decimalNumberAt(value: string, index: number) {
  let cursor = index;
  let raw = '';
  let hasDigit = false;
  let hasDecimal = false;
  while (cursor < value.length) {
    const char = value[cursor];
    if (char >= '0' && char <= '9') {
      raw += char;
      hasDigit = true;
      cursor += 1;
      continue;
    }
    if ((char === '.' || char === ',') && !hasDecimal) {
      raw += '.';
      hasDecimal = true;
      cursor += 1;
      continue;
    }
    break;
  }
  if (!hasDigit) return null;
  const parsed = parseKw(raw);
  return parsed === undefined ? null : { value: parsed, end: cursor };
}

function rangeSeparatorEnd(value: string, index: number) {
  const char = value[index];
  if (char === '-' || char === '–' || char === '—') return index + 1;
  return value.slice(index, index + 2).toLocaleLowerCase('ru-RU') === 'до'
    ? index + 2
    : undefined;
}

function powerUnitAt(value: string, index: number) {
  const tail = value.slice(index).toLocaleLowerCase('ru-RU');
  const units = [
    { unit: 'kw' as const, scale: 1, terms: [fromEscaped('\\u043a\\u0432\\u0442'), 'kw', 'kva', fromEscaped('\\u043a\\u0432\\u0430')] },
    { unit: 'w' as const, scale: 0.001, terms: [fromEscaped('\\u0432\\u0430\\u0442\\u0442'), fromEscaped('\\u0432\\u0442'), 'w'] }
  ];
  for (const candidate of units) {
    const term = candidate.terms.find((item) => tail.startsWith(item));
    if (!term) continue;
    return { unit: candidate.unit, scale: candidate.scale, end: index + term.length };
  }
  return undefined;
}

function structuredRequirementNumber(intent: AgentIntentContract, kinds: string[]) {
  const accepted = new Set(kinds);
  for (const requirement of intent.selectionPolicy?.requirements ?? []) {
    if (
      !accepted.has(requirement.kind) ||
      requirement.role !== 'hard_constraint' ||
      requirement.strictness !== 'strict'
    ) continue;
    const value = typeof requirement.value === 'number'
      ? requirement.value
      : typeof requirement.value === 'string'
        ? Number(requirement.value)
        : Number.NaN;
    if (Number.isFinite(value) && value >= 0) return value;
  }
  return undefined;
}

const supportedStrictNumericRequirementKinds = new Set([
  'budget_max_rub',
  'price_max_rub',
  'weight_min_kg',
  'weight_max_kg',
  'nominal_power_min_kw',
  'nominal_power_max_kw',
  'power_min_kw',
  'power_max_kw'
]);

const supportedCeramicMaterialValues = new Set(['ceramic', 'porcelain_tile', 'ceramic_tile']);

export function strictSelectionRequirementBlockers(
  intent: AgentIntentContract,
  productClass: ProductSelectionClass
) {
  const policy = intent.selectionPolicy;
  if (!policy) return [] as Array<{ id: string; kind: string; reason: string }>;

  const blockers: Array<{ id: string; kind: string; reason: string }> = [];
  for (const requirement of policy.requirements) {
    if (requirement.role !== 'hard_constraint' || requirement.strictness !== 'strict') continue;

    if (supportedStrictNumericRequirementKinds.has(requirement.kind)) {
      const value = typeof requirement.value === 'number'
        ? requirement.value
        : typeof requirement.value === 'string'
          ? Number(requirement.value)
          : Number.NaN;
      if (!Number.isFinite(value) || value < 0) {
        blockers.push({ id: requirement.id, kind: requirement.kind, reason: 'invalid_numeric_value' });
      }
      continue;
    }

    if (requirement.kind === 'phase') {
      const value = String(requirement.value ?? '').trim().toLocaleLowerCase('en-US');
      const expected = value === 'single_phase' || value === 'single' || value === '220' || value === '220v'
        ? 'single_phase'
        : value === 'three_phase' || value === 'three' || value === '380' || value === '380v'
          ? 'three_phase'
          : undefined;
      if (!expected || policy.phase !== expected) {
        blockers.push({ id: requirement.id, kind: requirement.kind, reason: 'phase_not_bound_to_typed_policy' });
      }
      continue;
    }

    if (requirement.kind === 'quantity') {
      const value = typeof requirement.value === 'number'
        ? requirement.value
        : typeof requirement.value === 'string'
          ? Number(requirement.value)
          : Number.NaN;
      if (!Number.isSafeInteger(value) || value < 1) {
        blockers.push({ id: requirement.id, kind: requirement.kind, reason: 'invalid_quantity_value' });
      }
      continue;
    }

    if (requirement.kind === 'material') {
      const value = typeof requirement.value === 'string'
        ? requirement.value.trim().toLocaleLowerCase('en-US')
        : '';
      if (productClass !== 'diamondBlade' || !supportedCeramicMaterialValues.has(value)) {
        blockers.push({ id: requirement.id, kind: requirement.kind, reason: 'material_not_mechanically_verifiable' });
      }
      continue;
    }

    blockers.push({ id: requirement.id, kind: requirement.kind, reason: 'unsupported_strict_requirement_kind' });
  }
  return blockers;
}

function structuredBudgetMax(intent: AgentIntentContract) {
  return structuredRequirementNumber(intent, ['budget_max_rub', 'price_max_rub']);
}

function structuredGeneratorPowerRequirement(intent: AgentIntentContract): GeneratorPowerCardRequirement | undefined {
  const minKw = structuredRequirementNumber(intent, ['nominal_power_min_kw', 'power_min_kw']);
  const maxKw = structuredRequirementNumber(intent, ['nominal_power_max_kw', 'power_max_kw']);
  return minKw === undefined && maxKw === undefined ? undefined : { minKw, maxKw };
}

function structuredPlateWeightRange(intent: AgentIntentContract): PlateWeightRange | undefined {
  const min = structuredRequirementNumber(intent, ['weight_min_kg']);
  const max = structuredRequirementNumber(intent, ['weight_max_kg']);
  if (min === undefined && max === undefined) return undefined;
  return {
    min: min ?? 0,
    max: max ?? Number.MAX_SAFE_INTEGER,
    source: 'planner'
  };
}

function structuredMaterialRequirement(intent: AgentIntentContract) {
  const requirement = (intent.selectionPolicy?.requirements ?? []).find((item) =>
    item.kind === 'material' && item.role === 'hard_constraint' && item.strictness === 'strict'
  );
  return typeof requirement?.value === 'string'
    ? requirement.value.trim().toLocaleLowerCase('ru-RU')
    : undefined;
}

export function productMeetsSupportedStrictMaterialRequirement(
  product: Product,
  intent: AgentIntentContract,
  productClass: ProductSelectionClass
) {
  const material = structuredMaterialRequirement(intent);
  if (!material) return true;
  return productClass === 'diamondBlade' &&
    supportedCeramicMaterialValues.has(material) &&
    diamondBladeSupportsCeramic(product);
}

function productMeetsStructuredPowerSource(
  product: Product,
  powerSource: 'battery' | 'fuel' | 'mains' | 'any' | null | undefined
) {
  if (!powerSource || powerSource === 'any') return true;
  const actual = productPowerSource(product);
  if (powerSource === 'battery') return actual === 'battery';
  if (powerSource === 'fuel') return actual === 'gasoline' || actual === 'diesel';
  return false;
}

function requestedPowerRangeKw(text: string) {
  for (let index = 0; index < text.length; index += 1) {
    const left = decimalNumberAt(text, index);
    if (!left) continue;
    const leftUnit = powerUnitAt(text, skipWhitespace(text, left.end));
    const separatorEnd = rangeSeparatorEnd(text, skipWhitespace(text, left.end));
    if (separatorEnd === undefined) {
      index = left.end;
      continue;
    }
    const right = decimalNumberAt(text, skipWhitespace(text, separatorEnd));
    const rightUnit = right ? powerUnitAt(text, skipWhitespace(text, right.end)) : undefined;
    if (right && rightUnit) {
      const leftScale = leftUnit?.scale ?? rightUnit.scale;
      const rightScale = rightUnit.scale;
      const leftKw = left.value * leftScale;
      const rightKw = right.value * rightScale;
      return {
        min: Math.min(leftKw, rightKw),
        max: Math.max(leftKw, rightKw)
      };
    }
    index = left.end;
  }

  for (let index = 0; index < text.length; index += 1) {
    const exact = decimalNumberAt(text, index);
    if (!exact) continue;
    const unit = powerUnitAt(text, skipWhitespace(text, exact.end));
    if (unit) {
      const valueKw = exact.value * unit.scale;
      const tolerance = unit.unit === 'w' ? Math.max(0.03, valueKw * 0.1) : 0.75;
      return { min: Math.max(0.1, valueKw - tolerance), max: valueKw + tolerance };
    }
    index = exact.end;
  }
  return undefined;
}

const powerLowerBoundBeforeTerms = [
  '>=',
  'at least',
  'minimum',
  'min',
  'from',
  fromEscaped('\\u043e\\u0442'),
  fromEscaped('\\u043d\\u0435 \\u043c\\u0435\\u043d\\u0435\\u0435'),
  fromEscaped('\\u043d\\u0435 \\u043c\\u0435\\u043d\\u044c\\u0448\\u0435'),
  fromEscaped('\\u043c\\u0438\\u043d\\u0438\\u043c\\u0443\\u043c')
];

const powerLowerBoundAfterTerms = [
  '+',
  'or more',
  'or higher',
  'and above',
  'and up',
  fromEscaped('\\u0438\\u043b\\u0438 \\u0431\\u043e\\u043b\\u044c\\u0448\\u0435'),
  fromEscaped('\\u0438\\u043b\\u0438 \\u0432\\u044b\\u0448\\u0435'),
  fromEscaped('\\u0438\\u043b\\u0438 \\u0431\\u043e\\u043b\\u0435\\u0435'),
  fromEscaped('\\u0438 \\u0432\\u044b\\u0448\\u0435'),
  fromEscaped('\\u0438 \\u0431\\u043e\\u043b\\u0435\\u0435')
];

function windowContainsAny(text: string, terms: string[]) {
  return terms.some((term) => text.includes(term));
}

function requestedPowerLowerBoundKw(text: string) {
  const normalized = text.toLocaleLowerCase('ru-RU');
  for (let index = 0; index < normalized.length; index += 1) {
    const exact = decimalNumberAt(normalized, index);
    if (!exact) continue;
    const unit = powerUnitAt(normalized, skipWhitespace(normalized, exact.end));
    if (!unit) {
      index = exact.end;
      continue;
    }
    const before = normalized.slice(Math.max(0, index - 36), index);
    const after = normalized.slice(unit.end, Math.min(normalized.length, unit.end + 44));
    if (windowContainsAny(before, powerLowerBoundBeforeTerms) || windowContainsAny(after, powerLowerBoundAfterTerms)) {
      return exact.value * unit.scale;
    }
    index = exact.end;
  }
  return undefined;
}

type GeneratorPowerCardRequirement = {
  minKw?: number;
  maxKw?: number;
};

function generatorPowerRequirementForCardSelection(text: string): GeneratorPowerCardRequirement | undefined {
  const lowerBound = requestedPowerLowerBoundKw(text);
  if (lowerBound !== undefined) return { minKw: lowerBound };
  const range = requestedPowerRangeKw(text);
  return range ? { minKw: range.min, maxKw: range.max } : undefined;
}

function generatorPowerFitScore(product: Product, range: { min: number; max: number }) {
  const power = extractGeneratorPowerForHardSelection(product);
  const nominal = power.nominalKw ?? power.maxKw;
  if (nominal === undefined) return -10_000;

  const target = (range.min + range.max) / 2;
  const distance = nominal < range.min
    ? range.min - nominal
    : nominal > range.max
      ? nominal - range.max
      : 0;
  let score = 100 - Math.abs(nominal - target);
  if (nominal >= range.min && nominal <= range.max) score += 50;
  if (power.maxKw !== undefined && nominal < range.min && power.maxKw >= range.min) score += 25;
  score -= distance * 12;
  if (nominal > range.max * 3 && nominal > range.max + 20) score -= 10_000;
  return score;
}

function productMeetsGeneratorPowerCardRequirement(
  product: Product,
  requirement?: GeneratorPowerCardRequirement,
  failClosed = false
) {
  if (!requirement) return true;
  const power = extractGeneratorPowerForHardSelection(product);
  const nominal = power.nominalKw ?? power.maxKw;
  if (nominal === undefined) return !failClosed;
  if (requirement.minKw !== undefined && nominal < requirement.minKw - 0.05) return false;
  if (requirement.maxKw !== undefined) {
    const toleratedMax = Math.max(requirement.maxKw + 0.3, requirement.maxKw * 1.25);
    if (nominal > toleratedMax) return false;
  }
  return true;
}

type GeneratorPhaseRequirement = 'single_220' | 'three_380';

const generatorThreePhaseTerms = [
  'three phase',
  'three-phase',
  '3 phase',
  '3-phase',
  fromEscaped('\\u0442\\u0440\\u0435\\u0445 \\u0444\\u0430\\u0437'),
  fromEscaped('\\u0442\\u0440\\u0451\\u0445 \\u0444\\u0430\\u0437'),
  fromEscaped('\\u0442\\u0440\\u0435\\u0445\\u0444\\u0430\\u0437'),
  fromEscaped('\\u0442\\u0440\\u0451\\u0445\\u0444\\u0430\\u0437'),
  fromEscaped('3 \\u0444\\u0430\\u0437'),
  fromEscaped('3-\\u0444\\u0430\\u0437')
];

const generatorSinglePhaseTerms = [
  'single phase',
  'single-phase',
  fromEscaped('\\u043e\\u0434\\u043d\\u043e \\u0444\\u0430\\u0437'),
  fromEscaped('\\u043e\\u0434\\u043d\\u043e\\u0444\\u0430\\u0437')
];

function isAsciiDigit(char: string | undefined) {
  return Boolean(char && char >= '0' && char <= '9');
}

function containsStandaloneNumberToken(text: string, values: string[]) {
  for (const value of values) {
    let index = text.indexOf(value);
    while (index >= 0) {
      const before = text[index - 1];
      const after = text[index + value.length];
      if (!isAsciiDigit(before) && !isAsciiDigit(after)) return true;
      index = text.indexOf(value, index + 1);
    }
  }
  return false;
}

function requestedGeneratorPhaseRequirement(text: string): GeneratorPhaseRequirement | undefined {
  const normalized = text.toLocaleLowerCase('ru-RU');
  const has380 = containsStandaloneNumberToken(normalized, ['380', '400']) ||
    windowContainsAny(normalized, generatorThreePhaseTerms);
  if (has380) return 'three_380';
  const has220 = containsStandaloneNumberToken(normalized, ['220', '230']) ||
    windowContainsAny(normalized, generatorSinglePhaseTerms);
  return has220 ? 'single_220' : undefined;
}

function productMeetsGeneratorPhaseRequirement(
  product: Product,
  requirement?: GeneratorPhaseRequirement,
  failClosed = false
) {
  if (!requirement) return true;
  const profile = generatorPhaseProfile(product);
  if (profile === 'unknown') return !failClosed;
  if (requirement === 'three_380') return profile === 'three_phase_380' || profile === 'mixed_220_380';
  return profile === 'single_220';
}

const ceramicBladeMaterialTerms = [
  'porcelain',
  'porcelain tile',
  'ceramic',
  'ceramic tile',
  fromEscaped('\\u043a\\u0435\\u0440\\u0430\\u043c\\u043e\\u0433\\u0440\\u0430\\u043d\\u0438\\u0442'),
  fromEscaped('\\u043a\\u0435\\u0440\\u0430\\u043c\\u0438\\u043a'),
  fromEscaped('\\u043f\\u043b\\u0438\\u0442\\u043a')
];

function productTextForMaterial(product: Product) {
  return [
    product.name,
    product.brand,
    product.category,
    product.description,
    JSON.stringify(product.specs ?? {})
  ].filter(Boolean).join(' ').toLocaleLowerCase('ru-RU');
}

function requiresCeramicDiamondBlade(text: string) {
  return windowContainsAny(text.toLocaleLowerCase('ru-RU'), ceramicBladeMaterialTerms);
}

function diamondBladeSupportsCeramic(product: Product) {
  return windowContainsAny(productTextForMaterial(product), ceramicBladeMaterialTerms);
}

export function generatorMeetsRequiredLoad(product: Product, requiredNominalKw: number) {
  if (!Number.isFinite(requiredNominalKw) || requiredNominalKw <= 0) return true;
  const power = extractGeneratorPowerForHardSelection(product);
  if (power.nominalKw === undefined && power.maxKw === undefined) return false;
  if (power.nominalKw !== undefined && power.nominalKw >= requiredNominalKw - 0.2) return true;
  return Boolean(
    power.nominalKw !== undefined &&
    power.maxKw !== undefined &&
    power.nominalKw >= requiredNominalKw - 0.7 &&
    power.maxKw >= requiredNominalKw + 0.5
  );
}

export function filterGeneratorProductsByLoadProfile(products: Product[], requiredNominalKw?: number) {
  if (requiredNominalKw === undefined || !Number.isFinite(requiredNominalKw) || requiredNominalKw <= 0) {
    return {
      products,
      droppedProductIds: [],
      warnings: [] as string[]
    };
  }
  const kept: Product[] = [];
  const droppedProductIds: string[] = [];
  for (const product of products) {
    if (generatorMeetsRequiredLoad(product, requiredNominalKw)) {
      kept.push(product);
    } else {
      droppedProductIds.push(product.id);
    }
  }
  const warnings = droppedProductIds.length
    ? [`catalog_products_filtered_by_generator_load:${droppedProductIds.length}`]
    : [];
  if (!kept.length && droppedProductIds.length) {
    warnings.push('catalog_search_no_generator_load_fit');
  }
  return {
    products: kept,
    droppedProductIds,
    warnings
  };
}

const selfLoadingPlateFragments = [
  'self-loading',
  'self loading',
  'selfloading',
  'load it myself',
  'loading it myself',
  'load myself',
  'loading myself',
  'one-person',
  'one person',
  'oneperson',
  'в одного',
  'одному'
];

const smallPlateSiteFragments = [
  'small site',
  'small area',
  'small driveway',
  'driveway',
  'paving',
  'slab',
  'sand',
  'crushed stone',
  'garden',
  'yard',
  'въезд',
  'плитк',
  'песок',
  'щеб',
  'двор',
  'дорож'
];

const heavyPlateSiteFragments = [
  'reversible',
  'heavy-duty',
  'heavy duty',
  'industrial',
  'road base',
  'parking',
  'crew',
  'реверсив',
  'тяж',
  'дорог',
  'парков',
  'каток',
  'бригад',
  'объект'
];

function isHintWhitespace(char: string) {
  return char === ' ' || char === '\t' || char === '\r' || char === '\n' || char === '\f' || char === '\v' || char === '\u00a0';
}

function normalizedHintText(text: string) {
  const source = text.toLocaleLowerCase('ru-RU').split('ё').join('е');
  let normalized = '';
  let previousWasSpace = false;
  for (const char of source) {
    if (isHintWhitespace(char)) {
      if (!previousWasSpace) normalized += ' ';
      previousWasSpace = true;
      continue;
    }
    normalized += char;
    previousWasSpace = false;
  }
  return normalized.trim();
}

function hintTextContainsAny(normalizedText: string, fragments: string[]) {
  return fragments.some((fragment) => normalizedText.includes(normalizedHintText(fragment)));
}

function hintTextContainsAll(normalizedText: string, fragments: string[]) {
  return fragments.every((fragment) => normalizedText.includes(normalizedHintText(fragment)));
}

function isSelfLoadingPlateText(text: string) {
  const normalized = normalizedHintText(text);
  return hintTextContainsAny(normalized, selfLoadingPlateFragments) ||
    hintTextContainsAll(normalized, ['груз', 'сам']);
}

function isSmallPlateSiteText(text: string) {
  const normalized = normalizedHintText(text);
  return hintTextContainsAny(normalized, smallPlateSiteFragments) ||
    hintTextContainsAll(normalized, ['небольш', 'площад']);
}

function isHeavyPlateSiteText(text: string) {
  return hintTextContainsAny(normalizedHintText(text), heavyPlateSiteFragments);
}

type PlateTaskWeightPolicy = {
  min: number;
  max: number;
  source: 'self_loading' | 'small_site';
  maxPracticalWeightKg: number;
  reason: string;
};

type PlateWeightRange = {
  min: number;
  max: number;
  source: 'explicit_user' | 'planner' | PlateTaskWeightPolicy['source'];
};

export type PlateTaskProductFilter = {
  products: Product[];
  droppedProductIds: string[];
  warnings: string[];
  policy?: PlateTaskWeightPolicy;
};

function plateTaskWeightPolicy(input: {
  userMessage: string;
  query: string;
  semanticContext: string;
}): PlateTaskWeightPolicy | undefined {
  const joined = [input.userMessage, input.query, input.semanticContext].join('\n');
  if (isSelfLoadingPlateText(joined)) {
    return {
      min: 40,
      max: 75,
      source: 'self_loading',
      maxPracticalWeightKg: 90,
      reason: 'one-person loading or transport requires a light plate class'
    };
  }
  if (isSmallPlateSiteText(joined) && !isHeavyPlateSiteText(joined)) {
    return {
      min: 45,
      max: 95,
      source: 'small_site',
      maxPracticalWeightKg: 120,
      reason: 'home paving, yard, paths, or paving tile require a small/light plate class'
    };
  }
  return undefined;
}

function requestedPlateWeightRangeKg(input: {
  userMessage: string;
  query: string;
  semanticContext: string;
}): PlateWeightRange | undefined {
  const taskPolicy = plateTaskWeightPolicy(input);
  const userExplicit = parseWeightNeedRangeKg(input.userMessage);
  if (taskPolicy && userExplicit && userExplicit.min > taskPolicy.maxPracticalWeightKg) {
    return { min: taskPolicy.min, max: taskPolicy.max, source: taskPolicy.source };
  }
  if (userExplicit) return { ...userExplicit, source: 'explicit_user' as const };
  const plannerExplicit = parseWeightNeedRangeKg(input.query) ?? parseWeightNeedRangeKg(input.semanticContext);
  if (taskPolicy && plannerExplicit && plannerExplicit.min > taskPolicy.maxPracticalWeightKg) {
    return { min: taskPolicy.min, max: taskPolicy.max, source: taskPolicy.source };
  }
  if (plannerExplicit) return { ...plannerExplicit, source: 'planner' as const };
  if (taskPolicy) return { min: taskPolicy.min, max: taskPolicy.max, source: taskPolicy.source };
  return undefined;
}

export function filterPlateProductsByCurrentTask(input: {
  products: Product[];
  userMessage: string;
  query: string;
  semanticContext: string;
}): PlateTaskProductFilter {
  const policy = plateTaskWeightPolicy(input);
  if (!policy || !input.products.length) {
    return {
      products: input.products,
      droppedProductIds: [],
      warnings: []
    };
  }
  const filtered = input.products.filter((product) => {
    const weight = extractWeightKg(product);
    return weight === undefined || weight <= policy.maxPracticalWeightKg;
  });
  const keptIds = new Set(filtered.map((product) => product.id));
  const droppedProductIds = input.products
    .filter((product) => !keptIds.has(product.id))
    .map((product) => product.id);
  return {
    products: filtered,
    droppedProductIds,
    warnings: droppedProductIds.length ? [`product_cards_suppressed:plate_task_weight_mismatch:${droppedProductIds.length}`] : [],
    policy
  };
}

function productAllowedByPlateTaskPolicy(product: Product, policy?: { maxPracticalWeightKg: number }) {
  if (!policy) return true;
  const weight = extractWeightKg(product);
  return weight === undefined || weight <= policy.maxPracticalWeightKg;
}

function plateWeightFitScore(product: Product, range: { min: number; max: number; source: string }) {
  const weight = extractWeightKg(product);
  if (weight === undefined) return range.source === 'self_loading' ? -25 : 0;

  const target = range.source === 'self_loading'
    ? Math.min(62, Math.max(range.min, (range.min + range.max) / 2))
    : (range.min + range.max) / 2;
  let score = 120 - Math.abs(weight - target);
  if (weight >= range.min && weight <= range.max) score += 80;
  if (weight < range.min) score -= (range.min - weight) * 2;
  if (weight > range.max) score -= (weight - range.max) * (range.source === 'self_loading' ? 10 : 5);
  if (range.source === 'self_loading' && weight > 90) score -= 300;
  if (range.source === 'self_loading' && weight > 120) score -= 1_000;
  return score;
}

function productsWithinPlateWeightRange(products: Product[], range: { min: number; max: number }) {
  return products.filter((product) => {
    const weight = extractWeightKg(product);
    return weight !== undefined && weight >= range.min && weight <= range.max;
  });
}

function requestedVisibleCardLimit(input: { userMessage: string; semanticContext: string }) {
  const normalized = normalizedHintText([input.userMessage, input.semanticContext].join(' '));
  if (hintTextContainsAny(normalized, ['две самые', 'два самых', '2 самые', '2 самых', 'только две', 'только два', 'оставьте две', 'оставьте два', 'сведите к двум', 'свести к двум', 'до двух'])) {
    return 2;
  }
  if (hintTextContainsAny(normalized, ['три самые', 'три самых', '3 самые', '3 самых', 'только три', 'оставьте три'])) {
    return 3;
  }
  return undefined;
}

function allowsHeavierPlateTradeoff(input: { userMessage: string; semanticContext: string }) {
  const normalized = normalizedHintText([input.userMessage, input.semanticContext].join(' '));
  const asksForLightOption = hintTextContainsAny(normalized, ['легк', 'перенос', 'перекат', 'грузить', 'одному']);
  const asksForStrongerOption = hintTextContainsAny(normalized, ['уверенн', 'сильн', 'мощн', 'запас', 'щеб', 'песок']);
  const asksForSplitChoice = hintTextContainsAny(normalized, ['две позиции', 'два варианта', 'одну', 'вторую', 'один', 'второй']);
  const explicitlyRemovesHeavy = hintTextContainsAny(normalized, ['уберите 72', 'без 72', '72 кг пока уберите', 'только 54', 'только 60']);
  return asksForLightOption && asksForStrongerOption && asksForSplitChoice && !explicitlyRemovesHeavy;
}

export function rankCatalogProductsByNumericFit(input: {
  products: Product[];
  intent: ProductSelectionClass;
  query: string;
  semanticContext: string;
  userMessage: string;
}) {
  if (input.intent === 'plate') {
    const range = requestedPlateWeightRangeKg(input);
    if (!range) return input.products;
    const taskPolicy = plateTaskWeightPolicy(input);
    const scoringRange = taskPolicy?.source === 'self_loading'
      ? { min: taskPolicy.min, max: taskPolicy.max, source: taskPolicy.source }
      : range;
    return input.products
      .map((product, index) => ({
        product,
        index,
        score: plateWeightFitScore(product, scoringRange)
      }))
      .sort((left, right) => right.score - left.score || left.index - right.index)
      .map((item) => item.product);
  }
  if (input.intent !== 'generator' && input.intent !== 'weldingGenerator') return input.products;
  const range = requestedPowerRangeKw(input.query) ?? requestedPowerRangeKw(input.semanticContext);
  if (!range) return input.products;
  return input.products
    .map((product, index) => ({
      product,
      index,
      score: generatorPowerFitScore(product, range)
    }))
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map((item) => item.product);
}

function sameIntentProducts(products: Product[], cardIntent: ProductSelectionClass) {
  if (cardIntent === 'unknown') return products.filter((product) => isCoreEquipment(product));
  return products.filter((product) => productMatchesIntent(product, cardIntent));
}

function plateRequirementsForCardSelection(input: {
  needState: CustomerNeedState;
  intent: AgentIntentContract;
  userMessage: string;
  plateWeightRange?: { min?: number; max?: number };
}): BuyerRequirementContract {
  const maxRub = input.intent.selectionPolicy
    ? structuredBudgetMax(input.intent)
    : budgetMaxFromNeedState(input.needState);
  const hasLightConstraint = Boolean(input.plateWeightRange);
  return {
    buyerGoal: [input.intent.userMessageSummary, input.intent.dialogueUnderstanding, input.userMessage].filter(Boolean).join(' / '),
    targetProductClass: 'plate',
    hardRequirements: maxRub ? [{ kind: 'budgetMaxRub', value: maxRub, evidence: 'structured budget', strictness: 'strict' }] : [],
    softRequirements: hasLightConstraint ? [{ kind: 'notTooHeavy', value: true, evidence: 'structured light/weight preference', strictness: 'soft' }] : [],
    allowedCompromises: hasLightConstraint ? [{ kind: 'slightlyHeavierForBetterCompaction', value: true, evidence: 'plate compaction tradeoff' }] : [],
    forbiddenRecommendations: [],
    criticalAttributes: ['weightKg'],
    budgetPolicy: maxRub ? { maxRub, strictness: 'strict', allowSlightlyAboveWhenFewMatches: true } : undefined,
    topicAction: 'continue_current_need',
    rationale: 'visible card selection safety gate'
  };
}

function honestPlateExpansionProducts(input: {
  products: Product[];
  needState: CustomerNeedState;
  intent: AgentIntentContract;
  userMessage: string;
  plateWeightRange?: { min?: number; max?: number };
}) {
  const requirements = plateRequirementsForCardSelection(input);
  const maxRub = input.intent.selectionPolicy
    ? structuredBudgetMax(input.intent)
    : budgetMaxFromNeedState(input.needState);
  const inBudgetMatchCount = maxRub === undefined
    ? input.products.length
    : input.products.filter((product) => typeof product.price === 'number' && Number.isFinite(product.price) && product.price <= maxRub).length;
  const decisions = input.products.map((product) => classifyProductSuitability({
    product,
    requirements,
    matchContext: { inBudgetMatchCount }
  }));
  return selectProductsBySuitability({ decisions, uiSafeCap: 8, minimumGoodMatchesBeforeCompromises: 3 })
    .map((decision) => decision.product);
}

function buyerRequirementTextForCardSelection(input: {
  userMessage: string;
  intent: AgentIntentContract;
  needState: CustomerNeedState;
}) {
  return [
    input.userMessage,
    input.intent.userMessageSummary,
    input.intent.dialogueUnderstanding,
    input.intent.nextStepRationale,
    toolRequestSemanticText(input.intent),
    input.needState.lastSummary,
    ...(input.needState.activeNeeds ?? []).flatMap((need) => [
      need.summary,
      ...(need.constraints ?? []),
      ...(need.openQuestions ?? [])
    ]),
    ...(input.needState.confirmedFacts ?? []).map((fact) => fact.value),
    ...(input.needState.constraints ?? []).map((constraint) => constraint.value),
    ...(input.needState.selectionState?.hardConstraints.mustHaveTraits ?? []),
    ...(input.needState.selectionState?.softPreferences.mustHaveTraits ?? [])
  ].filter(Boolean).join('\n');
}

export function selectProductsForVisibleCards(input: {
  products: Product[];
  userMessage: string;
  history: Message[];
  intent: AgentIntentContract;
  answerText: string;
  selectedProductIds?: string[];
  needState: CustomerNeedState;
  allowHistoricalProducts?: boolean;
}) {
  const unique = uniqueProducts(input.products);
  const hasExplicitCardTool = input.intent.toolRequests.some((request) =>
    request.tool === 'catalog.search' || request.tool === 'catalog.getProductDetails'
  ) || input.allowHistoricalProducts === true;
  const cardIntent = inferVisibleCardIntent(input);
  const structuredSelection = Boolean(
    input.intent.selectionPolicy && input.selectedProductIds !== undefined
  );
  if (!hasExplicitCardTool) {
    return {
      semanticAuthority: structuredSelection ? 'llm_contract' as const : 'legacy_fallback' as const,
      intent: cardIntent,
      products: [],
      selectedProductIds: [],
      answerMentionedProductIds: [],
      droppedProductIds: unique.map((product) => product.id),
      warnings: unique.length ? ['product_cards_suppressed:no_explicit_catalog_card_tool'] : []
    };
  }
  const mentioned = answerMentionedProducts(unique, input.answerText);
  const mentionedMatchingIntent = cardIntent === 'unknown'
    ? mentioned
    : mentioned.filter((product) => productMatchesIntent(product, cardIntent));
  const sameIntentPool = sameIntentProducts(unique, cardIntent);
  const strictRequirementBlockers = strictSelectionRequirementBlockers(input.intent, cardIntent);
  if (strictRequirementBlockers.length) {
    return {
      semanticAuthority: structuredSelection ? 'llm_contract' as const : 'legacy_fallback' as const,
      intent: cardIntent,
      products: [],
      selectedProductIds: [],
      answerMentionedProductIds: mentioned.map((product) => product.id),
      droppedProductIds: unique.map((product) => product.id),
      warnings: [`product_cards_suppressed:unsupported_or_unverifiable_strict_hard_constraint:${strictRequirementBlockers.length}`]
    };
  }

  let selected: Product[];
  if (structuredSelection) {
    const requestedIds = new Set(input.selectedProductIds ?? []);
    selected = unique.filter((product) => requestedIds.has(product.id));
    const strictProductClass = input.intent.selectionPolicy?.alternativePolicy === 'exact_only' ||
      input.intent.selectionPolicy?.alternativePolicy === 'same_class_only';
    if (strictProductClass && cardIntent !== 'unknown') {
      selected = selected.filter((product) => productMatchesIntent(product, cardIntent));
    }
    const mentionedIds = new Set(mentioned.map((product) => product.id));
    selected = selected.filter((product) => mentionedIds.has(product.id));
  } else if (mentionedMatchingIntent.length) {
    const shouldExpandCatalogSearch = cardIntent === 'plate' &&
      mentionedMatchingIntent.length === 1 &&
      input.intent.toolRequests.some((request) => request.tool === 'catalog.search') &&
      sameIntentPool.length > mentionedMatchingIntent.length;
    if (shouldExpandCatalogSearch) {
      const honestExpandedIds = new Set(honestPlateExpansionProducts({
        products: sameIntentPool,
        needState: input.needState,
        intent: input.intent,
        userMessage: input.userMessage,
        plateWeightRange: requestedPlateWeightRangeKg({
          userMessage: input.userMessage,
          query: toolRequestSemanticText(input.intent),
          semanticContext: [
            input.intent.userMessageSummary,
            input.intent.dialogueUnderstanding,
            input.intent.nextStepRationale
          ].filter(Boolean).join('\n')
        })
      }).map((product) => product.id));
      selected = uniqueProducts([
        ...mentionedMatchingIntent,
        ...sameIntentPool.filter((product) => honestExpandedIds.has(product.id))
      ]);
    } else {
      selected = mentionedMatchingIntent;
    }
  } else if (mentioned.length && cardIntent === 'unknown') {
    selected = mentioned;
  } else if (cardIntent !== 'unknown') {
    selected = unique.filter((product) => productMatchesIntent(product, cardIntent));
  } else {
    selected = unique.filter((product) => isCoreEquipment(product));
  }

  if (cardIntent === 'unknown' && !mentioned.length) {
    selected = [];
  }

  let powerSourceFilteredCount = 0;
  let powerSourceNoFit = false;
  const buyerRequirementText = buyerRequirementTextForCardSelection(input);
  const structuredPowerSource = structuredSelection
    ? input.intent.selectionPolicy?.powerSource
    : undefined;
  const batteryPowerSourceRequired = structuredSelection
    ? structuredPowerSource === 'battery'
    : requiresBatteryPowerStationFromText(buyerRequirementText);
  const sourceConstrainedGeneratorPool = isGeneratorProductClass(cardIntent)
    ? structuredSelection && structuredPowerSource && structuredPowerSource !== 'any'
      ? sameIntentPool.filter((product) => productMeetsStructuredPowerSource(product, structuredPowerSource))
      : batteryPowerSourceRequired
        ? sameIntentPool.filter(isBatteryPowerStation)
        : sameIntentPool
    : sameIntentPool;
  const hasStructuredPowerSource = Boolean(
    structuredSelection && structuredPowerSource && structuredPowerSource !== 'any'
  );
  if (
    isGeneratorProductClass(cardIntent) &&
    selected.length &&
    (batteryPowerSourceRequired || hasStructuredPowerSource)
  ) {
    const sourceMatchingSelected = structuredSelection
      ? selected.filter((product) => productMeetsStructuredPowerSource(product, structuredPowerSource))
      : selected.filter(isBatteryPowerStation);
    if (sourceMatchingSelected.length) {
      powerSourceFilteredCount = selected.length - sourceMatchingSelected.length;
      selected = sourceMatchingSelected;
    } else {
      powerSourceFilteredCount = selected.length;
      if (structuredSelection) {
        selected = [];
        powerSourceNoFit = true;
      } else {
        const fallbackBatteryProducts = sameIntentPool.filter(isBatteryPowerStation);
        selected = fallbackBatteryProducts;
        powerSourceNoFit = fallbackBatteryProducts.length === 0;
      }
    }
  }

  let generatorPowerFilteredCount = 0;
  let generatorPowerNoFit = false;
  const generatorPowerRequirement = isGeneratorProductClass(cardIntent)
    ? structuredSelection
      ? structuredGeneratorPowerRequirement(input.intent)
      : generatorPowerRequirementForCardSelection(buyerRequirementText)
    : undefined;
  if (isGeneratorProductClass(cardIntent) && selected.length && generatorPowerRequirement) {
    const powerMatchingSelected = selected.filter((product) =>
      productMeetsGeneratorPowerCardRequirement(product, generatorPowerRequirement, structuredSelection)
    );
    if (powerMatchingSelected.length) {
      generatorPowerFilteredCount = selected.length - powerMatchingSelected.length;
      selected = powerMatchingSelected;
    } else {
      generatorPowerFilteredCount = selected.length;
      if (structuredSelection) {
        selected = [];
        generatorPowerNoFit = true;
      } else {
        const fallbackPowerMatches = sourceConstrainedGeneratorPool.filter((product) =>
          productMeetsGeneratorPowerCardRequirement(product, generatorPowerRequirement)
        );
        selected = fallbackPowerMatches;
        generatorPowerNoFit = fallbackPowerMatches.length === 0;
      }
    }
  }

  let generatorPhaseFilteredCount = 0;
  let generatorPhaseNoFit = false;
  const generatorPhaseRequirement = isGeneratorProductClass(cardIntent)
    ? structuredSelection
      ? input.intent.selectionPolicy?.phase === 'single_phase'
        ? 'single_220'
        : input.intent.selectionPolicy?.phase === 'three_phase'
          ? 'three_380'
          : undefined
      : requestedGeneratorPhaseRequirement(buyerRequirementText)
    : undefined;
  if (isGeneratorProductClass(cardIntent) && selected.length && generatorPhaseRequirement) {
    const phaseMatchingSelected = selected.filter((product) =>
      productMeetsGeneratorPhaseRequirement(product, generatorPhaseRequirement, structuredSelection)
    );
    if (phaseMatchingSelected.length) {
      generatorPhaseFilteredCount = selected.length - phaseMatchingSelected.length;
      selected = phaseMatchingSelected;
    } else {
      generatorPhaseFilteredCount = selected.length;
      if (structuredSelection) {
        selected = [];
        generatorPhaseNoFit = true;
      } else {
        const fallbackPhaseMatches = sourceConstrainedGeneratorPool
          .filter((product) => productMeetsGeneratorPowerCardRequirement(product, generatorPowerRequirement))
          .filter((product) => productMeetsGeneratorPhaseRequirement(product, generatorPhaseRequirement));
        selected = fallbackPhaseMatches;
        generatorPhaseNoFit = fallbackPhaseMatches.length === 0;
      }
    }
  }

  const budgetMax = structuredSelection
    ? structuredBudgetMax(input.intent)
    : effectiveVisibleCardBudgetMax({ needState: input.needState, userMessage: input.userMessage });
  let budgetFilteredCount = 0;
  let budgetNoFit = false;
  if (budgetMax !== undefined && selected.length) {
    const withinBudget = selected.filter((product) =>
      typeof product.price === 'number' &&
      Number.isFinite(product.price) &&
      product.price <= budgetMax
    );
    if (withinBudget.length) {
      budgetFilteredCount = selected.length - withinBudget.length;
      selected = withinBudget;
    } else {
      if (structuredSelection) {
        budgetFilteredCount = selected.length;
        budgetNoFit = true;
        selected = [];
      } else {
      const fallbackWithinBudget = sameIntentPool.filter((product) =>
        typeof product.price === 'number' &&
        Number.isFinite(product.price) &&
        product.price <= budgetMax
      );
      if (fallbackWithinBudget.length) {
        budgetFilteredCount = selected.length;
        selected = fallbackWithinBudget;
      } else if (isGeneratorProductClass(cardIntent)) {
        budgetFilteredCount = selected.length;
        budgetNoFit = true;
        selected = [];
      }
      }
    }
  }

  let numericFitFilteredCount = 0;
  let plateTaskFilteredCount = 0;
  let plateTaskWarnings: string[] = [];
  const plateWeightRange = cardIntent === 'plate'
    ? structuredSelection
      ? structuredPlateWeightRange(input.intent)
      : requestedPlateWeightRangeKg({
        userMessage: input.userMessage,
        query: toolRequestSemanticText(input.intent),
        semanticContext: [
          input.intent.userMessageSummary,
          input.intent.dialogueUnderstanding,
          input.intent.nextStepRationale
        ].filter(Boolean).join('\n')
        })
    : undefined;
  const plateTaskPolicyForSelection = cardIntent === 'plate'
    ? structuredSelection
      ? undefined
      : plateTaskWeightPolicy({
        userMessage: input.userMessage,
        query: toolRequestSemanticText(input.intent),
        semanticContext: [
          input.intent.userMessageSummary,
          input.intent.dialogueUnderstanding,
          input.intent.nextStepRationale,
          input.answerText
        ].filter(Boolean).join('\n')
        })
    : undefined;
  if (plateWeightRange && selected.length) {
    const selectedWithinRange = productsWithinPlateWeightRange(selected, plateWeightRange)
      .filter((product) => productAllowedByPlateTaskPolicy(product, plateTaskPolicyForSelection));
    const heavierTradeoffAllowed = structuredSelection
      ? input.intent.selectionPolicy?.alternativePolicy === 'allow_adjacent_with_explanation' ||
        input.intent.selectionPolicy?.alternativePolicy === 'open_to_alternatives'
      : allowsHeavierPlateTradeoff({
          userMessage: input.userMessage,
          semanticContext: [
            input.intent.userMessageSummary,
            input.intent.dialogueUnderstanding,
            input.intent.nextStepRationale,
            input.answerText
          ].filter(Boolean).join('\n')
        });
    if (selectedWithinRange.length) {
      const inRangeIds = new Set(selectedWithinRange.map((product) => product.id));
      const mentionedIds = new Set(mentionedMatchingIntent.map((product) => product.id));
      const selectedAfterNumericFit = heavierTradeoffAllowed
        ? selected.filter((product) => inRangeIds.has(product.id) || mentionedIds.has(product.id))
        : selectedWithinRange;
      numericFitFilteredCount = selected.length - selectedAfterNumericFit.length;
      selected = selectedAfterNumericFit;
    } else {
      if (structuredSelection) {
        numericFitFilteredCount = selected.length;
        plateTaskWarnings = ['product_cards_suppressed:structured_weight_no_fit'];
        selected = [];
      } else {
      const fallbackWithinRange = productsWithinPlateWeightRange(sameIntentPool, plateWeightRange)
        .filter((product) => productAllowedByPlateTaskPolicy(product, plateTaskPolicyForSelection));
      if (fallbackWithinRange.length) {
        numericFitFilteredCount = selected.length;
        selected = fallbackWithinRange;
      } else if (plateWeightRange.source === 'self_loading' || plateWeightRange.source === 'small_site') {
        numericFitFilteredCount = selected.length;
        plateTaskWarnings = ['product_cards_suppressed:plate_task_weight_mismatch:selected_outside_task_range'];
        selected = [];
      }
      }
    }
  }
  if (!structuredSelection && cardIntent === 'plate' && selected.length) {
    const plateTaskFilter = filterPlateProductsByCurrentTask({
      products: selected,
      userMessage: input.userMessage,
      query: toolRequestSemanticText(input.intent),
      semanticContext: [
        input.intent.userMessageSummary,
        input.intent.dialogueUnderstanding,
        input.intent.nextStepRationale,
        input.answerText
      ].filter(Boolean).join('\n')
    });
    if (plateTaskFilter.droppedProductIds.length) {
      plateTaskFilteredCount = plateTaskFilter.droppedProductIds.length;
      plateTaskWarnings = plateTaskFilter.warnings;
      selected = plateTaskFilter.products;
    }
  }

  let diamondMaterialFilteredCount = 0;
  let diamondMaterialNoFit = false;
  const structuredMaterial = structuredSelection ? structuredMaterialRequirement(input.intent) : undefined;
  const requiresCeramic = structuredSelection
    ? structuredMaterial === 'ceramic' || structuredMaterial === 'porcelain_tile' || structuredMaterial === 'ceramic_tile'
    : requiresCeramicDiamondBlade(buyerRequirementText);
  if (cardIntent === 'diamondBlade' && selected.length && requiresCeramic) {
    const ceramicSelected = selected.filter(diamondBladeSupportsCeramic);
    if (ceramicSelected.length) {
      diamondMaterialFilteredCount = selected.length - ceramicSelected.length;
      selected = ceramicSelected;
    } else {
      diamondMaterialFilteredCount = selected.length;
      if (structuredSelection) {
        selected = [];
        diamondMaterialNoFit = true;
      } else {
        const fallbackCeramic = sameIntentPool.filter(diamondBladeSupportsCeramic);
        selected = fallbackCeramic;
        diamondMaterialNoFit = fallbackCeramic.length === 0;
      }
    }
  }

  const visibleCardLimit = structuredSelection
    ? input.intent.selectionPolicy?.maxCards ?? undefined
    : requestedVisibleCardLimit({
        userMessage: input.userMessage,
        semanticContext: [
          input.intent.userMessageSummary,
          input.intent.dialogueUnderstanding,
          input.intent.nextStepRationale,
          input.answerText
        ].filter(Boolean).join('\n')
      });
  const selectedProducts = uniqueProducts(selected).slice(0, visibleCardLimit ?? 8);
  const selectedIds = new Set(selectedProducts.map((product) => product.id));
  const structuredRequestedIds = new Set(input.selectedProductIds ?? []);
  const structuredSuppressedCount = structuredSelection
    ? [...structuredRequestedIds].filter((id) => !selectedIds.has(id)).length
    : 0;
  const droppedProductIds = unique
    .filter((product) => !selectedIds.has(product.id))
    .map((product) => product.id);
  const warnings = [
    ...(droppedProductIds.length ? [`product_cards_filtered:${droppedProductIds.length}`] : []),
    ...(structuredSuppressedCount > 0
      ? [`product_cards_suppressed:selected_id_not_grounded_mentioned_or_fit:${structuredSuppressedCount}`]
      : []),
    ...(budgetFilteredCount > 0 ? [`product_cards_filtered_by_budget:${budgetFilteredCount}`] : []),
    ...(budgetNoFit ? ['product_cards_suppressed:budget_no_fit'] : []),
    ...(powerSourceFilteredCount > 0
      ? [`product_cards_filtered_by_power_source:${structuredPowerSource ?? 'battery'}:${powerSourceFilteredCount}`]
      : []),
    ...(powerSourceNoFit
      ? [`product_cards_suppressed:power_source_no_fit:${structuredPowerSource ?? 'battery'}`]
      : []),
    ...(generatorPowerFilteredCount > 0 ? [`product_cards_filtered_by_generator_power:${generatorPowerFilteredCount}`] : []),
    ...(generatorPowerNoFit ? ['product_cards_suppressed:generator_power_no_fit'] : []),
    ...(generatorPhaseFilteredCount > 0 ? [`product_cards_filtered_by_generator_phase:${generatorPhaseFilteredCount}`] : []),
    ...(generatorPhaseNoFit ? ['product_cards_suppressed:generator_phase_no_fit'] : []),
    ...(numericFitFilteredCount > 0 ? [`product_cards_filtered_by_numeric_fit:${numericFitFilteredCount}`] : []),
    ...(plateTaskFilteredCount > 0 ? [`product_cards_filtered_by_plate_task:${plateTaskFilteredCount}`] : []),
    ...(diamondMaterialFilteredCount > 0 ? [`product_cards_filtered_by_diamond_material:${diamondMaterialFilteredCount}`] : []),
    ...(diamondMaterialNoFit ? ['product_cards_suppressed:diamond_material_no_fit'] : []),
    ...plateTaskWarnings
  ];

  return {
    semanticAuthority: structuredSelection ? 'llm_contract' as const : 'legacy_fallback' as const,
    intent: cardIntent,
    products: selectedProducts,
    selectedProductIds: selectedProducts.map((product) => product.id),
    answerMentionedProductIds: mentioned.map((product) => product.id),
    droppedProductIds,
    warnings
  };
}

const ambiguousCutterTerms = ['резчик', 'резак', 'резки', 'резку', 'шовнарез', 'бензорез', 'cutter', 'cutoff saw'];
const cutterMaterialOrWorkTerms = [
  'бетон', 'асфальт', 'металл', 'кирпич', 'труб', 'рельс', 'камень', 'плит', 'пол', 'шв',
  'проем', 'двер', 'окн', 'мокр', 'сух', 'помещ', 'улиц', 'дорог', 'алмаз', 'диск'
];

function textContainsAnyFragment(text: string, fragments: string[]) {
  const normalized = text.toLocaleLowerCase('ru');
  return fragments.some((fragment) => normalized.includes(fragment));
}

export function ambiguousCutterRequestNeedsMaterialClarification(text: string) {
  const normalized = text.toLocaleLowerCase('ru');
  if (!textContainsAnyFragment(normalized, ambiguousCutterTerms)) return false;
  return !textContainsAnyFragment(normalized, cutterMaterialOrWorkTerms);
}

type VisibleCardSelection = Omit<ReturnType<typeof selectProductsForVisibleCards>, 'semanticAuthority'> & {
  semanticAuthority?: 'llm_contract' | 'legacy_fallback';
};

export type VisibleCardReadiness = {
  status: 'ready_for_cards' | 'blocked_by_answer_contract' | 'blocked_by_tool_safety';
  productClass: ProductSelectionClass;
  missingFacts: string[];
  rationale: string;
  warnings: string[];
  decision?: AnswerSelectionReadiness;
};

export function assessVisibleCardReadiness(input: {
  cardSelection: VisibleCardSelection;
  answer: AnswerContract;
  toolResults?: ToolResult[];
  userMessage?: string;
}): VisibleCardReadiness {
  const productClass = input.cardSelection.intent;
  if (
    input.cardSelection.semanticAuthority !== 'llm_contract' &&
    input.userMessage &&
    ambiguousCutterRequestNeedsMaterialClarification(input.userMessage)
  ) {
    return {
      status: 'blocked_by_tool_safety',
      productClass,
      missingFacts: ['cutter_material_or_work'],
      rationale: 'The buyer used ambiguous cutter wording without material/work, so product cards would mix different cutter classes.',
      warnings: ['product_cards_suppressed:cutter_ambiguous_material_or_work'],
      decision: input.answer.selectionReadiness
    };
  }
  if (isGeneratorProductClass(productClass) && hasUnconfirmedGeneratorLoadBasisResult(input.toolResults ?? [])) {
    return {
      status: 'blocked_by_tool_safety',
      productClass,
      missingFacts: ['explicit_generator_load_basis'],
      rationale: 'Generator load calculation did not have a confirmed load basis, so product cards remain premature.',
      warnings: ['product_cards_suppressed:generator_load_unconfirmed_basis'],
      decision: input.answer.selectionReadiness
    };
  }
  if (
    isGeneratorProductClass(productClass) &&
    input.cardSelection.products.length === 0 &&
    input.cardSelection.warnings.includes('product_cards_suppressed:budget_no_fit')
  ) {
    const decision = input.answer.selectionReadiness;
    return {
      status: 'blocked_by_answer_contract',
      productClass,
      missingFacts: decision?.missingFacts ?? [],
      rationale: 'No visible generator cards satisfy the structured budget constraint, so over-budget cards stay hidden.',
      warnings: ['product_cards_suppressed:budget_no_fit'],
      decision
    };
  }
  const decision = input.answer.selectionReadiness;
  if (!decision) {
    return {
      status: 'ready_for_cards',
      productClass,
      missingFacts: [],
      rationale: 'Selection readiness contract was not provided; preserving legacy card behavior.',
      warnings: []
    };
  }

  if (
    decision.status === 'not_applicable' &&
    !decision.canShowProductCards &&
    productClass !== 'unknown' &&
    !isGeneratorProductClass(productClass) &&
    input.cardSelection.products.length > 0
  ) {
    return {
      status: 'ready_for_cards',
      productClass,
      missingFacts: decision.missingFacts,
      rationale: `${decision.rationale} Selection readiness was marked not_applicable, so non-generator catalog cards stay visible.`,
      warnings: ['selection_readiness_not_applicable_preserved_cards'],
      decision
    };
  }

  if (decision.canShowProductCards) {
    return {
      status: 'ready_for_cards',
      productClass,
      missingFacts: decision.missingFacts,
      rationale: decision.rationale,
      warnings: [],
      decision
    };
  }

  return {
    status: 'blocked_by_answer_contract',
    productClass,
    missingFacts: decision.missingFacts,
    rationale: decision.rationale,
    warnings: ['product_cards_suppressed:selection_readiness_contract'],
    decision
  };
}

export function suppressVisibleCardsForReadiness(input: {
  cardSelection: VisibleCardSelection;
  readiness: VisibleCardReadiness;
}): VisibleCardSelection & { selectionReadiness: VisibleCardReadiness; suppressedProductIds: string[] } {
  if (input.readiness.status === 'ready_for_cards') {
    return {
      ...input.cardSelection,
      selectionReadiness: input.readiness,
      suppressedProductIds: []
    };
  }

  const suppressedProductIds = uniqueStrings([
    ...input.cardSelection.selectedProductIds,
    ...input.cardSelection.products.map((product) => product.id)
  ]);

  return {
    ...input.cardSelection,
    products: [],
    selectedProductIds: [],
    droppedProductIds: uniqueStrings([
      ...input.cardSelection.droppedProductIds,
      ...suppressedProductIds
    ]),
    warnings: uniqueStrings([
      ...input.cardSelection.warnings,
      ...input.readiness.warnings
    ]),
    selectionReadiness: input.readiness,
    suppressedProductIds
  };
}
