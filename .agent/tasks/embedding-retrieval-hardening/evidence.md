# Embedding Retrieval Hardening Evidence

## Verdict

PASS. All acceptance criteria from `spec.md` are satisfied by current code and command results.

## Acceptance Criteria

- AC1 PASS: `products`, `catalog_pages`, and `troubleshooting_cases` now have `embedding_model`, `embedding_source_hash`, and `embedding_updated_at` in fresh SQL and migration `008_embedding_metadata.sql`.
- AC2 PASS: repository upserts write embedding metadata when vectors are supplied and preserve existing metadata when vectors are omitted.
- AC3 PASS: `AssistantService` checks embedding coverage before query embedding calls; zero/low coverage skips query embedding and vector search.
- AC4 PASS: vector score/source is exposed on `Product`, but existing hard filters still reject semantically similar products that violate product intent.
- AC5 PASS: `npm run embeddings:backfill -- --dry-run --limit=3` finds missing product/page vectors without calling OpenAI or updating rows.
- AC6 PASS: tests cover migration metadata, repository metadata/coverage SQL, runtime coverage guard, and vector hard-filter safety.
- AC7 PASS: evidence files are present in `.agent/tasks/embedding-retrieval-hardening/`.

## Commands

- `npm test -- tests/embeddingRetrieval.test.ts tests/conversationRepository.test.ts tests/migrate.test.ts` -> PASS, 18 tests.
- `npm run typecheck` -> PASS.
- `npm test -- tests/recommendationRanking.test.ts tests/agenticCycle876.test.ts tests/agentTurnContract.test.ts tests/agentRuntimeContractsEval.test.ts` -> PASS, 249 tests.
- `npm run migrate` -> PASS.
- `npm run embeddings:backfill -- --dry-run --limit=3` -> PASS, planned 3 products and 3 catalog pages.
- `npm test -- tests/openaiClient.test.ts tests/openaiUsageGuard.test.ts` -> PASS, 6 tests.
- `npm test` -> PASS, 45 files and 452 tests.
- `git diff --check` -> PASS with line-ending warnings only.

## Local Database Observation

After migration, local coverage remains intentionally zero until real backfill is run:

- `products total=3955 embedded=0 usable=0`
- `catalog_pages total=102 embedded=0 usable=0`
- `troubleshooting_cases total=1 embedded=0 usable=0`

This is now safe because runtime vector calls are gated by coverage.
