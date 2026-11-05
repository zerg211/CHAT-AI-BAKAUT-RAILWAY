"""Preserve every source field for a sequential catalog-index pilot."""

import argparse
import hashlib
import json
import os
import sqlite3
import sys
from pathlib import Path


EXPECTED_CATALOG_SIZE = 4324
PILOT_SIZE = 100


def field_rows(value, pointer=''):
    if isinstance(value, dict):
        for key, child in value.items():
            escaped = str(key).replace('~', '~0').replace('/', '~1')
            yield from field_rows(child, pointer + '/' + escaped)
    elif isinstance(value, list):
        for index, child in enumerate(value):
            yield from field_rows(child, pointer + '/' + str(index))
    else:
        rendered = json.dumps(value, ensure_ascii=False, separators=(',', ':'))
        text = value if isinstance(value, str) else rendered
        yield pointer, rendered, text


def create_tables(target):
    target.executescript('''
        CREATE TABLE products (
            product_id TEXT PRIMARY KEY, ordinal INTEGER NOT NULL UNIQUE,
            source TEXT NOT NULL UNIQUE, source_sha256 TEXT NOT NULL,
            title TEXT NOT NULL, category TEXT NOT NULL, raw_json TEXT NOT NULL,
            field_count INTEGER NOT NULL
        );
        CREATE TABLE fields (
            product_id TEXT NOT NULL, pointer TEXT NOT NULL,
            value_json TEXT NOT NULL, search_text TEXT NOT NULL,
            PRIMARY KEY (product_id, pointer)
        );
        CREATE VIRTUAL TABLE fields_fts USING fts5(
            product_id UNINDEXED, pointer UNINDEXED, search_text
        );
        CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    ''')


def index_product(target, row, ordinal, catalog_dir):
    source = row['source']
    path = (catalog_dir / source).resolve()
    if not path.is_relative_to(catalog_dir) or not path.is_file():
        raise ValueError(f'Product {ordinal}: source file unavailable: {source}')
    original = path.read_bytes()
    actual_sha = hashlib.sha256(original).hexdigest()
    if actual_sha != row['sha']:
        raise ValueError(f'Product {ordinal}: source differs from catalog: {source}')
    raw_json = original.decode('utf-8-sig')
    card = json.loads(raw_json)
    if not isinstance(card, dict) or card != json.loads(row['raw']):
        raise ValueError(f'Product {ordinal}: source content differs from catalog: {source}')
    if (card.get('название') != row['title'] or
            card.get('категория') != row['category'] or
            str(card.get('артикул') or '') != str(row['sku'] or '') or
            card.get('ссылка_на_товар') != row['url']):
        raise ValueError(f'Product {ordinal}: source identity differs from catalog: {source}')
    fields = list(field_rows(card))
    if not fields or len({pointer for pointer, _, _ in fields}) != len(fields):
        raise ValueError(f'Product {ordinal}: incomplete or duplicate field paths: {source}')

    target.execute('BEGIN')
    try:
        target.execute('INSERT INTO products VALUES (?,?,?,?,?,?,?,?)',
                       (row['id'], ordinal, source, actual_sha, row['title'],
                        row['category'], raw_json, len(fields)))
        target.executemany('INSERT INTO fields VALUES (?,?,?,?)',
                           ((row['id'], pointer, value, text) for pointer, value, text in fields))
        target.executemany('INSERT INTO fields_fts VALUES (?,?,?)',
                           ((row['id'], pointer, text) for pointer, _, text in fields))
        saved = target.execute('SELECT pointer,value_json,search_text FROM fields '
                               'WHERE product_id=? ORDER BY pointer', (row['id'],)).fetchall()
        if saved != sorted(fields):
            raise ValueError(f'Product {ordinal}: field readback failed: {source}')
        fts_count = target.execute('SELECT count(*) FROM fields_fts WHERE product_id=?',
                                   (row['id'],)).fetchone()[0]
        if fts_count != len(fields):
            raise ValueError(f'Product {ordinal}: search coverage failed: {source}')
        target.commit()
    except Exception:
        target.rollback()
        raise
    return len(fields)


def build(source_db, catalog_dir, output):
    source_db = source_db.resolve()
    catalog_dir = catalog_dir.resolve()
    output = output.resolve()
    if output.exists() or output.with_suffix(output.suffix + '.building').exists():
        raise ValueError('Output or unfinished build already exists; choose a new output path')
    source = sqlite3.connect(f'file:{source_db.as_posix()}?mode=ro', uri=True)
    source.row_factory = sqlite3.Row
    count = source.execute('SELECT count(*) FROM products').fetchone()[0]
    if count != EXPECTED_CATALOG_SIZE:
        raise ValueError(f'Expected {EXPECTED_CATALOG_SIZE} catalog cards, got {count}')
    revision = source.execute('SELECT revision FROM metadata').fetchone()[0]
    rows = source.execute('SELECT id,source,sha,raw,title,category,sku,url '
                          'FROM products ORDER BY source LIMIT ?', (PILOT_SIZE,)).fetchall()
    if len(rows) != PILOT_SIZE or len({row['id'] for row in rows}) != PILOT_SIZE:
        raise ValueError('The first 100 catalog products are incomplete or duplicated')
    work = output.with_suffix(output.suffix + '.building')
    target = sqlite3.connect(work)
    try:
        create_tables(target)
        field_count = 0
        for ordinal, row in enumerate(rows, 1):
            field_count += index_product(target, row, ordinal, catalog_dir)
        target.executemany('INSERT INTO metadata VALUES (?,?)', (
            ('source_revision', revision), ('catalog_size', str(count)),
            ('pilot_size', str(PILOT_SIZE)), ('field_count', str(field_count)),
            ('first_source', rows[0]['source']), ('last_source', rows[-1]['source'])
        ))
        target.commit()
        if (target.execute('SELECT count(*) FROM products').fetchone()[0] != PILOT_SIZE or
                target.execute('SELECT count(*) FROM fields').fetchone()[0] != field_count or
                target.execute('SELECT count(*) FROM fields_fts').fetchone()[0] != field_count):
            raise ValueError('Final index coverage failed')
    finally:
        target.close()
        source.close()
    os.replace(work, output)
    return {'products': PILOT_SIZE, 'fields': field_count, 'first_source': rows[0]['source'],
            'last_source': rows[-1]['source'], 'source_revision': revision,
            'index': str(output), 'bytes': output.stat().st_size}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source-db', type=Path, required=True)
    parser.add_argument('--catalog-dir', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    sys.stdout.reconfigure(encoding='utf-8')
    print(json.dumps(build(args.source_db, args.catalog_dir, args.output), ensure_ascii=False))
