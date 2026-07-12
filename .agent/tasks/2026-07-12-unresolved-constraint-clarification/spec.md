# Spec: unresolved strict constraints must allow useful clarification

Status: FROZEN before implementation

## Production evidence

- Deployed commit: `bebf07fd6e23f868fcb8b0ee8dc31845c626c00a`.
- Embedded widget session: `b7d72da7-2b6e-4a3f-aa53-cd3f9d03b706`.
- Turn: `e103014e-8920-4d07-bf24-062179fba510`.
- The planner correctly concluded that exact generator sizing was impossible without the pump type/power and intended to provide a preliminary range plus one decisive clarification.
- The answer contract had `selectionReadiness.status=needs_more_info`, `canShowProductCards=false`, no selected product IDs and a concrete pump question.
- A strict `generator_load_scenario` referenced a future calculator request that was intentionally not executable before clarification. Mechanical review treated this as an attempted unsafe recommendation and replaced the useful clarification with a calculation-failure refusal.
- A separate strict `product_type=generator` requirement was also treated as unsupported even though `canonicalProductClass=generator` already provides deterministic product-class verification.

## Intended boundary

- Unresolved strict requirements must always suppress product evidence and visible product cards.
- They must force a mechanical refusal only when the answer attempts a concrete product recommendation or claims that cards are ready.
- A safe `needs_more_info` answer with no selected products must be allowed to explain uncertainty and ask the smallest useful question.
- Product-class requirements remain deterministic code: they are verified against the canonical product class, not delegated to semantic keyword matching.

## Acceptance criteria

- AC1: `product_type` or `product_class` strict requirements are mechanically verified only when their canonical value equals the current canonical product class and `unit=null`; mismatches fail closed.
- AC2: Missing/failed/malformed typed-tool proof still suppresses answer products and cards.
- AC3: Mechanical `unverifiable_strict_hard_constraint` rewrite is emitted only when the answer selects product IDs or declares `selectionReadiness.canShowProductCards=true`.
- AC4: A safe clarification answer with `needs_more_info`, no selected product IDs and no cards is preserved and receives normal semantic review.
- AC5: A concrete recommendation under the same unresolved requirement remains blocked/re-written.
- AC6: Safe blocker formatting does not double-wrap evidence already enclosed in Russian or ASCII quotation marks.
- AC7: No phrase-specific regex, pump-specific branch or canned response is added.
- AC8: Regression tests cover canonical product type success/mismatch, clarification allowed, recommendation blocked and quote formatting.
- AC9: Full local release gate passes.
- AC10: Commit/push, Railway marker and adaptive embedded-widget replay prove the production behavior.

## Non-goals

- Do not weaken product/card suppression for unresolved strict requirements.
- Do not invent product facts or show preliminary cards when the answer contract says they are unsafe.
- Do not manually deploy Railway.
