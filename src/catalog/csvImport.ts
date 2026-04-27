import fs from 'node:fs';
import { parse } from 'csv-parse';
import { ProductRepository } from '../db/repositories.js';
import { createEmbedding } from '../ai/openaiClient.js';
import type { CatalogProductInput } from '../shared/types.js';
import { normalizeCsvHeader, parsePrice, productToEmbeddingText } from './normalize.js';

const knownColumns = new Set([
  'id',
  'external_id',
  'артикул',
  'sku',
  'url',
  'source_url',
  'name',
  'название',
  'brand',
  'бренд',
  'category',
  'категория',
  'price',
  'цена',
  'currency',
  'валюта',
  'image_url',
  'image',
  'картинка',
  'description',
  'описание'
]);

function pick(row: Record<string, string>, keys: string[]) {
  for (const key of keys) {
    const normalized = normalizeCsvHeader(key);
    if (row[normalized]) return row[normalized];
  }
  return undefined;
}

function rowToProduct(row: Record<string, string>, sourceLocation: string): CatalogProductInput | null {
  const name = pick(row, ['name', 'название']);
  if (!name) return null;

  const externalId = pick(row, ['external_id', 'id', 'артикул', 'sku']);
  const sourceUrl = pick(row, ['source_url', 'url']) ?? (externalId ? `csv:${externalId}` : `csv:${name}`);
  const specs: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (!value || knownColumns.has(key)) continue;
    specs[key] = value;
  }

  return {
    externalId,
    sourceUrl,
    name,
    brand: pick(row, ['brand', 'бренд']),
    category: pick(row, ['category', 'категория']),
    price: parsePrice(pick(row, ['price', 'цена'])),
    currency: pick(row, ['currency', 'валюта']) ?? 'RUB',
    imageUrl: pick(row, ['image_url', 'image', 'картинка']),
    description: pick(row, ['description', 'описание']),
    specs,
    sourcePriority: 30,
    raw: { sourceType: 'csv', sourceLocation, row }
  };
}

export async function importCatalogCsv(filePath: string, repository = new ProductRepository()) {
  const sourceId = await repository.startCatalogSource({ type: 'csv_import', location: filePath });
  let imported = 0;
  let skipped = 0;

  try {
    const parser = fs.createReadStream(filePath).pipe(
      parse({
        columns: (headers: string[]) => headers.map(normalizeCsvHeader),
        skip_empty_lines: true,
        trim: true,
        bom: true
      })
    );

    for await (const row of parser as AsyncIterable<Record<string, string>>) {
      const product = rowToProduct(row, filePath);
      if (!product) {
        skipped += 1;
        continue;
      }
      const embedding = await createEmbedding(productToEmbeddingText(product)).catch(() => null);
      await repository.upsertProduct(product, embedding ?? undefined);
      imported += 1;
    }

    await repository.finishCatalogSource(sourceId, 'completed', { imported, skipped });
    return { imported, skipped };
  } catch (error) {
    await repository.finishCatalogSource(sourceId, 'failed', { imported, skipped }, String(error));
    throw error;
  }
}
