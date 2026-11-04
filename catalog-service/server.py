import hmac,json,os,hashlib
from pathlib import Path
from starlette.responses import JSONResponse
from mcp.server.fastmcp import FastMCP
from mcp.types import CallToolResult,TextContent
from mcp.server.transport_security import TransportSecuritySettings
from knowledge import Knowledge
from get_products_batch import get_products_batch as read_product_batch
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
def compact_result(data):return CallToolResult(content=[TextContent(type='text',text=json.dumps(data,ensure_ascii=False,separators=(',',':')))])
@server.tool(structured_output=False)
def search_products(query:str='',category:str|None=None,min_nominal_kw:float|None=None,max_nominal_kw:float|None=None,max_price_rub:float|None=None,cursor:str|None=None,group:str='matches')->CallToolResult:
    """Search catalog. Generator category choices: Инверторные генераторы, Бензиновые генераторы, Дизельные генераторы, Газовые генераторы, Сварочные генераторы; генераторы includes all five. For numeric filters choose the most precise actual category: numeric search does not apply query text, reported in unsupported_filters. applied_filters lists only enforced constraints. Unknown or conflicting fields remain separately grouped. Text matching is evidence, not proof of an arbitrary property; source_scan_complete does not cover all synonyms. Page results have stable revision, snapshot and next_cursor."""
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
def semantic_concepts(kind:str)->CallToolResult:
    """Read the complete evidence-backed concept vocabulary for one kind in this catalog revision. This is reference data for model interpretation of a buyer request; synonyms are not the selection boundary."""
    kb=Knowledge('fts')
    try:return compact_result(kb.semantic_concepts(kind))
    finally:kb.close()
@server.custom_route('/health',methods=['GET'])
async def health(request):
    kb=Knowledge('fts');root=Path(__file__).parent
    code_hash=hashlib.sha256(b''.join((root/name).read_bytes() for name in ('server.py','knowledge.py','get_products_batch.py'))).hexdigest()
    return JSONResponse({'status':'ok','cards':kb.db.execute('select count(*) from products').fetchone()[0],
        'revision':kb.revision,'code_sha256':code_hash,'commit_sha':os.environ.get('RAILWAY_GIT_COMMIT_SHA')})
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
