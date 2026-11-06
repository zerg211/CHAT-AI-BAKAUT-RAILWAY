import hmac,json,os,hashlib,sqlite3,base64,threading,urllib.request
from collections import OrderedDict
from functools import lru_cache
from pathlib import Path
from starlette.responses import JSONResponse
from mcp.server.fastmcp import FastMCP
from mcp.types import CallToolResult,TextContent
from mcp.server.transport_security import TransportSecuritySettings
from knowledge import Knowledge
from get_products_batch import get_products_batch as read_product_batch
from embedding_index import EmbeddingIndex,embed_query
from semantic_selector import MODEL as SELECTOR_MODEL,select_products
import uvicorn
TOKEN=os.environ['BAKAUT_MCP_TOKEN']
EXPECTED_REVISION=os.environ['BAKAUT_EXPECTED_REVISION']
_startup_kb=Knowledge('fts')
if _startup_kb.revision!=EXPECTED_REVISION:
    raise RuntimeError('Catalog revision does not match the configured expected revision')
if _startup_kb.db.execute('select count(*) from products').fetchone()[0]!=int(os.environ.get('BAKAUT_EXPECTED_COUNT','4324')):
    raise RuntimeError('Catalog does not contain the expected number of products')
_startup_kb.db.close()
hosts=['127.0.0.1:*','localhost:*','healthcheck.railway.app']
if os.environ.get('RAILWAY_PUBLIC_DOMAIN'):hosts.append(os.environ['RAILWAY_PUBLIC_DOMAIN'])
if os.environ.get('BAKAUT_PUBLIC_HOSTNAME'):hosts.append(os.environ['BAKAUT_PUBLIC_HOSTNAME'])
server=FastMCP('BAKAUT indexed catalog',stateless_http=True,json_response=True,transport_security=TransportSecuritySettings(enable_dns_rebinding_protection=True,allowed_hosts=hosts))

@lru_cache(maxsize=2)
def loaded_embedding_index(path,mtime_ns,revision):
    index=EmbeddingIndex(os.environ['BAKAUT_DB_PATH'],path)
    if index.info['source_revision']!=revision:raise ValueError('Embedding index has a different catalog revision')
    return index

def embedding_index():
    path=os.environ.get('BAKAUT_EMBEDDING_DB_PATH')
    if not path or not Path(path).is_file():raise ValueError('Embedding index is not configured')
    kb=Knowledge('fts')
    try:revision=kb.revision
    finally:kb.db.close()
    return loaded_embedding_index(path,Path(path).stat().st_mtime_ns,revision)

@lru_cache(maxsize=32)
def cached_ranking(query,path,mtime_ns,revision):
    index=loaded_embedding_index(path,mtime_ns,revision)
    vector,usage=embed_query(query,index.info['model'],index.info['dimensions'])
    return tuple(index.rank(vector)),usage

@lru_cache(maxsize=128)
def cached_semantic_selection(revision,path,mtime_ns,requirement,category,min_nominal_kw,max_nominal_kw,max_price_rub):
    kb=Knowledge('fts')
    try:
        if kb.revision!=revision:raise ValueError('Catalog revision changed during selection')
        ranked,usage=cached_ranking(requirement,path,mtime_ns,revision)
        if len(ranked)!=kb.db.execute('SELECT COUNT(*) FROM products').fetchone()[0]:
            raise ValueError('Embedding ranking lost a catalog product')
        return select_products(kb,requirement,category,min_nominal_kw,max_nominal_kw,
            max_price_rub,ranking=ranked,embedding_tokens=usage)
    finally:kb.db.close()

_selection_aliases=OrderedDict()
_selection_alias_lock=threading.Lock()

