"""Durable per-operation checkpoint; budget reservations are issued externally."""

import json
import sqlite3
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager


class BatchOutcomeUnknown(RuntimeError):
    pass


class DurableBatchStore:
    def __init__(self, path):
        self.path = str(path)
        with self.transaction() as db:
            db.execute('''CREATE TABLE IF NOT EXISTS batch_calls (
                operation_id TEXT PRIMARY KEY, request_hash TEXT NOT NULL,
                reservation_id TEXT NOT NULL UNIQUE,
                state TEXT NOT NULL CHECK (state IN ('prepared','attempted','known','completed')),
                response_id TEXT, response_json TEXT)''')

    def connect(self):
        db = sqlite3.connect(self.path, timeout=30)
        db.execute('PRAGMA synchronous=FULL')
        return db

    @contextmanager
    def transaction(self):
        db = self.connect()
        try:
            db.execute('BEGIN IMMEDIATE')
            yield db
            db.commit()
        except BaseException:
            db.rollback()
            raise
        finally:
            db.close()

    def execute(self, operation_id, request_hash, reservation_id, invoke):
        if not all(isinstance(value, str) and value for value in (operation_id, request_hash, reservation_id)):
            raise ValueError('Operation, request hash and durable reservation are required')
        with self.transaction() as db:
            db.execute('''INSERT INTO batch_calls(operation_id,request_hash,reservation_id,state)
                          VALUES (?,?,?,'prepared') ON CONFLICT(operation_id) DO NOTHING''',
                       (operation_id, request_hash, reservation_id))
            row = db.execute('SELECT request_hash,reservation_id,state,response_json FROM batch_calls WHERE operation_id=?',
                             (operation_id,)).fetchone()
            if row[0] != request_hash or row[1] != reservation_id:
                raise ValueError('Operation identity or reservation changed')
            if row[2] == 'completed':
                return json.loads(row[3])
            if row[2] == 'known':
                return self._complete_known(db, operation_id, json.loads(row[3]))
            if row[2] == 'attempted':
                raise BatchOutcomeUnknown('Already attempted; automatic resubmission is forbidden')
            db.execute("UPDATE batch_calls SET state='attempted' WHERE operation_id=? AND state='prepared'", (operation_id,))
        response = invoke()
        if not isinstance(response, dict) or not isinstance(response.get('id'), str) or not response['id']:
            raise BatchOutcomeUnknown('Provider response identity is unknown')
        serialized = json.dumps(response, ensure_ascii=False, separators=(',', ':'), allow_nan=False)
        with self.transaction() as db:
            updated = db.execute("UPDATE batch_calls SET state='known',response_id=?,response_json=? WHERE operation_id=? AND state='attempted'",
                                 (response['id'], serialized, operation_id))
            if updated.rowcount != 1:
                raise BatchOutcomeUnknown('Receipt state changed before durable completion')
        with self.transaction() as db:
            return self._complete_known(db, operation_id, response)

    @staticmethod
    def _complete_known(db, operation_id, response):
        usage = response.get('usage')
        if not isinstance(usage, dict) or any(type(usage.get(key)) is not int or usage[key] < 0
                                               for key in ('input_tokens', 'output_tokens')):
            raise BatchOutcomeUnknown('Provider identity is known but usage is unknown')
        if response.get('status') != 'completed' or not isinstance(response.get('decisions'), list):
            raise BatchOutcomeUnknown('Provider result is not a completed classification')
        updated = db.execute("UPDATE batch_calls SET state='completed' WHERE operation_id=? AND state='known'", (operation_id,))
        if updated.rowcount != 1:
            raise BatchOutcomeUnknown('Receipt state changed before durable completion')
        return response

    def reconcile(self, operation_id, response):
        if not isinstance(response, dict) or not isinstance(response.get('id'), str):
            raise ValueError('Provider response identity is required')
        serialized = json.dumps(response, ensure_ascii=False, separators=(',', ':'), allow_nan=False)
        with self.transaction() as db:
            row = db.execute('SELECT state,response_id,response_json FROM batch_calls WHERE operation_id=?',
                             (operation_id,)).fetchone()
            if not row or row[1] != response['id'] or row[0] not in ('known', 'completed'):
                raise BatchOutcomeUnknown('Provider response does not match a known operation')
            if row[0] == 'completed':
                return json.loads(row[2])
            db.execute('UPDATE batch_calls SET response_json=? WHERE operation_id=?', (serialized, operation_id))
            return self._complete_known(db, operation_id, response)


def execute_all(store, operations, workers=8):
    """Return results only if every independently checkpointed operation completed."""
    def run(operation):
        return store.execute(operation['operation_id'], operation['request_hash'],
                             operation['reservation_id'], operation['invoke'])
    with ThreadPoolExecutor(max_workers=workers) as executor:
        return list(executor.map(run, operations))
