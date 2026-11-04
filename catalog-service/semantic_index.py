"""Build a source-grounded semantic product index from the 4324 original cards.

prepare writes an OpenAI Batch API /v1/responses JSONL file; ingest validates
every response against its exact source card before atomically publishing SQLite.
Neither command changes the live catalog database.
"""
import argparse
import hashlib
import json
import os
import sqlite3
import unicodedata
import urllib.error
import urllib.request
import uuid
from datetime import datetime, timezone
from pathlib import Path

SOURCE_FIELDS = ('название', 'бренд', 'категория', 'артикул', 'описание', 'характеристики')
FACT_KINDS = ('product_type', 'purpose', 'material', 'compatibility', 'feature', 'dimension')
FACT_SCHEMA = {
    'type': 'object', 'additionalProperties': False, 'required': ['facts'],
    'properties': {'facts': {'type': 'array', 'items': {
        'type': 'object', 'additionalProperties': False,
        'required': ['kind', 'value', 'source_field', 'attribute_key', 'evidence'],
        'properties': {
            'kind': {'type': 'string', 'enum': list(FACT_KINDS)},
            'value': {'type': 'string'},
            'source_field': {'type': 'string', 'enum': list(SOURCE_FIELDS)},
            'attribute_key': {'type': ['string', 'null']},
            'evidence': {'type': 'string'},
        },
    }}},
}
INSTRUCTIONS = (
    'Выдели из товарной карточки понятия для поиска по смыслу: тип товара, '
    'назначение, материал применения, явно указанную совместимость, существенные '
    'свойства и размеры. Для product_type укажи и конкретный вид, и более общий '
    'род товара, когда оба прямо следуют из названия или категории: например, '
    '«абразивный диск» и «диск». Не добавляй особенности упаковки или вес брутто, '
    'если они не влияют на выбор товара. Это подготовка индекса, а не ответ покупателю. '
    'Каждый факт подкрепи ДОСЛОВНЫМ коротким фрагментом значения одного поля '
    'этой карточки в evidence: без кавычек, названия поля, добавленных слов и '
    'перефразирования. В source_field укажи точный ключ верхнего уровня; '
    'для характеристики укажи её точное имя в attribute_key, для остальных '
    'полей attribute_key=null. Например, если категория равна «Дизельные '
    'генераторы», evidence="Дизельные генераторы", source_field="категория". '
    'Не дополняй знанием о бренде или похожих моделях. '
    'Не смешивай мощность двигателя, номинальную и максимальную электрическую '
    'мощность; не выводи совместимость из одного только совпадения бренда. '
    'Если факт не указан, не добавляй его. Верни JSON по схеме.'
)


def normalized(value):
    return unicodedata.normalize('NFKC', str(value)).casefold().replace('ё', 'е')


def source_rows(directory):
    files = sorted(Path(directory).glob('*.json'), key=lambda path: path.name)
    if len(files) != 4324:
        raise ValueError(f'Expected 4324 source cards; found {len(files)}')
    seen = set()
    for path in files:
        raw = path.read_bytes()
        sha = hashlib.sha256(raw).hexdigest()
        if path.name in seen:
            raise ValueError(f'Duplicate source name: {path.name}')
        seen.add(path.name)
        data = json.loads(raw.decode('utf-8-sig'))
        if not isinstance(data, dict):
            raise ValueError(f'Card is not an object: {path.name}')
        yield path.name, sha, data


def card_payload(data):
    return {key: data.get(key) for key in SOURCE_FIELDS if data.get(key) not in (None, '', {}, [])}


def card_id(source, sha):
    return hashlib.sha256((source + '\0' + sha).encode('utf-8')).hexdigest()[:32]


def prepare(source_dir, output_path, model):
    output = Path(output_path)
    if output.exists():
        raise FileExistsError(output)
    tmp = output.with_name(output.name + '.tmp')
    if tmp.exists():
        raise FileExistsError(tmp)
    count = 0
    try:
        with tmp.open('w', encoding='utf-8', newline='\n') as stream:
            for source, sha, data in source_rows(source_dir):
                request = {
                    'custom_id': card_id(source, sha), 'method': 'POST', 'url': '/v1/responses',
                    'body': {
                        'model': model, 'reasoning': {'effort': 'medium'},
                        'instructions': INSTRUCTIONS,
                        'input': json.dumps(card_payload(data), ensure_ascii=False, separators=(',', ':')),
                        'text': {'format': {
                            'type': 'json_schema', 'name': 'bakaut_product_semantics',
                            'strict': True, 'schema': FACT_SCHEMA,
                        }},
                    },
                }
                stream.write(json.dumps(request, ensure_ascii=False, separators=(',', ':')) + '\n')
                count += 1
        os.replace(tmp, output)
    finally:
        if tmp.exists():
            tmp.unlink()
    return {'requests': count, 'bytes': output.stat().st_size, 'path': str(output)}


