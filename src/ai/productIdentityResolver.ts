/**
 * Single ownership point for product identity resolution (F03/F12/F13).
 *
 * Resolution order is fixed and deterministic:
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

export async function resolveProductIdentity(
  repo: ExactProductLookup,
  input: EvidenceInput
): Promise<IdentityResolution> {
  const attemptedSelectors: string[] = [];
  const unmatchedFirstPartyUrls: string[] = [];
  const fingerprint = evidenceFingerprint(input);
  const strength = evidenceStrength(input);

  for (const id of input.identifiers) {
    if (id.kind === 'catalog_id') {
      const selector = 'exact_external_id:' + id.normalized;
      attemptedSelectors.push(selector);
      const product = await repo.getProductByExactExternalId(id.normalized);
      if (product && productIdOf(product)) {
        return { resolved: { product, confidence: 'exact', selector }, unmatchedFirstPartyUrls, ephemeral: null, evidenceFingerprint: fingerprint, strength, attemptedSelectors };
      }
    }
  }

  for (const id of input.identifiers) {
    if (id.kind === 'numeric_article') {
      const selector = 'exact_article:' + id.normalized;
      attemptedSelectors.push(selector);
      const product = await repo.getProductByExactArticle(id.normalized);
      if (product && productIdOf(product)) {
        return { resolved: { product, confidence: 'exact', selector }, unmatchedFirstPartyUrls, ephemeral: null, evidenceFingerprint: fingerprint, strength, attemptedSelectors };
      }
    }
  }

  for (const url of input.urls) {
    if (!url.firstParty) continue;
    const selector = 'exact_source_url:' + url.canonical;
    attemptedSelectors.push(selector);
    const product = await repo.getProductBySourceUrl(url.canonical);
    if (product && productIdOf(product)) {
      return { resolved: { product, confidence: 'exact', selector }, unmatchedFirstPartyUrls, ephemeral: null, evidenceFingerprint: fingerprint, strength, attemptedSelectors };
    }
    unmatchedFirstPartyUrls.push(url.canonical);
  }

  if (repo.findProductsByNormalizedModel) {
    for (const id of input.identifiers) {
      if (id.kind !== 'model_code') continue;
      const selector = 'normalized_model:' + id.normalized;
      attemptedSelectors.push(selector);
      const candidates = await repo.findProductsByNormalizedModel(id.normalized);
      const valid = candidates.filter((candidate) => productIdOf(candidate));
      if (valid.length === 1) {
        return { resolved: { product: valid[0]!, confidence: 'strong', selector }, unmatchedFirstPartyUrls, ephemeral: null, evidenceFingerprint: fingerprint, strength, attemptedSelectors };
      }
      if (valid.length > 1) {
        return { resolved: { product: valid[0]!, confidence: 'ambiguous', selector }, unmatchedFirstPartyUrls, ephemeral: null, evidenceFingerprint: fingerprint, strength, attemptedSelectors };
      }
    }
  }

  return { resolved: null, unmatchedFirstPartyUrls, ephemeral: null, evidenceFingerprint: fingerprint, strength, attemptedSelectors };
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
