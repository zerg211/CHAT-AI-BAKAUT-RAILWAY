import * as cheerio from 'cheerio';
import { fetch } from 'undici';
import { config } from '../config.js';
import { ProductRepository } from '../db/repositories.js';
import { createEmbedding } from '../ai/openaiClient.js';
import { embeddingMetadataForText } from '../ai/embeddingUtils.js';
import type { CatalogProductInput } from '../shared/types.js';
import { absoluteUrl, cleanText, normalizeSpecKey, parsePrice, productToEmbeddingText, slugFromUrl } from './normalize.js';

function shouldVisit(url: string, baseUrl: string) {
  try {
    const parsed = new URL(url);
    const base = new URL(baseUrl);
    if (parsed.hostname !== base.hostname) return false;
    if (!parsed.pathname.startsWith('/catalog/')) return false;
    if (parsed.pathname.match(/\.(jpg|jpeg|png|gif|webp|pdf|zip|doc|docx|xls|xlsx)$/i)) return false;
    if (parsed.pathname.includes('/clear/')) return false;
    if (parsed.pathname.includes('-is-') || parsed.pathname.includes('-from-') || parsed.pathname.includes('-to-')) return false;
    return true;
  } catch {
    return false;
  }
}

function isProductLikeUrl(url: string) {
  try {
    const pathParts = new URL(url).pathname.split('/').filter(Boolean);
    const slug = pathParts.at(-1) ?? '';
    return pathParts[0] === 'catalog' && pathParts.length >= 3 && slug.length > 4 && !slug.startsWith('filter');
  } catch {
    return false;
  }
}

function extractLinks(html: string, pageUrl: string, baseUrl: string) {
  const $ = cheerio.load(html);
  const links = new Set<string>();
  $('a[href]').each((_, element) => {
    const href = $(element).attr('href');
    const url = absoluteUrl(href, pageUrl);
    if (url && shouldVisit(url, baseUrl)) {
      const parsed = new URL(url);
      parsed.hash = '';
      links.add(parsed.toString());
    }
  });
  return [...links].sort((a, b) => Number(isProductLikeUrl(b)) - Number(isProductLikeUrl(a)));
}

function extractSpecs($: cheerio.CheerioAPI) {
  const specs: Record<string, string> = {};

  $('table tr').each((_, row) => {
    const cells = cheerio.load(row)('td, th')
      .toArray()
      .map((cell) => cleanText(cheerio.load(cell).text()));
    if (cells.length >= 2) {
      const key = normalizeSpecKey(cells[0]);
      const value = cleanText(cells.slice(1).join(' '));
      if (key && value && key.length < 80) specs[key] = value;
    }
  });

  $('dl').each((_, dl) => {
    const local = cheerio.load(dl);
    const terms = local('dt').toArray();
    const defs = local('dd').toArray();
    terms.forEach((term, index) => {
      const key = normalizeSpecKey(local(term).text());
      const value = cleanText(local(defs[index]).text());
      if (key && value) specs[key] = value;
    });
  });

  $('[class*="character"], [class*="param"], [class*="spec"], [class*="props"]').find('li, div').each((_, node) => {
    const text = cleanText($(node).text());
    const split = text.split(/[:—-]/);
    if (split.length >= 2) {
      const key = normalizeSpecKey(split[0]);
      const value = cleanText(split.slice(1).join(' '));
      if (key && value && key.length < 80 && value.length < 200) specs[key] = value;
    }
  });

  return specs;
}

function extractProduct(html: string, pageUrl: string, baseUrl: string): CatalogProductInput | null {
  const $ = cheerio.load(html);
  const isProductPage =
    html.includes('schema.org/Product') ||
    html.includes('itemtype="http://schema.org/Offer"') ||
    html.includes("itemtype='http://schema.org/Offer'") ||
    html.includes('card__current-price');
  if (!isProductPage) return null;

  const name = cleanText($('h1').first().text() || $('[itemprop="name"]').first().text());
  if (!name || name.length < 4) return null;

  const specs = extractSpecs($);
  const description = cleanText(
    $('[itemprop="description"]').first().text() ||
      $('[class*="description"]').first().text() ||
      $('meta[name="description"]').attr('content')
  );
  const priceText = cleanText(
    $('[itemprop="price"]').first().attr('content') ||
      $('[class*="price"]').first().text() ||
      $('meta[property="product:price:amount"]').attr('content')
  );
  const imageUrl = absoluteUrl(
    $('meta[property="og:image"]').attr('content') ||
      $('[itemprop="image"]').first().attr('src') ||
      $('img').first().attr('src'),
    baseUrl
  );
  const category = cleanText($('.breadcrumbs a, [class*="breadcrumb"] a').last().text());
  const hasProductSignals = Object.keys(specs).length >= 2 || Boolean(priceText) || /купить|артикул|характерист/i.test(html);
  if (!hasProductSignals) return null;

  return {
    sourceUrl: pageUrl,
    slug: slugFromUrl(pageUrl),
    name,
    category: category || undefined,
    price: parsePrice(priceText),
    currency: 'RUB',
    imageUrl,
    description,
    specs,
    sourcePriority: 40,
    raw: { sourceType: 'site', pageType: 'product', crawledAt: new Date().toISOString() }
  };
}

