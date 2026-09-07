'use strict';
// Preloaded in OFFLINE checks only. Never imported by application or live runner.
function check(value){const u=new URL(typeof value==='string'||value instanceof URL?value:value.url);if(!['localhost','127.0.0.1','[::1]'].includes(u.hostname))throw new Error('OFFLINE_EXTERNAL_NETWORK_FORBIDDEN');}
const originalFetch=globalThis.fetch;
globalThis.fetch=(input,init)=>{check(input);return originalFetch(input,init);};
for(const moduleName of ['node:http','node:https']){
 const mod=require(moduleName);
 for(const method of ['request','get']){const original=mod[method];mod[method]=function(...args){const o=args[0];if(typeof o==='string'||o instanceof URL)check(o);else{const host=o?.hostname??o?.host??'localhost';if(!['localhost','127.0.0.1','::1'].includes(host))throw new Error('OFFLINE_EXTERNAL_NETWORK_FORBIDDEN');}return original.apply(this,args);};}
}
