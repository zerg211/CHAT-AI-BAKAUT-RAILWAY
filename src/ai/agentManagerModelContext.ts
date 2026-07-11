import type { Product } from '../shared/types.js';
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
  return toolResults.map((result) => {
    if (!catalogTools.has(result.tool)) return result;
    const payload = result.payload && typeof result.payload === 'object' && !Array.isArray(result.payload)
      ? result.payload as Record<string, unknown>
      : {};
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
