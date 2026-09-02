# Production Failure Evidence

- Site path: embedded widget on `https://bakautprof.ru/`
- Railway commit: `e250b937e690e03b72e7945efd3e730a2689c8d0`
- Session: `586cda3d-535b-4769-b3fb-8df2fe324388`
- Buyer request: reserve generator for a 220 V home, including an approximately 750 W borehole pump, refrigerator, gas boiler, and lights; then repeated requests for two catalog generators around 3-4 kW with prices.
- Committed assistant answer: named SUMEC SU4700 at 23,590 RUB, described it as a catalog reference, requested pump plate data, and offered contact capture for stock checking.
- Visible cards: none.
- Completed answer warnings: `answer_products_suppressed:unsupported_or_unverifiable_strict_hard_constraint:1`, `product_cards_suppressed:generator_load_unconfirmed_basis`, and `selection_readiness_blocked_cards`.
- Completed answer readiness: `needs_more_info`, `canShowProductCards=false`; missing facts included pump starting power and 220/230 V compatibility.
- Failed turn evidence: `semantic_decision_incoherent:active_requirement_mismatch:voltage_v`, `semantic_decision_incoherent:generator_load_scenario_unexecutable_load:unknown_load:газовый котёл`, and multiple `wall_time_budget_exceeded` turns.
- Verdict: FAIL. Missing load details and standard 220/230 V representation were treated as reasons to suppress preliminary candidates, contrary to AC1, AC5, AC6, and the repository policy that missing evidence is not incompatibility.
