# Evidence: failed web research grounding

## Local checks

- `npx vitest run tests/agentManagerComparisonResearch.test.ts tests/agentManagerIntegrationSource.test.ts tests/productComparisonResearch.test.ts` - PASS, 28 tests.
- `npm run typecheck` - PASS.
- `npm run lint:no-regex` - PASS, no new regex constructs.

## Pre-fix production finding

- Production marker before the fix: `a81477de79833586faa54e9e1c47850be00f2314`.
- Live widget conversation: `#1560`, session `6ff743d9-1d1f-4258-abf4-59b956d2c5e3`.
- Buyer asked only a technical question about SUNREKA G7000iS start method.
- Catalog-presence noise was absent, but `web.researchProductFacts` failed with `status="error"` and the answer still cited request `web1` as evidence for exact start-method facts.

## Code evidence

- `answerEvidenceSourceHints` now exposes only `ok` tool results as fact source ids.
- `normalizeAnswerEvidenceSources` now trusts only ledger facts and `ok` tool results for `factsUsed`.
- Pre-send review now detects `failed_tool_result_used_as_fact_source`.
- If the failed source is exact web research, the final answer is rewritten to avoid a categorical exact technical claim from failed evidence.
- Final answer metadata removes facts that cited failed tool results.
- Exact-target product comparison research now receives a scoped higher output budget to reduce JSON truncation/parse failures.

## Pending production verification

- Commit/push and Railway marker check are required before the post-fix live widget test.