def response_facts(item):
    response = item.get('response')
    if not isinstance(response, dict) or response.get('status_code') != 200:
        raise ValueError('Batch response failed')
    body = response.get('body') or {}
    if body.get('status') != 'completed':
        raise ValueError('Model response incomplete')
    parts = [part.get('text') for message in body.get('output', [])
             if message.get('type') == 'message'
             for part in message.get('content', []) if part.get('type') == 'output_text']
    if len(parts) != 1 or not isinstance(parts[0], str):
        raise ValueError('Expected one structured model answer')
    parsed = json.loads(parts[0])
    if set(parsed) != {'facts'} or not isinstance(parsed['facts'], list):
        raise ValueError('Invalid semantic facts object')
    return parsed['facts']


def catalog_mapping(path):
    path = Path(path)
    if path.suffix.lower() == '.json':
        data = json.loads(path.read_text(encoding='utf-8-sig'))
        revision = data['revision']
        entries = data['products']
    else:
        catalog = sqlite3.connect('file:' + path.resolve().as_posix() + '?mode=ro', uri=True)
        try:
            entries = catalog.execute('SELECT id,source,sha FROM products').fetchall()
            revision = catalog.execute('SELECT revision FROM metadata').fetchone()[0]
        finally:
            catalog.close()
    if not isinstance(revision, str) or not revision:
        raise ValueError('Missing catalog revision')
    result = {source: (product_id, sha) for product_id, source, sha in entries}
    if len(result) != len(entries) or len({entry[0] for entry in result.values()}) != len(entries):
        raise ValueError('Duplicate catalog identity')
    return result, revision


