import { describe, expect, it } from 'vitest';
import { classifyCompanyPath, isCompanyPath } from '../src/ai/companyKnowledge.js';
import { readFirstPartyPage } from '../src/ai/siteFirstParty.js';
import type { SafeOutboundFetchResult } from '../src/security/outboundHttp.js';

const BASE = 'https://bakautprof.ru';

function fakeFetch(html: string, status = 200, contentType = 'text/html; charset=utf-8') {
  return async (url: string) => ({
    url,
    status,
    headers: new Headers({ 'content-type': contentType }),
    bytes: new TextEncoder().encode(html)
  }) as SafeOutboundFetchResult;
}

describe('company knowledge classification', () => {
  it('classifies company roots with STABLE volatility for contacts', () => {
    expect(classifyCompanyPath('/contacts/')).toMatchObject({ kind: 'company_contacts', volatility: 'STABLE' });
    expect(classifyCompanyPath('/delivery-and-payment/')).toMatchObject({ kind: 'company_delivery', volatility: 'SEMI_VOLATILE' });
    expect(classifyCompanyPath('/about')).toMatchObject({ kind: 'company_about', volatility: 'STABLE' });
    expect(isCompanyPath('/catalog/dizelnye_generatory/')).toBe(false);
    expect(isCompanyPath('/garantiya/')).toBe(true);
  });
});

describe('first-party page read', () => {
  it('preserves URL representation, footer/table facts and exposes resumable text ranges', async () => {
    const url = BASE + '/contacts/?branch=kazan#hours';
    const html = '<body><h1>Контакты</h1><main><p>' + 'Описание '.repeat(1300) +
      '</p></main><footer><table><tr><th>Казань</th><td>Суббота 10–16</td></tr></table></footer></body>';
    const targets: string[] = [];
    const fetchBytes = async (target: string) => { targets.push(target); return fakeFetch(html)(target); };
    const first = await readFirstPartyPage(url, { baseUrl: BASE, fetchBytes });
    expect(targets[0]).toBe(BASE + '/contacts/?branch=kazan');
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.page.readRange.complete).toBe(false);
    const second = await readFirstPartyPage(url, { baseUrl: BASE, fetchBytes, offset: first.page.readRange.nextOffset! });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.page.text).toContain('Казань | Суббота 10–16');
    expect(second.page.readRange.nextOffset).toBeNull();
    expect(second.page.sourceFingerprint).toBe(first.page.sourceFingerprint);
    const changed = await readFirstPartyPage(url, { baseUrl: BASE, fetchBytes: fakeFetch(html.replace('10–16', '11–17')) });
    if (!changed.ok) throw new Error('read failed');
    expect(changed.page.sourceFingerprint).not.toBe(first.page.sourceFingerprint);
    const mixed = await readFirstPartyPage(url, { baseUrl: BASE, fetchBytes: fakeFetch(html.replace('10–16', '11–17')),
      offset: first.page.readRange.nextOffset!, expectedSourceFingerprint: first.page.sourceFingerprint });
    expect(mixed).toMatchObject({ ok: false, failure: { code: 'source_changed' } });
  });

  it('uses the final URL for identity and does not classify a category path as a product', async () => {
    const result = await readFirstPartyPage(BASE + '/catalog/type/long_category_name/', {
      baseUrl: BASE, fetchBytes: async () => fakeFetch('<body><h1>Контакты</h1><p>Адрес офиса</p></body>')(BASE + '/contacts?office=2')
    });
    if (!result.ok) throw new Error('read failed');
    expect(result.page.canonicalUrl).toBe(BASE + '/contacts?office=2');
    expect(result.page.pageKind).toBe('company');
    const category = await readFirstPartyPage(BASE + '/catalog/type/long_category_name/', {
      baseUrl: BASE, fetchBytes: fakeFetch('<body><h1>Каталог генераторов</h1><p>Список моделей</p></body>')
    });
    if (!category.ok) throw new Error('read failed');
    expect(category.page.pageKind).toBe('other');
  });

  it('denies foreign origins without any fetch', async () => {
    let calls = 0;
    const result = await readFirstPartyPage('https://example.com/catalog/x/', {
      baseUrl: BASE,
      fetchBytes: (async () => { calls += 1; throw new Error('must not fetch'); }) as never
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.code).toBe('denied');
    expect(calls).toBe(0);
  });

  it('reads a product page identity including the article', async () => {
    const html = '<html><body><h1>Генератор Tecener TE6000GLIS</h1><div>Артикул: 1110511</div>' +
      '<script type="application/ld+json">{"@type":"Product","url":"https://bakautprof.ru/catalog/invertornye_generatory/generator_tecener_te6000glis_1110511/"}</script></body></html>';
    const result = await readFirstPartyPage('https://bakautprof.ru/catalog/invertornye_generatory/generator_tecener_te6000glis_1110511/', {
      baseUrl: BASE,
      fetchBytes: fakeFetch(html) as never
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.page.pageKind).toBe('product');
      expect(result.page.productIdentity).toMatchObject({ title: 'Генератор Tecener TE6000GLIS', article: '1110511' });
      expect(result.page.sourceFingerprint).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('reads a company page with kind and snippet', async () => {
    const html = '<html><body><h1>Контакты</h1><p>Москва, Тюменский проезд, 3, корпус 6. Телефон 8 800 550-88-71.</p></body></html>';
    const result = await readFirstPartyPage('https://bakautprof.ru/contacts/', {
      baseUrl: BASE,
      fetchBytes: fakeFetch(html) as never
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.page.pageKind).toBe('company');
      expect(result.page.companyInfo).toMatchObject({ kind: 'company_contacts', volatility: 'STABLE' });
      expect(result.page.companyInfo!.snippet).toContain('Тюменский');
    }
  });

  it('maps fetch timeout to timeout, never to absence', async () => {
    const timeout = async () => {
      const error = new Error('fetch failed');
      error.name = 'TimeoutError';
      throw error;
    };
    const result = await readFirstPartyPage('https://bakautprof.ru/catalog/x/', {
      baseUrl: BASE,
      fetchBytes: timeout as never
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.code).toBe('timeout');
  });

  it('maps non-200 to http_status and binaries to unsupported', async () => {
    const missing = await readFirstPartyPage('https://bakautprof.ru/catalog/gone/', {
      baseUrl: BASE,
      fetchBytes: fakeFetch('', 404) as never
    });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.failure.code).toBe('http_status');
    const binary = await readFirstPartyPage('https://bakautprof.ru/file.pdf', {
      baseUrl: BASE,
      fetchBytes: fakeFetch('', 200, 'application/zip') as never
    });
    expect(binary.ok).toBe(false);
    if (!binary.ok) expect(binary.failure.code).toBe('unsupported');
  });
});
