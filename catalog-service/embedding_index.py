"""Build and query a complete, revision-bound embedding index of the catalog.

The source of truth remains knowledge.sqlite. This file never silently drops a
card or truncates its characteristics. The work database survives interruptions
on the Railway volume; the published database is replaced only after all source
cards and chunks have been checked.
"""
import argparse
import hashlib
import json
import os
import sqlite3
import struct
import time
import urllib.error
import urllib.request
from pathlib import Path

import numpy as np
import tiktoken

MODEL = 'text-embedding-3-large'
DIMENSIONS = 3072
MAX_CHUNK_TOKENS = 7800  # Leaves space under the API's 8192-token input limit.
OVERLAP_TOKENS = 128
EXPECTED_CARDS = 4324


def source_rows(source_db):
    connection = sqlite3.connect('file:' + Path(source_db).resolve().as_posix() + '?mode=ro', uri=True)
    connection.row_factory = sqlite3.Row
    revision = connection.execute('SELECT revision FROM metadata').fetchone()[0]
    rows = connection.execute('SELECT id,source,sha,raw FROM products ORDER BY source').fetchall()
    if len(rows) != EXPECTED_CARDS or len({row['id'] for row in rows}) != len(rows):
        raise ValueError('The catalog must contain exactly 4324 distinct cards')
    digest = hashlib.sha256(''.join(row['source'] + '\t' + row['sha'] + '\n' for row in rows).encode()).hexdigest()
    return connection, revision, digest, rows


def card_text(raw):
    card = json.loads(raw)
    if not isinstance(card, dict):
        raise ValueError('Product card is not an object')
    title = str(card.get('название') or '').strip()
    if not title:
        raise ValueError('Product card has no title')
    header = '\n'.join(part for part in (
        'Товар: ' + title,
        'Категория: ' + str(card['категория']) if card.get('категория') else '',
        'Бренд: ' + str(card['бренд']) if card.get('бренд') else '',
    ) if part)
    lines = []
    if card.get('описание'):
        lines.append('Описание: ' + str(card['описание']))
    attributes = card.get('характеристики') or {}
    if not isinstance(attributes, dict):
        raise ValueError('Product characteristics are not an object')
    for key, value in attributes.items():
        rendered = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False, sort_keys=True)
        lines.append(str(key) + ': ' + rendered)
    for document in card.get('документы') or []:
        if isinstance(document, dict):
            name = document.get('название') or document.get('наименование')
            if name:
                lines.append('Документ: ' + str(name))
    return header, '\n'.join(lines)


def card_chunks(header, body, encoder):
    prefix = encoder.encode(header + '\n')
    body_tokens = encoder.encode(body)
    capacity = MAX_CHUNK_TOKENS - len(prefix)
    if capacity < 1024:
        raise ValueError('Product identity is too long for a safe embedding chunk')
    if len(body_tokens) <= capacity:
        return [header + '\n' + body]
    chunks = []
    offset = 0
    while offset < len(body_tokens):
        end = min(len(body_tokens), offset + capacity)
        chunks.append(header + '\n' + encoder.decode(body_tokens[offset:end]))
        if end == len(body_tokens):
            break
        offset = end - OVERLAP_TOKENS
    return chunks


def init_work(path, revision, digest, model, dimensions):
    db = sqlite3.connect(path)
    db.execute('PRAGMA journal_mode=WAL')
    db.executescript('''
        CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS products(
            product_id TEXT PRIMARY KEY,source TEXT NOT NULL,source_sha TEXT NOT NULL,
            content_sha TEXT NOT NULL,chunk_count INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS chunks(
            product_id TEXT NOT NULL,chunk_index INTEGER NOT NULL,input_sha TEXT NOT NULL,
            vector BLOB NOT NULL,PRIMARY KEY(product_id,chunk_index));
    ''')
    details = dict(db.execute('SELECT key,value FROM metadata'))
    expected = {'source_revision': revision, 'source_digest': digest,
                'model': model, 'dimensions': str(dimensions)}
    if details and any(details.get(key) != value for key, value in expected.items()):
        db.close()
        raise ValueError('Work index belongs to a different catalog or embedding model')
    db.executemany('INSERT OR REPLACE INTO metadata(key,value) VALUES (?,?)', expected.items())
    db.commit()
    return db


