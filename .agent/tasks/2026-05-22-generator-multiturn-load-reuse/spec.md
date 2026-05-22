# Task: generator multi-turn load reuse

## Scope

Fix the latest production eval failure where a follow-up generator selection turn searched catalog products without re-running `calculator.generatorLoad`, even though the previous turn had produced a load estimate.

This is a planner-contract fix, not regex or keyword routing.

## Current Behavior

Production eval on `0eb3b03`:
- `generator_load_selection` failed LLM rubric.
- Turn 2 calculated a preliminary generator load profile around 4.5 kW.
- Turn 3 asked for catalog variants under 90k with reserve, but planner ran only `catalog.search`.
- Runtime could not apply generator load fit filtering for that turn and the answer mentioned weak products.

## Structural Improvement

Update the Agent Manager planner instructions:
- In multi-turn generator selection, when history contains a prior load estimate or enough load facts, do not run `catalog.search` alone.
- Re-run `calculator.generatorLoad` in the same turn before `catalog.search` so the current tool results carry `payload.profile.requiredNominalKw`.
- Preserve `bounded_assumption` and missing exact facts when pump/tool data remains approximate.

## Acceptance Criteria

AC1. No new regex constructs are introduced.

AC2. Source guard tests assert the multi-turn generator load instruction exists.

AC3. Clean-index local gates pass.

AC4. After commit and push, Railway marker reaches the new commit.

AC5. Production Promptfoo/widget harness passes with deterministic average > 90%, LLM average > 90%, and no failed cases if achievable.
