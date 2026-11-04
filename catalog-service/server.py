import base64,hmac,json,os,hashlib,math,time,sqlite3
from functools import lru_cache
from pathlib import Path
from starlette.responses import JSONResponse
from mcp.server.fastmcp import FastMCP
from mcp.types import CallToolResult,TextContent
from mcp.server.transport_security import TransportSecuritySettings
from knowledge import Knowledge
from get_products_batch import get_products_batch as read_product_batch
from embedding_index import EmbeddingIndex,embed_query
import uvicorn
TOKEN=os.environ['BAKAUT_MCP_TOKEN']
EXPECTED_REVISION=os.environ['BAKAUT_EXPECTED_REVISION']
_startup_kb=Knowledge('fts')
if _startup_kb.revision!=EXPECTED_REVISION:
    raise RuntimeError('Catalog revision does not match the configured expected revision')
if _startup_kb.db.execute('select count(*) from products').fetchone()[0]!=int(os.environ.get('BAKAUT_EXPECTED_COUNT','4324')):
    raise RuntimeError('Catalog does not contain the expected number of products')
_startup_kb.close()
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
def semantic_result(kb,requirements,query,minimum,maximum,budget,group='matches',cursor=None,full=False):
    started=time.perf_counter()
    if cursor:
        token=json.loads(base64.urlsafe_b64decode(cursor+'='*(-len(cursor)%4)))
        criteria=token['criteria']
        if token['revision']!=kb.revision or token['group']!=group:
            raise ValueError('Semantic catalog cursor changed')
        offset=token['offset']
        if not isinstance(offset,int) or offset<0:raise ValueError('Invalid semantic cursor offset')
    else:
        criteria={'query':query,'category':None,'min_nominal_kw':minimum,
                  'max_nominal_kw':maximum,'max_price_rub':budget,
                  'semantic_requirements':requirements}
        offset=0
    if not isinstance(criteria['query'],str):raise ValueError('query must be a string')
    for key in ('min_nominal_kw','max_nominal_kw','max_price_rub'):
        number=criteria[key]
        if number is not None and (isinstance(number,bool) or not isinstance(number,(int,float))
                                   or not math.isfinite(number) or number<0):
            raise ValueError('Invalid numeric semantic filter')
        if number is not None:criteria[key]=float(number)
    if (criteria['min_nominal_kw'] is not None and criteria['max_nominal_kw'] is not None
            and criteria['min_nominal_kw']>criteria['max_nominal_kw']):
        raise ValueError('Invalid semantic numeric range')
    digest=hashlib.sha256(json.dumps([kb.revision,criteria],sort_keys=True,ensure_ascii=False).encode()).hexdigest()[:24]
    if cursor and token['snapshot']!=digest:raise ValueError('Semantic cursor snapshot changed')
    chosen=kb.semantic_selection(criteria['semantic_requirements'],criteria['min_nominal_kw'],
                                 criteria['max_nominal_kw'],criteria['max_price_rub'])
    groups=chosen['groups']
    if group not in groups:raise ValueError('Invalid semantic result group')
    counts={name:len(items) for name,items in groups.items()}
    applied={key:value for key,value in criteria.items() if key!='query' and value is not None}
    unsupported=['query'] if criteria['query'].strip() else []
    result={'status':'ok','criteria':criteria,'applied_filters':applied,
            'unsupported_filters':unsupported,'snapshot':digest,'group':group,
            'count':counts[group],'counts':counts,'candidates_checked':chosen['candidates_checked'],
            'semantic_scan_complete':True,'numeric_scan_complete':True,
            'source_scan_complete':True,'candidate_basis':'full_semantic_concept_scan',
            'source_revision':kb.revision,'price_source':'catalog','stock':'unknown'}
    if full:
        result.update(groups=groups,excluded=chosen['excluded'],has_more=False)
    else:
        items=groups[group]
        end=len(items) if criteria['query'].strip() else offset+10
        next_cursor=None
        if end<len(items):
            next_cursor=base64.urlsafe_b64encode(json.dumps({'criteria':criteria,'revision':kb.revision,
                'group':group,'offset':end,'snapshot':digest},ensure_ascii=False,separators=(',',':')).encode()).decode().rstrip('=')
        result.update(items=items[offset:end],next_cursor=next_cursor,
                      has_more=next_cursor is not None,remaining=max(0,len(items)-end),
                      review_examples=groups['needs_check'][:4]+groups['unknown'][:4])
    result['retrieval_ms']=round((time.perf_counter()-started)*1000,2)
    return result
