# Evidence: catalog presence relevance

## Changes verified

- `researchGuidanceSafeRewrite` now receives the planner intent and appends present catalog presence only when `riskFlags` contains `answer_policy_catalog_presence_relevant`.
- Planner prompt instructs the LLM to add that policy flag only when the buyer actually asks about our catalog/availability/order/price or needs catalog alternatives.
- Answer prompt blocks "у нас есть в каталоге" for pure technical exact-model answers unless that policy flag is present.
- Approved style example no longer includes the catalog-presence sentence in a pure technical answer.

## Commands

```powershell
npx vitest run tests/agentManagerComparisonResearch.test.ts tests/agentManagerIntegrationSource.test.ts tests/productComparisonResearch.test.ts
```

Result: PASS, 3 files, 27 tests.

```powershell
npm run typecheck
```

Result: PASS.

```powershell
npm run lint:no-regex
```

Result: PASS, no new regex constructs.

## Production

Not yet run for this change.
