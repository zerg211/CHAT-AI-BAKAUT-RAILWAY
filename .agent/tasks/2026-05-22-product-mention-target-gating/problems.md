# Problems after production eval 5d88c46

Source artifact: `.agent/tasks/2026-05-22-product-mention-target-gating/production-promptfoo-5d88c46.json`

Summary:

- Deterministic average: `92.62%`
- LLM average: `77.17%`
- Gate result: `FAIL` because LLM average is below `90%`

## P1: form offer text without leadRequested metadata

Scenario: `commercial_delivery_discount_rules`

Observed behavior:

- The answer asks the buyer to leave a phone/name in the form.
- `lead.capture` returns `not_found` with `lead_contact_missing`, which is correct because no contact was provided.
- The final payload still has `leadRequested: false`.

Cause:

- The answer text and the structured `leadAction` can diverge when the answer already offers the form but the answer contract keeps `leadAction: none`.
- This is a deterministic contract consistency issue, not a buyer-intent decision.

Fix direction:

- If a failed `lead.capture` result says contact/name is missing and the final answer already asks for contact data, repair the final `leadAction` to `offer_form`.
- Do not add phrase-specific behavior or regex. Use the existing contact-request text scanner.

Validation:

- Add a focused unit test for this consistency repair.
- Rerun orchestrator tests and typecheck.

## P2: answer names a catalog product that is not visible in cards

Scenario: `generator_load_selection`

Observed behavior:

- The answer names a product that is not present in visible cards.
- The buyer sees cards for other products, so answer text and UI recommendations diverge.

Cause:

- The LLM answer can use a returned product as narrative filler even when card selection drops it later.

Fix direction:

- Strengthen answer/reviewer instructions at the structural level: named catalog recommendations must be exact products from the provided product context and should be treated as visible recommendation candidates, not filler.
- Avoid a product-name-specific rule.

Validation:

- Rerun production Promptfoo after commit/push/Railway marker.

## P3: plate compactor answer underweights the one-person transport constraint

Scenario: `context_shift_agent_completion`

Observed behavior:

- The answer promotes a heavier in-budget plate compactor while the buyer asked for one-person transport.
- The answer does not clearly label the heavier option as a compromise.

Cause:

- Existing LLM guidance handles obvious 90+ kg violations, but not the softer case where the only in-budget card is still near the upper edge of the one-person constraint.

Fix direction:

- Strengthen semantic guidance: if no light in-budget candidate is available, present heavier in-budget candidates as compromise options and ask whether that tradeoff is acceptable.
- Do not encode a scenario-specific keyword rule.

Validation:

- Rerun production Promptfoo after commit/push/Railway marker.
