import { describe, expect, it, vi } from 'vitest';
import { fetch } from 'undici';
import type { CatalogPageInput, CatalogProductInput } from '../src/shared/types.js';

vi.mock('undici', () => ({
  fetch: vi.fn()
}));

const { syncCatalogFromSitemap } = await import('../src/catalog/sitemapSync.js');

function xmlResponse(xml: string) {
  return {
    status: 200,
    text: async () => xml
  } as Awaited<ReturnType<typeof fetch>>;
}

describe('sitemap sync no-regex XML parsing', () => {
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
            <div itemscope itemtype="https://schema.org/Product">
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
});