def embed_batch(texts, model, dimensions, key):
    payload = json.dumps({'model': model, 'dimensions': dimensions, 'input': texts}, ensure_ascii=False).encode()
    request = urllib.request.Request('https://api.openai.com/v1/embeddings', data=payload,
        headers={'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json'}, method='POST')
    for attempt in range(8):
        try:
            with urllib.request.urlopen(request, timeout=120) as response:
                result = json.load(response)
            break
        except urllib.error.HTTPError as error:
            if error.code not in (408, 409, 429, 500, 502, 503, 504) or attempt == 7:
                raise RuntimeError(f'Embeddings API returned HTTP {error.code}') from None
            time.sleep(min(60, 2 ** attempt))
        except (TimeoutError, urllib.error.URLError):
            if attempt == 7:
                raise
            time.sleep(min(60, 2 ** attempt))
    data = result.get('data') or []
    by_index = {item['index']: item['embedding'] for item in data}
    if result.get('model') != model or set(by_index) != set(range(len(texts))):
        raise ValueError('Embedding response does not match the requested batch')
    vectors = []
    for index in range(len(texts)):
        vector = by_index[index]
        if len(vector) != dimensions or not np.isfinite(vector).all():
            raise ValueError('Invalid embedding dimensions or values')
        vectors.append(struct.pack('<' + 'f' * dimensions, *vector))
    return vectors, int((result.get('usage') or {}).get('total_tokens') or 0)


def embed_query(text, model=MODEL, dimensions=DIMENSIONS):
    if not isinstance(text, str) or not text.strip():
        raise ValueError('Search query must be nonempty')
    key = os.environ.get('OPENAI_API_KEY')
    if not key:
        raise ValueError('OPENAI_API_KEY is not configured')
    tokens = tiktoken.get_encoding('cl100k_base').encode(text)
    if len(tokens) > 8192:
        raise ValueError('Search query exceeds the embedding input limit')
    vectors, usage = embed_batch([text], model, dimensions, key)
    return struct.unpack('<' + 'f' * dimensions, vectors[0]), usage


def inspect(source_db, index_path):
    source, revision, digest, rows = source_rows(source_db)
    source.close()
    index = sqlite3.connect('file:' + Path(index_path).resolve().as_posix() + '?mode=ro', uri=True)
    try:
        details = dict(index.execute('SELECT key,value FROM metadata'))
        if details.get('source_revision') != revision or details.get('source_digest') != digest:
            raise ValueError('Embedding index does not match the current catalog')
        products = index.execute('SELECT COUNT(*) FROM products').fetchone()[0]
        chunks = index.execute('SELECT COUNT(*) FROM chunks').fetchone()[0]
        wrong = index.execute('''SELECT COUNT(*) FROM products p WHERE p.chunk_count < 1 OR
            p.chunk_count != (SELECT COUNT(*) FROM chunks c WHERE c.product_id=p.product_id)''').fetchone()[0]
        source_ids = {row['id']: row['sha'] for row in rows}
        indexed_ids = {pid: sha for pid, sha in index.execute('SELECT product_id,source_sha FROM products')}
        if products != EXPECTED_CARDS or source_ids != indexed_ids or wrong or chunks < products:
            raise ValueError('Embedding index does not cover every source card')
        dimensions = int(details['dimensions'])
        malformed = index.execute('SELECT COUNT(*) FROM chunks WHERE length(vector) != ?',
                                  (dimensions * 4,)).fetchone()[0]
        if malformed:
            raise ValueError('Embedding index contains malformed vectors')
        return {'status': 'ok', 'products': products, 'chunks': chunks,
                'model': details['model'], 'dimensions': dimensions,
                'source_revision': revision, 'total_input_tokens': int(details.get('total_input_tokens', '0'))}
    finally:
        index.close()


