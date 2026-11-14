"""Return a real Knowledge/get_products_batch response from the fixed fixture."""
import hashlib
import json
import sqlite3
import sys
from pathlib import Path

root = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(root / 'catalog-service'))
from get_products_batch import get_products_batch
from knowledge import Knowledge

fixture = json.loads((Path(__file__).with_name('dpu6555-local-originals.json')).read_text(encoding='utf-8'))
if '--synthetic-extra' in sys.argv:
    control = json.loads(json.dumps(fixture['items'][0], ensure_ascii=False))
    control['product_id'] = 'f' * 24
    control['source_file'] = 'synthetic-control-not-a-real-product.json'
    control['original']['дополнительное_поле_проверки'] = {'вложенная_карта': {'неизвестное': ['α', {'условие': 'без потерь'}]}}
    control['source_sha256'] = hashlib.sha256(json.dumps(control['original'], ensure_ascii=False).encode('utf-8')).hexdigest()
    fixture['items'].append(control)
knowledge = Knowledge.__new__(Knowledge)
knowledge.revision = fixture['revision']
knowledge.db = sqlite3.connect(':memory:')
knowledge.db.row_factory = sqlite3.Row
knowledge.db.execute('CREATE TABLE products (id TEXT,sku TEXT,title TEXT,category TEXT,url TEXT,price REAL,powers TEXT,source TEXT,sha TEXT,raw TEXT)')
for item in fixture['items']:
    original = item['original']
    knowledge.db.execute('INSERT INTO products VALUES (?,?,?,?,?,?,?,?,?,?)', (
        item['product_id'], original.get('артикул'), original.get('название'), original.get('категория'),
        original.get('ссылка_на_товар'), None, '[]', item['source_file'], item['source_sha256'],
        json.dumps(original, ensure_ascii=False)))
ids = [item['product_id'] for item in fixture['items']]
result = get_products_batch(knowledge, ids, expected_revision=fixture['revision'], mode='full')
print(json.dumps(result, ensure_ascii=False))
knowledge.db.close()
