import { describe, expect, it, vi } from 'vitest';
import { fetch } from 'undici';

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
});
