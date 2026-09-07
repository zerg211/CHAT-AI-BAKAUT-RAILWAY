import type { Product } from '../shared/types.js';
import { sitePriceErrorCode, type VerifiedSitePrice } from './currentSitePrice.js';

/** A budget comparison must use the company page price, not an unverified import. */
export async function verifyBudgetPrices(input: {
  products: Product[];
  read: (product: Product, signal?: AbortSignal) => Promise<VerifiedSitePrice>;
  persist: (price: VerifiedSitePrice) => Promise<Product | null>;
  signal?: AbortSignal;
}) {
  const results = await Promise.all(input.products.map(async product => {
    try {
      const proof = await input.read(product, input.signal);
      const updated = await input.persist(proof);
      if (!updated) throw new Error('site_price_persistence_conflict');
      return { product: updated, proof: { productId:proof.productId, previousPrice:proof.previousPrice,
        price:proof.price, currency:proof.currency, sourceUrl:proof.sourceUrl, observedAt:proof.observedAt,
        evidence:proof.evidence, status: 'verified' as const } };
    } catch(error) {
      // Keep the technical candidate; lack of a verified price is not incompatibility.
      return { product: { ...product, price: null }, proof: {
        productId: product.id, previousPrice: product.price ?? null,
        status: 'unavailable' as const, errorCode: sitePriceErrorCode(error)
      } };
    }
  }));
  return { products: results.map(result => result.product), proofs: results.map(result => result.proof) };
}
