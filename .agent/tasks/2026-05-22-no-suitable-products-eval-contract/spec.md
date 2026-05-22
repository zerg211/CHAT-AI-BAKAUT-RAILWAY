# No Suitable Products Eval Contract

## Problem

Production Promptfoo on current `main` (`e94fd24`) returns `5/6` while both score gates pass:

- deterministic average: `0.9076666666666666`;
- LLM average: `0.9500000000000001`.

The failing case is `generator_load_selection`. The LLM judge scored it `0.96`; the assistant correctly refused to show visible generator cards because the catalog search did not produce safe in-budget options. Deterministic assertions still require at least one card and literal completion text, so the scorecard treats a valid "no suitable products" outcome as a failure.

## Current Behavior

`assertRetrievalGrounding` treats every product-selection scenario with `expectCards: true` as a hard card requirement. `assertSupportAnswerQuality` and `assertAgentTaskCompletion` also require literal final-answer pattern matches even when structured metadata already proves the product class and the final turn is a blocked-card no-suitable-products outcome.

## Structural Improvement

Add an explicit eval-contract path for product-selection scenarios where:

- the assistant completed without runtime failure;
- structured metadata says the current product class is known;
- catalog/search tooling ran;
- selection readiness blocked visible cards;
- the answer explains that no safe/suitable/budget-fitting option should be shown yet.

This is eval stabilization over structured metadata, not production behavior change and not regex.

## Acceptance Criteria

- AC1: `generator_load_selection` can pass deterministic assertions when it has a structured no-suitable-products outcome with no visible cards.
- AC2: The relaxed path is opt-in per scenario and does not weaken card requirements globally.
- AC3: Product class completion can be proven from metadata for the no-suitable-products path.
- AC4: No regex is added.
- AC5: Local non-OpenAI gates pass.
- AC6: After commit/push/Railway, production Promptfoo deterministic and LLM averages stay above 90%; target `6/6`.
