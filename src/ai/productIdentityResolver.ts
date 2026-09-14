/**
 * Single ownership point for product identity resolution (F03/F12/F13).
 *
 * Selectors are checked deterministically; conflicting rows are never first-row truth:
 *   1. internal catalog id (`bakaut:<slug>` external id);
 *   2. exact SKU / numeric article (`specs.артикул`);
 *   3. canonical first-party URL / slug (`source_url`);
 *   4. normalized model code (via injected model lookup, no embeddings);
 *   5. text / semantic search (owned elsewhere; reported as attempted, not resolved here).
 *
 * A lookup miss is recorded in `attemptedSelectors` and never means product absence.
 * SKU/URL selectors never use embeddings (F12). A verified first-party page whose
 * product is absent from the local DB yields an ephemeral page identity (F13) that
 * can ground a customer answer without requiring full catalog ingestion.
 */
import { evidenceFingerprint, evidenceStrength, type EvidenceInput } from './evidenceInput.js';
import type { Product } from '../shared/types.js';

export type IdentityConfidence = 'exact' | 'strong' | 'preliminary' | 'ambiguous';

export interface ExactProductLookup {
  getProductByExactExternalId(externalId: string): Promise<Product | null>;
  getProductByExactArticle(article: string): Promise<Product | null>;
  getProductsByExactArticle?(article: string, namespace?: string): Promise<Product[]>;
  getProductBySourceUrl(sourceUrl: string): Promise<Product | null>;
  /** Model-code candidates (LIKE retrieval + exact in-memory match), no embeddings. */
  findProductsByNormalizedModel?(normalizedModel: string): Promise<Product[]>;
}

export interface ResolvedProductIdentity {
  product: Product;
  confidence: IdentityConfidence;
  /** Auditable selector, e.g. `exact_article:1110511`. */
  selector: string;
}

export interface EphemeralPageIdentity {
  canonicalUrl: string;
  status: 'page_read_pending' | 'page_verified';
  title?: string;
  article?: string;
  model?: string;
}

export interface IdentityResolution {
  resolved: ResolvedProductIdentity | null;
  candidates: Product[];
  selectorMatches: Array<{ selector: string; productIds: string[] }>;
  /** First-party URLs with no DB match yet (page read can still verify them). */
  unmatchedFirstPartyUrls: string[];
  ephemeral: EphemeralPageIdentity | null;
  evidenceFingerprint: string;
  strength: number;
  attemptedSelectors: string[];
}

function productIdOf(product: Product): string {
  return String((product as { id?: unknown }).id ?? '');
}

export async function articleCandidates(repo: Pick<ExactProductLookup, 'getProductByExactArticle' | 'getProductsByExactArticle'>,
  article: string, namespace?: string): Promise<Product[]> {
  const candidates = repo.getProductsByExactArticle
    ? await repo.getProductsByExactArticle(article, namespace)
    : namespace ? [] : [await repo.getProductByExactArticle(article)].filter((p): p is Product => p !== null);
  return [...new Map(candidates.filter(p => productIdOf(p)).map(p => [p.id, p])).values()];
}

export async function resolveProductIdentity(repo: ExactProductLookup, input: EvidenceInput,
  options: { sameSubject?: boolean } = {}): Promise<IdentityResolution> {
  const attemptedSelectors: string[] = [];
  const unmatchedFirstPartyUrls: string[] = [];
  const matches: Array<{ selector: string; products: Product[]; confidence: 'exact' | 'strong' }> = [];
  const add = (selector: string, products: Product[], confidence: 'exact' | 'strong' = 'exact') => {
    attemptedSelectors.push(selector);
    matches.push({ selector, products: [...new Map(products.filter(p => productIdOf(p)).map(p => [p.id,p])).values()], confidence });
  };
  for (const id of input.identifiers.filter(id => id.kind === 'catalog_id')) {
    const product = await repo.getProductByExactExternalId(id.normalized);
    add('exact_external_id:' + id.normalized, product ? [product] : []);
  }
  for (const id of input.identifiers.filter(id => id.kind === 'numeric_article')) {
    add('exact_article:' + id.normalized, await articleCandidates(repo,id.normalized));
  }
  for (const url of input.urls.filter(url => url.firstParty)) {
    const product = await repo.getProductBySourceUrl(url.canonical);
    add('exact_source_url:' + url.canonical, product ? [product] : []);
    if (!product) unmatchedFirstPartyUrls.push(url.canonical);
  }
  // A model selector can expose a genuine disagreement with a SKU. Do not skip
  // it just because an earlier selector produced one row.
  if (repo.findProductsByNormalizedModel) {
    for (const id of input.identifiers.filter(id => id.kind === 'model_code')) {
      add('normalized_model:' + id.normalized, await repo.findProductsByNormalizedModel(id.normalized), 'strong');
    }
  }
  const found = matches.filter(match => match.products.length);
  const candidates = [...new Map(found.flatMap(match => match.products).map(p => [p.id,p])).values()];
  const eligible = options.sameSubject && found.length
    ? candidates.filter(p => found.every(match => match.products.some(candidate => candidate.id === p.id)))
    : candidates;
  const unique = eligible.length === 1 ? eligible[0]! : undefined;
  const binding = unique ? found.find(match => match.products.some(p => p.id === unique.id)) : undefined;
  return {
    resolved: unique && binding ? { product: unique, confidence: binding.confidence, selector: binding.selector } : null,
    candidates, selectorMatches: matches.map(match => ({ selector: match.selector, productIds: match.products.map(p => p.id) })),
    unmatchedFirstPartyUrls, ephemeral: null, evidenceFingerprint: evidenceFingerprint(input),
    strength: evidenceStrength(input), attemptedSelectors
  };
}

/**
 * Binds a verified first-party page read to an ephemeral identity (F13).
 * Allowed only when the page was actually read (`page_verified`) — never from
 * search snippets or model guesses.
 */
export function bindEphemeralPageIdentity(input: {
  canonicalUrl: string;
  pageVerified: boolean;
  title?: string;
  article?: string;
  model?: string;
}): EphemeralPageIdentity | null {
  if (!input.pageVerified || !input.canonicalUrl) return null;
  return {
    canonicalUrl: input.canonicalUrl,
    status: 'page_verified',
    ...(input.title ? { title: input.title } : {}),
    ...(input.article ? { article: input.article } : {}),
    ...(input.model ? { model: input.model } : {})
  };
}
