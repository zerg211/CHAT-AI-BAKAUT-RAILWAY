import { describe, expect, it } from 'vitest';
import { classifyCompanyPath, isCompanyPath } from '../src/ai/companyKnowledge.js';
import { readFirstPartyPage } from '../src/ai/siteFirstParty.js';
import type { SafeOutboundFetchResult } from '../src/security/outboundHttp.js';

const BASE = 'https://bakautprof.ru';

function fakeFetch(html: string, status = 200, contentType = 'text/html; charset=utf-8') {
  return async () => ({
    url: BASE + '/x',
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
    const html = '<html><body><h1>Генератор Tecener TE6000GLIS</h1><div>Артикул: 1110511</div></body></html>';
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
      fetchBytes: fakeFetch('', 200, 'application/pdf') as never
    });
    expect(binary.ok).toBe(false);
    if (!binary.ok) expect(binary.failure.code).toBe('unsupported');
  });
});
