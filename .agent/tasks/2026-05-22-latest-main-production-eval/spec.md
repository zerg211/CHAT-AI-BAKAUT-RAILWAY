# Task: latest main production eval

## Scope

Verify the current `main` runtime after the additional commit `9d04038` landed on top of the generator bounded-estimate fix.

No code changes are planned in this task. This is a production parity check because the previous passing eval was run on `8890cdf`, while current `main` is newer.

## Acceptance Criteria

AC1. Railway `/api/health` reports the current `main` commit marker.

AC2. Production Promptfoo/widget harness runs against:
- `PROMPTFOO_CHAT_BASE_URL=https://chat-ai-production-3057.up.railway.app`
- `PROMPTFOO_CHAT_PAGE_URL=https://bakautprof.ru/?agentHarness=1`

AC3. Production eval reaches:
- deterministic average > 90%;
- LLM average > 90%;
- no Promptfoo runtime errors.

AC4. Raw artifacts and summary are stored in this task directory.
