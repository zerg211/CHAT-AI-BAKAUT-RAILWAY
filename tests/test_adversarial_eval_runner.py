import json
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from contextlib import closing
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import adversarial_eval_runner as runner


class OfflineEvalRunnerTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.db = Path(self.tmp.name) / 'ledger.sqlite'
        runner.initialize(self.db)
        self.case_ids = [case['id'] for case in runner.cases()]
        self.posts = 0

    def tearDown(self):
        self.tmp.cleanup()

    def post(self, request):
        self.posts += 1
        runner.validate_request(request)
        return {'id': 'mock-response', 'model': runner.MODEL, 'service_tier': 'default', 'status': 'completed',
                'usage': {'input_tokens': 50, 'output_tokens': 10}, 'output': [{'type': 'message', 'content': []}]}

    def run_attempt(self, case_id, op):
        return runner.run_mock(self.db, case_id, op, lambda _: 100, self.post)

    def test_dry_run_is_offline_and_live_always_blocked(self):
        script = str(Path(runner.__file__))
        dry = subprocess.run([sys.executable, '-B', script], capture_output=True, text=True, encoding='utf-8')
        self.assertEqual(dry.returncode, 0, dry.stderr)
        plan = json.loads(dry.stdout)
        self.assertEqual((plan['mode'], plan['live'], plan['token_preflight'], len(plan['cases'])),
                         ('dry_run', 'BLOCKED', 'NOT_AVAILABLE', 8))
        live = subprocess.run([sys.executable, '-B', script, '--live'], capture_output=True, text=True, encoding='utf-8')
        self.assertNotEqual(live.returncode, 0)
        self.assertIn('BLOCKED', live.stderr)

    def test_no_tools_or_external_state_allowed_in_request(self):
        request = runner.make_request(runner.cases()[0])
        runner.validate_request(request)
        for patch in ({'tools': []}, {'service_tier': 'priority'}, {'model': 'other'}, {'truncation': 'auto'}, {'store': True}):
            with self.assertRaises(ValueError): runner.validate_request({**request, **patch})

    def test_request_contains_the_complete_local_dpu_cards_but_not_expected_answers(self):
        case = runner.cases()[0]
        request = runner.make_request(case)
        delivered = json.loads(request['input'][0]['content'])
        fixture = json.loads(runner.DPU_PATH.read_text(encoding='utf-8'))
        self.assertEqual(delivered['data']['original_cards'], [item['original'] for item in fixture['items']])
        self.assertEqual(delivered['data']['revision'], fixture['revision'])
        self.assertNotIn('expected', delivered)
        self.assertNotIn('tools', request)

    def test_oversize_and_unknown_token_count_are_blocked_before_post(self):
        for count in (100_001, -1, None, True, 1.5):
            with self.assertRaises(ValueError): runner.run_mock(self.db, self.case_ids[0], str(count), lambda _, value=count: value, self.post)
        self.assertEqual(self.posts, 0)
        with closing(sqlite3.connect(self.db)) as conn: self.assertEqual(conn.execute('SELECT count(*) FROM attempts').fetchone()[0], 0)

    def test_all_24_attempts_count_and_fourth_per_case_is_blocked(self):
        for case_id in self.case_ids:
            for n in range(3): self.run_attempt(case_id, f'{case_id}-{n}')
        with self.assertRaises(ValueError): self.run_attempt(self.case_ids[0], 'fourth')
        with closing(sqlite3.connect(self.db)) as conn:
            count, reserved = conn.execute('SELECT count(*),sum(reserved_micro_usd) FROM attempts').fetchone()
        self.assertEqual((count, reserved, self.posts), (24, 1_776_000, 24))

    def test_unknown_outcome_remains_reserved_and_blocks_fresh_attempt_after_restart(self):
        def unknown(_):
            with closing(sqlite3.connect(self.db)) as conn:
                self.assertEqual(conn.execute('SELECT status,reserved_micro_usd FROM attempts WHERE operation_id=?', ('once',)).fetchone(), ('attempted', 74_000))
            raise OSError('unknown transport result')
        with self.assertRaises(OSError): runner.run_mock(self.db, self.case_ids[0], 'once', lambda _: 100, unknown)
        for op in ('once', 'new-operation'):
            with self.assertRaises((ValueError, sqlite3.IntegrityError)): self.run_attempt(self.case_ids[0], op)
        with closing(sqlite3.connect(self.db)) as conn:
            self.assertEqual(conn.execute('SELECT status,reserved_micro_usd FROM attempts').fetchone(), ('unknown', 74_000))
        self.assertEqual(self.posts, 0)
        self.run_attempt(self.case_ids[1], 'other-case')
        with closing(sqlite3.connect(self.db)) as conn:
            self.assertEqual(conn.execute('SELECT sum(reserved_micro_usd) FROM attempts').fetchone()[0], 148_000)

    def test_crash_before_post_with_attempted_checkpoint_blocks_replay(self):
        with closing(sqlite3.connect(self.db)) as conn, conn:
            conn.execute('INSERT INTO attempts VALUES(?,?,?,?,?,?,NULL)', ('crash', self.case_ids[0], 'hash', 100, 74_000, 'attempted'))
        with self.assertRaises(ValueError): self.run_attempt(self.case_ids[0], 'different-id')
        self.assertEqual(self.posts, 0)

    def test_concurrent_owners_cannot_spend_same_operation_or_exceed_case_cap(self):
        def invoke(op):
            try:
                self.run_attempt(self.case_ids[0], op)
                return True
            except (ValueError, sqlite3.IntegrityError, sqlite3.OperationalError):
                return False
        with ThreadPoolExecutor(max_workers=8) as executor:
            result = list(executor.map(invoke, ['same'] * 8))
        self.assertEqual(sum(result), 1)
        with closing(sqlite3.connect(self.db)) as conn: self.assertEqual(conn.execute('SELECT count(*) FROM attempts').fetchone()[0], 1)

    def test_parallel_distinct_operations_still_respect_case_limit(self):
        def invoke(n):
            try:
                self.run_attempt(self.case_ids[0], f'op-{n}')
                return True
            except (ValueError, sqlite3.IntegrityError, sqlite3.OperationalError):
                return False
        with ThreadPoolExecutor(max_workers=12) as executor:
            completed = sum(executor.map(invoke, range(12)))
        with closing(sqlite3.connect(self.db)) as conn:
            count = conn.execute('SELECT count(*) FROM attempts WHERE case_id=?', (self.case_ids[0],)).fetchone()[0]
        self.assertEqual(count, completed)
        self.assertLessEqual(count, 3)

    def test_mismatched_tier_model_usage_or_tool_freezes_and_holds(self):
        for patch in ({'model': 'different'}, {'service_tier': 'priority'}, {'usage': {'input_tokens': 101, 'output_tokens': 10}},
                      {'output': [{'type': 'web_search_call'}]}):
            db = Path(self.tmp.name) / f'bad-{len(list(Path(self.tmp.name).glob("bad*")))}.sqlite'
            def bad(request): return {**self.post(request), **patch}
            with self.assertRaises(ValueError): runner.run_mock(db, self.case_ids[0], 'op', lambda _: 100, bad)
            with closing(sqlite3.connect(db)) as conn:
                self.assertEqual(conn.execute('SELECT status,reserved_micro_usd FROM attempts').fetchone(), ('unknown', 74_000))
                self.assertEqual(conn.execute('SELECT frozen FROM control').fetchone()[0], 1)
            with self.assertRaises(ValueError): runner.run_mock(db, self.case_ids[1], 'second', lambda _: 100, self.post)


if __name__ == '__main__':
    unittest.main()
