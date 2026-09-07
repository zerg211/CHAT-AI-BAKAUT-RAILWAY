import * as cheerio from 'cheerio';
import { config } from '../config.js';
import type { Product } from '../shared/types.js';
import { compactModelText } from '../ai/modelTextMatching.js';
import { safeFetchBytes, outboundText } from '../security/outboundHttp.js';
import { cleanText } from './normalize.js';

export type VerifiedSitePrice = { productId: string; productName: string; previousPrice: number | null;
  price: number; currency: 'RUB'; sourceUrl: string; observedAt: string; evidence: string };

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

export async function readCurrentSitePrice(product: Product, signal?: AbortSignal): Promise<VerifiedSitePrice> {
  if (!product.sourceUrl || new URL(product.sourceUrl).origin !== new URL(config.CATALOG_BASE_URL).origin) throw new Error('site_price_source_untrusted');
  const result = await safeFetchBytes(product.sourceUrl, { allowedOrigin:config.CATALOG_BASE_URL,
    timeoutMs:7_000, maxBytes:config.CATALOG_MAX_RESPONSE_BYTES, maxRedirects:2, signal,
    headers:{'user-agent':'Bakaut catalog price verification'} });
  if (result.status !== 200) throw new Error('site_price_http_error');
  const price = extractCurrentSitePrice(outboundText(result), product, result.url, config.CATALOG_BASE_URL);
  if (!price) throw new Error('site_price_identity_or_value_unconfirmed');
  return price;
}
