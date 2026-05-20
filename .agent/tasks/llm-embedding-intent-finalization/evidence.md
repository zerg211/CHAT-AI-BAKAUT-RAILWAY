# Evidence: LLM + Embedding Intent Finalization

## Verdict

Status: **not final yet**.

Code implementation is pushed to GitHub as `afdfc62380b23816ada1df4bf0d6c72f135c135e`, and local verification is green. Production is not yet running this commit at the time of this evidence pass: `/api/health` reports `8a33c3bd1f4c4343035c5d9e9947b30c06b4c7c1`.

Finality is blocked until Railway runs the new commit and a live widget dialogue through `https://bakautprof.ru/` passes manual + metadata audit.

## Implementation Evidence

### AC1: LLM owns retrieval intent

Status: **PASS, local code**.

- `src/ai/agentManagerOrchestrator.ts` now requires LLM tool calls to provide `semanticQuery` and `productIntent` for catalog search.
- `toolRequestProductIntent(...)` extracts product class from the LLM tool request before fallback heuristics.
- `inferVisibleCardIntent(...)` prioritizes current LLM tool requests before prior dialogue state.

### AC2: Embeddings are intent-scoped

Status: **PASS, local code**.

- `catalog.search` passes `embeddingQuery: semanticQuery` into `searchCatalogProducts(...)`.
- Runtime tool payload exposes `retrieval.intent`, `retrieval.query`, `retrieval.embeddingQuery`, `retrieval.textCount`, `retrieval.vectorCount`, and `retrieval.usedEmbeddings`.
- This makes vector retrieval auditable and tied to the LLM-understood current focus.

### AC3: stale constraints cleared on focus switch

Status: **PASS, local code**.

- `src/ai/assistant.ts` now prioritizes planner/LLM product intent before stale profile/state intent in `productIntentFromSelection(...)`.
- This prevents old generator constraints from controlling a new plate-compactor turn.

### AC4: card-class guard

Status: **PASS, local tests**.

- `searchCatalogProducts(...)` filters merged text/vector results by LLM `productIntent`.
- Wrong-class candidates are dropped and traced as `catalog_products_filtered_by_intent:<intent>:<count>`.
- Regression test proves a stale vector generator candidate is not shown on a plate-compactor turn.

### AC5: no deterministic technical writer for normal LLM path

Status: **PASS, local tests**.

- `legacyAnswerWriterAllowed('fast_technical_orientation')` is disabled by default when legacy writers are disabled.
- Tests assert the ordinary generator/plate technical orientation path does not emit `fast_technical_orientation` and does not start with the canned phrase.

### AC6: calculations are tools, not final writers

Status: **PASS, local tests**.

- Existing generator calculation traces remain available.
- The primary answer path stays LLM/planner-owned unless an emergency deterministic fallback is explicitly marked.

### AC7: Dialog #1064 failure pattern covered

Status: **PASS, local tests**.

- `tests/agentManagerOrchestrator.test.ts` includes a regression where the dialogue has prior generator history, the current LLM tool request asks for a plate compactor, vector search returns a generator, and visible cards remain plate-only.
- `tests/assistantFallback.test.ts` covers technical orientation through the LLM planner path instead of the canned fast writer.

### AC8: embedding infrastructure remains green

Status: **PASS, local runtime checks**.

- `npm run embeddings:coverage` succeeds.
- `npm run embeddings:backfill -- --dry-run --limit=50` succeeds.
- Existing test suite remains green.

### AC9: evidence and finality

Status: **BLOCKED, production live gate**.

- Evidence files exist under `.agent/tasks/llm-embedding-intent-finalization/`.
- Production admin auth works.
- Production OpenAI runtime is healthy.
- Production embedding coverage is final-ready:
  - products coverage: `0.9246242774566474`
  - catalog pages coverage: `1`
  - model: `text-embedding-3-small`
- Blocker: Railway health marker still reports old commit `8a33c3bd1f4c4343035c5d9e9947b30c06b4c7c1`, not `afdfc62380b23816ada1df4bf0d6c72f135c135e`.
- Live widget verification has not been run against the new code because production is not yet on the new commit.

## Verification Commands

Raw command outputs are saved under `.agent/tasks/llm-embedding-intent-finalization/raw/`.

- `npm run typecheck`: PASS
- `npm test -- tests/agentManagerOrchestrator.test.ts tests/agentManagerConfig.test.ts tests/assistantFallback.test.ts tests/recommendationRanking.test.ts`: PASS, 238 tests
- `npm test`: PASS, 510 tests
- `npm run build`: PASS
- `npm run migrate`: PASS
- `npm run embeddings:coverage`: PASS
- `npm run embeddings:backfill -- --dry-run --limit=50`: PASS
- production preflight: admin runtime PASS, production coverage PASS, deploy marker BLOCKED

## Raw Artifacts

- `raw/typecheck.txt`
- `raw/targeted-tests.txt`
- `raw/full-tests.txt`
- `raw/build.txt`
- `raw/migrate.txt`
- `raw/embedding-coverage-local.txt`
- `raw/embedding-backfill-dry-run.txt`
- `raw/production-preflight.txt`

## Next Required Step

After Railway updates `/api/health.runtime.commitSha` to a commit containing `afdfc62`, run a live adaptive dialogue through the real widget on `https://bakautprof.ru/`:

1. Start with a generator sizing consultation.
2. Provide pump power to verify calculation path and absence of stale default `5-6 кВт` wording.
3. Switch to a plate-compactor question.
4. Verify visible cards are plate-compactor cards only, not generators.
5. Audit admin metadata for LLM `productIntent`, intent-scoped `embeddingQuery`, no unmarked fallback/recovery, and card/answer consistency.
6. Save the live protocol under `local-live-tests/*.production.md`.
