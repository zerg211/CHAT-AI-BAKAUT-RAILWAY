import type { CustomerNeedState, Message, Product, ProductCard, ProductSelectionClass } from '../shared/types.js';
import type { AgentIntentContract, AnswerContract, AnswerSelectionReadiness, ToolRequest, ToolResult } from './agentManagerContracts.js';
import { hasUnconfirmedGeneratorLoadBasisResult, isGeneratorProductClass } from './agentManagerGeneratorLoad.js';
import {
  compactModelText,
  displayProductBrand,
  extractGeneratorPowerForHardSelection,
  extractModelTokens,
  extractWeightKg,
  inferProductIntent,
  isCoreEquipment,
  parseWeightNeedRangeKg,
  productMatchesIntent,
  productMentionedInText
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
  const prefix = ['budget.max:', 'budget_max:', 'budgetmax:', 'budget:'].find((candidate) => trimmed.startsWith(candidate));
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

  const textValues = [
    ...(needState.constraints ?? []).map((item) => item.value),
    ...(needState.confirmedFacts ?? []).map((item) => item.value),
    ...(needState.explicitNeeds ?? []).map((item) => item.value),
    ...(needState.activeNeeds ?? []).flatMap((need) => need.constraints ?? [])
  ];
  for (const value of textValues) {
    const budget = typeof value === 'string' ? numberFromStructuredBudgetText(value) : undefined;
    if (budget !== undefined) return budget;
  }
  return undefined;
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

export function toolRequestProductIntent(request: ToolRequest, fallbackText = ''): ProductSelectionClass {
  const args = request.args as Record<string, unknown>;
  const explicit = coerceProductSelectionClass(args.productIntent);
  if (explicit !== 'unknown') return explicit;
  const semanticText = [
    typeof args.semanticQuery === 'string' ? args.semanticQuery : '',
    typeof args.query === 'string' ? args.query : '',
    typeof args.reason === 'string' ? args.reason : '',
    typeof args.notes === 'string' ? args.notes : '',
    request.rationale,
    fallbackText
  ].filter(Boolean).join('\n');
  return inferProductIntent(semanticText);
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
  needState: CustomerNeedState;
}): ProductSelectionClass {
  const toolIntent = intentFromContractToolRequests(input.intent);
  if (toolIntent !== 'unknown') return toolIntent;
  const semanticText = [
    input.userMessage,
    input.intent.userMessageSummary,
    input.intent.dialogueUnderstanding,
    input.intent.nextStepRationale,
    input.intent.productMentions?.map((mention) => [mention.productClass, mention.name, mention.evidence].filter(Boolean).join(' ')).join('\n'),
    toolRequestSemanticText(input.intent),
    input.answerText
  ].filter(Boolean).join('\n');
  const textIntent = inferProductIntent(semanticText);
  return textIntent !== 'unknown' ? textIntent : latestActiveNeedProductClass(input.needState);
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

function hasPowerUnitAt(value: string, index: number) {
  const tail = value.slice(index).toLocaleLowerCase('ru-RU');
  return ['квт', 'kw', 'kva', 'ква'].some((unit) => tail.startsWith(unit));
}

function requestedPowerRangeKw(text: string) {
  for (let index = 0; index < text.length; index += 1) {
    const left = decimalNumberAt(text, index);
    if (!left) continue;
    const separatorEnd = rangeSeparatorEnd(text, skipWhitespace(text, left.end));
    if (separatorEnd === undefined) {
      index = left.end;
      continue;
    }
    const right = decimalNumberAt(text, skipWhitespace(text, separatorEnd));
    if (right && hasPowerUnitAt(text, skipWhitespace(text, right.end))) {
      return {
        min: Math.min(left.value, right.value),
        max: Math.max(left.value, right.value)
      };
    }
    index = left.end;
  }

  for (let index = 0; index < text.length; index += 1) {
    const exact = decimalNumberAt(text, index);
    if (!exact) continue;
    if (hasPowerUnitAt(text, skipWhitespace(text, exact.end))) {
      return { min: Math.max(0.1, exact.value - 0.75), max: exact.value + 0.75 };
    }
    index = exact.end;
  }
  return undefined;
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

function requestedPlateWeightRangeKg(input: {
  userMessage: string;
  query: string;
  semanticContext: string;
}) {
  const userExplicit = parseWeightNeedRangeKg(input.userMessage);
  if (userExplicit) return { ...userExplicit, source: 'explicit_user' as const };

  const joined = [input.userMessage, input.query, input.semanticContext].join('\n');
  if (isSelfLoadingPlateText(joined)) return { min: 40, max: 75, source: 'self_loading' as const };
  if (isSmallPlateSiteText(joined) && !isHeavyPlateSiteText(joined)) return { min: 45, max: 95, source: 'small_site' as const };

  const plannerExplicit = parseWeightNeedRangeKg(input.query) ?? parseWeightNeedRangeKg(input.semanticContext);
  return plannerExplicit ? { ...plannerExplicit, source: 'planner' as const } : undefined;
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
  if (hintTextContainsAny(normalized, ['две самые', 'два самых', '2 самые', '2 самых', 'только две', 'только два', 'оставьте две', 'оставьте два'])) {
    return 2;
  }
  if (hintTextContainsAny(normalized, ['три самые', 'три самых', '3 самые', '3 самых', 'только три', 'оставьте три'])) {
    return 3;
  }
  return undefined;
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
    return input.products
      .map((product, index) => ({
        product,
        index,
        score: plateWeightFitScore(product, range)
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
  const maxRub = budgetMaxFromNeedState(input.needState);
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
  const maxRub = budgetMaxFromNeedState(input.needState);
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

export function selectProductsForVisibleCards(input: {
  products: Product[];
  userMessage: string;
  history: Message[];
  intent: AgentIntentContract;
  answerText: string;
  needState: CustomerNeedState;
  allowHistoricalProducts?: boolean;
}) {
  const unique = uniqueProducts(input.products);
  const hasExplicitCardTool = input.intent.toolRequests.some((request) =>
    request.tool === 'catalog.search' || request.tool === 'catalog.getProductDetails'
  ) || input.allowHistoricalProducts === true;
  const cardIntent = inferVisibleCardIntent(input);
  if (!hasExplicitCardTool) {
    return {
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

  let selected: Product[];
  if (mentionedMatchingIntent.length) {
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

  const budgetMax = budgetMaxFromNeedState(input.needState);
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

  let numericFitFilteredCount = 0;
  const plateWeightRange = cardIntent === 'plate'
    ? requestedPlateWeightRangeKg({
        userMessage: input.userMessage,
        query: toolRequestSemanticText(input.intent),
        semanticContext: [
          input.intent.userMessageSummary,
          input.intent.dialogueUnderstanding,
          input.intent.nextStepRationale
        ].filter(Boolean).join('\n')
      })
    : undefined;
  if (plateWeightRange && selected.length) {
    const selectedWithinRange = productsWithinPlateWeightRange(selected, plateWeightRange);
    if (selectedWithinRange.length) {
      numericFitFilteredCount = selected.length - selectedWithinRange.length;
      selected = selectedWithinRange;
    } else {
      const fallbackWithinRange = productsWithinPlateWeightRange(sameIntentPool, plateWeightRange);
      if (fallbackWithinRange.length) {
        numericFitFilteredCount = selected.length;
        selected = fallbackWithinRange;
      }
    }
  }

  const visibleCardLimit = requestedVisibleCardLimit({
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
  const droppedProductIds = unique
    .filter((product) => !selectedIds.has(product.id))
    .map((product) => product.id);
  const warnings = [
    ...(droppedProductIds.length ? [`product_cards_filtered:${droppedProductIds.length}`] : []),
    ...(budgetFilteredCount > 0 ? [`product_cards_filtered_by_budget:${budgetFilteredCount}`] : []),
    ...(budgetNoFit ? ['product_cards_suppressed:budget_no_fit'] : []),
    ...(numericFitFilteredCount > 0 ? [`product_cards_filtered_by_numeric_fit:${numericFitFilteredCount}`] : [])
  ];

  return {
    intent: cardIntent,
    products: selectedProducts,
    selectedProductIds: selectedProducts.map((product) => product.id),
    answerMentionedProductIds: mentioned.map((product) => product.id),
    droppedProductIds,
    warnings
  };
}

type VisibleCardSelection = ReturnType<typeof selectProductsForVisibleCards>;

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
}): VisibleCardReadiness {
  const productClass = input.cardSelection.intent;
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
