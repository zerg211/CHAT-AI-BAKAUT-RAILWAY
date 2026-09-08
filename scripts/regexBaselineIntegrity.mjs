/** Moving an unchanged expression is allowed; accepting a new expression or another copy is not. */
export function assertRegexBaselineDoesNotGrow(reference,current) {
  const counts=baseline=>{
    if(!Array.isArray(baseline?.findings))throw new Error('Invalid regex baseline');
    const result=new Map(),ids=new Set();
    for(const finding of baseline.findings){
      if(typeof finding.file!=='string'||typeof finding.kind!=='string'||typeof finding.hash!=='string'||
        !Number.isSafeInteger(finding.occurrence)||finding.occurrence<1||
        finding.id!==[finding.file,finding.kind,finding.hash,finding.occurrence].join('|')||ids.has(finding.id))throw new Error('Invalid or duplicate regex baseline entry');
      ids.add(finding.id);const key=[finding.kind,finding.hash].join('|');result.set(key,(result.get(key)??0)+1);
    }
    return result;
  };
  const available=counts(reference),requested=counts(current);
  for(const[key,count]of requested)if(count>(available.get(key)??0))throw new Error(`No-regex baseline grew for ${key}: ${available.get(key)??0} -> ${count}`);
}
