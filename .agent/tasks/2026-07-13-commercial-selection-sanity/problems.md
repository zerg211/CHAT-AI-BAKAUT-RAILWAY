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

## Production attempt 8 on commit `45892db`

Session `696f837d-0082-48ab-856a-50f8f4314fc7` failed from the buyer's perspective even though backend processing succeeded:

1. The embedded widget displayed the generic technical fallback and no cards.
2. Admin turn `881dc369-aadf-4c12-ad7d-40b20a5468dc` completed normally in about 46.6 seconds with no error and no recovery.
3. Planner semantics, strict `voltage_v=220`, load calculation, catalog selection, pre-send review, saved answer, and four selected cards were all present.
4. The successful saved answer was not delivered to the widget after the primary SSE transport ended.
5. Client recovery could only start after parsing the SSE `turn` event. A stream that ended before delivering/parsing that event left the client without a turn ID and forced the public fallback.

The current local transport fix duplicates the durable turn ID in the initial HTTP header and consumes it before reading SSE events. Recovery can therefore retrieve the already-saved answer without repeating the buyer message or rerunning semantic planning. The release remains FAIL until deployment and a fresh multi-turn widget plus admin audit passes.

## Production attempt 9 on commit `511de70`

Session `61b981c4-a350-454e-94d8-1cb8f498ce34` failed on a two-product comparison after a successful first selection turn:

1. Turn 1 displayed six coherent priced cards and recommended SUMEC SU8800 as the no-overpayment option.
2. Turn 2 correctly narrowed the need state to SUMEC SU8800 and BISON BS6250IE.
3. The LLM planner emitted more than 12 comparison attributes in the second tool request.
4. Runtime Zod rejected the entire intent contract with `too_big`, and recovery failed with the same structural mismatch.
5. The OpenAI Structured Outputs JSON Schema did not publish the runtime maximum, so this output was valid under the model-facing contract but invalid under the code-facing contract.

The current local fix aligns all bounded planner/answer arrays and bounded integers between the handwritten JSON Schema and Zod, plus adds a schema-parity regression. Semantic attribute prioritization stays with the LLM. The release remains FAIL until deployment and a fresh multi-turn widget plus admin audit passes.

## Production attempt 10 on commit `599378f`

Session `a5253565-aab7-4bbc-b37b-31669a6db423` failed in the embedded widget even though backend work completed successfully:

1. The buyer saw the public technical fallback and no product cards on turn 1.
2. Admin turn `d57f167c-6567-4cd5-9f7e-468007ba16fd` was `completed` / `assistant_message_saved`, with no error and no recovery.
3. The saved response correctly calculated a 4.5 kW nominal minimum, named four preliminary products, preserved prices, and passed pre-send review.
4. Recovery had the durable turn ID, but collided with the original runner's active execution lease and treated `turn_execution_in_progress` as a final recovery failure.
5. The original runner saved the correct answer after that collision, too late for the iframe that had already rendered fallback.

The current local fix makes recovery wait and retry the same durable turn while the original lease is active. Lease ownership still prevents a concurrent second runner. The release remains FAIL until deployment and a fresh embedded multi-turn dialogue plus per-turn admin audit passes.

## Production attempt 11 on commit `0a976a2`

Session `1d5116e2-81d7-4a93-b216-f1be2ac60709` proved that transport recovery now delivers the real response, but the commercial behavior still failed:

1. The assistant correctly calculated a 4.5 kW minimum and then refused to show cards.
2. Catalog search completed, but a single strict-requirement blocker suppressed all candidates and a 1,000-product recovery scan.
3. The LLM emitted `kind=voltage_v`, `value=220`, `unit=null`, and typed `phase=single_phase`.
4. Deterministic code required the redundant literal unit `V` even though the stable kind `voltage_v` already defines volts.
5. Pre-send review did not flag the resulting refusal.

The current local fix accepts a missing duplicate unit only for the stable `voltage_v` kind while retaining all value, phase, class, and product-fact checks. The release remains FAIL until deployment and a fresh embedded multi-turn dialogue plus per-turn admin audit passes.
