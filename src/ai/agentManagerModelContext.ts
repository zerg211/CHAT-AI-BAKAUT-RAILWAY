import { isDeepStrictEqual } from 'node:util';
import type { Product, VerifiedProductFact } from '../shared/types.js';
import type { ToolResult } from './agentManagerContracts.js';

const catalogTools = new Set<ToolResult['tool']>([
  'catalog.search',
  'catalog.getProductDetails'
]);

/**
 * Durable tool artifacts keep their full catalog payload. Model requests receive
 * exact product facts once via `products`, so duplicate product objects are
 * removed only from the model-facing copy of catalog tool results.
 */
export function compactToolResultsForModel(
  toolResults: ToolResult[],
  products: Product[]
): ToolResult[] {
  const allowedProductIds = new Set(products.map((product) => product.id));
  const productsById = new Map(products.map((product) => [product.id, product]));
  return toolResults.map((result) => {
    const payload = result.payload && typeof result.payload === 'object' && !Array.isArray(result.payload)
      ? result.payload as Record<string, unknown>
      : {};
    if (result.tool === 'web.researchProductFacts' && Array.isArray(payload.products)) {
      const sharedProductIds: string[] = [];
      const remainingProducts = payload.products.filter((product: unknown) => {
        if (!product || typeof product !== 'object' || !('id' in product) || typeof product.id !== 'string') return true;
        if (!isDeepStrictEqual(product, productsById.get(product.id))) return true;
        sharedProductIds.push(product.id);
        return false;
      });
      if (!sharedProductIds.length) return result;
      const { products: _sharedProducts, ...rest } = payload;
      return { ...result, payload: { ...rest,
        productIds: [...new Set([...(Array.isArray(payload.productIds) ? payload.productIds : []), ...sharedProductIds])],
        ...(remainingProducts.length ? { products: remainingProducts } : {})
      } };
    }
    if (!catalogTools.has(result.tool)) return result;
    const { products: _duplicateProducts, ...compactPayload } = payload;
    if (Array.isArray(payload.productIds)) {
      compactPayload.productIds = payload.productIds.filter((productId): productId is string =>
        typeof productId === 'string' && allowedProductIds.has(productId)
      );
    }
    return {
      ...result,
      payload: compactPayload
    };
  });
}

/** Semantic evidence remains complete; storage bookkeeping stays in durable facts. */
export function compactVerifiedFactsForModel(facts: VerifiedProductFact[]) {
  return facts.map(({ hitCount, createdAt, updatedAt, firstSeenAt, catalogSourceHash, sourceFingerprint, ...evidence }) => evidence);
}

/** Shortlist identity/order stays exact. Reading details is an explicit observer action. */
export function compactObserverCandidates(products: Product[], results: ToolResult[]) {
  const detailedIds = new Set(results.filter(result=>result.status==='ok' &&
    (result.tool==='catalog.getProductDetails' || result.tool==='web.researchProductFacts'))
    .flatMap(result=>[
      ...(Array.isArray(result.payload.productIds)?result.payload.productIds.filter((id):id is string=>typeof id==='string'):[]),
      ...(Array.isArray(result.payload.products)?result.payload.products.flatMap((product:unknown)=>
        product && typeof product==='object' && 'id' in product && typeof product.id==='string'?[product.id]:[]):[])
    ]));
  return products.map(product=>detailedIds.has(product.id)?product:{
    id:product.id,name:product.name,brand:product.brand,category:product.category,
    price:product.price,currency:product.currency,sourceUrl:product.sourceUrl,detailRequired:true
  });
}