def plan(source_db):
    source, revision, digest, rows = source_rows(source_db)
    encoder = tiktoken.get_encoding('cl100k_base')
    chunks = 0
    longest = 0
    try:
        for row in rows:
            header, body = card_text(row['raw'])
            parts = card_chunks(header, body, encoder)
            chunks += len(parts)
            longest = max(longest, *(len(encoder.encode(part)) for part in parts))
        return {'products': len(rows), 'chunks': chunks, 'max_chunk_tokens': longest,
                'source_revision': revision, 'source_digest': digest}
    finally:
        source.close()


def build(source_db, output, model=MODEL, dimensions=DIMENSIONS, batch_size=24):
    if batch_size < 1 or batch_size > 32:
        raise ValueError('Batch size must be 1..32')
    key = os.environ.get('OPENAI_API_KEY')
    if not key:
        raise ValueError('OPENAI_API_KEY is not configured')
    source, revision, digest, rows = source_rows(source_db)
    target = Path(output)
    target.parent.mkdir(parents=True, exist_ok=True)
    work = Path(str(target) + '.work')
    encoder = tiktoken.get_encoding('cl100k_base')
    db = init_work(work, revision, digest, model, dimensions)
    pending = []
    total_tokens = int(dict(db.execute('SELECT key,value FROM metadata')).get('total_input_tokens', '0'))
    reused = 0

    # A previous complete index may supply vectors for unchanged cards after a
    # catalog revision. The source SHA and text hash must both match.
    previous = None
    if target.exists():
        try:
            previous = sqlite3.connect('file:' + target.resolve().as_posix() + '?mode=ro', uri=True)
            prior = dict(previous.execute('SELECT key,value FROM metadata'))
            if prior.get('model') != model or prior.get('dimensions') != str(dimensions):
                previous.close(); previous = None
        except (sqlite3.Error, ValueError):
            if previous is not None:
                previous.close()
            previous = None

    def publish_batch():
        nonlocal total_tokens
        if not pending:
            return
        for start in range(0, len(pending), batch_size):
            group = pending[start:start + batch_size]
            vectors, usage = embed_batch([entry[2] for entry in group], model, dimensions, key)
            with db:
                db.executemany('INSERT OR REPLACE INTO chunks(product_id,chunk_index,input_sha,vector) VALUES (?,?,?,?)',
                    ((entry[0], entry[1], entry[3], vector) for entry, vector in zip(group, vectors)))
                total_tokens += usage
                db.execute('INSERT OR REPLACE INTO metadata(key,value) VALUES (?,?)',
                           ('total_input_tokens', str(total_tokens)))
            print(json.dumps({'embedded_chunks': len(group), 'input_tokens_total': total_tokens}), flush=True)
        pending.clear()

    try:
        for row in rows:
            header, body = card_text(row['raw'])
            content_sha = hashlib.sha256((header + '\n' + body).encode()).hexdigest()
            chunks = card_chunks(header, body, encoder)
            hashes = [hashlib.sha256(text.encode()).hexdigest() for text in chunks]
            current = db.execute('SELECT source_sha,content_sha,chunk_count FROM products WHERE product_id=?',
                                 (row['id'],)).fetchone()
            if current is not None and current == (row['sha'], content_sha, len(chunks)):
                saved = db.execute('SELECT chunk_index,input_sha,length(vector) FROM chunks WHERE product_id=? ORDER BY chunk_index',
                                   (row['id'],)).fetchall()
                if len(saved) == len(chunks) and all(index == i and input_sha == hashes[i] and size == dimensions * 4
                                                    for i, (index, input_sha, size) in enumerate(saved)):
                    continue
                # A batch may have failed after the product row was written. Reuse
                # successful chunks and request only missing ones below.
            if previous is not None:
                old = previous.execute('SELECT source_sha,content_sha,chunk_count FROM products WHERE product_id=?',
                                       (row['id'],)).fetchone()
                if old == (row['sha'], content_sha, len(chunks)):
                    vectors = previous.execute('SELECT chunk_index,input_sha,vector FROM chunks WHERE product_id=? ORDER BY chunk_index',
                                               (row['id'],)).fetchall()
                    if len(vectors) == len(chunks) and all(index == i and input_sha == hashes[i] and len(vector) == 4 * dimensions
                                                      for i, (index, input_sha, vector) in enumerate(vectors)):
                        with db:
                            db.execute('INSERT OR REPLACE INTO products VALUES (?,?,?,?,?)',
                                       (row['id'], row['source'], row['sha'], content_sha, len(chunks)))
                            db.executemany('INSERT OR REPLACE INTO chunks VALUES (?,?,?,?)',
                                           ((row['id'], *item) for item in vectors))
                        reused += 1
                        continue
            if current != (row['sha'], content_sha, len(chunks)):
                with db:
                    db.execute('DELETE FROM chunks WHERE product_id=?', (row['id'],))
            with db:
                db.execute('INSERT OR REPLACE INTO products VALUES (?,?,?,?,?)',
                           (row['id'], row['source'], row['sha'], content_sha, len(chunks)))
            for index, text in enumerate(chunks):
                stored = db.execute('SELECT input_sha,length(vector) FROM chunks WHERE product_id=? AND chunk_index=?',
                                    (row['id'], index)).fetchone()
                if stored == (hashes[index], dimensions * 4):
                    continue
                if len(encoder.encode(text)) > 8192:
                    raise ValueError('Embedding chunk exceeds model input limit')
                pending.append((row['id'], index, text, hashes[index]))
            if len(pending) >= batch_size:
                publish_batch()
        publish_batch()
        db.close()
        source.close()
        if previous is not None:
            previous.close()
        result = inspect(source_db, work)
        os.replace(work, target)
        for suffix in ('-wal', '-shm'):
            Path(str(work) + suffix).unlink(missing_ok=True)
        return {**result, 'reused_products': reused, 'index_bytes': target.stat().st_size}
    finally:
        if db:
            try: db.close()
            except sqlite3.Error: pass
        try: source.close()
        except sqlite3.Error: pass
        if previous is not None:
            try: previous.close()
            except sqlite3.Error: pass


