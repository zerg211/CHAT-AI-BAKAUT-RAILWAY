import json
import sqlite3
import sys
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import bounded_live_eval_adapter as adapter
import adversarial_eval_runner as fixtures


class BoundedLiveAdapterMockTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.db = Path(self.tmp.name) / 'ledger.sqlite'
        adapter.claim_owner(self.db, 'only-owner')
        self.cases = [item['id'] for item in fixtures.cases()]
        self.requests = []

    def tearDown(self):
        self.tmp.cleanup()

    def transport(self, endpoint, body):
        with closing(sqlite3.connect(self.db)) as conn:
            self.assertEqual(conn.execute("SELECT count(*) FROM http_attempts WHERE status='attempted'").fetchone()[0], 1)
        self.requests.append((endpoint, body))
        if endpoint.endswith('/input_tokens'):
            return {'object': 'response.input_tokens', 'input_tokens': 200}
        return {'id': f'resp_mock_{len(self.requests)}', 'status': 'completed', 'model': 'gpt-6-luna', 'service_tier': 'default',
                'prompt_cache_options': {'mode': 'explicit'}, 'usage': {'input_tokens': 200, 'output_tokens': 10,
                'input_tokens_details': {'cached_tokens': 0, 'cache_write_tokens': 0}},
                'output': [{'type': 'message', 'content': []}]}

    def test_all_eight_requests_use_current_schema_without_tools_and_record_changes(self):
        for case_id in self.cases:
            request, provenance = adapter.build_request(case_id)
            adapter.validate_request(request)
            self.assertEqual(request['prompt_cache_options'], {'mode': 'explicit'})
            self.assertFalse(request['store'])
            self.assertFalse(request['background'])
            self.assertNotIn('tools', request)
            self.assertEqual(request['service_tier'], 'default')
            self.assertIn('answer_review', request['text']['format']['schema']['required'])
            self.assertIn('web_search_intent', request['text']['format']['schema']['required'])
            self.assertEqual(provenance['request_sha256'], adapter.digest(request))
            self.assertEqual(provenance['saved_agent_instructions'], 'MOCK')
            self.assertIn('removed tools', provenance['changes'])

    def test_real_entrypoint_is_unconditionally_blocked_before_any_transport(self):
        with self.assertRaisesRegex(RuntimeError, 'BLOCKED'): adapter.run_live()
        self.assertEqual(self.requests, [])
        self.assertEqual(adapter.VERIFIED_PREFLIGHT_MAX_MICRO_USD, 0)

    def test_dpu_followup_questions_are_kept_exactly_as_exported(self):
        for case_id, phrase in [(self.cases[0], 'между ними'), (self.cases[1], 'все известные модификации')]:
            request, provenance = adapter.build_request(case_id)
            self.assertIn(phrase, request['input'][-1]['content'][0]['text'])
            self.assertNotIn('replaced input with standalone case context', provenance['changes'])

    def test_offline_plan_exposes_all_exact_bodies_and_hashes_without_http(self):
        plan = adapter.offline_plan()
        self.assertEqual((plan['mode'], plan['actual_http_calls'], len(plan['cases'])), ('offline_review_only', 0, 8))
        for case in plan['cases']:
            self.assertEqual(case['preflight_body_sha256'], adapter.digest(case['preflight_body']))
            self.assertEqual(case['provenance']['request_sha256'], adapter.digest(case['generation_request']))
            self.assertNotIn('tools', case['generation_request'])
        self.assertEqual(self.requests, [])

    def test_mock_pair_counts_both_http_calls_and_reserves_before_each(self):
        result = adapter.run_case(self.db, 'only-owner', self.cases[0], 100, self.transport)
        self.assertEqual(result['input_tokens'], 200)
        self.assertEqual([endpoint for endpoint, _ in self.requests], ['/v1/responses/input_tokens', '/v1/responses'])
        with closing(sqlite3.connect(self.db)) as conn:
            rows = conn.execute('SELECT kind,full_request_sha256,body_sha256,reserved_micro_usd,status FROM http_attempts ORDER BY rowid').fetchall()
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[0][0], 'preflight')
        self.assertEqual(rows[1][0], 'generation')
        self.assertEqual(rows[0][1], rows[1][1])
        self.assertNotEqual(rows[0][2], rows[1][2])
        self.assertEqual((rows[0][3], rows[1][3]), (100, 81_400))
        self.assertTrue(all(row[4] == 'completed' for row in rows))

    def test_eight_mock_cases_use_sixteen_total_http_attempts(self):
        for case_id in self.cases:
            adapter.run_case(self.db, 'only-owner', case_id, adapter.VERIFIED_PREFLIGHT_MAX_MICRO_USD, self.transport)
        with closing(sqlite3.connect(self.db)) as conn:
            count, held = conn.execute('SELECT count(*),sum(reserved_micro_usd) FROM http_attempts').fetchone()
        self.assertEqual((count, held, len(self.requests)), (16, 8 * 81_400, 16))

    def test_duplicate_generation_receipt_freezes_ledger(self):
        def duplicate(endpoint, body):
            result = self.transport(endpoint, body)
            if not endpoint.endswith('/input_tokens'): result['id'] = 'resp_duplicate'
            return result
        adapter.run_case(self.db, 'only-owner', self.cases[0], 0, duplicate)
        with self.assertRaises(ValueError): adapter.run_case(self.db, 'only-owner', self.cases[1], 0, duplicate)
        with closing(sqlite3.connect(self.db)) as conn:
            self.assertEqual(conn.execute('SELECT frozen FROM control').fetchone()[0], 1)

    def test_unknown_preflight_price_or_too_large_input_prevents_generation(self):
        with self.assertRaisesRegex(ValueError, 'Unverified request cost'):
            adapter.run_case(self.db, 'only-owner', self.cases[0], None, self.transport)
        self.assertEqual(self.requests, [])
        def oversized(endpoint, body):
            self.requests.append((endpoint, body))
            return {'object': 'response.input_tokens', 'input_tokens': 100_001}
        with self.assertRaisesRegex(ValueError, 'over 100000'):
            adapter.run_case(self.db, 'only-owner', self.cases[0], 100, oversized)
        self.assertEqual([path for path, _ in self.requests], ['/v1/responses/input_tokens'])

    def test_unknown_http_outcome_freezes_every_case_and_retains_reservation(self):
        def unknown(_endpoint, _body): raise OSError('unknown')
        with self.assertRaises(OSError): adapter.run_case(self.db, 'only-owner', self.cases[0], 200, unknown)
        with closing(sqlite3.connect(self.db)) as conn:
            self.assertEqual(conn.execute('SELECT kind,status,reserved_micro_usd FROM http_attempts').fetchall(), [('preflight', 'unknown', 200)])
            self.assertEqual(conn.execute('SELECT frozen FROM control').fetchone()[0], 1)
        with self.assertRaises(ValueError): adapter.run_case(self.db, 'only-owner', self.cases[1], 200, self.transport)
        self.assertEqual(self.requests, [])

    def test_crashed_attempt_blocks_all_new_http(self):
        request, _ = adapter.build_request(self.cases[0])
        adapter._reserve(self.db, 'only-owner', self.cases[0], 'preflight', adapter.digest(request), 'hash', 5)
        with self.assertRaises(ValueError): adapter.run_case(self.db, 'only-owner', self.cases[1], 5, self.transport)
        self.assertEqual(self.requests, [])

    def test_wrong_model_tier_cache_usage_or_hidden_tool_freezes(self):
        cases = [
            {'model': 'snapshot-not-allowlisted'}, {'service_tier': 'priority'}, {'prompt_cache_options': {'mode': 'implicit'}},
            {'usage': {'input_tokens': 201, 'output_tokens': 1, 'input_tokens_details': {'cached_tokens': 0, 'cache_write_tokens': 0}}},
            {'usage': {'input_tokens': 10, 'output_tokens': 1, 'input_tokens_details': {}}},
            {'output': [{'type': 'web_search_call'}]}
        ]
        for index, patch in enumerate(cases):
            db = Path(self.tmp.name) / f'bad-{index}.sqlite'
            adapter.claim_owner(db, 'owner')
            def invalid(endpoint, body):
                if endpoint.endswith('/input_tokens'): return {'object': 'response.input_tokens', 'input_tokens': 200}
                response = {'id': 'resp_mock', 'status': 'completed', 'model': 'gpt-6-luna', 'service_tier': 'default',
                            'prompt_cache_options': {'mode': 'explicit'}, 'usage': {'input_tokens': 200, 'output_tokens': 10,
                            'input_tokens_details': {'cached_tokens': 0, 'cache_write_tokens': 0}}, 'output': [{'type': 'message'}]}
                return {**response, **patch}
            with self.assertRaises(ValueError): adapter.run_case(db, 'owner', self.cases[0], 1, invalid)
            with closing(sqlite3.connect(db)) as conn:
                self.assertEqual(conn.execute('SELECT frozen FROM control').fetchone()[0], 1)
                self.assertEqual(conn.execute("SELECT status FROM http_attempts WHERE kind='generation'").fetchone()[0], 'unknown')

    def test_one_owner_is_atomic_under_concurrency(self):
        db = Path(self.tmp.name) / 'owners.sqlite'
        adapter.initialize(db)
        def claim(n):
            try: adapter.claim_owner(db, f'owner-{n}'); return True
            except (ValueError, sqlite3.OperationalError): return False
        with ThreadPoolExecutor(max_workers=8) as executor:
            self.assertEqual(sum(executor.map(claim, range(8))), 1)

    def test_all_http_attempts_and_case_attempts_are_counted(self):
        with closing(sqlite3.connect(self.db)) as conn, conn:
            for index in range(24):
                conn.execute('INSERT INTO http_attempts VALUES(?,?,?,?,?,?,?,?,NULL)',
                             (f'other-{index}', 'only-owner', f'other-{index}', 'preflight', 'h', 'h', 1, 'completed'))
        with self.assertRaises(ValueError): adapter.run_case(self.db, 'only-owner', self.cases[0], 1, self.transport)
        self.assertEqual(self.requests, [])
        other = Path(self.tmp.name) / 'per-case.sqlite'
        adapter.claim_owner(other, 'owner')
        with closing(sqlite3.connect(other)) as conn, conn:
            for index in range(3):
                conn.execute('INSERT INTO http_attempts VALUES(?,?,?,?,?,?,?,?,NULL)',
                             (f'case-{index}', 'owner', self.cases[0], 'preflight', 'h', 'h', 1, 'completed'))
        with self.assertRaises(ValueError): adapter.run_case(other, 'owner', self.cases[0], 1, self.transport)

    def test_input_or_tools_tampering_rejected_before_transport(self):
        request, _ = adapter.build_request(self.cases[0])
        with self.assertRaises(ValueError): adapter.validate_request({**request, 'tools': []})
        with self.assertRaises(ValueError): adapter._call_once(self.db, 'only-owner', self.cases[0], 'preflight', request,
            {'model': 'wrong'}, 1, self.transport)
        self.assertEqual(self.requests, [])


if __name__ == '__main__': unittest.main()
