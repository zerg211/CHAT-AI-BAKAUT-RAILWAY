# Evidence: Unconfirmed Generator Load Answer Clause

## Baseline

- Production eval source: `.agent/tasks/2026-05-22-no-suitable-products-eval-contract/production-evals-after-03e9fcc.json`
- Result: `5/6`
- Deterministic average: `0.9828333333333333`
- LLM average: `0.9083333333333333`
- Failing case: `vague_generator_no_cards_before_load_profile`
- Bottleneck: final answer presented `5 kW` / `6-7 kW` as a recommendation while tool warnings showed `generator_load_bounded_basis_incomplete` and `generator_load_unbounded_guess`.

## Change

- Added `generator_unconfirmed_load_no_numeric_selection` required response clause when `calculator.generatorLoad` returns an unconfirmed/unbounded basis.
- Compose prompt now says this clause overrides calculator profile values.
- Review prompt now requires rewrite if the answer presents a numeric kW recommendation or range as the selection answer under that clause.
- Existing card suppression stays deterministic and unchanged.

## Local Checks

- `npm test -- tests/agentManagerOrchestrator.test.ts`: PASS, 27 tests.
- `npm run lint:no-regex`: PASS, no new regex constructs, legacy baseline 1794.
- `git diff --check`: PASS, only line-ending warnings.
- `npm run typecheck`: PASS.
- `npm test`: PASS, 76 files, 628 tests.
- `npm run build`: PASS.

## Acceptance Criteria

- AC1: PASS. The orchestrator creates a required response clause for unconfirmed generator load tool results.
- AC2: PASS. The updated orchestrator test asserts the clause reaches compose and review input.
- AC3: PASS. Existing generator card safety assertions still pass in the same test.
- AC4: PASS. `lint:no-regex` reports no new regex constructs.
- AC5: PASS. Local non-OpenAI gates passed.
- AC6: PASS. Production Railway marker reached commit `8093c8a`, then production Promptfoo passed.

## Production Check

- Command: `npm run evals -- --no-cache -j 1 -o .agent/tasks/2026-05-22-unconfirmed-generator-load-answer-clause/production-evals-after-8093c8a.json`
- Base URL: `https://chat-ai-production-3057.up.railway.app`
- Page URL: `https://bakautprof.ru/?agentHarness=1`
- Result: `6/6`
- Deterministic average: `0.9921666666666665`
- LLM average: `0.9566666666666666`
- Summary: `.agent/tasks/2026-05-22-unconfirmed-generator-load-answer-clause/production-evals-after-8093c8a.summary.json`
