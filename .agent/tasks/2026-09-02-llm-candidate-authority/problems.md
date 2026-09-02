# Problems

## Production Failure

- Railway deployed commit `e250b937e690e03b72e7945efd3e730a2689c8d0`, but AC9 is not verified.
- Production widget session `586cda3d-535b-4769-b3fb-8df2fe324388` repeatedly asked for concrete 3-4 kW generator options. The only completed answer named SUMEC SU4700 but returned no card.
- The answer metadata contained `answer_products_suppressed:unsupported_or_unverifiable_strict_hard_constraint`, `product_cards_suppressed:generator_load_unconfirmed_basis`, and `selection_readiness_blocked_cards` even though no catalog fact proved the candidate incompatible.
- Other turns failed with `active_requirement_mismatch:voltage_v` for the standard 220/230 V single-phase representation or exhausted the wall-time budget after semantic retries.

## LLM And Code Boundary

- Deployed code at `e250b93` overrides semantic understanding twice: `generator_load_result_not_preliminary_fit_safe` removes candidates before writer, and `product_cards_suppressed:generator_load_unconfirmed_basis` removes writer-selected preliminary cards afterward.
- Its exact `Object.is` comparison for `voltage_v` lacks the product/electrical context already represented by deterministic voltage proof normalization, so 220 V and 230 V can be rejected as contradictory ledger values.
- Deterministic code must continue to reject proven numeric under-capacity, phase/fuel/source conflicts, invalid units, exact-identity violations, safety violations, and business-policy violations.
- Writer must decide whether incomplete load evidence still supports useful preliminary candidates, and must express caveats rather than having code convert missing evidence into incompatibility.
- The existing structured result is sufficient: `selectedProductIds`, `selectionRationale`, and `selectionReadiness` with `status`, `canShowProductCards`, `missingFacts`, and `rationale`.

## Required Resolution

- Allow a successful generator-load calculation with uncertain basis to support `preliminary_fit`; keep it blocked for `final_fit`.
- Treat 220/230 V and 380/400 V as equivalent normalized voltage representations when validating ledger requirement consistency.
- Update writer guidance and regression tests, rerun local verification, deploy a new commit, then repeat a connected production widget audit with buyer-visible and admin metadata review.

The local remediation and AC1-AC8 verification are complete. Deployment and the replacement AC9 audit remain pending.
