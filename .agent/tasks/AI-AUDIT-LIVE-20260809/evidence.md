# AI-AUDIT-LIVE-20260809 evidence

Updated: 2026-08-11 13:58 (Europe/Moscow)

## Current disposition

The follow-up code is pushed, but the frozen task is not complete. The embedded widget was exercised after commit `a9eaaff`; the exact model still was not retrieved from the AI catalog and the assistant stopped after an incomplete external check. Railway `/api/health` was unavailable, so the exact runtime marker could not be read back.

## Code changes verified

- AC1: explicit comparison subjects are kept in `productEvidenceRoles` as factual `comparison_reference_only` entries; deterministic hard-constraint proofs drive rejection reasons; only eligible candidates can become cards. Coverage includes budget and a generic catalog weight proof.
- AC2: numeric rewrite exceptions require an exact structured buyer-threshold quote derived from the current requirement evidence and present in the current user message. Forged product price/specification claims and numeric-only quotes remain blocked.
- AC3: the second semantic review block uses the existing fenced terminal recovery and emits one useful degraded answer from validated catalog/artifact evidence.
- AC4: missing requested technical attributes repair to one typed catalog-first conditional web request; exact target names and attribute bindings are preserved; complete catalog evidence can short-circuit external web.
- AC5: web tool timeout is 45 s, turn wall budget is 100 s, route/persistence deadline is 105 s, and compose/review/terminal reserves remain explicit. Timeout and abort paths return typed partial research instead of discarding catalog evidence.

## Fresh local signals

- `npm.cmd test -- --run tests/agentManagerOrchestrator.test.ts --maxWorkers=1 --no-file-parallelism`: 159/159 PASS.
- Connected follow-up suites: 7 files / 134 tests PASS; agentic suite 4 files / 258 tests PASS; additional web/lifecycle/UI suites 8 files / 138 tests PASS.
- `npm.cmd run verify`: PASS — full suite 77 files / 848 tests, agentic 257 tests, typecheck, production build, production dependency audit, and no-regex gate.
- `npm.cmd run typecheck`: PASS.
- `npm.cmd run lint:no-regex`: PASS (`Legacy baseline: 508`).
- `npm.cmd run build`: PASS.
- `git diff --check`: PASS (Git only reports its normal LF/CRLF conversion warnings).
- Sanitized scoped scan: 659 text files, zero suspicious production/credential matches. One test fixture match is explicitly a test-marker placeholder in `tests/adminEmbeddingCoverage.test.ts`; no value was printed or staged as a secret.

## Database limitation

Post-fix rerun after `a9eaaff`: `npm.cmd run verify` PASS — 77 files / 849 tests, agentic 258 tests; orchestrator focused suite 159/159 PASS.

The real PostgreSQL barrier script was attempted against the current environment and returned `ECONNREFUSED` on `127.0.0.1:5432`/`::1:5432`; `psql` is absent and the Docker daemon is unavailable. Repository SQL contract tests are green, but this environment cannot provide a fresh two-client PostgreSQL race proof. This is recorded as a verification limitation, not hidden as a PASS.

## Deployment/live gate

GitHub `main` contains `a9eaaff`; this was pushed successfully. Railway CLI reported the service online, but both Railway and widget health URLs were unavailable from this environment, so the exact runtime marker readback is `UNVERIFIED`. The adaptive widget record is in `local-live-tests/2026-08-11-AI-AUDIT-LIVE-followup.production.md`.

Live verdict: safety is preserved, but exact catalog retrieval, useful partial answer, source provenance, and autonomous completion are `FAIL` for the technical request. Admin metadata could not be audited because the production admin page requires the Railway `ADMIN_PASSWORD`, which was not entered or printed.
