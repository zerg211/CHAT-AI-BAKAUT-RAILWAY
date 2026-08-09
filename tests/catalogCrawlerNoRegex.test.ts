import { describe, expect, it, vi } from 'vitest';
import { fetch } from 'undici';

vi.mock('undici', () => ({
  fetch: vi.fn(),
  Agent: class {
    async close() {}
  }
}));

vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(async () => [{ address: '93.184.216.34', family: 4 }])
}));

vi.mock('../src/ai/openaiClient.js', () => ({
  createEmbedding: vi.fn(async () => null)
}));

const { inventoryCatalogFromSite, syncCatalogFromSite } = await import('../src/catalog/crawler.js');

function responseWithHtml(html: string) {
  return new Response(html, { status: 200, headers: { 'content-type': 'text/html' } }) as unknown as Awaited<ReturnType<typeof fetch>>;
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
          <html itemscope itemtype="https://schema.org/Product" itemid="https://example.test/catalog/generators/signal-product/">
            <head><meta property="og:type" content="product"></head>
            <h1>Signal Product</h1>
            <div class="card__main-slider">Signal Product</div>
            <button class="js_favorite" data-id="signal-product">В избранное</button>
            <div>КУПИТЬ</div>
          </html>
        `);
      }
      return responseWithHtml(`
        <html itemscope itemtype="https://schema.org/Product" itemid="https://example.test/catalog/generators/tss-sgg-10000eha/">
          <head><meta property="og:type" content="product"></head>
          <h1>Generator TSS SGG 10000EHA</h1>
          <div class="card__main-slider">Generator TSS SGG 10000EHA</div>
          <button class="js_favorite" data-id="tss-sgg-10000eha">В избранное</button>
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

  it('fails a crawler sync when an in-loop heartbeat update fails', async () => {
    let currentTime = 0;
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => currentTime);
    vi.mocked(fetch).mockImplementation(async () => {
      currentTime = 20_000;
      return responseWithHtml(`
        <html itemscope itemtype="https://schema.org/Product" itemid="https://example.test/catalog/heartbeat-product/">
          <head><meta property="og:type" content="product"></head>
          <h1>Heartbeat crawler product</h1>
          <div class="card__main-slider">Heartbeat crawler product</div>
          <button class="js_favorite" data-id="heartbeat-product">В избранное</button>
        </html>
      `);
    });
    const heartbeatError = new Error('crawler heartbeat failed');
    const finishCatalogSource = vi.fn(async () => undefined);
    const repository = {
      startCatalogSource: vi.fn(async () => 'crawler-heartbeat-run'),
      heartbeatCatalogSource: vi.fn(async () => {
        throw heartbeatError;
      }),
      finishCatalogSource,
      upsertProduct: vi.fn(async () => undefined)
    };

    try {
      await expect(syncCatalogFromSite({
        baseUrl: 'https://example.test',
        startPath: '/catalog/',
        maxPages: 1
      }, repository as never)).rejects.toBe(heartbeatError);
    } finally {
      nowSpy.mockRestore();
    }

    expect(repository.heartbeatCatalogSource).toHaveBeenCalledOnce();
    expect(finishCatalogSource).toHaveBeenCalledWith(
      'crawler-heartbeat-run',
      'failed',
      expect.objectContaining({ coverageComplete: false }),
      expect.stringContaining('crawler heartbeat failed'),
      expect.objectContaining({ coverageComplete: false })
    );
  });

  it('wraps import-missing inventory mutations in the shared partial-sync lifecycle', async () => {
    let currentTime = 0;
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => currentTime);
    vi.mocked(fetch).mockImplementation(async () => {
      currentTime = 20_000;
      return responseWithHtml(`
        <html itemscope itemtype="https://schema.org/Product" itemid="https://example.test/catalog/inventory-import-product/">
          <head><meta property="og:type" content="product"></head>
          <h1>Inventory import product</h1>
          <div class="card__main-slider">Inventory import product</div>
          <button class="js_favorite" data-id="inventory-import-product">В избранное</button>
          <div>КУПИТЬ</div>
        </html>
      `);
    });
    const finishCatalogSource = vi.fn(async () => undefined);
    const repository = {
      startCatalogSource: vi.fn(async () => 'inventory-import-run'),
      heartbeatCatalogSource: vi.fn(async () => undefined),
      finishCatalogSource,
      listProductSourceUrls: vi.fn(async () => []),
      upsertProduct: vi.fn(async () => undefined)
    };

    let result;
    try {
      result = await inventoryCatalogFromSite({
        baseUrl: 'https://example.test',
        startPath: '/catalog/inventory-import-product/',
        maxPages: 1,
        importMissing: true
      }, repository as never);
    } finally {
      nowSpy.mockRestore();
    }

    expect(result?.importedMissing).toBe(1);
    expect(repository.startCatalogSource).toHaveBeenCalledWith({
      type: 'site_crawl',
      location: 'https://example.test/catalog/inventory-import-product/',
      syncMode: 'partial'
    });
    expect(repository.heartbeatCatalogSource).toHaveBeenCalledOnce();
    expect(repository.upsertProduct).toHaveBeenCalledOnce();
    expect(finishCatalogSource).toHaveBeenCalledWith(
      'inventory-import-run',
      'completed',
      expect.objectContaining({ importedMissing: 1, coverageComplete: false }),
      undefined,
      expect.objectContaining({ coverageComplete: false, syncedItemCount: 1 })
    );
  });
});
