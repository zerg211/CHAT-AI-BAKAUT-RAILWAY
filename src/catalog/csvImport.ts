import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'csv-parse';
import { ProductRepository } from '../db/repositories.js';
import { createEmbedding } from '../ai/openaiClient.js';
import { embeddingMetadataForText } from '../ai/embeddingUtils.js';
import type { CatalogProductInput } from '../shared/types.js';
import { createCatalogSyncHeartbeat } from './catalogFreshness.js';
import { normalizeCsvHeader, parsePrice, productToEmbeddingText } from './normalize.js';
import { config } from '../config.js';

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

export async function assertCatalogCsvInput(
  filePath: string,
  options: { allowOutsideRoot?: boolean; allowedRoot?: string } = {}
) {
  const resolvedFile = await fs.promises.realpath(path.resolve(filePath));
  if (path.extname(resolvedFile).toLocaleLowerCase('en-US') !== '.csv') {
    throw new Error('catalog_csv_extension_required');
  }
  if (!options.allowOutsideRoot) {
    const resolvedRoot = await fs.promises.realpath(path.resolve(options.allowedRoot ?? config.CATALOG_IMPORT_ROOT));
    const relative = path.relative(resolvedRoot, resolvedFile);
    if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
      throw new Error('catalog_csv_outside_import_root');
    }
  }
  const stat = await fs.promises.stat(resolvedFile);
  if (!stat.isFile()) throw new Error('catalog_csv_regular_file_required');
  if (stat.size > config.CATALOG_MAX_CSV_BYTES) throw new Error('catalog_csv_too_large');
  return resolvedFile;
}

export async function importCatalogCsv(
  filePath: string,
  repository = new ProductRepository(),
  options: { allowOutsideRoot?: boolean; allowedRoot?: string } = {}
) {
  const safeFilePath = await assertCatalogCsvInput(filePath, options);
  const sourceId = await repository.startCatalogSource({
    type: 'csv_import',
    location: safeFilePath,
    syncMode: 'partial'
  });
  const heartbeat = createCatalogSyncHeartbeat(() => repository.heartbeatCatalogSource(sourceId));
  let imported = 0;
  let skipped = 0;

  try {
    const parser = fs.createReadStream(safeFilePath).pipe(
      parse({
        columns: (headers: string[]) => headers.map(normalizeCsvHeader),
        skip_empty_lines: true,
        trim: true,
        bom: true,
        max_record_size: 1024 * 1024
      })
    );

    for await (const row of parser as AsyncIterable<Record<string, string>>) {
      await heartbeat();
      if (imported + skipped >= config.CATALOG_MAX_CSV_ROWS) throw new Error('catalog_csv_row_limit_exceeded');
      const product = rowToProduct(row, safeFilePath);
      if (!product) {
        skipped += 1;
        continue;
      }
      const embeddingText = productToEmbeddingText(product);
      const embedding = await createEmbedding(embeddingText).catch(() => null);
      await repository.upsertProduct(product, embedding ?? undefined, embedding ? embeddingMetadataForText(embeddingText) : undefined);
      imported += 1;
      await heartbeat();
    }

    await repository.finishCatalogSource(
      sourceId,
      'completed',
      { imported, skipped, coverageComplete: false },
      undefined,
      {
        coverageComplete: false,
        discoveredItemCount: imported + skipped,
        syncedItemCount: imported,
        failedItemCount: 0
      }
    );
    return { imported, skipped };
  } catch (error) {
    await repository.finishCatalogSource(
      sourceId,
      'failed',
      { imported, skipped, coverageComplete: false },
      String(error),
      {
        coverageComplete: false,
        discoveredItemCount: imported + skipped,
        syncedItemCount: imported,
        failedItemCount: 1
      }
    );
    throw error;
  }
}
