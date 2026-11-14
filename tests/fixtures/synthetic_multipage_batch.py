"""Synthetic 112-card Python-to-TypeScript pagination contract; no live catalog."""
import hashlib
import json
import sqlite3
import sys

sys.path.insert(0, 'catalog-service')
from get_products_batch import get_products_batch
from knowledge import Knowledge

revision = 'multipage-synthetic-revision'
ids = [format(i, '024x') for i in range(112)]
cards = []
db = sqlite3.connect(':memory:')
db.row_factory = sqlite3.Row
db.execute('CREATE TABLE products(id TEXT,sku TEXT,title TEXT,category TEXT,url TEXT,price REAL,powers TEXT,source TEXT,sha TEXT,raw TEXT)')
for index, ident in enumerate(ids):
    text = f'Товар: fixture {index}\n' + ('Длинный текст α 特殊 ☃; ' * 150) + f'\nконец {ident}'
    card = {'название': f'fixture {index}',
            'характеристики': {'Поле / особое 🛠': {'вложено': [index, None, {'α.β': 'значение'}]}, 'Длинное': text},
            'описание': f'Описание {ident}\n{text}', 'документы': [{'название': 'Документ', 'ссылка': f'https://example.test/{ident}'}],
            'enriched_knowledge': {'chunks': [{'chunk_index': 0, 'text': text, 'input_sha256': hashlib.sha256(text.encode()).hexdigest(),
                                               'необычные данные': [ident, {'数': index}]}]},
            'необычный ключ': {'$fixture': [ident, {'точка.ключ': 'без потерь'}]}}
    cards.append(card)
    db.execute('INSERT INTO products VALUES (?,?,?,?,?,?,?,?,?,?)', (ident, ident, card['название'], 'fixture', '', 1, '[]',
               f'synthetic-{index}.json', f'sha-{index}', json.dumps(card, ensure_ascii=False)))
kb = Knowledge.__new__(Knowledge)
kb.db, kb.revision = db, revision
first = get_products_batch(kb, ids, expected_revision=revision, mode='full')
second = get_products_batch(kb, ids, expected_revision=revision, mode='full', cursor=first['next_cursor'])
print(json.dumps({'revision': revision, 'ids': ids, 'cards': cards, 'pages': [first, second]}, ensure_ascii=False))
db.close()
