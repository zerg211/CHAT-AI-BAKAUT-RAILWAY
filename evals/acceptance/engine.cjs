'use strict';
// Independent acceptance oracle. Never imports the application's selectors/guards.
const { createHash } = require('node:crypto');
const canonical = x => x && typeof x === 'object' ? Array.isArray(x) ? x.map(canonical) : Object.fromEntries(Object.keys(x).sort().map(k => [k, canonical(x[k])])) : x;
const hash = x => createHash('sha256').update(JSON.stringify(canonical(x))).digest('hex');
const norm = x => String(x ?? '').normalize('NFKC').trim().toLocaleLowerCase('ru-RU');
const own = (o,k) => Object.prototype.hasOwnProperty.call(o ?? {},k);
const same = (a,b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const aliases = {searchCatalog:'catalog.search',selectProducts:'catalog.search',getProductDetails:'catalog.getProductDetails',webFactSearch:'web.researchProductFacts',createLead:'lead.capture',calculateGeneratorLoad:'calculator.generatorLoad'};
const toolName = x => aliases[x] || x;
const knownConstraints = new Set(['class','fuel','voltage','nominalMin','nominalMax','weightMin','weightMax','priceMin','priceMax','electricStart','autoStart','remoteStart','excludeKeys']);
function quantity(value, unit) {
  const units = {kw:['power',1],'квт':['power',1],w:['power',.001],'вт':['power',.001],kg:['mass',1],'кг':['mass',1],g:['mass',.001],'г':['mass',.001],v:['voltage',1],'в':['voltage',1],rub:['money',1],'руб':['money',1],'₽':['money',1],'':['scalar',1]};
  const unitKey=x=>{const n=norm(x);return n.endsWith('.')?n.slice(0,-1):n;};
  if (typeof value === 'number') { if (!Number.isFinite(value)) return null; }
  else if (typeof value === 'string') {
    const text=value.trim();let i=0;
    if(text[i]==='+'||text[i]==='-')i++;
    const begin=i;while(i<text.length && '0123456789'.includes(text[i]))i++;
    if(i===begin)return null;
    if(text[i]==='.'||text[i]===','){i++;const d=i;while(i<text.length && '0123456789'.includes(text[i]))i++;if(i===d)return null;}
    const suffix=text.slice(i).trim();const parsed=Number(text.slice(0,i).split(',').join('.'));
    if(suffix && unit && !same(units[unitKey(suffix)],units[unitKey(unit)]))return null;
    if(suffix)unit=suffix;value=parsed;
  } else return null;
  const u = units[unitKey(unit)]; return u ? {dimension:u[0],value:value*u[1]} : null;
}
function equivalent(a,au,b,bu) { const x=quantity(a,au),y=quantity(b,bu); return x && y && x.dimension===y.dimension ? Math.abs(x.value-y.value)<1e-8*Math.max(1,Math.abs(x.value),Math.abs(y.value)) : norm(a)===norm(b) && norm(au)===norm(bu); }
function productViolations(p,c={}) {
  const out=[];
  for(const key of Object.keys(c)) if(!knownConstraints.has(key)) throw new Error(`UNKNOWN_CONSTRAINT:${key}`);
  for(const key of ['nominalMin','nominalMax','weightMin','weightMax','priceMin','priceMax','voltage'])if(own(c,key)&&(!Number.isFinite(c[key])||c[key]<0))throw new Error(`INVALID_NUMERIC_CONSTRAINT:${key}`);
  for(const key of ['electricStart','autoStart','remoteStart'])if(own(c,key)&&typeof c[key]!=='boolean')throw new Error(`INVALID_BOOLEAN_CONSTRAINT:${key}`);
  if(c.excludeKeys!==undefined&&(!Array.isArray(c.excludeKeys)||c.excludeKeys.some(x=>typeof x!=='string')))throw new Error('INVALID_EXCLUSION_LIST');
  for(const k of ['class','fuel','voltage','electricStart','autoStart','remoteStart']) if(own(c,k) && !same(p[k],c[k])) out.push(k);
  for(const [k,field,cmp] of [['nominalMin','nominalKw','min'],['nominalMax','nominalKw','max'],['weightMin','weightKg','min'],['weightMax','weightKg','max'],['priceMin','price','min'],['priceMax','price','max']]) {
    if(own(c,k) && (typeof p[field]!=='number' || (cmp==='min' ? p[field]<c[k] : p[field]>c[k]))) out.push(k);
  }
  if(c.excludeKeys?.includes(p.key)) out.push('excluded');
  return out;
}
function executed(turn) { return (Array.isArray(turn.metadata?.toolResults)?turn.metadata.toolResults:[]).filter(x => x && typeof x.requestId==='string' && typeof x.tool==='string'); }
function provesTool(r,level='succeeded') {
  if(level==='attempted') return ['ok','not_found','error','timeout'].includes(r.status) && !r.warnings?.some(w=>String(w).startsWith('tool_not_executed'));
  if(r.status!=='ok') return false;
  if(level==='succeeded') return true;
  if(level!=='fact') throw new Error(`UNKNOWN_TOOL_OUTCOME:${level}`);
  if(r.tool!=='web.researchProductFacts') return false;
  const p=r.payload ?? {};
  return (p.usedWebSearch===true || p.usedDocumentRead===true) && ['completed','timed_out','skipped_budget'].includes(p.searchDisposition) &&
    [...(Array.isArray(p.facts)?p.facts:[]),...(Array.isArray(p.answerGuidance?.coverage)?p.answerGuidance.coverage:[])].some(f=>f.evidenceVerifiedExact===true && f.sourceUrl && f.evidence && f.productName && f.attribute && f.value!==undefined);
}
function validateScenario(s) {
  if(!s || typeof s.id!=='string' || !s.id || !Array.isArray(s.steps) || !s.steps.length) throw new Error('INVALID_SCENARIO');
  const ids=new Set();
  for(const [i,st] of s.steps.entries()) {
    if(!st || typeof st.user!=='string' || !st.user.trim()) throw new Error(`INVALID_STEP:${i}`);
    productViolations({},st.expect?.constraints);
    if(st.criteria!==undefined&&!Array.isArray(st.criteria))throw new Error('INVALID_CRITERIA_LIST');
    for(const key of ['minCards','maxCards'])if(own(st.expect,key)&&(!Number.isSafeInteger(st.expect[key])||st.expect[key]<0))throw new Error(`INVALID_CARD_LIMIT:${key}`);
    if(own(st.expect,'minCards')&&own(st.expect,'maxCards')&&st.expect.minCards>st.expect.maxCards)throw new Error('IMPOSSIBLE_CARD_LIMITS');
    for(const c of st.criteria??[]) {
      if(!c.id || ids.has(c.id) || !c.rule || !['critical','quality'].includes(c.severity)) throw new Error(`INVALID_CRITERION:${i}`);
      ids.add(c.id);
    }
    for(const t of st.expect?.tools??[]) if(!['attempted','succeeded','fact'].includes(t.outcome??'succeeded')) throw new Error('INVALID_TOOL_LEVEL');
  }
  return s;
}
function worldAt(world,scenario,index) {
 const version=structuredClone(world);
 for(const step of scenario.steps.slice(0,index+1))if(step.before){
  if(step.before.action!=='set-price')throw new Error('UNKNOWN_SCENARIO_ACTION');
  const p=version.products.find(p=>p.key===step.before.key);
  if(!p||!Number.isFinite(step.before.price)||step.before.price<=0)throw new Error('INVALID_PRICE_ACTION');
  p.price=step.before.price;
 }
 return version;
}

function evaluate(run,scenario,world,semantic=null) {
  const issues=[];
  const add=(code,turn,message,severity='critical',kind='behavior')=>issues.push({code,turn,message,severity,kind});
  try { validateScenario(scenario); } catch(e) { return {status:'INCONCLUSIVE',pass:false,issues:[{code:'HARNESS_INVALID_SCENARIO',kind:'harness',message:e.message}],score:0}; }
  if(!world || !Array.isArray(world.products) || world.products.some(p=>!p||typeof p.key!=='string'||typeof p.id!=='string') || new Set(world.products.map(p=>p.key)).size!==world.products.length) return {status:'INCONCLUSIVE',pass:false,score:0,issues:[{code:'HARNESS_WORLD',kind:'harness',message:'Independent world missing or invalid'}]};
  if(run?.harnessError) add('HARNESS_COLLECTION',null,JSON.stringify(run.harnessError),'critical','harness');
  if(run?.cleanupError) add('HARNESS_CLEANUP',null,'Test session cleanup failed','critical','harness');
  const turns=run?.turns;
  if(!Array.isArray(turns)) return {status:'INCONCLUSIVE',pass:false,score:0,issues:[{code:'HARNESS_NO_TRANSCRIPT',kind:'harness',message:'No transcript'}]};
  if(run.worldHash!==hash(world)) add('HARNESS_WORLD_CHANGED',null,'Run and independent world hashes differ','critical','harness');
  if(turns.length!==scenario.steps.length) add('DIALOGUE_INCOMPLETE',null,`Expected ${scenario.steps.length} turns; got ${turns.length}`);
  const turnIds=new Set(),messageIds=new Set();
  for(let i=0;i<Math.min(turns.length,scenario.steps.length);i++) {
    const t=turns[i],st=scenario.steps[i],e=st.expect??{};
    if(!t || !t.turnId || turnIds.has(t.turnId)) { add('HARNESS_TURN_ID',i,'Missing/repeated turn identity','critical','harness'); continue; }
    turnIds.add(t.turnId);
    if(t.user!==st.user) add('HARNESS_BUYER_MISMATCH',i,'Transcript buyer message differs from scenario','critical','harness');
    if(t.ok!==true) add('TURN_FAILED',i,t.error??'No completed response');
    if(typeof t.answer!=='string' || !t.answer.trim()) add('EMPTY_ANSWER',i,'No useful content delivered');
    if(!Array.isArray(t.productCards)) { add('HARNESS_CARDS_MISSING',i,'Cards field is not an array','critical','harness'); continue; }
    if(e.audit!==false && (!t.audit || t.audit.turnId!==t.turnId || t.audit.assistantMessageId!==t.assistantMessageId || !t.metadata || typeof t.metadata!=='object')) add('HARNESS_UNBOUND_AUDIT',i,'Private evidence is absent or not joined to this exact turn','critical','harness');
    if(t.assistantMessageId) { if(messageIds.has(t.assistantMessageId)) add('DUPLICATE_ANSWER_ID',i,'Different buyer turns share an assistant message'); messageIds.add(t.assistantMessageId); }
    if(own(e,'maxLatencyMs') && (typeof t.elapsedMs!=='number' || t.elapsedMs>e.maxLatencyMs)) add('LATENCY_FINAL',i,`Final answer ${t.elapsedMs??'unknown'}ms exceeds ${e.maxLatencyMs}ms`,'quality');
    if(own(e,'maxUsefulMs') && (typeof t.firstUsefulMs!=='number' || t.firstUsefulMs>e.maxUsefulMs)) add('LATENCY_USEFUL',i,`First useful content ${t.firstUsefulMs??'unknown'}ms exceeds ${e.maxUsefulMs}ms`,'quality');
    if(t.transportRecovered && e.allowRecovery===false) add('UNEXPECTED_RECOVERY',i,'This first-attempt reliability scenario disallows recovery');
    if(e.samePayloadOnReplay && (!t.replay || !same(t.replay.first,t.replay.second))) add('IDEMPOTENCY_PAYLOAD',i,'Retry did not reproduce the same completed payload');
    let refs;try{refs=worldAt(world,scenario,i).products;}catch(err){add('HARNESS_WORLD_ACTION',i,err.message,'critical','harness');refs=[];}const seenCards=new Set();
    for(const card of t.productCards) {
      if(seenCards.has(card.id)) add('DUPLICATE_CARD',i,`Repeated card ${card.id}`); seenCards.add(card.id);
      const p=refs.find(p=>p.id===card.id);
      if(!p) { add('UNKNOWN_PRODUCT',i,`Card ${card.id} absent from independent fixture`); continue; }
      if(norm(card.name)!==norm(p.name)) add('WRONG_MODIFICATION',i,`Expected ${p.name}; got ${card.name}`);
      if(p.price!=null && (typeof card.price!=='number'||!Number.isFinite(card.price)||Math.abs(card.price-p.price)>.005)) add('CARD_PRICE_MISMATCH',i,`Card price differs from independent ${p.price}`);
      if(p.price!=null && (card.currency??'RUB')!=='RUB') add('CARD_CURRENCY_MISMATCH',i,'Not RUB');
      const bad=productViolations(p,e.constraints);
      if(bad.length) {
        const alternative=(e.alternatives??[]).find(x=>x.key===p.key && bad.every(k=>x.violations.includes(k)));
        if(!alternative) add('CARD_CONSTRAINT',i,`${p.key}: ${bad.join(',')}`);
        else if(!card.caveats?.length) add('UNLABELLED_COMPROMISE',i,`${p.key} lacks visible tradeoff`);
      }
      if(e.exactKeys && !e.exactKeys.includes(p.key)) add('UNREQUESTED_PRODUCT',i,`${p.key} not an allowed exact model`);
      // Every supplied card spec must agree with the independent snapshot if that key is known.
      for(const [k,v] of Object.entries(card.specs??{})) if(own(p.specs,k) && !equivalent(v,'',p.specs[k],'')) add('CARD_SPEC_MISMATCH',i,`${p.key}.${k}: ${v} != ${p.specs[k]}`);
    }
    if(own(e,'minCards') && t.productCards.length<e.minCards) add('MISSING_CURRENT_CARDS',i,`Need ${e.minCards} current cards, got ${t.productCards.length}`);
    if(own(e,'maxCards') && t.productCards.length>e.maxCards) add('UNEXPECTED_CURRENT_CARDS',i,`Allowed at most ${e.maxCards} cards`);
    if(e.cheapestFirst && t.productCards.length) {
      const eligible=refs.filter(p=>!productViolations(p,e.constraints).length && typeof p.price==='number');
      const cheapest=Math.min(...eligible.map(p=>p.price));
      const first=refs.find(p=>p.id===t.productCards[0].id);
      if(!first||first.price!==cheapest) add('WRONG_PRICE_RANKING',i,`First must have cheapest eligible price ${cheapest}`);
    }
    if(e.noSuitable) {
      const eligible=refs.filter(p=>!productViolations(p,e.constraints).length);
      if(eligible.length) add('FALSE_NO_SUITABLE',i,`Independent catalogue has ${eligible.length} suitable candidates`);
      if(t.productCards.length && !e.alternatives?.length) add('NO_MATCH_WITH_CARDS',i,'No-match outcome unexpectedly shows cards');
    }
    const results=executed(t);
    // A present card or metadata flag is not proof of retrieval. Historical
    // evidence is allowed only for the same exact product, not to satisfy card counts.
    const evidenceTurns=turns.slice(0,i+1);
    for(const key of e.evidenceFor??[]) {
      const p=refs.find(x=>x.key===key);
      const supported=p && evidenceTurns.some(et=>executed(et).some(r=>r.status==='ok' && (r.payload?.products??[]).some(x=>x.id===p.id && norm(x.name)===norm(p.name))) || (et.metadata?.verifiedProductFacts??[]).some(f=>f.productId===p.id && f.sourceUrl && f.evidence));
      if(!supported) add('MISSING_PRODUCT_EVIDENCE',i,`No executed retrieval/verified memory for ${key}`);
    }
    for(const req of e.tools??[]) if(!results.some(r=>r.tool===toolName(req.tool)&&provesTool(r,req.outcome??'succeeded'))) {
      const outage=req.allowOutage && results.some(r=>r.tool===toolName(req.tool) && ['timeout','error'].includes(r.status));
      add(outage?'RESEARCH_ENVIRONMENT_UNAVAILABLE':'TOOL_OBLIGATION',i,`${req.tool} requires ${req.outcome??'succeeded'} executed evidence`,'critical',outage?'harness':'behavior');
    }
    if(e.forbidFreshResearch && results.some(r=>r.tool==='web.researchProductFacts' && (r.payload?.usedWebSearch===true || r.payload?.usedDocumentRead===true))) add('UNNECESSARY_EXTERNAL_RESEARCH',i,'Known fact was fetched externally again rather than reused');
    for(const name of e.forbiddenTools??[]) if(results.some(r=>r.tool===toolName(name) && provesTool(r,'attempted'))) add('UNNECESSARY_TOOL',i,`Must reuse available evidence rather than ${name}`);
    if(own(e,'maxTools') && results.length>e.maxTools) add('EXCESSIVE_TOOLS',i,`${results.length} > ${e.maxTools}`,'quality');
    const facts=Object.values(t.metadata?.ledgerState?.factsByKey??{}).filter(f=>f.status==='active');
    for(const expected of e.ledger??[]) {
      const matches=facts.filter(f=>f.factKey===expected.factKey && (!expected.productClass || f.productClass===expected.productClass) && (!expected.scope || f.scope===expected.scope));
      if(expected.absent ? matches.length!==0 : !matches.some(f=>equivalent(f.value,f.unit??'',expected.value,expected.unit??''))) add('MEMORY_REQUIREMENT',i,`Scoped ${expected.factKey}: ${expected.absent?'must be absent':JSON.stringify(expected.value)}`);
      if(!expected.absent && matches.some(f=>!equivalent(f.value,f.unit??'',expected.value,expected.unit??''))) add('MEMORY_CONTRADICTION',i,`Conflicting active values for ${expected.factKey}`);
    }
    if(own(e,'leadRequested') && t.leadRequested!==e.leadRequested) add('LEAD_REQUEST_POLICY',i,`leadRequested should be ${e.leadRequested}`);
    if(own(e,'leadCount')) {
      if(!Array.isArray(t.audit?.leads)) add('HARNESS_LEAD_EVIDENCE',i,'Missing independently read leads','critical','harness');
      else if(t.audit.leads.filter(l=>l.sessionId===run.sessionId).length!==e.leadCount) add('LEAD_COUNT',i,`Expected ${e.leadCount} durable leads for this session`);
    }
    if(own(e,'outboxCount')) {
      if(!Array.isArray(t.audit?.outbox)) add('HARNESS_OUTBOX_EVIDENCE',i,'Missing independently read outbox','critical','harness');
      else if(t.audit.outbox.length!==e.outboxCount || t.audit.outbox.some(x=>!['pending','sending','sent'].includes(x.status))) add('OUTBOX_STATE',i,'Unexpected outbox count or non-dispatchable state');
    }
    for(const f of e.rememberedFacts??[]) {
      const stored=t.metadata?.verifiedProductFacts??[];
      if(!stored.some(x=>norm(x.productName)===norm(refs.find(p=>p.key===f.key)?.name) && norm(x.attribute)===norm(f.attribute) && equivalent(x.value,f.unit??'',f.value,f.unit??''))) add('FACT_MEMORY_MISSING',i,`${f.key}.${f.attribute} was not available`);
    }
  }
  const criteria=scenario.steps.flatMap((st,index)=>(st.criteria??[]).map(c=>({...c,turn:index})));
  if(criteria.length) {
    if(!semantic || semantic.inputHash!==hash({scenario,world,turns:run.turns})) add('JUDGE_MISSING_OR_STALE',null,'Independent semantic verdict missing or for another transcript','critical','harness');
    else {
      const entries=Array.isArray(semantic.checks)?semantic.checks:[];
      if(!Array.isArray(entries) || new Set(entries.map(x=>x.id)).size!==entries.length || entries.length!==criteria.length || entries.some(x=>!criteria.some(c=>c.id===x.id))) add('JUDGE_SCHEMA',null,'Missing, duplicated or unexpected criteria','critical','harness');
      for(const c of criteria) {
        const j=entries?.find(x=>x.id===c.id);
        if(!j || !['pass','fail','unknown'].includes(j.verdict)||typeof j.reason!=='string'||!j.reason.trim()) { add('JUDGE_SCHEMA',c.turn,c.id,'critical','harness'); continue; }
        const quotes=j.quotes;
        const visible=[turns[c.turn]?.answer,...(turns[c.turn]?.productCards??[]).flatMap(x=>[x.name,...(x.reasons??[]),...(x.caveats??[]),...Object.values(x.specs??{})])].join('\n');
        if(!Array.isArray(quotes)||quotes.some(q=>typeof q!=='string'||!q.trim()||!visible.includes(q))) add('JUDGE_INVENTED_QUOTE',c.turn,c.id,'critical','harness');
        if(!Array.isArray(j.sourceIds) || j.sourceIds.some(id=>!(world.sources??[]).some(s=>s.id===id) && !executed(turns[c.turn]??{}).some(r=>r.requestId===id))) add('JUDGE_INVENTED_SOURCE',c.turn,c.id,'critical','harness');
        if(j.verdict==='unknown') add('JUDGE_UNKNOWN',c.turn,`${c.id}: ${j.reason}`,c.severity,'harness');
        if(j.verdict==='fail') add(`SEMANTIC_${c.id}`,c.turn,j.reason,c.severity);
      }
    }
  }
  const status=issues.some(i=>i.kind==='behavior')?'FAIL':issues.length?'INCONCLUSIVE':'PASS';
  return {status,pass:status==='PASS',score:status==='PASS'?1:0,issues};
}
function releaseVerdict({requiredIds,reports,commit,worldHash,suiteHash,maxAgeMs=86_400_000,now=Date.now()}) {
  const missing=[],failed=[],invalid=[];
  if(new Set(reports.map(r=>r.scenarioId)).size!==reports.length) return {status:'NOT_PROVEN',missing:[],failed:[],invalid:['duplicate_scenario_reports']};
  for(const id of requiredIds) {
    const r=reports.find(r=>r.scenarioId===id);
    if(!r) {missing.push(id);continue;}
    if(r.mode!=='real-agent' || r.commit!==commit || r.worldHash!==worldHash || r.suiteHash!==suiteHash || !Number.isFinite(Date.parse(r.finishedAt)) || now-Date.parse(r.finishedAt)>maxAgeMs || Date.parse(r.finishedAt)>now+60_000) invalid.push(id);
    else if(r.result?.status!=='PASS' || r.result?.pass!==true || r.attempts?.some(a=>a.result?.status!=='PASS')) failed.push(id);
  }
  return {status:failed.length?'BLOCKED':missing.length||invalid.length?'NOT_PROVEN':'READY_FOR_THIS_SUITE',missing,failed,invalid};
}
module.exports={hash,norm,same,quantity,equivalent,productViolations,executed,provesTool,toolName,validateScenario,worldAt,evaluate,releaseVerdict};
