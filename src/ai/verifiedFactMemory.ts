import type { VerifiedProductFact } from '../shared/types.js';
import type {
  ProductComparisonResearchFact,
  ProductComparisonResearchResult
} from './productComparisonResearch.js';
import { compactModelText, modelTextTokens, textMatchesTargetName } from './modelTextMatching.js';

const genericAttributeTokens = new Set([
  'buyer',
  'question',
  'requested',
  'attribute',
  'technical',
  'fact',
  'facts',
  'model',
  'product'
]);

const verifiedFactMemoryTtlMs = 90 * 24 * 60 * 60 * 1_000;
const futureClockSkewMs = 5 * 60 * 1_000;
const powerQualifierPrefixes = {
  nominal: ['nominal', 'rated', 'continuous', 'номин', 'ном'],
  maximum: ['maximum', 'max', 'peak', 'surge', 'максим', 'пиков'],
  engine: ['engine', 'motor', 'двигат'],
  apparent: ['apparent', 'kva', 'полна']
} as const;

function uniqueStrings(values: string[]) {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

export function verifiedFactAttributeTokens(value: unknown) {
  return uniqueStrings(modelTextTokens(value)
    .map(compactModelText)
    .filter((token) => token.length >= 3 && !genericAttributeTokens.has(token)));
}

function attributeTokenMatches(leftToken: string, rightToken: string) {
  if (leftToken === rightToken) return true;
  const smaller = leftToken.length <= rightToken.length ? leftToken : rightToken;
  const larger = leftToken.length <= rightToken.length ? rightToken : leftToken;
  return smaller.length >= 4 && larger.startsWith(smaller);
}

function factTokensCoverRequestedAttribute(factTokens: string[], requestedTokens: string[]) {
  return requestedTokens.every((requestedToken) =>
    factTokens.some((factToken) => attributeTokenMatches(factToken, requestedToken))
  );
}

type PowerQualifier = keyof typeof powerQualifierPrefixes;

function powerQualifiers(tokens: string[]) {
  return new Set<PowerQualifier>((Object.entries(powerQualifierPrefixes) as Array<[
    PowerQualifier,
    readonly string[]
  ]>).flatMap(([qualifier, prefixes]) =>
    tokens.some((token) => prefixes.some((prefix) => token.startsWith(prefix))) ? [qualifier] : []
  ));
}

function isHttpSourceUrl(value: string | null | undefined) {
  if (!value) return false;
  try {
    const protocol = new URL(value).protocol;
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

function reusableVerifiedFact(fact: VerifiedProductFact, now: Date) {
  if (fact.status !== 'active') return false;
  if (fact.confidence !== 'high' && fact.confidence !== 'medium') return false;
  if (fact.sourceType === 'web' && !isHttpSourceUrl(fact.sourceUrl)) return false;
  const verifiedAt = Date.parse(fact.lastVerifiedAt);
  if (!Number.isFinite(verifiedAt)) return false;
  const ageMs = now.getTime() - verifiedAt;
  return ageMs >= -futureClockSkewMs && ageMs <= verifiedFactMemoryTtlMs;
}

export function verifiedFactMatchesAttribute(fact: VerifiedProductFact, attribute: string) {
  const requestedTokens = verifiedFactAttributeTokens(attribute);
  if (!requestedTokens.length) return false;
  const factTokens = verifiedFactAttributeTokens([fact.attribute, fact.value].join(' '));
  const requestedPowerQualifiers = powerQualifiers(requestedTokens);
  if (requestedPowerQualifiers.size) {
    const factPowerQualifiers = powerQualifiers(factTokens);
    if (![...requestedPowerQualifiers].some((qualifier) => factPowerQualifiers.has(qualifier))) return false;
  }
  return factTokens.length > 0 && factTokensCoverRequestedAttribute(factTokens, requestedTokens);
}

export function matchingVerifiedFactsForRequest(input: {
  facts: VerifiedProductFact[];
  targetProductNames: string[];
  comparisonAttributes: string[];
  now?: Date;
}) {
  const reusableFacts = input.facts.filter((fact) => reusableVerifiedFact(fact, input.now ?? new Date()));
  const targetScopedFacts = input.targetProductNames.length
    ? reusableFacts.filter((fact) =>
        input.targetProductNames.some((targetName) => textMatchesTargetName(fact.productName, targetName))
      )
    : reusableFacts;
  const meaningfulAttributes = input.comparisonAttributes
    .filter((attribute) => verifiedFactAttributeTokens(attribute).length > 0);
  if (!meaningfulAttributes.length) return [];
  return targetScopedFacts.filter((fact) =>
    meaningfulAttributes.some((attribute) => verifiedFactMatchesAttribute(fact, attribute))
  );
}

export function verifiedFactsCoverRequest(input: {
  facts: VerifiedProductFact[];
  comparisonAttributes: string[];
}) {
  if (!input.facts.length) return false;
  const meaningfulAttributes = input.comparisonAttributes
    .filter((attribute) => verifiedFactAttributeTokens(attribute).length > 0);
  if (!meaningfulAttributes.length) return false;
  return meaningfulAttributes.every((attribute) => {
    const matchingFacts = input.facts.filter((fact) => verifiedFactMatchesAttribute(fact, attribute));
    if (!matchingFacts.length) return false;
    const valuesByProduct = new Map<string, Set<string>>();
    for (const fact of matchingFacts) {
      const productKey = fact.productId ?? fact.productKey ?? compactModelText(fact.productName);
      const values = valuesByProduct.get(productKey) ?? new Set<string>();
      values.add(compactModelText(fact.value));
      valuesByProduct.set(productKey, values);
    }
    return [...valuesByProduct.values()].every((values) => values.size === 1);
  });
}

export function verifiedFactsResearchResult(facts: VerifiedProductFact[]): ProductComparisonResearchResult {
  const researchFacts: ProductComparisonResearchFact[] = facts.map((fact) => ({
    productName: fact.productName,
    attribute: fact.attribute,
    value: fact.value,
    sourceType: 'web',
    confidence: fact.confidence,
    evidence: fact.evidence ?? [fact.sourceTitle, fact.sourceUrl].filter(Boolean).join(' '),
    sourceUrl: fact.sourceUrl ?? undefined,
    sourceTitle: fact.sourceTitle ?? undefined
  }));
  return {
    usedWebSearch: false,
    searchDisposition: 'memory_hit',
    sourcesExhausted: false,
    facts: researchFacts,
    conflicts: [],
    answerGuidance: {
      directAnswer: '',
      completeness: 'answered',
      coverage: facts.map((fact) => ({
        attribute: fact.attribute,
        status: 'confirmed',
        value: fact.value,
        evidence: fact.evidence ?? [fact.sourceTitle, fact.sourceUrl].filter(Boolean).join(' '),
        sourceUrl: fact.sourceUrl ?? undefined,
        sourceTitle: fact.sourceTitle ?? undefined
      }))
    },
    summaryForAnswer: 'Verified local product fact memory found source-backed exact-model facts. Use payload.facts and answer in simple buyer-facing words without copying raw attribute labels.',
    warnings: ['verified_product_fact_memory_used', 'web_search_skipped_verified_fact_memory']
  };
}

export function researchFactConfidenceNumber(confidence: ProductComparisonResearchFact['confidence']) {
  if (confidence === 'high') return 0.9;
  if (confidence === 'medium') return 0.8;
  return 0.55;
}