class EmbeddingIndex:
    def __init__(self, source_db, index_path):
        self.info = inspect(source_db, index_path)
        db = sqlite3.connect('file:' + Path(index_path).resolve().as_posix() + '?mode=ro', uri=True)
        try:
            rows = db.execute('SELECT product_id,vector FROM chunks ORDER BY product_id,chunk_index').fetchall()
        finally:
            db.close()
        self.ids = [row[0] for row in rows]
        matrix = np.stack([np.frombuffer(row[1], dtype='<f4') for row in rows])
        norms = np.linalg.norm(matrix, axis=1)
        if np.any(norms == 0):
            raise ValueError('Embedding index contains a zero vector')
        self.matrix = matrix / norms[:, None]

    def rank(self, query_vector):
        query = np.asarray(query_vector, dtype=np.float32)
        if query.shape != (self.info['dimensions'],) or not np.isfinite(query).all():
            raise ValueError('Invalid query vector')
        magnitude = np.linalg.norm(query)
        if magnitude == 0:
            raise ValueError('Zero query vector')
        scores = self.matrix @ (query / magnitude)
        best = {}
        for product_id, score in zip(self.ids, scores):
            best[product_id] = max(best.get(product_id, -1.0), float(score))
        return sorted(best.items(), key=lambda item: (-item[1], item[0]))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    for name in ('plan', 'build', 'inspect'):
        command = sub.add_parser(name)
        command.add_argument('--source-db', required=True)
        if name != 'plan':
            command.add_argument('--index', required=True)
        if name == 'build':
            command.add_argument('--model', default=MODEL)
            command.add_argument('--dimensions', type=int, default=DIMENSIONS)
            command.add_argument('--batch-size', type=int, default=24)
    args = parser.parse_args()
    result = (plan(args.source_db) if args.command == 'plan' else
              build(args.source_db, args.index, args.model, args.dimensions, args.batch_size)
              if args.command == 'build' else inspect(args.source_db, args.index))
    print(json.dumps(result, ensure_ascii=False), flush=True)


if __name__ == '__main__':
    main()
