import { diagnosticSpan, diagnosticEvent, diagnosticError } from '../observability/diagnostics.js';
import * as cheerio from 'cheerio';
import { config } from '../config.js';
import type { Product } from '../shared/types.js';
import { compactModelText } from '../ai/modelTextMatching.js';
import { safeFetchBytes, outboundText } from '../security/outboundHttp.js';
import { cleanText } from './normalize.js';
import {singleflightPriceReader} from './priceSingleflight.js';

export type VerifiedSitePrice = { productId: string; productName: string; previousPrice: number | null;
  price: number; currency: 'RUB'; sourceUrl: string; observedAt: string; evidence: string };

export function sitePriceErrorCode(error: unknown): string {
  if (!(error instanceof Error)) return 'site_price_unknown_error';
  if (error.name === 'TimeoutError' || error.name === 'AbortError') return 'site_price_timeout';
  const known = ['site_price_source_untrusted','site_price_http_error','site_price_identity_or_value_unconfirmed','site_price_persistence_conflict','site_price_circuit_open','site_price_verification_deferred'];
  return known.includes(error.message) ? error.message : 'site_price_fetch_or_storage_error';
}

function strictPrice(text: string) {
  const value = [...text.normalize('NFKC')].filter(char => char.trim() !== '' && char !== '₽').join('').replace(',', '.');
  if (!value || [...value].some(char => !'0123456789.'.includes(char)) || value.split('.').length > 2) return null;
  const price = Number(value);
  return Number.isFinite(price) && price > 0 ? price : null;
}

export function extractCurrentSitePrice(html: string, product: Product, pageUrl: string, baseUrl: string): VerifiedSitePrice | null {
  if (!product.sourceUrl) return null;
  const actual = new URL(pageUrl), expected = new URL(product.sourceUrl), base = new URL(baseUrl);
  if (actual.origin !== base.origin || expected.origin !== base.origin || actual.pathname !== expected.pathname) return null;
  const $ = cheerio.load(html);
  const heading = cleanText($('h1').first().text());
  // A price is attached to the complete catalog identity, never another variant
  // mentioned in recommendations or supplied in the buyer's message.
  if (compactModelText(heading) !== compactModelText(product.name)) return null;
  const blocks = $('.card__prices[itemprop="offers"]').toArray();
  if (blocks.length !== 1) return null;
  const prices = blocks.flatMap(block => {
    const offer = $(block);
    const currency = offer.find('[itemprop="priceCurrency"]').attr('content');
    const machine = strictPrice(offer.find('[itemprop="price"]').attr('content') ?? '');
    const visible = strictPrice(offer.find('.card__current-price').first().text());
    return currency === 'RUB' && machine !== null && machine === visible ? [{price:machine, evidence:cleanText(offer.find('.card__current-price').first().text())}] : [];
  });
  if (prices.length !== 1) return null;
  return { productId: product.id, productName: product.name, previousPrice: product.price ?? null,
    price: prices[0].price, currency: 'RUB', sourceUrl: actual.toString(), observedAt: new Date().toISOString(), evidence: prices[0].evidence };
}

async function fetchCurrentSitePrice(product: Product): Promise<VerifiedSitePrice> {
  if (!product.sourceUrl || new URL(product.sourceUrl).origin !== new URL(config.CATALOG_BASE_URL).origin) throw new Error('site_price_source_untrusted');
  const result = await diagnosticSpan('catalog.price.fetch', async () => safeFetchBytes(product.sourceUrl!, { allowedOrigin:config.CATALOG_BASE_URL,
    timeoutMs:Math.min(15_000,config.CATALOG_REQUEST_TIMEOUT_MS), maxBytes:config.CATALOG_MAX_RESPONSE_BYTES, maxRedirects:2,
    headers:{'user-agent':'Bakaut catalog price verification'} }));
  if (result.status !== 200) throw new Error('site_price_http_error');
  const price = extractCurrentSitePrice(outboundText(result), product, result.url, config.CATALOG_BASE_URL);
  if (!price) throw new Error('site_price_identity_or_value_unconfirmed');
  return price;
}

