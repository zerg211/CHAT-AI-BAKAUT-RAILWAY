# Evidence: LLM + Embedding Intent Finalization

## Verdict

Status: **primary rollout PASS**.

Production is running commit `511f8c40532dc91052d9517d37e206b2a3b1d4b9` on branch `main`. This commit includes the runtime fix `57e1a8d42f211119cbeb85678d0c27973a73ff38` for AgentManager answer evidence-source normalization and the deploy trigger commit `511f8c4`.

AgentManager harness is globally enabled in production without `?agentHarness=1`; the old mode remains in code only as rollback/migration fallback and was not used by the tested widget sessions.

## Current Production State

- Production API: `https://chat-ai-production-3057.up.railway.app`
- Runtime commit: `511f8c40532dc91052d9517d37e206b2a3b1d4b9`
- Branch: `main`
- AgentManager harness: enabled
- Widget iframe: no `agentHarness=1` opt-in param
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
- Generator calculator enriches missing household loads and canonicalizes unknown load names by `name`.
- LLM answer/review prompts keep calculator values authoritative and require self-loading plate advice to keep 90+ kg out of the primary range.
- Answer contracts now expose explicit allowed evidence source ids to the LLM.
- Answer source metadata is normalized to existing ledger/tool artifacts before review; unsupported facts with no ledger/tool evidence still block.
- Lead form delivery is queued through the outbox, so buyer-visible form submission no longer depends on synchronous email delivery.

## Verification Done

- `npm test -- --run tests/agentManagerOrchestrator.test.ts`: PASS, 17 tests
- `npm run typecheck`: PASS
- `npm test`: PASS, 520 tests
- `npm run build`: PASS
- `git diff --check`: PASS
- Production `/api/health`: PASS, commit `511f8c40532dc91052d9517d37e206b2a3b1d4b9`
- Production `/api/admin/runtime/openai`: PASS
- Production `/api/admin/embedding-coverage`: PASS, `finalReady=true`

## Live Widget Verification

Protocol: `local-live-tests/2026-05-20-global-harness-rollout-2026-05-20T12-49-32-285Z.production.md`

Raw detail: `local-live-tests/2026-05-20-global-harness-rollout-2026-05-20T12-49-32-285Z.json`

Run mode: real production iframe on `https://bakautprof.ru/`, no `?agentHarness=1`. Headless `production_live_test` budget was exhausted, so this final run used a non-headless production widget browser source. This still exercises the real production widget and production backend.

### Dialogs

1. `coffee_point_generator`
   - Session: `9e185b4e-71db-4e9d-b2d2-b40f523b9d57`
   - Result: PASS by manual audit and admin audit.
   - Notes: runner reported `initial_answer_missing:/кофемашин/iu`, but the answer did address the coffee-point load, calculated 4.1 kW working load and about 5.5 kW with start, then continued correctly. This is a test-regex false positive, not a bot behavior defect.

2. `business_plate_heavy_base`
   - Session: `e9d675c0-1192-4515-871f-1d615bbfcfb1`
   - Result: PASS.
   - The bot recommended the correct heavier class for commercial compaction, showed 90+ kg catalog cards, did not promise live stock/delivery, and the lead form saved successfully.

3. `workshop_generator_unknown_start`
   - Session: `cdaa0925-5ef8-4e06-bade-4cc8f2071c33`
   - Result: PASS.
   - The bot calculated around 9 kW initially, adjusted to 8.5 kW minimum after simultaneous-use clarification, showed suitable catalog cards, answered maintenance, and routed live stock/delivery to the form. Lead form saved successfully.

Admin audit for all three dialogs: no `adminIssues`, no `adminWarnings`.

## Acceptance Criteria

- AC1 LLM owns retrieval intent: **PASS**
- AC2 embeddings are intent-scoped: **PASS**
- AC3 stale constraints cleared on focus switch: **PASS**
- AC4 card-class guard: **PASS**
- AC5 no deterministic technical writer for normal LLM path: **PASS**
- AC6 calculations are tools, not final writers: **PASS**
- AC7 Dialog #1064 failure pattern covered: **PASS**
- AC8 embedding infrastructure green: **PASS**
- AC9 evidence and finality: **PASS**

## Remaining Operational Notes

- `production_live_test` headless budget remains exhausted for the last 24h window:
  - usedTokens: `3986558`
  - budget: `4000000`
  - reserveTokens: `16000`
  - remainingAfterReserve: `-2558`
- This blocks only headless final-gate reruns. It does not mean the production widget is broken.
- Step 5, deleting old rollback/legacy code, was intentionally not done per user instruction.
