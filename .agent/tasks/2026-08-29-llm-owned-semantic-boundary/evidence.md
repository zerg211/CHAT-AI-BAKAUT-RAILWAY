# Verification Evidence

Task: `2026-08-29-llm-owned-semantic-boundary`
Verified at: `2026-08-29T10:56:17.375Z`
Baseline HEAD: `0d12930b1c1850b68ddfad5f61f36c3f624dd63b`
Current verdict: `PENDING`

The implementation and all local checks are complete, but the task is not done until AC10 passes on the exact pushed Railway deployment through a fresh widget dialogue at `https://bakautprof.ru/`.

## Acceptance Criteria

| AC | Local verdict | Evidence |
| --- | --- | --- |
| AC1 | PASS | The production `agent_manager` runtime accepts one typed `AgentSemanticDecision`; the deleted semantic repair symbols and `planner_repaired_*` paths have no matches in `src`. `inferProductIntent` has no production caller and remains only in a legacy test-fixture adapter. Catalog product classification still operates only on catalog facts and typed product classes. |
| AC2 | PASS | `semanticAuthorityIssues` rejects missing/inconsistent selection authority. Runtime permits one initial LLM semantic decision plus at most two bounded corrections, then throws `AgentSemanticDecisionIncoherentError` before tools. The HTTP route classifies that error as non-retryable, so it cannot reset the turn budget. |
| AC3 | PASS | Semantic mutation helpers for electric start, preliminary/final fit, stale targets, open-ended requirements, grounding, catalog promotion, and typed coverage were removed. Recovered decisions are revalidated rather than normalized. |
| AC4 | PASS | Generator calculation consumes typed load kind, operation mode, running/starting values, and provenance. `tests/agentManagerGeneratorLoad.test.ts` and semantic-decision tests pass. |
| AC5 | PASS | Missing research planning is rejected by the semantic validator. Premature specialist/lead plans fail closed unless exact persisted source-exhaustion provenance is proven. `agentManagerSearchBeforeSpecialistIntegration.test.ts`: 9/9 PASS. |
| AC6 | PASS | Full card-selection suite confirms unknown mandatory attributes remain preliminary while proven conflicts are excluded. `agentManagerCardSelection.test.ts`: 63/63 PASS. |
| AC7 | PASS | Deterministic schema, evidence, catalog identity, filtering, ordering, arithmetic, lead authorization, persistence, checkpoints, and tool execution remain active; full release gate passes. |
| AC8 | PASS | Writer structured output requires `selectionRationale`; pre-send review blocks selected product IDs without a non-empty LLM rationale; product cards receive only that rationale. Always-null `replacementProductEvidence` metadata was removed. |
| AC9 | PASS | `npm run verify`, standalone no-regex guard, focused integration suites, typecheck, build, and `git diff --check` pass on current files. Full suite: 88 files, 895 tests. Agentic suite: 193 tests. |
| AC10 | PENDING | The current repair still needs an exact matching Railway deployment and a fresh post-deploy widget dialogue with buyer/admin audit. |

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

## Fresh-Verifier Budget Fix

A fresh verifier found that route-level retry could rerun an exhausted semantic decision with fresh counters and that three planner deadlines did not preserve downstream work time. Semantic incoherence is now non-retryable at the route, and all planner attempts use the shared turn budget with a 45-second tools/writer reserve.

- Focused affected suites: 5 files, 140 tests.
- Full release gate: 88 files, 891 tests.
- Agentic suite: 192 tests.
- Typecheck, build, no-regex guard, dependency audit, and diff check: PASS.
- Exact staged snapshot without `.env`: 84 files, 822 tests; agentic 192; typecheck/build PASS.
- Fresh read-only verifier: PASS for AC1-AC9; safe to commit for a new AC10 production attempt.

## Third Post-Live Fix Verification

Production traces showed that one correction could expose a second independent contract invariant. Diagnostics now identify exact mismatched load fields, generator scenarios receive explicit typed-tool binding guidance, and the bounded planner path allows two correction attempts while retaining the shared wall-time/provider budgets and fail-closed outcome.

- Focused affected suites: 4 files, 134 tests.
- Full release gate: 88 files, 889 tests.
- Agentic suite: 191 tests.
- Exact staged snapshot without `.env`: 84 files, 820 tests; agentic 191; typecheck/build PASS.
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

## Fourth Production Audit

- Exact deployed commit: `f7ee0ef3d6e4e9645fedbbe8ebff8ba1f3107109`.
- Widget session: `990bb45f-d0e3-4139-9c10-b0dccf25da49` on `https://bakautprof.ru/`.
- Eight of nine turns returned buyer-visible answers; generator and plate cards were shown. One generator-selection turn failed after three semantic attempts, so AC10 remains PENDING.
- Trace sequence showed correction regression: attempt 1 failed research planning/typed requirement, attempt 2 repaired those but lost the pump load, and attempt 3 restored the load while reintroducing research planning failure and changing `source`.
- Follow-up sends accumulated prior validator issues to the LLM as a non-regression constraint while validating only the current candidate. Focused suites: 2 files, 114 tests; full gate 88 files / 891 tests; agentic 192; typecheck/build/no-regex/dependency audit PASS. Exact staged snapshot without `.env`: 84 files / 822 tests, agentic 192, typecheck/build PASS. Fresh read-only verifier: PASS for AC1-AC9.

