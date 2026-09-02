import type { CustomerNeedState, Message, Product, ProductCard, ProductSelectionClass } from '../shared/types.js';
import type { AgentIntentContract, AnswerContract, AnswerSelectionReadiness, ToolRequest, ToolResult } from './agentManagerContracts.js';
import {
  hasGeneratorLoadBasisThatBlocksPreliminaryFit,
  hasUnconfirmedGeneratorLoadBasisResult,
  isGeneratorProductClass
} from './agentManagerGeneratorLoad.js';
import {
  compactModelText,
  displayProductBrand,
  extractConfirmedGeneratorNominalPowerKw,
  extractGeneratorPowerForHardSelection,
  extractModelTokens,
  extractWeightKg,
  fromEscaped,
  generatorAutoStartProfile,
  generatorPhaseProfile,
  generatorRemoteStartProfile,
  productMentionedInText,
  productPowerSource
} from './productClassifier.js';
import {
  modelTextTokens as matchingModelTextTokens,
  tokenHasDigit,
  tokenHasLetter
} from './modelTextMatching.js';
import {
  buildRequirementProofs,
  productRequirementProofCaveats,
  requirementUsesGenericReadProof,
  requirementProofsFor,
  resolvedRequirementEligibilityStatus,
  selectionRequirementAttributeMatches,
  type RequirementProof
} from './requirementProofs.js';

export function normalizedProductIdentity(product: Product) {
  return matchingModelTextTokens(product.name).join('_') || product.id;
}

function uniqueVisibleProductsByIdentity(products: Product[]) {
  const seenIds = new Set<string>();
  const seenIdentities = new Set<string>();
  const unique: Product[] = [];
  for (const product of products) {
    const identity = normalizedProductIdentity(product);
    if (seenIds.has(product.id) || seenIdentities.has(identity)) continue;
    seenIds.add(product.id);
    seenIdentities.add(identity);
    unique.push(product);
  }
  return unique;
}

