# Promptfoo Baseline Evals

The Promptfoo suite is defined in `promptfooconfig.yaml`.

It targets the user-facing chat path rather than raw model prompts:

1. `POST /api/chat/sessions`
2. `POST /api/chat/sessions/:id/messages`
3. SSE `done` payload assertions over answer text, product cards, and runtime metadata

Run locally:

```bash
docker compose up -d
npm run migrate
npm run dev:server
npm run evals
```

When `npm run evals` is run with `-o path/to/result.json` or `--output path/to/result.json`, the wrapper also writes `path/to/result.summary.json`. The summary reports deterministic average score, assertion pass rate, and `llmAverage` status (`ready`, `blocked`, or `not_configured`).

Required environment for a real AI baseline:

- `DATABASE_URL`
- `OPENAI_API_KEY`
- `PROMPTFOO_CHAT_BASE_URL` if the API is not on `http://localhost:3010`

Optional:

- `PROMPTFOO_CHAT_PAGE_URL`
- `PROMPTFOO_CHAT_TIMEOUT_MS`
- `PROMPTFOO_CHAT_ADMIN_TOKEN` for the production LLM grader. If omitted, the grader falls back to `ADMIN_API_KEY` or `ADMIN_PASSWORD` from `.env`.

Production baseline against the widget backend embedded on `https://bakautprof.ru/`:

```bash
PROMPTFOO_CHAT_BASE_URL=https://chat-ai-production-3057.up.railway.app \
PROMPTFOO_CHAT_PAGE_URL=https://bakautprof.ru/?agentHarness=1 \
npm run evals -- --no-cache -j 1
```

The suite includes a production-backed `llm-rubric` assertion. The grader calls `POST /api/admin/evals/llm-rubric` on the production backend, so LLM scoring uses Railway's OpenAI access instead of this local machine's OpenAI path.

On Windows PowerShell:

```powershell
$env:PROMPTFOO_CHAT_BASE_URL='https://chat-ai-production-3057.up.railway.app'
$env:PROMPTFOO_CHAT_PAGE_URL='https://bakautprof.ru/?agentHarness=1'
npm run evals -- --no-cache -j 1
```

Strict live UI check through the embedded widget:

```powershell
$env:ALLOW_PRODUCTION_LIVE_TESTS='1'
$env:FINAL_RELEASE_LIVE_GATE='1'
$env:ALLOW_FIXED_PRODUCTION_REPLAY='1'
npm run test:live:production
```

The live UI check clicks and types in the real iframe on `https://bakautprof.ru/`. The current baseline fails on the first vague generator request because production renders product cards before the generator load profile is ready. The saved protocol is `local-live-tests/2026-05-21-bakautprof-production-agent-cycle-failure.production.md`.

Seed cases:

- `vague_generator_no_cards_before_load_profile`
- `generator_load_selection`
- `commercial_delivery_discount_rules`
- `plate_retrieval_grounding`
- `web_required_technical_grounding`
- `context_shift_agent_completion`

Fixtures must stay synthetic and must not contain customer data or secrets.
