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

// Coverage and facts share the source validator, but are separate model output
// arrays. Only validator-marked confirmed coverage can enter the usual fact
// persistence path; that path still applies scope/conflict/authority guards.
export function researchFactMemoryCandidates(research: ProductComparisonResearchResult): ProductComparisonResearchFact[] {
  const candidates = [...research.facts];
  for (const coverage of research.answerGuidance.coverage) {
    if (coverage.status !== 'confirmed' || coverage.evidenceVerifiedExact !== true ||
      !coverage.productName?.trim() || !coverage.value.trim()) continue;
    const duplicate = candidates.some(fact => fact.productName === coverage.productName && fact.attribute === coverage.attribute &&
      fact.value === coverage.value && fact.sourceUrl === coverage.sourceUrl && fact.sourceType === 'web' &&
      fact.evidenceVerifiedExact === true && (fact.confidence === 'high' || fact.confidence === 'medium'));
    if (duplicate) continue;
    candidates.push({ productName: coverage.productName, attribute: coverage.attribute, value: coverage.value,
      sourceType: 'web', confidence: 'medium', evidence: coverage.evidence, sourceUrl: coverage.sourceUrl,
      sourceTitle: coverage.sourceTitle, sourceTier: coverage.sourceTier, sourceAuthority: coverage.sourceAuthority,
      evidenceVerifiedExact: true, targetApplicability: coverage.targetApplicability, scopeQuote: coverage.scopeQuote });
  }
  return candidates;
}
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