def ingest(source_dir, result_path, output_path, catalog_path):
    rows = {card_id(source, sha): (source, sha, data)
            for source, sha, data in source_rows(source_dir)}
    if len(rows) != 4324:
        raise ValueError('Source identity collision')
    catalog_rows, revision = catalog_mapping(catalog_path)
    if len(catalog_rows) != len(rows) or any(
            catalog_rows.get(source, (None, None))[1] != sha for source, sha, _ in rows.values()):
        raise ValueError('Catalog does not match all original source cards')
    output = Path(output_path)
    if output.exists():
        raise FileExistsError(output)
    tmp = output.with_name(output.name + '.tmp')
    if tmp.exists():
        raise FileExistsError(tmp)
    connection = sqlite3.connect(tmp)
    seen = set()
    try:
        connection.executescript('''
            CREATE TABLE products(product_id TEXT PRIMARY KEY, source TEXT UNIQUE NOT NULL,
                                  sha TEXT NOT NULL, custom_id TEXT UNIQUE NOT NULL, needs_review INTEGER NOT NULL);
            CREATE TABLE facts(product_id TEXT NOT NULL, kind TEXT NOT NULL, value TEXT NOT NULL,
                               normalized_value TEXT NOT NULL,
                               source_field TEXT NOT NULL, attribute_key TEXT, evidence TEXT NOT NULL,
                               FOREIGN KEY(product_id) REFERENCES products(product_id));
            CREATE TABLE rejected_facts(product_id TEXT NOT NULL, reason TEXT NOT NULL, fact_json TEXT NOT NULL);
            CREATE INDEX facts_kind_value ON facts(kind,normalized_value,product_id);
            CREATE TABLE concepts(kind TEXT NOT NULL, normalized_value TEXT NOT NULL,
                                  display_value TEXT NOT NULL, product_count INTEGER NOT NULL,
                                  PRIMARY KEY(kind,normalized_value));
            CREATE TABLE metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL);
        ''')
        with Path(result_path).open(encoding='utf-8') as stream:
            for line in stream:
                item = json.loads(line)
                identifier = item.get('custom_id')
                if identifier not in rows or identifier in seen:
                    raise ValueError('Missing or duplicate source identity in batch result')
                seen.add(identifier)
                source, sha, data = rows[identifier]
                product_id = catalog_rows[source][0]
                facts = response_facts(item)
                accepted = set()
                needs_review = 0
                for fact in facts:
                    if not isinstance(fact, dict) or set(fact) != {'kind', 'value', 'source_field', 'attribute_key', 'evidence'}:
                        raise ValueError(f'Invalid fact shape in {source}')
                    kind, value, field, attribute, evidence = (
                        fact[key] for key in ('kind', 'value', 'source_field', 'attribute_key', 'evidence'))
                    valid = kind in FACT_KINDS and field in SOURCE_FIELDS and all(
                        isinstance(x, str) and x.strip() for x in (value, evidence))
                    if field == 'характеристики':
                        valid = valid and isinstance(attribute, str) and attribute in (data.get(field) or {})
                        original = (data.get(field) or {}).get(attribute, '') if valid else ''
                    else:
                        valid = valid and attribute is None and isinstance(data.get(field), str)
                        original = data.get(field, '') if valid else ''
                    if not valid or normalized(evidence) not in normalized(original):
                        needs_review = 1
                        connection.execute('INSERT INTO rejected_facts VALUES(?,?,?)',
                                           (product_id, 'evidence_not_in_exact_source_field', json.dumps(fact, ensure_ascii=False)))
                        continue
                    identity = (kind, normalized(value), field, attribute, normalized(evidence))
                    if identity in accepted:
                        continue
                    accepted.add(identity)
                    connection.execute('INSERT INTO facts VALUES(?,?,?,?,?,?,?)',
                                       (product_id, kind, value.strip(), normalized(value.strip()),
                                        field, attribute, evidence.strip()))
                if not accepted:
                    needs_review = 1
                connection.execute('INSERT INTO products VALUES(?,?,?,?,?)',
                                   (product_id, source, sha, identifier, needs_review))
        if len(seen) != len(rows):
            raise ValueError(f'Incomplete batch: {len(seen)} of {len(rows)} cards')
        digest = hashlib.sha256(''.join(source + '\t' + sha + '\n'
                         for source, sha, _ in sorted(rows.values())).encode()).hexdigest()
        connection.execute('''INSERT INTO concepts
            SELECT kind, normalized_value, MIN(value), COUNT(DISTINCT product_id)
            FROM facts GROUP BY kind, normalized_value''')
        connection.execute('INSERT INTO metadata VALUES(?,?)', ('source_digest', digest))
        connection.execute('INSERT INTO metadata VALUES(?,?)', ('source_revision', revision))
        connection.execute('INSERT INTO metadata VALUES(?,?)', ('card_count', str(len(rows))))
        connection.commit()
        count = connection.execute('SELECT COUNT(*) FROM facts').fetchone()[0]
        concepts = connection.execute('SELECT COUNT(*) FROM concepts').fetchone()[0]
        review = connection.execute('SELECT COUNT(*) FROM products WHERE needs_review=1').fetchone()[0]
        rejected = connection.execute('SELECT COUNT(*) FROM rejected_facts').fetchone()[0]
        connection.close()
        os.replace(tmp, output)
        return {'cards': len(rows), 'facts': count, 'concepts': concepts, 'needs_review': review,
                'rejected_facts': rejected, 'source_digest': digest, 'path': str(output)}
    except BaseException:
        connection.close()
        if tmp.exists():
            tmp.unlink()
        raise


def api_request(key, path, payload=None, content_type=None):
    headers = {'Authorization': 'Bearer ' + key}
    if content_type:
        headers['Content-Type'] = content_type
    request = urllib.request.Request('https://api.openai.com/v1' + path, data=payload, headers=headers,
                                     method='POST' if payload is not None else 'GET')
    try:
        with urllib.request.urlopen(request, timeout=180) as response:
            return response.read()
    except urllib.error.HTTPError as exc:
        try:
            problem = json.loads(exc.read())
            detail = problem.get('error', {})
            message = str(detail.get('message', ''))[:200]
        except (ValueError, AttributeError):
            message = ''
        raise RuntimeError(f'OpenAI request failed: HTTP {exc.code}; {message}') from None


def read_key(path):
    key = Path(path).read_text(encoding='utf-8-sig').strip()
    if not key.startswith('sk-'):
        raise ValueError('Key file does not contain an OpenAI API key')
    return key


def submit_batch(key_path, input_path, receipt_path):
    receipt = Path(receipt_path)
    if receipt.exists():
        raise FileExistsError(receipt)
    key = read_key(key_path)
    data = Path(input_path).read_bytes()
    if sum(line.strip() != b'' for line in data.splitlines()) != 4324:
        raise ValueError('Expected 4324 batch requests')
    boundary = 'bakaut-' + uuid.uuid4().hex
    body = (f'--{boundary}\r\nContent-Disposition: form-data; name="purpose"\r\n\r\nbatch\r\n'
            f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="catalog.jsonl"\r\n'
            'Content-Type: application/jsonl\r\n\r\n').encode() + data + f'\r\n--{boundary}--\r\n'.encode()
    uploaded = json.loads(api_request(key, '/files', body, f'multipart/form-data; boundary={boundary}'))
    file_id = uploaded['id']
    request = json.dumps({'input_file_id': file_id, 'endpoint': '/v1/responses',
                          'completion_window': '24h',
                          'metadata': {'purpose': 'bakaut_semantic_product_index'}},
                         separators=(',', ':')).encode()
    batch = json.loads(api_request(key, '/batches', request, 'application/json'))
    result = {'batch_id': batch['id'], 'input_file_id': file_id,
              'submitted_at': datetime.now(timezone.utc).isoformat(),
              'input_sha256': hashlib.sha256(data).hexdigest(), 'requests': 4324}
    receipt.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
    return {'batch_id': result['batch_id'], 'status': batch['status'], 'receipt': str(receipt)}


