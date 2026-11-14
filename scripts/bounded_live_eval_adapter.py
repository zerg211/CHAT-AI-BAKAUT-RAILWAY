"""Single-ledger, explicitly authorized Responses evaluation; dry-run by default.

No call is made on import or without all explicit CLI authorization arguments.
The designated executor must independently review the transport before use.
"""
from __future__ import annotations

import hashlib
import argparse
import http.client
import json
import os
import re
import sqlite3
import ssl
import sys
import uuid
from contextlib import closing
from pathlib import Path
from typing import Any, Callable

import adversarial_eval_runner as fixtures

ROOT = Path(__file__).resolve().parents[1]
EXPORTS = ROOT / '.agent/tasks/full-cards-availability-20261112/raw'
LIVE_LEDGER = EXPORTS / 'bounded-live-ledger.sqlite'
PLAN_FILE = EXPORTS / 'bounded-eval-request-plan.json'
PINNED_PLAN_SHA256 = '5ba6fc8b2dc9868af7be2464f189cbc8d50ee14574ca06c16f8ca5cd28b2d380'
PINNED_EXPORTS = {
    'dpu-runtime-request.json': '27ce676f69edc301e0546fb2dd9df512229d9724370bafae66bb5b40b24561bb',
    'dpu-runtime-request-all-twelve.json': '7cf5f7b4ce6fc72f3617ccbcb4969321d4887302292d1293f2cef2cb0d97403c'
}
HTTP_LIMIT = 24
CASE_HTTP_LIMIT = 3
BUDGET_MICRO_USD = 2_000_000
# Conservative conditional reservation: 100k input + 128k output at Standard,
# plus 10% regional uplift, with caching disabled. Not proof of actual charges.
GENERATION_RESERVE_MICRO_USD = 81_400
# OpenAI's official Help Center states this endpoint is free (recheck before use).
VERIFIED_PREFLIGHT_MAX_MICRO_USD = 0