async function fetchText(url: string) {
  const response = await fetch(url, {
    headers: {
      'user-agent': 'Bakaut AI catalog crawler (+local development; contact site owner)'
    }
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  return response.text();
}

export async function syncCatalogFromSite(
  options: { baseUrl?: string; maxPages?: number; startPath?: string } = {},
  repository = new ProductRepository()
) {
  const baseUrl = options.baseUrl ?? config.CATALOG_BASE_URL;
  const maxPages = options.maxPages ?? config.CATALOG_MAX_PAGES;
  const startUrl = new URL(options.startPath ?? '/catalog/', baseUrl).toString();
  const sourceId = await repository.startCatalogSource({ type: 'site_crawl', location: startUrl });
  const queue = [startUrl];
  const visited = new Set<string>();
  let imported = 0;
  let failed = 0;

  try {
    while (queue.length && visited.size < maxPages) {
      const url = queue.shift()!;
      if (visited.has(url)) continue;
      visited.add(url);

      try {
        const html = await fetchText(url);
        for (const link of extractLinks(html, url, baseUrl)) {
          if (!visited.has(link) && queue.length + visited.size < maxPages) queue.push(link);
        }

        const product = extractProduct(html, url, baseUrl);
        if (product) {
          const embeddingText = productToEmbeddingText(product);
          const embedding = await createEmbedding(embeddingText).catch(() => null);
          await repository.upsertProduct(product, embedding ?? undefined, embedding ? embeddingMetadataForText(embeddingText) : undefined);
          imported += 1;
        }
      } catch {
        failed += 1;
      }
    }

    await repository.finishCatalogSource(sourceId, 'completed', { visited: visited.size, imported, failed });
    return { visited: visited.size, imported, failed };
  } catch (error) {
    await repository.finishCatalogSource(sourceId, 'failed', { visited: visited.size, imported, failed }, String(error));
    throw error;
  }
}

function normalizeInventoryUrl(value: string) {
  try {
    const url = new URL(value);
    url.hash = '';
    url.search = '';
    return url.toString().replace(/\/$/, '');
  } catch {
    return value.replace(/\/$/, '');
  }
}

export async function inventoryCatalogFromSite(
  options: { baseUrl?: string; maxPages?: number; startPath?: string; importMissing?: boolean } = {},
  repository = new ProductRepository()
) {
  const baseUrl = options.baseUrl ?? config.CATALOG_BASE_URL;
  const maxPages = options.maxPages ?? config.CATALOG_MAX_PAGES;
  const startUrl = new URL(options.startPath ?? '/catalog/', baseUrl).toString();
  const queue = [startUrl];
  const visited = new Set<string>();
  const siteProducts = new Map<string, CatalogProductInput>();
  let failed = 0;

  while (queue.length && visited.size < maxPages) {
    const url = queue.shift()!;
    const normalizedUrl = normalizeInventoryUrl(url);
    if (visited.has(normalizedUrl)) continue;
    visited.add(normalizedUrl);

    try {
      const html = await fetchText(url);
      for (const link of extractLinks(html, url, baseUrl)) {
        const normalizedLink = normalizeInventoryUrl(link);
        if (!visited.has(normalizedLink) && queue.length + visited.size < maxPages) queue.push(link);
      }
      const product = extractProduct(html, url, baseUrl);
      if (product?.sourceUrl) siteProducts.set(normalizeInventoryUrl(product.sourceUrl), product);
    } catch {
      failed += 1;
    }
  }

  const dbUrls = new Set((await repository.listProductSourceUrls(20000)).map(normalizeInventoryUrl));
  const missingProducts = [...siteProducts.entries()]
    .filter(([url]) => !dbUrls.has(url))
    .map(([, product]) => product);

  if (options.importMissing) {
    for (const product of missingProducts) {
      const embeddingText = productToEmbeddingText(product);
      const embedding = await createEmbedding(embeddingText).catch(() => null);
      await repository.upsertProduct(product, embedding ?? undefined, embedding ? embeddingMetadataForText(embeddingText) : undefined);
    }
  }

  return {
    visited: visited.size,
    failed,
    siteProductCount: siteProducts.size,
    dbProductUrlCount: dbUrls.size,
    missingCount: missingProducts.length,
    importedMissing: options.importMissing ? missingProducts.length : 0,
    missingProducts: missingProducts.slice(0, 200).map((product) => ({
      name: product.name,
      sourceUrl: product.sourceUrl,
      price: product.price,
      category: product.category
    }))
  };
}