export const readCurrentSitePrice=singleflightPriceReader(fetchCurrentSitePrice,()=>config.CATALOG_BASE_URL,{ttlMs:10_000});

export type SitePriceObservation =
  | { status: 'priced'; productId: string; price: number; sourceUrl: string; observedAt: string }
  | { status: 'on_request'; productId: string; sourceUrl: string; observedAt: string }
  | { status: 'unknown'; productId: string };

/** Verify the exact catalog URL and product heading before interpreting its own offer. */
export function extractSitePriceObservation(html: string, product: Product, pageUrl: string, baseUrl: string): SitePriceObservation {
  const unknown: SitePriceObservation = { status: 'unknown', productId: product.id };
  if (!product.id || !product.sourceUrl) return unknown;
  let actual: URL, expected: URL, base: URL;
  try { actual = new URL(pageUrl); expected = new URL(product.sourceUrl); base = new URL(baseUrl); } catch { return unknown; }
  if (actual.protocol !== 'https:' || actual.origin !== base.origin || expected.origin !== base.origin || actual.pathname !== expected.pathname || actual.search || expected.search) return unknown;
  const $ = cheerio.load(html);
  if (compactModelText(cleanText($('h1').first().text())) !== compactModelText(product.name)) return unknown;
  const blocks = $('.card__prices[itemprop="offers"]');
  if (!blocks.length) {
    // A complete primary product card without any price markup is distinguishable
    // from a partial page or an unrecognised price layout.
    const primary = $('main .card');
    const side = primary.find('.card__side');
    if (primary.length === 1 && side.length === 1 && side.find('.card__btn--request').length === 1 && !side.find('[itemprop="price"], [class*="price"]').length) {
      return { status: 'on_request', productId: product.id, sourceUrl: actual.toString(), observedAt: new Date().toISOString() };
    }
    return unknown;
  }
  if (blocks.length !== 1) return unknown;
  const verified = extractCurrentSitePrice(html, product, pageUrl, baseUrl);
  if (verified) return { status: 'priced', productId: product.id, price: verified.price, sourceUrl: verified.sourceUrl, observedAt: verified.observedAt };
  const block = blocks.first();
  const visible = cleanText(block.find('.card__current-price').first().text()).toLocaleLowerCase('ru');
  const machine = block.find('[itemprop="price"]').attr('content');
  // An explicit on-request label is required; a blank, hidden or malformed price is unknown.
  if (!machine && block.find('.card__current-price').length === 1 &&
      (visible === '' || visible === 'по запросу' || visible === 'цена по запросу' || visible === 'под заказ')) {
    return { status: 'on_request', productId: product.id, sourceUrl: actual.toString(), observedAt: new Date().toISOString() };
  }
  return unknown;
}

export async function readSitePriceObservation(product: Product, signal?: AbortSignal): Promise<SitePriceObservation> {
  const unknown: SitePriceObservation = { status: 'unknown', productId: product.id };
  if (!product.sourceUrl) { diagnosticEvent('catalog.price.result', { outcome: 'unknown', basis: 'missing_source' }); return unknown; }
  try {
    const expected = new URL(product.sourceUrl);
    if (expected.protocol !== 'https:' || expected.origin !== 'https://bakautprof.ru') return unknown;
    const result = await diagnosticSpan('catalog.price.fetch', async () => safeFetchBytes(product.sourceUrl!, { allowedOrigin: 'https://bakautprof.ru',
      timeoutMs: 5000, maxBytes: config.CATALOG_MAX_RESPONSE_BYTES, maxRedirects: 2, signal,
      headers: { 'user-agent': 'Bakaut catalog price verification' } }));
    const observation = result.status === 200 ? extractSitePriceObservation(outboundText(result), product, result.url, 'https://bakautprof.ru') : unknown;
    diagnosticEvent('catalog.price.result', { statusCode: result.status, outcome: observation.status });
    return observation;
  } catch (error) { diagnosticError('catalog.price.failed', error, { outcome: 'unknown', aborted: Boolean(signal?.aborted) }); return unknown; }
}