def batch_status(key_path, receipt_path, download_path=None):
    receipt = json.loads(Path(receipt_path).read_text(encoding='utf-8'))
    key = read_key(key_path)
    batch = json.loads(api_request(key, '/batches/' + receipt['batch_id']))
    result = {'batch_id': batch['id'], 'status': batch['status'],
              'counts': batch.get('request_counts'), 'usage': batch.get('usage')}
    if download_path:
        if batch['status'] != 'completed' or not batch.get('output_file_id'):
            raise ValueError('Batch output is not ready')
        output = Path(download_path)
        if output.exists():
            raise FileExistsError(output)
        payload = api_request(key, '/files/' + batch['output_file_id'] + '/content')
        tmp = output.with_name(output.name + '.tmp')
        if tmp.exists():
            raise FileExistsError(tmp)
        try:
            tmp.write_bytes(payload)
            os.replace(tmp, output)
        finally:
            if tmp.exists():
                tmp.unlink()
        result['output_path'] = str(output)
        result['output_bytes'] = len(payload)
    return result


def inspect_index(path):
    connection = sqlite3.connect('file:' + Path(path).resolve().as_posix() + '?mode=ro', uri=True)
    try:
        metadata = dict(connection.execute('SELECT key,value FROM metadata'))
        cards = connection.execute('SELECT COUNT(*) FROM products').fetchone()[0]
        distinct_ids = connection.execute('SELECT COUNT(DISTINCT product_id) FROM products').fetchone()[0]
        facts_by_kind = dict(connection.execute('SELECT kind,COUNT(*) FROM facts GROUP BY kind'))
        concepts_by_kind = dict(connection.execute('SELECT kind,COUNT(*) FROM concepts GROUP BY kind'))
        needs_review = connection.execute('SELECT COUNT(*) FROM products WHERE needs_review=1').fetchone()[0]
        rejected = connection.execute('SELECT COUNT(*) FROM rejected_facts').fetchone()[0]
        without_type = connection.execute('''SELECT COUNT(*) FROM products p WHERE NOT EXISTS
            (SELECT 1 FROM facts f WHERE f.product_id=p.product_id AND f.kind='product_type')''').fetchone()[0]
        if cards != 4324 or distinct_ids != cards or metadata.get('card_count') != str(cards):
            raise ValueError('Incomplete or duplicate semantic index')
        return {'source_revision': metadata['source_revision'], 'source_digest': metadata['source_digest'],
                'cards': cards, 'facts_by_kind': facts_by_kind, 'concepts_by_kind': concepts_by_kind,
                'needs_review': needs_review, 'rejected_facts': rejected, 'without_product_type': without_type}
    finally:
        connection.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    for name in ('prepare', 'ingest'):
        command = commands.add_parser(name)
        command.add_argument('--source', required=True)
        command.add_argument('--output', required=True)
        if name == 'prepare':
            command.add_argument('--model', default='gpt-6-luna')
        else:
            command.add_argument('--results', required=True)
            command.add_argument('--catalog', required=True)
    submit = commands.add_parser('submit')
    submit.add_argument('--input', required=True)
    submit.add_argument('--receipt', required=True)
    submit.add_argument('--key-file', required=True)
    status = commands.add_parser('status')
    status.add_argument('--receipt', required=True)
    status.add_argument('--key-file', required=True)
    status.add_argument('--download')
    inspect = commands.add_parser('inspect')
    inspect.add_argument('--index', required=True)
    args = parser.parse_args()
    if args.command == 'prepare':
        result = prepare(args.source, args.output, args.model)
    elif args.command == 'ingest':
        result = ingest(args.source, args.results, args.output, args.catalog)
    elif args.command == 'submit':
        result = submit_batch(args.key_file, args.input, args.receipt)
    elif args.command == 'inspect':
        result = inspect_index(args.index)
    else:
        result = batch_status(args.key_file, args.receipt, args.download)
    print(json.dumps(result, ensure_ascii=False))


if __name__ == '__main__':
    main()
