# Evidence: LLM + Embedding Intent Finalization

## Verdict

Status: **final**.

Production is running commit `57be092419150c02dc5936afa99be6c38ad64955`, production embedding coverage is `finalReady=true`, and the real widget live gate on `https://bakautprof.ru/` passed manual + metadata audit.

## Final Runtime Evidence

- Production API: `https://chat-ai-production-3057.up.railway.app`
- Runtime commit: `57be092419150c02dc5936afa99be6c38ad64955`
- Branch: `main`
- AgentManager harness: enabled
- Production OpenAI runtime: PASS (`gpt-5.4-mini` answer/planner)
- Production embedding coverage:
  - model: `text-embedding-3-small`
  - products: `3999 / 4325 usable`, coverage `0.9246242774566474`
  - catalog pages: `102 / 102 usable`, coverage `1`
  - finalReady: `true`

## Live Widget Gate

Status: **PASS**.

- Protocol: `local-live-tests/2026-05-20-llm-embedding-intent-2026-05-20T11-38-27-888Z.production.md`
- Raw detail: `local-live-tests/2026-05-20-llm-embedding-intent-2026-05-20T11-38-27-888Z.json`
- Session: `47e9a621-005f-4716-ade1-0938ae702329`
- Scenario: generator sizing, pump-power update, switch to plate compactor, explicit plate catalog request.

Buyer-visible audit:

- PASS: no canned `fast_technical_orientation` phrase.
- PASS: generator first turn used calculator profile and clearly marked `5 kW` as the calculated minimum from estimated loads.
- PASS: after pump `1.1 kW`, answer used calculated minimum `4.5 kW` and practical `5 kW` class.
- PASS: plate turn switched context from generator to plate compactor.
- PASS: explicit plate catalog request showed plate cards only.
- PASS: visible plate cards were in the self-loading range (`60-72 kg`), not stale generator cards or heavy 90+ kg first choices.

Admin metadata audit:

- PASS: `agentManager=true` on all turns.
- PASS: `recovered=false` on all turns.
- PASS: no fallback/recovery diagnostics.
- PASS: `catalog.search` plate request used `retrieval.intent="plate"` and `usedEmbeddings=true`.
- PASS: plate metadata product cards contain plate compactors only.
- PASS: generator calculator tool profile is present on both generator turns.

## Acceptance Criteria

### AC1: LLM owns retrieval intent

Status: **PASS**.

`catalog.search` tool requests carry LLM-owned `productIntent` and `semanticQuery`. Runtime metadata shows the plate request used `intent=plate` after prior generator context.

### AC2: Embeddings are intent-scoped

Status: **PASS**.

Embeddings are called with the LLM semantic query, and the merged text/vector result is filtered by current product intent. Live metadata shows `usedEmbeddings=true` and `embeddingQuery` scoped to plate compactors.

### AC3: stale constraints cleared on focus switch

Status: **PASS**.

The live dialogue switched from generator to plate compactor. No generator cards were shown on the plate turns.

### AC4: card-class guard

Status: **PASS**.

Wrong-class candidates are filtered before visible cards. Live metadata includes intent filtering and no generator cards in plate metadata.

### AC5: no deterministic technical writer for normal LLM path

Status: **PASS**.

No `fast_technical_orientation` answer mode appeared in production metadata, and the canned phrase did not appear in the widget.

### AC6: calculations are tools, not final writers

Status: **PASS**.

Generator sizing is tool-grounded: the calculator produces `requiredNominalKw` / `requiredStartingKw`, and the LLM answer uses those values. The second generator turn produced `requiredNominalKw=4.5` and `requiredStartingKw=4.5`.

### AC7: Dialog #1064 failure pattern covered

Status: **PASS**.

Regression tests and production live gate cover the failure pattern: after generator context, a plate-compactor request remains plate-scoped through LLM intent, semantic embedding query, catalog filtering, and visible cards.

### AC8: embedding infrastructure remains green

Status: **PASS**.

Local command `npm run embeddings:coverage` succeeds. Production coverage endpoint is final-ready.

### AC9: evidence and finality

Status: **PASS**.

Code is pushed, production is on the target commit, production coverage targets are met, live widget protocol is saved, and every audited acceptance criterion is PASS.

## Verification Commands

- `npm run typecheck`: PASS
- `npm test -- tests/agentManagerOrchestrator.test.ts tests/recommendationRanking.test.ts tests/assistantFallback.test.ts tests/factClaimPlanner.test.ts tests/chatStream.test.ts`: PASS, 251 tests
- `npm test`: PASS, 517 tests
- `npm run build`: PASS
- `npm run embeddings:coverage`: PASS locally, local DB not final-ready
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
