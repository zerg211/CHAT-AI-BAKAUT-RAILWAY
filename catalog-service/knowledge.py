"""Read-only retrieval handlers for the saved BAKAUT agent. No user interface."""
import base64,hashlib,json,math,os,re,sqlite3,time,unicodedata
from pathlib import Path

ROOT=Path(__file__).resolve().parent
DB=Path(os.environ.get('BAKAUT_DB_PATH', str(ROOT/'knowledge.sqlite')))
SUMMARY_COLUMNS='id,sku,title,category,url,price,powers,source,sha'
REMOTE_EVIDENCE_RE=re.compile(r'дистанционн.{0,30}(?:управ|пульт)|(?:управ|пульт).{0,30}дистанционн|(?:\bик\b|инфракрасн).{0,30}(?:управ|пульт)|(?:управ|пульт).{0,30}(?:\bик\b|инфракрасн)|радиоуправ|радио[- ]?пульт|remote\s*control|(?:bluetooth.{0,20}(?:пульт|управ|радио)|(?:пульт|управ|радио).{0,20}bluetooth)|пульт.{0,15}\bду\b|\bду\b.{0,15}пульт',re.I)
def norm(s):return unicodedata.normalize('NFKC',str(s)).casefold().replace('ё','е').strip()
class Knowledge:
    cutting_facts_cache={}
    def __init__(self,retrieval_backend='fts'):
        if retrieval_backend!='fts':raise ValueError('Unsupported retrieval backend')
        self.db=sqlite3.connect('file:'+DB.resolve().as_posix()+'?mode=ro',uri=True);self.db.row_factory=sqlite3.Row
        self.revision=self.db.execute('select revision from metadata').fetchone()[0];self.snapshots={};self.log=[]
    def row(self,ident):return self.db.execute('SELECT * FROM products WHERE id=?',(ident,)).fetchone()
    def source_evidence(self,r,query):
        if not re.search(r'дистанц|пульт|радиоуправ|инфракрас|bluetooth|remote',norm(query)):return None
        raw=json.loads(self.row(r['id'])['raw']);attrs=raw.get('характеристики') or {};facts=[]
        def segments(value):return [' '.join(x.split()) for x in re.split(r'(?<=[.!?])\s+|[;\n]+',str(value)) if x.strip()]
        for key,value in attrs.items():
            text='; '.join(x for x in segments(value) if REMOTE_EVIDENCE_RE.search(norm(x)))
            if text:
                facts.append({'field':str(key)[:120],'text':text[:420]})
                if len(facts)>=5:break
        snippets=[]
        for excerpt in segments(raw.get('описание') or ''):
            if REMOTE_EVIDENCE_RE.search(norm(excerpt)) and excerpt not in snippets:snippets.append(excerpt[:320])
            if len(snippets)>=2:break
        return {'attributes':facts,'description_excerpts':snippets}
    def compact(self,r,notes=None,evidence=None):
        result={'product_id':r['id'],'name':r['title'],'sku':r['sku'],'category':r['category'],'price_rub':r['price'],'url':r['url'],'nominal_electrical_power':json.loads(r['powers']),'conditions':notes or []}
        technical=self.cutting_evidence(r)
        if technical:result['cutting_evidence']=technical
        if evidence is not None:result['source_evidence']=evidence
        return result
    def cutting_evidence(self,r):
        """Expose source-labelled cutting facts, without inferring compatibility."""
        category=norm(r['category'])
        if category not in ('алмазные диски','абразивные диски','швонарезчики и резчики'):return None
        cache_key=(self.revision,r['id'],r['sha'])
        if cache_key in self.cutting_facts_cache:return self.cutting_facts_cache[cache_key]
        raw=json.loads(self.row(r['id'])['raw']);attrs=raw.get('характеристики') or {}
        if not isinstance(attrs,dict):
            self.cutting_facts_cache[cache_key]=None
            return None
        keys={
            'diameter':('диаметр режущего диска, мм','диаметр диска, мм','наружный диаметр, мм','максимальный диаметр режущего диска (диаметр алмазного кольца), мм','максимальный диаметр режущего диска в данной комплектации, мм','минимальный диаметр режущего диска, мм','минимальный диаметр диска, мм','диапазон диаметров применяемых дисков'),
            'bore':('диаметр посадочного отверстия, мм','посадка, мм','посадочный диаметр, мм','посадочный диаметр диска, мм','посадочное отверстие, мм','особенности посадки по oem','сменные втулки под посадочное отверстие диска'),
            'materials':('оптимальные материалы по oem','оптимальные материалы','материал резки','материалы по текущему oem gs50s','материалы по каталогу husqvarna 2021','подбор материала по oem cat2021','допустимые материалы и ограничения','не рекомендованные материалы по каталогу oem 2021','режим и назначение инструмента'),
            'speed':('требуемый скоростной рейтинг диска 350 мм','требуемая маркировка скорости диска 300 мм, об./мин','требование к допустимой скорости диска','скоростная маркировка рекомендуемого диска, об/мин','скорость диска, об/мин'),
        }
        wanted={key:group for group,names in keys.items() for key in names}
        result={}
        for key,value in attrs.items():
            group=wanted.get(norm(key))
            if group and value is not None and str(value).strip():
                result.setdefault(group,[]).append({'field':str(key),'raw':str(value)})
        self.cutting_facts_cache[cache_key]=result or None
        return self.cutting_facts_cache[cache_key]
    def exact(self,identifier):
        key=norm(identifier)
        if not key:return []
        if re.fullmatch(r'[0-9a-f]{24}',key):
            row=self.row(key)
            return [row] if row else []
        ids=[r['id'] for r in self.db.execute('SELECT id,sku,title,url FROM products') if key in (norm(r['id']),norm(r['sku']),norm(r['title']),norm(r['url']))]
        if not ids and re.search(r'\d',key) and len(key)>=5:
            pattern=re.compile(r'(?<!\w)'+re.escape(key)+r'(?!\w)')
            ids=[r['id'] for r in self.db.execute('SELECT id,title FROM products') if pattern.search(norm(r['title']))]
        return [self.row(ident) for ident in ids]
    def get_product(self,identifier,fields=None):
        matches=self.exact(identifier)
        if len(matches)!=1:return {'status':'ambiguous' if matches else 'not_found','candidates':[self.compact(r) for r in matches[:10]]}
        r=matches[0];d=json.loads(r['raw'])
        # Full original attributes are returned for the exact product. Images never inflate model context.
        result={'status':'found','product_id':r['id'],'name':r['title'],'sku':r['sku'],'url':r['url'],'category':r['category'],'source_file':r['source'],'source_sha256':r['sha'],'price_rub':r['price'],'price_current':False,'stock':'unknown'}
        if fields:
            aliases={**result,'nominal_electrical_power':json.loads(r['powers']),'conditions':[],'attributes':d.get('характеристики',{}),'description':d.get('описание',''),'documents':d.get('документы',[]),'brand':d.get('бренд')}
            result['fields']={k:aliases.get(k,d.get(k,(d.get('характеристики') or {}).get(k))) for k in fields}
        else:
            result.update(brand=d.get('бренд'),attributes=d.get('характеристики',{}),description=d.get('описание',''),documents=d.get('документы',[]))
        return result
    def classify(self,r,lo,hi,budget):
        if budget is not None and r['price'] is not None and r['price']>budget:return 'excluded',[]
        facts=json.loads(r['powers']);known=[f for f in facts if f['kw'] is not None and f['mode']!='per_phase']
        if lo is not None or hi is not None:
            if not known:return 'unknown',['номинальная электрическая мощность не определена']
            inside=lambda f:(lo is None or f['kw']>=lo) and (hi is None or f['kw']<=hi)
            if not any(inside(f) for f in known):return ('unknown',['есть нераспознанная номинальная характеристика']) if any(f['kw'] is None for f in facts) else ('excluded',[])
            if any(f['kw'] is None for f in facts):return 'needs_check',['есть нераспознанная номинальная характеристика']
            groups={m:{f['kw'] for f in known if f['mode']==m} for m in ('general','220','380','petrol','gas')}
            conflict=any(len(vals)>1 for vals in groups.values())
            if groups['general']:
                target=groups['380'] or groups['220']
                if target and target!=groups['general']:conflict=True
            if conflict:return 'needs_check',['противоречивые номинальные значения']
            notes=[] if all(inside(f) for f in known) else ['подходит только при определённом напряжении или топливе; см. исходные значения']
        else:notes=[]
        if budget is not None:
            if r['price'] is None:return 'needs_check',['нет цены для проверки бюджета']
            if r['price']>budget:return 'excluded',[]
        return 'matches',notes
    def search_products(self,query='',category=None,min_nominal_kw=None,max_nominal_kw=None,max_price_rub=None,cursor=None,group='matches',cutting_diameters_mm=None,max_cutting_diameter_mm=None):
        start_time=time.perf_counter()
        if cursor:
            try:
                token=json.loads(base64.urlsafe_b64decode(cursor+'='*(-len(cursor)%4)))
                if token.get('revision')!=self.revision:raise ValueError('catalog changed')
                if token['snapshot'] not in self.snapshots:
                    self.search_products(**token['criteria'],group=group)
                snapshot=self.snapshots[token['snapshot']];offset=token['offset']
                if token['group']!=group:raise ValueError('group changed')
                if not isinstance(offset,int) or offset<0:raise ValueError('invalid offset')
            except (ValueError,KeyError,TypeError):raise ValueError('Cursor unavailable: repeat original search with unchanged criteria')
        else:
            for n in (min_nominal_kw,max_nominal_kw,max_price_rub):
                if n is not None and (isinstance(n,bool) or not math.isfinite(n) or n<0):raise ValueError('invalid numeric filter')
            # MCP validates numeric inputs as floats while /search-full can receive
            # JSON integers. Equal numeric criteria must identify the same snapshot.
            min_nominal_kw=float(min_nominal_kw) if min_nominal_kw is not None else None
            max_nominal_kw=float(max_nominal_kw) if max_nominal_kw is not None else None
            max_price_rub=float(max_price_rub) if max_price_rub is not None else None
            if min_nominal_kw is not None and max_nominal_kw is not None and min_nominal_kw>max_nominal_kw:raise ValueError('invalid range')
            structured=any(x is not None for x in (min_nominal_kw,max_nominal_kw,max_price_rub))
            if cutting_diameters_mm is not None or max_cutting_diameter_mm is not None:
                if structured or query.strip() or norm(category) not in ('алмазные диски','абразивные диски','режущие диски'):
                    raise ValueError('Diameter search requires a disc category and no other search filters')
                if cutting_diameters_mm is not None:
                    if max_cutting_diameter_mm is not None or not isinstance(cutting_diameters_mm,list) or not 1<=len(cutting_diameters_mm)<=10 or any(isinstance(x,bool) or not isinstance(x,(int,float)) or not math.isfinite(x) or x<=0 for x in cutting_diameters_mm):raise ValueError('Invalid disc diameters')
                    cutting_diameters_mm=sorted(set(float(x) for x in cutting_diameters_mm))
                if max_cutting_diameter_mm is not None:
                    if isinstance(max_cutting_diameter_mm,bool) or not isinstance(max_cutting_diameter_mm,(int,float)) or not math.isfinite(max_cutting_diameter_mm) or max_cutting_diameter_mm<=0:raise ValueError('Invalid maximum disc diameter')
                    max_cutting_diameter_mm=float(max_cutting_diameter_mm)
            allrows=self.db.execute('SELECT '+SUMMARY_COLUMNS+' FROM products ORDER BY price IS NULL,price,title,id').fetchall()
            categories=sorted({r['category'] for r in allrows});category_lookup={norm(x):x for x in categories}
            if category:
                if norm(category) in ('генератор','генераторы','generators'):allrows=[r for r in allrows if norm(r['category']) in ('бензиновые генераторы','дизельные генераторы','газовые генераторы','инверторные генераторы','сварочные генераторы')]
                elif norm(category)=='режущие диски':allrows=[r for r in allrows if norm(r['category']) in ('алмазные диски','абразивные диски')]
                elif norm(category) in category_lookup:
                    category=category_lookup[norm(category)];allrows=[r for r in allrows if r['category']==category]
                else:return {'status':'category_not_found','categories':categories}
            if (min_nominal_kw is not None or max_nominal_kw is not None) and not category:return {'status':'category_required','message':'Для номинальной электрической мощности укажите категорию генераторов','categories':categories}
            groups={'matches':[],'needs_check':[],'unknown':[]};excluded=0;source_scan_complete=False;candidate_basis='semantic_top_results'
            if cutting_diameters_mm is not None or max_cutting_diameter_mm is not None:
                for r in allrows:
                    item=self.compact(r);facts=item.get('cutting_evidence',{}).get('diameter',[])
                    values=[]
                    for fact in facts:
                        value=fact['raw'].strip().replace(',','.')
                        if re.fullmatch(r'\d+(?:\.\d+)?(?:\s*мм)?',value,re.I):values.append(float(re.sub(r'\s*мм$','',value,flags=re.I)))
                    if len(set(values))!=1 or len(values)!=len(facts):
                        item['conditions'].append('диаметр не подтверждён однозначно');groups['unknown'].append(item)
                    elif (cutting_diameters_mm is not None and values[0] in cutting_diameters_mm) or (max_cutting_diameter_mm is not None and values[0]<=max_cutting_diameter_mm):groups['matches'].append(item)
                    else:excluded+=1
                complete=True;universe=len(allrows);source_scan_complete=True;candidate_basis='structured_disc_diameter'
            elif structured:
                # Never use a vector top-k subset as the candidate universe for numeric filters.
                for r in allrows:
                    status,notes=self.classify(r,min_nominal_kw,max_nominal_kw,max_price_rub)
                    if status=='excluded':excluded+=1
                    else:groups[status].append(self.compact(r,notes))
                complete=True;universe=len(allrows)
            elif category and re.search(r'дистанц|пульт|радиоуправ|инфракрас|bluetooth|remote',norm(query)):
                # Feature questions scan every card in the chosen category for explicit source evidence.
                for r in allrows:
                    ev=self.source_evidence(r,query)
                    if ev and (ev['attributes'] or ev['description_excerpts']):groups['matches'].append(self.compact(r,evidence=ev))
                complete=False;universe=len(allrows);source_scan_complete=True;candidate_basis='full_category_keyword_scan'
            else:
                exact=self.exact(query) if query.strip() else []
                matches=exact
                if category:matches=[r for r in matches if r['id'] in {x['id'] for x in allrows}]
                if not matches and query.strip():
                    allowed={r['id'] for r in allrows};seen=set()
                    stop={'для','как','что','нужен','нужно','найди','найдите','какой','какая','мне','при','или','подберите','товар','оборудование'}
                    terms=[w for w in re.findall(r'\w+',norm(query)) if len(w)>2 and w not in stop]
                    terms=[w[:5] if re.fullmatch(r'[а-я]+',w) and len(w)>5 else w for w in terms]
                    expression=' OR '.join('"'+w+'"*' for w in dict.fromkeys(terms))
                    ids=[h['id'] for h in self.db.execute('SELECT id FROM docs WHERE docs MATCH ? ORDER BY bm25(docs,0,20,1) LIMIT 100',(expression,))] if expression else []
                    for ident in ids:
                        if ident in allowed and ident not in seen:
                            seen.add(ident);matches.append(self.row(ident))
                            if len(matches)>=30:break
                elif not query.strip():matches=allrows
                groups['matches']=[self.compact(r,evidence=self.source_evidence(r,query)) for r in matches];complete=bool(exact) or not query.strip();universe=len(allrows)
            criteria={'query':query,'category':category,'min_nominal_kw':min_nominal_kw,'max_nominal_kw':max_nominal_kw,'max_price_rub':max_price_rub}
            if cutting_diameters_mm is not None:criteria['cutting_diameters_mm']=cutting_diameters_mm
            if max_cutting_diameter_mm is not None:criteria['max_cutting_diameter_mm']=max_cutting_diameter_mm
            sid=hashlib.sha256(json.dumps([self.revision,criteria],sort_keys=True,ensure_ascii=False).encode()).hexdigest()[:24]
            snapshot={'groups':groups,'criteria':criteria,'snapshot':sid,'complete':complete,'universe':universe,'excluded':excluded,'source_scan_complete':source_scan_complete,'candidate_basis':candidate_basis};self.snapshots[sid]=snapshot;offset=0
        if group not in snapshot['groups']:raise ValueError('invalid group')
        items=snapshot['groups'][group];next_offset=offset+(100 if 'cutting_diameters_mm' in snapshot['criteria'] or 'max_cutting_diameter_mm' in snapshot['criteria'] else 10)
        next_cursor=base64.urlsafe_b64encode(json.dumps({'snapshot':snapshot['snapshot'],'revision':self.revision,'criteria':snapshot['criteria'],'offset':next_offset,'group':group}).encode()).decode().rstrip('=') if next_offset<len(items) else None
        criteria=snapshot['criteria']
        applied={key:value for key,value in criteria.items() if key!='query' and value is not None}
        unsupported=[]
        if criteria['query'].strip():
            if any(criteria[key] is not None for key in ('min_nominal_kw','max_nominal_kw','max_price_rub')):
                unsupported.append('query')
            else:
                applied['query']=criteria['query']
                if not snapshot['complete']:unsupported.append('semantic_query_completeness')
        result={'status':'ok','criteria':criteria,'applied_filters':applied,'unsupported_filters':unsupported,'snapshot':snapshot['snapshot'],'group':group,'count':len(items),'counts':{k:len(v) for k,v in snapshot['groups'].items()},'candidates_checked':snapshot['universe'],'numeric_scan_complete':snapshot['complete'],'source_scan_complete':snapshot['source_scan_complete'],'candidate_basis':snapshot['candidate_basis'],'items':items[offset:next_offset],'next_cursor':next_cursor,'remaining':max(0,len(items)-next_offset),'price_current':False,'stock':'unknown','source_revision':self.revision,'retrieval_ms':round((time.perf_counter()-start_time)*1000,2)}
        result['has_more']=next_cursor is not None
        result['review_examples']=snapshot['groups']['needs_check'][:4] if group=='matches' and offset==0 else []
        self.log.append({'tool':'search_products','criteria':snapshot['criteria'],'count':len(items),'ms':result['retrieval_ms']});return result