def canonical(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'))


def digest(value: Any) -> str:
    return hashlib.sha256(canonical(value).encode('utf-8')).hexdigest()


def load_export(filename: str) -> dict[str, Any]:
    if filename not in PINNED_EXPORTS:
        raise ValueError('Unknown runtime export')
    data = (EXPORTS / filename).read_bytes()
    if hashlib.sha256(data).hexdigest() != PINNED_EXPORTS[filename]:
        raise ValueError('Runtime export file hash mismatch')
    return json.loads(data)


def build_request(case_id: str) -> tuple[dict[str, Any], dict[str, Any]]:
    case = next((item for item in fixtures.cases() if item['id'] == case_id), None)
    if case is None:
        raise ValueError('Unknown case')
    filename = 'dpu-runtime-request.json' if case_id == 'dpu6555_narrow_trench' else 'dpu-runtime-request-all-twelve.json'
    artifact = load_export(filename)
    if artifact.get('live_provider') != 'NOT_RUN' or artifact.get('mock_context', {}).get('history_is_synthetic') is not True:
        raise ValueError('Untrusted runtime export')
    source = artifact['request']
    if hashlib.sha256(json.dumps(source, ensure_ascii=False, separators=(',', ':')).encode('utf-8')).hexdigest() != artifact['runtime_request_sha256']:
        raise ValueError('Runtime request hash mismatch')
    # The actual exported object contains tools, stored/background execution and
    # synthetic saved-agent instructions. Remove tools and record every change.
    request = {key: source[key] for key in ('model', 'instructions', 'reasoning', 'text', 'input', 'truncation', 'max_output_tokens')}
    request['instructions'] += '\nДля этой проверки внешние инструменты недоступны. Используй только предоставленные данные.'
    dpu_case = case_id in ('dpu6555_narrow_trench', 'complete_modification_comparison')
    if not dpu_case:
        request['input'] = [{'role': 'user', 'content': [{'type': 'input_text',
            'text': canonical({'question': case['question'], 'data': case['context']})}]}]
    request.update(service_tier='default', store=False, background=False, prompt_cache_options={'mode': 'explicit'})
    validate_request(request)
    return request, {'source_export_sha256': hashlib.sha256((EXPORTS / filename).read_bytes()).hexdigest(),
        'source_request_sha256': artifact['runtime_request_sha256'], 'request_sha256': digest(request),
        'changes': ['removed tools', 'disabled store and background', 'explicit cache mode without breakpoints',
                    'added no-tools instruction'] + ([] if dpu_case else ['replaced input with standalone case context']),
        'saved_agent_instructions': 'MOCK', 'first_turn_history': 'SYNTHETIC', 'quality': 'NOT_RUN'}


def validate_request(request: dict[str, Any]) -> None:
    allowed = {'model', 'instructions', 'reasoning', 'text', 'input', 'truncation', 'max_output_tokens',
               'service_tier', 'store', 'background', 'prompt_cache_options'}
    if set(request) != allowed or request.get('model') != 'gpt-6-luna' or request.get('service_tier') != 'default' or \
       request.get('store') is not False or request.get('background') is not False or \
       request.get('truncation') != 'disabled' or request.get('max_output_tokens') != 128_000 or \
       request.get('prompt_cache_options') != {'mode': 'explicit'} or request.get('reasoning') != {'effort': 'medium'} or \
       not isinstance(request.get('instructions'), str) or \
       not isinstance(request.get('input'), list) or not request['input']:
        raise ValueError('Unsafe provider request')
    for item in request['input']:
        if not isinstance(item, dict) or set(item) != {'role', 'content'} or item['role'] not in ('user', 'assistant') or \
           not isinstance(item['content'], list) or any(not isinstance(part, dict) or set(part) != {'type', 'text'} or
           part['type'] != 'input_text' or not isinstance(part['text'], str) for part in item['content']):
            raise ValueError('Unsafe request input or cache breakpoint')
    format_ = request.get('text', {}).get('format', {})
    expected_format = load_export('dpu-runtime-request.json')['request']['text']['format']
    if format_ != expected_format or format_.get('type') != 'json_schema' or format_.get('strict') is not True or \
       not {'answer_review', 'web_search_intent', 'availability'}.issubset(format_.get('schema', {}).get('required', [])):
        raise ValueError('Current response schema missing')


def initialize(db: Path) -> None:
    with closing(sqlite3.connect(db, timeout=30)) as conn, conn:
        conn.execute('PRAGMA journal_mode=WAL')
        conn.execute('PRAGMA synchronous=FULL')
        conn.execute('CREATE TABLE IF NOT EXISTS control (id INTEGER PRIMARY KEY CHECK(id=1), owner TEXT, frozen INTEGER NOT NULL)')
        conn.execute('INSERT OR IGNORE INTO control VALUES(1,NULL,0)')
        conn.execute('''CREATE TABLE IF NOT EXISTS http_attempts (
          operation_id TEXT PRIMARY KEY, owner TEXT NOT NULL, case_id TEXT NOT NULL, kind TEXT NOT NULL,
          full_request_sha256 TEXT NOT NULL, body_sha256 TEXT NOT NULL, reserved_micro_usd INTEGER NOT NULL,
          status TEXT NOT NULL, response_json TEXT)''')


def claim_owner(db: Path, owner: str) -> None:
    if not owner:
        raise ValueError('Executor identity is required')
    initialize(db)
    with closing(sqlite3.connect(db, timeout=30, isolation_level=None)) as conn:
        conn.execute('BEGIN IMMEDIATE')
        current, frozen = conn.execute('SELECT owner,frozen FROM control WHERE id=1').fetchone()
        if frozen or current is not None:
            conn.execute('ROLLBACK')
            raise ValueError('Another executor owns the ledger or it is frozen')
        conn.execute('UPDATE control SET owner=? WHERE id=1', (owner,))
        conn.execute('COMMIT')


def _reserve(db: Path, owner: str, case_id: str, kind: str, full_hash: str, body_hash: str, ceiling: int) -> str:
    if kind not in ('preflight', 'generation') or type(ceiling) is not int or ceiling < 0:
        raise ValueError('Unverified request cost')
    operation = f'{case_id}:{kind}'
    with closing(sqlite3.connect(db, timeout=30, isolation_level=None)) as conn:
        conn.execute('PRAGMA synchronous=FULL')
        conn.execute('BEGIN IMMEDIATE')
        try:
            current, frozen = conn.execute('SELECT owner,frozen FROM control WHERE id=1').fetchone()
            count, held = conn.execute('SELECT count(*),coalesce(sum(reserved_micro_usd),0) FROM http_attempts').fetchone()
            per_case = conn.execute('SELECT count(*) FROM http_attempts WHERE case_id=?', (case_id,)).fetchone()[0]
            unknown = conn.execute("SELECT count(*) FROM http_attempts WHERE status IN ('attempted','unknown')").fetchone()[0]
            if current != owner or frozen or unknown or count >= HTTP_LIMIT or per_case >= CASE_HTTP_LIMIT or held + ceiling > BUDGET_MICRO_USD:
                raise ValueError('Executor, HTTP limit, budget or unresolved outcome blocks request')
            conn.execute('INSERT INTO http_attempts VALUES(?,?,?,?,?,?,?,\'attempted\',NULL)',
                         (operation, owner, case_id, kind, full_hash, body_hash, ceiling))
            conn.execute('COMMIT')
        except BaseException:
            if conn.in_transaction: conn.execute('ROLLBACK')
            raise
    return operation


def _finish(db: Path, operation: str, response: Any, valid: bool) -> bool:
    with closing(sqlite3.connect(db, timeout=30)) as conn, conn:
        conn.execute('PRAGMA synchronous=FULL')
        conn.execute('BEGIN IMMEDIATE')
        kind = conn.execute('SELECT kind FROM http_attempts WHERE operation_id=? AND status=\'attempted\'', (operation,)).fetchone()
        if not kind: raise ValueError('HTTP attempt identity missing')
        if valid and kind[0] == 'generation':
            prior = conn.execute("SELECT response_json FROM http_attempts WHERE kind='generation' AND status='completed'").fetchall()
            if any(json.loads(row[0]).get('id') == response.get('id') for row in prior): valid = False
        conn.execute('UPDATE http_attempts SET status=?,response_json=? WHERE operation_id=? AND status=\'attempted\'',
                     ('completed' if valid else 'unknown', canonical(response), operation))
        if not valid: conn.execute('UPDATE control SET frozen=1 WHERE id=1')
    return valid


def _call_once(db: Path, owner: str, case_id: str, kind: str, full_request: dict[str, Any],
               body: dict[str, Any], ceiling: int, transport: Callable[[str, dict[str, Any]], dict[str, Any]],
               max_input: int = 100_000) -> dict[str, Any]:
    validate_request(full_request)
    expected = {key: full_request[key] for key in ('model', 'instructions', 'reasoning', 'text', 'input', 'truncation')} if kind == 'preflight' else full_request
    if body != expected:
        raise ValueError('Preflight or generation request differs from frozen request')
    operation = _reserve(db, owner, case_id, kind, digest(full_request), digest(body), ceiling)
    try:
        response = transport('/v1/responses/input_tokens' if kind == 'preflight' else '/v1/responses', json.loads(canonical(body)))
    except BaseException:
        _finish(db, operation, {'outcome': 'unknown'}, False)
        raise
    if kind == 'preflight':
        valid = isinstance(response, dict) and response.get('object') == 'response.input_tokens' and type(response.get('input_tokens')) is int and response['input_tokens'] >= 0
    else:
        usage_value = response.get('usage') if isinstance(response, dict) else None
        usage = usage_value if isinstance(usage_value, dict) else {}
        details_value = usage.get('input_tokens_details')
        details = details_value if isinstance(details_value, dict) else {}
        cache_value = response.get('prompt_cache_options') if isinstance(response, dict) else None
        cache = cache_value if isinstance(cache_value, dict) else {}
        valid = isinstance(response, dict) and isinstance(response.get('id'), str) and response['id'].startswith('resp_') and response.get('status') == 'completed' and \
            response.get('model') == 'gpt-6-luna' and response.get('service_tier') == 'default' and \
            cache.get('mode') == 'explicit' and \
            type(usage.get('input_tokens')) is int and 0 <= usage['input_tokens'] <= max_input and \
            type(usage.get('output_tokens')) is int and 0 <= usage['output_tokens'] <= 128_000 and \
            type(details.get('cached_tokens')) is int and details['cached_tokens'] == 0 and \
            type(details.get('cache_write_tokens')) is int and details['cache_write_tokens'] == 0 and \
            isinstance(response.get('output'), list) and all(isinstance(item, dict) and item.get('type') in ('message', 'reasoning') for item in response['output'])
    valid = _finish(db, operation, response, bool(valid))
    if not valid: raise ValueError('Unverified response; ledger frozen and reservation held')
    return response


def run_case(db: Path, owner: str, case_id: str, preflight_ceiling: int,
             transport: Callable[[str, dict[str, Any]], dict[str, Any]],
             pinned_case: dict[str, Any] | None = None) -> dict[str, Any]:
    """Execute one reserved preflight/generation pair without retrying."""
    request, provenance = build_request(case_id)
    validate_request(request)
    count_body = {key: request[key] for key in ('model', 'instructions', 'reasoning', 'text', 'input', 'truncation')}
    if pinned_case is not None and (pinned_case.get('case_id') != case_id or pinned_case.get('generation_request') != request or
                                    pinned_case.get('preflight_body') != count_body or pinned_case.get('provenance') != provenance):
        raise ValueError('Prepared request no longer matches the pinned review plan')
    counted = _call_once(db, owner, case_id, 'preflight', request, count_body, preflight_ceiling, transport)
    if counted['input_tokens'] > 100_000:
        raise ValueError('Input over 100000 tokens; generation not submitted')
    result = _call_once(db, owner, case_id, 'generation', request, request, GENERATION_RESERVE_MICRO_USD, transport,
                        max_input=counted['input_tokens'])
    return {'provenance': provenance, 'response': result, 'input_tokens': counted['input_tokens']}


def offline_plan() -> dict[str, Any]:
    """Build a reviewable plan without reading credentials, opening a DB or making HTTP calls."""
    planned = []
    for case in fixtures.cases():
        request, provenance = build_request(case['id'])
        count_body = {key: request[key] for key in ('model', 'instructions', 'reasoning', 'text', 'input', 'truncation')}
        planned.append({'case_id': case['id'], 'preflight_body_sha256': digest(count_body),
                        'preflight_body': count_body, 'generation_request': request, 'provenance': provenance})
    return {'mode': 'offline_review_only', 'actual_http_calls': 0, 'live_provider': 'NOT_RUN',
            'preflight_price_micro_usd': VERIFIED_PREFLIGHT_MAX_MICRO_USD, 'http_limit': HTTP_LIMIT,
            'per_case_http_limit': CASE_HTTP_LIMIT, 'budget_micro_usd': BUDGET_MICRO_USD,
            'generation_reserve_micro_usd': GENERATION_RESERVE_MICRO_USD, 'cases': planned}


def read_api_key(environment: dict[str, str] | None = None, env_file: Path | None = None) -> str:
    """Read only OPENAI_API_KEY, never parse or export other dotenv entries."""
    env = os.environ if environment is None else environment
    key = env.get('OPENAI_API_KEY', '').strip()
    source = ROOT / '.env' if env_file is None else env_file
    if not key and source.is_file():
        if source.stat().st_size > 1_048_576: raise ValueError('Credential source is invalid')
        found = []
        for line in source.read_text(encoding='utf-8-sig').splitlines():
            match = re.fullmatch(r'\s*(?:export\s+)?OPENAI_API_KEY\s*=\s*(.*?)\s*', line)
            if match: found.append(match.group(1))
        if len(found) > 1: raise ValueError('Credential source is ambiguous')
        if found:
            key = found[0]
            if len(key) >= 2 and key[0] == key[-1] and key[0] in ('"', "'"): key = key[1:-1]
    if not key.startswith('sk-') or any(not 33 <= ord(character) <= 126 for character in key) or '${' in key:
        raise ValueError('OPENAI_API_KEY unavailable or invalid')
    return key


class LiteralOpenAITransport:
    """One HTTPS POST per call, no proxy, redirects or automatic retries."""
    def __init__(self, key: str):
        if not key or any(character.isspace() for character in key): raise ValueError('Credential is invalid')
        self.__key = key

    def __call__(self, endpoint: str, body: dict[str, Any]) -> dict[str, Any]:
        if endpoint not in ('/v1/responses/input_tokens', '/v1/responses'):
            raise ValueError('Endpoint is not allowed')
        payload = canonical(body).encode('utf-8')
        connection = http.client.HTTPSConnection('api.openai.com', port=443, timeout=120, context=ssl.create_default_context())
        try:
            connection.request('POST', endpoint, body=payload, headers={
                'Authorization': 'Bearer ' + self.__key, 'Content-Type': 'application/json', 'Accept': 'application/json'})
            response = connection.getresponse()
            if response.status != 200:
                raise RuntimeError('Provider response not accepted; outcome unknown')
            data = response.read(16_000_001)
            if len(data) > 16_000_000 or self.__key.encode('utf-8') in data:
                raise RuntimeError('Provider response is unsafe; outcome unknown')
            parsed = json.loads(data)
            if not isinstance(parsed, dict): raise RuntimeError('Provider response is invalid; outcome unknown')
            return parsed
        finally:
            connection.close()


def _load_pinned_plan() -> dict[str, Any]:
    data = PLAN_FILE.read_bytes()
    if hashlib.sha256(data).hexdigest() != PINNED_PLAN_SHA256: raise ValueError('Review plan hash mismatch')
    plan = json.loads(data)
    if plan != offline_plan(): raise ValueError('Review plan does not match current source and fixtures')
    if len(plan['cases']) != 8 or len({case['case_id'] for case in plan['cases']}) != 8:
        raise ValueError('Invalid review plan case count')
    return plan


def run_live(*, execute: bool = False, executor: str = '', budget_usd: str = '', max_http: int = 0, scenarios: int = 0) -> dict[str, Any]:
    """Run once only after explicit CLI scope confirmation by the designated executor."""
    if not execute or executor != 'mark' or budget_usd != '2.00' or max_http != 24 or scenarios != 8:
        raise RuntimeError('BLOCKED: explicit authorized scope and designated executor are required')
    if VERIFIED_PREFLIGHT_MAX_MICRO_USD != 0 or BUDGET_MICRO_USD != 2_000_000 or HTTP_LIMIT != 24 or CASE_HTTP_LIMIT != 3:
        raise RuntimeError('BLOCKED: verified budget contract changed')
    if 8 * GENERATION_RESERVE_MICRO_USD + 8 * VERIFIED_PREFLIGHT_MAX_MICRO_USD > BUDGET_MICRO_USD:
        raise RuntimeError('BLOCKED: worst-case reservations exceed budget')
    if os.environ.get('SSL_CERT_FILE') or os.environ.get('SSL_CERT_DIR'):
        raise RuntimeError('BLOCKED: custom TLS certificate environment is not allowed')
    plan = _load_pinned_plan()
    components = [ROOT / '.agent', ROOT / '.agent/tasks', ROOT / '.agent/tasks/full-cards-availability-20261112', EXPORTS]
    if any(component.is_symlink() or component.is_junction() for component in components) or \
       LIVE_LEDGER.is_symlink() or LIVE_LEDGER.is_junction() or LIVE_LEDGER.resolve().parent != EXPORTS.resolve() or \
       (LIVE_LEDGER.exists() and LIVE_LEDGER.stat().st_nlink != 1):
        raise RuntimeError('BLOCKED: fixed ledger path is unsafe')
    # Key is held only in process memory. It is never put in plan, SQLite or output.
    key = read_api_key()
    transport = LiteralOpenAITransport(key)
    owner = f'mark:{uuid.uuid4()}'
    claim_owner(LIVE_LEDGER, owner)
    completed = []
    for case in plan['cases']:
        run_case(LIVE_LEDGER, owner, case['case_id'], VERIFIED_PREFLIGHT_MAX_MICRO_USD,
                      transport, pinned_case=case)
        completed.append(case['case_id'])
    return {'status': 'completed', 'cases': completed, 'http_attempts': len(completed) * 2,
            'ledger': str(LIVE_LEDGER), 'quality': 'NOT_YET_REVIEWED'}


def main() -> None:
    parser = argparse.ArgumentParser(description='Direct, no-tools evaluation; offline by default.')
    parser.add_argument('--execute', action='store_true')
    parser.add_argument('--executor', default='')
    parser.add_argument('--budget-usd', default='')
    parser.add_argument('--max-http', type=int, default=0)
    parser.add_argument('--scenarios', type=int, default=0)
    args = parser.parse_args()
    if not args.execute:
        print(json.dumps({'mode': 'offline', 'live_calls': 0, 'cases': len(offline_plan()['cases'])}))
        return
    try:
        result = run_live(execute=True, executor=args.executor, budget_usd=args.budget_usd, max_http=args.max_http, scenarios=args.scenarios)
    except Exception:
        # No provider body, URL parameters, headers, secrets or arbitrary exception text in stdout/stderr.
        print('STOP: evaluation failed or is blocked; inspect the fixed ledger without retrying.', file=sys.stderr)
        raise SystemExit(1)
    print(json.dumps(result, ensure_ascii=False))


if __name__ == '__main__':
    main()
