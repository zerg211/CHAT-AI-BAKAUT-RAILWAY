import type { Product } from '../shared/types.js';
import type { PreSendReview, ToolResult } from './agentManagerContracts.js';
import { extractStructuredProductAttributes } from './productAttributeExtraction.js';
import {
  compactModelText,
  modelIdentifierDisplayTokens,
  modelIdentifierTokens,
  modelTextTokens,
  normalizeModelText,
  textMatchesTargetName,
  tokenHasDigit,
  tokenHasLetter
} from './modelTextMatching.js';

export interface ReviewerRewriteGuardInput {
  revisedAnswerText: string;
  userMessage: string;
  products: Product[];
  toolResults: ToolResult[];
  durableLeadCaptureSucceeded: boolean;
  numericClaimBindings?: ReviewerRewriteNumericClaimBinding[];
}

type NumericQualifier = 'nominal' | 'maximum';

export interface ReviewerRewriteNumericClaimBinding {
  verifiedSourceQuote: string;
  dimension: string;
  value: number;
  qualifier?: NumericQualifier;
  semanticRole: 'buyer_requirement_threshold';
  sourceId: string;
}

interface NumericFact {
  dimension: string;
  value: number;
  qualifier?: NumericQualifier;
}

interface NumericClaim extends NumericFact {
  raw: string;
  start: number;
  end: number;
}

interface ProductEvidence {
  key: string;
  name: string;
  identifiers: Set<string>;
  numericFacts: NumericFact[];
}

interface UnitDefinition {
  dimension: string;
  multiplier: number;
  aliases: string[];
}

const unitDefinitions: UnitDefinition[] = [
  { dimension: 'price_rub', multiplier: 1, aliases: ['₽', 'руб', 'руб.', 'рубль', 'рубля', 'рублей', 'rub', 'ruble', 'rubles'] },
  { dimension: 'percent', multiplier: 1, aliases: ['%', 'процент', 'процента', 'процентов', 'percent'] },
  { dimension: 'power_kw', multiplier: 1, aliases: ['квт', 'kw', 'kilowatt', 'kilowatts'] },
  { dimension: 'power_kw', multiplier: 0.001, aliases: ['вт', 'w', 'watt', 'watts'] },
  { dimension: 'apparent_power_kva', multiplier: 1, aliases: ['ква', 'kva'] },
  { dimension: 'voltage_v', multiplier: 1, aliases: ['в', 'v', 'вольт', 'вольта', 'вольтов', 'volt', 'volts'] },
  { dimension: 'current_a', multiplier: 1, aliases: ['а', 'a', 'ампер', 'ампера', 'амперов', 'amp', 'amps'] },
  { dimension: 'frequency_hz', multiplier: 1, aliases: ['гц', 'hz', 'hertz'] },
  { dimension: 'mass_kg', multiplier: 1, aliases: ['кг', 'kg', 'килограмм', 'килограмма', 'килограммов'] },
  { dimension: 'mass_kg', multiplier: 0.001, aliases: ['г', 'g', 'грамм', 'грамма', 'граммов'] },
  { dimension: 'length_mm', multiplier: 1, aliases: ['мм', 'mm', 'миллиметр', 'миллиметра', 'миллиметров'] },
  { dimension: 'length_mm', multiplier: 10, aliases: ['см', 'cm', 'сантиметр', 'сантиметра', 'сантиметров'] },
  { dimension: 'length_mm', multiplier: 1000, aliases: ['м', 'm', 'метр', 'метра', 'метров'] },
  { dimension: 'volume_l', multiplier: 1, aliases: ['л', 'l', 'литр', 'литра', 'литров', 'liter', 'liters'] },
  { dimension: 'noise_db', multiplier: 1, aliases: ['дб', 'db'] },
  { dimension: 'speed_rpm', multiplier: 1, aliases: ['об/мин', 'об мин', 'rpm'] },
  { dimension: 'time_h', multiplier: 1, aliases: ['ч', 'час', 'часа', 'часов', 'h', 'hour', 'hours'] }
];

function canonicalUnitKey(value: unknown) {
  return String(value ?? '').normalize('NFKD').toLocaleLowerCase('ru-RU')
    .replaceAll('.', '')
    .replaceAll(' ', '')
    .replaceAll('\u00a0', '')
    .replaceAll('\u202f', '');
}

