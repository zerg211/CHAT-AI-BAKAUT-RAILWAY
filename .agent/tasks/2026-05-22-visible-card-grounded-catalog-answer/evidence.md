# Evidence: visible-card grounded catalog answer

## Change

Updated Agent Manager answer and review instructions for catalog selection:
- list only the strongest 1-3 products rather than the full returned catalog;
- treat every named product as a visible recommendation candidate;
- mention dimensions, weights, prices, and specs only when present in the provided product context.

This is a contract-level grounding improvement and adds no regex.

## Local Validation

- `npm test -- tests/agentManagerIntegrationSource.test.ts`: PASS, 10 tests.
- `npm run lint:no-regex`: PASS, baseline 1767.
- `npm run typecheck`: PASS.
- `npm run build`: PASS.
- `git diff --check`: PASS.

`npm test` initially failed in unrelated unstaged local source/test files for product comparison research. After staging this pass and temporarily stashing those unrelated unstaged changes with `git stash --keep-index`, the full unit suite passed: 78 files, 648 tests.

Additional regression guard:
- `npm test -- tests/agentManagerComparisonResearch.test.ts`: PASS, 9 tests.
- This required restoring the catalog-present line behavior already expected by current tests.

## Acceptance Criteria Status

- AC1: PASS. No new regex constructs.
- AC2: PASS. Source guard test asserts the catalog-answer grounding instruction.
- AC3: PASS. Focused/source/no-regex/typecheck/build checks passed, and clean-index full test passed.
- AC4: PENDING. Needs commit, push, and Railway marker.
- AC5: PENDING. Needs production Promptfoo/widget harness after deploy.
