import {describe,it,expect,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {textPdfPages} from './fixtures/pdfTextFixture.js';
const fixture = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('../src/security/outboundHttp.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/security/outboundHttp.js')>(), safeFetchBytes: fixture.fetch
}));
const isolated = (() => {try {const u=new URL(process.env.DATABASE_URL||'file:///missing');return ['127.0.0.1','localhost','[::1]'].includes(u.hostname)&&u.pathname.startsWith('/bakaut_acceptance_');}catch{return false;}})();

describe.skipIf(!isolated)('source lifecycle I: actual executor, PostgreSQL artifacts and replay; HTTP boundary controlled',()=>{
 it('preserves late scoped facts, blank-summary content, changed representations and unavailable-source semantics through durable execution',async()=>{
  const {pool}=await import('../src/db/pool.js');
  const {ConversationRepository,ProductRepository,LeadRepository}=await import('../src/db/repositories.js');
  const {AgentManagerToolExecutor}=await import('../src/ai/agentManagerToolExecutor.js');
  const {AgentIntentContractSchema,ToolResultSchema}=await import('../src/ai/agentManagerContracts.js');
  const {AgentManagerTurnBudget}=await import('../src/ai/agentManagerTurnBudget.js');
  const {compactToolResultsForModel}=await import('../src/ai/agentManagerModelContext.js');
  const {validateToolResultOutput}=await import('../src/ai/agentManagerToolRegistry.js');
  const {config}=await import('../src/config.js');
  const repo=new ConversationRepository(),products=new ProductRepository(),visitor=randomUUID();
  const session=await repo.createSession({visitorId:visitor});
  const owner=randomUUID(),pageUrl=config.CATALOG_BASE_URL+'/contacts/'+randomUUID();
  const turn=await repo.createTurnWithUserMessage({sessionId:session.id,visitorCapability:visitor,clientMessageId:randomUUID(),requestHash:randomUUID(),content:'Public address verification fixture',deadlineAt:new Date(Date.now()+120000).toISOString()});
  await repo.claimTurnExecution({sessionId:session.id,turnId:turn.id,ownerId:owner,leaseMs:120000});
  const executor=new AgentManagerToolExecutor(repo,products,new LeadRepository(),{} as never,async()=>{throw Error('unexpected embedding');},async()=>{throw Error('unexpected price');},async()=>{});
  const html='<h1>Контакты</h1><nav>'+ 'Публичное меню '.repeat(1100) + '</nav><footer><table><tr><td>Тестоград</td><td>Офис</td><td>Первая улица 7</td></tr><tr><td>Другой город</td><td>Склад</td><td>Вторая улица 9</td></tr></table></footer>';
  let currentHtml=html,status=200,finalUrl=pageUrl,contentType='text/html',binary:Uint8Array|undefined;
  fixture.fetch.mockImplementation(async()=>({url:finalUrl,status,headers:new Headers({'content-type':contentType}),bytes:binary??new TextEncoder().encode(currentHtml)}));
  const run=async(id:string,tool:'site.readFirstPartyPage'|'site.searchCompanyKnowledge',args:Record<string,unknown>,persisted=new Map(),signal?:AbortSignal)=>{
   const request={id,tool,args,rationale:'source lifecycle fixture',required:true};
   const intent=AgentIntentContractSchema.parse({turnId:turn.id,userMessageSummary:'public facts',dialogueUnderstanding:'verify source',nextStepRationale:'read authoritative document',requiresTools:true,toolRequests:[request],mustNotAskQuestionIds:[],riskFlags:[]});
   return executor.executeTools({session,turnId:turn.id,executionOwner:owner,userMessage:'Verify the public address.',history:[],intent,toolRequests:intent.toolRequests,needState:session.needState,pendingLeadCaptureDraft:null,persistedToolResults:persisted,budget:new AgentManagerTurnBudget(),signal});
  };
  try{
   const first=(await run('source-first','site.readFirstPartyPage',{url:pageUrl})).toolResults[0]!;
   expect(first.status).toBe('ok');
   const range=first.payload.readRange as {nextOffset:number;complete:boolean};
   expect(range.complete).toBe(false);
   let restOffset=range.nextOffset;
   let rest=(await run('source-rest','site.readFirstPartyPage',{url:pageUrl,offset:restOffset,expectedSourceFingerprint:first.payload.sourceFingerprint})).toolResults[0]!;
   while((rest.payload.readRange as {nextOffset:number|null}).nextOffset!==null){
    restOffset=(rest.payload.readRange as {nextOffset:number}).nextOffset;
    rest=(await run('source-rest-'+restOffset,'site.readFirstPartyPage',{url:pageUrl,offset:restOffset,expectedSourceFingerprint:first.payload.sourceFingerprint})).toolResults[0]!;
   }
   expect(rest.payload.text).toContain('Тестоград | Офис | Первая улица 7');
   expect(rest.payload.text).toContain('Другой город | Склад | Вторая улица 9');
   currentHtml=html.replace('Первая улица 7','Третья улица 11');
   const changed=(await run('source-changed','site.readFirstPartyPage',{url:pageUrl,offset:range.nextOffset,expectedSourceFingerprint:first.payload.sourceFingerprint})).toolResults[0]!;
   expect(changed.payload.failureCode).toBe('source_changed');
   await products.upsertCatalogPage({sourceUrl:pageUrl+'/blank',pageType:'company_contacts',title:'Контакты',summary:'  ',content:'Тестоград, офис, Четвёртая улица 13.'});
   const search=(await run('source-search','site.searchCompanyKnowledge',{query:'Четвёртая улица',limit:4})).toolResults[0]!;
   expect(JSON.stringify(search.payload.pages)).toContain('Четвёртая улица 13');
   await products.upsertCatalogPage({sourceUrl:pageUrl,pageType:'company_contacts',title:'Контакты',content:'Тестоград офис Первая улица 7',sourceObservedAt:new Date(Date.now()-3600000).toISOString()});
   const beforeOutage=(await pool.query('SELECT source_content_hash,source_observed_at,updated_at FROM catalog_pages WHERE source_url=$1',[pageUrl])).rows[0];
   status=503;
   const unavailable=(await run('source-unavailable','site.readFirstPartyPage',{url:pageUrl})).toolResults[0]!;
   expect(unavailable.observationStatus).toBe('unavailable');
   expect((await pool.query('SELECT source_content_hash,source_observed_at,updated_at FROM catalog_pages WHERE source_url=$1',[pageUrl])).rows[0]).toEqual(beforeOutage);
   expect((await products.searchCatalogPages('Тестоград')).some(page=>page.sourceUrl===pageUrl)).toBe(true);
   status=200;contentType='image/png';currentHtml='image-only bytes';
   const unsupported=(await run('source-image','site.readFirstPartyPage',{url:pageUrl})).toolResults[0]!;
   expect(unsupported.observationStatus).toBe('unsupported');
   contentType='application/pdf';finalUrl=config.CATALOG_BASE_URL+'/documents/'+randomUUID()+'.pdf';
   binary=textPdfPages(['North city office: First street 7. No warehouse here.','South city warehouse: Second street 9. Saturday 10-16.']);
   const pdf=(await run('source-pdf','site.readFirstPartyPage',{url:finalUrl})).toolResults[0]!;
   expect(pdf.payload.format).toBe('pdf');
   expect(pdf.payload.sourceTruncated).toBe(false);
   expect(pdf.payload.text).toContain('North city office: First street 7. No warehouse here.');
   expect(pdf.payload.text).toContain('South city warehouse: Second street 9. Saturday 10-16.');
   binary=undefined;contentType='text/html';currentHtml='<h1>Контакты</h1><p>Регион Север, офис</p>';
   finalUrl=pageUrl+'?city=north';
   const north=(await run('source-north','site.readFirstPartyPage',{url:finalUrl})).toolResults[0]!;
   currentHtml='<h1>Контакты</h1><p>Регион Юг, склад</p>';finalUrl=pageUrl+'?city=south';
   const south=(await run('source-south','site.readFirstPartyPage',{url:finalUrl})).toolResults[0]!;
   expect(north.payload.canonicalUrl).not.toBe(south.payload.canonicalUrl);
   expect(north.payload.sourceFingerprint).not.toBe(south.payload.sourceFingerprint);
   expect(south.payload.text).toContain('Регион Юг, склад');
   finalUrl='https://foreign.invalid/redirect';
   const foreign=(await run('source-foreign','site.readFirstPartyPage',{url:pageUrl})).toolResults[0]!;
   expect(foreign.payload.failureCode).toBe('denied');
   finalUrl=pageUrl+'/challenge';currentHtml='<h1>Access denied</h1><p>Verify browser to continue.</p>';
   const challenge=(await run('source-challenge','site.readFirstPartyPage',{url:finalUrl})).toolResults[0]!;
   expect(challenge.payload.ephemeralPageIdentity).toBeUndefined();
   expect(challenge.payload.pageKind).not.toBe('product');
   for(const [label,body] of [['soft-404','Page not found'],['category','Equipment categories and product list']]){
    finalUrl=pageUrl+'/'+label;currentHtml='<h1>'+body+'</h1>';
    const nonProduct=(await run('source-'+label,'site.readFirstPartyPage',{url:finalUrl})).toolResults[0]!;
    expect(nonProduct.payload.ephemeralPageIdentity).toBeUndefined();
    expect(nonProduct.payload.pageKind).not.toBe('product');
   }
   finalUrl=config.CATALOG_BASE_URL+'/catalog/isolated-'+randomUUID();
   currentHtml='<h1>Генератор Fixture PX-1</h1><div>Артикул: 000778811</div><script type="application/ld+json">'+JSON.stringify({'@type':'Product',url:finalUrl})+'</script>';
   const countBefore=Number((await pool.query('SELECT count(*) AS n FROM products')).rows[0].n);
   const ephemeral=(await run('source-ephemeral','site.readFirstPartyPage',{url:finalUrl})).toolResults[0]!;
   expect(ephemeral.payload.catalogMatch).toBe('absent');
   expect(ephemeral.payload.ephemeralPageIdentity).toMatchObject({status:'page_verified',article:'000778811'});
   expect(Number((await pool.query('SELECT count(*) AS n FROM products')).rows[0].n)).toBe(countBefore);
   await pool.query('ALTER TABLE products RENAME TO isolated_unavailable_products');
   try{
    const dbFailure=(await run('source-reconciliation-db-failure','site.readFirstPartyPage',{url:finalUrl})).toolResults[0]!;
    expect(dbFailure.payload.catalogMatch).toBe('error');
    expect(dbFailure.payload.catalogProductId).toBeUndefined();
    expect(dbFailure.warnings).toContain('first_party_catalog_error');
    expect(dbFailure.warnings).not.toContain('first_party_catalog_absent');
    expect(dbFailure.payload.ephemeralPageIdentity).toMatchObject({status:'page_verified'});
   }finally{await pool.query('ALTER TABLE isolated_unavailable_products RENAME TO products');}
   const saved=await new ConversationRepository().listToolArtifacts(session.id,turn.id);
   const savedRest=saved.find(row=>row.tool_request_id===rest.requestId)!;
   const replay=validateToolResultOutput(ToolResultSchema.parse({requestId:savedRest.tool_request_id,tool:savedRest.tool_name,status:savedRest.status,payload:savedRest.payload,warnings:savedRest.warnings}));
   const callsBefore=fixture.fetch.mock.calls.length;
   const resumed=(await run(rest.requestId,'site.readFirstPartyPage',{url:pageUrl,offset:restOffset,expectedSourceFingerprint:first.payload.sourceFingerprint},new Map([[rest.requestId,replay]]))).toolResults[0]!;
   expect(fixture.fetch.mock.calls.length).toBe(callsBefore);
   expect(compactToolResultsForModel([resumed],[])[0]?.payload.text).toBe(rest.payload.text);
   expect(resumed.payload.sourceFingerprint).toBe(rest.payload.sourceFingerprint);
   const cancelledUrl=pageUrl+'/cancelled',abort=new AbortController();
   let started!:()=>void;
   const began=new Promise<void>(resolve=>{started=resolve;});
   fixture.fetch.mockImplementation(async(_url:string,options:{signal?:AbortSignal})=>new Promise((_resolve,reject)=>{
    options.signal!.addEventListener('abort',()=>reject(options.signal!.reason),{once:true});started();
   }));
   const cancelling=run('source-cancelled','site.readFirstPartyPage',{url:cancelledUrl},new Map(),abort.signal);
   await began;abort.abort();
   const cancelled=(await cancelling).toolResults[0]!;
   expect(cancelled.status).not.toBe('ok');
   expect(cancelled.observationStatus).not.toBe('authoritative_absence');
   expect((await pool.query('SELECT count(*)::int AS n FROM catalog_pages WHERE source_url=$1',[cancelledUrl])).rows[0].n).toBe(0);
   expect((await pool.query("SELECT count(*)::int AS n FROM verified_fact_enrichment_jobs WHERE page_payload->>'sourceUrl'=$1",[cancelledUrl])).rows[0].n).toBe(0);
   console.log(JSON.stringify({status:'PASS',level:'I',checks:['A02','A03','A09','A10/source-change-fence','I03','I07','I08/foreign-redirect-and-challenge','Z14','Z20/multipage-pdf-and-unsupported-image'],modelCalls:0,controlledBoundary:'HTTP bytes only',database:'real PostgreSQL; actual executor persists tool artifacts'}));
  }finally{
   await pool.query("DELETE FROM verified_fact_enrichment_jobs WHERE page_payload->>'sourceUrl'=ANY($1::text[])",[[pageUrl,pageUrl+'/challenge',pageUrl+'/soft-404',pageUrl+'/category']]);
   await pool.query('DELETE FROM catalog_pages WHERE source_url=ANY($1::text[])',[[pageUrl,pageUrl+'/blank']]);
   await pool.query('DELETE FROM conversation_sessions WHERE id=$1',[session.id]);
   await pool.end();
  }
 },30000);
});
