# Problems

## Confirmed production failures

1. Search stopped after one formally valid 8.5 kW candidate even though closer 5-6 kW products existed.
2. Canonical structured recovery was gated on zero survivors instead of insufficient/low-quality coverage.
3. Previously validated 6.0 kW products were dropped from the next answer.
4. A no-tool recommendation follow-up lost the prior validation evidence and failed all recovery attempts.
5. The manual verification process initially described a partial behavior improvement before completing the mandatory per-turn audit.

## Current status

## Production attempt 1 on commit `50ee8a5`

Session `9ad5a646-0f86-4bf5-8df2-1984dcd84538` failed the embedded-widget audit:

1. Turn 2 visibly returned valid gasoline products including TSS SGG 5000N 5.0 kW / 49,281 RUB and SUMEC SU8800 6.0 kW / 47,990 RUB.
2. Turn 3 added the buyer's explicit gasoline choice as strict `fuel_type=gasoline` and then suppressed every product with `unsupported_or_unverifiable_strict_hard_constraint:1`.
3. The deterministic strict-requirement validator did not support `fuel_type`, even though the catalog classifier already had deterministic gasoline/diesel facts.
4. The buyer therefore saw the false statement that no suitable gasoline model could be shown and was again asked for a nameplate.
5. The pre-send review returned `pass` despite the direct contradiction with the prior turn.
6. Turns 2-4 had recovered status; under AC13 that independently fails the release.

The fuel-type validator was fixed and deployed in commit `5c3f0b2`.

## Production attempt 2 on commit `5c3f0b2`

Session `710f559f-a5cb-415e-9b43-194ea500afd5` was buyer-visible PASS but not accepted as a clean release:

1. The assistant showed three matching gasoline single-phase 5-5.5 kW products with prices and gave a concrete TSS recommendation without overpaying.
2. Cards and answer text stayed consistent through the comparison turn.
3. Turn 3 completed through the same-turn durable-checkpoint recovery path rather than normal execution.
4. Because AC13 rejects recovery/fallback in the proof dialogue, this attempt was not accepted even though the recovered answer itself was correct.

## Production attempt 3 on commit `5c3f0b2`

Session `9ea0d9b6-2cd3-44e3-8d49-f684f3ffb3a2` failed the embedded-widget audit:

1. Turn 1 completed normally and showed four valid 5.0 kW gasoline single-phase generators with prices.
2. The buyer narrowed the same set to 2-3 products in 5-6 kW and explicitly required prices.
3. The LLM planner correctly retained `reusePreviousCards=true`, the 5-6 kW range, gasoline, single phase, and `price_visibility=true`.
4. Historical selection evidence was present, but deterministic strict validation treated `price_visibility` as unsupported and suppressed all four prior products.
5. The assistant therefore produced the false statement that no verified cards with prices existed; pre-send review again returned `pass`.

The current local fix keeps semantic ownership in the LLM and adds deterministic support for the general catalog fact `price_visibility=true`. It filters only products without a real positive price instead of suppressing the entire selection. A continuity regression proves that prior validated products with prices survive a no-new-result follow-up. The release remains FAIL until the new code is pushed, deployed, and passes a fresh clean widget dialogue plus admin audit.

## Production attempt 6 on commit `31f965d`

Session `30b1820f-1c33-47e1-bd19-765ecfa4d1a0` failed the embedded-widget and admin audit:

1. The LLM correctly interpreted the buyer's 220 V house supply as strict `voltage_v=220` and typed single-phase policy.
2. The load calculator succeeded and produced a 5 kW preliminary nominal target.
3. Deterministic strict validation did not support `voltage_v`, so it erased all catalog products and the assistant again refused to show preliminary cards.
4. Turn 1 completed only through recovery; turn 2 failed all recovery attempts and exposed the technical fallback to the buyer.
5. The turn-2 guard correctly detected missing preliminary cards, but recovery reused the same empty catalog/answer-product state instead of obtaining a repairable product set.

The current local fix adds a general generator-voltage verifier bound to typed phase policy and confirmed product phase/voltage classification. It does not add a special phrase, model, or dialogue branch. The release remains FAIL until deployment and a clean production dialogue with per-turn metadata proof.