const unitByAlias = new Map<string, UnitDefinition>();
for (const definition of unitDefinitions) {
  for (const alias of definition.aliases) unitByAlias.set(canonicalUnitKey(alias), definition);
}

function normalizedNumber(raw: string) {
  const compact = raw
    .replaceAll(' ', '')
    .replaceAll('\u00a0', '')
    .replaceAll('\u202f', '')
    .replace(',', '.');
  const parsed = Number(compact);
  return Number.isFinite(parsed) ? parsed : null;
}

interface NumberSpan {
  raw: string;
  start: number;
  end: number;
}

function isAsciiDigit(value: string | undefined) {
  if (!value) return false;
  const code = value.codePointAt(0) ?? 0;
  return code >= 48 && code <= 57;
}

function isNumberSpacing(value: string | undefined) {
  return value === ' ' || value === '\t' || value === '\u00a0' || value === '\u202f';
}

function numberSpans(value: string) {
  const spans: NumberSpan[] = [];
  let index = 0;
  while (index < value.length) {
    if (!isAsciiDigit(value[index])) {
      index += 1;
      continue;
    }
    const start = index;
    let cursor = index;
    let decimalSeen = false;
    while (cursor < value.length) {
      if (isAsciiDigit(value[cursor])) {
        cursor += 1;
        continue;
      }
      if (isNumberSpacing(value[cursor])) {
        let next = cursor;
        while (isNumberSpacing(value[next])) next += 1;
        if (isAsciiDigit(value[next])) {
          cursor = next;
          continue;
        }
        break;
      }
      if (!decimalSeen && (value[cursor] === '.' || value[cursor] === ',') && isAsciiDigit(value[cursor + 1])) {
        decimalSeen = true;
        cursor += 1;
        continue;
      }
      break;
    }
    spans.push({ raw: value.slice(start, cursor), start, end: cursor });
    index = cursor;
  }
  return spans;
}

const sortedUnitAliases = unitDefinitions.flatMap((definition) =>
  definition.aliases.map((alias) => ({ definition, alias }))
).sort((left, right) => right.alias.length - left.alias.length);

function unitAfterNumber(value: string, numberEnd: number) {
  let start = numberEnd;
  while (isNumberSpacing(value[start])) start += 1;
  for (const candidate of sortedUnitAliases) {
    const raw = value.slice(start, start + candidate.alias.length);
    if (normalizeModelText(raw) !== normalizeModelText(candidate.alias)) continue;
    const next = normalizeModelText(value[start + candidate.alias.length] ?? '');
    if (tokenHasLetter(next)) continue;
    return {
      definition: candidate.definition,
      raw,
      end: start + candidate.alias.length
    };
  }
  return null;
}

const nominalPowerAbbreviations = new Set(['nom', 'ном'].map(compactModelText));

function powerQualifierToken(token: string): NumericQualifier | null {
  const compact = compactModelText(token);
  if (nominalPowerAbbreviations.has(compact)) return 'nominal';
  if (tokenStartsWithAny(token, ['номин', 'rated', 'nominal', 'continuous'])) return 'nominal';
  if (tokenStartsWithAny(token, ['макс', 'maximum', 'max', 'пиков', 'peak', 'surge', 'предель'])) return 'maximum';
  return null;
}

function powerQualifierAbbreviationBeforePeriod(value: string, periodIndex: number) {
  const tokens = modelTextTokens(value.slice(Math.max(0, periodIndex - 16), periodIndex));
  const token = tokens[tokens.length - 1];
  return token ? powerQualifierToken(token) !== null : false;
}

function powerQualifierFromAttribute(value: string) {
  const qualifiers = new Set(
    modelTextTokens(value)
      .map(powerQualifierToken)
      .filter((qualifier): qualifier is NumericQualifier => qualifier !== null)
  );
  return qualifiers.size === 1 ? [...qualifiers][0] : undefined;
}