def equivalent_cached_requirement(requirement,known,category):
    """Reuse a result only when the model confirms identical product eligibility."""
    body=json.dumps({'model':SELECTOR_MODEL,'reasoning':{'effort':'low'},
        'instructions':('Compare requirements only for products already filtered to the supplied category. '
            'A category name added to a requirement does not change eligibility within that category. '
            'Copy the EXACT text of one previous requirement into "match" only if both requirements '
            'would include and exclude exactly the same products within the category. '
            'Different model, size, material, use, negation, or other condition means no match. '
            'If unsure, return null. Return only JSON: {"match":previous_requirement_text_or_null}.'),
        'input':json.dumps({'category':category,'new':requirement,'previous':known},ensure_ascii=False),
        'max_output_tokens':800},ensure_ascii=False).encode()
    request=urllib.request.Request('https://api.openai.com/v1/responses',data=body,method='POST',
        headers={'Authorization':'Bearer '+os.environ['OPENAI_API_KEY'],'Content-Type':'application/json'})
    try:
        with urllib.request.urlopen(request,timeout=12) as response:result=json.load(response)
        if result.get('status')!='completed':return None,None
        output=''.join(part.get('text','') for item in result.get('output',[])
            for part in item.get('content',[]) if part.get('type')=='output_text')
        match=json.loads(output).get('match')
        if not isinstance(match,str) or match not in known:return None,None
        usage=result.get('usage') or {}
        return match,{'run_id':result['id'],'model':SELECTOR_MODEL,
            'input_tokens':int(usage.get('input_tokens') or 0),
            'output_tokens':int(usage.get('output_tokens') or 0),
            'cached_input_tokens':int((usage.get('input_tokens_details') or {}).get('cached_tokens') or 0)}
    except (OSError,ValueError,KeyError,TimeoutError):
        return None,None

def selection_with_cache(revision,path,mtime_ns,requirement,category,min_nominal_kw,max_nominal_kw,max_price_rub):
    base=(revision,path,mtime_ns,category,min_nominal_kw,max_nominal_kw,max_price_rub)
    key=(base,requirement)
    with _selection_alias_lock:
        alias=_selection_aliases.get(key)
        known=list(dict.fromkeys(source for (candidate_base,_),source in reversed(_selection_aliases.items())
            if candidate_base==base))[:32] if alias is None else []
    lookup=None
    if alias is None and known:
        alias,lookup=equivalent_cached_requirement(requirement,known,category)
    source=alias or requirement
    selection=cached_semantic_selection(revision,path,mtime_ns,source,category,
        min_nominal_kw,max_nominal_kw,max_price_rub)
    with _selection_alias_lock:
        _selection_aliases[key]=source
        _selection_aliases.move_to_end(key)
        while len(_selection_aliases)>128:_selection_aliases.popitem(last=False)
    if source!=requirement:
        return {**selection,'cache_hit':True,**({'cache_lookup_usage':lookup} if lookup else {})}
    return selection

def ranked_products(query,offset=0,page_size=50):
    if not isinstance(query,str) or not query.strip():raise ValueError('query must be a nonempty string')
    if not isinstance(offset,int) or offset<0:raise ValueError('offset must be a nonnegative integer')
    if not isinstance(page_size,int) or page_size<1 or page_size>200:raise ValueError('page_size must be 1..200')
    index=embedding_index()
    path=os.environ['BAKAUT_EMBEDDING_DB_PATH']
    kb=Knowledge('fts')
    try:
        ranked,usage=cached_ranking(query,path,Path(path).stat().st_mtime_ns,kb.revision)
        if len(ranked)!=kb.db.execute('SELECT COUNT(*) FROM products').fetchone()[0]:
            raise ValueError('Embedding ranking lost a catalog product')
        items=[]
        for product_id,score in ranked[offset:offset+page_size]:
            row=kb.row(product_id)
            if row is None:raise ValueError('Embedding product is missing from the catalog')
            items.append({**kb.compact(row),'similarity':round(score,5)})
        return {'status':'ok','query':query,'items':items,'count':len(ranked),
                'offset':offset,'next_offset':offset+len(items) if offset+len(items)<len(ranked) else None,
                'source_revision':kb.revision,'index_model':index.info['model'],
                'candidate_basis':'complete_catalog_embedding_ranking',
                'selection_complete':False,'input_tokens':usage}
    finally:kb.db.close()

def compact_result(data):return CallToolResult(content=[TextContent(type='text',text=json.dumps(data,ensure_ascii=False,separators=(',',':')))])
@server.tool(structured_output=False)
def list_categories()->CallToolResult:
    """List the current catalog categories and product counts for choosing where to search. This does not select products."""
    kb=Knowledge('fts')
    try:
        rows=kb.db.execute('SELECT category, COUNT(*) AS count FROM products GROUP BY category ORDER BY category').fetchall()
        return compact_result({'status':'ok','source_revision':kb.revision,
            'categories':[{'name':row['category'],'count':row['count']} for row in rows]})
    finally:kb.db.close()