export function reusableVerifiedFact(fact: VerifiedProductFact, now: Date) {
  if (fact.status !== 'active') return false;
  if (fact.confidence !== 'high' && fact.confidence !== 'medium') return false;
  if ((fact.sourceType === 'web' || fact.sourceType === 'manual') && !isHttpSourceUrl(fact.sourceUrl)) return false;
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

export function verifiedFactCoverageForRequest(input: {
  facts: VerifiedProductFact[];
  targetProductNames?: string[];
  comparisonAttributes: string[];
  requestedFactSlots?: Array<{ productName: string; attribute: string }>;
}) {
  const requestedFactSlots = input.requestedFactSlots ?? (input.targetProductNames ?? []).flatMap((productName) =>
    input.comparisonAttributes.map((attribute) => ({ productName, attribute }))
  );
  if (!input.facts.length) {
    return {
      coveredAttributes: [] as string[],
      missingAttributes: [...input.comparisonAttributes],
      missingFactSlots: requestedFactSlots
    };
  }
  const meaningfulAttributes = input.comparisonAttributes
    .filter((attribute) => verifiedFactAttributeTokens(attribute).length > 0);
  if (!meaningfulAttributes.length) {
    return {
      coveredAttributes: [] as string[],
      missingAttributes: [...input.comparisonAttributes],
      missingFactSlots: requestedFactSlots
    };
  }
  const attributeCovered = (attribute: string) => {
    const matchingFacts = input.facts.filter((fact) => verifiedFactMatchesAttribute(fact, attribute));
    if (!matchingFacts.length) return false;
    const targetNames = input.targetProductNames?.filter(Boolean) ?? [];
    const factGroups = targetNames.length
      ? targetNames.map((targetName) => matchingFacts.filter((fact) => textMatchesTargetName(fact.productName, targetName)))
      : [...matchingFacts.reduce((groups, fact) => {
          const productKey = fact.productId ?? fact.productKey ?? compactModelText(fact.productName);
          const group = groups.get(productKey) ?? [];
          group.push(fact);
          groups.set(productKey, group);
          return groups;
        }, new Map<string, VerifiedProductFact[]>()).values()];
    return factGroups.length > 0 && factGroups.every((facts) => {
      if (!facts.length) return false;
      const values = new Set(facts.map((fact) => compactModelText(fact.value)));
      return values.size === 1;
    });
  };
  const coveredAttributes = meaningfulAttributes.filter(attributeCovered);
  const missingFactSlots = requestedFactSlots.flatMap(({ productName, attribute }) => {
    const facts = input.facts.filter((fact) =>
      textMatchesTargetName(fact.productName, productName) && verifiedFactMatchesAttribute(fact, attribute)
    );
    const values = new Set(facts.map((fact) => compactModelText(fact.value)));
    return values.size === 1 ? [] : [{ productName, attribute }];
  });
  const missingSlotKeys = new Set(missingFactSlots.map((slot) =>
    `${compactModelText(slot.productName)}|${compactModelText(slot.attribute)}`
  ));
  const coveredAttributesFromSlots = meaningfulAttributes.filter((attribute) => {
    const slots = requestedFactSlots.filter((slot) => compactModelText(slot.attribute) === compactModelText(attribute));
    return slots.length > 0 && slots.every((slot) => !missingSlotKeys.has(
      `${compactModelText(slot.productName)}|${compactModelText(slot.attribute)}`
    ));
  });
  return {
    coveredAttributes: requestedFactSlots.length ? coveredAttributesFromSlots : coveredAttributes,
    missingAttributes: input.comparisonAttributes.filter((attribute) =>
      !(requestedFactSlots.length ? coveredAttributesFromSlots : coveredAttributes).includes(attribute)
    ),
    missingFactSlots
  };
}

export function verifiedFactsCoverRequest(input: {
  facts: VerifiedProductFact[];
  targetProductNames?: string[];
  comparisonAttributes: string[];
  requestedFactSlots?: Array<{ productName: string; attribute: string }>;
}) {
  const coverage = verifiedFactCoverageForRequest(input);
  return input.comparisonAttributes.length > 0 &&
    coverage.missingAttributes.length === 0 &&
    coverage.missingFactSlots.length === 0;
}

export function verifiedFactsResearchResult(
  facts: VerifiedProductFact[],
  options: { attributesCovered?: boolean } = {}
): ProductComparisonResearchResult {
  const researchFacts: ProductComparisonResearchFact[] = facts.map((fact) => ({
    productName: fact.productName,
    attribute: fact.attribute,
    value: fact.value,
    sourceType: 'web',
    confidence: fact.confidence,
    evidence: fact.evidence ?? [fact.sourceTitle, fact.sourceUrl].filter(Boolean).join(' '),
    sourceUrl: fact.sourceUrl ?? undefined,
    sourceTitle: fact.sourceTitle ?? undefined,
    sourceTier: fact.sourceTier ?? undefined,
    sourceAuthority: fact.sourceAuthority ?? undefined
  }));
  const attributesCovered = options.attributesCovered !== false;
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
        productName: fact.productName,
        attribute: fact.attribute,
        status: 'confirmed',
        value: fact.value,
        evidence: fact.evidence ?? [fact.sourceTitle, fact.sourceUrl].filter(Boolean).join(' '),
        sourceUrl: fact.sourceUrl ?? undefined,
        sourceTitle: fact.sourceTitle ?? undefined,
        sourceTier: fact.sourceTier ?? undefined,
        sourceAuthority: fact.sourceAuthority ?? undefined
      }))
    },
    summaryForAnswer: attributesCovered
      ? 'Verified local product fact memory found source-backed exact-model facts. Use payload.facts and answer in simple buyer-facing words without copying raw attribute labels.'
      : 'Verified local product fact memory has source-backed facts for this model, but they may not cover every requested attribute. Answer only what payload.facts confirm; for any requested attribute absent from the facts, say honestly that it is not confirmed yet instead of guessing.',
    warnings: attributesCovered
      ? ['verified_product_fact_memory_used', 'web_search_skipped_verified_fact_memory']
      : ['verified_product_fact_memory_used', 'verified_fact_memory_partial_attribute_coverage']
  };
}

export function researchFactConfidenceNumber(confidence: ProductComparisonResearchFact['confidence']) {
  if (confidence === 'high') return 0.9;
  if (confidence === 'medium') return 0.8;
  return 0.55;
}