function powerQualifierAroundClaim(value: string, start: number, end: number) {
  const prefixTokens = modelTextTokens(value.slice(Math.max(0, start - 80), start));
  for (let index = prefixTokens.length - 1; index >= 0; index -= 1) {
    const token = prefixTokens[index];
    const qualifier = powerQualifierToken(token);
    if (qualifier) return qualifier;
    if (tokenHasDigit(token)) break;
  }
  const suffixToken = modelTextTokens(value.slice(end, Math.min(value.length, end + 24)))[0];
  return suffixToken ? powerQualifierToken(suffixToken) ?? undefined : undefined;
}

function extractTypedNumericClaims(value: string) {
  const claims: NumericClaim[] = [];
  for (const span of numberSpans(value)) {
    const unit = unitAfterNumber(value, span.end);
    const numeric = normalizedNumber(span.raw);
    if (!unit || numeric === null) continue;
    claims.push({
      dimension: unit.definition.dimension,
      value: numeric * unit.definition.multiplier,
      ...(unit.definition.dimension === 'power_kw'
        ? { qualifier: powerQualifierAroundClaim(value, span.start, unit.end) }
        : {}),
      raw: value.slice(span.start, unit.end),
      start: span.start,
      end: unit.end
    });
  }
  return claims;
}

function isLetter(value: string | undefined) {
  return Boolean(value && tokenHasLetter(normalizeModelText(value)));
}

function extractBarePriceClaims(value: string, occupied: NumericClaim[]) {
  const claims: NumericClaim[] = [];
  for (const span of numberSpans(value)) {
    const start = span.start;
    const end = span.end;
    if (occupied.some((claim) => start < claim.end && end > claim.start)) continue;
    if (isLetter(value[start - 1]) || isLetter(value[end])) continue;
    const contextTokens = modelTextTokens(value.slice(Math.max(0, start - 28), start));
    const isPriceContext = contextTokens.some((token) =>
      ['price', 'cost', 'цена', 'ценой', 'цене', 'стоимость', 'стоит'].some((needle) =>
        token.startsWith(compactModelText(needle))
      )
    );
    const numeric = normalizedNumber(span.raw);
    if (!isPriceContext || numeric === null) continue;
    claims.push({ dimension: 'price_rub', value: numeric, raw: span.raw, start, end });
  }
  return claims;
}

function extractNumericClaims(value: string) {
  const typed = extractTypedNumericClaims(value);
  return [...typed, ...extractBarePriceClaims(value, typed)].sort((left, right) => left.start - right.start);
}

function scalarEntries(value: unknown, path = ''): Array<{ path: string; value: string }> {
  if (value === null || value === undefined) return [];
  if (typeof value === 'string' || typeof value === 'number') {
    return [{ path, value: String(value) }];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => scalarEntries(item, `${path}[${index}]`));
  }
  if (typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).flatMap(([key, item]) =>
      scalarEntries(item, path ? `${path}.${key}` : key)
    );
  }
  return [];
}

function unitDefinitionFromSpecPath(path: string) {
  const tokens = modelTextTokens(path);
  const compactPath = compactModelText(path);
  for (const candidate of sortedUnitAliases) {
    const aliasTokens = modelTextTokens(candidate.alias);
    if (containsSequence(tokens, aliasTokens)) return candidate.definition;
    const compactAlias = compactModelText(candidate.alias);
    if (compactAlias.length >= 2 && compactPath.endsWith(compactAlias)) return candidate.definition;
  }
  return null;
}

function numericFactsFromSpecEntry(entry: { path: string; value: string }) {
  const text = `${entry.path} ${entry.value}`;
  const qualifier = powerQualifierFromAttribute(entry.path);
  const typed = extractTypedNumericClaims(text).map(({ dimension, value, qualifier: claimQualifier }) => ({
    dimension,
    value,
    ...(dimension === 'power_kw' && (qualifier ?? claimQualifier)
      ? { qualifier: qualifier ?? claimQualifier }
      : {})
  }));
  const unit = unitDefinitionFromSpecPath(entry.path);
  const span = numberSpans(entry.value)[0];
  const numeric = span ? normalizedNumber(span.raw) : null;
  if (!unit || numeric === null) return typed;
  const pathUnitFact = {
    dimension: unit.dimension,
    value: numeric * unit.multiplier,
    ...(unit.dimension === 'power_kw' && qualifier ? { qualifier } : {})
  };
  if (!typed.some((fact) =>
    fact.dimension === pathUnitFact.dimension &&
    Math.abs(fact.value - pathUnitFact.value) < 1e-9 &&
    fact.qualifier === pathUnitFact.qualifier
  )) typed.push(pathUnitFact);
  return typed;
}

