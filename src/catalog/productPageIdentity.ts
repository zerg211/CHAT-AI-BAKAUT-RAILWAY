import * as cheerio from 'cheerio';

function normalizedHttpUrl(value: unknown, baseUrl: string) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value, baseUrl);
    url.hash = '';
    url.search = '';
    while (url.pathname.length > 1 && url.pathname.endsWith('/')) {
      url.pathname = url.pathname.slice(0, -1);
    }
    return url.toString();
  } catch {
    return null;
  }
}

function schemaTypes(value: unknown) {
  if (typeof value === 'string') return [value];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function jsonProductBoundToPage(value: unknown, pageUrl: string): boolean {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some((item) => jsonProductBoundToPage(item, pageUrl));
  const record = value as Record<string, unknown>;
  const isProduct = schemaTypes(record['@type']).some((type) => type.toLocaleLowerCase('en-US') === 'product');
  if (isProduct) {
    const identityUrls = [record.url, record['@id'], record.mainEntityOfPage]
      .flatMap((item) => {
        if (typeof item === 'string') return [item];
        if (item && typeof item === 'object' && !Array.isArray(item)) {
          const nested = item as Record<string, unknown>;
          return [nested['@id'], nested.url].filter((nestedItem): nestedItem is string => typeof nestedItem === 'string');
        }
        return [];
      });
    const normalizedPageUrl = normalizedHttpUrl(pageUrl, pageUrl);
    if (normalizedPageUrl && identityUrls.some((url) => normalizedHttpUrl(url, pageUrl) === normalizedPageUrl)) {
      return true;
    }
  }
  return Object.values(record).some((item) => jsonProductBoundToPage(item, pageUrl));
}

function documentHasExactJsonProduct($: cheerio.CheerioAPI, pageUrl: string) {
  return $('script[type="application/ld+json"]').toArray().some((node) => {
    const text = $(node).text().trim();
    if (!text) return false;
    try {
      return jsonProductBoundToPage(JSON.parse(text), pageUrl);
    } catch {
      return false;
    }
  });
}

function normalizedIdentityValue(value: unknown) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLocaleLowerCase('ru-RU');
  return normalized || null;
}

function captionSkuValue(value: string) {
  const trimmed = value.trim();
  const normalized = trimmed.toLocaleLowerCase('ru-RU');
  const prefix = ['артикул', 'sku'].find((candidate) => {
    if (!normalized.startsWith(candidate)) return false;
    const boundary = normalized[candidate.length];
    return boundary === undefined || boundary.trim().length === 0 || [':', '№', '#', '-', '—'].includes(boundary);
  });
  if (!prefix) return null;
  let remainder = trimmed.slice(prefix.length).trim();
  while (remainder && [':', '№', '#', '-', '—'].includes(remainder[0])) {
    remainder = remainder.slice(1).trim();
  }
  return normalizedIdentityValue(remainder);
}

function hasSingleDetailLayoutIdentity($: cheerio.CheerioAPI, pageUrl: string) {
  const detailMarkerSelector = '.card__main-slider, .product-caption__item, #description .card__caption';
  const productScopeSelector = '[itemscope][itemtype*="schema.org/Product"]';
  const listingContainerSelector = '.catalog-list, .catalog-grid, .products-list, .product-list, .catalog-items';
  const pageLevelDetailMarkers = $(detailMarkerSelector).filter((_, node) =>
    $(node).closest(listingContainerSelector).length === 0
  );
  if (!pageLevelDetailMarkers.length) return false;

  const normalizedPageUrl = normalizedHttpUrl(pageUrl, pageUrl);
  const productScopeCount = $(productScopeSelector).length;
  let hasUrlBoundDetailIdentity = false;
  const identityBelongsToDetailPage = (node: Parameters<cheerio.CheerioAPI>[0]) => {
    if ($(node).closest(listingContainerSelector).length) return false;
    const childCard = $(node).closest('article');
    if (childCard.length) {
      const linksToAnotherPage = childCard.find('a[href]').toArray().some((link) => {
        const linkedUrl = normalizedHttpUrl($(link).attr('href'), pageUrl);
        return Boolean(linkedUrl && normalizedPageUrl && linkedUrl !== normalizedPageUrl);
      });
      if (linksToAnotherPage) return false;
    }
    const scope = $(node).closest(productScopeSelector);
    if (!scope.length) {
      return pageLevelDetailMarkers.toArray().some((marker) => $(marker).closest(productScopeSelector).length === 0);
    }
    if (!scope.find(detailMarkerSelector).length && !scope.is(detailMarkerSelector)) return false;
    const identityUrls = [scope.attr('itemid')]
      .concat(scope.find('[itemprop="url"]').toArray().flatMap((urlNode) => [
        $(urlNode).attr('href'),
        $(urlNode).attr('content')
      ]))
      .filter((value): value is string => typeof value === 'string' && Boolean(value.trim()));
    if (identityUrls.length > 0) {
      const matchesPage = Boolean(normalizedPageUrl) && identityUrls.some((value) =>
        normalizedHttpUrl(value, pageUrl) === normalizedPageUrl
      );
      if (matchesPage) hasUrlBoundDetailIdentity = true;
      return matchesPage;
    }
    return productScopeCount === 1;
  };

  const productIds = new Set<string>();
  $('.js_favorite[data-id], .js_compare[data-id]').each((_, node) => {
    if (!identityBelongsToDetailPage(node)) return;
    const id = normalizedIdentityValue($(node).attr('data-id'));
    if (id) productIds.add(id);
  });

  const skus = new Set<string>();
  $('[itemprop="sku"]').each((_, node) => {
    if (!identityBelongsToDetailPage(node)) return;
    const sku = normalizedIdentityValue($(node).attr('content') ?? $(node).text());
    if (sku) skus.add(sku);
  });
  $('.product-caption__item').each((_, node) => {
    if (!identityBelongsToDetailPage(node)) return;
    const sku = captionSkuValue($(node).text());
    if (sku) skus.add(sku);
  });

  if (productIds.size > 1 || skus.size > 1) return false;
  return hasUrlBoundDetailIdentity
    ? productIds.size === 1 || skus.size === 1
    : productIds.size === 1 && skus.size === 1;
}

export function hasPageSpecificProductEvidence(html: string, pageUrl: string) {
  const $ = cheerio.load(html);
  const name = $('h1').first().text().trim();
  if (!name) return false;
  return documentHasExactJsonProduct($, pageUrl) ||
    hasSingleDetailLayoutIdentity($, pageUrl);
}
