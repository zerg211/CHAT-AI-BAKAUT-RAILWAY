import { describe, it, expect, vi } from 'vitest';
import { verifyBudgetPrices } from '../src/catalog/verifyBudgetPrices.js';
import { validateToolResultOutput } from '../src/ai/agentManagerToolRegistry.js';
import type { Product } from '../src/shared/types.js';

describe('company price evidence before budget selection', () => {
  const products = [
    {id:'sgg5000',name:'SGG 5000Ei',price:64558,currency:'RUB',specs:{power:'5 кВт'}},
    {id:'sgg6000',name:'SGG 6000Ei',price:80377,currency:'RUB',specs:{power:'6 кВт'}}
  ] as Product[];
  const read = async(product:Product) => ({productId:product.id,productName:product.name,
    previousPrice:product.price!,price:product.id==='sgg5000'?78240:98930,currency:'RUB' as const,
    sourceUrl:'https://bakautprof.ru/catalog/'+product.id,observedAt:'2026-09-07T16:22:20Z',evidence:'company page'});
  it('replaces both stale prices before the consumer evaluates the 90000 budget',async()=>{
    const persist=vi.fn(async(proof)=>({...products.find(p=>p.id===proof.productId)!,price:proof.price}));
    const result=await verifyBudgetPrices({products,read,persist});
    expect(result.products.map(p=>p.price)).toEqual([78240,98930]);
    expect(result.products.filter(p=>typeof p.price==='number'&&p.price<=90000).map(p=>p.id)).toEqual(['sgg5000']);
    expect(persist).toHaveBeenCalledTimes(2);
    expect(()=>validateToolResultOutput({tool:'catalog.search',requestId:'search',status:'ok',warnings:[],
      payload:{priceVerifications:result.proofs}})).not.toThrow();
    expect(products[1].price).toBe(80377);
  });
  it('keeps an unpriced technical candidate without publishing the stale price as current',async()=>{
    const persist=vi.fn();
    const result=await verifyBudgetPrices({products:[products[0]],read:async()=>{throw new Error('site_price_identity_or_value_unconfirmed');},persist});
    expect(persist).not.toHaveBeenCalled();
    expect(result.products[0]).toMatchObject({id:'sgg5000',price:null,specs:{power:'5 кВт'}});
    expect(result.proofs[0]).toMatchObject({status:'unavailable',previousPrice:64558});
  });
  it('does not claim a successful update if persistence loses the identity or freshness race',async()=>{
    const result=await verifyBudgetPrices({products:[products[0]],read,persist:async()=>null});
    expect(result.products[0].price).toBeNull();
    expect(result.proofs[0]).toMatchObject({status:'unavailable',errorCode:'site_price_persistence_conflict'});
  });
  it('deduplicates a batch, limits in-flight reads, and keeps output order', async () => {
    const batch = [products[0], products[1], { ...products[0], price: 70000 }];
    let inFlight = 0;
    let maxInFlight = 0;
    const readCalls: string[] = [];
    const boundedRead = vi.fn(async (product: Product) => {
      readCalls.push(product.id);
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise(resolve => setTimeout(resolve, 5));
      inFlight -= 1;
      return {
        productId: product.id,
        productName: product.name,
        previousPrice: product.price ?? null,
        price: product.id === 'sgg5000' ? 78240 : 98930,
        currency: 'RUB' as const,
        sourceUrl: `https://bakautprof.ru/catalog/${product.id}`,
        observedAt: '2026-09-07T16:22:20Z',
        evidence: 'company page'
      };
    });
    const persist = vi.fn(async (proof: Awaited<ReturnType<typeof boundedRead>>) => ({
      ...batch.find(product => product.id === proof.productId)!,
      price: proof.price
    }));

    const result = await verifyBudgetPrices({
      products: batch,
      read: boundedRead,
      persist,
      maxConcurrency: 1
    });

    expect(readCalls).toEqual(['sgg5000', 'sgg6000']);
    expect(maxInFlight).toBe(1);
    expect(persist).toHaveBeenCalledTimes(2);
    expect(result.products.map(product => product.price)).toEqual([78240, 98930, 78240]);
    expect(result.proofs.map(proof => proof.productId)).toEqual(['sgg5000', 'sgg6000', 'sgg5000']);
  });
  it('opens the verification circuit after the configured failure threshold', async () => {
    const batch = [products[0], products[1], { ...products[0], id: 'sgg7000', name: 'SGG 7000Ei' }];
    const read = vi.fn(async () => {
      throw new Error('site_price_http_error');
    });
    const result = await verifyBudgetPrices({
      products: batch,
      read,
      persist: vi.fn(),
      maxConcurrency: 1,
      maxFailures: 1
    });

    expect(read).toHaveBeenCalledTimes(1);
    expect(result.proofs.map(proof => proof.errorCode)).toEqual([
      'site_price_http_error',
      'site_price_circuit_open',
      'site_price_circuit_open'
    ]);
    expect(result.products.every(product => product.price === null)).toBe(true);
  });
});
