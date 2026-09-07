import { describe, expect, it } from 'vitest';
import { extractCurrentSitePrice } from '../src/catalog/currentSitePrice.js';
import type { Product } from '../src/shared/types.js';

const product: Product = { id:'price-product',name:'Wacker Neuson BPS 1550 Gw-c CE',price:160000,
  currency:'RUB',sourceUrl:'https://bakautprof.ru/catalog/exact-model/',specs:{} };
const offer = (visible='165 000 ₽',machine='165000',currency='RUB') =>
  `<div class="card__prices" itemprop="offers"><meta itemprop="priceCurrency" content="${currency}"><meta itemprop="price" content="${machine}"><span class="card__current-price">${visible}</span><del>190 000 ₽</del></div>`;
const page = (body=offer(),name=product.name) => `<h1>${name}</h1>${body}`;
const parse = (html:string,url=product.sourceUrl!) => extractCurrentSitePrice(html,product,url,'https://bakautprof.ru');

describe('authoritative company product price',()=>{
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
});
