import json
import os
import shutil
import sqlite3
import sys
import tempfile
import unittest
from contextlib import closing
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import bounded_live_eval_adapter as adapter


class ProviderResponse:
    def __init__(self, status, payload): self.status, self.payload = status, json.dumps(payload).encode('utf-8')
    def read(self, _size): return self.payload


class TransportMockTest(unittest.TestCase):
    def test_key_reads_only_named_value_and_rejects_ambiguity(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / '.env'
            source.write_text('OTHER_SECRET=never-use\nOPENAI_API_KEY="sk-local-example"\n', encoding='utf-8')
            self.assertEqual(adapter.read_api_key({}, source), 'sk-local-example')
            self.assertEqual(adapter.read_api_key({'OPENAI_API_KEY': 'sk-env-example'}, source), 'sk-env-example')
            source.write_text('OPENAI_API_KEY=one\nOPENAI_API_KEY=two\n', encoding='utf-8')
            with self.assertRaisesRegex(ValueError, 'ambiguous'): adapter.read_api_key({}, source)
            source.write_text('OPENAI_API_KEY=${OTHER_SECRET}\n', encoding='utf-8')
            with self.assertRaisesRegex(ValueError, 'invalid'): adapter.read_api_key({}, source)

    def test_fixed_host_one_post_and_redirect_rejection_without_proxy_or_retry(self):
        events = []
        class FakeConnection:
            def __init__(self, host, port, timeout, context): events.append(('connect', host, port, timeout))
            def request(self, method, endpoint, body, headers): events.append(('request', method, endpoint, json.loads(body), headers))
            def getresponse(self): return ProviderResponse(302, {'untrusted': 'ignored'})
            def close(self): events.append(('close',))
        with patch.dict(os.environ, {'HTTP_PROXY': 'http://127.0.0.1:1', 'HTTPS_PROXY': 'http://127.0.0.1:2'}, clear=True), \
             patch.object(adapter.http.client, 'HTTPSConnection', FakeConnection), \
             patch.object(adapter.ssl, 'create_default_context', return_value=object()):
            transport = adapter.LiteralOpenAITransport('sk-fake-test')
            with self.assertRaisesRegex(RuntimeError, 'outcome unknown'):
                transport('/v1/responses/input_tokens', {'model': 'gpt-6-luna'})
            with self.assertRaises(ValueError): transport('https://elsewhere.invalid/', {})
        self.assertEqual([event[0] for event in events], ['connect', 'request', 'close'])
        self.assertEqual(events[0][1:3], ('api.openai.com', 443))
        self.assertEqual(events[1][1:3], ('POST', '/v1/responses/input_tokens'))
        self.assertEqual(events[1][4]['Authorization'], 'Bearer sk-fake-test')

    def test_invalid_scope_and_default_cli_path_never_read_key(self):
        with patch.object(adapter, 'read_api_key', side_effect=AssertionError('key read')) as read:
            with self.assertRaisesRegex(RuntimeError, 'BLOCKED'): adapter.run_live()
            with self.assertRaisesRegex(RuntimeError, 'BLOCKED'):
                adapter.run_live(execute=True, executor='mark', budget_usd='2.01', max_http=24, scenarios=8)
            read.assert_not_called()

    def test_timeout_after_generation_is_held_and_never_retried(self):
        with tempfile.TemporaryDirectory() as directory:
            db = Path(directory) / 'ledger.sqlite'
            adapter.claim_owner(db, 'owner')
            calls = []
            def transport(endpoint, body):
                calls.append(endpoint)
                if endpoint.endswith('/input_tokens'): return {'object': 'response.input_tokens', 'input_tokens': 200}
                raise TimeoutError('unknown generation outcome')
            case_id = adapter.fixtures.cases()[0]['id']
            with self.assertRaises(TimeoutError): adapter.run_case(db, 'owner', case_id, 0, transport)
            with self.assertRaises(ValueError): adapter.run_case(db, 'owner', case_id, 0, transport)
            with closing(sqlite3.connect(db)) as conn:
                self.assertEqual(conn.execute('SELECT kind,status,reserved_micro_usd FROM http_attempts ORDER BY rowid').fetchall(),
                    [('preflight', 'completed', 0), ('generation', 'unknown', 81_400)])
                self.assertEqual(conn.execute('SELECT frozen FROM control').fetchone()[0], 1)
            self.assertEqual(calls, ['/v1/responses/input_tokens', '/v1/responses'])

    def test_response_echoing_key_is_rejected_without_retry(self):
        calls = []
        class FakeConnection:
            def __init__(self, host, port, timeout, context): pass
            def request(self, method, endpoint, body, headers): calls.append(endpoint)
            def getresponse(self): return ProviderResponse(200, {'error': 'sk-not-real'})
            def close(self): pass
        with patch.object(adapter.http.client, 'HTTPSConnection', FakeConnection), patch.object(adapter.ssl, 'create_default_context', return_value=object()):
            with self.assertRaisesRegex(RuntimeError, 'unsafe'):
                adapter.LiteralOpenAITransport('sk-not-real')('/v1/responses/input_tokens', {})
        self.assertEqual(calls, ['/v1/responses/input_tokens'])

    def test_eight_cases_end_to_end_over_mock_http_and_one_fixed_ledger(self):
        with tempfile.TemporaryDirectory() as directory:
            export_dir = Path(directory) / 'exports'
            export_dir.mkdir()
            for filename in (*adapter.PINNED_EXPORTS, 'bounded-eval-request-plan.json'):
                shutil.copyfile(adapter.EXPORTS / filename, export_dir / filename)
            ledger = export_dir / 'bounded-live-ledger.sqlite'
            requests = []
            class FakeConnection:
                def __init__(self, host, port, timeout, context):
                    if (host, port) != ('api.openai.com', 443): raise AssertionError('unexpected destination')
                    self.endpoint = None
                def request(self, method, endpoint, body, headers):
                    if method != 'POST' or headers.get('Authorization') != 'Bearer sk-not-real': raise AssertionError('unexpected request')
                    self.endpoint = endpoint
                    requests.append((endpoint, json.loads(body)))
                def getresponse(self):
                    if self.endpoint.endswith('/input_tokens'):
                        return ProviderResponse(200, {'object': 'response.input_tokens', 'input_tokens': 200})
                    return ProviderResponse(200, {'id': f'resp_mock_{len(requests)}', 'status': 'completed', 'model': 'gpt-6-luna',
                        'service_tier': 'default', 'prompt_cache_options': {'mode': 'explicit'},
                        'usage': {'input_tokens': 200, 'output_tokens': 10, 'input_tokens_details': {'cached_tokens': 0, 'cache_write_tokens': 0}},
                        'output': [{'type': 'message', 'content': []}]})
                def close(self): pass
            with patch.object(adapter, 'EXPORTS', export_dir), patch.object(adapter, 'PLAN_FILE', export_dir / 'bounded-eval-request-plan.json'), \
                 patch.object(adapter, 'LIVE_LEDGER', ledger), patch.object(adapter.http.client, 'HTTPSConnection', FakeConnection), \
                 patch.object(adapter.ssl, 'create_default_context', return_value=object()), \
                 patch.dict(os.environ, {'OPENAI_API_KEY': 'sk-not-real'}, clear=True):
                result = adapter.run_live(execute=True, executor='mark', budget_usd='2.00', max_http=24, scenarios=8)
                self.assertEqual((result['status'], len(result['cases']), result['http_attempts']), ('completed', 8, 16))
                with self.assertRaises(ValueError):
                    adapter.run_live(execute=True, executor='mark', budget_usd='2.00', max_http=24, scenarios=8)
            self.assertEqual(len(requests), 16)
            self.assertEqual([path for path, _ in requests].count('/v1/responses/input_tokens'), 8)
            self.assertEqual([path for path, _ in requests].count('/v1/responses'), 8)
            with closing(sqlite3.connect(ledger)) as conn:
                self.assertEqual(conn.execute('SELECT count(*),sum(reserved_micro_usd) FROM http_attempts').fetchone(), (16, 651_200))
                self.assertEqual(conn.execute("SELECT count(*) FROM http_attempts WHERE status='completed'").fetchone()[0], 16)
            self.assertNotIn(b'sk-not-real', ledger.read_bytes())


if __name__ == '__main__': unittest.main()
