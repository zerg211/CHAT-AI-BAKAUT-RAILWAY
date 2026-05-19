# Embedding Finalization Execution Spec

## Objective

Implement the remaining code-level pieces from `docs/plans/2026-05-19-embedding-finalization-plan.md` and then carry the workflow as far as available credentials, budget, and production access allow.

Current state is not final until production coverage and production live evidence pass.

## Acceptance Criteria

AC1. Add authenticated admin endpoint `GET /api/admin/embedding-coverage`.

AC2. Add CLI script `npm run embeddings:coverage`.

AC3. Endpoint and CLI use the same coverage report builder based on `ProductRepository.getEmbeddingCoverage(...)`.

AC4. Coverage report includes `model`, `minCoverage`, three targets (`products`, `catalog_pages`, `troubleshooting_cases`), per-target `ready`, and top-level `finalReady`.

AC5. Tests cover admin auth, endpoint payload shape, and shared report formatting.

AC6. Existing embedding hardening tests, typecheck, full tests, local migration, coverage report, and backfill dry-run pass.

AC7. Commit and push to `origin codex/llm-commercial-lead-form` after verification.

AC8. Production coverage/backfill/live gates are attempted only when required credentials and budget are available; blockers are recorded and final readiness remains false if any gate cannot run or fails.

AC9. Evidence artifacts record separate statuses: `code_ready`, `production_backfill_ready`, `production_backfill_done`, `live_gate_done`, `final_ready`.
