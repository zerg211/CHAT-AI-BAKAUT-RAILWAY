# Verification Problems

## AC10 Failed Production Audit

Commit `af020f228e2058612ffc02c39f6e60070cdd2dd9` deployed successfully, but the fresh widget session `78cf118b-fd3b-45bf-b654-1cd143f4e1fb` failed AC10. Turns 4-8 ended with `agent_manager_generation_failed`; no assistant message or cards were visible on those turns.

Admin traces show that the strict validator correctly rejected incoherent decisions. The bounded correction call received only issue codes, not the rejected typed decision, so it generated a new independent interpretation rather than repairing the invalid fields. Across the failed attempts this changed errors between missing catalog/web requests, missing generator-load provenance, requirement coverage mismatches, and ledger/intent mismatches.

AC10 remains blocked until the rejected decision is supplied to the LLM correction call, the minimal fix is locally verified and deployed, and a new widget dialogue plus admin audit passes with zero buyer/code issues.

The follow-up commit `71c30a070f4d3b985bd88c84d99898569fbab946` deployed, but session `359b8cf9-0a20-45ae-9ca7-4fd48bde957e` also failed: turns 2-9 had no assistant message. Supplying the rejected decision reduced some issue sets but exposed a schema mismatch (`source=null` was allowed by structured JSON while validation/execution require provenance) and insufficiently actionable validator issue codes. The next fix aligns the typed schema and supplies field-specific repair guidance without weakening validation.

Commit `08eebebed0dd8474d9d93960d24b745972ab399f` aligned provenance schema and restored clarification turns, but session `7c53864a-4e20-4f67-ba61-774210229ec8` still failed on selection. Traces converged to `active_requirement_mismatch:generator_load_scenario` and a boiler load-semantics mismatch. The first correction often fixed conditional research and only then exposed one of these deeper invariants. The next fix adds exact mismatch field names, explicit typed binding guidance, and one additional bounded correction inside the existing wall-time budget.

## Worktree Isolation

The repository contains many unrelated modified and untracked files from parallel workstreams. The task commit must stage only reviewed LLM-boundary files and this task's artifacts; unrelated retrieval, V2, SQL, client, agent-configuration, and temporary files must remain untouched.

## Fresh Verifier Findings

The first fresh verification of the three-attempt patch returned `NOT_PASS`: `AgentSemanticDecisionIncoherentError` was still eligible for the generic HTTP-route retry, which could create a fresh budget, and three 45-second planner attempts did not reserve downstream tools/writer time. The minimal fix makes semantic incoherence non-retryable and derives every planner deadline from the shared turn budget with a 45-second downstream reserve. Focused tests and the full release gate now pass; exact-index and fresh re-verification remain required before commit.

Resolved locally: the exact staged snapshot passed 84 files / 822 tests, agentic 192, typecheck and build, and a second fresh verifier returned `PASS` for AC1-AC9. AC10 remains pending until exact deployment and widget/admin audit.

## Fourth Production Failure

Commit `f7ee0ef3d6e4e9645fedbbe8ebff8ba1f3107109` deployed exactly, but widget session `990bb45f-d0e3-4139-9c10-b0dccf25da49` still had one empty failed turn. The other eight turns completed, including generator and plate cards, so the prior systemic empty-turn failure was substantially reduced but AC10 did not pass.

The failed turn `63e96ca0-9215-4531-81b1-4adb0d92b1f4` had enough time remaining and exhausted three semantic candidates. Validation oscillated across attempts instead of monotonically repairing: `conditional_research_plan_missing` and `active_requirement_mismatch:generator_load_scenario`; then missing/unexecutable pump load; then `conditional_research_plan_missing` plus pump `source` mismatch. The next fix gives the LLM accumulated validator issue history as a non-regression constraint while the deterministic validator continues to judge only the current candidate.

Resolved locally: cumulative issue history is transported only to the LLM repair context, every current candidate is fully revalidated, and a fresh verifier returned `PASS` for AC1-AC9. AC10 remains pending until the next exact deployment and widget/admin audit.

## Fifth Production Failure

Commit `a50f70e96adb444949129ab1732c313b13f2f257` deployed exactly, but widget session `37924cf9-44d4-43bb-aade-fdcea4939079` still had one empty failed turn at the first clarification. The other seven turns completed, including three generator cards, four plate cards, and a successful lead capture, so the dialogue overall progressed but AC10 did not pass.

The failed turn `bdab556e-a2cb-4592-8277-3534ad4685b9` exhausted three semantic candidates: attempt 1 created hard fact `generator_loads` without matching policy and missed catalog, attempt 2 fixed catalog but hallucinated five product mentions, attempt 3 fixed mentions but missed `calculator.generatorLoad` for `req_loads`. The next fix adds explicit guidance for `generator_loads` vs `generator_load_scenario` and for missing calculator tool while preserving cumulative history.

Resolved locally: additional LLM-only guidance for `generator_loads` and missing calculator is staged, every candidate is still fully revalidated, and a fresh verifier returned `PASS` for AC1-AC9. AC10 remains pending until exact deployment and widget/admin audit.

## Sixth Production Failure

Commit `7908deb8a8bd492072bb22a4e83a1248cf99930b` deployed exactly, but widget session `79ba351c-d491-41cd-8e2e-5e8df1126d0a` still had one empty failed turn at the plate switch. The other eight turns completed, including two generator cards, two plate cards, and a successful lead capture.

The failed turn `5532bcff-d90e-4e4c-ba2b-37a79d661534` succeeded on semantic decision (attempt 1 valid) but writer produced 3 `factsUsed` entries with empty `sourceEventIds`, failing `AnswerContractSchema` validation (`too_small` at `factsUsed.*.sourceEventIds`). Remaining wall time was ample, so this was writer schema hallucination, not budget exhaustion. The next fix sanitizes writer `factsUsed` by filtering entries with empty `sourceEventIds` in `parseAnswerContractModelOutput`, keeping planner validation fail-closed.

Resolved locally: writer factsUsed sanitization filters empty sourceEventIds, every candidate still fully revalidated, and a fresh verifier returned `PASS` for AC1-AC9. AC10 remains pending until exact deployment and widget/admin audit.

## Seventh Production Failure

Commit `f8d0baae77f3c31007d7a2dd86680f35cd6be3c5` deployed exactly, but widget session `5de0bdbc-c227-4204-8bf4-f2187ff60fc0` did not complete the buyer goal. Six turns returned answers without generator cards, then three catalog turns failed with `agent_manager_generation_aborted_or_timeout`; the live command was stopped after 20 minutes without a completed protocol.

The first selection decision contained an invalid strict numeric requirement (`nominal_power_kw` with `value=true`) that was not rejected before tools and caused every candidate to be suppressed. Later turns used a bounded estimate for known loads plus an unknown lighting value; `loadsFromArgs` incorrectly added `generator_load_unbounded_guess` for the omitted lighting value, so deterministic readiness suppressed all preliminary cards despite `selectionGoal=preliminary_fit`. Repeated catalog requests eventually stalled after `tool_started:catalog.search`; no writer failure occurred.

Resolved locally: omitted values now remain `generator_load_bounded_basis_incomplete` without falsely marking the calculated known loads unbounded, while final fit remains blocked. Invalid strict requirement shapes are rejected before tools and returned to the bounded LLM correction loop with explicit guidance. Focused/full gates, the exact staged snapshot, and a fresh verifier pass. AC10 still requires exact deployment and a successful widget/admin audit.
