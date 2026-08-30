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

## Eighth Production Failure

Commit `5e18d505950654c1791c6d8eafd674419b8bb158` deployed exactly, but widget session `4bf4478c-dd95-467e-8d24-9f281e1912a1` had one empty failed turn when the buyer asked about availability and delivery for the selected generator and plate. Generator and plate selection turns returned cards, the following form-offer turn completed, and lead capture and the buyer goal both passed, but AC10 requires zero buyer/code issues.

The failed turn `83e9c047-eabd-47c0-afcd-4a654f4ec712` exhausted three semantic candidates. The final issues were `opened_need_action_mismatch:continue` and `required_tool_request_missing:lead.capture`. The generic missing-tool correction told the LLM to add every tool named by `grounding.requiredToolKinds`, but an availability handoff without a supplied or authorized contact must instead remove `lead.capture` from the executable plan and let the writer offer the form. No wall-time, catalog, writer, or lead-persistence failure occurred.

Resolved locally: the planner now distinguishes a form offer from authorized lead execution, the lead-specific correction no longer inherits the generic add-the-tool instruction, and `need.opened`/`needAction` mismatches receive exact structural repair guidance. Deterministic lead authorization and denial remain unchanged. Focused tests, the full release gate, exact-index verification, and a fresh verifier pass. AC10 still requires exact deployment and a successful widget/admin audit.

## Ninth Production Failure

Commit `8fe9d7759af90bf72a1f56ebab5f3a22364ca08a` deployed exactly. Widget session `4fa03331-1802-43d9-baca-8132f636b7fd` confirmed the availability/delivery repair: that turn answered correctly, the next form handoff completed, lead capture passed, and the overall buyer goal passed. AC10 still failed because the earlier plate-plus-accessory catalog turn returned no answer.

The failed turn `3d12b999-229f-48ec-9c15-6eeaebf7553f` asked for 80–100 kg plates and information about a paving mat. All three semantic candidates kept a primary `plate` selection policy and a separate `plateAccessory` catalog request. Deterministic validation rejected every candidate with `catalog_tool_product_class_mismatch:mat_search:plateAccessory:plate`; attempt 1 also lacked conditional research. The final attempt still had 105636 ms remaining, so this was not a budget or tool failure.

Root cause: code incorrectly required every catalog request to match the one primary selection class, replacing dialogue context with a single-class assumption. Resolved locally by allowing a secondary request class only when the LLM contract explicitly authorizes that class through a current-message target product mention with exact evidence. Unexplained cross-class requests remain rejected. The planner and correction prompts describe the required structured result; no raw-text or accessory keyword inference was added. Focused tests, the full release gate, and exact-index verification pass; a fresh verifier remains required.

The first fresh verifier returned `NOT_PASS` on that initial exception. It could allow a secondary-only catalog plan to satisfy the primary selection, visible cards could depend on tool order, and web research consumed a mixed global product pool. The smallest follow-up now requires a primary-class catalog request, uses the primary `selectionPolicy` before tool order for cards, and scopes web candidates plus catalog-completion evidence to the web request's typed class. Positive and negative multi-class validation, secondary-first card filtering, and mixed-pool web scoping tests pass. Exact-index verification passes; a second fresh verifier remains required.

The second fresh verifier also returned `NOT_PASS`. It found that `catalog.getProductDetails` could return a product whose actual catalog class contradicted the request, unfamiliar LLM-owned class labels were rejected because only the canonical enum was executable, web target names and prior completion were not completely bound to each request class, and the tests did not execute those boundaries end to end.

Resolved locally: known-class detail results are filtered against actual catalog identity before entering tool results or cards; unfamiliar classes use exact typed keys instead of being coerced to a known class; named and empty-name web requests require typed class authorization; and unfamiliar web candidate pools use matching tool-result provenance. New execution tests cover mismatched detail IDs and mixed unfamiliar catalog/web classes. Focused suites pass 260 tests, the full release gate passes 903 tests, and the exact staged snapshot passes 834 tests plus 200 agentic tests. A third fresh verifier remains required.

The third fresh verifier returned `NOT_PASS` because a web request with neither canonical class nor typed `productIntent` still used null as a wildcard over prior request completion and the accumulated product pool. It also required mixed valid/conflicting `getProductDetails` execution coverage and a web execution case where the only successful prior catalog result belongs to another unfamiliar class.

Resolved locally: product-scoped web requests now fail validation without a typed class; null class keys match no prior request and can consume only products fetched by their own web lookup; `unknown` is not treated as an unfamiliar class label. The details regression now returns one valid generator plus one conflicting accessory and proves only the generator reaches the writer/cards. The unfamiliar web regression makes the explicit primary catalog request fail while the secondary class succeeds, then proves web execution performs its own primary lookup and receives no secondary products. Full, focused, agentic, and exact-index checks pass; a fourth fresh verifier remains required.

The fourth fresh verifier returned `NOT_PASS` because an unfamiliar secondary catalog request could still inherit the known primary `ProductIntent` during execution, causing the structured primary policy to filter the secondary lookup. It also found that card scoping for an unfamiliar primary class could infer and adopt a known secondary tool class instead of retaining primary catalog-result provenance.

Resolved locally: unfamiliar typed request classes now remain exact through catalog execution instead of falling back to the primary class; structured primary policy is passed only for requests targeting the primary selection class; and unfamiliar-primary cards are limited to IDs returned by primary catalog tools. Execution regressions cover known-primary plus unfamiliar-secondary search and unfamiliar-primary plus known-secondary card provenance. Focused suites pass 263 tests, the full release gate passes 906 tests, and the exact staged snapshot passes 837 tests plus 203 agentic tests. A fifth fresh verifier remains required.

Final resolution: the fifth verifier passed AC1-AC9 with no findings. Commit `afe7f61bbb03555f4d910a70b14e50771e427abc` deployed exactly, and widget session `ff38ed11-0d08-44e7-b44c-2c3c6ec3c093` completed six turns with zero buyer/code/goal/lead issues. The mixed plate/accessory turn executed without class mismatch; its timed-out accessory web lookup remained explicitly unconfirmed rather than becoming a false compatibility claim. The lead form persisted successfully with `sent_email`. AC10 and the overall task now pass.
