import * as cheerio from 'cheerio';
import { createEmbedding } from '../ai/openaiClient.js';
import { embeddingMetadataForText } from '../ai/embeddingUtils.js';
import { config } from '../config.js';
import { ProductRepository } from '../db/repositories.js';
import type { CatalogPageInput, CatalogProductInput } from '../shared/types.js';
import { outboundText, safeFetchBytes } from '../security/outboundHttp.js';
import { createCatalogSyncHeartbeat, evaluateCatalogInventoryCoverage } from './catalogFreshness.js';
import { absoluteUrl, cleanText, normalizeSpecKey, parsePrice, productToEmbeddingText, slugFromUrl } from './normalize.js';
import { hasPageSpecificProductEvidence } from './productPageIdentity.js';

type SitemapEntry = {
  loc: string;
  lastmod?: string;
};

export type SitemapSyncOptions = {
  sitemapUrl?: string;
  maxProducts?: number;
  maxContentPages?: number;
  concurrency?: number;
  includeProducts?: boolean;
  includeContent?: boolean;
  includeEmbeddings?: boolean;
  requestDelayMs?: number;
  onlyUrls?: string[];
  onProgress?: (message: string) => void;
};

type FetchResult = {
  url: string;
  status: number;
  html: string;
};

const defaultContentRoots = new Set([
  'articles',
  'news',
  'services',
  'projects',
  'implemented-projects',
  'stocks',
  'faq',
  'guarantee',
  'garantiya',
  'delivery-and-payment',
  'about',
  'brands'
]);

const documentSuffixes = ['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.zip', '.rar'];
const brandSpecKeys = ['производитель', 'бренд', 'марка'];

function replaceAllText(value: string, target: string, replacement: string) {
  return value.split(target).join(replacement);
}

function decodeXml(value: string) {
  let decoded = value;
  for (const [entity, replacement] of [
    ['&amp;', '&'],
    ['&lt;', '<'],
    ['&gt;', '>'],
    ['&quot;', '"'],
    ['&#039;', "'"]
  ]) {
    decoded = replaceAllText(decoded, entity, replacement);
  }
  return decoded;
}

function isXmlTagBoundary(char: string | undefined) {
  return char === undefined || char === '>' || char === '/' || char.trim().length === 0;
}

function findXmlBlocks(xml: string, tagName: string) {
  const lowerXml = xml.toLocaleLowerCase('en-US');
  const lowerTag = tagName.toLocaleLowerCase('en-US');
  const openPrefix = `<${lowerTag}`;
  const closeTag = `</${lowerTag}>`;
  const blocks: string[] = [];
  let searchFrom = 0;

  while (searchFrom < lowerXml.length) {
    const openStart = lowerXml.indexOf(openPrefix, searchFrom);
    if (openStart < 0) break;
    if (!isXmlTagBoundary(lowerXml[openStart + openPrefix.length])) {
      searchFrom = openStart + openPrefix.length;
      continue;
    }
    const openEnd = lowerXml.indexOf('>', openStart);
    if (openEnd < 0) break;
    const closeStart = lowerXml.indexOf(closeTag, openEnd + 1);
    if (closeStart < 0) break;
    blocks.push(xml.slice(openStart, closeStart + closeTag.length));
    searchFrom = closeStart + closeTag.length;
  }

  return blocks;
}

function extractXmlTagText(xml: string, tagName: string) {
  const lowerXml = xml.toLocaleLowerCase('en-US');
  const lowerTag = tagName.toLocaleLowerCase('en-US');
  const openPrefix = `<${lowerTag}`;
  const closeTag = `</${lowerTag}>`;
  let searchFrom = 0;

  while (searchFrom < lowerXml.length) {
    const openStart = lowerXml.indexOf(openPrefix, searchFrom);
    if (openStart < 0) return undefined;
    if (!isXmlTagBoundary(lowerXml[openStart + openPrefix.length])) {
      searchFrom = openStart + openPrefix.length;
      continue;
    }
    const openEnd = lowerXml.indexOf('>', openStart);
    if (openEnd < 0) return undefined;
    const closeStart = lowerXml.indexOf(closeTag, openEnd + 1);
    if (closeStart < 0) return undefined;
    return xml.slice(openEnd + 1, closeStart);
  }

  return undefined;
}