function productKey(product: Pick<Product, 'id' | 'name'>) {
  return product.id?.trim() || compactModelText(product.name);
}

function newProductEvidence(product: Product): ProductEvidence {
  const identifiers = new Set(modelIdentifierTokens([
    product.name,
    product.brand,
    product.externalId,
    product.slug,
    JSON.stringify(product.specs ?? {})
  ].filter(Boolean).join(' ')));
  const numericFacts: NumericFact[] = [];
  if (typeof product.price === 'number' && Number.isFinite(product.price)) {
    numericFacts.push({ dimension: 'price_rub', value: product.price });
  }
  for (const text of [product.name, product.description ?? '']) {
    numericFacts.push(...extractTypedNumericClaims(text).map(({ dimension, value, qualifier }) => ({
      dimension,
      value,
      ...(qualifier ? { qualifier } : {})
    })));
  }
  for (const entry of scalarEntries(product.specs ?? {})) {
    numericFacts.push(...numericFactsFromSpecEntry(entry));
  }
  const structuredAttributes = extractStructuredProductAttributes(product);
  for (const [attribute, dimension] of [
    ['powerKw', 'power_kw'],
    ['voltageV', 'voltage_v'],
    ['weightKg', 'mass_kg']
  ] as const) {
    const value = structuredAttributes[attribute]?.value;
    if (typeof value === 'number' && Number.isFinite(value)) {
      if (dimension === 'power_kw' && numericFacts.some((fact) => fact.dimension === dimension)) continue;
      numericFacts.push({ dimension, value });
    }
  }
  return {
    key: productKey(product),
    name: product.name,
    identifiers,
    numericFacts
  };
}

function isArtifactProduct(value: unknown): value is Product {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<Product>;
  return typeof candidate.id === 'string' &&
    typeof candidate.name === 'string' &&
    Boolean(candidate.specs && typeof candidate.specs === 'object' && !Array.isArray(candidate.specs));
}

function artifactProducts(toolResults: ToolResult[]) {
  return toolResults.flatMap((result) => {
    if (result.status !== 'ok') return [];
    const products = (result.payload as { products?: unknown }).products;
    return Array.isArray(products) ? products.filter(isArtifactProduct) : [];
  });
}

function addWebFactEvidence(evidence: ProductEvidence[], toolResults: ToolResult[]) {
  for (const result of toolResults) {
    if (result.status !== 'ok' || result.tool !== 'web.researchProductFacts') continue;
    const facts = (result.payload as { facts?: unknown }).facts;
    if (!Array.isArray(facts)) continue;
    for (const value of facts) {
      if (!value || typeof value !== 'object') continue;
      const fact = value as {
        productName?: unknown;
        attribute?: unknown;
        value?: unknown;
        confidence?: unknown;
        sourceType?: unknown;
      };
      if (
        typeof fact.productName !== 'string' ||
        typeof fact.value !== 'string' ||
        !['high', 'medium'].includes(String(fact.confidence)) ||
        fact.sourceType === 'conflict'
      ) continue;
      const target = evidence.find((item) => textMatchesTargetName(item.name, fact.productName as string)) ?? {
        key: `web:${compactModelText(fact.productName)}`,
        name: fact.productName,
        identifiers: new Set(modelIdentifierTokens(fact.productName)),
        numericFacts: []
      };
      if (!evidence.includes(target)) evidence.push(target);
      const factText = `${typeof fact.attribute === 'string' ? fact.attribute : ''} ${fact.value}`;
      target.numericFacts.push(...extractTypedNumericClaims(factText).map(({ dimension, value: numeric, qualifier }) => ({
        dimension,
        value: numeric,
        ...(qualifier ? { qualifier } : {})
      })));
    }
  }
}

