# Evidence

## Implementation

- Replaced regex-based self-loading, small-site, and heavy-site plate hint checks in `agentManagerCardSelection.ts` with normalized deterministic fragment checks.
- Kept the behavior scoped to card ranking and catalog safety; no public API or answer behavior contract changed.
- Added public-path unit coverage through `rankCatalogProductsByNumericFit()`.
- Updated the no-regex baseline after reviewing removal of six legacy regex findings from `agentManagerCardSelection.ts`.

## Local Verification

- `npm test -- tests/agentManagerCardSelection.test.ts` - PASS, 12 tests.
- `npm run lint:no-regex` - PASS, legacy baseline is now 1806.
- `npm run typecheck` - PASS.
- `git diff --check` - PASS, CRLF warnings only.
- `npm test` - PASS, 76 files / 612 tests.
- `npm run build` - PASS.

## Notes

- `src/ai/productComparisonResearch.ts` and `tests/productComparisonResearch.test.ts` have separate uncommitted changes that are not part of this pass and were not staged.
- This pass does not need production Promptfoo by itself because it removes regex from deterministic card ranking while preserving the tested ranking behavior. Production behavior validation remains required for later behavior-changing passes.

## Acceptance Criteria Status

- AC1: PASS.
- AC2: PASS.
- AC3: PASS.
- AC4: PASS.
- AC5: PASS.
- AC6: PASS.
