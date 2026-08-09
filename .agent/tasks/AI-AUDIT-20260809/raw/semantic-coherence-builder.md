# Semantic coherence builder evidence

Date: 2026-08-09
Mode: BUILD
Owned production surface: `src/ai/agentManagerOrchestrator.ts`
Owned regression surface: `tests/agentManagerOrchestrator.test.ts`, `tests/agentManagerConditionalWebShortCircuit.test.ts`

## Implemented behavior

- `repairIntentForCatalogClarificationBeforeTools` no longer derives semantic ambiguity from message fragments and no longer rewrites a schema-valid typed planner contract. A real clarification remains represented by the planner/answer contracts; deterministic code still validates tools, facts, referents, business rules and answer/card consistency.
- Parallel planning keeps its low-latency pre-delta path when the typed plan matches the applied delta. Current-turn, active-need `hard_requirement` facts are compared by exact typed `factKey` and scalar value against strict planner requirements. `phase` and `power_source` may be represented by their dedicated typed selection fields. A missing, stale or contradictory representation emits `active_requirement_mismatch:<factKey>` and forces exactly one planner call against post-delta ledger state.
- The model input now explicitly identifies whether the ledger already includes the current-turn delta. The production prompt tells a post-delta replan not to re-apply the buyer message and to align the selection policy with active typed hard requirements. The reducer prompt requires stable `factKey`/requirement `kind` identity.
- The orchestrator's answer-product filter consumes `resolvedRequirementEligibilityStatus`. Preliminary unknown candidates are retained when no qualified fact resolves them; resolved violations are excluded. Final-fit unknowns may be satisfied by qualified native weight/phase/nominal-power facts. Nominal active power uses `qualifiedNominalActivePowerKw`; maximum/peak/engine/kVA do not substitute for nominal power.

## Test-first evidence

Former four semantic regression IDs:

1. `replans once when the parallel reducer changes typed hard requirements after the planner read the old ledger`
2. `keeps the parallel planner fast path when its typed hard requirements match the applied delta`
3. `preserves a valid typed catalog plan instead of replacing planner semantics from message fragments`
4. `keeps a schema-valid broad catalog plan planner-owned`

Initial RED for those four: the stale requirement case made one planner call instead of two; both catalog-plan cases lost their typed `catalog.search` plan; the coherent fast path already passed. After the owning-layer change, all four passed. The coherent case now also covers dedicated `phase` and `power_source` fields without duplicate requirements.

Additional RED/GREEN cases:

- `replans once when the reducer adds a new typed hard requirement omitted by the parallel planner`: RED was `expected 2 calls, got 1`; GREEN after the generic missing-representation check.
- `keeps a preliminary candidate when nominal power and weight remain unknown instead of treating max power as nominal`: RED returned no products for a maximum-only product; GREEN retains it as preliminary unknown.
- `still excludes a preliminary candidate with a proven nominal-power violation`: remains GREEN and proves that tri-state handling does not fail open on a qualified violation.
- `uses qualified native facts to resolve unknown final-fit eligibility`: RED returned no products; GREEN accepts native nominal power, weight and phase when the catalog result itself lacks those proof fields.

## Final validation

- Focused semantic suite:
  - `npm.cmd test -- tests/agentManagerOrchestrator.test.ts -t "replans once when the parallel reducer changes|replans once when the reducer adds a new typed hard requirement omitted|keeps the parallel planner fast path|preserves a valid typed catalog plan|keeps a schema-valid broad catalog plan"`
  - Result: exit 0; 5 passed, 142 skipped.
- Focused tri-state consumer suite:
  - `npm.cmd test -- tests/agentManagerConditionalWebShortCircuit.test.ts -t "keeps a preliminary candidate when nominal power|still excludes a preliminary candidate|uses qualified native facts to resolve unknown final-fit eligibility"`
  - Result: exit 0; 3 passed, 57 skipped.
- Full owned target:
  - `npm.cmd test -- tests/agentManagerConditionalWebShortCircuit.test.ts tests/agentManagerOrchestrator.test.ts`
  - Result: exit 0; 2 files, 207 tests passed.
- Connected producer/consumer suites:
  - `npm.cmd test -- tests/agentManagerCardSelection.test.ts tests/agentManagerRequirementProofs.test.ts tests/agentManagerToolRegistry.test.ts tests/openAIAgentManagerModel.test.ts tests/salesManagerSelectionScenarios.test.ts tests/agentManagerConditionalWebShortCircuit.test.ts tests/agentManagerOrchestrator.test.ts`
  - Result: exit 0; 7 files, 313 tests passed.
- `npm.cmd run typecheck`: final exit 0. An intermediate run caught an untyped Vitest spy access in the new assertion; the spy input was typed and the command was rerun successfully.
- `npm.cmd run lint:no-regex`: exit 0; `No new regex constructs. Legacy baseline: 508.`
- `git diff --check`: exit 0; only existing LF/CRLF conversion warnings were printed.

One transient test invocation failed to import `node_modules/undici/index.js` while the shared dependency tree was being refreshed. The file appeared immediately after that concurrent update; the same test and all final suites above then passed.

## Scope and limitations

- No build was run, per integration-owner instruction; the root task will run the aggregate build.
- No commit, push, deployment or production-widget live test was performed in this builder slice. Production behavior therefore still requires the repository's post-push embedded-widget verification.
- The worktree was already broadly dirty and shared. Existing ledger, product-referent, card-selection and requirement-proof edits were preserved; no unrelated file was reverted or cleaned.
- Temporary diagnostic logging and `.scratch/semantic-filter-debug.ts` were removed before final validation.
