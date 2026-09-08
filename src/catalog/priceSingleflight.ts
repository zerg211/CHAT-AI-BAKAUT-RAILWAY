import type {Product} from '../shared/types.js';
import type {VerifiedSitePrice} from './currentSitePrice.js';

/** Concurrent reads share transport; optional bounded proof reuse never refreshes observedAt. */
export function singleflightPriceReader(read:(product:Product)=>Promise<VerifiedSitePrice>,namespace:()=>string=()=> '',
  options:{ttlMs?:number;maxEntries?:number;now?:()=>number}={}) {
  const pending=new Map<string,Promise<VerifiedSitePrice>>();
  const proofs=new Map<string,VerifiedSitePrice>();
  const now=options.now??Date.now;
  const ttlMs=Math.max(0,Math.min(10_000,options.ttlMs??0));
  const maxEntries=Math.max(1,Math.min(256,options.maxEntries??256));
  return async (product:Product,signal?:AbortSignal):Promise<VerifiedSitePrice>=>{
    if(signal?.aborted)throw new DOMException('The operation was aborted.','AbortError');
    const snapshot={...product};
    const key=JSON.stringify([namespace(),snapshot.id,snapshot.name,snapshot.sourceUrl,snapshot.technicalVersion,snapshot.sourceContentHash,snapshot.price]);
    const cached=proofs.get(key);
    if(cached){
      const age=now()-Date.parse(cached.observedAt);
      if(Number.isFinite(age)&&age>=0&&age<ttlMs)return {...cached,previousPrice:snapshot.price??null};
      proofs.delete(key);
    }
    let operation=pending.get(key);
    if(!operation){
      operation=Promise.resolve().then(()=>read(snapshot)).then(proof=>{
        const age=now()-Date.parse(proof.observedAt);
        if(ttlMs>0&&Number.isFinite(age)&&age>=0&&age<ttlMs&&proof.productId===snapshot.id&&
          proof.productName===snapshot.name&&proof.sourceUrl===snapshot.sourceUrl){
          if(proofs.size>=maxEntries)proofs.delete(proofs.keys().next().value!);
          proofs.set(key,{...proof});
        }
        return proof;
      }).finally(()=>{if(pending.get(key)===operation)pending.delete(key);});
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
