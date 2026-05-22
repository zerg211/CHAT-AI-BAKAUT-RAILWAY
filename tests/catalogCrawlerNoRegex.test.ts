import { describe, expect, it, vi } from 'vitest';
import { fetch } from 'undici';

vi.mock('undici', () => ({
  fetch: vi.fn()
}));

const { inventoryCatalogFromSite } = await import('../src/catalog/crawler.js');

function responseWithHtml(html: string) {
  return {
    ok: true,
    status: 200,
    text: async () => html
  } as Awaited<ReturnType<typeof fetch>>;
}

describe('catalog crawler no-regex parsing', () => {
  it('keeps catalog link filtering and spec extraction behavior', async () => {
    const baseUrl = 'https://example.test';
    const fetchedUrls: string[] = [];
    const fetchMock = vi.mocked(fetch);

    fetchMock.mockImplementation(async (url, _init) => {
      const urlText = String(url);
      fetchedUrls.push(urlText);
      if (urlText.endsWith('/catalog/')) {
        return responseWithHtml(`
          <a href="/catalog/generators/tss-sgg-10000eha/">generator</a>
          <a href="/catalog/generators/signal-product/">signal product</a>
          <a href="/catalog/generators/manual.pdf">manual</a>
          <a href="/catalog/generators/filter-is-brand/">filter</a>
        `);
      }
      if (urlText.endsWith('/catalog/generators/signal-product/')) {
        return responseWithHtml(`
          <html itemscope itemtype="https://schema.org/Product">
            <h1>Signal Product</h1>
            <div>КУПИТЬ</div>
          </html>
        `);
      }
      return responseWithHtml(`
        <html itemscope itemtype="https://schema.org/Product">
          <h1>Generator TSS SGG 10000EHA</h1>
          <div class="params">
            <li>Power — 10 kW</li>
            <li>Start: electric</li>
            <li>Voltage - 220 V</li>
          </div>
        </html>
      `);
    });

    const repository = {
      listProductSourceUrls: vi.fn(async () => [])
    };

    const result = await inventoryCatalogFromSite(
      { baseUrl, startPath: '/catalog/', maxPages: 5 },
      repository as never
    );

    expect(fetchedUrls).toContain('https://example.test/catalog/');
    expect(fetchedUrls).toContain('https://example.test/catalog/generators/tss-sgg-10000eha/');
    expect(fetchedUrls).toContain('https://example.test/catalog/generators/signal-product/');
    expect(fetchedUrls.some((url) => url.endsWith('.pdf'))).toBe(false);
    expect(fetchedUrls.some((url) => url.includes('-is-'))).toBe(false);
    expect(result.missingCount).toBe(2);
    expect(result.missingProducts.map((product) => product.sourceUrl)).toContain('https://example.test/catalog/generators/tss-sgg-10000eha/');
    expect(result.missingProducts.map((product) => product.name)).toContain('Generator TSS SGG 10000EHA');
    expect(result.missingProducts.map((product) => product.name)).toContain('Signal Product');
  });
});
