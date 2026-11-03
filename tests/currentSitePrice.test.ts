import { describe, expect, it } from 'vitest';
import { extractCurrentSitePrice, extractSitePriceObservation, sitePriceErrorCode } from '../src/catalog/currentSitePrice.js';
import type { Product } from '../src/shared/types.js';

const product: Product = { id:'price-product',name:'Wacker Neuson BPS 1550 Gw-c CE',price:160000,
  currency:'RUB',sourceUrl:'https://bakautprof.ru/catalog/exact-model/',specs:{} };
const offer = (visible='165 000 ₽',machine='165000',currency='RUB') =>
  `<div class="card__prices" itemprop="offers"><meta itemprop="priceCurrency" content="${currency}"><meta itemprop="price" content="${machine}"><span class="card__current-price">${visible}</span><del>190 000 ₽</del></div>`;
const page = (body=offer(),name=product.name) => `<h1>${name}</h1>${body}`;
const parse = (html:string,url=product.sourceUrl!) => extractCurrentSitePrice(html,product,url,'https://bakautprof.ru');

describe('authoritative company product price',()=>{
  it('distinguishes a timeout without exposing arbitrary provider or database text',()=>{
    const timeout=new Error('internal detail');timeout.name='TimeoutError';
    expect(sitePriceErrorCode(timeout)).toBe('site_price_timeout');
    expect(sitePriceErrorCode(new Error('private database detail'))).toBe('site_price_fetch_or_storage_error');
  });
  it('uses current price, preserves previous price and binds full identity and source',()=>{
    expect(parse(page())).toMatchObject({productId:product.id,previousPrice:160000,price:165000,currency:'RUB',sourceUrl:product.sourceUrl});
  });
  it.each([
    page(offer(),'Wacker Neuson BPS 1550 Gw-c'),
    page(offer('160 000 ₽')),
    page(offer('от 165 000 ₽')),
    page(offer('Цена по запросу')),
    page(offer('-1','-1')),
    page(offer('165000','165000','USD')),
    page(offer()+offer()),
    page(offer()+offer('неизвестно')),
    page('<p>Покупатель сообщил цену 165000</p>')
  ])('rejects ambiguous, unconfirmed or mismatched data',html=>expect(parse(html)).toBeNull());
  it.each(['https://other.example/catalog/exact-model/','https://bakautprof.ru/catalog/another-model/'])(
    'rejects a different page or origin',url=>expect(parse(page(),url)).toBeNull());
  it('distinguishes an explicit on-request offer from an inaccessible or ambiguous price', () => {
    const onRequest = page('<div class="card__prices" itemprop="offers"><span class="card__current-price">По запросу</span></div>');
    const observe = (html: string, url = product.sourceUrl!) => extractSitePriceObservation(html, product, url, 'https://bakautprof.ru');
    expect(observe(onRequest)).toMatchObject({ status: 'on_request', productId: product.id, sourceUrl: product.sourceUrl });
    expect(observe(page('<div class="card__prices" itemprop="offers"></div>')).status).toBe('unknown');
    expect(observe(`<main><h1>${product.name}</h1><div class="card"><div class="card__side"><button class="card__btn--request">Запрос</button></div></div></main>`).status).toBe('on_request');
    expect(observe(`<main><h1>${product.name}</h1><div class="card"><div class="card__side"><span class="other-price">123</span></div></div></main>`).status).toBe('unknown');
    expect(observe(onRequest, 'https://bakautprof.ru/catalog/wrong/').status).toBe('unknown');
    expect(observe(page(offer())).status).toBe('priced');
    expect(observe(page(offer(), 'Другая модель')).status).toBe('unknown');
  });

});
