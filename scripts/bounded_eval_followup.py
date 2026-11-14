"""Four-case follow-up sharing the original fixed ledger; offline by default.

Only the designated executor may invoke the explicitly authorized CLI. No network
operation occurs on import, plan generation or ordinary test execution.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import sqlite3
import sys
import uuid
from contextlib import closing
from pathlib import Path
from typing import Any, Callable

import adversarial_eval_runner as fixtures
import bounded_live_eval_adapter as base

ROUND = 'semantic-followup-v1'
CASE_IDS = ('dpu6555_narrow_trench', 'lossless_raw_fields', 'unknown_capability', 'multi_category')
PER_CASE_TOTAL_LIMIT = 4  # two original HTTP calls plus this round's two; total remains 24.
EXPORT_HASHES = {
    'followup-runtime-shown-two.json': 'c34bc70b315cf03de9c60fc5891342e0b4d6c4c8f068835390bc68e055c72230',
    'followup-runtime-all-twelve.json': '590ad7fa0cbeefa94df41242756894dcb817a3938cc22745babf64b9b5f8bd4d'
}
PLAN_FILE = base.EXPORTS / 'semantic-followup-request-plan.json'
# Filled with the offline-generated review plan hash; it is checked before any live operation.
PINNED_PLAN_SHA256 = '655034168c299688d2cee26e3f17850a45e6266d024a5e892cc8be54a49127ad'


def load_export(filename: str) -> dict[str, Any]:
    if filename not in EXPORT_HASHES: raise ValueError('Unknown follow-up export')
    data = (base.EXPORTS / filename).read_bytes()
    if hashlib.sha256(data).hexdigest() != EXPORT_HASHES[filename]: raise ValueError('Follow-up export hash mismatch')
    artifact = json.loads(data)
    request = artifact['request']
    if artifact.get('live_provider') != 'NOT_RUN' or artifact.get('mock_context', {}).get('history_is_synthetic') is not True or \
       hashlib.sha256(json.dumps(request, ensure_ascii=False, separators=(',', ':')).encode('utf-8')).hexdigest() != artifact['runtime_request_sha256']:
        raise ValueError('Follow-up export invalid')
    return artifact


def validate_request(request: dict[str, Any]) -> None:
    allowed = {'model', 'instructions', 'reasoning', 'text', 'input', 'truncation', 'max_output_tokens',
               'service_tier', 'store', 'background', 'prompt_cache_options'}
    if set(request) != allowed or request.get('model') != 'gpt-6-luna' or request.get('service_tier') != 'default' or \
       request.get('store') is not False or request.get('background') is not False or request.get('truncation') != 'disabled' or \
       request.get('max_output_tokens') != 128_000 or request.get('reasoning') != {'effort': 'medium'} or \
       request.get('prompt_cache_options') != {'mode': 'explicit'} or not isinstance(request.get('instructions'), str) or \
       not isinstance(request.get('input'), list) or not request['input']:
        raise ValueError('Unsafe follow-up request')
    for item in request['input']:
        if not isinstance(item, dict) or set(item) != {'role', 'content'} or item['role'] not in ('user', 'assistant') or \
           not isinstance(item['content'], list) or any(not isinstance(part, dict) or set(part) != {'type', 'text'} or \
           part['type'] != 'input_text' or not isinstance(part['text'], str) for part in item['content']):
            raise ValueError('Unsafe follow-up input or cache breakpoint')
    expected = load_export('followup-runtime-shown-two.json')['request']['text']['format']
    actual = request.get('text', {}).get('format', {})
    if actual != expected or not {'comparison_ids', 'recommendation_status', 'answer_review'}.issubset(actual['schema']['required']) or \
       'publication' not in actual['schema']['properties']['answer_review']['required']:
        raise ValueError('Follow-up schema is not the current schema')


def build_case(case_id: str) -> dict[str, Any]:
    if case_id not in CASE_IDS: raise ValueError('Unknown follow-up case')
    fixture = next(item for item in fixtures.cases() if item['id'] == case_id)
    name = 'followup-runtime-shown-two.json' if case_id == CASE_IDS[0] else 'followup-runtime-all-twelve.json'
    artifact = load_export(name)
    source = artifact['request']
    request = {key: source[key] for key in ('model', 'instructions', 'reasoning', 'text', 'input', 'truncation', 'max_output_tokens')}
    request['instructions'] += '\nДля этой проверки внешние инструменты недоступны. Используй только предоставленные данные.'
    if case_id != CASE_IDS[0]:
        request['input'] = [{'role': 'user', 'content': [{'type': 'input_text',
            'text': base.canonical({'question': fixture['question'], 'data': fixture['context']})}]}]
    request.update(service_tier='default', store=False, background=False, prompt_cache_options={'mode': 'explicit'})
    validate_request(request)
    count_body = {key: request[key] for key in ('model', 'instructions', 'reasoning', 'text', 'input', 'truncation')}
    return {'case_id': case_id, 'generation_request': request, 'request_sha256': base.digest(request),
            'preflight_body': count_body, 'preflight_body_sha256': base.digest(count_body),
            'source_export': name, 'source_export_sha256': EXPORT_HASHES[name],
            'source_request_sha256': artifact['runtime_request_sha256'],
            'changes': ['removed tools', 'disabled store and background', 'explicit cache mode without breakpoints',
                        'added no-tools instruction'] + ([] if case_id == CASE_IDS[0] else ['replaced input with standalone case context']),
            'first_turn_history': 'SYNTHETIC', 'saved_agent_instructions': 'MOCK'}


def offline_plan() -> dict[str, Any]:
    return {'mode': 'offline_review_only', 'round': ROUND, 'actual_http_calls': 0, 'live_provider': 'NOT_RUN',
            'baseline_http_calls': 16, 'http_limit': 24, 'per_case_total_http_limit': PER_CASE_TOTAL_LIMIT,
            'budget_micro_usd': base.BUDGET_MICRO_USD, 'generation_reserve_micro_usd': base.GENERATION_RESERVE_MICRO_USD,
            'cases': [build_case(case_id) for case_id in CASE_IDS]}


def load_plan() -> dict[str, Any]:
    data = PLAN_FILE.read_bytes()
    if hashlib.sha256(data).hexdigest() != PINNED_PLAN_SHA256: raise ValueError('Follow-up plan hash mismatch')
    plan = json.loads(data)
    if plan != offline_plan(): raise ValueError('Follow-up plan differs from current source')
    return plan


def _original_rows_valid(conn: sqlite3.Connection) -> str:
    original_plan = base._load_pinned_plan()
    owner, frozen = conn.execute('SELECT owner,frozen FROM control WHERE id=1').fetchone()
    rows = conn.execute('SELECT operation_id,owner,case_id,kind,full_request_sha256,body_sha256,reserved_micro_usd,status FROM http_attempts').fetchall()
    if not isinstance(owner, str) or not owner.startswith('mark:') or frozen or len(rows) != 16:
        raise ValueError('Original ledger is not exactly complete')
    expected = {}
    for case in original_plan['cases']:
        for kind in ('preflight', 'generation'):
            full_hash = case['provenance']['request_sha256']
            expected[f"{case['case_id']}:{kind}"] = (case['case_id'], kind, full_hash,
                case['preflight_body_sha256'] if kind == 'preflight' else full_hash,
                0 if kind == 'preflight' else base.GENERATION_RESERVE_MICRO_USD)
    for operation, row_owner, case_id, kind, full_hash, body_hash, reserve, status in rows:
        if row_owner != owner or status != 'completed' or expected.pop(operation, None) != (case_id, kind, full_hash, body_hash, reserve):
            raise ValueError('Original ledger contains incomplete or changed attempts')
    if expected: raise ValueError('Original ledger is missing attempts')
    return owner


def claim_followup(db: Path, owner: str) -> None:
    if not owner.startswith('mark:followup:'): raise ValueError('Designated follow-up executor required')
    # Never create or replace a ledger in the follow-up path.
    if not db.is_file(): raise ValueError('Original ledger missing')
    with closing(sqlite3.connect(db, timeout=30, isolation_level=None)) as conn:
        conn.execute('PRAGMA synchronous=FULL')
        conn.execute('BEGIN IMMEDIATE')
        try:
            previous_owner = _original_rows_valid(conn)
            changed = conn.execute('UPDATE control SET owner=? WHERE id=1 AND owner=? AND frozen=0', (owner, previous_owner)).rowcount
            if changed != 1: raise ValueError('Ledger ownership changed concurrently')
            conn.execute('COMMIT')
        except BaseException:
            if conn.in_transaction: conn.execute('ROLLBACK')
            raise


def _reserve_followup(db: Path, owner: str, case: dict[str, Any], kind: str) -> str:
    case_id = case['case_id']
    if case_id not in CASE_IDS or kind not in ('preflight', 'generation'): raise ValueError('Invalid follow-up operation')
    operation = f'{ROUND}:{case_id}:{kind}'
    ceiling = 0 if kind == 'preflight' else base.GENERATION_RESERVE_MICRO_USD
    body_hash = case['preflight_body_sha256'] if kind == 'preflight' else case['request_sha256']
    with closing(sqlite3.connect(db, timeout=30, isolation_level=None)) as conn:
        conn.execute('PRAGMA synchronous=FULL')
        conn.execute('BEGIN IMMEDIATE')
        try:
            current, frozen = conn.execute('SELECT owner,frozen FROM control WHERE id=1').fetchone()
            total, held = conn.execute('SELECT count(*),coalesce(sum(reserved_micro_usd),0) FROM http_attempts').fetchone()
            per_case = conn.execute('SELECT count(*) FROM http_attempts WHERE case_id=?', (case_id,)).fetchone()[0]
            unresolved = conn.execute("SELECT count(*) FROM http_attempts WHERE status IN ('attempted','unknown')").fetchone()[0]
            if current != owner or frozen or unresolved or total >= base.HTTP_LIMIT or per_case >= PER_CASE_TOTAL_LIMIT or \
               held + ceiling > base.BUDGET_MICRO_USD:
                raise ValueError('Follow-up ledger, HTTP limit or budget blocks request')
            if kind == 'generation':
                prior = conn.execute('SELECT full_request_sha256,body_sha256,status,response_json FROM http_attempts WHERE operation_id=?',
                                     (f'{ROUND}:{case_id}:preflight',)).fetchone()
                if not prior or prior[0] != case['request_sha256'] or prior[1] != case['preflight_body_sha256'] or prior[2] != 'completed':
                    raise ValueError('Matching completed preflight required')
                count = json.loads(prior[3]).get('input_tokens')
                if type(count) is not int or not 0 <= count <= 100_000: raise ValueError('Preflight count invalid')
            conn.execute('INSERT INTO http_attempts VALUES(?,?,?,?,?,?,?,\'attempted\',NULL)',
                         (operation, owner, case_id, kind, case['request_sha256'], body_hash, ceiling))
            conn.execute('COMMIT')
        except BaseException:
            if conn.in_transaction: conn.execute('ROLLBACK')
            raise
    return operation


def _call_once(db: Path, owner: str, case: dict[str, Any], kind: str,
               transport: Callable[[str, dict[str, Any]], dict[str, Any]], max_input: int = 100_000) -> dict[str, Any]:
    request = case['generation_request']
    validate_request(request)
    expected_count = {key: request[key] for key in ('model', 'instructions', 'reasoning', 'text', 'input', 'truncation')}
    if base.digest(request) != case['request_sha256'] or expected_count != case['preflight_body'] or \
       base.digest(expected_count) != case['preflight_body_sha256']:
        raise ValueError('Follow-up request hash or preflight changed')
    operation = _reserve_followup(db, owner, case, kind)
    try:
        response = transport('/v1/responses/input_tokens' if kind == 'preflight' else '/v1/responses',
                             json.loads(base.canonical(expected_count if kind == 'preflight' else request)))
    except BaseException:
        base._finish(db, operation, {'outcome': 'unknown'}, False)
        raise
    if kind == 'preflight':
        valid = isinstance(response, dict) and response.get('object') == 'response.input_tokens' and type(response.get('input_tokens')) is int and response['input_tokens'] >= 0
    else:
        usage_value = response.get('usage') if isinstance(response, dict) else None
        usage = usage_value if isinstance(usage_value, dict) else {}
        detail_value = usage.get('input_tokens_details')
        details = detail_value if isinstance(detail_value, dict) else {}
        cache_value = response.get('prompt_cache_options') if isinstance(response, dict) else None
        cache = cache_value if isinstance(cache_value, dict) else {}
        valid = isinstance(response, dict) and isinstance(response.get('id'), str) and response['id'].startswith('resp_') and \
            response.get('status') == 'completed' and response.get('model') == 'gpt-6-luna' and response.get('service_tier') == 'default' and \
            cache.get('mode') == 'explicit' and type(usage.get('input_tokens')) is int and 0 <= usage['input_tokens'] <= max_input and \
            type(usage.get('output_tokens')) is int and 0 <= usage['output_tokens'] <= 128_000 and \
            type(details.get('cached_tokens')) is int and details['cached_tokens'] == 0 and \
            type(details.get('cache_write_tokens')) is int and details['cache_write_tokens'] == 0 and \
            isinstance(response.get('output'), list) and all(isinstance(item, dict) and item.get('type') in ('message', 'reasoning') for item in response['output'])
    valid = base._finish(db, operation, response, bool(valid))
    if not valid: raise ValueError('Unverified follow-up response; ledger frozen and reservation held')
    return response


def run_case(db: Path, owner: str, case: dict[str, Any], transport: Callable[[str, dict[str, Any]], dict[str, Any]]) -> None:
    counted = _call_once(db, owner, case, 'preflight', transport)
    if counted['input_tokens'] > 100_000: raise ValueError('Input over 100000 tokens; no generation')
    _call_once(db, owner, case, 'generation', transport, max_input=counted['input_tokens'])


def run_live(*, execute: bool = False, executor: str = '', budget_usd: str = '', max_total_http: int = 0,
             scenarios: int = 0, round_id: str = '') -> dict[str, Any]:
    if not execute or executor != 'mark' or budget_usd != '2.00' or max_total_http != 24 or scenarios != 4 or round_id != ROUND:
        raise RuntimeError('BLOCKED: explicit follow-up scope and designated executor required')
    if os.environ.get('SSL_CERT_FILE') or os.environ.get('SSL_CERT_DIR'): raise RuntimeError('BLOCKED: custom TLS trust is not allowed')
    plan = load_plan()
    ledger = base.LIVE_LEDGER
    components = [base.ROOT / '.agent', base.ROOT / '.agent/tasks', base.ROOT / '.agent/tasks/full-cards-availability-20261112', base.EXPORTS]
    if any(component.is_symlink() or component.is_junction() for component in components) or ledger.is_symlink() or ledger.is_junction() or \
       ledger.resolve().parent != base.EXPORTS.resolve() or not ledger.is_file() or ledger.stat().st_nlink != 1:
        raise RuntimeError('BLOCKED: original fixed ledger unavailable or unsafe')
    key = base.read_api_key()
    transport = base.LiteralOpenAITransport(key)
    owner = f'mark:followup:{uuid.uuid4()}'
    claim_followup(ledger, owner)
    completed = []
    for case in plan['cases']:
        run_case(ledger, owner, case, transport)
        completed.append(case['case_id'])
    return {'status': 'completed', 'round': ROUND, 'cases': completed, 'additional_http_attempts': len(completed) * 2,
            'total_http_limit': base.HTTP_LIMIT, 'ledger': str(ledger), 'quality': 'NOT_YET_REVIEWED'}


def main() -> None:
    parser = argparse.ArgumentParser(description='Four-case follow-up; offline by default.')
    parser.add_argument('--execute', action='store_true')
    parser.add_argument('--executor', default='')
    parser.add_argument('--budget-usd', default='')
    parser.add_argument('--max-total-http', type=int, default=0)
    parser.add_argument('--scenarios', type=int, default=0)
    parser.add_argument('--round', default='')
    args = parser.parse_args()
    if not args.execute:
        print(json.dumps({'mode': 'offline', 'round': ROUND, 'live_calls': 0, 'cases': len(CASE_IDS)}))
        return
    try:
        result = run_live(execute=True, executor=args.executor, budget_usd=args.budget_usd,
                          max_total_http=args.max_total_http, scenarios=args.scenarios, round_id=args.round)
    except Exception:
        print('STOP: follow-up is blocked or failed; inspect the original fixed ledger without retrying.', file=sys.stderr)
        raise SystemExit(1)
    print(json.dumps(result, ensure_ascii=False))


if __name__ == '__main__': main()