function collectProductEvidence(input: ReviewerRewriteGuardInput) {
  const byKey = new Map<string, ProductEvidence>();
  for (const product of [...input.products, ...artifactProducts(input.toolResults)]) {
    const next = newProductEvidence(product);
    const existing = byKey.get(next.key);
    if (!existing) {
      byKey.set(next.key, next);
      continue;
    }
    next.identifiers.forEach((identifier) => existing.identifiers.add(identifier));
    existing.numericFacts.push(...next.numericFacts);
  }
  const evidence = [...byKey.values()];
  addWebFactEvidence(evidence, input.toolResults);
  return evidence;
}

function measurementIdentifierToken(value: string) {
  let splitAt = 0;
  while (splitAt < value.length && value[splitAt] >= '0' && value[splitAt] <= '9') splitAt += 1;
  if (splitAt === 0 || splitAt === value.length) return false;
  const unit = value.slice(splitAt);
  return unitByAlias.has(canonicalUnitKey(unit));
}

function splitSegments(value: string) {
  const segments: Array<{ text: string; start: number }> = [];
  const terminators = new Set(['.', '!', '?', '\n', '。', '！', '？']);
  let text = '';
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    text += value[index];
    if (!terminators.has(value[index])) continue;
    if (
      value[index] === '.' &&
      value[index - 1] >= '0' && value[index - 1] <= '9' &&
      value[index + 1] >= '0' && value[index + 1] <= '9'
    ) continue;
    if (value[index] === '.' && powerQualifierAbbreviationBeforePeriod(value, index)) continue;
    if (text.trim()) segments.push({ text, start });
    text = '';
    start = index + 1;
  }
  if (text.trim()) segments.push({ text, start });
  return segments;
}

function productMentionPositionBeforeClaim(segment: string, claimStart: number, product: ProductEvidence) {
  const prefix = normalizeModelText(segment.slice(0, claimStart));
  let position = -1;
  for (const identifier of product.identifiers) position = Math.max(position, prefix.lastIndexOf(identifier));
  if (position >= 0) return position;
  return textMatchesTargetName(prefix, product.name) ? 0 : -1;
}

function productsForClaim(segment: string, claim: NumericClaim, evidence: ProductEvidence[]) {
  const ranked = evidence
    .map((product) => ({ product, position: productMentionPositionBeforeClaim(segment, claim.start, product) }))
    .filter((item) => item.position >= 0)
    .sort((left, right) => right.position - left.position);
  if (ranked.length) return [ranked[0].product];
  const segmentIdentifiers = new Set(modelIdentifierTokens(segment));
  const mentioned = evidence.filter((product) =>
    [...product.identifiers].some((identifier) => segmentIdentifiers.has(identifier)) ||
    textMatchesTargetName(segment, product.name)
  );
  return mentioned;
}

function sameNumericFact(claim: NumericFact, fact: NumericFact) {
  if (claim.dimension !== fact.dimension) return false;
  if (claim.dimension === 'power_kw' && claim.qualifier && fact.qualifier !== claim.qualifier) {
    return false;
  }
  const tolerance = claim.dimension === 'price_rub'
    ? 0.5
    : Math.max(0.01, Math.abs(fact.value) * 0.001);
  return Math.abs(claim.value - fact.value) <= tolerance;
}

function hasExactStructuredNumericBinding(
  segment: string,
  claim: NumericClaim,
  bindings: ReviewerRewriteNumericClaimBinding[],
  userMessage: string
) {
  return bindings.some((binding) => {
    if (
      binding.semanticRole !== 'buyer_requirement_threshold' ||
      !binding.sourceId.trim() ||
      !sameNumericFact(claim, binding)
    ) return false;
    const sourceQuote = binding.verifiedSourceQuote.trim();
    if (
      !sourceQuote ||
      !userMessage.includes(sourceQuote) ||
      !modelTextTokens(sourceQuote).some(tokenHasLetter)
    ) return false;
    const sourceClaims = extractNumericClaims(sourceQuote);
    let quoteStart = segment.indexOf(sourceQuote);
    while (quoteStart >= 0) {
      const matchingSourceClaim = sourceClaims.some((sourceClaim) =>
        sameNumericFact(claim, sourceClaim) &&
        claim.start === quoteStart + sourceClaim.start &&
        claim.end === quoteStart + sourceClaim.end
      );
      if (matchingSourceClaim) return true;
      quoteStart = segment.indexOf(sourceQuote, quoteStart + 1);
    }
    return false;
  });
}

