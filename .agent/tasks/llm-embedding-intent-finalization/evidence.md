# Evidence: LLM + Embedding Intent Finalization

## Verdict

Status: **final**.

Production live widget gate passed on runtime commit `4bf48dc27348b5ea3d15f1e85b741d356b811aea`. Production embedding coverage is `finalReady=true`, production OpenAI runtime is healthy, and the live protocol was saved.

The headless production live-test budget was raised from `4,000,000` to `6,000,000` tokens/day so the final gate could run without disabling the guard. This budget applies to `production_live_test`; buyer traffic remains governed separately by `OPENAI_DAILY_TOKEN_BUDGET`.

## Runtime Evidence

- Production API: `https://chat-ai-production-3057.up.railway.app`
- Runtime commit: `4bf48dc27348b5ea3d15f1e85b741d356b811aea`
- Branch: `main`
- AgentManager harness: enabled
- Production OpenAI runtime: PASS (`gpt-5.4-mini` answer/planner)
- Production live-test budget: PASS, `headlessDailyTokenBudget=6000000`
- Production embedding coverage:
  - model: `text-embedding-3-small`
  - products: `3999 / 4325 usable`, coverage `0.9246242774566474`
  - catalog pages: `102 / 102 usable`, coverage `1`
  - finalReady: `true`

## Live Widget Gate

Status: **PASS**.

- Protocol: `local-live-tests/2026-05-20-llm-embedding-intent-2026-05-20T12-55-43-718Z.production.md`
- Raw detail: `local-live-tests/2026-05-20-llm-embedding-intent-2026-05-20T12-55-43-718Z.json`
- Session: `7dcd6c20-e88b-4328-9185-300c6dd8b7da`
- Scenario: generator sizing, pump-power update, switch to plate compactor, explicit plate catalog request.

Buyer-visible audit:

- PASS: no canned `fast_technical_orientation` phrase.
- PASS: initial generator answer used calculator profile and treated `5 kW` as the lower working class from estimated loads.
- PASS: after pump `1.1 kW`, answer used calculated minimum `4.5 kW` and practical `5 kW` class.
- PASS: plate turn switched context away from generator.
- PASS: plate advice used `50-80 kg`, usually `60-75 kg`; `90+ kg` was only described as heavier, not primary.
- PASS: explicit plate catalog request showed plate cards only.
- PASS: visible plate cards were in the self-loading range (`50-68 kg`).

Admin metadata audit:

- PASS: `agentManager=true` on all turns.
- PASS: `recovered=false` on all turns.
- PASS: no fallback/recovery diagnostics.
- PASS: generator calculator tool profile is present on both generator turns.
- PASS: pump update canonicalized `насос` as `pump`; profile has `requiredNominalKw=4.5`, `requiredStartingKw=4.5`.
- PASS: plate catalog request used `catalog.search` with `retrieval.intent="plate"` and `usedEmbeddings=true`.
- PASS: plate metadata product cards contain plate compactors only.

## Acceptance Criteria

- AC1 LLM owns retrieval intent: **PASS**.
- AC2 embeddings are intent-scoped: **PASS**.
- AC3 stale constraints cleared on focus switch: **PASS**.
- AC4 card-class guard: **PASS**.
- AC5 no deterministic technical writer for normal LLM path: **PASS**.
- AC6 calculations are tools, not final writers: **PASS**.
- AC7 Dialog #1064 failure pattern covered: **PASS**.
- AC8 embedding infrastructure green: **PASS**.
- AC9 evidence and finality: **PASS**.

## Verification Commands

- `npm run typecheck`: PASS
- `npm test -- tests/productionOpenAiRuntimePreflight.test.mjs tests/agentManagerOrchestrator.test.ts`: PASS, 24 tests
- `npm test`: PASS, 521 tests
- `npm run build`: PASS
- Production `/api/admin/openai-usage?hours=24&source=production_live_test`: PASS, budget now `6000000`
- Production `/api/admin/embedding-coverage`: PASS, `finalReady=true`
- Production `/api/admin/runtime/openai`: PASS
- Production live widget gate: PASS

## Raw Artifacts

- `raw/typecheck.txt`
- `raw/targeted-tests.txt`
- `raw/full-tests.txt`
- `raw/build.txt`
- `raw/embedding-coverage-local.txt`
- `raw/production-final-preflight.txt`
- `raw/production-live-widget.txt`
