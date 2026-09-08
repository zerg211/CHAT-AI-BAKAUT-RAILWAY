import type {Product} from '../shared/types.js';
import type {VerifiedSitePrice} from './currentSitePrice.js';

/** Share only concurrent reads. No retained cache and no extension of proof freshness. */
export function singleflightPriceReader(read:(product:Product)=>Promise<VerifiedSitePrice>,namespace:()=>string=()=> '') {
  const pending=new Map<string,Promise<VerifiedSitePrice>>();
  return async (product:Product,signal?:AbortSignal):Promise<VerifiedSitePrice>=>{
    if(signal?.aborted)throw new DOMException('The operation was aborted.','AbortError');
    const snapshot={...product};
    const key=JSON.stringify([namespace(),snapshot.id,snapshot.name,snapshot.sourceUrl,snapshot.technicalVersion,snapshot.sourceContentHash,snapshot.price]);
    let operation=pending.get(key);
    if(!operation){
      operation=Promise.resolve().then(()=>read(snapshot)).finally(()=>{if(pending.get(key)===operation)pending.delete(key);});
      pending.set(key,operation);
    }
    return new Promise<VerifiedSitePrice>((resolve,reject)=>{
      const onAbort=()=>reject(new DOMException('The operation was aborted.','AbortError'));
      signal?.addEventListener('abort',onAbort,{once:true});
      operation!.then(proof=>resolve({...proof,previousPrice:snapshot.price??null}),reject)
        .finally(()=>signal?.removeEventListener('abort',onAbort));
    });
  };
}
