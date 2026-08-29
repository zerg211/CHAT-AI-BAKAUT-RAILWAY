# Verification Evidence

Task: `2026-08-29-llm-owned-semantic-boundary`
Verified at: `2026-08-29T10:56:17.375Z`
Baseline HEAD: `0d12930b1c1850b68ddfad5f61f36c3f624dd63b`
Current verdict: `PENDING`

The implementation and all local checks are complete, but the task is not done until AC10 passes after commit, push, Railway deployment, and a fresh dialogue through the widget on `https://bakautprof.ru/`.

## Acceptance Criteria

| AC | Local verdict | Evidence |
| --- | --- | --- |
| AC1 | PASS | The production `agent_manager` runtime accepts one typed `AgentSemanticDecision`; the deleted semantic repair symbols and `planner_repaired_*` paths have no matches in `src`. `inferProductIntent` remains only as an unreferenced legacy export in `productClassifier.ts`. Catalog product classification still operates only on catalog facts and typed product classes. |
| AC2 | PASS | `semanticAuthorityIssues` rejects missing/inconsistent selection authority. Runtime permits at most two LLM semantic attempts and throws `AgentSemanticDecisionIncoherentError` before tools when both fail. |
| AC3 | PASS | Semantic mutation helpers for electric start, preliminary/final fit, stale targets, open-ended requirements, grounding, catalog promotion, and typed coverage were removed. Recovered decisions are revalidated rather than normalized. |
| AC4 | PASS | Generator calculation consumes typed load kind, operation mode, running/starting values, and provenance. `tests/agentManagerGeneratorLoad.test.ts` and semantic-decision tests pass. |
| AC5 | PASS | Missing research planning is rejected by the semantic validator. Premature specialist/lead plans fail closed unless exact persisted source-exhaustion provenance is proven. `agentManagerSearchBeforeSpecialistIntegration.test.ts`: 9/9 PASS. |
| AC6 | PASS | Full card-selection suite confirms unknown mandatory attributes remain preliminary while proven conflicts are excluded. `agentManagerCardSelection.test.ts`: 63/63 PASS. |
| AC7 | PASS | Deterministic schema, evidence, catalog identity, filtering, ordering, arithmetic, lead authorization, persistence, checkpoints, and tool execution remain active; full release gate passes. |
| AC8 | PASS | Writer structured output requires `selectionRationale`; pre-send review blocks selected product IDs without a non-empty LLM rationale; product cards receive only that rationale. Always-null `replacementProductEvidence` metadata was removed. |
| AC9 | PASS | `npm run verify`, standalone no-regex guard, focused integration suites, typecheck, build, and `git diff --check` pass on current files. Full suite: 88 files, 887 tests. Agentic suite: 190 tests. |
| AC10 | PENDING | No task commit/push or matching Railway deployment exists yet, so no post-deploy widget dialogue has been performed. |

## Focused Results

- Search-before-specialist integration: 9/9 PASS.
- Orchestrator after dead repair removal: 110/110 PASS.
- Focused affected suites: 175/175 PASS.
- Static reachability: no deleted repair symbol remains in `src` or `tests`.
- No-regex guard: no new constructs; legacy baseline 514; 15 baseline findings removed.
- Production dependency audit: 0 high-severity vulnerabilities.

## Staged Snapshot Isolation

The exact Git index was exported to a clean temporary snapshot with no `.env` and no unstaged/untracked files. The snapshot passed:

- TypeScript typecheck.
- Full tracked test suite: 84 files, 818 tests.
- Agentic suite: 190 tests.
- Production build.

The release wrapper itself could not run in the exported directory because it intentionally had no `.git` metadata for the no-regex baseline lookup. The standalone no-regex guard passed in the repository, and the staged changes are a subset of that audited diff.

## Post-Live Fix Verification

The failed production audit exposed that a bounded LLM correction received validator issue codes but not the rejected typed decision. The follow-up keeps all validators and the two-attempt bound unchanged, and supplies the rejected decision to the correction call for a targeted LLM-owned repair.

- Focused correction transport tests: 2 files, 113 tests.
- Full release gate: 88 files, 887 tests.
- Exact follow-up index snapshot without `.env`: 84 files, 818 tests; agentic 190; typecheck/build PASS.
- Agentic suite: 190 tests.
- Typecheck, build, no-regex guard, dependency audit, and diff check: PASS.
- New production deployment and widget audit: PENDING.

## Second Post-Live Fix Verification

The second failed production session exposed a structured-schema mismatch and non-actionable correction diagnostics. Generator-load semantic fields required by validation/execution are now required by the model contract, and rejected decisions receive field-specific invariant guidance without any deterministic semantic rewrite.

- Focused affected suites: 4 files, 134 tests.
- Full release gate: 88 files, 888 tests.
- Agentic suite: 191 tests.
- Exact staged snapshot without `.env`: 84 files, 819 tests; agentic 191; typecheck/build PASS.
- Typecheck, build, no-regex guard, dependency audit, and diff check: PASS.
- New production deployment and widget audit: PENDING.

## Artifacts

- `raw/local-verification.md`
- `raw/static-audit.md`
- `problems.md`
- `spec.md`
