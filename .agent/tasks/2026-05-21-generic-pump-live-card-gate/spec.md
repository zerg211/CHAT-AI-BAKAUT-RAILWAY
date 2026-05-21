# Generic Pump Live Card Gate Spec

## Current Behavior

Production live widget validation after commit `4ac10b7` failed on the second generator turn:

- the buyer said the pump type/model was unknown;
- the planner sent a calculator request containing the unknown pump with `basisKind="generic_load_name"` and null kW values;
- the calculator dropped that unusable pump load but did not mark the result as unsafe for catalog cards;
- `catalog.search` ran and visible generator cards appeared before pump type or power was known.

## Structural Improvement

Treat omitted generic/unknown motor loads without usable kW as an incomplete generator-load basis. The existing tool-safety gate should then deny catalog search and suppress visible generator cards.

This stays deterministic because it validates structured tool arguments and calculator basis safety. It does not infer buyer intent through regex or keyword patches.

## Acceptance Criteria

AC1. A `calculator.generatorLoad` request that includes a generic/unknown pump without running/start kW records `generator_load_bounded_basis_incomplete` and `generator_load_unbounded_guess`.

AC2. If that warning exists, later generator `catalog.search` is denied with `catalog_search_skipped:generator_load_unconfirmed_basis`.

AC3. Even if the answer contract incorrectly marks preliminary cards ready, visible generator cards are suppressed by tool safety.

AC4. The pass adds no new regex constructs.

AC5. Focused unit tests, typecheck, build, and production Promptfoo pass.

AC6. The production live widget gate through `https://bakautprof.ru/` passes before this regression is considered closed.
