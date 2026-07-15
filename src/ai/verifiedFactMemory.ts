import type { VerifiedProductFact } from '../shared/types.js';
import type {
  ProductComparisonResearchFact,
  ProductComparisonResearchResult
} from './productComparisonResearch.js';
import { compactModelText, modelTextTokens, textMatchesTargetName } from './modelTextMatching.js';

const genericAttributeTokens = new Set([
  'current',
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

function uniqueStrings(values: string[]) {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

export function verifiedFactAttributeTokens(value: unknown) {
  return uniqueStrings(modelTextTokens(value)
    .map(compactModelText)
    .filter((token) => token.length >= 3 && !genericAttributeTokens.has(token)));
}

function tokensOverlap(left: string[], right: string[]) {
  return left.some((leftToken) =>
    right.some((rightToken) => {
      if (leftToken === rightToken) return true;
      const smaller = leftToken.length <= rightToken.length ? leftToken : rightToken;
      const larger = leftToken.length <= rightToken.length ? rightToken : leftToken;
      return smaller.length >= 4 && larger.startsWith(smaller);
    })
  );
}

export function verifiedFactMatchesAttribute(fact: VerifiedProductFact, attribute: string) {
  const requestedTokens = verifiedFactAttributeTokens(attribute);
  if (!requestedTokens.length) return true;
  const factTokens = verifiedFactAttributeTokens([fact.attribute, fact.value].join(' '));
  return factTokens.length > 0 && tokensOverlap(factTokens, requestedTokens);
}

export function matchingVerifiedFactsForRequest(input: {
  facts: VerifiedProductFact[];
  targetProductNames: string[];
  comparisonAttributes: string[];
}) {
  const targetScopedFacts = input.targetProductNames.length
    ? input.facts.filter((fact) =>
        input.targetProductNames.some((targetName) => textMatchesTargetName(fact.productName, targetName))
      )
    : input.facts;
  const meaningfulAttributes = input.comparisonAttributes
    .filter((attribute) => verifiedFactAttributeTokens(attribute).length > 0);
  if (!meaningfulAttributes.length) return targetScopedFacts;
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
  if (!meaningfulAttributes.length) return true;
  return meaningfulAttributes.every((attribute) =>
    input.facts.some((fact) => verifiedFactMatchesAttribute(fact, attribute))
  );
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
