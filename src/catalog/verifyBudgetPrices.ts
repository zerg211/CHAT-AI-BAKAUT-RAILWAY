import type { Product } from '../shared/types.js';
import { sitePriceErrorCode, type VerifiedSitePrice } from './currentSitePrice.js';

const DEFAULT_MAX_CONCURRENCY = 3;
const DEFAULT_MAX_FAILURES = 3;

type PriceVerification = {
  product: Product;
  proof: {
    productId: string;
    previousPrice: number | null;
    price?: number;
    currency?: 'RUB';
    sourceUrl?: string;
    observedAt?: string;
    evidence?: string;
    status: 'verified' | 'unavailable';
    errorCode?: string;
  };
};

function limit(value: number | undefined, fallback: number) {
  return Number.isFinite(value) && (value ?? 0) > 0
    ? Math.max(1, Math.floor(value as number))
    : fallback;
}

function unavailable(product: Product, errorCode: string, preservePrice: boolean): PriceVerification {
  return {
    product: { ...product, price: preservePrice ? product.price : null },
    proof: {
      productId: product.id,
      previousPrice: product.price ?? null,
      status: 'unavailable',
      errorCode
    }
  };
}

/** A budget comparison must use the company page price, not an unverified import. */
export async function verifyBudgetPrices(input: {
  products: Product[];
  read: (product: Product, signal?: AbortSignal) => Promise<VerifiedSitePrice>;
  persist: (price: VerifiedSitePrice) => Promise<Product | null>;
  signal?: AbortSignal;
  maxConcurrency?: number;
  maxFailures?: number;
  maxProducts?: number;
  preservePriceOnFailure?: boolean;
  onFailure?: (product: Product, errorCode: string, stage: 'read_page' | 'persist_price') => void | Promise<void>;
}) {
  const maxConcurrency = limit(input.maxConcurrency, DEFAULT_MAX_CONCURRENCY);
  const maxFailures = limit(input.maxFailures, DEFAULT_MAX_FAILURES);
  const uniqueProducts = [...new Map(input.products.map(product => [product.id, product])).values()];
  const results: Array<PriceVerification | undefined> = new Array(uniqueProducts.length);
  const verificationLimit = Math.min(uniqueProducts.length, limit(input.maxProducts, uniqueProducts.length));
  for (let index = verificationLimit; index < uniqueProducts.length; index += 1) {
    results[index] = unavailable(uniqueProducts[index]!, 'site_price_verification_deferred', input.preservePriceOnFailure === true);
  }
  let nextIndex = 0;
  let failureCount = 0;
  let circuitOpen = false;

  const worker = async () => {
    while (true) {
      const index = nextIndex++;
      if (index >= verificationLimit) return;
      const product = uniqueProducts[index]!;
      if (circuitOpen) {
        results[index] = unavailable(product, 'site_price_circuit_open', input.preservePriceOnFailure === true);
        continue;
      }
      let stage: 'read_page' | 'persist_price' = 'read_page';
      try {
        const proof = await input.read(product, input.signal);
        stage = 'persist_price';
        const updated = await input.persist(proof);
        if (!updated) throw new Error('site_price_persistence_conflict');
        results[index] = {
          product: updated,
          proof: {
            productId: proof.productId,
            previousPrice: proof.previousPrice,
            price: proof.price,
            currency: proof.currency,
            sourceUrl: proof.sourceUrl,
            observedAt: proof.observedAt,
            evidence: proof.evidence,
            status: 'verified'
          }
        };
      } catch (error) {
        failureCount += 1;
        if (failureCount >= maxFailures) circuitOpen = true;
        // Keep the technical candidate; lack of a verified price is not incompatibility.
        const errorCode = sitePriceErrorCode(error);
        results[index] = unavailable(product, errorCode, input.preservePriceOnFailure === true);
        try {
          await input.onFailure?.(product, errorCode, stage);
        } catch (traceError) {
          console.warn('Site price verification failure trace failed', traceError);
        }
      }
    }
  };

  if (uniqueProducts.length > 0) {
    const workerCount = Math.min(maxConcurrency, uniqueProducts.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
  }

  const byProductId = new Map(uniqueProducts.map((product, index) => [product.id, results[index]!]));
  return {
    products: input.products.map(product => byProductId.get(product.id)!.product),
    proofs: input.products.map(product => byProductId.get(product.id)!.proof)
  };
}
