import sqlite3
import subprocess
import sys
import tempfile
import threading
import unittest
import json
import os
import urllib.error
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'catalog-service'))
from durable_batch import BatchOutcomeUnknown, DurableBatchStore, execute_all
import semantic_selector


class DurableBatchTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name) / 'receipts.sqlite'
        self.store = DurableBatchStore(self.path)

    @staticmethod
    def success():
        return {'id': 'resp_test', 'status': 'completed', 'usage': {'input_tokens': 100, 'output_tokens': 20},
                'decisions': ['yes']}

    def test_partial_failure_preserves_success_and_restart_never_reposts(self):
        sent = []
        def first():
            sent.append('first')
            return self.success()
        def second():
            sent.append('second')
            raise TimeoutError('unknown provider outcome')
        jobs = [{'operation_id': 'scope:1', 'request_hash': 'hash1', 'reservation_id': 'reserve1', 'invoke': first},
                {'operation_id': 'scope:2', 'request_hash': 'hash2', 'reservation_id': 'reserve2', 'invoke': second}]
        with self.assertRaises(TimeoutError):
            execute_all(self.store, jobs)
        restarted = DurableBatchStore(self.path)
        self.assertEqual(restarted.execute('scope:1', 'hash1', 'reserve1', first), self.success())
        with self.assertRaises(BatchOutcomeUnknown):
            restarted.execute('scope:2', 'hash2', 'reserve2', second)
        self.assertCountEqual(sent, ['first', 'second'])
        with closing(sqlite3.connect(self.path)) as db:
            states = dict(db.execute('SELECT operation_id,state FROM batch_calls'))
        self.assertEqual(states, {'scope:1': 'completed', 'scope:2': 'attempted'})
        script = '''import sys
from durable_batch import DurableBatchStore, BatchOutcomeUnknown
store = DurableBatchStore(sys.argv[1])
def forbidden(): raise AssertionError('provider called again')
assert store.execute('scope:1', 'hash1', 'reserve1', forbidden)['id'] == 'resp_test'
try: store.execute('scope:2', 'hash2', 'reserve2', forbidden)
except BatchOutcomeUnknown: pass
else: raise AssertionError('unknown operation was resubmitted')
'''
        environment = dict(__import__('os').environ)
        environment['PYTHONPATH'] = str(Path(__file__).resolve().parents[1] / 'catalog-service')
        restarted_process = subprocess.run([sys.executable, '-B', '-c', script, str(self.path)],
                                           capture_output=True, text=True, env=environment)
        self.assertEqual(restarted_process.returncode, 0, restarted_process.stderr)

    def test_receipt_write_failure_leaves_attempted_and_blocks_repost(self):
        with closing(sqlite3.connect(self.path)) as db:
            db.execute("CREATE TRIGGER reject_receipt BEFORE UPDATE OF state ON batch_calls WHEN NEW.state='known' BEGIN SELECT RAISE(FAIL,'disk failure'); END")
            db.commit()
        calls = []
        def invoke():
            calls.append(1)
            return self.success()
        with self.assertRaises(sqlite3.IntegrityError):
            self.store.execute('operation', 'hash', 'reservation', invoke)
        with self.assertRaises(BatchOutcomeUnknown):
            DurableBatchStore(self.path).execute('operation', 'hash', 'reservation', invoke)
        self.assertEqual(calls, [1])

    def test_unknown_usage_is_not_zero_and_cannot_be_reposted(self):
        calls = []
        def invoke():
            calls.append(1)
            return {'id': 'resp_test', 'usage': None}
        with self.assertRaises(BatchOutcomeUnknown):
            self.store.execute('operation', 'hash', 'reservation', invoke)
        with self.assertRaises(BatchOutcomeUnknown):
            DurableBatchStore(self.path).execute('operation', 'hash', 'reservation', invoke)
        self.assertEqual(calls, [1])
        with closing(sqlite3.connect(self.path)) as db:
            self.assertEqual(db.execute('SELECT state,response_id FROM batch_calls').fetchone(), ('known', 'resp_test'))
        restarted = DurableBatchStore(self.path)
        with self.assertRaises(BatchOutcomeUnknown):
            restarted.reconcile('operation', {**self.success(), 'id': 'resp_wrong'})
        self.assertEqual(restarted.reconcile('operation', self.success()), self.success())
        self.assertEqual(restarted.execute('operation', 'hash', 'reservation', invoke), self.success())
        self.assertEqual(calls, [1])

    def test_concurrent_recovery_sends_at_most_one_post(self):
        started = threading.Event()
        release = threading.Event()
        calls = []
        def invoke():
            calls.append(1)
            started.set()
            self.assertTrue(release.wait(5))
            return self.success()
        with ThreadPoolExecutor(max_workers=2) as executor:
            first = executor.submit(self.store.execute, 'operation', 'hash', 'reservation', invoke)
            self.assertTrue(started.wait(5))
            second = executor.submit(DurableBatchStore(self.path).execute, 'operation', 'hash', 'reservation', invoke)
            with self.assertRaises(BatchOutcomeUnknown): second.result(timeout=5)
            release.set()
            self.assertEqual(first.result(timeout=5), self.success())
        self.assertEqual(calls, [1])

    def test_changed_request_or_reused_reservation_is_rejected(self):
        self.store.execute('one', 'hash', 'reserve', self.success)
        with self.assertRaises(ValueError): self.store.execute('one', 'different', 'reserve', self.success)
        with self.assertRaises(sqlite3.IntegrityError): self.store.execute('two', 'hash', 'reserve', self.success)

    def test_real_grouping_persists_success_before_neighbor_failure(self):
        products = [{'id': str(i), 'name': f'card {i}', 'facts': [('name', 'test')]} for i in range(21)]
        calls = []
        class Response:
            def __init__(self, value): self.value = value
            def __enter__(self): return self
            def __exit__(self, *args): pass
            def read(self): return json.dumps(self.value).encode()
        def provider(request, timeout):
            body = json.loads(request.data)
            is_first = 'card 19' in body['input']
            calls.append('first' if is_first else 'second')
            if not is_first: raise urllib.error.URLError('unknown second POST')
            labels = {str(i): {'label': 'yes', 'facts': [0]} for i in range(20)}
            return Response({'id': 'resp_first', 'status': 'completed',
                'usage': {'input_tokens': 100, 'output_tokens': 20},
                'output': [{'content': [{'type': 'output_text', 'text': json.dumps(labels)}]}]})
        context = {'store': self.store, 'operation_scope': 'turn', 'reservations': ['reserve1', 'reserve2']}
        with patch.dict(os.environ, {'OPENAI_API_KEY': 'test'}), patch.object(semantic_selector.urllib.request, 'urlopen', provider):
            with self.assertRaises(urllib.error.URLError): semantic_selector._classify(products, 'requirement', context)
            context['store'] = DurableBatchStore(self.path)
            with self.assertRaises(BatchOutcomeUnknown): semantic_selector._classify(products, 'requirement', context)
        self.assertCountEqual(calls, ['first', 'second'])
        with closing(sqlite3.connect(self.path)) as db:
            rows = dict(db.execute('SELECT operation_id,state FROM batch_calls'))
        self.assertEqual(rows, {'turn:0': 'completed', 'turn:1': 'attempted'})

    def test_unreserved_batch_is_rejected_before_network(self):
        products = [{'id': str(i), 'name': f'card {i}', 'facts': [('name', 'test')]} for i in range(21)]
        context = {'store': self.store, 'operation_scope': 'turn', 'reservations': ['only_one']}
        with patch.object(semantic_selector.urllib.request, 'urlopen') as send:
            with self.assertRaisesRegex(ValueError, 'Every classification batch'):
                semantic_selector._classify(products, 'requirement', context)
        send.assert_not_called()


if __name__ == '__main__':
    unittest.main()