## Fifth Production Audit

- Exact deployed commit: `a50f70e96adb444949129ab1732c313b13f2f257`.
- Widget session: `37924cf9-44d4-43bb-aade-fdcea4939079` on `https://bakautprof.ru/`.
- Seven of eight turns returned buyer-visible answers; generator and plate cards were shown and lead was captured. One initial turn failed after three semantic attempts with `required_tool_request_missing:calculator.generatorLoad` and `typed_requirement_tool_mismatch:req_loads`, so AC10 remains PENDING.
- Trace shows first attempt created hard fact `generator_loads` without matching policy, second introduced product mention hallucinations, third fixed mentions but reintroduced calculator mismatch. The follow-up adds explicit guidance for `generator_loads` vs `generator_load_scenario` and for missing calculator tool while keeping cumulative history. Focused suites: 2 files, 115 tests; full gate 88 files / 892 tests; agentic 192; typecheck/build/no-regex/dependency audit PASS. Exact staged snapshot without `.env`: 84 files / 823 tests, agentic 192, typecheck/build PASS. Fresh read-only verifier: PASS for AC1-AC9.

## Writer FactsUsed Sanitization

- Exact deployed commit: `7908deb8a8bd492072bb22a4e83a1248cf99930b` had one empty turn due to writer `factsUsed` empty `sourceEventIds`.
- Widget session: `79ba351c-d491-41cd-8e2e-5e8df1126d0a` on `https://bakautprof.ru/`.
- Eight of nine turns returned buyer-visible answers; plate switch turn failed after semantic decision succeeded, with ZodError for `factsUsed` `sourceEventIds` `too_small`. The follow-up sanitizes writer `factsUsed` by filtering entries with empty `sourceEventIds` in `parseAnswerContractModelOutput`, keeping deterministic planner validation fail-closed. Focused suites: 3 files, 131 tests; full gate 88 files / 892 tests; agentic 192; typecheck/build/no-regex/dependency audit PASS. Exact staged snapshot without `.env`: 84 files / 823 tests, agentic 192, typecheck/build PASS. Fresh read-only verifier: PASS for AC1-AC9.

## Preliminary Load And Requirement Shape Follow-Up

- Exact deployed commit `f8d0baae77f3c31007d7a2dd86680f35cd6be3c5` was exercised through the widget in session `5de0bdbc-c227-4204-8bf4-f2187ff60fc0`.
- Six turns returned answers without generator cards; three later catalog turns timed out, so AC10 remains PENDING.
- Admin metadata showed an invalid numeric strict requirement (`nominal_power_kw=true`) escaped pre-tool validation. Later valid preliminary decisions were blocked because one omitted lighting value incorrectly marked the otherwise bounded calculation as `generator_load_unbounded_guess`.
- The follow-up rejects invalid strict requirement shapes before tools and keeps omitted load values as incomplete, not unbounded. Final-fit safety remains fail-closed; incomplete preliminary calculations retain explicit caveats. Focused suites: 6 files / 204 tests; full gate: 88 files / 894 tests; agentic 192; typecheck/build/no-regex/dependency audit PASS. Exact staged snapshot without `.env`: 84 files / 825 tests, agentic 192, typecheck/build PASS. Fresh read-only verifier: PASS for AC1-AC9.

## Availability Handoff Repair Guidance

- Exact deployed commit `5e18d505950654c1791c6d8eafd674419b8bb158` was exercised through the widget in session `4bf4478c-dd95-467e-8d24-9f281e1912a1`.
- Generator and plate selections returned cards, and the buyer goal and final lead audit passed. The availability/delivery turn returned no answer after three invalid semantic candidates, so AC10 remains PENDING.
- Final validator issues were `opened_need_action_mismatch:continue` and `required_tool_request_missing:lead.capture`. The generic correction guidance could incorrectly push the LLM toward adding lead execution even though no contact was authorized.
- The follow-up gives `lead.capture` a dedicated LLM repair path: without an authorized contact it removes executable lead fields and preserves a form-offer handoff; with authorization it emits a required lead request. It also explains how to reconcile a real new need with `needAction`, or update an existing need without `need.opened`. Deterministic validators and lead authorization are unchanged.
- Focused suites: 2 files / 116 tests; full gate: 88 files / 895 tests; agentic 193; typecheck/build/no-regex/dependency audit PASS. Exact staged snapshot without `.env`: 84 files / 826 tests, agentic 193, typecheck/build PASS. Fresh read-only verifier: PASS for AC1-AC9; AC10 PENDING.
