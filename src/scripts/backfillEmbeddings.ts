import { createEmbedding } from '../ai/openaiClient.js';
import { embeddingMetadataForText } from '../ai/embeddingUtils.js';
import { productToEmbeddingText } from '../catalog/normalize.js';
import { config } from '../config.js';
import { pool } from '../db/pool.js';
import { ProductRepository } from '../db/repositories.js';
import type { CatalogPage } from '../shared/types.js';

function numberArg(name: string, fallback: number) {
  const arg = process.argv.find((value) => value.startsWith(`${name}=`));
  if (!arg) return fallback;
  const value = Number(arg.split('=').slice(1).join('='));
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function pageToEmbeddingText(page: CatalogPage) {
  return [page.title, page.summary, page.content].filter(Boolean).join('\n').slice(0, 8000);
}

async function backfill() {
  const repository = new ProductRepository();
  const dryRun = process.argv.includes('--dry-run');
  const productsOnly = process.argv.includes('--products-only');
  const contentOnly = process.argv.includes('--content-only');
  const limit = numberArg('--limit', 100);
  const stats = {
    model: config.OPENAI_EMBEDDING_MODEL,
    dryRun,
    limit,
    products: { scanned: 0, planned: 0, updated: 0, skippedFresh: 0, failed: 0 },
    catalogPages: { scanned: 0, planned: 0, updated: 0, skippedFresh: 0, failed: 0 }
  };

  if (!contentOnly && limit > 0) {
    const candidates = await repository.listProductsNeedingEmbeddings(limit, config.OPENAI_EMBEDDING_MODEL);
    stats.products.scanned = candidates.length;
    for (const item of candidates) {
      const text = productToEmbeddingText(item.product);
      const metadata = embeddingMetadataForText(text);
      if (item.hasEmbedding && item.embeddingModel === metadata.model && item.embeddingSourceHash === metadata.sourceHash) {
        stats.products.skippedFresh += 1;
        if (!dryRun) await repository.touchProductEmbeddingMetadata(item.product.id, metadata);
        continue;
      }
      stats.products.planned += 1;
      if (dryRun) continue;
      try {
        const embedding = await createEmbedding(text);
        if (!embedding) {
          stats.products.failed += 1;
          continue;
        }
        await repository.updateProductEmbedding(item.product.id, embedding, metadata);
        stats.products.updated += 1;
      } catch {
        stats.products.failed += 1;
      }
    }
  }

  if (!productsOnly && limit > 0) {
    const candidates = await repository.listCatalogPagesNeedingEmbeddings(limit, config.OPENAI_EMBEDDING_MODEL);
    stats.catalogPages.scanned = candidates.length;
    for (const item of candidates) {
      const text = pageToEmbeddingText(item.page);
      const metadata = embeddingMetadataForText(text);
      if (item.hasEmbedding && item.embeddingModel === metadata.model && item.embeddingSourceHash === metadata.sourceHash) {
        stats.catalogPages.skippedFresh += 1;
        if (!dryRun) await repository.touchCatalogPageEmbeddingMetadata(item.page.id, metadata);
        continue;
      }
      stats.catalogPages.planned += 1;
      if (dryRun) continue;
      try {
        const embedding = await createEmbedding(text);
        if (!embedding) {
          stats.catalogPages.failed += 1;
          continue;
        }
        await repository.updateCatalogPageEmbedding(item.page.id, embedding, metadata);
        stats.catalogPages.updated += 1;
      } catch {
        stats.catalogPages.failed += 1;
      }
    }
  }

  return stats;
}

backfill()
  .then(async (stats) => {
    console.log(JSON.stringify(stats, null, 2));
    await pool.end();
  })
  .catch(async (error) => {
    console.error(error);
    await pool.end();
    process.exitCode = 1;
  });
