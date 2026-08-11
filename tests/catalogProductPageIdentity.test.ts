import { describe, expect, it } from 'vitest';
import { extractProduct as extractCrawlerProduct } from '../src/catalog/crawler.js';
import { hasPageSpecificProductEvidence } from '../src/catalog/productPageIdentity.js';
import { extractProduct as extractSitemapProduct } from '../src/catalog/sitemapSync.js';

const categoryUrl = 'https://bakautprof.ru/catalog/vibroplity/';
const productUrl = 'https://bakautprof.ru/catalog/vibroplity/wacker-mp12/';

describe('catalog product page identity', () => {
  it('rejects a listing page that only contains child Product/Offer cards', () => {
    const html = `
      <html><head><link rel="canonical" href="${categoryUrl}"></head><body>
        <h1>Виброплиты</h1>
        <section class="catalog-list">
          <article itemscope itemtype="https://schema.org/Product">
            <a itemprop="url" href="${productUrl}"><span itemprop="name">Wacker Neuson MP12</span></a>
            <div itemprop="offers" itemscope itemtype="https://schema.org/Offer">
              <span class="card__current-price" itemprop="price">80 000</span>
            </div>
          </article>
        </section>
      </body></html>`;

    expect(hasPageSpecificProductEvidence(html, categoryUrl)).toBe(false);
    expect(extractCrawlerProduct(html, categoryUrl, 'https://bakautprof.ru/')).toBeNull();
    expect(extractSitemapProduct({ url: categoryUrl, status: 200, html }, 'https://bakautprof.ru/')).toBeNull();
  });

  it('rejects a listing even when shared detail and price classes are present', () => {
    const html = `
      <html><body>
        <h1>Виброплиты</h1>
        <div class="card__main-slider">Популярные модели</div>
        <article>
          <button class="js_favorite" data-id="123">В избранное</button>
          <div class="card__current-price">80 000 ₽</div>
        </article>
        <article>
          <button class="js_favorite" data-id="456">В избранное</button>
          <div class="card__current-price">95 000 ₽</div>
        </article>
      </body></html>`;

    expect(hasPageSpecificProductEvidence(html, categoryUrl)).toBe(false);
    expect(extractCrawlerProduct(html, categoryUrl, 'https://bakautprof.ru/')).toBeNull();
    expect(extractSitemapProduct({ url: categoryUrl, status: 200, html }, 'https://bakautprof.ru/')).toBeNull();
  });

  it('rejects a listing without product ids even when shared detail classes look like a product page', () => {
    const html = `
      <html><body>
        <h1>Виброплиты</h1>
        <div class="card__main-slider">Популярные модели</div>
        <div class="props-list">Подбор по характеристикам</div>
        <article>
          <a href="${productUrl}">Wacker Neuson MP12</a>
          <div class="card__current-price">80 000 ₽</div>
        </article>
        <article>
          <a href="https://bakautprof.ru/catalog/vibroplity/wacker-mp15/">Wacker Neuson MP15</a>
          <div class="card__current-price">95 000 ₽</div>
        </article>
      </body></html>`;

    expect(hasPageSpecificProductEvidence(html, categoryUrl)).toBe(false);
    expect(extractCrawlerProduct(html, categoryUrl, 'https://bakautprof.ru/')).toBeNull();
    expect(extractSitemapProduct({ url: categoryUrl, status: 200, html }, 'https://bakautprof.ru/')).toBeNull();
  });

  it('rejects a sparse one-result listing whose only child reuses the complete detail layout', () => {
    const html = `
      <html><body>
        <h1>Виброплиты</h1>
        <section class="catalog-list">
          <article>
            <div class="card__main-slider"><img src="/mp12.jpg"></div>
            <div class="product-caption__item">Артикул: MP12</div>
            <button class="js_favorite" data-id="123">В избранное</button>
            <div class="card__current-price">80 000 ₽</div>
            <a href="${productUrl}">Wacker Neuson MP12</a>
          </article>
        </section>
      </body></html>`;

    expect(hasPageSpecificProductEvidence(html, categoryUrl)).toBe(false);
    expect(extractCrawlerProduct(html, categoryUrl, 'https://bakautprof.ru/')).toBeNull();
    expect(extractSitemapProduct({ url: categoryUrl, status: 200, html }, 'https://bakautprof.ru/')).toBeNull();
  });

  it('rejects a listing with a false og product declaration when no identity is bound to the page', () => {
    const html = `
      <html><head>
        <meta property="og:type" content="product">
        <link rel="canonical" href="${categoryUrl}">
      </head><body>
        <h1>Виброплиты</h1>
        <section class="catalog-list">
          <article itemscope itemtype="https://schema.org/Product">
            <a itemprop="url" href="${productUrl}"><span itemprop="name">Wacker Neuson MP12</span></a>
            <div itemprop="offers" itemscope itemtype="https://schema.org/Offer">
              <span class="card__current-price" itemprop="price">80 000</span>
            </div>
          </article>
        </section>
      </body></html>`;

    expect(hasPageSpecificProductEvidence(html, categoryUrl)).toBe(false);
    expect(extractCrawlerProduct(html, categoryUrl, 'https://bakautprof.ru/')).toBeNull();
    expect(extractSitemapProduct({ url: categoryUrl, status: 200, html }, 'https://bakautprof.ru/')).toBeNull();
  });

  it('accepts an exact JSON-LD Product bound to the current page URL', () => {
    const html = `
      <html><head>
        <script type="application/ld+json">${JSON.stringify({
          '@context': 'https://schema.org',
          '@type': 'Product',
          name: 'Wacker Neuson MP12',
          url: productUrl,
          offers: { '@type': 'Offer', price: '80000' }
        })}</script>
      </head><body><h1>Wacker Neuson MP12</h1></body></html>`;

    expect(hasPageSpecificProductEvidence(html, productUrl)).toBe(true);
  });

  it('accepts the Bakaut detail layout with one page-level product identity', () => {
    const html = `
      <html><body>
        <h1>Wacker Neuson MP12</h1>
        <div class="card__main-slider"><img src="/mp12.jpg"></div>
        <div class="product-caption__item">Артикул: MP12</div>
        <button class="js_favorite" data-id="123">В избранное</button>
        <div class="card__current-price">80 000 ₽</div>
      </body></html>`;

    expect(hasPageSpecificProductEvidence(html, productUrl)).toBe(true);
  });

  it('accepts a detail page when its Product scope also contains related-card ids', () => {
    const detailUrl = 'https://bakautprof.ru/catalog/vibroplity/vibroplita_pryamokhodnaya_benzinovaya_wacker_neuson_bps_1550_aw_89_kg/';
    const html = `
      <html><body>
        <main itemscope itemtype="https://schema.org/Product">
          <h1>Виброплита прямоходная бензиновая Wacker Neuson BPS 1550 Aw (89 кг)</h1>
          <div class="card__main-slider"><img src="/bps.jpg"></div>
          <div class="product-caption__item">Артикул 5100061216</div>
          <button class="js_favorite" data-id="2813">В избранное</button>
          <div class="card__current-price">260 000 ₽</div>
          <section class="related-products">
            <button class="js_favorite" data-id="2700">В избранное</button>
          </section>
        </main>
      </body></html>`;

    expect(hasPageSpecificProductEvidence(html, detailUrl)).toBe(true);
  });
});