@server.tool(structured_output=False)
def search_products(query:str='',category:str|None=None,min_nominal_kw:float|None=None,max_nominal_kw:float|None=None,max_price_rub:float|None=None,cursor:str|None=None,group:str='matches')->CallToolResult:
    """Search catalog. Generator category choices: Инверторные генераторы, Бензиновые генераторы, Дизельные генераторы, Газовые генераторы, Сварочные генераторы; генераторы includes all five. min_nominal_kw/max_nominal_kw refer to the selected generator or power station's own nominal electrical output, not the rating of equipment it fits. For numeric filters choose the most precise actual category: numeric search does not apply query text, reported in unsupported_filters. applied_filters lists only enforced constraints. Unknown or conflicting fields remain separately grouped. Text matching is evidence, not proof of an arbitrary property; source_scan_complete does not cover all synonyms. Page results have stable revision, snapshot and next_cursor."""
    return compact_result(Knowledge('fts').search_products(query,category,min_nominal_kw,max_nominal_kw,max_price_rub,cursor,group))
@server.tool(structured_output=False)
def get_product(identifier:str,fields:list[str]|None=None)->CallToolResult:
    """Read one original card by product ID, SKU, model or URL. Preserve SKU ambiguity and conflicting source fields. Use for additional facts not present in search results."""
    return compact_result(Knowledge('fts').get_product(identifier,fields))
@server.tool(structured_output=False)
def get_products_batch(identifiers:list[str],fields:list[str],expected_revision:str|None=None)->CallToolResult:
    """Read only requested missing fields for up to 100 exact product_id values. Pass source_revision as expected_revision. Null means unknown. Do not reread fields already supplied by search; use web for unresolved material facts."""
    return compact_result(read_product_batch(Knowledge('fts'),identifiers,fields,expected_revision))
@server.tool(structured_output=False)
def semantic_rank_products(query:str,offset:int=0,page_size:int=50)->CallToolResult:
    """Rank ALL 4324 original cards by meaning. Pages are transport only: next_offset reaches every card. Ranking discovers candidates; it does not prove eligibility or complete selection. Check exact card data and structured filters before recommending."""
    return compact_result(ranked_products(query,offset,page_size))
@server.tool(structured_output=False)
def semantic_select_products(requirement:str,category:str,min_nominal_kw:float|None=None,max_nominal_kw:float|None=None,max_price_rub:float|None=None)->CallToolResult:
    """Check every product in the named category against one buyer requirement, including the requested product type. For several relevant categories call once per category. min_nominal_kw/max_nominal_kw filter the selected generator or power station's own nominal electrical output; put compatible-machine ratings and accessory dimensions in requirement instead. Return complete classification, selected_products with IDs and names, a short preview, and source revision. No top-k cutoff. The chat server loads all cards directly."""
    kb=Knowledge('fts')
    try:revision=kb.revision
    finally:kb.db.close()
    path=os.environ['BAKAUT_EMBEDDING_DB_PATH']
    return compact_result(selection_with_cache(revision,path,Path(path).stat().st_mtime_ns,
        requirement,category,min_nominal_kw,max_nominal_kw,max_price_rub))
@server.custom_route('/health',methods=['GET'])
async def health(request):
    kb=Knowledge('fts');root=Path(__file__).parent
    code_hash=hashlib.sha256(b''.join((root/name).read_bytes() for name in ('server.py','knowledge.py','get_products_batch.py','embedding_index.py','semantic_selector.py'))).hexdigest()
    index_path=os.environ.get('BAKAUT_EMBEDDING_DB_PATH')
    index_status='unavailable';index_cards=0
    if index_path and Path(index_path).is_file():
        try:
            index=embedding_index();index_status='ready';index_cards=index.info['products']
        except (ValueError,sqlite3.Error,KeyError):index_status='stale'
    return JSONResponse({'status':'ok','cards':kb.db.execute('select count(*) from products').fetchone()[0],
        'revision':kb.revision,'code_sha256':code_hash,'commit_sha':os.environ.get('RAILWAY_GIT_COMMIT_SHA'),
        'embedding_status':index_status,'embedding_cards':index_cards})