function unsupportedNumericClaims(
  text: string,
  evidence: ProductEvidence[],
  bindings: ReviewerRewriteNumericClaimBinding[],
  userMessage: string
) {
  const unsupported: Array<{ claim: NumericClaim; products: ProductEvidence[] }> = [];
  for (const segment of splitSegments(text)) {
    const claims = extractNumericClaims(segment.text);
    for (const claim of claims) {
      if (hasExactStructuredNumericBinding(segment.text, claim, bindings, userMessage)) continue;
      if (claim.dimension === 'percent' && !evidence.some((product) => product.numericFacts.some((fact) => sameNumericFact(claim, fact)))) {
        continue;
      }
      const products = productsForClaim(segment.text, claim, evidence);
      if (!products.length) continue;
      if (products.some((product) => product.numericFacts.some((fact) => sameNumericFact(claim, fact)))) continue;
      unsupported.push({ claim, products });
    }
  }
  return unsupported;
}

function containsSequence(tokens: string[], rawNeedle: string[]) {
  const needle = rawNeedle.map(compactModelText);
  if (!needle.length || needle.length > tokens.length) return false;
  for (let index = 0; index <= tokens.length - needle.length; index += 1) {
    if (needle.every((token, offset) => tokens[index + offset] === token)) return true;
  }
  return false;
}

function hasFalseLeadConfirmation(value: string) {
  const tokens = modelTextTokens(value);
  const sequences = [
    ['контакт', 'получен'],
    ['контакты', 'получены'],
    ['заявка', 'создана'],
    ['заявка', 'принята'],
    ['заявку', 'оформили'],
    ['запрос', 'передан'],
    ['вопрос', 'передан'],
    ['я', 'передал'],
    ['я', 'передаю'],
    ['мы', 'передали'],
    ['специалист', 'уже', 'уточняет'],
    ['contact', 'received'],
    ['request', 'has', 'been', 'passed'],
    ['request', 'was', 'sent'],
    ['lead', 'created']
  ];
  return sequences.some((sequence) => containsSequence(tokens, sequence));
}

function tokenStartsWithAny(token: string, needles: string[]) {
  return needles.some((needle) => token.startsWith(compactModelText(needle)));
}

function hasUncertaintyBefore(tokens: string[], sequence: string[]) {
  const needle = sequence.map(compactModelText);
  for (let index = 0; index <= tokens.length - needle.length; index += 1) {
    if (!needle.every((token, offset) => tokens[index + offset] === token)) continue;
    const prefix = tokens.slice(Math.max(0, index - 8), index);
    return prefix.some((token) => tokenStartsWithAny(token, [
      'уточн', 'провер', 'подтверд', 'нельзя', 'зависит', 'unknown', 'verify', 'confirm', 'cannot', 'can\'t'
    ]));
  }
  return false;
}

function forbiddenCommercialPromise(value: string) {
  const unsafeSequences: Array<{ topic: string; tokens: string[] }> = [
    { topic: 'stock', tokens: ['есть', 'в', 'наличии'] },
    { topic: 'stock', tokens: ['в', 'наличии', 'есть'] },
    { topic: 'stock', tokens: ['в', 'наличии'] },
    { topic: 'stock', tokens: ['есть', 'на', 'складе'] },
    { topic: 'stock', tokens: ['in', 'stock'] },
    { topic: 'delivery', tokens: ['доставка', 'будет'] },
    { topic: 'delivery', tokens: ['можем', 'доставить'] },
    { topic: 'delivery', tokens: ['доставим'] },
    { topic: 'delivery', tokens: ['привезем'] },
    { topic: 'discount', tokens: ['скидка', 'есть'] },
    { topic: 'discount', tokens: ['скидка', 'доступна'] },
    { topic: 'discount', tokens: ['дадим', 'скидку'] },
    { topic: 'discount', tokens: ['сделаем', 'скидку'] },
    { topic: 'discount', tokens: ['скидку', 'сделаем'] },
    { topic: 'discount', tokens: ['можем', 'дать', 'скидку'] },
    { topic: 'discount', tokens: ['discount', 'is', 'available'] },
    { topic: 'discount', tokens: ['we', 'can', 'offer', 'a', 'discount'] }
  ];
  const violations = new Set<string>();
  for (const segment of splitSegments(value)) {
    const tokens = modelTextTokens(segment.text);
    for (const sequence of unsafeSequences) {
      if (!containsSequence(tokens, sequence.tokens)) continue;
      if (hasUncertaintyBefore(tokens, sequence.tokens)) continue;
      violations.add(sequence.topic);
    }
    const commercialTopic = tokens.find((token) => tokenStartsWithAny(token, [
      'скидк', 'discount', 'доставк', 'delivery', 'налич', 'stock'
    ]));
    const commercialNumber = extractNumericClaims(segment.text).find((claim) =>
      claim.dimension === 'price_rub' || claim.dimension === 'percent' || claim.dimension === 'time_h'
    );
    const hasUncertainty = tokens.some((token) => tokenStartsWithAny(token, [
      'уточн', 'провер', 'подтверд', 'зависит', 'неизвест', 'verify', 'confirm', 'depend', 'unknown'
    ]));
    if (commercialTopic && commercialNumber && !hasUncertainty) violations.add('unsupported_commercial_number');
  }
  return [...violations];
}