function extractAllXmlTagText(xml: string, tagName: string) {
  const values: string[] = [];
  const lowerXml = xml.toLocaleLowerCase('en-US');
  const lowerTag = tagName.toLocaleLowerCase('en-US');
  const openPrefix = `<${lowerTag}`;
  const closeTag = `</${lowerTag}>`;
  let searchFrom = 0;

  while (searchFrom < lowerXml.length) {
    const openStart = lowerXml.indexOf(openPrefix, searchFrom);
    if (openStart < 0) break;
    if (!isXmlTagBoundary(lowerXml[openStart + openPrefix.length])) {
      searchFrom = openStart + openPrefix.length;
      continue;
    }
    const openEnd = lowerXml.indexOf('>', openStart);
    if (openEnd < 0) break;
    const closeStart = lowerXml.indexOf(closeTag, openEnd + 1);
    if (closeStart < 0) break;
    values.push(xml.slice(openEnd + 1, closeStart));
    searchFrom = closeStart + closeTag.length;
  }

  return values;
}

function parseSitemapIndex(xml: string) {
  return findXmlBlocks(xml, 'sitemap')
    .map((block) => extractXmlTagText(block, 'loc'))
    .filter((value): value is string => Boolean(value))
    .map((value) => decodeXml(value.trim()));
}

function parseSitemapEntries(xml: string): SitemapEntry[] {
  const blocks = findXmlBlocks(xml, 'url');
  if (!blocks.length) {
    return extractAllXmlTagText(xml, 'loc').map((value) => ({ loc: decodeXml(value.trim()) }));
  }
  return blocks
    .map((block) => ({
      loc: decodeXml(extractXmlTagText(block, 'loc')?.trim() ?? ''),
      lastmod: extractXmlTagText(block, 'lastmod')?.trim()
    }))
    .filter((entry) => entry.loc);
}

function pathParts(url: string) {
  try {
    return new URL(url).pathname.split('/').filter(Boolean);
  } catch {
    return [];
  }
}

function sameHost(url: string, baseUrl: string) {
  try {
    return new URL(url).hostname === new URL(baseUrl).hostname;
  } catch {
    return false;
  }
}

function isCatalogUrl(url: string, baseUrl: string) {
  const parts = pathParts(url);
  return sameHost(url, baseUrl) && parts[0] === 'catalog';
}

function looksLikeProductUrl(url: string, baseUrl: string) {
  const parts = pathParts(url);
  if (!sameHost(url, baseUrl) || parts[0] !== 'catalog' || parts.length < 3) return false;
  const last = parts.at(-1) ?? '';
  return last.length > 8 && !last.startsWith('filter') && !last.includes('clear');
}

function contentPageType(url: string, baseUrl: string) {
  const parts = pathParts(url);
  if (!sameHost(url, baseUrl) || !parts.length) return undefined;
  if (parts[0] === 'catalog') return undefined;
  return defaultContentRoots.has(parts[0]) ? parts[0] : undefined;
}

function withoutQueryOrHash(value: string) {
  const queryIndex = value.indexOf('?');
  const hashIndex = value.indexOf('#');
  const indexes = [queryIndex, hashIndex].filter((index) => index >= 0);
  const cutIndex = indexes.length ? Math.min(...indexes) : -1;
  return cutIndex >= 0 ? value.slice(0, cutIndex) : value;
}

function hasDocumentSuffix(value: string) {
  const path = withoutQueryOrHash(value).toLocaleLowerCase('en-US');
  return documentSuffixes.some((suffix) => path.endsWith(suffix));
}

function extractCssUrl(value: string) {
  const lower = value.toLocaleLowerCase('en-US');
  const marker = 'url(';
  const start = lower.indexOf(marker);
  if (start < 0) return undefined;
  const contentStart = start + marker.length;
  const end = value.indexOf(')', contentStart);
  if (end < 0) return undefined;
  let content = value.slice(contentStart, end).trim();
  const first = content[0];
  const last = content[content.length - 1];
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
    content = content.slice(1, -1).trim();
  }
  return content || undefined;
}

function articleValueFromCaption(value: string) {
  const marker = 'артикул';
  const lower = value.toLocaleLowerCase('ru-RU');
  const markerIndex = lower.indexOf(marker);
  if (markerIndex < 0) return undefined;
  const afterMarker = value.slice(markerIndex + marker.length);
  if (afterMarker && afterMarker[0].trim().length > 0) return undefined;
  const trimmed = afterMarker.trimStart();
  return trimmed.length ? trimmed : undefined;
}