@server.tool(structured_output=False)
def search_products(query:str='',category:str|None=None,min_nominal_kw:float|None=None,max_nominal_kw:float|None=None,max_price_rub:float|None=None,cursor:str|None=None,group:str='matches',semantic_requirements:list[dict]|None=None)->CallToolResult:
    """Search all catalog identities. For complete semantic selection first read semantic_concepts for each required kind, then pass semantic_requirements=[{'kind':kind,'decisions':{every_concept_key:'match'|'exclude'|'uncertain'}}]. Include every key, and omit category. Add numeric filters separately; query must be empty only when those structured requirements express every mandatory buyer condition. A semantic result accounts for every card, with unknown and needs_check separated. The legacy text/category path cannot guarantee semantic completeness. Stable revision, snapshot and cursor identify the result."""
    kb=Knowledge('fts')
    try:
        semantic_cursor=False
        if cursor:
            try:
                token=json.loads(base64.urlsafe_b64decode(cursor+'='*(-len(cursor)%4)))
                semantic_cursor='semantic_requirements' in token.get('criteria',{})
            except (ValueError,TypeError,AttributeError):pass
        if semantic_requirements is not None or semantic_cursor:
            if category is not None:raise ValueError('Semantic search scans the entire catalog; category must be omitted')
            return compact_result(semantic_result(kb,semantic_requirements,query,min_nominal_kw,
                                                  max_nominal_kw,max_price_rub,group,cursor))
        return compact_result(kb.search_products(query,category,min_nominal_kw,max_nominal_kw,max_price_rub,cursor,group))
    finally:kb.close()
@server.tool(structured_output=False)
def get_product(identifier:str,fields:list[str]|None=None)->CallToolResult:
    """Read one original card by product ID, SKU, model or URL. Preserve SKU ambiguity and conflicting source fields. Use for additional facts not present in search results."""
    return compact_result(Knowledge('fts').get_product(identifier,fields))
@server.tool(structured_output=False)
def get_products_batch(identifiers:list[str],fields:list[str],expected_revision:str|None=None)->CallToolResult:
    """Read only requested missing fields for up to 100 exact product_id values. Pass source_revision as expected_revision. Null means unknown. Do not reread fields already supplied by search; use web for unresolved material facts."""
    return compact_result(read_product_batch(Knowledge('fts'),identifiers,fields,expected_revision))
@server.tool(structured_output=False)
def semantic_concepts(kind:str)->CallToolResult:
    """Read the complete evidence-backed concept vocabulary for one kind in this catalog revision. This is reference data for model interpretation of a buyer request; synonyms are not the selection boundary."""
    kb=Knowledge('fts')
    try:return compact_result(kb.semantic_concepts(kind))
    finally:kb.close()
@server.tool(structured_output=False)
def semantic_rank_products(query:str,offset:int=0,page_size:int=50)->CallToolResult:
    """Rank ALL 4324 original cards by meaning. Pages are transport only: next_offset reaches every card. Ranking discovers candidates; it does not prove eligibility or complete selection. Check exact card data and structured filters before recommending."""
    return compact_result(ranked_products(query,offset,page_size))
@server.custom_route('/health',methods=['GET'])
async def health(request):
    kb=Knowledge('fts');root=Path(__file__).parent
    try:
        code_hash=hashlib.sha256(b''.join((root/name).read_bytes() for name in ('server.py','knowledge.py','get_products_batch.py','embedding_index.py','semantic_index.py'))).hexdigest()
        index_path=os.environ.get('BAKAUT_EMBEDDING_DB_PATH')
        index_status='unavailable';index_cards=0
        if index_path and Path(index_path).is_file():
            try:
                index=embedding_index();index_status='ready';index_cards=index.info['products']
            except (ValueError,sqlite3.Error,KeyError):index_status='stale'
        semantic_cards=kb.semantic.execute('SELECT COUNT(*) FROM products').fetchone()[0] if kb.semantic else 0
        return JSONResponse({'status':'ok','cards':kb.db.execute('select count(*) from products').fetchone()[0],
            'semantic_cards':semantic_cards,'revision':kb.revision,'code_sha256':code_hash,
            'commit_sha':os.environ.get('RAILWAY_GIT_COMMIT_SHA'),
            'embedding_status':index_status,'embedding_cards':index_cards})
    finally:kb.close()
@server.custom_route('/search-full',methods=['POST'])
async def search_full(request):
    """Server-side complete selection from one catalog revision, not model pagination."""
    try:
        body=await request.json()
        allowed={'query','category','min_nominal_kw','max_nominal_kw','max_price_rub','semantic_requirements','expected_revision'}
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
        if body.get('semantic_requirements') is not None:
            if args.get('category') is not None:raise ValueError('Semantic search cannot filter by category')
            result=semantic_result(kb,body['semantic_requirements'],args.get('query',''),
                args.get('min_nominal_kw'),args.get('max_nominal_kw'),args.get('max_price_rub'),full=True)
            return JSONResponse(result)
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
