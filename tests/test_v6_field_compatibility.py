import hashlib
import json
import sqlite3
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'catalog-service'))
import knowledge
import reviewed_field_aliases

class V6FieldCompatibility(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(':memory:')
        self.addCleanup(self.db.close)
        self.db.row_factory = sqlite3.Row
        self.db.execute('CREATE TABLE products(id TEXT,sku TEXT,title TEXT,category TEXT,url TEXT,price REAL,powers TEXT,source TEXT,sha TEXT,raw TEXT)')
        self.ident = 'a' * 24
        self.value = '2.5 л/ч'
        self.raw = json.dumps({'характеристики': {'Расход топлива, л/ч': self.value}, 'описание': 'Полный оригинал'}, ensure_ascii=False)
        self.db.execute('INSERT INTO products VALUES (?,?,?,?,?,?,?,?,?,?)', (self.ident, 'model123', 'Generator', 'cat', '', 1, '[]', 'source', 'source-sha', self.raw))
        self.entry = {'target': 'Расход топлива, л/ч', 'raw_sha256': 'source-sha', 'value_sha256': hashlib.sha256(self.value.encode()).hexdigest()}
        self.mapping = {self.ident: {'Расход топлива': self.entry}}
        self.new = knowledge.Knowledge.__new__(knowledge.Knowledge)
        self.new.db, self.new.revision = self.db, 'rev'

    def test_reviewed_alias_and_exact_field_are_available(self):
        with patch.object(reviewed_field_aliases, '_MAP', self.mapping):
            for field in ('Расход топлива', 'Расход топлива, л/ч'):
                new = self.new.get_product(self.ident, [field])
                self.assertEqual(new['fields'][field], self.value)
                self.assertEqual(new['field_status'][field], 'found')
            raw = json.dumps({'характеристики': {'Расход топлива': 'direct', 'Расход топлива, л/ч': self.value}})
            self.db.execute('UPDATE products SET raw=? WHERE id=?', (raw, self.ident))
            self.assertEqual(self.new.get_product(self.ident, ['Расход топлива'])['fields']['Расход топлива'], 'direct')

    def test_changed_source_or_value_does_not_reuse_old_alias(self):
        with patch.object(reviewed_field_aliases, '_MAP', self.mapping):
            for field, changed in [('sha', 'other'), ('raw', json.dumps({'характеристики': {'Расход топлива, л/ч': 'new'}}))]:
                with self.subTest(field=field):
                    self.db.execute(f'UPDATE products SET {field}=? WHERE id=?', (changed, self.ident))
                    new = self.new.get_product(self.ident, ['Расход топлива'])
                    self.assertIsNone(new['fields']['Расход топлива'])
                    self.assertEqual(new['field_status']['Расход топлива'], 'unknown_field')
                    self.assertIn('full_product', new)
                    self.db.execute('UPDATE products SET sha=?,raw=? WHERE id=?', ('source-sha', self.raw, self.ident))

    def test_exact_lookup_id_sku_title_and_missing_are_preserved(self):
        for identifier, expected in ((self.ident, 'found'), ('model123', 'found'), ('Generator', 'found'), ('absent', 'not_found')):
            with self.subTest(identifier=identifier):
                self.assertEqual(self.new.get_product(identifier)['status'], expected)

    def test_reviewed_alias_table_matches_verified_v6_artifact(self):
        data = (ROOT / 'catalog-service/reviewed_field_aliases.json').read_bytes()
        self.assertEqual(hashlib.sha256(data).hexdigest(), 'd83a2ab40daa99ca69f5a766faa2a0fd2643f89cc12012d3745dea590d85bf44')
        entries = json.loads(data)
        self.assertEqual(len(entries), 85)
        self.assertEqual(sum(map(len, entries.values())), 245)


if __name__ == '__main__': unittest.main()