function isBrandSpecKey(value: string) {
  const lower = value.toLocaleLowerCase('ru-RU');
  return brandSpecKeys.some((key) => lower.includes(key));
}

function isAsciiAlnumOrHyphen(char: string) {
  const code = char.codePointAt(0) ?? 0;
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || char === '-';
}

function isBrandLikeToken(value: string) {
  return value.length >= 3 && [...value].every(isAsciiAlnumOrHyphen);
}

async function fetchText(url: string, baseUrl: string, maxBytes = config.CATALOG_MAX_RESPONSE_BYTES): Promise<FetchResult> {
  const response = await safeFetchBytes(url, {
    allowedOrigin: baseUrl,
    maxBytes,
    timeoutMs: config.CATALOG_REQUEST_TIMEOUT_MS,
    maxRedirects: 3,
    headers: { 'user-agent': 'Bakaut AI catalog sync (+local development; respects sitemap)' },
  });
  return { url: response.url, status: response.status, html: outboundText(response) };
}

async function collectSitemapEntries(
  sitemapUrl: string,
  baseUrl: string,
  heartbeat: () => Promise<void>
) {
  await heartbeat();
  const root = await fetchText(sitemapUrl, baseUrl, config.CATALOG_MAX_SITEMAP_BYTES);
  await heartbeat();
  if (root.status >= 400) throw new Error(`Sitemap HTTP ${root.status}: ${sitemapUrl}`);
  const sitemapUrls = parseSitemapIndex(root.html);
  if (sitemapUrls.length > config.CATALOG_MAX_SITEMAP_FILES) {
    throw new Error(`Sitemap index exceeds ${config.CATALOG_MAX_SITEMAP_FILES} files`);
  }
  const targetSitemaps = sitemapUrls.length ? sitemapUrls : [sitemapUrl];
  const entries: SitemapEntry[] = [];

  for (const url of targetSitemaps) {
    await heartbeat();
    const response = await fetchText(url, baseUrl, config.CATALOG_MAX_SITEMAP_BYTES);
    await heartbeat();
    if (response.status >= 400) continue;
    entries.push(...parseSitemapEntries(response.html));
    if (entries.length > config.CATALOG_MAX_SITEMAP_ENTRIES) {
      throw new Error(`Sitemap inventory exceeds ${config.CATALOG_MAX_SITEMAP_ENTRIES} entries`);
    }
  }

  const byUrl = new Map<string, SitemapEntry>();
  for (const entry of entries) byUrl.set(entry.loc, entry);
  return { sitemapUrls: targetSitemaps, entries: [...byUrl.values()] };
}

function assignSpec(specs: Record<string, string>, keyText: string, valueText: string) {
  const key = normalizeSpecKey(cleanText(keyText));
  const value = cleanText(valueText);
  if (!key || !value || key.length > 120 || value.length > 500) return;
  specs[key] = value;
}

function extractSpecs($: cheerio.CheerioAPI) {
  const specs: Record<string, string> = {};

  $('.props-item, .caption-item').each((_, node) => {
    const title = $(node).find('.props-item__title, .caption-item__title').first().text();
    const value = $(node).find('.props-item__text, .caption-item__text').first().text();
    assignSpec(specs, title, value);
  });

  $('table tr').each((_, row) => {
    const cells = $(row)
      .find('td, th')
      .toArray()
      .map((cell) => cleanText($(cell).text()));
    if (cells.length >= 2) assignSpec(specs, cells[0], cells.slice(1).join(' '));
  });

  $('dl').each((_, dl) => {
    const terms = $(dl).find('dt').toArray();
    const defs = $(dl).find('dd').toArray();
    terms.forEach((term, index) => assignSpec(specs, $(term).text(), $(defs[index]).text()));
  });

  return specs;
}

function extractJsonLd($: cheerio.CheerioAPI) {
  const blocks: unknown[] = [];
  $('script[type="application/ld+json"]').each((_, script) => {
    const text = $(script).text();
    if (!text.trim()) return;
    try {
      blocks.push(JSON.parse(text));
    } catch {
      // Ignore broken JSON-LD blocks from the source page.
    }
  });
  return blocks;
}

