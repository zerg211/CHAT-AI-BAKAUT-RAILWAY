import concurrent.futures
import json
import sqlite3
import sys
import tempfile
import unittest
from contextlib import closing
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import bounded_live_eval_adapter as base
import bounded_eval_followup as follow


class FollowupTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.db = Path(self.tmp.name) / 'ledger.sqlite'
        base.initialize(self.db)
        with closing(sqlite3.connect(self.db)) as conn, conn:
            conn.execute("UPDATE control SET owner='mark:original'")
            for case in base._load_pinned_plan()['cases']:
                for kind in ('preflight', 'generation'):
                    full = case['provenance']['request_sha256']
                    body = case['preflight_body_sha256'] if kind == 'preflight' else full
                    response = {'id': 'resp_old_' + case['case_id']} if kind == 'generation' else {'input_tokens': 10}
                    conn.execute('INSERT INTO http_attempts VALUES(?,?,?,?,?,?,?,?,?)',
                                 (case['case_id'] + ':' + kind, 'mark:original', case['case_id'], kind,
                                  full, body, 0 if kind == 'preflight' else base.GENERATION_RESERVE_MICRO_USD,
                                  'completed', json.dumps(response)))
        self.plan = follow.load_plan()

    def rows(self):
        with closing(sqlite3.connect(self.db)) as conn:
            return conn.execute('SELECT * FROM http_attempts ORDER BY operation_id').fetchall()

    def test_four_cases_share_old_limits_and_preserve_receipts(self):
        original = self.rows()
        owner = 'mark:followup:test'
        follow.claim_followup(self.db, owner)
        calls = []
        def mock(endpoint, body):
            calls.append(endpoint)
            if endpoint.endswith('input_tokens'):
                return {'object': 'response.input_tokens', 'input_tokens': 100}
            return {'id': 'resp_new_' + str(len(calls)), 'status': 'completed', 'model': 'gpt-6-luna',
                    'service_tier': 'default', 'prompt_cache_options': {'mode': 'explicit'},
                    'usage': {'input_tokens': 50, 'output_tokens': 20,
                              'input_tokens_details': {'cached_tokens': 0, 'cache_write_tokens': 0}}, 'output': []}
        for case in self.plan['cases']:
            follow.run_case(self.db, owner, case, mock)
        rows = self.rows()
        self.assertEqual([r for r in rows if not r[0].startswith(follow.ROUND)], original)
        self.assertEqual((len(calls), len(rows), sum(r[6] for r in rows)), (8, 24, 976800))
        with self.assertRaises(ValueError):
            follow._call_once(self.db, owner, self.plan['cases'][0], 'preflight', mock)
        self.assertEqual(len(calls), 8)

    def test_unresolved_original_blocks_handoff(self):
        for status in ('unknown', 'attempted'):
            with closing(sqlite3.connect(self.db)) as conn, conn:
                conn.execute('UPDATE http_attempts SET status=? WHERE operation_id=(SELECT min(operation_id) FROM http_attempts)', (status,))
            with self.assertRaises(ValueError):
                follow.claim_followup(self.db, 'mark:followup:test')
            with closing(sqlite3.connect(self.db)) as conn:
                self.assertEqual(conn.execute('SELECT owner FROM control').fetchone()[0], 'mark:original')

    def test_only_one_claimant(self):
        def claim(n):
            try:
                follow.claim_followup(self.db, 'mark:followup:' + str(n))
                return True
            except ValueError:
                return False
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            self.assertEqual(sum(pool.map(claim, (1, 2))), 1)

    def test_unknown_result_freezes_without_retry(self):
        owner = 'mark:followup:test'
        follow.claim_followup(self.db, owner)
        calls = []
        def fail(endpoint, body):
            calls.append(endpoint)
            raise TimeoutError()
        with self.assertRaises(TimeoutError):
            follow.run_case(self.db, owner, self.plan['cases'][0], fail)
        with self.assertRaises(ValueError):
            follow.run_case(self.db, owner, self.plan['cases'][1], fail)
        self.assertEqual(len(calls), 1)

    def test_execution_requires_explicit_scope(self):
        with self.assertRaises(RuntimeError):
            follow.run_live()


if __name__ == '__main__':
    unittest.main()
