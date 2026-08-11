import { describe, expect, it, vi } from 'vitest';
import { fetch } from 'undici';
import type { CatalogPageInput, CatalogProductInput } from '../src/shared/types.js';

vi.mock('undici', () => ({
  fetch: vi.fn(),
  Agent: class {
    async close() {}
  }
}));

vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(async () => [{ address: '93.184.216.34', family: 4 }])
}));

const { refreshExactCatalogProducts, syncCatalogFromSitemap } = await import('../src/catalog/sitemapSync.js');

function xmlResponse(xml: string) {
  return new Response(xml, { status: 200, headers: { 'content-type': 'application/xml' } }) as unknown as Awaited<ReturnType<typeof fetch>>;
}

function htmlResponse(html: string) {
  return new Response(html, { status: 200, headers: { 'content-type': 'text/html' } }) as unknown as Awaited<ReturnType<typeof fetch>>;
}

describe('sitemap sync no-regex XML parsing', () => {
  it('refreshes only the exact product URL when the runtime snapshot misses a split model', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockImplementation(async (url) => {
      const urlText = String(url);
      if (urlText.endsWith('/sitemap.xml')) {
        return xmlResponse(`
          <urlset>
            <url><loc>https://bakautprof.ru/catalog/vibroplity/wacker-neuson-bps-1550-aw/</loc></url>
            <url><loc>https://bakautprof.ru/catalog/vibroplity/wacker-neuson-bps-1550-gw/</loc></url>
          </urlset>
        `);
      }
      return htmlResponse(`
        <html>
          <body>
              <div itemscope itemtype="https://schema.org/Product" itemid="${urlText}">
                <h1>Wacker Neuson BPS 1550 Aw</h1>
                <div class="props-item"><span class="props-item__title">Brand</span><span class="props-item__text">Wacker Neuson</span></div>
                <div class="props-item"><span class="props-item__title">Weight</span><span class="props-item__text">89 kg</span></div>
                <div class="product-caption__item"><span itemprop="sku">BPS-1550-AW</span></div>
                <div class="card__current-price">260 000</div>
            </div>
          </body>
        </html>
      `);
    });
    const upsertProduct = vi.fn(async (_product: CatalogProductInput) => undefined);
    const repository = {
      startCatalogSource: vi.fn(async () => 'source-exact'),
      heartbeatCatalogSource: vi.fn(async () => undefined),
      finishCatalogSource: vi.fn(async () => undefined),
      upsertProduct
    };

    const result = await refreshExactCatalogProducts(['BPS 1550 Aw'], repository as never);

    expect(result.candidateUrls).toEqual([
      'https://bakautprof.ru/catalog/vibroplity/wacker-neuson-bps-1550-aw/'
    ]);
    expect(result.importedProducts).toBe(1);
    expect(upsertProduct).toHaveBeenCalledTimes(1);
    expect(upsertProduct.mock.calls[0]?.[0]).toMatchObject({
      name: 'Wacker Neuson BPS 1550 Aw',
      price: 260000
    });
  });

  it('recognizes underscore slugs with a trailing weight suffix as the exact model page', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockImplementation(async (url) => {
      const urlText = String(url);
      if (urlText.endsWith('/sitemap.xml')) {
        return xmlResponse(`
          <urlset>
            <url><loc>https://bakautprof.ru/catalog/vibroplity/vibroplita_pryamokhodnaya_benzinovaya_wacker_neuson_bps_1550_aw_89_kg/</loc></url>
          </urlset>
        `);
      }
      return htmlResponse(`
        <html>
          <body>
            <div itemscope itemtype="https://schema.org/Product" itemid="${urlText}">
              <h1>Виброплита прямоходная бензиновая Wacker Neuson BPS 1550 Aw (89 кг)</h1>
              <div class="props-item"><span class="props-item__title">Масса</span><span class="props-item__text">89 кг</span></div>
              <div class="product-caption__item"><span itemprop="sku">5100061216</span></div>
              <div class="card__current-price">240 000</div>
            </div>
          </body>
        </html>
      `);
    });
    const upsertProduct = vi.fn(async (_product: CatalogProductInput) => undefined);
    const repository = {
      startCatalogSource: vi.fn(async () => 'source-underscore-slug'),
      heartbeatCatalogSource: vi.fn(async () => undefined),
      finishCatalogSource: vi.fn(async () => undefined),
      upsertProduct
    };

    const result = await refreshExactCatalogProducts(['BPS 1550 Aw'], repository as never);

    expect(result.candidateUrls).toEqual([
      'https://bakautprof.ru/catalog/vibroplity/vibroplita_pryamokhodnaya_benzinovaya_wacker_neuson_bps_1550_aw_89_kg/'
    ]);
    expect(result.importedProducts).toBe(1);
    expect(upsertProduct).toHaveBeenCalledWith(expect.objectContaining({
      name: 'Виброплита прямоходная бензиновая Wacker Neuson BPS 1550 Aw (89 кг)',
      price: 240000
    }));
  });

  it('uses the public catalog search before a slow or unavailable sitemap', async () => {
    const fetchMock = vi.mocked(fetch);
    const callsBefore = fetchMock.mock.calls.length;
    fetchMock.mockImplementation(async (url) => {
      const urlText = String(url);
      if (urlText.includes('/search/')) {
        return htmlResponse(`
          <html><body>
            <a href="/catalog/vibroplity/vibroplita_pryamokhodnaya_benzinovaya_wacker_neuson_bps_1550_aw_89_kg/">
              Виброплита прямоходная бензиновая Wacker Neuson BPS 1550 Aw (89 кг)
            </a>
          </body></html>
        `);
      }
      if (urlText.endsWith('/sitemap.xml')) throw new Error('sitemap should not be needed after exact search');
      return htmlResponse(`
        <html><body>
          <div itemscope itemtype="https://schema.org/Product" itemid="${urlText}">
            <h1>Виброплита прямоходная бензиновая Wacker Neuson BPS 1550 Aw (89 кг)</h1>
            <div class="props-item"><span class="props-item__title">Масса</span><span class="props-item__text">89 кг</span></div>
            <div class="product-caption__item"><span itemprop="sku">5100061216</span></div>
            <div class="card__current-price">260 000</div>
          </div>
        </body></html>
      `);
    });
    const repository = {
      startCatalogSource: vi.fn(async () => 'source-search-first'),
      heartbeatCatalogSource: vi.fn(async () => undefined),
      finishCatalogSource: vi.fn(async () => undefined),
      upsertProduct: vi.fn(async () => undefined)
    };

    const result = await refreshExactCatalogProducts(['BPS 1550 Aw'], repository as never);

    expect(result.candidateUrls).toEqual([
      'https://bakautprof.ru/catalog/vibroplity/vibroplita_pryamokhodnaya_benzinovaya_wacker_neuson_bps_1550_aw_89_kg/'
    ]);
    expect(result.importedProducts).toBe(1);
    expect(fetchMock.mock.calls.slice(callsBefore).some(([url]) => String(url).endsWith('/sitemap.xml'))).toBe(false);
  });

  it('follows sitemap indexes and extracts URL entries with decoded loc values', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockImplementation(async (url, _init) => {
      const urlText = String(url);
      if (urlText.endsWith('/sitemap.xml')) {
        return xmlResponse(`
          <sitemapindex>
            <sitemap>
              <loc>https://bakautprof.ru/sitemap-products.xml</loc>
            </sitemap>
          </sitemapindex>
        `);
      }
      return xmlResponse(`
        <urlset>
          <url>
            <loc>https://bakautprof.ru/catalog/generators/tss-sgg-10000eha/?a=1&amp;b=2</loc>
            <lastmod>2026-05-22</lastmod>
          </url>
          <url>
            <loc>https://bakautprof.ru/articles/how-to-choose-generator/</loc>
          </url>
        </urlset>
      `);
    });

    const finishCatalogSource = vi.fn(async (_sourceId: string, _status: string, _stats: unknown) => undefined);
    const repository = {
      startCatalogSource: vi.fn(async () => 'source-1'),
      finishCatalogSource
    };

    const result = await syncCatalogFromSitemap(
      {
        sitemapUrl: 'https://bakautprof.ru/sitemap.xml',
        includeProducts: false,
        includeContent: false
      },
      repository as never
    );

    expect(result.sitemapFiles).toBe(1);
    expect(result.sitemapEntries).toBe(2);
    expect(result.productCandidates).toBe(1);
    expect(result.contentCandidates).toBe(1);
    expect(finishCatalogSource.mock.calls[0]?.[2]).toMatchObject({
      sitemapEntries: 2,
      productCandidates: 1,
      contentCandidates: 1
    });
  });

  it('falls back to plain loc extraction when URL blocks are absent', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockImplementation(async () => xmlResponse(`
      <loc>https://bakautprof.ru/catalog/vibroplity/test-product/</loc>
      <loc>https://bakautprof.ru/services/rent/</loc>
    `));

    const repository = {
      startCatalogSource: vi.fn(async () => 'source-2'),
      finishCatalogSource: vi.fn(async () => undefined)
    };

    const result = await syncCatalogFromSitemap(
      {
        sitemapUrl: 'https://bakautprof.ru/plain.xml',
        includeProducts: false,
        includeContent: false
      },
      repository as never
    );

    expect(result.sitemapFiles).toBe(1);
    expect(result.sitemapEntries).toBe(2);
    expect(result.productCandidates).toBe(1);
    expect(result.contentCandidates).toBe(1);
  });

  it('extracts product metadata without regex helpers', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockImplementation(async (url, _init) => {
      const urlText = String(url);
      if (urlText.endsWith('/metadata.xml')) {
        return xmlResponse(`
          <urlset>
            <url>
              <loc>https://bakautprof.ru/catalog/generators/tss-sgg-10000eha/</loc>
            </url>
            <url>
              <loc>https://bakautprof.ru/catalog/generators/missing-product/</loc>
            </url>
            <url>
              <loc>https://bakautprof.ru/articles/generator-guide/</loc>
            </url>
          </urlset>
        `);
      }
      if (urlText.endsWith('/missing-product/')) {
        return xmlResponse('<html><body><h1>404</h1></body></html>');
      }
      if (urlText.endsWith('/generator-guide/')) {
        return xmlResponse(`
          <html>
            <body>
              <main>
                <h1>Guide</h1>
                <p>Generator    guide      content with enough words for a useful content page.</p>
                <p>Generator guide content with enough words for a useful content page.</p>
                <p>Generator guide content with enough words for a useful content page.</p>
                <p>Generator guide content with enough words for a useful content page.</p>
                <p>Generator guide content with enough words for a useful content page.</p>
              </main>
            </body>
          </html>
        `);
      }
      return xmlResponse(`
        <html>
          <head>
            <meta property="og:image" content="/images/og.jpg">
          </head>
          <body>
            <div itemscope itemtype="https://schema.org/Product" itemid="${String(url)}">
              <h1>TSS SGG 10000EHA generator</h1>
              <div class="props-item">
                <span class="props-item__title">Бренд</span>
                <span class="props-item__text">TSS</span>
              </div>
              <div class="product-caption__item">Артикул ART-100</div>
              <div class="card__current-price">123 456</div>
              <div class="card__thumbs-slider-item" style="background-image: URL('/images/thumb.jpg')"></div>
              <a href="/docs/manual.pdf?download=1">Manual</a>
            </div>
          </body>
        </html>
      `);
    });

    const upsertProduct = vi.fn(async (_product: CatalogProductInput, _embedding?: unknown, _metadata?: unknown) => undefined);
    const upsertCatalogPage = vi.fn(async (_page: CatalogPageInput, _embedding?: unknown, _metadata?: unknown) => undefined);
    const repository = {
      startCatalogSource: vi.fn(async () => 'source-3'),
      finishCatalogSource: vi.fn(async () => undefined),
      getActiveCatalogInventoryCounts: vi.fn(async () => ({ products: 0, pages: 0 })),
      upsertProduct,
      upsertCatalogPage
    };

    const result = await syncCatalogFromSitemap(
      {
        sitemapUrl: 'https://bakautprof.ru/metadata.xml',
        includeEmbeddings: false,
        requestDelayMs: 0
      },
      repository as never
    );

    expect(result.importedProducts).toBe(1);
    expect(result.skippedProducts).toBe(1);
    expect(result.importedContentPages).toBe(1);
    expect(upsertProduct).toHaveBeenCalledTimes(1);
    const product = upsertProduct.mock.calls[0]?.[0];
    expect(product).toMatchObject({
      brand: 'TSS',
      price: 123456
    });
    const raw = product?.raw as {
      article?: unknown;
      documents?: Array<{ url?: unknown }>;
      images?: unknown[];
    } | undefined;
    expect(raw?.article).toBe('ART-100');
    expect(raw?.documents?.[0]?.url).toBe('https://bakautprof.ru/docs/manual.pdf?download=1');
    expect(raw?.images).toContain('https://bakautprof.ru/images/thumb.jpg');
    expect(upsertCatalogPage).toHaveBeenCalledTimes(1);
  });

  it('fails the whole sitemap run when an in-loop heartbeat update fails', async () => {
    let currentTime = 0;
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => currentTime);
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockImplementation(async (url) => {
      if (String(url).endsWith('/heartbeat.xml')) {
        return xmlResponse(`
          <urlset>
            <url><loc>https://bakautprof.ru/catalog/generators/heartbeat-product/</loc></url>
          </urlset>
        `);
      }
      currentTime = 20_000;
      return htmlResponse(`
        <html><head><meta property="og:type" content="product"></head><body>
          <div itemscope itemtype="https://schema.org/Product" itemid="${String(url)}">
            <h1>Heartbeat generator</h1>
            <div class="card__main-slider">Heartbeat generator</div>
            <button class="js_favorite" data-id="heartbeat-generator">В избранное</button>
            <div class="card__current-price">100 000</div>
          </div>
        </body></html>
      `);
    });
    const heartbeatError = new Error('heartbeat database unavailable');
    const finishCatalogSource = vi.fn(async () => undefined);
    const repository = {
      startCatalogSource: vi.fn(async () => 'source-heartbeat-failure'),
      finishCatalogSource,
      heartbeatCatalogSource: vi.fn(async () => {
        throw heartbeatError;
      }),
      getActiveCatalogInventoryCounts: vi.fn(async () => ({ products: 0, pages: 0 })),
      upsertProduct: vi.fn(async () => undefined)
    };

    try {
      await expect(syncCatalogFromSitemap({
        sitemapUrl: 'https://bakautprof.ru/heartbeat.xml',
        includeContent: false,
        includeEmbeddings: false,
        requestDelayMs: 0,
        concurrency: 2
      }, repository as never)).rejects.toBe(heartbeatError);
    } finally {
      nowSpy.mockRestore();
    }

    expect(repository.heartbeatCatalogSource).toHaveBeenCalledOnce();
    expect(finishCatalogSource).toHaveBeenCalledWith(
      'source-heartbeat-failure',
      'failed',
      expect.objectContaining({ coverageComplete: false }),
      expect.stringContaining('heartbeat database unavailable'),
      expect.objectContaining({ coverageComplete: false })
    );
  });

  it('fails a non-empty full run before writes when discovered inventory drops sharply', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockImplementation(async () => xmlResponse(`
      <urlset>
        <url><loc>https://bakautprof.ru/catalog/generators/product-one/</loc></url>
        <url><loc>https://bakautprof.ru/catalog/generators/product-two/</loc></url>
      </urlset>
    `));
    const finishCatalogSource = vi.fn(async () => undefined);
    const upsertProduct = vi.fn(async () => undefined);
    const repository = {
      startCatalogSource: vi.fn(async () => 'source-incomplete'),
      finishCatalogSource,
      getActiveCatalogInventoryCounts: vi.fn(async () => ({ products: 100, pages: 0 })),
      upsertProduct
    };

    await expect(syncCatalogFromSitemap({
      sitemapUrl: 'https://bakautprof.ru/incomplete.xml',
      includeContent: false,
      includeEmbeddings: false,
      requestDelayMs: 0
    }, repository as never)).rejects.toThrow('catalog_inventory_coverage_below_threshold:products');

    expect(upsertProduct).not.toHaveBeenCalled();
    expect(finishCatalogSource).toHaveBeenCalledWith(
      'source-incomplete',
      'failed',
      expect.objectContaining({
        productCandidates: 2,
        activeProductsBefore: 100,
        inventoryCoverageSafe: false
      }),
      expect.stringContaining('catalog_inventory_coverage_below_threshold:products'),
      expect.objectContaining({ coverageComplete: false })
    );
  });

  it('applies the same fail-closed inventory guard to content pages', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockImplementation(async () => xmlResponse(`
      <urlset>
        <url><loc>https://bakautprof.ru/articles/only-one-page/</loc></url>
      </urlset>
    `));
    const finishCatalogSource = vi.fn(async () => undefined);
    const upsertCatalogPage = vi.fn(async () => undefined);
    const repository = {
      startCatalogSource: vi.fn(async () => 'source-incomplete-pages'),
      finishCatalogSource,
      getActiveCatalogInventoryCounts: vi.fn(async () => ({ products: 0, pages: 100 })),
      upsertCatalogPage
    };

    await expect(syncCatalogFromSitemap({
      sitemapUrl: 'https://bakautprof.ru/incomplete-pages.xml',
      includeProducts: false,
      includeEmbeddings: false,
      requestDelayMs: 0
    }, repository as never)).rejects.toThrow('catalog_inventory_coverage_below_threshold:pages');

    expect(upsertCatalogPage).not.toHaveBeenCalled();
    expect(finishCatalogSource).toHaveBeenCalledWith(
      'source-incomplete-pages',
      'failed',
      expect.objectContaining({
        contentCandidates: 1,
        activeContentPagesBefore: 100,
        inventoryCoverageSafe: false
      }),
      expect.stringContaining('catalog_inventory_coverage_below_threshold:pages'),
      expect.objectContaining({ coverageComplete: false })
    );
  });

  it('preserves a full initial-catalog bootstrap when no active inventory exists', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockImplementation(async (url) => {
      if (String(url).endsWith('/bootstrap.xml')) {
        return xmlResponse(`
          <urlset>
            <url><loc>https://bakautprof.ru/catalog/generators/bootstrap-product/</loc></url>
          </urlset>
        `);
      }
      return htmlResponse(`
        <html><head><meta property="og:type" content="product"></head><body>
          <div itemscope itemtype="https://schema.org/Product" itemid="${String(url)}">
            <h1>Bootstrap generator</h1>
            <div class="card__main-slider">Bootstrap generator</div>
            <button class="js_favorite" data-id="bootstrap-generator">В избранное</button>
            <div class="card__current-price">100 000</div>
          </div>
        </body></html>
      `);
    });
    const finishCatalogSource = vi.fn(async () => undefined);
    const upsertProduct = vi.fn(async () => undefined);
    const repository = {
      startCatalogSource: vi.fn(async () => 'source-bootstrap'),
      finishCatalogSource,
      heartbeatCatalogSource: vi.fn(async () => undefined),
      getActiveCatalogInventoryCounts: vi.fn(async () => ({ products: 0, pages: 0 })),
      upsertProduct
    };

    const result = await syncCatalogFromSitemap({
      sitemapUrl: 'https://bakautprof.ru/bootstrap.xml',
      includeContent: false,
      includeEmbeddings: false,
      requestDelayMs: 0
    }, repository as never);

    expect(result.importedProducts).toBe(1);
    expect(finishCatalogSource).toHaveBeenCalledWith(
      'source-bootstrap',
      'completed',
      expect.objectContaining({ inventoryCoverageSafe: true }),
      undefined,
      expect.objectContaining({ coverageComplete: true, deactivateProducts: true })
    );
  });
});
