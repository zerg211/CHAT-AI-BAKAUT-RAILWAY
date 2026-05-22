# Bounded Generator Null Load Defaults

## Problem

Production Promptfoo after `da0f939` reached the numeric gates, but `generator_load_selection` still failed one deterministic assertion: no product cards were shown after the buyer explicitly asked for catalog variants under 90k. The planner correctly identified a 220 V borehole pump as a bounded motor/function, but left `runningKw` and `startingKw` null. The runtime dropped that load, treated the generator calculation as unconfirmed, denied `catalog.search`, and suppressed all cards.

## Current Behavior

`buildGeneratorLoadToolPayload()` only counts load items with numeric kW values. A load with `source="estimated_average"`, `basisKind="specific_type_or_function"`, and sufficient basis signals is still dropped if the planner leaves kW null. This is correct for generic unknown loads, but too strict for bounded preliminary selection where the LLM has already marked the estimate basis as bounded.

## Structural Improvement

For bounded `estimated_average` load items with enough structured basis, fill conservative default load values by canonical load kind. Keep the result explicitly preliminary through warnings and existing `selectionReadiness.missingFacts`; do not treat the default as an exact nameplate fact. Generic pumps or unknown loads remain blocked.

## Acceptance Criteria

- AC1: Bounded estimated pump loads with null kW and sufficient basis signals receive conservative numeric defaults.
- AC2: Generic or insufficient pump loads with null kW remain unconfirmed and still block premature generator cards.
- AC3: `generator_load_bounded_assumption` remains the readiness signal for preliminary cards, and `generator_load_unbounded_guess` is not emitted for the bounded default case.
- AC4: Add tests without adding regex.
- AC5: `npm run lint:no-regex`, targeted tests, typecheck, full tests, and build pass locally.
- AC6: Commit, push, Railway marker, and production Promptfoo prove overall score and LLM average stay above 90%, preferably with 6/6 deterministic pass.
