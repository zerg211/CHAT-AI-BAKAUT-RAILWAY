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
- AC4: PASS. Commit `aa20662` reached Railway.
- AC5: PASS. Production Promptfoo/widget harness passed.

## Production Eval After `aa20662`

- `npm run evals -- --no-cache -j 1 -o .agent/tasks/2026-05-22-visible-card-grounded-catalog-answer/production-evals-after-aa20662.json`: PASS.
- Pass/fail: 6/6.
- Deterministic average: 0.9923333333333333.
- LLM average: 0.9583333333333331.
- Assertion pass rate: 33/33.
- `plate_retrieval_grounding`: PASS, LLM score 0.96, 2 cards.
- `web_required_technical_grounding`: PASS, `web.researchProductFacts` present.

## Latest-Main Recheck After `0eb3b03`

- `npm run evals -- --no-cache -j 1 -o .agent/tasks/2026-05-22-visible-card-grounded-catalog-answer/production-evals-after-0eb3b03.json`: FAIL.
- Pass/fail: 5/6.
- Deterministic average: 0.9830555555555556.
- LLM average: 0.9016666666666667.
- Remaining failed case: `generator_load_selection`.
- Root cause: the follow-up turn searched catalog without a same-turn `calculator.generatorLoad`, so weak generator products could be mentioned without current load-fit filtering.

Follow-up task: `.agent/tasks/2026-05-22-generator-multiturn-load-reuse/`.
