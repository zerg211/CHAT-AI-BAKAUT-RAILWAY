"""Synthetic recovered chunks for offline transport tests, not real catalog data."""
import hashlib
import json
import sqlite3
import sys

sys.path.insert(0, 'catalog-service')
from get_products_batch import get_products_batch
from knowledge import Knowledge

ident = 'e' * 24
texts = ['Товар: Synthetic fixture\n' + 'Начало α\n' + 'длинный текст; ' * 20000 + '\nКОНЕЦ',
         'Товар: Synthetic fixture\nВторой фрагмент: 特殊 значение']
chunks = [{'chunk_index': i, 'text': text, 'input_sha256': hashlib.sha256(text.encode()).hexdigest(),
           'нестандартное поле': {'α': ['β', i]}} for i, text in enumerate(texts)]
assert all(c['chunk_index'] == i and hashlib.sha256(c['text'].encode()).hexdigest() == c['input_sha256']
           and c['text'].split('\n', 1)[0] == 'Товар: Synthetic fixture' for i, c in enumerate(chunks))
card = {'название': 'Synthetic fixture', 'характеристики': {'Объём': '1'}, 'описание': 'Синтетический пример',
        'документы': [], 'enriched_knowledge': {'chunks': chunks, 'extra/ключ': {'данные': ['☃', 42]}},
        'необычный ключ': {'a.b': ['x', {'$fixture': 'kept'}]}}
db = sqlite3.connect(':memory:')
db.row_factory = sqlite3.Row
db.execute('CREATE TABLE products(id TEXT,sku TEXT,title TEXT,category TEXT,url TEXT,price REAL,powers TEXT,source TEXT,sha TEXT,raw TEXT)')
db.execute('INSERT INTO products VALUES (?,?,?,?,?,?,?,?,?,?)', (ident, ident, 'Synthetic fixture', 'fixture', '', 1, '[]', 'synthetic.json', 'synthetic-sha', json.dumps(card, ensure_ascii=False)))
kb = Knowledge.__new__(Knowledge)
kb.db, kb.revision = db, 'fixture-revision'
batch = get_products_batch(kb, [ident], expected_revision='fixture-revision', mode='full')
print(json.dumps({'batch': batch, 'original': card}, ensure_ascii=True))
db.close()
