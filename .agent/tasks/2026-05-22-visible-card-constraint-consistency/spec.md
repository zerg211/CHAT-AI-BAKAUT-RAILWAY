# Visible Card Constraint Consistency

## Problem

Production Promptfoo on `39e07e8` returned `4/6` with LLM average below target. The two weak cases were card/text consistency problems:

- generator selection: answer said no suitable options under 90k, but one visible card was 170k;
- plate selection: answer said prioritize 56-70 kg and treated 88 kg as not first choice, but the visible card was the 88 kg model.

## Current Behavior

`selectProductsForVisibleCards` prioritizes answer-mentioned products before applying all structured constraints. That can make a caveat/negative mention become the only visible card.

## Structural Improvement

Keep behavior deterministic and non-regex:

- if a generator budget exists and no selected or same-intent products are within budget, suppress visible generator cards instead of showing over-budget cards;
- if plate weight constraints are inferable from the user/tool semantic context, prefer selected or same-intent products inside that range over answer-mentioned out-of-range products.

This preserves LLM semantics while making visible cards obey hard constraints.

## Acceptance Criteria

- AC1: Generator visible cards are suppressed when every same-intent candidate is over a structured budget.
- AC2: Plate visible cards prefer products inside inferred self-loading/small-site weight range even when an out-of-range product is mentioned in the answer.
- AC3: Existing card selection behavior and generator load safety tests still pass.
- AC4: No regex is added.
- AC5: Local non-OpenAI gates pass.
- AC6: After commit/push/Railway, production Promptfoo returns `6/6` and both averages stay above 90%.
