# Task: catalog-present line regression

## Scope

Fix the current `main` unit regression where exact-model research safe rewrites no longer include the catalog-present line for `catalogPresence.status="present"`.

This is not a regex or keyword fix. It restores a deterministic response-clause behavior already covered by existing tests: when checked research says the exact model is present in the BAKAUT catalog, the safe rewritten answer should include a concise catalog-present sentence.

## Acceptance Criteria

AC1. No new regex constructs are introduced.

AC2. Existing `tests/agentManagerComparisonResearch.test.ts` passes.

AC3. Full local tests pass on a clean-index state.

AC4. The fix remains compatible with the visible-card grounded catalog answer instructions.