@server.custom_route('/mentioned-products',methods=['POST'])
async def mentioned_products(request):
    supplied=request.headers.get('authorization','')
    if not hmac.compare_digest(supplied,'Bearer '+TOKEN):
        return JSONResponse({'status':'unauthorized'},status_code=401)
    try:
        body=await request.json()
        if not isinstance(body,dict) or set(body)!={'message'}:
            raise ValueError('Expected only message')
        kb=Knowledge('fts')
        try:result=kb.mentioned_products(body['message'])
        finally:kb.db.close()
        return JSONResponse(result)
    except (ValueError,TypeError):
        return JSONResponse({'status':'invalid_request'},status_code=400)
@server.custom_route('/search-full',methods=['POST'])
async def search_full(request):
    """Server-side complete selection from one catalog revision, not model pagination."""
    try:
        body=await request.json()
        allowed={'query','category','min_nominal_kw','max_nominal_kw','max_price_rub','expected_revision'}
        if not isinstance(body,dict):raise ValueError('Expected an object')
        extras=sorted(set(body)-allowed)
        if extras:return JSONResponse({'status':'unsupported_filters','unsupported_filters':extras},status_code=400)
        args={key:body[key] for key in ('query','category','min_nominal_kw','max_nominal_kw','max_price_rub') if key in body}
        if 'query' in args and not isinstance(args['query'],str):raise ValueError('query must be a string')
        if args.get('category') is not None and not isinstance(args['category'],str):raise ValueError('category must be a string or null')
        for key in ('min_nominal_kw','max_nominal_kw','max_price_rub'):
            if args.get(key) is not None and (isinstance(args[key],bool) or not isinstance(args[key],(int,float))):raise ValueError(key+' must be a number or null')
        kb=Knowledge('fts')
        if body.get('expected_revision') is not None and body['expected_revision']!=kb.revision:
            return JSONResponse({'status':'revision_changed','source_revision':kb.revision},status_code=409)
        first=kb.search_products(**args,group='matches')
        if first.get('status')!='ok':return JSONResponse(first,status_code=400)
        snapshot=next(reversed(kb.snapshots.values()))
        groups=snapshot['groups']
        identifiers=[item['product_id'] for items in groups.values() for item in items]
        if len(identifiers)!=len(set(identifiers)):raise ValueError('Duplicate product in catalog snapshot')
        result={key:value for key,value in first.items() if key not in ('items','next_cursor','remaining','has_more','group')}
        result.update(snapshot=snapshot['snapshot'],groups=groups,has_more=False)
        return JSONResponse(result)
    except (ValueError,KeyError,TypeError) as e:return JSONResponse({'status':'invalid_request','error':str(e)},status_code=400)
