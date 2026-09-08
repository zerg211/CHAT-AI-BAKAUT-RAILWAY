import {describe,expect,it,vi} from 'vitest';
import {singleflightPriceReader} from '../src/catalog/priceSingleflight';
import type {Product} from '../src/shared/types';
import type {VerifiedSitePrice} from '../src/catalog/currentSitePrice';
const product:Product={id:'fixture',name:'Model A',sourceUrl:'https://fixture.invalid/a',technicalVersion:'v1',price:10,specs:{}};
const proof:VerifiedSitePrice={productId:product.id,productName:product.name,previousPrice:10,price:12,currency:'RUB',sourceUrl:product.sourceUrl!,observedAt:'2026-09-08T12:00:00Z',evidence:'12 RUB'};
describe('concurrent price verification',()=>{
  it('shares the network read without letting one subscriber cancel another',async()=>{
    let release!:(value:VerifiedSitePrice)=>void;
    const read=vi.fn(()=>new Promise<VerifiedSitePrice>(resolve=>{release=resolve;}));
    const broker=singleflightPriceReader(read),abort=new AbortController();
    const one=broker(product,abort.signal),two=broker({...product});
    await Promise.resolve();expect(read).toHaveBeenCalledTimes(1);
    abort.abort();await expect(one).rejects.toMatchObject({name:'AbortError'});
    release(proof);expect(await two).toEqual(proof);
  });
  it.each([{name:'Model B'},{sourceUrl:'https://fixture.invalid/b'},{technicalVersion:'v2'},{sourceContentHash:'changed'},{price:11}])('does not share changed identity/version: %j',async change=>{
    const read=vi.fn(async()=>proof),broker=singleflightPriceReader(read);
    await Promise.all([broker(product),broker({...product,...change})]);expect(read).toHaveBeenCalledTimes(2);
  });
  it('never retains a failure or extends the timestamp on later reads',async()=>{
    const read=vi.fn().mockRejectedValueOnce(new Error('network failure')).mockResolvedValue(proof),broker=singleflightPriceReader(read);
    await expect(broker(product)).rejects.toThrow('network failure');
    expect((await broker(product)).observedAt).toBe(proof.observedAt);
    await broker(product);expect(read).toHaveBeenCalledTimes(3);
  });
  it('does not start a read for an already cancelled caller',async()=>{
    const read=vi.fn(async()=>proof),abort=new AbortController();abort.abort();
    await expect(singleflightPriceReader(read)(product,abort.signal)).rejects.toMatchObject({name:'AbortError'});
    expect(read).not.toHaveBeenCalled();
  });
});
