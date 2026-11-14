import importlib.util
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import patch
import urllib.error

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'catalog-service'))
import semantic_selector

spec = importlib.util.spec_from_file_location('guard_test_embedding_index', ROOT / 'catalog-service' / 'embedding_index.py')
embedding = importlib.util.module_from_spec(spec)
with patch.dict(sys.modules, {'numpy': types.ModuleType('numpy'), 'tiktoken': types.ModuleType('tiktoken')}):
    spec.loader.exec_module(embedding)


def response(data):
    return io.BytesIO(json.dumps(data).encode())


class PythonMonetaryGuardTest(unittest.TestCase):
    def test_embedding_guard_flags_and_off_behavior(self):
        fixture = {'model': 'fixture', 'data': [{'index': 0, 'embedding': [1.0, 2.0]}], 'usage': {'total_tokens': 2}}
        for flag in ('1', ' TRUE ', 'yes', 'ON', 'invalid', '2', '', '0', ' false ', 'no', 'OFF'):
            with self.subTest(flag=flag), patch.dict(os.environ, {'OPENAI_MONETARY_GUARD_ENABLED': flag}), \
                 patch.object(embedding.urllib.request, 'urlopen', return_value=response(fixture)) as send, \
                 patch.object(embedding.np, 'isfinite', return_value=types.SimpleNamespace(all=lambda: True), create=True):
                if flag.strip().lower() in ('1', 'true', 'yes', 'on'):
                    with self.assertRaises(RuntimeError): embedding.embed_batch(['x'], 'fixture', 2, 'fake')
                    send.assert_not_called()
                elif flag in ('invalid', '2'):
                    with self.assertRaises(ValueError): embedding.embed_batch(['x'], 'fixture', 2, 'fake')
                    send.assert_not_called()
                else:
                    vectors, usage = embedding.embed_batch(['x'], 'fixture', 2, 'fake')
                    self.assertEqual((len(vectors), usage), (1, 2))
                    send.assert_called_once()

    def test_query_off_sends_fake_request(self):
        fixture = {'model': 'fixture', 'data': [{'index': 0, 'embedding': [1.0, 2.0]}], 'usage': {'total_tokens': 2}}
        encoder = types.SimpleNamespace(encode=lambda text: [1])
        with patch.dict(os.environ, {'OPENAI_MONETARY_GUARD_ENABLED': 'off', 'OPENAI_API_KEY': 'fake'}), \
             patch.object(embedding.tiktoken, 'get_encoding', return_value=encoder, create=True), \
             patch.object(embedding.np, 'isfinite', return_value=types.SimpleNamespace(all=lambda: True), create=True), \
             patch.object(embedding.urllib.request, 'urlopen', return_value=response(fixture)) as send:
            self.assertEqual(embedding.embed_query('test', model='fixture', dimensions=2), ((1.0, 2.0), 2))
            send.assert_called_once()

    def test_retry_rechecks_guard(self):
        for flag, exception in [('true', RuntimeError), ('bad', ValueError)]:
            def first_attempt(*args, **kwargs):
                os.environ['OPENAI_MONETARY_GUARD_ENABLED'] = flag
                raise urllib.error.URLError('offline fixture')
            with self.subTest(flag=flag), patch.dict(os.environ, {'OPENAI_MONETARY_GUARD_ENABLED': 'off'}), \
                 patch.object(embedding.urllib.request, 'urlopen', side_effect=first_attempt) as send, \
                 patch.object(embedding.time, 'sleep'):
                with self.assertRaises(exception): embedding.embed_batch(['x'], 'fixture', 2, 'fake')
                self.assertEqual(send.call_count, 1)

    def test_build_and_query_refuse_before_index_or_credentials(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / 'index.sqlite'
            target.write_bytes(b'unchanged')
            for flag, exception in [('true', RuntimeError), ('bad', ValueError)]:
                with self.subTest(flag=flag), patch.dict(os.environ, {'OPENAI_MONETARY_GUARD_ENABLED': flag}), \
                     patch.object(embedding.urllib.request, 'urlopen') as send, \
                     patch.object(embedding, 'source_rows') as rows:
                    with self.assertRaises(exception): embedding.build('missing', target)
                    with self.assertRaises(exception): embedding.embed_query('test')
                    rows.assert_not_called()
                    send.assert_not_called()
                    self.assertEqual(target.read_bytes(), b'unchanged')
                    self.assertEqual([p.name for p in Path(directory).iterdir()], ['index.sqlite'])

    def test_selector_flags_and_off_behavior(self):
        group = [({'id': '1'}, {'name': 'item', 'facts': ['name: item']})]
        result = {'status': 'completed', 'usage': {}, 'output': [{'content': [{'type': 'output_text', 'text': '{"0":{"label":"unknown","facts":[]}}'}]}]}
        for flag in ('1', ' TRUE ', 'yes', 'ON', 'bad', '', '0', ' FALSE ', 'no', 'off'):
            with self.subTest(flag=flag), patch.dict(os.environ, {'OPENAI_MONETARY_GUARD_ENABLED': flag, 'OPENAI_API_KEY': 'fake'}), \
                 patch.object(semantic_selector.urllib.request, 'urlopen', return_value=response(result)) as send:
                if flag.strip().lower() in ('1', 'true', 'yes', 'on'):
                    with self.assertRaises(RuntimeError): semantic_selector._classify_group(group, 'test')
                    send.assert_not_called()
                elif flag == 'bad':
                    with self.assertRaises(ValueError): semantic_selector._classify_group(group, 'test')
                    send.assert_not_called()
                else:
                    decisions, _, _, _ = semantic_selector._classify_group(group, 'test')
                    self.assertEqual(decisions[0]['label'], 'unknown')
                    send.assert_called_once()

    def test_selector_rechecks_at_send(self):
        group = [({'id': '1'}, {'name': 'item', 'facts': ['name: item']})]
        class Store:
            def execute(self, operation_id, digest, reservation, send):
                os.environ['OPENAI_MONETARY_GUARD_ENABLED'] = 'on'
                return send()
        receipt = {'store': Store(), 'operation_id': 'op', 'reservation_id': 'reservation'}
        with patch.dict(os.environ, {'OPENAI_MONETARY_GUARD_ENABLED': 'off', 'OPENAI_API_KEY': 'fake'}), \
             patch.object(semantic_selector.urllib.request, 'urlopen') as send:
            with self.assertRaises(RuntimeError): semantic_selector._classify_group(group, 'test', receipt)
            send.assert_not_called()


if __name__ == '__main__':
    unittest.main()
