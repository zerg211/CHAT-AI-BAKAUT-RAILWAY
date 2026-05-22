# Budget Fallback Card Selection

## Problem

Production Promptfoo after `28e806c` still failed `generator_load_selection` because the assistant showed catalog cards above the buyer's stated 90k budget. The deterministic checks passed, but the LLM judge correctly marked the answer as inconsistent with the buyer's budget constraint.

## Current Behavior

`selectProductsForVisibleCards()` first prefers products mentioned in the answer. Budget filtering is then applied only to that selected subset. If the answer mentioned only over-budget products, card selection keeps those over-budget cards even when the catalog result set also contains in-budget candidates.

## Structural Improvement

Treat an explicit budget as a hard card visibility constraint when in-budget catalog candidates exist for the same product intent. If answer-mentioned products are all above budget, fall back to matching in-budget catalog candidates instead of reinforcing the answer model's over-budget picks. If no in-budget catalog candidates exist at all, preserve the existing behavior and keep nearest over-budget orientation cards.

## Acceptance Criteria

- AC1: When selected/mentioned products exceed budget but same-intent catalog candidates exist within budget, visible cards switch to the in-budget candidates.
- AC2: When no in-budget same-intent candidate exists, current nearest over-budget behavior is preserved.
- AC3: Add tests without adding regex.
- AC4: `npm run lint:no-regex`, targeted tests, typecheck, full tests, and build pass locally.
- AC5: Commit, push, Railway marker, and production Promptfoo prove overall score and LLM average above 90%; target 6/6 if model output cooperates.
