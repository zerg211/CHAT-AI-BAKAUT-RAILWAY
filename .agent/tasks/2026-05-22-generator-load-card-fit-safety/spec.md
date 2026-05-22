# Generator Load Card Fit Safety

## Problem

Production Promptfoo after `22d1cb8` failed `generator_load_selection`. The SSE provider worked, but the assistant showed weak in-budget generator cards after `calculator.generatorLoad` produced a structured requirement of about 7 kW nominal. The answer said those cards were weak, but visible cards still contradicted the current calculated load profile.

## Current Behavior

When `catalog.search` runs after `calculator.generatorLoad`, catalog results are ranked by query text and budget constraints, but the structured load profile is not applied as a hard visible-card safety filter. If the budget only returns weaker generators, those cards can still be shown.

## Structural Improvement

Use the structured `calculator.generatorLoad.payload.profile.requiredNominalKw` result as a deterministic catalog/card safety constraint for generator catalog searches:

- keep products that meet the calculated nominal requirement, with small tolerance for nominal/max ratings;
- drop products below the calculated load from visible catalog results;
- if no products meet the load, return no cards and warn that catalog candidates were filtered by load.

This is deterministic fact checking over structured tool output, not semantic buyer-intent matching or regex text parsing.

## Acceptance Criteria

- AC1: Generator catalog results below structured `requiredNominalKw` are not returned as visible products.
- AC2: Fitting generator products remain visible.
- AC3: If all generator candidates are below the structured load, the catalog tool result is `not_found` and carries a generator-load-fit warning.
- AC4: No regex is added.
- AC5: Local non-OpenAI gates pass.
- AC6: After push/Railway, production Promptfoo returns deterministic and LLM averages above 90%; target 6/6.