function findJsonProduct(value: unknown): any | undefined {
  if (!value || typeof value !== 'object') return undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findJsonProduct(item);
      if (found) return found;
    }
    return undefined;
  }
  const object = value as Record<string, unknown>;
  const type = object['@type'];
  if (type === 'Product' || (Array.isArray(type) && type.includes('Product'))) return object;
  for (const item of Object.values(object)) {
    const found = findJsonProduct(item);
    if (found) return found;
  }
  return undefined;
}

function extractBreadcrumbs($: cheerio.CheerioAPI) {
  return $('.breadcrumbs a, [class*="breadcrumb"] a')
    .toArray()
    .map((node) => cleanText($(node).text()))
    .filter(Boolean);
}

function extractDocuments($: cheerio.CheerioAPI, pageUrl: string) {
  const docs: Array<{ title: string; url: string }> = [];
  $('a[href]').each((_, node) => {
    const href = $(node).attr('href');
    if (!href || !hasDocumentSuffix(href)) return;
    const url = absoluteUrl(href, pageUrl);
    if (url) docs.push({ title: cleanText($(node).text()) || url.split('/').pop() || url, url });
  });
  return [...new Map(docs.map((doc) => [doc.url, doc])).values()];
}

function extractImages($: cheerio.CheerioAPI, pageUrl: string) {
  const urls = new Set<string>();
  const add = (value: string | undefined) => {
    const url = absoluteUrl(value, pageUrl);
    if (url) urls.add(url);
  };
  add($('meta[property="og:image"]').attr('content'));
  $('[itemprop="image"], .card__main-slider img, .card__thumbs-slider-item').each((_, node) => {
    add($(node).attr('src'));
    const style = $(node).attr('style') ?? '';
    add(extractCssUrl(style));
  });
  return [...urls];
}

function extractArticle($: cheerio.CheerioAPI, specs: Record<string, string>) {
  const captionValue = $('.product-caption__item')
    .toArray()
    .map((node) => cleanText($(node).text()))
    .map(articleValueFromCaption)
    .find((value): value is string => Boolean(value));
  return specs['артикул'] || captionValue;
}

function extractBrand(specs: Record<string, string>, name: string, jsonProduct: any | undefined) {
  const specBrand = Object.entries(specs).find(([key]) => isBrandSpecKey(key))?.[1];
  const jsonBrand = typeof jsonProduct?.brand === 'string'
    ? jsonProduct.brand
    : typeof jsonProduct?.brand?.name === 'string'
      ? jsonProduct.brand.name
      : undefined;
  if (specBrand) return specBrand;
  if (jsonBrand) return jsonBrand;
  const firstToken = cleanText(name).split(' ').find(isBrandLikeToken);
  return firstToken;
}

function extractAvailability($: cheerio.CheerioAPI) {
  const offer = $('[itemprop="availability"]').first().attr('href') ?? '';
  const text = cleanText($('.product-not-in-stock, [class*="stock"], [class*="availability"]').first().text());
  if (offer.includes('OutOfStock')) return { status: 'out_of_stock', text: text || 'Нет в наличии' };
  if (offer.includes('InStock')) return { status: 'in_stock', text: text || 'В наличии' };
  return text ? { status: 'unknown', text } : undefined;
}

function isNotFoundPage($: cheerio.CheerioAPI, status: number) {
  const h1 = cleanText($('h1').first().text()).toLowerCase();
  return status === 404 || h1.includes('страница не найдена') || h1.split(' ').includes('404');
}