@server.custom_route('/semantic-selection',methods=['POST'])
async def semantic_selection(request):
    """Rebuild and hydrate a semantic selection from its compact status code."""
    try:
        body=await request.json()
        if not isinstance(body,dict) or set(body)!={'criteria','status_blob','candidate_count','snapshot','expected_revision'}:
            raise ValueError('Invalid selection request')
        criteria=body['criteria']
        if not isinstance(criteria,dict) or set(criteria)!={'requirement','category','min_nominal_kw','max_nominal_kw','max_price_rub'}:
            raise ValueError('Invalid selection criteria')
        if not isinstance(body['candidate_count'],int) or not 0<=body['candidate_count']<=4324:
            raise ValueError('Invalid candidate count')
        if not isinstance(body['status_blob'],str) or len(body['status_blob'])>1500:
            raise ValueError('Invalid status code')
        kb=Knowledge('fts')
        if body['expected_revision']!=kb.revision:
            return JSONResponse({'status':'revision_changed','source_revision':kb.revision},status_code=409)
        page=kb.search_products(category=criteria['category'],min_nominal_kw=criteria['min_nominal_kw'],
            max_nominal_kw=criteria['max_nominal_kw'],max_price_rub=criteria['max_price_rub'])
        if page.get('status')!='ok':raise ValueError('Catalog category changed')
        snapshot=kb.snapshots[page['snapshot']]
        candidates=[item for group in ('matches','needs_check','unknown') for item in snapshot['groups'][group]]
        if len(candidates)!=body['candidate_count'] or snapshot['criteria']['category']!=criteria['category']:
            raise ValueError('Catalog candidate universe changed')
        packed=base64.urlsafe_b64decode(body['status_blob']+'='*(-len(body['status_blob'])%4))
        if len(packed)!=(len(candidates)+3)//4:raise ValueError('Invalid status code length')
        selected=[];uncertain=[];rejected=[]
        for index,item in enumerate(candidates):
            code=(packed[index//4]>>(2*(index%4)))&3
            if code==1:selected.append(item['product_id'])
            elif code==2:uncertain.append(item['product_id'])
            elif code==0:rejected.append(item['product_id'])
            else:raise ValueError('Invalid product status')
        canonical_criteria={'requirement':criteria['requirement'],
            'category':snapshot['criteria']['category'],
            'min_nominal_kw':snapshot['criteria']['min_nominal_kw'],
            'max_nominal_kw':snapshot['criteria']['max_nominal_kw'],
            'max_price_rub':snapshot['criteria']['max_price_rub']}
        fingerprint=hashlib.sha256(json.dumps([kb.revision,canonical_criteria,selected,uncertain,rejected],
            ensure_ascii=False,sort_keys=True).encode()).hexdigest()[:24]
        if fingerprint!=body['snapshot']:raise ValueError('Selection fingerprint mismatch')
        result=[]
        uncertain_ids=set(uncertain)
        for ident in selected+uncertain:
            row=kb.row(ident)
            if row is None:raise ValueError('Selected product is absent from catalog')
            item=kb.compact(row)
            if ident in uncertain_ids:item['match_status']='uncertain'
            result.append(item)
        return JSONResponse({'status':'ok','source_revision':kb.revision,'items':result})
    except (ValueError,KeyError,TypeError) as error:
        return JSONResponse({'status':'invalid_request','error':str(error)},status_code=400)
@server.custom_route('/semantic-select-buyer',methods=['POST'])
async def semantic_select_buyer(request):
    try:
        body=await request.json()
        allowed={'requirement','category','min_nominal_kw','max_nominal_kw','max_price_rub','expected_revision'}
        if not isinstance(body,dict) or set(body)!=allowed:raise ValueError('Invalid buyer selection request')
        if not isinstance(body['requirement'],str) or not body['requirement'].strip() or len(body['requirement'])>600:
            raise ValueError('Invalid buyer requirement')
        if not isinstance(body['category'],str) or not body['category'].strip():raise ValueError('Invalid category')
        for key in ('min_nominal_kw','max_nominal_kw','max_price_rub'):
            value=body[key]
            if value is not None and (isinstance(value,bool) or not isinstance(value,(int,float))):raise ValueError('Invalid numeric filter')
        kb=Knowledge('fts')
        try:revision=kb.revision
        finally:kb.db.close()
        if body['expected_revision']!=revision:
            return JSONResponse({'status':'revision_changed','source_revision':revision},status_code=409)
        path=os.environ['BAKAUT_EMBEDDING_DB_PATH']
        result=selection_with_cache(revision,path,Path(path).stat().st_mtime_ns,
            body['requirement'],body['category'],body['min_nominal_kw'],body['max_nominal_kw'],body['max_price_rub'])
        return JSONResponse(result)
    except (ValueError,KeyError,TypeError) as error:
        return JSONResponse({'status':'invalid_request','error':str(error)},status_code=400)
inner=server.streamable_http_app()
class Auth:
    async def __call__(self,scope,receive,send):
        if scope['type']=='http' and scope.get('path')!='/health':
            headers=dict(scope.get('headers',[]));auth=headers.get(b'authorization',b'').decode('utf8','replace')
            if not hmac.compare_digest(auth,'Bearer '+TOKEN):
                await JSONResponse({'error':'unauthorized'},status_code=401)(scope,receive,send);return
        await inner(scope,receive,send)
app=Auth()
if __name__=='__main__':uvicorn.run(app,host=os.environ.get('BAKAUT_BIND_HOST','0.0.0.0'),port=int(os.environ.get('PORT','8000')),access_log=False)
