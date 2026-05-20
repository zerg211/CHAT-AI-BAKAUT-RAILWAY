# Evidence: LLM + Embedding Intent Finalization

## Verdict

Status: **not final yet**.

Code is implemented, pushed, and production is running the latest commit `8f48e6e9909cf89bda4576cb3dbb73e755244d4e`. Production embedding coverage is `finalReady=true`, and production OpenAI runtime is healthy.

Finality is blocked by production live-test budget: the current live widget gate could not start because `/api/admin/openai-usage` budget guard returned `production_live_test_budget_insufficient_for_scenario`. Per project rules, without a successful live dialogue through the real widget on `https://bakautprof.ru/` against the current commit, this cannot be claimed final.

## Current Production State

- Production API: `https://chat-ai-production-3057.up.railway.app`
- Runtime commit: `8f48e6e9909cf89bda4576cb3dbb73e755244d4e`
- Branch: `main`
- AgentManager harness: enabled
- Production OpenAI runtime: PASS (`gpt-5.4-mini` answer/planner)
- Production embedding coverage:
  - model: `text-embedding-3-small`
  - products: `3999 / 4325 usable`, coverage `0.9246242774566474`
  - catalog pages: `102 / 102 usable`, coverage `1`
  - finalReady: `true`

## What Is Implemented

- AgentManager catalog retrieval uses LLM-owned `productIntent` and `semanticQuery`.
- Embedding vector retrieval is scoped by that LLM semantic query.
- Merged text/vector products are filtered by current LLM product intent before visible cards.
- Plate compactor self-loading constraints are applied in catalog ranking.
- Generator calculator tool now enriches missing household loads and canonicalizes unknown load names by `name`, so `kind:"unknown", name:"насос"` is treated as `pump` and receives motor-start handling.
- LLM answer/review prompts require calculator values to remain authoritative and require self-loading plate advice to keep 90+ kg out of the primary range.

## Verification Done

- `npm run typecheck`: PASS
- `npm test -- tests/agentManagerOrchestrator.test.ts`: PASS, 16 tests
- `npm test`: PASS, 519 tests
- `npm run build`: PASS
- Production `/api/health`: PASS, commit `8f48e6e9909cf89bda4576cb3dbb73e755244d4e`
- Production `/api/admin/embedding-coverage`: PASS, `finalReady=true`
- Production `/api/admin/runtime/openai`: PASS

## Live Widget History

### Commit `57be092419150c02dc5936afa99be6c38ad64955`

Status: PASS.

- Protocol: `local-live-tests/2026-05-20-llm-embedding-intent-2026-05-20T11-38-27-888Z.production.md`
- Raw detail: `local-live-tests/2026-05-20-llm-embedding-intent-2026-05-20T11-38-27-888Z.json`
- Session: `47e9a621-005f-4716-ade1-0938ae702329`

### Commit `af853642ad4289ad33dd623c2aa27eec12d17430`

Status: FAIL, then fixed.

- Failure: `turn2_understated_calculated_generator_minimum`.
- Root cause: LLM sent pump load as `kind:"unknown", name:"насос"`, and the calculator canonicalized by `kind` only, so pump motor starting load was not applied.
- Fix: `db5ea209ad6381e471f604a28d5cabe7fb505ef2` canonicalizes unknown load kinds by load `name`.

### Commit `8f48e6e9909cf89bda4576cb3dbb73e755244d4e`

Status: BLOCKED, not run.

- Production is on this commit.
- Live gate was blocked before browser launch by `production_live_test_budget_insufficient_for_scenario`.
- Budget state from error:
  - usedTokens: `3986558`
  - budget: `4000000`
  - reserveTokens: `16000`
  - remainingAfterReserve: `-2558`

## Acceptance Criteria

- AC1 LLM owns retrieval intent: **PASS in code/tests; production latest not live-verified**
- AC2 embeddings are intent-scoped: **PASS in code/tests; production latest not live-verified**
- AC3 stale constraints cleared on focus switch: **PASS in code/tests; production latest not live-verified**
- AC4 card-class guard: **PASS in code/tests; production latest not live-verified**
- AC5 no deterministic technical writer for normal LLM path: **PASS in code/tests; production latest not live-verified**
- AC6 calculations are tools, not final writers: **PASS in code/tests; production latest not live-verified**
- AC7 Dialog #1064 failure pattern covered: **PASS in regression tests; production latest not live-verified**
- AC8 embedding infrastructure green: **PASS**
- AC9 evidence and finality: **BLOCKED by production live-test budget**

## Required To Finish

When production live-test budget is available again, first read `/api/health.runtime.commitSha`, then run the live gate against that exact current production commit. If production has advanced beyond `8f48e6e9909cf89bda4576cb3dbb73e755244d4e`, use the newer health marker in `EXPECTED_PRODUCTION_COMMIT_SHA`.

```powershell
$env:ALLOW_PRODUCTION_LIVE_TESTS='1'
$env:FINAL_RELEASE_LIVE_GATE='1'
$env:EXPECTED_PRODUCTION_COMMIT_SHA='<current /api/health.runtime.commitSha>'
node local-live-tests\2026-05-20-llm-embedding-intent-live-runner.mjs
```

Final only if that live widget gate passes and the protocol is saved.