function supportedIdentifierTokens(input: ReviewerRewriteGuardInput, evidence: ProductEvidence[]) {
  const supported = new Set(modelIdentifierTokens(input.userMessage));
  for (const product of evidence) product.identifiers.forEach((identifier) => supported.add(identifier));
  for (const result of input.toolResults) {
    if (result.status !== 'ok') continue;
    for (const identifier of modelIdentifierTokens(JSON.stringify(result.payload))) supported.add(identifier);
  }
  return supported;
}

export function revalidateReviewerRewrite(input: ReviewerRewriteGuardInput): PreSendReview['issues'] {
  const text = input.revisedAnswerText.trim();
  if (!text) {
    return [{
      code: 'review_rewrite_empty',
      severity: 'high',
      message: 'Reviewer rewrite is empty and cannot be sent.',
      evidence: 'revisedAnswerText'
    }];
  }
  const evidence = collectProductEvidence(input);
  const supportedIdentifiers = supportedIdentifierTokens(input, evidence);
  const unsupportedIdentifiers = modelIdentifierDisplayTokens(text).filter((identifier) => {
    const canonical = compactModelText(identifier);
    return !measurementIdentifierToken(identifier) &&
      tokenHasDigit(canonical) &&
      tokenHasLetter(canonical) &&
      !supportedIdentifiers.has(canonical);
  });
  const numericClaims = unsupportedNumericClaims(
    text,
    evidence,
    input.numericClaimBindings ?? [],
    input.userMessage
  );
  const commercialPromises = forbiddenCommercialPromise(text);
  const issues: PreSendReview['issues'] = [];
  if (unsupportedIdentifiers.length) {
    issues.push({
      code: 'review_rewrite_unsupported_product_identifier',
      severity: 'high',
      message: 'Reviewer rewrite introduced an identifier absent from current successful tool evidence.',
      evidence: [...new Set(unsupportedIdentifiers)].join(', ')
    });
  }
  if (numericClaims.length) {
    issues.push({
      code: 'review_rewrite_unsupported_numeric_product_claim',
      severity: 'high',
      message: 'Reviewer rewrite introduced a numeric price or specification claim that does not match current product evidence.',
      evidence: numericClaims
        .slice(0, 6)
        .map(({ claim, products }) => `${claim.raw}:${products.map((product) => product.name).join('|')}`)
        .join(', ')
    });
  }
  if (!input.durableLeadCaptureSucceeded && hasFalseLeadConfirmation(text)) {
    issues.push({
      code: 'review_rewrite_false_lead_confirmation',
      severity: 'high',
      message: 'Reviewer rewrite claims a lead or handoff succeeded without a durable local lead and outbox result.',
      evidence: 'lead.capture durable result absent'
    });
  }
  if (commercialPromises.length) {
    issues.push({
      code: 'review_rewrite_forbidden_commercial_promise',
      severity: 'high',
      message: 'Reviewer rewrite makes an unsupported stock, delivery, timing, or discount promise.',
      evidence: commercialPromises.join(', ')
    });
  }
  return issues;
}