export function productCards(
  products: Product[],
  reasons: string[] = [],
  caveatsByProductId: Record<string, string[]> = {}
): ProductCard[] {
  return uniqueVisibleProductsByIdentity(products).map((product) => ({
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
    caveats: caveatsByProductId[product.id] ?? []
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

function typedProductClassKey(canonicalValue: unknown, fallbackValue: unknown) {
  const canonicalClass = coerceProductSelectionClass(canonicalValue);
  if (canonicalClass !== 'unknown') return canonicalClass;
  if (typeof fallbackValue !== 'string' || !fallbackValue.trim()) return null;
  const fallbackClass = fallbackValue.trim().toLocaleLowerCase('ru-RU');
  return fallbackClass === 'unknown' ? null : fallbackClass;
}

function productMatchesExactNamedTarget(product: Product, targetName: string) {
  const targetTokens = extractModelTokens(targetName).map(compactModelText).filter(Boolean);
  const productTokens = new Set(extractModelTokens(product.name).map(compactModelText).filter(Boolean));
  if (targetTokens.length) return targetTokens.every((token) => productTokens.has(token));
  const normalizedTarget = compactModelText(targetName);
  return Boolean(normalizedTarget && compactModelText(product.name).includes(normalizedTarget));
}

export function toolRequestProductIntent(request: ToolRequest): ProductSelectionClass {
  const args = request.args as Record<string, unknown>;
  const canonical = coerceProductSelectionClass(args.canonicalProductIntent);
  if (canonical !== 'unknown') return canonical;
  return coerceProductSelectionClass(args.productIntent);
}

export function toolRequestScopedQuery(request: ToolRequest) {
  const args = request.args as Record<string, unknown>;
  const query = typeof args.query === 'string' && args.query.trim()
    ? args.query.trim()
    : '';
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
  intent: AgentIntentContract;
}): ProductSelectionClass {
  const policyIntent = coerceProductSelectionClass(input.intent.selectionPolicy?.canonicalProductClass);
  if (policyIntent !== 'unknown') return policyIntent;
  if (typedProductClassKey(
    input.intent.selectionPolicy?.canonicalProductClass,
    input.intent.selectionPolicy?.targetProductClass
  ) !== null) return 'unknown';
  const toolIntent = intentFromContractToolRequests(input.intent);
  if (toolIntent !== 'unknown') return toolIntent;
  for (const mention of input.intent.productMentions ?? []) {
    const mentionIntent = coerceProductSelectionClass(mention.productClass);
    if (mentionIntent !== 'unknown') return mentionIntent;
  }
  return 'unknown';
}

function unfamiliarPrimaryProductIds(intent: AgentIntentContract, toolResults: ToolResult[]) {
  const canonicalPolicyClass = coerceProductSelectionClass(intent.selectionPolicy?.canonicalProductClass);
  if (canonicalPolicyClass !== 'unknown') return null;
  const primaryClassKey = typedProductClassKey(
    intent.selectionPolicy?.canonicalProductClass,
    intent.selectionPolicy?.targetProductClass
  );
  if (primaryClassKey === null) return null;
  const primaryRequestIds = new Set(intent.toolRequests
    .filter((request) =>
      (request.tool === 'catalog.search' || request.tool === 'catalog.getProductDetails') &&
      typedProductClassKey(request.args.canonicalProductIntent, request.args.productIntent) === primaryClassKey
    )
    .map((request) => request.id));
  const productIds = new Set<string>();
  for (const result of toolResults) {
    if (!primaryRequestIds.has(result.requestId) || result.status !== 'ok') continue;
    const payload = result.payload as { productIds?: unknown; products?: unknown };
    if (Array.isArray(payload.productIds)) {
      for (const id of payload.productIds) if (typeof id === 'string') productIds.add(id);
    }
    if (Array.isArray(payload.products)) {
      for (const product of payload.products) {
        if (product && typeof product === 'object' && typeof (product as { id?: unknown }).id === 'string') {
          productIds.add((product as { id: string }).id);
        }
      }
    }
  }
  return productIds;
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
  'price_lower_than_reference',
  'price_lower_than_reference_rub',
  'weight_min_kg',
  'weight_max_kg',
  'nominal_power_min_kw',
  'nominal_power_max_kw',
  'power_min_kw',
  'power_max_kw'
]);

const supportedStrictNumericRequirementUnits: Record<string, Set<string>> = {
  budget_max_rub: new Set(['rub', '₽', 'руб', 'руб.']),
  price_max_rub: new Set(['rub', '₽', 'руб', 'руб.']),
  price_lower_than_reference: new Set(['rub', '₽', 'руб', 'руб.']),
  price_lower_than_reference_rub: new Set(['rub', '₽', 'руб', 'руб.']),
  weight_min_kg: new Set(['kg', 'кг']),
  weight_max_kg: new Set(['kg', 'кг']),
  nominal_power_min_kw: new Set(['kw', 'квт']),
  nominal_power_max_kw: new Set(['kw', 'квт']),
  power_min_kw: new Set(['kw', 'квт']),
  power_max_kw: new Set(['kw', 'квт'])
};

const generatorLoadDerivedRequirementKind = 'generator_load_scenario';
const generatorLoadDerivedMinimumRequirementKinds = new Set(['nominal_power_min_kw', 'power_min_kw']);
const generatorAutoStartRequirementKinds = new Set(['auto_start_required', 'autostart_required']);
const generatorElectricStartRequirementKinds = new Set(['electric_start_required']);
const generatorRemoteStartRequirementKinds = new Set(['remote_start', 'remote_start_required']);
const priceVisibilityRequirementKind = 'price_visibility';
const generatorVoltageRequirementKind = 'voltage_v';
const supportedGeneratorVoltageUnits = new Set(['v', 'volt', 'volts', fromEscaped('\\u0432')]);

export interface StrictSelectionRequirementBlocker {
  id: string;
  kind: string;
  reason: string;
  evidence: string;
}

export interface StrictSelectionRequirementAssessment {
  blockers: StrictSelectionRequirementBlocker[];
  generatorNominalPowerMinKw?: number;
}

export interface StrictSelectionRequirementGate extends StrictSelectionRequirementAssessment {
  preliminaryUnverified: StrictSelectionRequirementBlocker[];
}

const webVerifiablePreliminaryBlockerReasons = new Set([
  'material_not_mechanically_verifiable',
  'unsupported_strict_requirement_kind'
]);

// Strict kinds with a deterministic verifier path in this module. A strict
// requirement of any other kind is an unconfirmed data gap (preliminary), not a
// blocker — AGENTS.md: missing verification ≠ proven conflict.
const deterministicallyVerifiableStrictKinds = new Set([
  ...supportedStrictNumericRequirementKinds,
  'product_type',
  'product_class',
  'phase',
  generatorVoltageRequirementKind,
  'fuel_type',
  'power_source',
  priceVisibilityRequirementKind,
  'comparison_scope',
  'quantity',
  ...generatorAutoStartRequirementKinds,
  ...generatorRemoteStartRequirementKinds,
  generatorLoadDerivedRequirementKind
]);

const failedOrOpenEndedWebProofBlockerReasons = new Set([
  'typed_tool_result_missing',
  'typed_tool_result_not_found',
  'typed_tool_result_denied',
  'typed_tool_result_error',
  'typed_tool_result_timeout',
  'unsupported_typed_tool_verifier'
]);

function typedToolRequirementProof(input: {
  requirement: NonNullable<AgentIntentContract['selectionPolicy']>['requirements'][number];
  intent: AgentIntentContract;
  productClass: ProductSelectionClass;
  toolResults: ToolResult[];
  requirementProofs: RequirementProof[];
}) {
  const verification = input.requirement.verification;
  if (!verification || verification.mode !== 'typed_tool') return undefined;
  const blocker = (reason: string): StrictSelectionRequirementBlocker => ({
    id: input.requirement.id,
    kind: input.requirement.kind,
    reason,
    evidence: input.requirement.evidence
  });
  const request = input.intent.toolRequests.find((item) => item.id === verification.toolRequestId);
  const carriedEvidenceAllowed =
    input.intent.selectionPolicy?.reusePreviousCards === true &&
    input.intent.selectionPolicy?.selectionGoal === 'preliminary_fit' &&
    verification.tool === 'calculator.generatorLoad' &&
    verification.verifier === 'generator_load_profile' &&
    verification.bindAs === 'nominal_power_min_kw' &&
    (
      input.requirement.kind === generatorLoadDerivedRequirementKind ||
      generatorLoadDerivedMinimumRequirementKinds.has(input.requirement.kind)
    );
  let result: ToolResult | undefined;
  if (!request) {
    if (!carriedEvidenceAllowed) return { blocker: blocker('typed_tool_request_missing') };
    result = [...input.toolResults].reverse().find((item) =>
      item.tool === verification.tool && item.status === 'ok'
    );
    if (!result) return { blocker: blocker('typed_tool_carried_result_missing') };
  } else {
    if (!request.required) return { blocker: blocker('typed_tool_request_not_required') };
    if (request.tool !== verification.tool) return { blocker: blocker('typed_tool_request_tool_mismatch') };
    if (!(request.coversRequirementIds ?? []).includes(input.requirement.id)) {
      return { blocker: blocker('typed_tool_request_missing_requirement_coverage') };
    }
    result = input.toolResults.find((item) => item.requestId === request.id);
    if (!result) return { blocker: blocker('typed_tool_result_missing') };
    if (result.tool !== request.tool) return { blocker: blocker('typed_tool_result_tool_mismatch') };
  }
  if (result.status !== 'ok') return { blocker: blocker(`typed_tool_result_${result.status}`) };

  if (
    verification.tool === 'calculator.generatorLoad' &&
    verification.verifier === 'generator_load_profile' &&
    verification.bindAs === 'nominal_power_min_kw'
  ) {
    const normalizedUnit = input.requirement.unit?.trim().toLocaleLowerCase('ru-RU');
    const scenarioShape = input.requirement.kind === generatorLoadDerivedRequirementKind &&
      input.requirement.value === true &&
      input.requirement.unit === null;
    const derivedMinimumShape = generatorLoadDerivedMinimumRequirementKinds.has(input.requirement.kind) &&
      input.requirement.value === null &&
      Boolean(normalizedUnit && supportedStrictNumericRequirementUnits[input.requirement.kind]?.has(normalizedUnit));
    if (
      input.requirement.kind !== generatorLoadDerivedRequirementKind &&
      !generatorLoadDerivedMinimumRequirementKinds.has(input.requirement.kind)
    ) {
      return { blocker: blocker('generator_load_requirement_kind_mismatch') };
    }
    if (!scenarioShape && !derivedMinimumShape) {
      return { blocker: blocker('generator_load_requirement_shape_mismatch') };
    }
    if (!isGeneratorProductClass(input.productClass)) {
      return { blocker: blocker('generator_load_product_class_mismatch') };
    }
    const selectionGoal = input.intent.selectionPolicy?.selectionGoal ?? 'final_fit';
    if (
      selectionGoal === 'final_fit' &&
      hasUnconfirmedGeneratorLoadBasisResult([result])
    ) {
      return { blocker: blocker('generator_load_result_not_final_fit_safe') };
    }
    if (
      selectionGoal === 'preliminary_fit' &&
      hasGeneratorLoadBasisThatBlocksPreliminaryFit([result])
    ) {
      return { blocker: blocker('generator_load_result_not_preliminary_fit_safe') };
    }
    const profile = (result.payload as { profile?: { requiredNominalKw?: unknown } }).profile;
    const requiredNominalKw = profile?.requiredNominalKw;
    if (typeof requiredNominalKw !== 'number' || !Number.isFinite(requiredNominalKw) || requiredNominalKw <= 0) {
      return { blocker: blocker('generator_load_profile_missing_positive_required_nominal_kw') };
    }
    return { generatorNominalPowerMinKw: requiredNominalKw };
  }

  if (
    verification.tool === 'web.researchProductFacts' ||
    verification.tool === 'catalog.search' ||
    verification.tool === 'catalog.getProductDetails'
  ) {
    const proofs = input.requirementProofs.filter((proof) => proof.requirementId === input.requirement.id);
    // The read completed and its evidence is represented in the proof contract.
    // An unverified semantic value is a preliminary data gap, not a malformed
    // verifier that should suppress every candidate before the writer sees it.
    if (
      proofs.some((proof) => proof.status !== 'unverified') ||
      proofs.length && !deterministicallyVerifiableStrictKinds.has(input.requirement.kind)
    ) return {};
  }

  return { blocker: blocker('unsupported_typed_tool_verifier') };
}

export function assessStrictSelectionRequirements(
  intent: AgentIntentContract,
  productClass: ProductSelectionClass,
  toolResults: ToolResult[] = [],
  products: Product[] = []
): StrictSelectionRequirementAssessment {
  const policy = intent.selectionPolicy;
  if (!policy) return { blockers: [] };

  const requirementProofs = buildRequirementProofs({ intent, products, toolResults });
  const blockers: StrictSelectionRequirementBlocker[] = [];
  let generatorNominalPowerMinKw: number | undefined;
  let generatorAutoStartRequirement: boolean | undefined;
  let generatorRemoteStartRequirement: boolean | undefined;
  const addBlocker = (
    requirement: NonNullable<AgentIntentContract['selectionPolicy']>['requirements'][number],
    reason: string
  ) => blockers.push({
    id: requirement.id,
    kind: requirement.kind,
    reason,
    evidence: requirement.evidence
  });
  for (const requirement of policy.requirements) {
    if (requirement.role !== 'hard_constraint' || requirement.strictness !== 'strict') continue;

    if (requirement.verification?.mode === 'typed_tool') {
      const proof = typedToolRequirementProof({
        requirement,
        intent,
        productClass,
        toolResults,
        requirementProofs
      });
      if (proof?.blocker) blockers.push(proof.blocker);
      if (proof?.generatorNominalPowerMinKw !== undefined) {
        generatorNominalPowerMinKw = generatorNominalPowerMinKw === undefined
          ? proof.generatorNominalPowerMinKw
          : Math.max(generatorNominalPowerMinKw, proof.generatorNominalPowerMinKw);
      }
      continue;
    }

    if (requirement.kind === 'product_type' || requirement.kind === 'product_class') {
      const expectedProductClass = coerceProductSelectionClass(requirement.value);
      const humanProductClass = typeof requirement.value === 'string'
        ? requirement.value.trim().toLocaleLowerCase('ru-RU')
        : '';
      const humanTargetProductClass = policy.targetProductClass?.trim().toLocaleLowerCase('ru-RU') ?? '';
      const explicitlyBoundHumanClass =
        expectedProductClass === 'unknown' &&
        humanProductClass.length > 0 &&
        humanProductClass === humanTargetProductClass &&
        policy.canonicalProductClass === productClass;
      if (
        requirement.unit !== null ||
        productClass === 'unknown' ||
        (!explicitlyBoundHumanClass && expectedProductClass !== productClass)
      ) {
        addBlocker(requirement, 'product_class_not_bound_to_canonical_policy');
      }
      continue;
    }

    if (supportedStrictNumericRequirementKinds.has(requirement.kind)) {
      const normalizedUnit = requirement.unit?.trim().toLocaleLowerCase('ru-RU');
      if (!normalizedUnit || !supportedStrictNumericRequirementUnits[requirement.kind]?.has(normalizedUnit)) {
        addBlocker(requirement, 'numeric_requirement_unit_mismatch');
        continue;
      }
      const value = typeof requirement.value === 'number'
        ? requirement.value
        : typeof requirement.value === 'string'
          ? Number(requirement.value)
          : Number.NaN;
      if (!Number.isFinite(value) || value < 0) {
        addBlocker(requirement, 'invalid_numeric_value');
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
        addBlocker(requirement, 'phase_not_bound_to_typed_policy');
      }
      continue;
    }

    if (requirement.kind === generatorVoltageRequirementKind) {
      const normalizedUnit = requirement.unit?.trim().toLocaleLowerCase('ru-RU');
      const hasSupportedUnit = requirement.unit === null || Boolean(
        normalizedUnit && supportedGeneratorVoltageUnits.has(normalizedUnit)
      );
      const voltage = typeof requirement.value === 'number'
        ? requirement.value
        : typeof requirement.value === 'string'
          ? Number(requirement.value)
          : Number.NaN;
      const expectedPhase = voltage === 220 || voltage === 230
        ? 'single_phase'
        : voltage === 380 || voltage === 400
          ? 'three_phase'
          : undefined;
      if (
        !isGeneratorProductClass(productClass) ||
        !hasSupportedUnit ||
        !expectedPhase ||
        policy.phase !== expectedPhase
      ) {
        addBlocker(requirement, 'generator_voltage_not_bound_to_typed_phase_policy');
      }
      continue;
    }

    if (requirement.kind === 'fuel_type' || requirement.kind === 'power_source') {
      const expected = normalizeStructuredGeneratorFuelRequirement(requirement.value);
      const expectedPolicyPowerSource = expected === 'battery'
        ? 'battery'
        : expected === 'mains'
          ? 'mains'
          : expected === 'gasoline' || expected === 'diesel' || expected === 'fuel'
            ? 'fuel'
            : undefined;
      if (
        requirement.unit !== null ||
        !expected ||
        policy.powerSource !== expectedPolicyPowerSource
      ) {
        addBlocker(requirement, 'fuel_type_not_bound_to_typed_policy');
      }
      continue;
    }

    if (generatorAutoStartRequirementKinds.has(requirement.kind)) {
      const relation = requirement.relation;
      if (
        requirement.unit !== null ||
        typeof requirement.value !== 'boolean' ||
        !isGeneratorProductClass(productClass)
      ) {
        addBlocker(requirement, 'autostart_requirement_shape_or_product_class_mismatch');
      } else if (
        requirement.value === false &&
        (relation === undefined || relation === 'not_required' || relation === 'preferred' || relation === 'context')
      ) {
        // A false value historically meant both “not required” and “must be
        // absent”. Legacy false values fail open as optional; only the new
        // explicit must_not_have relation may exclude catalog products.
        continue;
      } else if (
        (requirement.value === false && relation !== 'must_not_have') ||
        (requirement.value === true && relation === 'must_not_have')
      ) {
        addBlocker(requirement, 'autostart_requirement_relation_mismatch');
      } else if (
        generatorAutoStartRequirement !== undefined &&
        generatorAutoStartRequirement !== requirement.value
      ) {
        addBlocker(requirement, 'conflicting_autostart_requirements');
      } else {
        generatorAutoStartRequirement = requirement.value;
      }
      continue;
    }

    if (generatorRemoteStartRequirementKinds.has(requirement.kind)) {
      if (
        requirement.unit !== null ||
        typeof requirement.value !== 'boolean' ||
        !isGeneratorProductClass(productClass) ||
        (
          requirement.value === true && requirement.relation === 'must_not_have' ||
          requirement.value === false && requirement.relation !== 'must_not_have'
        )
      ) {
        addBlocker(requirement, 'remote_start_requirement_shape_or_product_class_mismatch');
      } else if (
        generatorRemoteStartRequirement !== undefined &&
        generatorRemoteStartRequirement !== requirement.value
      ) {
        addBlocker(requirement, 'conflicting_remote_start_requirements');
      } else {
        generatorRemoteStartRequirement = requirement.value;
      }
      continue;
    }

    if (generatorElectricStartRequirementKinds.has(requirement.kind)) {
      if (
        requirement.unit !== null ||
        typeof requirement.value !== 'boolean' ||
        requirement.value !== true ||
        requirement.relation === 'must_not_have' ||
        !isGeneratorProductClass(productClass)
      ) {
        addBlocker(requirement, 'electric_start_requirement_shape_or_product_class_mismatch');
      }
      continue;
    }

    if (requirement.kind === priceVisibilityRequirementKind) {
      if (
        requirement.unit !== null ||
        requirement.value !== true ||
        (requirement.relation !== undefined && requirement.relation !== 'must_have')
      ) {
        addBlocker(requirement, 'price_visibility_requirement_shape_mismatch');
      }
      continue;
    }

    if (requirement.kind === 'comparison_scope') {
      const comparisonSubjects = (intent.productMentions ?? []).filter((mention) =>
        mention.role === 'comparison_subject' || mention.role === 'target_product'
      );
      if (
        requirement.unit !== null ||
        typeof requirement.value !== 'string' ||
        !requirement.value.trim() ||
        policy.alternativePolicy !== 'exact_only' ||
        comparisonSubjects.length < 2
      ) {
        addBlocker(requirement, 'comparison_scope_not_bound_to_exact_product_mentions');
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
        addBlocker(requirement, 'invalid_quantity_value');
      }
      continue;
    }

    const genericProofs = requirementProofs.filter((proof) => proof.requirementId === requirement.id);
    if (!genericProofs.some((proof) => proof.status !== 'unverified')) {
      // No deterministic verifier for this kind: that is missing confirmation, not a
      // proven conflict. Per AGENTS.md the product stays a preliminary candidate and
      // the writer marks the unverified attribute; do not block concrete selection.
      continue;
    }
  }
  return { blockers, generatorNominalPowerMinKw };
}

export function strictSelectionRequirementBlockers(
  intent: AgentIntentContract,
  productClass: ProductSelectionClass,
  toolResults: ToolResult[] = []
) {
  return assessStrictSelectionRequirements(intent, productClass, toolResults).blockers;
}

const deferredStrictRequirementBlockerReasons = new Set([
  ...webVerifiablePreliminaryBlockerReasons,
  'typed_tool_result_missing',
  'typed_tool_carried_result_missing'
]);

export function strictSelectionRequirementShapeBlockers(
  intent: AgentIntentContract,
  productClass: ProductSelectionClass
) {
  return assessStrictSelectionRequirements(intent, productClass).blockers.filter((blocker) =>
    !deferredStrictRequirementBlockerReasons.has(blocker.reason)
  );
}

export function gateStrictSelectionRequirements(
  intent: AgentIntentContract,
  productClass: ProductSelectionClass,
  toolResults: ToolResult[] = [],
  products: Product[] = []
): StrictSelectionRequirementGate {
  const assessment = assessStrictSelectionRequirements(intent, productClass, toolResults, products);
  if (
    intent.selectionPolicy?.selectionGoal !== 'preliminary_fit' &&
    intent.selectionPolicy?.selectionGoal !== 'final_fit'
  ) {
    return { ...assessment, preliminaryUnverified: [] };
  }
  const webCoveredRequirementIds = new Set(intent.toolRequests.flatMap((request) =>
    request.tool === 'web.researchProductFacts' && request.required
      ? request.coversRequirementIds ?? []
      : []
  ));
  const typedWebRequirementIds = new Set(
    (intent.selectionPolicy?.requirements ?? []).flatMap((requirement) => {
      const verification = requirement.verification;
      if (verification?.mode !== 'typed_tool' || verification.tool !== 'web.researchProductFacts') return [];
      const request = intent.toolRequests.find((item) => item.id === verification.toolRequestId);
      if (
        request?.required !== true ||
        request.tool !== 'web.researchProductFacts' ||
        !(request.coversRequirementIds ?? []).includes(requirement.id)
      ) return [];
      return [requirement.id];
    })
  );
  const preliminaryUnverified = assessment.blockers.filter((blocker) =>
    (
      webVerifiablePreliminaryBlockerReasons.has(blocker.reason) &&
      webCoveredRequirementIds.has(blocker.id)
    ) || (
      failedOrOpenEndedWebProofBlockerReasons.has(blocker.reason) &&
      typedWebRequirementIds.has(blocker.id)
    )
  );
  const representedRequirementIds = new Set(preliminaryUnverified.map((blocker) => blocker.id));
  const requirementProofs = buildRequirementProofs({ intent, products, toolResults });
  for (const requirement of intent.selectionPolicy?.requirements ?? []) {
    if (
      requirement.role !== 'hard_constraint' ||
      requirement.strictness !== 'strict' ||
      representedRequirementIds.has(requirement.id)
    ) continue;
    // Unsupported strict kinds (no deterministic verifier exists) are unconfirmed
    // data gaps, not blockers (AGENTS.md): surface them as needing evidence so the
    // writer marks the caveat instead of suppressing the whole shortlist.
    const hasDeterministicVerifier = deterministicallyVerifiableStrictKinds.has(requirement.kind);
    const webCovered = webCoveredRequirementIds.has(requirement.id) || typedWebRequirementIds.has(requirement.id);
    if (!hasDeterministicVerifier) {
      preliminaryUnverified.push({
        id: requirement.id,
        kind: requirement.kind,
        reason: 'unsupported_strict_requirement_kind',
        evidence: requirement.evidence
      });
      representedRequirementIds.add(requirement.id);
      continue;
    }
    if (!webCovered) continue;
    const candidateNeedsEvidence = products.some((product) =>
      resolvedRequirementEligibilityStatus(requirementProofsFor(
        requirementProofs,
        product.id,
        [requirement.id]
      )) === 'unknown'
    );
    if (!candidateNeedsEvidence) continue;
    preliminaryUnverified.push({
      id: requirement.id,
      kind: requirement.kind,
      reason: 'catalog_requirement_needs_evidence',
      evidence: requirement.evidence
    });
  }
  const preliminaryUnverifiedKeys = new Set(
    preliminaryUnverified.map((blocker) => `${blocker.id}:${blocker.reason}`)
  );
  return {
    ...assessment,
    blockers: assessment.blockers.filter((blocker) =>
      !preliminaryUnverifiedKeys.has(`${blocker.id}:${blocker.reason}`)
    ),
    preliminaryUnverified
  };
}

function strictRequirementIdsForKinds(intent: AgentIntentContract, kinds: string[]) {
  const accepted = new Set(kinds);
  return (intent.selectionPolicy?.requirements ?? []).flatMap((requirement) =>
    requirement.role === 'hard_constraint' &&
    requirement.strictness === 'strict' &&
    accepted.has(requirement.kind)
      ? [requirement.id]
      : []
  );
}

function proofEligibilityStatusForKinds(input: {
  proofs: RequirementProof[];
  productId: string;
  intent: AgentIntentContract;
  kinds: string[];
}) {
  return resolvedRequirementEligibilityStatus(requirementProofsFor(
    input.proofs,
    input.productId,
    strictRequirementIdsForKinds(input.intent, input.kinds)
  ));
}

function productPassesNativeConstraintOrAuthoritativeProof(input: {
  proofs: RequirementProof[];
  productId: string;
  intent: AgentIntentContract;
  kinds: string[];
  nativeMatch: boolean;
  nativeKnown?: boolean;
}) {
  const proofs = requirementProofsFor(
    input.proofs,
    input.productId,
    strictRequirementIdsForKinds(input.intent, input.kinds)
  );
  const proofStatus = proofEligibilityStatusForKinds(input);
  const nativeKnown = input.nativeKnown ?? true;
  if (proofStatus === 'satisfied') return true;
  if (proofStatus === 'violated') return false;
  // Tri-state per AGENTS.md: a card missing the attribute is an unconfirmed data gap,
  // not a proven conflict — keep the candidate (writer marks the caveat). Only a
  // natively known mismatch is a real conflict.
  if (!nativeKnown) return true;
  if (proofs.some((proof) => proof.status === 'conflicted')) {
    return input.intent.selectionPolicy?.selectionGoal === 'preliminary_fit';
  }
  return input.nativeMatch;
}

function productsMeetingGenericRequirementProofs(input: {
  products: Product[];
  intent: AgentIntentContract;
  proofs: RequirementProof[];
}): { products: Product[]; unknownEvidenceKeptIds: string[] } {
  const strictRequirements = (input.intent.selectionPolicy?.requirements ?? []).filter((requirement) =>
    requirement.role === 'hard_constraint' && requirement.strictness === 'strict'
  );
  const proofBackedRequirementIds = new Set(input.proofs.flatMap((proof) =>
    proof.sourceResultIds.length ? [proof.requirementId] : []
  ));
  const genericRequirementIds = strictRequirements.flatMap((requirement) => {
    return requirementUsesGenericReadProof(requirement) && proofBackedRequirementIds.has(requirement.id)
      ? [requirement.id]
      : [];
  });
  if (!genericRequirementIds.length) {
    return { products: input.products, unknownEvidenceKeptIds: [] };
  }
  const finalFit = (input.intent.selectionPolicy?.selectionGoal ?? 'final_fit') === 'final_fit';
  const survivors: Array<{ product: Product; allSatisfied: boolean }> = [];
  for (const product of input.products) {
    let allSatisfied = true;
    let hasUnknown = false;
    let violated = false;
    for (const requirementId of genericRequirementIds) {
      const status = resolvedRequirementEligibilityStatus(requirementProofsFor(
        input.proofs,
        product.id,
        [requirementId]
      ));
      if (status === 'violated') {
        violated = true;
        break;
      }
      if (status !== 'satisfied') hasUnknown = true;
    }
    if (violated) continue;
    // A proven conflict excludes the product outright. Missing confirmation is
    // not a conflict: under final fit the product stays as a caveated
    // preliminary candidate instead of silently disappearing from the answer.
    if (finalFit && hasUnknown) allSatisfied = false;
    survivors.push({ product, allSatisfied });
  }
  const keptUnknown = survivors.filter((item) => !item.allSatisfied).map((item) => item.product);
  const ordered = [
    ...survivors.filter((item) => item.allSatisfied).map((item) => item.product),
    ...keptUnknown
  ];
  return { products: ordered, unknownEvidenceKeptIds: keptUnknown.map((product) => product.id) };
}

function structuredGeneratorAutoStartRequirement(intent: AgentIntentContract) {
  let resolved: boolean | undefined;
  for (const requirement of intent.selectionPolicy?.requirements ?? []) {
    if (
      requirement.role !== 'hard_constraint' ||
      requirement.strictness !== 'strict' ||
      !generatorAutoStartRequirementKinds.has(requirement.kind)
    ) continue;
    if (requirement.unit !== null || typeof requirement.value !== 'boolean') return 'invalid' as const;
    if (
      requirement.value === false &&
      (requirement.relation === undefined ||
        requirement.relation === 'not_required' ||
        requirement.relation === 'preferred' ||
        requirement.relation === 'context')
    ) continue;
    if (
      (requirement.value === false && requirement.relation !== 'must_not_have') ||
      (requirement.value === true && requirement.relation === 'must_not_have')
    ) return 'invalid' as const;
    if (resolved !== undefined && resolved !== requirement.value) return 'invalid' as const;
    resolved = requirement.value;
  }
  return resolved;
}

export function productMeetsSupportedStrictAutoStartRequirement(
  product: Product,
  intent: AgentIntentContract,
  productClass: ProductSelectionClass
) {
  const required = structuredGeneratorAutoStartRequirement(intent);
  if (required === undefined) return true;
  if (required === 'invalid') return false;
  if (!isGeneratorProductClass(productClass)) return false;
  const profile = generatorAutoStartProfile(product);
  if (profile === 'unknown' || profile === 'conflict') return false;
  return required ? profile === 'present' : profile === 'absent';
}

function structuredGeneratorRemoteStartRequirement(intent: AgentIntentContract) {
  let resolved: boolean | undefined;
  for (const requirement of intent.selectionPolicy?.requirements ?? []) {
    if (
      requirement.role !== 'hard_constraint' ||
      requirement.strictness !== 'strict' ||
      !generatorRemoteStartRequirementKinds.has(requirement.kind)
    ) continue;
    if (requirement.unit !== null || typeof requirement.value !== 'boolean') return 'invalid' as const;
    if (
      (requirement.value === true && requirement.relation === 'must_not_have') ||
      (requirement.value === false && requirement.relation !== 'must_not_have')
    ) return 'invalid' as const;
    if (resolved !== undefined && resolved !== requirement.value) return 'invalid' as const;
    resolved = requirement.value;
  }
  return resolved;
}

export function hasStructuredGeneratorRemoteStartPreference(intent: AgentIntentContract) {
  return (intent.selectionPolicy?.requirements ?? []).some((requirement) =>
    generatorRemoteStartRequirementKinds.has(requirement.kind) &&
    requirement.value === true &&
    requirement.unit === null &&
    requirement.relation === 'preferred' &&
    requirement.role === 'preference' &&
    requirement.strictness === 'preferred' &&
    requirement.verification?.mode === 'product_attribute'
  );
}

export function productMeetsSupportedStrictRemoteStartRequirement(
  product: Product,
  intent: AgentIntentContract,
  productClass: ProductSelectionClass
) {
  const required = structuredGeneratorRemoteStartRequirement(intent);
  if (required === undefined) return true;
  if (required === 'invalid' || !isGeneratorProductClass(productClass)) return false;
  const profile = generatorRemoteStartProfile(product);
  if (profile === 'unknown' || profile === 'conflict') return false;
  return required ? profile === 'present' : profile === 'absent';
}

function structuredBudgetMax(intent: AgentIntentContract) {
  const inclusiveMax = structuredRequirementNumber(intent, ['budget_max_rub', 'price_max_rub']);
  const exclusiveReference = structuredRequirementNumber(intent, [
    'price_lower_than_reference',
    'price_lower_than_reference_rub'
  ]);
  const exclusiveMax = exclusiveReference === undefined
    ? undefined
    : Math.max(0, exclusiveReference - 1);
  if (inclusiveMax === undefined) return exclusiveMax;
  if (exclusiveMax === undefined) return inclusiveMax;
  return Math.min(inclusiveMax, exclusiveMax);
}

function structuredGeneratorPowerRequirement(intent: AgentIntentContract): GeneratorPowerCardRequirement | undefined {
  const minKw = structuredRequirementNumber(intent, ['nominal_power_min_kw', 'power_min_kw']);
  const maxKw = structuredRequirementNumber(intent, ['nominal_power_max_kw', 'power_max_kw']);
  return minKw === undefined && maxKw === undefined ? undefined : { minKw, maxKw, requireNominal: true };
}

function structuredPlateWeightRange(intent: AgentIntentContract): { min: number; max: number } | undefined {
  const min = structuredRequirementNumber(intent, ['weight_min_kg']);
  const max = structuredRequirementNumber(intent, ['weight_max_kg']);
  if (min === undefined && max === undefined) return undefined;
  return {
    min: min ?? 0,
    max: max ?? Number.MAX_SAFE_INTEGER
  };
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

type StructuredGeneratorFuelRequirement = 'gasoline' | 'diesel' | 'battery' | 'fuel' | 'mains';

function normalizeStructuredGeneratorFuelRequirement(value: unknown): StructuredGeneratorFuelRequirement | undefined {
  const normalized = compactModelText(String(value ?? ''));
  if (['gasoline', 'petrol', 'benzine', 'бензин', 'бензиновый', 'бензиновые'].includes(normalized)) {
    return 'gasoline';
  }
  if (['diesel', 'дизель', 'дизельный', 'дизельные'].includes(normalized)) return 'diesel';
  if (['battery', 'аккумулятор', 'аккумуляторный', 'аккумуляторные'].includes(normalized)) return 'battery';
  if (['fuel', 'combustion', 'топливный', 'топливные'].includes(normalized)) return 'fuel';
  if (['mains', 'grid', 'сетевой', 'сетевые'].includes(normalized)) return 'mains';
  return undefined;
}

function structuredGeneratorFuelRequirement(intent: AgentIntentContract) {
  const strictRequirements = (intent.selectionPolicy?.requirements ?? []).filter((requirement) =>
    (requirement.kind === 'fuel_type' || requirement.kind === 'power_source') &&
    requirement.role === 'hard_constraint' &&
    requirement.strictness === 'strict'
  );
  if (!strictRequirements.length) return undefined;
  const values = uniqueStrings(strictRequirements.flatMap((requirement) => {
    const normalized = normalizeStructuredGeneratorFuelRequirement(requirement.value);
    return normalized ? [normalized] : [];
  }));
  return values.length === 1 ? values[0] as StructuredGeneratorFuelRequirement : 'invalid' as const;
}

export function productMeetsSupportedStrictFuelRequirement(
  product: Product,
  intent: AgentIntentContract,
  productClass: ProductSelectionClass
) {
  const requirement = structuredGeneratorFuelRequirement(intent);
  if (!requirement) return true;
  if (requirement === 'invalid' || productClass === 'unknown') return false;
  const actual = productPowerSource(product);
  if (requirement === 'fuel') return actual === 'gasoline' || actual === 'diesel';
  if (requirement === 'mains') return false;
  return actual === requirement;
}

function strictPriceVisibilityRequired(intent: AgentIntentContract) {
  return (intent.selectionPolicy?.requirements ?? []).some((requirement) =>
    requirement.kind === priceVisibilityRequirementKind &&
    requirement.role === 'hard_constraint' &&
    requirement.strictness === 'strict' &&
    requirement.value === true
  );
}

export function productMeetsSupportedStrictPriceVisibilityRequirement(
  product: Product,
  intent: AgentIntentContract
) {
  if (!strictPriceVisibilityRequired(intent)) return true;
  return typeof product.price === 'number' && Number.isFinite(product.price) && product.price > 0;
}

function structuredGeneratorVoltageRequirement(intent: AgentIntentContract) {
  const values = (intent.selectionPolicy?.requirements ?? []).flatMap((requirement) => {
    if (
      requirement.kind !== generatorVoltageRequirementKind ||
      requirement.role !== 'hard_constraint' ||
      requirement.strictness !== 'strict'
    ) return [];
    const value = typeof requirement.value === 'number'
      ? requirement.value
      : typeof requirement.value === 'string'
        ? Number(requirement.value)
        : Number.NaN;
    return Number.isFinite(value) ? [value] : [];
  });
  const unique = [...new Set(values)];
  return unique.length === 1 ? unique[0] : unique.length > 1 ? 'invalid' as const : undefined;
}

export function productMeetsSupportedStrictVoltageRequirement(
  product: Product,
  intent: AgentIntentContract,
  productClass: ProductSelectionClass
) {
  const voltage = structuredGeneratorVoltageRequirement(intent);
  if (voltage === undefined) return true;
  if (voltage === 'invalid' || !isGeneratorProductClass(productClass)) return false;
  const profile = generatorPhaseProfile(product);
  if (profile === 'unknown') return false;
  if (voltage === 220 || voltage === 230) {
    return profile === 'single_220' || profile === 'mixed_220_380';
  }
  if (voltage === 380 || voltage === 400) {
    return profile === 'three_phase_380' || profile === 'mixed_220_380';
  }
  return false;
}

export function productVoltageNativeKnown(product: Product, productClass: ProductSelectionClass) {
  return isGeneratorProductClass(productClass) && generatorPhaseProfile(product) !== 'unknown';
}

export function productFuelNativeKnown(product: Product) {
  return productPowerSource(product) !== 'unknown';
}

export function productAutoStartNativeKnown(product: Product) {
  return generatorAutoStartProfile(product) !== 'unknown';
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
  requireNominal?: boolean;
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

const nominalActivePowerUnitWords = new Set(
  ['kw', 'квт', 'w', 'вт'].flatMap((unit) => matchingModelTextTokens(unit))
);

export function qualifiedNominalActivePowerKw(product: Product) {
  const hasQualifiedField = Object.entries(product.specs ?? {}).some(([key, value]) => {
    if (!selectionRequirementAttributeMatches(key, 'nominal_power_min_kw')) return false;
    return matchingModelTextTokens([key, String(value)].join(' '))
      .some((word) => nominalActivePowerUnitWords.has(word));
  });
  return hasQualifiedField ? extractConfirmedGeneratorNominalPowerKw(product) : undefined;
}

function productMeetsGeneratorPowerCardRequirement(
  product: Product,
  requirement?: GeneratorPowerCardRequirement,
  failClosed = false
) {
  if (!requirement) return true;
  const power = extractGeneratorPowerForHardSelection(product);
  const nominal = requirement.requireNominal
    ? qualifiedNominalActivePowerKw(product)
    : power.nominalKw ?? power.maxKw;
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

export function generatorMeetsRequiredLoad(product: Product, requiredNominalKw: number) {
  if (!Number.isFinite(requiredNominalKw) || requiredNominalKw <= 0) return true;
  const nominalKw = qualifiedNominalActivePowerKw(product);
  return nominalKw === undefined ? undefined : nominalKw >= requiredNominalKw;
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
  const unconfirmedProductIds: string[] = [];
  for (const product of products) {
    const fit = generatorMeetsRequiredLoad(product, requiredNominalKw);
    if (fit !== false) {
      kept.push(product);
      if (fit === undefined) unconfirmedProductIds.push(product.id);
    } else {
      droppedProductIds.push(product.id);
    }
  }
  const warnings = [
    ...(droppedProductIds.length
      ? [`catalog_products_filtered_by_generator_load:${droppedProductIds.length}`]
      : []),
    ...(unconfirmedProductIds.length
      ? [`catalog_products_preliminary:generator_load_unconfirmed:${unconfirmedProductIds.length}`]
      : [])
  ];
  if (!kept.length && droppedProductIds.length) {
    warnings.push('catalog_search_no_generator_load_fit');
  }
  return {
    products: kept,
    droppedProductIds,
    warnings
  };
}

function productsWithinPlateWeightRange(products: Product[], range: { min: number; max: number }) {
  return products.filter((product) => {
    const weight = extractWeightKg(product);
    return weight !== undefined && weight >= range.min && weight <= range.max;
  });
}

export type ExecutableSelectionRankingObjective = {
  requirementId: string;
  attribute: 'weight_kg' | 'price_rub' | 'nominal_power_kw';
  direction: 'minimize' | 'maximize';
};

export function structuredSelectionRankingObjectives(
  intent: AgentIntentContract
): ExecutableSelectionRankingObjective[] {
  const policy = intent.selectionPolicy;
  if (!policy) return [];
  const requirements = new Map(policy.requirements.map((requirement) => [requirement.id, requirement]));
  const canonicalClass = policy.canonicalProductClass;
  const seen = new Set<string>();
  return (policy.rankingObjectives ?? []).filter((objective) => {
    const requirement = requirements.get(objective.requirementId);
    if (
      !requirement ||
      requirement.role !== 'preference' ||
      requirement.strictness !== 'preferred' ||
      requirement.relation !== 'preferred' ||
      requirement.verification?.mode !== 'product_attribute'
    ) return false;
    if (
      objective.attribute === 'nominal_power_kw' &&
      canonicalClass !== 'generator' &&
      canonicalClass !== 'weldingGenerator'
    ) return false;
    const key = `${objective.requirementId}:${objective.attribute}:${objective.direction}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function structuredRankingAttributeValue(
  product: Product,
  attribute: ExecutableSelectionRankingObjective['attribute']
) {
  if (attribute === 'weight_kg') return extractWeightKg(product);
  if (attribute === 'price_rub') {
    return typeof product.price === 'number' && Number.isFinite(product.price)
      ? product.price
      : undefined;
  }
  return qualifiedNominalActivePowerKw(product);
}

function generatorRemoteStartPreferenceRank(product: Product) {
  const profile = generatorRemoteStartProfile(product);
  if (profile === 'present') return 0;
  if (profile === 'absent') return 2;
  return 1;
}

export function rankCatalogProductsByStructuredPreferences(input: {
  products: Product[];
  intent: AgentIntentContract;
}) {
  const objectives = structuredSelectionRankingObjectives(input.intent);
  const remoteStartPreferred = hasStructuredGeneratorRemoteStartPreference(input.intent);
  if ((!objectives.length && !remoteStartPreferred) || input.products.length <= 1) return input.products;
  return input.products
    .map((product, index) => ({ product, index }))
    .sort((left, right) => {
      if (remoteStartPreferred) {
        const remoteStartOrder = generatorRemoteStartPreferenceRank(left.product) -
          generatorRemoteStartPreferenceRank(right.product);
        if (remoteStartOrder !== 0) return remoteStartOrder;
      }
      for (const objective of objectives) {
        const leftValue = structuredRankingAttributeValue(left.product, objective.attribute);
        const rightValue = structuredRankingAttributeValue(right.product, objective.attribute);
        const leftKnown = leftValue !== undefined && Number.isFinite(leftValue);
        const rightKnown = rightValue !== undefined && Number.isFinite(rightValue);
        if (leftKnown !== rightKnown) return leftKnown ? -1 : 1;
        if (!leftKnown || !rightKnown || leftValue === rightValue) continue;
        return objective.direction === 'minimize'
          ? leftValue - rightValue
          : rightValue - leftValue;
      }
      return left.index - right.index;
    })
    .map((item) => item.product);
}

export function selectProductsForVisibleCards(input: {
  products: Product[];
  userMessage: string;
  history: Message[];
  intent: AgentIntentContract;
  answerText: string;
  selectedProductIds?: string[];
  needState: CustomerNeedState;
  toolResults?: ToolResult[];
  allowHistoricalProducts?: boolean;
}) {
  const unique = uniqueProducts(input.products);
  const requirementProofs = buildRequirementProofs({
    intent: input.intent,
    products: unique,
    toolResults: input.toolResults ?? []
  });
  const productCaveatsById = productRequirementProofCaveats(requirementProofs);
  const hasExplicitCardTool = input.intent.toolRequests.some((request) =>
    request.tool === 'catalog.search' || request.tool === 'catalog.getProductDetails'
  ) || input.allowHistoricalProducts === true;
  const cardIntent = inferVisibleCardIntent(input);
  const structuredSelection = Boolean(
    input.intent.selectionPolicy && input.selectedProductIds !== undefined
  );
  if (!structuredSelection) {
    return {
      semanticAuthority: 'missing_structured_authority' as const,
      intent: cardIntent,
      products: [],
      selectedProductIds: [],
      answerMentionedProductIds: [],
      droppedProductIds: unique.map((product) => product.id),
      warnings: ['product_cards_blocked:missing_structured_llm_selection'],
      requirementProofs,
      productCaveatsById
    };
  }
  if (!hasExplicitCardTool) {
    return {
      semanticAuthority: 'llm_contract' as const,
      intent: cardIntent,
      products: [],
      selectedProductIds: [],
      answerMentionedProductIds: [],
      droppedProductIds: unique.map((product) => product.id),
      warnings: unique.length ? ['product_cards_suppressed:no_explicit_catalog_card_tool'] : [],
      requirementProofs,
      productCaveatsById
    };
  }
  const mentioned = answerMentionedProducts(unique, input.answerText);
  const strictRequirementAssessment = gateStrictSelectionRequirements(
    input.intent,
    cardIntent,
    input.toolResults ?? [],
    unique
  );
  if (strictRequirementAssessment.blockers.length) {
    return {
      semanticAuthority: 'llm_contract' as const,
      intent: cardIntent,
      products: [],
      selectedProductIds: [],
      answerMentionedProductIds: mentioned.map((product) => product.id),
      droppedProductIds: unique.map((product) => product.id),
      warnings: [`product_cards_suppressed:unsupported_or_unverifiable_strict_hard_constraint:${strictRequirementAssessment.blockers.length}`],
      requirementProofs,
      productCaveatsById
    };
  }

  const uniqueById = new Map(unique.map((product) => [product.id, product]));
  let selected = (input.selectedProductIds ?? []).flatMap((productId) => {
    const product = uniqueById.get(productId);
    return product ? [product] : [];
  });
  const unfamiliarPrimaryIds = unfamiliarPrimaryProductIds(input.intent, input.toolResults ?? []);
  if (unfamiliarPrimaryIds !== null) {
    selected = selected.filter((product) => unfamiliarPrimaryIds.has(product.id));
  }
  if (input.intent.selectionPolicy?.alternativePolicy === 'exact_only') {
    const exactTargetNames = (input.intent.productMentions ?? [])
      .filter((mention) => mention.role === 'target_product' || mention.role === 'comparison_subject')
      .map((mention) => mention.name);
    if (exactTargetNames.length) {
      selected = selected.filter((product) =>
        exactTargetNames.some((targetName) => productMatchesExactNamedTarget(product, targetName))
      );
    }
  }
  const beforeGenericProofCount = selected.length;
  const genericProofOutcome = productsMeetingGenericRequirementProofs({
    products: selected,
    intent: input.intent,
    proofs: requirementProofs
  });
  selected = genericProofOutcome.products;
  const genericProofFilteredCount = beforeGenericProofCount - selected.length;
  const unknownEvidenceKeptIds = input.intent.selectionPolicy?.selectionGoal === 'final_fit'
    ? genericProofOutcome.unknownEvidenceKeptIds
    : [];

  let priceVisibilityFilteredCount = 0;
  let priceVisibilityNoFit = false;
  if (strictPriceVisibilityRequired(input.intent) && selected.length) {
    const priceVisibleSelected = selected.filter((product) =>
      productMeetsSupportedStrictPriceVisibilityRequirement(product, input.intent)
    );
    priceVisibilityFilteredCount = selected.length - priceVisibleSelected.length;
    selected = priceVisibleSelected;
    priceVisibilityNoFit = selected.length === 0;
  }

  let voltageFilteredCount = 0;
  let voltageNoFit = false;
  const strictGeneratorVoltage = structuredGeneratorVoltageRequirement(input.intent);
  if (strictGeneratorVoltage !== undefined && selected.length) {
    const voltageMatchingSelected = selected.filter((product) =>
      productPassesNativeConstraintOrAuthoritativeProof({
        proofs: requirementProofs,
        productId: product.id,
        intent: input.intent,
        kinds: [generatorVoltageRequirementKind],
        nativeMatch: productMeetsSupportedStrictVoltageRequirement(product, input.intent, cardIntent),
        nativeKnown: productVoltageNativeKnown(product, cardIntent)
      })
    );
    voltageFilteredCount = selected.length - voltageMatchingSelected.length;
    selected = voltageMatchingSelected;
    voltageNoFit = selected.length === 0;
  }

  let powerSourceFilteredCount = 0;
  let powerSourceNoFit = false;
  const structuredPowerSource = input.intent.selectionPolicy?.powerSource;
  const batteryPowerSourceRequired = structuredPowerSource === 'battery';
  const strictFuelRequirement = structuredGeneratorFuelRequirement(input.intent);
  const hasStructuredPowerSource = Boolean(
    structuredPowerSource && structuredPowerSource !== 'any'
  );
  if (
    isGeneratorProductClass(cardIntent) &&
    selected.length &&
    (batteryPowerSourceRequired || hasStructuredPowerSource)
  ) {
    const sourceMatchingSelected = selected.filter((product) => productPassesNativeConstraintOrAuthoritativeProof({
      proofs: requirementProofs,
      productId: product.id,
      intent: input.intent,
      kinds: ['power_source'],
      nativeMatch: productMeetsStructuredPowerSource(product, structuredPowerSource),
      nativeKnown: productFuelNativeKnown(product)
    }));
    if (sourceMatchingSelected.length) {
      powerSourceFilteredCount = selected.length - sourceMatchingSelected.length;
      selected = sourceMatchingSelected;
    } else {
      powerSourceFilteredCount = selected.length;
      selected = [];
      powerSourceNoFit = true;
    }
  }

  let generatorFuelFilteredCount = 0;
  let generatorFuelNoFit = false;
  if (strictFuelRequirement && selected.length) {
    const fuelMatchingSelected = selected.filter((product) => productPassesNativeConstraintOrAuthoritativeProof({
      proofs: requirementProofs,
      productId: product.id,
      intent: input.intent,
      kinds: ['fuel_type', 'power_source'],
      nativeMatch: productMeetsSupportedStrictFuelRequirement(product, input.intent, cardIntent),
      nativeKnown: productFuelNativeKnown(product)
    }));
    generatorFuelFilteredCount = selected.length - fuelMatchingSelected.length;
    selected = fuelMatchingSelected;
    generatorFuelNoFit = selected.length === 0;
  }

  let generatorPowerFilteredCount = 0;
  let generatorPowerNoFit = false;
  const structuredGeneratorRequirement = structuredGeneratorPowerRequirement(input.intent);
  const generatorPowerRequirement = isGeneratorProductClass(cardIntent)
    ? strictRequirementAssessment.generatorNominalPowerMinKw === undefined
        ? structuredGeneratorRequirement
        : {
            minKw: Math.max(
              structuredGeneratorRequirement?.minKw ?? 0,
              strictRequirementAssessment.generatorNominalPowerMinKw
            ),
            maxKw: structuredGeneratorRequirement?.maxKw,
            requireNominal: true
          }
    : undefined;
  if (isGeneratorProductClass(cardIntent) && selected.length && generatorPowerRequirement) {
    const powerMatchingSelected = selected.filter((product) => productPassesNativeConstraintOrAuthoritativeProof({
      proofs: requirementProofs,
      productId: product.id,
      intent: input.intent,
      kinds: ['nominal_power_min_kw', 'power_min_kw', 'nominal_power_max_kw', 'power_max_kw'],
      nativeMatch: productMeetsGeneratorPowerCardRequirement(product, generatorPowerRequirement, true),
      // Only a qualified nominal ACTIVE power reading (kW, not max/peak/engine/kVA)
      // counts as natively known; otherwise the card is an unconfirmed data gap.
      nativeKnown: qualifiedNominalActivePowerKw(product) !== undefined
    }));
    if (powerMatchingSelected.length) {
      generatorPowerFilteredCount = selected.length - powerMatchingSelected.length;
      selected = powerMatchingSelected;
    } else {
      generatorPowerFilteredCount = selected.length;
      selected = [];
      generatorPowerNoFit = true;
    }
  }

  let generatorPhaseFilteredCount = 0;
  let generatorPhaseNoFit = false;
  const generatorPhaseRequirement = isGeneratorProductClass(cardIntent)
    ? input.intent.selectionPolicy?.phase === 'single_phase'
        ? 'single_220'
        : input.intent.selectionPolicy?.phase === 'three_phase'
          ? 'three_380'
          : undefined
    : undefined;
  if (isGeneratorProductClass(cardIntent) && selected.length && generatorPhaseRequirement) {
    const phaseMatchingSelected = selected.filter((product) => {
      return productPassesNativeConstraintOrAuthoritativeProof({
        proofs: requirementProofs,
        productId: product.id,
        intent: input.intent,
        kinds: ['phase', generatorVoltageRequirementKind],
        nativeMatch: productMeetsGeneratorPhaseRequirement(product, generatorPhaseRequirement, true),
        nativeKnown: productVoltageNativeKnown(product, cardIntent)
      });
    });
    if (phaseMatchingSelected.length) {
      generatorPhaseFilteredCount = selected.length - phaseMatchingSelected.length;
      selected = phaseMatchingSelected;
    } else {
      generatorPhaseFilteredCount = selected.length;
      selected = [];
      generatorPhaseNoFit = true;
    }
  }

  let generatorAutoStartFilteredCount = 0;
  let generatorAutoStartNoFit = false;
  const generatorAutoStartRequirement = input.intent.selectionPolicy && isGeneratorProductClass(cardIntent)
    ? structuredGeneratorAutoStartRequirement(input.intent)
    : undefined;
  if (generatorAutoStartRequirement !== undefined && selected.length) {
    const autoStartMatchingSelected = selected.filter((product) => productPassesNativeConstraintOrAuthoritativeProof({
      proofs: requirementProofs,
      productId: product.id,
      intent: input.intent,
      kinds: [...generatorAutoStartRequirementKinds],
      nativeMatch: productMeetsSupportedStrictAutoStartRequirement(product, input.intent, cardIntent),
      nativeKnown: productAutoStartNativeKnown(product)
    }));
    generatorAutoStartFilteredCount = selected.length - autoStartMatchingSelected.length;
    selected = autoStartMatchingSelected;
    generatorAutoStartNoFit = selected.length === 0;
  }

  let generatorRemoteStartFilteredCount = 0;
  let generatorRemoteStartNoFit = false;
  let generatorRemoteStartUnknownKeptCount = 0;
  const generatorRemoteStartRequirement = input.intent.selectionPolicy && isGeneratorProductClass(cardIntent)
    ? structuredGeneratorRemoteStartRequirement(input.intent)
    : undefined;
  if (generatorRemoteStartRequirement !== undefined && selected.length) {
    const remoteStartMatchingSelected = selected.filter((product) => productPassesNativeConstraintOrAuthoritativeProof({
      proofs: requirementProofs,
      productId: product.id,
      intent: input.intent,
      kinds: [...generatorRemoteStartRequirementKinds],
      nativeMatch: productMeetsSupportedStrictRemoteStartRequirement(product, input.intent, cardIntent),
      nativeKnown: generatorRemoteStartProfile(product) !== 'unknown'
    }));
    generatorRemoteStartFilteredCount = selected.length - remoteStartMatchingSelected.length;
    selected = remoteStartMatchingSelected;
    generatorRemoteStartNoFit = selected.length === 0;
    generatorRemoteStartUnknownKeptCount = selected.filter((product) =>
      generatorRemoteStartProfile(product) === 'unknown'
    ).length;
    for (const product of selected) {
      if (generatorRemoteStartProfile(product) !== 'unknown') continue;
      productCaveatsById[product.id] = uniqueStrings([
        ...(productCaveatsById[product.id] ?? []),
        'Запуск по команде с брелока или пульта в доступных характеристиках не подтвержден.'
      ]);
    }
  }

  const budgetMax = structuredBudgetMax(input.intent);
  let budgetFilteredCount = 0;
  let budgetNoFit = false;
  if (budgetMax !== undefined && selected.length) {
    const withinBudgetOrUnknown = selected.filter((product) =>
      typeof product.price !== 'number' ||
      !Number.isFinite(product.price) ||
      product.price <= budgetMax
    );
    budgetFilteredCount = selected.length - withinBudgetOrUnknown.length;
    selected = withinBudgetOrUnknown;
    budgetNoFit = selected.length === 0;
  }

  let numericFitFilteredCount = 0;
  let plateTaskFilteredCount = 0;
  let plateTaskWarnings: string[] = [];
  const plateWeightRange = cardIntent === 'plate'
    ? structuredPlateWeightRange(input.intent)
    : undefined;
  if (plateWeightRange && selected.length) {
    const nativeWeightMatches = new Set(
      productsWithinPlateWeightRange(selected, plateWeightRange).map((product) => product.id)
    );
    const selectedWithinRange = selected
      .filter((product) => productPassesNativeConstraintOrAuthoritativeProof({
        proofs: requirementProofs,
        productId: product.id,
        intent: input.intent,
        kinds: ['weight_min_kg', 'weight_max_kg'],
        nativeMatch: nativeWeightMatches.has(product.id),
        nativeKnown: extractWeightKg(product) !== undefined
      }));
    if (selectedWithinRange.length) {
      numericFitFilteredCount = selected.length - selectedWithinRange.length;
      selected = selectedWithinRange;
    } else {
      numericFitFilteredCount = selected.length;
      plateTaskWarnings = ['product_cards_suppressed:structured_weight_no_fit'];
      selected = [];
    }
  }

  const visibleCardLimit = input.intent.selectionPolicy?.maxCards ?? undefined;
  const selectedById = uniqueProducts(selected);
  const selectedProducts = uniqueVisibleProductsByIdentity(selectedById).slice(0, visibleCardLimit ?? 8);
  const identityDeduplicatedCount = selectedById.length - uniqueVisibleProductsByIdentity(selectedById).length;
  const selectedIds = new Set(selectedProducts.map((product) => product.id));
  const structuredRequestedIds = new Set(input.selectedProductIds ?? []);
  const structuredSuppressedCount = [...structuredRequestedIds].filter((id) => !selectedIds.has(id)).length;
  const droppedProductIds = unique
    .filter((product) => !selectedIds.has(product.id))
    .map((product) => product.id);
  const warnings = [
    ...(strictRequirementAssessment.preliminaryUnverified.length
      ? [`product_cards_preliminary:unverified_web_covered_strict_requirements:${strictRequirementAssessment.preliminaryUnverified.length}`]
      : []),
    ...(strictRequirementAssessment.preliminaryUnverified.length
      ? [`product_cards_preliminary:needs_evidence:${strictRequirementAssessment.preliminaryUnverified.length}`]
      : []),
    ...(genericProofFilteredCount > 0
      ? [`product_cards_filtered_by_requirement_proof:${genericProofFilteredCount}`]
      : []),
    ...(unknownEvidenceKeptIds.length
      ? [`product_cards_preliminary:unknown_evidence_kept:${unknownEvidenceKeptIds.length}`]
      : []),
    ...(identityDeduplicatedCount > 0
      ? [`product_cards_deduplicated_by_product_identity:${identityDeduplicatedCount}`]
      : []),
    ...(droppedProductIds.length ? [`product_cards_filtered:${droppedProductIds.length}`] : []),
    ...(structuredSuppressedCount > 0
      ? [`product_cards_suppressed:selected_id_not_grounded_mentioned_or_fit:${structuredSuppressedCount}`]
      : []),
    ...(budgetFilteredCount > 0 ? [`product_cards_filtered_by_budget:${budgetFilteredCount}`] : []),
    ...(budgetNoFit ? ['product_cards_suppressed:budget_no_fit'] : []),
    ...(priceVisibilityFilteredCount > 0
      ? [`product_cards_filtered_by_price_visibility:${priceVisibilityFilteredCount}`]
      : []),
    ...(priceVisibilityNoFit ? ['product_cards_suppressed:price_visibility_no_fit'] : []),
    ...(voltageFilteredCount > 0
      ? [`product_cards_filtered_by_generator_voltage:${strictGeneratorVoltage}:${voltageFilteredCount}`]
      : []),
    ...(voltageNoFit ? [`product_cards_suppressed:generator_voltage_no_fit:${strictGeneratorVoltage}`] : []),
    ...(powerSourceFilteredCount > 0
      ? [`product_cards_filtered_by_power_source:${structuredPowerSource ?? 'battery'}:${powerSourceFilteredCount}`]
      : []),
    ...(powerSourceNoFit
      ? [`product_cards_suppressed:power_source_no_fit:${structuredPowerSource ?? 'battery'}`]
      : []),
    ...(generatorFuelFilteredCount > 0
      ? [`product_cards_filtered_by_fuel:${strictFuelRequirement}:${generatorFuelFilteredCount}`]
      : []),
    ...(generatorFuelNoFit
      ? [`product_cards_suppressed:fuel_no_fit:${strictFuelRequirement}`]
      : []),
    ...(generatorPowerFilteredCount > 0 ? [`product_cards_filtered_by_generator_power:${generatorPowerFilteredCount}`] : []),
    ...(generatorPowerNoFit ? ['product_cards_suppressed:generator_power_no_fit'] : []),
    ...(generatorPhaseFilteredCount > 0 ? [`product_cards_filtered_by_generator_phase:${generatorPhaseFilteredCount}`] : []),
    ...(generatorPhaseNoFit ? ['product_cards_suppressed:generator_phase_no_fit'] : []),
    ...(generatorAutoStartFilteredCount > 0 ? [`product_cards_filtered_by_generator_autostart:${generatorAutoStartFilteredCount}`] : []),
    ...(generatorAutoStartNoFit ? ['product_cards_suppressed:generator_autostart_no_fit'] : []),
    ...(generatorRemoteStartFilteredCount > 0 ? [`product_cards_filtered_by_generator_remote_start:${generatorRemoteStartFilteredCount}`] : []),
    ...(generatorRemoteStartNoFit ? ['product_cards_suppressed:generator_remote_start_no_fit'] : []),
    ...(generatorRemoteStartUnknownKeptCount > 0 ? [`product_cards_preliminary:generator_remote_start_unconfirmed:${generatorRemoteStartUnknownKeptCount}`] : []),
    ...(numericFitFilteredCount > 0 ? [`product_cards_filtered_by_numeric_fit:${numericFitFilteredCount}`] : []),
    ...(plateTaskFilteredCount > 0 ? [`product_cards_filtered_by_plate_task:${plateTaskFilteredCount}`] : []),
    ...plateTaskWarnings
  ];

  return {
    semanticAuthority: 'llm_contract' as const,
    intent: cardIntent,
    products: selectedProducts,
    selectedProductIds: selectedProducts.map((product) => product.id),
    answerMentionedProductIds: mentioned.map((product) => product.id),
    droppedProductIds,
    warnings,
    requirementProofs,
    productCaveatsById
  };
}

type VisibleCardSelection = Omit<
  ReturnType<typeof selectProductsForVisibleCards>,
  'semanticAuthority' | 'requirementProofs' | 'productCaveatsById'
> & {
  semanticAuthority?: 'llm_contract' | 'missing_structured_authority';
  requirementProofs?: RequirementProof[];
  productCaveatsById?: Record<string, string[]>;
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
  intent?: AgentIntentContract;
}): VisibleCardReadiness {
  const productClass = input.cardSelection.intent;
  const selectionGoal = input.intent?.selectionPolicy?.selectionGoal ?? 'final_fit';
  const generatorLoadBlocksCards = selectionGoal === 'browse_catalog'
    ? false
    : selectionGoal === 'preliminary_fit'
      ? hasGeneratorLoadBasisThatBlocksPreliminaryFit(input.toolResults ?? [])
      : hasUnconfirmedGeneratorLoadBasisResult(input.toolResults ?? []);
  if (isGeneratorProductClass(productClass) && generatorLoadBlocksCards) {
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
      status: 'blocked_by_answer_contract',
      productClass,
      missingFacts: ['selection_readiness_contract'],
      rationale: 'Selection readiness contract was not provided.',
      warnings: ['product_cards_suppressed:selection_readiness_contract']
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
