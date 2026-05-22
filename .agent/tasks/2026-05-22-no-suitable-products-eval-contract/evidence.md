# No Suitable Products Eval Contract Evidence

## Pre-fix production signal

Production Promptfoo on `e94fd24` returned `5/6` while both score gates were above target:

- deterministic average: `0.9076666666666666`;
- LLM average: `0.9500000000000001`;
- failing case: `generator_load_selection`;
- LLM score for the failing case: `0.96`.

The final answer correctly refused to show generator cards because the catalog search did not produce safe in-budget options. Deterministic assertions failed because the scenario always required at least one card and literal final-answer completion text.

## Change

Added an opt-in `allowNoSuitableProductOutcome` eval path. It accepts a no-card product-selection outcome only when structured metadata proves:

- product class is known;
- catalog/search/select tooling ran;
- visible cards were blocked by selection readiness;
- the final answer explains that no safe/suitable/budget-fitting option should be shown.

This is an eval-contract stabilization only. Production behavior is unchanged.

## Local checks

- `npm test -- tests/promptfooAssertions.test.ts`: PASS, 6 tests.
- `npm run lint:no-regex`: PASS, legacy baseline `1794`, no new regex constructs.
- `git diff --check`: PASS.
- Offline deterministic regrade of `generator_load_selection` from `.agent/tasks/2026-05-22-visible-card-continuity/production-evals-after-e94fd24.json`: PASS for all five JavaScript assertions.
- `npm run typecheck`: PASS.
- Negative coverage: PASS. Missing visible cards still fail when `allowNoSuitableProductOutcome` is not enabled.
- `npm test`: PASS, 76 files, 626 tests.
- `npm run build`: PASS.

## Acceptance criteria

- AC1: PASS. Offline regrade proves `generator_load_selection` deterministic assertions pass for the structured no-suitable-products outcome.
- AC2: PASS. The relaxed path is opt-in via `allowNoSuitableProductOutcome`, and unit coverage proves missing cards still fail without opt-in.
- AC3: PASS. Unit coverage proves product-class completion from metadata works without literal final product text.
- AC4: PASS. `npm run lint:no-regex` reports no new regex constructs.
- AC5: PASS. Local non-OpenAI gates passed.
- AC6: PENDING. Requires commit, push, Railway marker, then production Promptfoo.
