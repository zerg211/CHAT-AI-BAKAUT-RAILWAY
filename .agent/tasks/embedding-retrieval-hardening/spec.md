# Embedding Retrieval Hardening Spec

## Objective

Close the practical downsides of the existing embeddings layer without changing the assistant into a rule-based dialog bot. Embeddings must support catalog retrieval, not override the LLM planner, hard catalog facts, or product constraint checks.

## Scope

- Add durable embedding metadata so stale vectors can be detected and refreshed.
- Add a backfill workflow for existing catalog rows with missing or stale embeddings.
- Add runtime coverage guards so the assistant does not pay for query embeddings when the database cannot use them.
- Preserve vector similarity as candidate discovery input only; final product eligibility stays behind existing hard filters and scoring.
- Add focused tests for metadata, guard behavior, and hybrid retrieval safety.

## Acceptance Criteria

AC1. Schema supports embedding metadata for `products`, `catalog_pages`, and `troubleshooting_cases`: model, source hash, and updated timestamp.

AC2. Repository upserts write embedding metadata only when an embedding is supplied, and preserve existing vectors/metadata when an import does not include embeddings.

AC3. Runtime catalog retrieval checks embedding coverage before calling OpenAI embeddings. If coverage is below a minimum threshold or zero, product/page/troubleshooting vector search is skipped and no query embedding is requested for that table.

AC4. Vector retrieval exposes retrieval score/source internally enough for ranking/tests, but hard catalog filters still decide product eligibility. A semantically similar product that violates hard constraints must not become a visible recommendation because of vector similarity alone.

AC5. A local script can backfill missing or stale embeddings for products and catalog pages in bounded batches, with dry-run and limit options.

AC6. Tests cover schema/metadata, coverage guard, and vector candidate safety.

AC7. Evidence files exist under `.agent/tasks/embedding-retrieval-hardening/` and include commands run plus PASS/FAIL status for every AC.

## Out of Scope

- No production live widget run in this local coding pass unless explicitly requested after deploy.
- No model migration away from `text-embedding-3-small`.
- No LLM prompt changes for product semantics.
- No manual Railway deploy.
