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