export function extractProduct(response: FetchResult, baseUrl: string, sitemapLastmod?: string): CatalogProductInput | null {
  const $ = cheerio.load(response.html);
  if (isNotFoundPage($, response.status)) return null;

  const jsonProduct = extractJsonLd($).map(findJsonProduct).find(Boolean);
  const hasProductSignals =
    response.html.includes('schema.org/Product') ||
    $('[itemtype*="schema.org/Product"]').length > 0 ||
    $('.card__current-price, .card__title, .props-list, [itemprop="offers"]').length > 0;
  if (!hasProductSignals || !hasPageSpecificProductEvidence(response.html, response.url)) return null;

  const name = cleanText($('h1').first().text() || $('.card__title').first().text() || jsonProduct?.name);
  if (!name || name.length < 4) return null;

  const specs = extractSpecs($);
  const article = extractArticle($, specs);
  const description = cleanText(
    $('#description .card__caption').first().text() ||
      $('[itemprop="description"]').first().text() ||
      $('meta[name="description"]').attr('content')
  );
  const priceText = cleanText(
    $('[itemprop="price"]').first().attr('content') ||
      $('.card__current-price').first().text() ||
      $('meta[property="product:price:amount"]').attr('content') ||
      jsonProduct?.offers?.price
  );
  const breadcrumbs = extractBreadcrumbs($);
  const category = [...breadcrumbs].reverse().find((item) => item.toLowerCase() !== 'каталог' && item.toLowerCase() !== 'главная');
  const images = extractImages($, response.url);
  const siteProductId = $('.js_favorite[data-id], .js_compare[data-id]').first().attr('data-id');
  const availability = extractAvailability($);
  const slug = slugFromUrl(response.url);

  return {
    externalId: slug ? `bakaut:${slug}` : undefined,
    sourceUrl: response.url,
    slug,
    name,
    brand: extractBrand(specs, name, jsonProduct),
    category,
    price: parsePrice(priceText),
    currency: 'RUB',
    imageUrl: images[0],
    description,
    specs,
    sourcePriority: 30,
    raw: {
      sourceType: 'site',
      pageType: 'product',
      crawledAt: new Date().toISOString(),
      sitemapLastmod,
      article,
      siteProductId,
      availability,
      breadcrumbs,
      images,
      documents: extractDocuments($, response.url),
      deliveryText: cleanText($('.delivery-info').first().text())
    }
  };
}

function readablePageText($: cheerio.CheerioAPI) {
  $('script, style, noscript, svg, form, header, footer, nav, .breadcrumbs, .header, .footer').remove();
  const preferred = $('article, main, .page, .content, .section').first();
  const text = cleanText((preferred.length ? preferred : $('body')).text());
  return text.slice(0, 40_000);
}

function extractCatalogPage(response: FetchResult, baseUrl: string, pageType: string, sitemapLastmod?: string): CatalogPageInput | null {
  const $ = cheerio.load(response.html);
  if (isNotFoundPage($, response.status)) return null;
  const title = cleanText($('h1').first().text() || $('title').first().text());
  if (!title || title.length < 3) return null;
  const content = readablePageText($);
  if (content.length < 200) return null;
  const summary = cleanText($('meta[name="description"]').attr('content') || content.slice(0, 500));
  return {
    sourceUrl: response.url,
    pageType,
    title,
    content,
    summary,
    raw: {
      sourceType: 'site',
      pageType,
      crawledAt: new Date().toISOString(),
      sitemapLastmod,
      documents: extractDocuments($, response.url)
    }
  };
}

async function maybeEmbedding(text: string, enabled: boolean) {
  if (!enabled) return undefined;
  const embedding = await createEmbedding(text).catch(() => undefined);
  return embedding ?? undefined;
}

