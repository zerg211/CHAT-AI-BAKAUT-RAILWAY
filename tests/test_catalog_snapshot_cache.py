import json
import ast
import asyncio
import os
import sqlite3
import urllib.error
import threading
import sys
import tempfile
import importlib.util
import types
from contextlib import closing
import unittest
from unittest.mock import patch
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'catalog-service'))
from knowledge import _serialized_full_card, full_card, Knowledge, normalized_powers
import semantic_selector
import knowledge
from get_products_batch import get_products_batch


class CatalogSnapshotCacheTest(unittest.TestCase):
    def setUp(self):
        _serialized_full_card.cache_clear()
        self.row = {'id': 'a' * 24, 'title': 'Generator', 'sku': 'one', 'url': 'https://example.test',
                    'category': 'Generators', 'source': 'one.json', 'sha': 'sha', 'price': 100,
                    'raw': json.dumps({'характеристики': {'Мощность': '8 кВт'},
                                       'описание': 'complete', 'документы': ['manual']}, ensure_ascii=False)}

    def test_shared_snapshot_is_singleflight_and_callers_cannot_mutate_it(self):
        with ThreadPoolExecutor(max_workers=16) as executor:
            cards = list(executor.map(lambda _: full_card('rev1', self.row), range(32)))
        self.assertEqual(_serialized_full_card.cache_info().misses, 1)
        cards[0]['original_card']['описание'] = 'changed in one session'
        cards[0]['attributes']['Мощность'] = 'wrong'
        self.assertEqual(full_card('rev1', self.row)['original_card']['описание'], 'complete')
        self.assertEqual(cards[1]['attributes']['Мощность'], '8 кВт')

    def test_revision_and_actual_row_changes_invalidate(self):
        self.assertEqual(full_card('rev1', self.row)['price_rub'], 100)
        self.assertEqual(full_card('rev2', {**self.row, 'price': 200})['price_rub'], 200)
        changed = {**self.row, 'raw': json.dumps({'описание': 'updated'}, ensure_ascii=False)}
        self.assertEqual(full_card('rev1', changed)['description'], 'updated')
        self.assertEqual(_serialized_full_card.cache_info().misses, 3)

    def test_deleted_and_changed_rows_are_read_from_current_catalog_not_cache(self):
        db = sqlite3.connect(':memory:')
        db.row_factory = sqlite3.Row
        db.execute('CREATE TABLE products (id TEXT, title TEXT, sku TEXT, url TEXT, category TEXT, source TEXT, sha TEXT, price REAL, raw TEXT, powers TEXT)')
        row = {**self.row, 'powers': '[]'}
        db.execute('INSERT INTO products VALUES (:id,:title,:sku,:url,:category,:source,:sha,:price,:raw,:powers)', row)
        catalog = Knowledge.__new__(Knowledge)
        catalog.db, catalog.revision = db, 'rev1'
        self.addCleanup(db.close)
        self.assertEqual(catalog.get_product(row['id'])['attributes']['Мощность'], '8 кВт')
        updated = json.dumps({'характеристики': {'Мощность': '9 кВт'}}, ensure_ascii=False)
        db.execute('UPDATE products SET raw=? WHERE id=?', (updated, row['id']))
        self.assertEqual(catalog.get_product(row['id'])['attributes']['Мощность'], '9 кВт')
        db.execute('DELETE FROM products WHERE id=?', (row['id'],))
        self.assertEqual(catalog.get_product(row['id'])['status'], 'not_found')
        with self.assertRaisesRegex(ValueError, 'not found'):
            get_products_batch(catalog, [row['id']], expected_revision='rev1', mode='full')

    def test_build_failure_is_not_cached_and_next_request_retries(self):
        original = knowledge._build_full_card
        with patch.object(knowledge, '_build_full_card', side_effect=[ValueError('bad card'), original(*('rev1', self.row['id'], self.row['title'], self.row['sku'], self.row['url'], self.row['category'], self.row['source'], self.row['sha'], self.row['price'], self.row['raw'], 1))]):
            with self.assertRaisesRegex(ValueError, 'bad card'):
                full_card('rev1', self.row)
            self.assertEqual(_serialized_full_card.cache_info().currsize, 0)
            self.assertEqual(full_card('rev1', self.row)['attributes']['Мощность'], '8 кВт')

    def test_same_key_concurrent_miss_builds_once(self):
        entered, release = threading.Event(), threading.Event()
        original = knowledge._build_full_card
        def build(*args):
            entered.set()
            if not release.wait(3): raise TimeoutError('build was not released')
            return original(*args)
        with patch.object(knowledge, '_build_full_card', side_effect=build) as builder, ThreadPoolExecutor(max_workers=2) as executor:
            first = executor.submit(full_card, 'rev1', self.row)
            self.assertTrue(entered.wait(3))
            second = executor.submit(full_card, 'rev1', self.row)
            release.set()
            self.assertEqual(first.result()['product_id'], second.result()['product_id'])
            self.assertEqual(builder.call_count, 1)

    def test_index_inspection_uses_current_catalog_count_and_rejects_changed_catalog(self):
        spec = importlib.util.spec_from_file_location('offline_embedding_index', Path(__file__).resolve().parents[1] / 'catalog-service/embedding_index.py')
        module = importlib.util.module_from_spec(spec)
        with patch.dict(sys.modules, {'numpy': types.ModuleType('numpy'), 'tiktoken': types.ModuleType('tiktoken')}):
            spec.loader.exec_module(module)
        with tempfile.TemporaryDirectory() as folder:
            source, index = Path(folder) / 'source.db', Path(folder) / 'index.db'
            with closing(sqlite3.connect(source)) as db:
                with db: db.executescript("CREATE TABLE metadata(revision TEXT, count INTEGER); INSERT INTO metadata VALUES ('rev', 1); CREATE TABLE products(id TEXT, source TEXT, sha TEXT, raw TEXT); INSERT INTO products VALUES ('id', 'one.json', 'sha', '{}');")
            db, revision, digest, _ = module.source_rows(source)
            db.close()
            with closing(sqlite3.connect(index)) as db, db:
                db.executescript('CREATE TABLE metadata(key TEXT, value TEXT); CREATE TABLE products(product_id TEXT, source_sha TEXT, chunk_count INTEGER); CREATE TABLE chunks(product_id TEXT, vector BLOB);')
                db.executemany('INSERT INTO metadata VALUES (?,?)', [('source_revision', revision), ('source_digest', digest), ('dimensions', '1'), ('model', 'test')])
                db.execute("INSERT INTO products VALUES ('id', 'sha', 1)")
                db.execute("INSERT INTO chunks VALUES ('id', X'0000803F')")
            self.assertEqual(module.inspect(source, index)['products'], 1)
            with closing(sqlite3.connect(source)) as db, db:
                db.execute("UPDATE products SET sha='changed'")
            with self.assertRaisesRegex(ValueError, 'does not match'):
                module.inspect(source, index)

    def test_large_cards_bypass_cache_without_losing_content(self):
        text = 'тест' * 400_000
        row = {**self.row, 'raw': json.dumps({'описание': text}, ensure_ascii=False)}
        self.assertEqual(full_card('rev1', row)['description'], text)
        self.assertEqual(_serialized_full_card.cache_info().currsize, 0)

    def test_many_large_cards_are_evicted_within_accounted_byte_budget(self):
        for index in range(20):
            row = {**self.row, 'id': str(index), 'raw': json.dumps({'описание': 'x' * 300_000})}
            self.assertEqual(len(full_card('rev1', row)['description']), 300_000)
            info = _serialized_full_card.cache_info()
            self.assertLessEqual(info.bytes, info.max_bytes)
        self.assertLess(_serialized_full_card.cache_info().currsize, 20)

    def test_distinct_cache_keys_can_build_concurrently(self):
        def stripe(row):
            key = ('rev', row['id'], row['title'], row['sku'], row['url'], row['category'], row['source'],
                   row['sha'], row['price'], row['raw'], 1)
            return hash(key) % len(knowledge._card_flights)
        first = self.row
        second = next({**self.row, 'id': str(i)} for i in range(1000)
                      if stripe({**self.row, 'id': str(i)}) != stripe(first))
        barrier = threading.Barrier(2, timeout=3)
        original = knowledge._build_full_card
        def build(*args):
            barrier.wait()
            return original(*args)
        with patch.object(knowledge, '_build_full_card', build), ThreadPoolExecutor(max_workers=2) as executor:
            results = list(executor.map(lambda row: full_card('rev', row), [first, second]))
        self.assertEqual({card['product_id'] for card in results}, {first['id'], second['id']})

    def test_explicit_power_pairs_are_parsed_without_guessing_ambiguous_text(self):
        def item(raw, field='Номинальная мощность'):
            return {'raw': raw, 'field': field, 'kw': None, 'mode': 'general'}
        cases = [
            (item('16 кВт / 20 кВА; резерв 17,6 кВт / 22 кВА'), 16),
            (item('200 кВт / 250 кВА (PRP)'), 200),
            (item('64 (80 кВА)', 'Номинальная мощность, кВт'), 64),
            (item('51–52 кВт / 64–65 кВА'), None),
            (item('8 по таблице артикула 160014, архивные 7,8 кВт'), None),
            (item('8 кВт / 10 кВА; иное значение 7 кВт'), None),
        ]
        for fact, expected in cases:
            self.assertEqual(normalized_powers(json.dumps([fact], ensure_ascii=False))[0]['kw'], expected)
        row = {'price': 100, 'powers': json.dumps([cases[0][0]], ensure_ascii=False)}
        self.assertEqual(Knowledge.classify(None, row, 16, 16, None)[0], 'matches')
        self.assertEqual(Knowledge.classify(None, row, 5, 10, None)[0], 'excluded')
        row['powers'] = json.dumps([cases[4][0]], ensure_ascii=False)
        self.assertEqual(Knowledge.classify(None, row, 5, 10, None)[0], 'unknown')

    def test_numeric_uncertainty_reaches_classifier_without_being_lost(self):
        groups = {name: [{'product_id': str(index), 'name': name}]
                  for index, name in enumerate(('matches', 'needs_check', 'unknown'))}
        class Catalog:
            revision = 'rev'
            snapshots = {'snapshot': {'groups': groups, 'criteria': {'category': 'Generators',
                'min_nominal_kw': 5, 'max_nominal_kw': 10, 'max_price_rub': None},
                'universe': 3, 'excluded': 0, 'complete': True}}
            def search_products(self, **kwargs):
                return {'status': 'ok', 'snapshot': 'snapshot'}
            def row(self, ident):
                return {'title': 'Card ' + ident, 'raw': json.dumps({'характеристики': {'Мощность': ident}})}
        seen = []
        def classify(products, requirement):
            seen.extend(p['id'] for p in products)
            return ({p['id']: {'label': 'yes', 'evidence': []} for p in products}, 0, 0, 0)
        with patch.object(semantic_selector, '_classify', classify):
            result = semantic_selector.select_products(Catalog(), 'generator', 'Generators', 5, 10)
        self.assertEqual(seen, ['0', '1', '2'])
        self.assertEqual((result['selected_count'], result['uncertain_count'], result['rejected_count']), (1, 2, 0))
        self.assertEqual(result['candidate_ids'], ['0', '1', '2'])

    def test_semantic_tool_discovers_all_candidates_without_provider(self):
        from candidate_discovery import discover_candidates
        tree = ast.parse((Path(__file__).resolve().parents[1] / 'catalog-service/server.py').read_text(encoding='utf-8'))
        tool = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == 'semantic_select_products')
        tool.decorator_list = []
        class DB:
            def close(self): pass
        class Catalog:
            revision = 'rev'
            db = DB()
            def __init__(self, _):
                self.snapshots = {'s': {'snapshot': 's', 'complete': True, 'criteria': {'query': '', 'category': 'category'},
                    'excluded': 0, 'universe': 3, 'groups': {'matches': [{'product_id': 'a'*24}, {'product_id': 'b'*24},
                    {'product_id': 'c'*24}], 'needs_check': [], 'unknown': []}}}
            def search_products(self, **kwargs): return {'status': 'ok', 'snapshot': 's'}
        namespace = {'Knowledge': Catalog, 'discover_candidates': discover_candidates, 'compact_result': lambda value: value,
                     'CallToolResult': object}
        exec(compile(ast.Module(body=[tool], type_ignores=[]), 'server.py', 'exec'), namespace)
        with patch.object(semantic_selector.urllib.request, 'urlopen', side_effect=AssertionError('paid provider called')):
            result = namespace['semantic_select_products']('any request', 'category', 5, 10, 100)
        self.assertEqual(result['candidate_ids'], ['a'*24, 'b'*24, 'c'*24])
        self.assertTrue(result['complete'])
        self.assertFalse(result['suitability_decided'])

    def test_legacy_semantic_paid_entrypoints_are_disabled(self):
        tree = ast.parse((Path(__file__).resolve().parents[1] / 'catalog-service/server.py').read_text(encoding='utf-8'))
        nodes = [node for node in tree.body if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
                 and node.name in ('semantic_rank_products', 'semantic_select_buyer', 'web_search_facts')]
        for node in nodes: node.decorator_list = []
        namespace = {'CallToolResult': object, 'compact_result': lambda value: value,
                     'JSONResponse': lambda value, status_code: (value, status_code)}
        exec(compile(ast.Module(body=nodes, type_ignores=[]), 'server.py', 'exec'), namespace)
        with patch.object(semantic_selector.urllib.request, 'urlopen', side_effect=AssertionError('paid provider called')):
            self.assertEqual(namespace['semantic_rank_products']('request')['status'], 'unavailable')
            self.assertEqual(namespace['web_search_facts']('request'), {'status': 'unavailable', 'reason': 'trusted_budget_context_unavailable'})
            self.assertEqual(asyncio.run(namespace['semantic_select_buyer'](None))[1], 410)
        calls = {node.func.id for node in ast.walk(tree) if isinstance(node, ast.Call) and isinstance(node.func, ast.Name)}
        self.assertFalse({'select_products', 'embed_query', 'select_requirement', 'rank_requirement'} & calls)
        dockerfile = (Path(__file__).resolve().parents[1] / 'catalog-service/Dockerfile').read_text(encoding='utf-8')
        self.assertNotIn('semantic_selector.py', dockerfile)

    def test_unknown_model_post_is_not_sent_twice(self):
        group = [({'id': 'one'}, {'name': 'Card', 'facts': ['fact']})]
        with patch.dict(os.environ, {'OPENAI_API_KEY': 'test'}), \
             patch.object(semantic_selector.urllib.request, 'urlopen', side_effect=urllib.error.URLError('unknown')) as send:
            with self.assertRaises(urllib.error.URLError):
                semantic_selector._classify_group(group, 'requirement')
        self.assertEqual(send.call_count, 1)

    def test_original_documents_and_extra_fields_reach_classification(self):
        raw = json.dumps({'описание': 'Описание', 'документы': [{'text': 'Ширина основания 550 мм',
            'url': 'https://example.test/manual'}], 'custom_fact': 'Работа в траншее'}, ensure_ascii=False)
        facts = semantic_selector._facts(raw, 'Test')
        full = next(value for field, value in facts if field == 'Полная исходная карточка')
        self.assertEqual(json.loads(full), json.loads(raw))

    def test_category_candidates_do_not_depend_on_words_used_for_a_feature(self):
        catalog = Knowledge.__new__(Knowledge)
        catalog.revision = 'rev'
        catalog.snapshots = {}
        catalog.log = []
        catalog.db = sqlite3.connect(':memory:')
        catalog.db.row_factory = sqlite3.Row
        catalog.db.execute('CREATE TABLE products (id TEXT,sku TEXT,title TEXT,category TEXT,url TEXT,price REAL,powers TEXT,source TEXT,sha TEXT,raw TEXT)')
        for index in range(12):
            catalog.db.execute('INSERT INTO products VALUES (?,?,?,?,?,?,?,?,?,?)',
                (str(index).zfill(24), str(index), 'Machine ' + str(index), 'Машины', '', 100, '[]', '', '', '{}'))
        try:
            all_ids = []
            for query in ('управляется с пульта?', 'можно управлять, не подходя к машине?'):
                page = catalog.search_products(query=query, category='Машины')
                ids = [item['product_id'] for item in page['items']]
                self.assertEqual(page['unsupported_filters'], ['query'])
                while page['has_more']:
                    page = catalog.search_products(cursor=page['next_cursor'])
                    ids.extend(item['product_id'] for item in page['items'])
                all_ids.append(ids)
            self.assertEqual(len(all_ids[0]), 12)
            self.assertEqual(all_ids[0], all_ids[1])
        finally:
            catalog.db.close()

    def test_full_batch_can_continue_past_old_catalog_size(self):
        class Catalog:
            revision = 'rev'
            def get_product(self, ident, fields):
                return {'status': 'found', 'product_id': ident, 'source_revision': self.revision}
        ids = [format(i, '024x') for i in range(4325)]
        cursor = None
        returned = []
        while True:
            page = get_products_batch(Catalog(), ids, expected_revision='rev', mode='full', cursor=cursor)
            returned.extend(page['returned_ids'])
            if page['complete']: break
            cursor = page['next_cursor']
        self.assertEqual(returned, ids)


if __name__ == '__main__':
    unittest.main()