async function runPool<T>(
  items: T[],
  concurrency: number,
  handler: (item: T, index: number) => Promise<void>
) {
  let next = 0;
  const failures: unknown[] = [];
  const workers = Array.from({ length: Math.max(1, concurrency) }, async () => {
    while (failures.length === 0 && next < items.length) {
      const index = next;
      next += 1;
      try {
        await handler(items[index], index);
      } catch (error) {
        if (failures.length === 0) failures.push(error);
      }
    }
  });
  await Promise.all(workers);
  if (failures.length) throw failures[0];
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function limitedErrors(errors: Array<{ url: string; error: string }>, url: string, error: unknown) {
  if (errors.length < 50) {
    errors.push({ url, error: error instanceof Error ? error.message : String(error) });
  }
}

export async function syncCatalogFromSitemap(options: SitemapSyncOptions = {}, repository = new ProductRepository()) {
  const baseUrl = config.CATALOG_BASE_URL;
  const sitemapUrl = options.sitemapUrl ?? new URL('/sitemap.xml', baseUrl).toString();
  const includeProducts = options.includeProducts ?? true;
  const includeContent = options.includeContent ?? true;
  const includeEmbeddings = options.includeEmbeddings ?? false;
  const concurrency = options.concurrency ?? 4;
  const requestDelayMs = options.requestDelayMs ?? 150;
  const errors: Array<{ url: string; error: string }> = [];
  const limitedScope = Boolean(options.onlyUrls?.length) ||
    (includeProducts && options.maxProducts !== undefined) ||
    (includeContent && options.maxContentPages !== undefined);
  const syncMode = limitedScope ? 'partial' : 'full';
  const sourceId = await repository.startCatalogSource({
    type: 'site_crawl',
    location: sitemapUrl,
    syncMode
  });
  const heartbeat = createCatalogSyncHeartbeat(() => repository.heartbeatCatalogSource(sourceId));

  const stats = {
    sitemapUrl,
    sitemapFiles: 0,
    sitemapEntries: 0,
    productCandidates: 0,
    contentCandidates: 0,
    importedProducts: 0,
    skippedProducts: 0,
    failedProducts: 0,
    importedContentPages: 0,
    skippedContentPages: 0,
    failedContentPages: 0,
    productsWithoutPrice: 0,
    productsWithoutSpecs: 0,
    activeProductsBefore: 0,
    activeContentPagesBefore: 0,
    minimumProductCandidates: 0,
    minimumContentCandidates: 0,
    inventoryCoverageSafe: syncMode !== 'full',
    errors
  };

  try {
    const collected = await collectSitemapEntries(sitemapUrl, baseUrl, heartbeat);
    stats.sitemapFiles = collected.sitemapUrls.length;
    stats.sitemapEntries = collected.entries.length;

    const onlyUrlEntries: SitemapEntry[] = options.onlyUrls?.map((loc) => ({ loc })) ?? [];
    const productEntries = onlyUrlEntries.length
      ? onlyUrlEntries.filter((entry) => isCatalogUrl(entry.loc, baseUrl))
      : collected.entries
          .filter((entry) => isCatalogUrl(entry.loc, baseUrl))
          .sort((a, b) => Number(looksLikeProductUrl(b.loc, baseUrl)) - Number(looksLikeProductUrl(a.loc, baseUrl)))
          .slice(0, options.maxProducts ?? Number.MAX_SAFE_INTEGER);
    const contentEntries = onlyUrlEntries.length
      ? onlyUrlEntries
          .map((entry) => ({ ...entry, pageType: contentPageType(entry.loc, baseUrl) }))
          .filter((entry): entry is SitemapEntry & { pageType: string } => typeof entry.pageType === 'string')
      : collected.entries
          .map((entry) => ({ ...entry, pageType: contentPageType(entry.loc, baseUrl) }))
          .filter((entry): entry is SitemapEntry & { pageType: string } => typeof entry.pageType === 'string')
          .slice(0, options.maxContentPages ?? Number.MAX_SAFE_INTEGER);

    stats.productCandidates = productEntries.length;
    stats.contentCandidates = contentEntries.length;
    options.onProgress?.(`Sitemap: ${stats.sitemapEntries} URLs, ${stats.productCandidates} catalog candidates, ${stats.contentCandidates} content candidates`);

    if (syncMode === 'full' && (includeProducts || includeContent)) {
      const activeInventory = await repository.getActiveCatalogInventoryCounts();
      const thresholds = {
        minimumRatio: config.CATALOG_DEACTIVATION_MIN_DISCOVERY_RATIO,
        minimumFloor: config.CATALOG_DEACTIVATION_MIN_DISCOVERY_FLOOR
      };
      const productInventory = evaluateCatalogInventoryCoverage({
        activeItems: activeInventory.products,
        discoveredItems: stats.productCandidates
      }, thresholds);
      const contentInventory = evaluateCatalogInventoryCoverage({
        activeItems: activeInventory.pages,
        discoveredItems: stats.contentCandidates
      }, thresholds);
      stats.activeProductsBefore = activeInventory.products;
      stats.activeContentPagesBefore = activeInventory.pages;
      stats.minimumProductCandidates = productInventory.requiredItems;
      stats.minimumContentCandidates = contentInventory.requiredItems;
      const unsafeInventory = [
        includeProducts && !productInventory.safe
          ? `products(active=${productInventory.activeItems},discovered=${productInventory.discoveredItems},required=${productInventory.requiredItems})`
          : null,
        includeContent && !contentInventory.safe
          ? `pages(active=${contentInventory.activeItems},discovered=${contentInventory.discoveredItems},required=${contentInventory.requiredItems})`
          : null
      ].filter((value): value is string => Boolean(value));
      stats.inventoryCoverageSafe = unsafeInventory.length === 0;
      if (unsafeInventory.length) {
        throw new Error(`catalog_inventory_coverage_below_threshold:${unsafeInventory.join(',')}`);
      }
    }

    if (includeProducts) {
      await runPool(productEntries, concurrency, async (entry, index) => {
        await heartbeat();
        try {
          const response = await fetchText(entry.loc, baseUrl);
          const product = extractProduct(response, baseUrl, entry.lastmod);
          if (!product) {
            stats.skippedProducts += 1;
            return;
          }
          const embeddingText = productToEmbeddingText(product);
          const embedding = await maybeEmbedding(embeddingText, includeEmbeddings);
          await repository.upsertProduct(product, embedding, embedding ? embeddingMetadataForText(embeddingText) : undefined);
          stats.importedProducts += 1;
          if (!product.price) stats.productsWithoutPrice += 1;
          if (!Object.keys(product.specs ?? {}).length) stats.productsWithoutSpecs += 1;
          if (stats.importedProducts % 100 === 0) {
            options.onProgress?.(`Products imported: ${stats.importedProducts}/${stats.productCandidates}`);
          }
        } catch (error) {
          stats.failedProducts += 1;
          limitedErrors(errors, entry.loc, error);
        } finally {
          if (requestDelayMs > 0) await sleep(requestDelayMs);
          await heartbeat();
        }
      });
    }

    if (includeContent) {
      await runPool(contentEntries, Math.min(concurrency, 3), async (entry) => {
        await heartbeat();
        try {
          const response = await fetchText(entry.loc, baseUrl);
          const page = extractCatalogPage(response, baseUrl, entry.pageType, entry.lastmod);
          if (!page) {
            stats.skippedContentPages += 1;
            return;
          }
          const embeddingText = [page.title, page.summary, page.content].filter(Boolean).join('\n').slice(0, 8000);
          const embedding = await maybeEmbedding(embeddingText, includeEmbeddings);
          await repository.upsertCatalogPage(page, embedding, embedding ? embeddingMetadataForText(embeddingText) : undefined);
          stats.importedContentPages += 1;
        } catch (error) {
          stats.failedContentPages += 1;
          limitedErrors(errors, entry.loc, error);
        } finally {
          if (requestDelayMs > 0) await sleep(requestDelayMs);
          await heartbeat();
        }
      });
    }

    const failedItemCount = stats.failedProducts + stats.failedContentPages;
    const discoveredItemCount =
      (includeProducts ? stats.productCandidates : 0) +
      (includeContent ? stats.contentCandidates : 0);
    const syncedItemCount = stats.importedProducts + stats.importedContentPages;
    const productCoverageComplete = !includeProducts || (
      stats.productCandidates > 0 &&
      stats.importedProducts === stats.productCandidates &&
      stats.skippedProducts === 0 &&
      stats.failedProducts === 0
    );
    const contentCoverageComplete = !includeContent || (
      stats.contentCandidates > 0 &&
      stats.importedContentPages === stats.contentCandidates &&
      stats.skippedContentPages === 0 &&
      stats.failedContentPages === 0
    );
    const coverageComplete = syncMode === 'full' &&
      discoveredItemCount > 0 &&
      syncedItemCount === discoveredItemCount &&
      failedItemCount === 0 &&
      productCoverageComplete &&
      contentCoverageComplete;
    await repository.finishCatalogSource(
      sourceId,
      'completed',
      { ...stats, syncMode, coverageComplete },
      undefined,
      {
        coverageComplete,
        discoveredItemCount,
        syncedItemCount,
        failedItemCount,
        deactivateProducts: coverageComplete && includeProducts,
        deactivatePages: coverageComplete && includeContent
      }
    );
    return stats;
  } catch (error) {
    await repository.finishCatalogSource(
      sourceId,
      'failed',
      { ...stats, syncMode, coverageComplete: false },
      error instanceof Error ? error.message : String(error),
      {
        coverageComplete: false,
        discoveredItemCount: stats.productCandidates + stats.contentCandidates,
        syncedItemCount: stats.importedProducts + stats.importedContentPages,
        failedItemCount: stats.failedProducts + stats.failedContentPages + 1
      }
    );
    throw error;
  }
}
