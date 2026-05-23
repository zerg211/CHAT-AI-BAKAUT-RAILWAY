# Problems after production eval 3d878fd

Source artifact: `.agent/tasks/2026-05-22-start-type-semantic-requirement/production-promptfoo-3d878fd.json`

Summary:

- Production Promptfoo passed averages but exited non-zero: `5/6` tests passed.
- Deterministic average: `98.12%`
- LLM average: `90.17%`

## P1: short model names in answer text are not always selected as visible cards

Scenario: `context_shift_agent_completion`

Observed behavior:

- Turn 1 answer named `Husqvarna LF 50 LAT`, `TSS-WP60TL`, and `Husqvarna LF 80 L`.
- Visible cards showed only `TSS-WP60TL`.
- The later judge penalized the conversation for weak answer/card grounding.

Cause:

- `answerMentionedProducts` matched long or compact model tokens, but short spaced model names such as `LF 50 LAT` can be missed.
- This lets the answer name a catalog candidate while card selection treats it as unmentioned and drops it.

Fix direction:

- Improve deterministic product mention matching for brand plus short model token sequences.
- Keep semantic choice in the LLM: the code only aligns visible cards with product names already chosen in the answer.
- Do not add regex or a scenario-specific product exception.

Validation:

- Add a focused card-selection test for `Husqvarna LF 50 LAT` and `TSS-WP60TL`.
- Rerun local checks.
- Commit, push, wait for Railway marker, and rerun production Promptfoo.

# Problems after production eval 32e60bc

Source artifact: `.agent/tasks/2026-05-22-start-type-semantic-requirement/production-promptfoo-32e60bc.json`

Summary:

- Production Promptfoo still exited non-zero: `5/6` tests passed.
- Deterministic average: `91.03%`
- LLM average: `96.50%`

## P2: AgentManager planner can semantically require web grounding but omit the web tool

Scenario: `web_required_technical_grounding`

Observed behavior:

- The user asked for a technical THD explanation and explicitly requested fact checking if catalog data was missing.
- `intentContract.dialogueUnderstanding` recognized that factual verification was requested.
- The same `intentContract.nextStepRationale` then chose no tool because no exact named product was present.
- No `web.researchProductFacts` tool ran, so metadata had no `webFactSearch` evidence and no `technical_answer` task signal.

Cause:

- The AgentManager intent contract did not have a structured grounding policy separate from tool requests.
- That let the LLM express a semantic grounding requirement in prose while returning `requiresTools=false`.
- Code had no typed policy to reconcile this contradiction without falling back to phrase matching.

Fix direction:

- Add a typed `grounding` block to `AgentIntentContract`: task type, source policy, web purpose, required tool kinds, technical attributes, and rationale.
- In the planner prompt, require `grounding` to be filled first and require `web.researchProductFacts` when `grounding.sourcePolicy="web_required"`.
- Add a runtime repair that adds `web.researchProductFacts` only when the LLM's structured `grounding` policy requires it but the tool request is missing.
- Expose `sourcePolicy` and a minimal `turnContract` in AgentManager metadata for eval/runtime observability.

Validation:

- Add a focused AgentManager test where the mocked LLM returns `grounding.sourcePolicy="web_required"` but omits the tool, and prove runtime repairs it into `auto:web-grounding`.
- Rerun typecheck, no-regex guard, build, and full test suite.
- Commit, push, wait for Railway marker, and rerun production Promptfoo.

# Problems after production eval 4107581

Source artifact: `.agent/tasks/2026-05-22-start-type-semantic-requirement/production-promptfoo-4107581.json`

Summary:

- Production Promptfoo still exited non-zero: `5/6` tests passed.
- Deterministic average: `96.98%`
- LLM average: `84.50%`

## P3: LLM answer can mention over-budget products before card filtering hides them

Scenario: `context_shift_agent_completion`

Observed behavior:

- Turn 2 buyer constrained the vibroplate selection to `до 70 тысяч` and one-person transport.
- The answer named `ТСС TSS-WP60TH` at `79 592 ₽` and explicitly said it was above budget.
- Visible cards correctly hid that product and showed only in-budget models.
- The judge penalized answer/card inconsistency and weak grounding because a product not shown as a card appeared inside the recommendation shortlist.

Cause:

- `composeAnswer` received all catalog products before `selectProductsForVisibleCards` applied the structured budget filter.
- This let the LLM name products that deterministic card logic later removed.

Fix direction:

- Before composing the answer, apply a deterministic evidence gate to the product context: if a structured budget is known and same-class in-budget catalog products exist, remove same-class over-budget products from the products passed to the LLM.
- Keep over-budget products visible to the LLM only when no in-budget same-class candidates exist, so it can honestly explain no fit instead of hiding the situation.
- Add metadata `answerProductEvidence` and warning `answer_products_filtered_by_budget:N` for auditability.

Validation:

- Add a focused AgentManager test proving the answer LLM receives only in-budget plate products when an in-budget set exists.
- Rerun focused tests, typecheck, no-regex guard, build, and full test suite.
- Commit, push, wait for Railway marker, and rerun production Promptfoo.

# Problems after production eval 9a14705

Source artifact: `.agent/tasks/2026-05-22-start-type-semantic-requirement/production-promptfoo-9a14705.json`

Summary:

- Production Promptfoo still exited non-zero: `5/6` tests passed.
- Deterministic average: `98.64%`
- LLM average: `92.83%`
- Both score averages were above 90%, but the failed LLM rubric was still below its per-scenario pass threshold.

## P4: answer text can still name a model absent from answer product evidence

Scenario: `context_shift_agent_completion`

Observed behavior:

- Turn 2 answer correctly used the new budget evidence gate: `answerProductEvidence.products` contained only `TSS-WP60TL` and dropped over-budget candidates.
- Visible cards also showed only `TSS-WP60TL`.
- The LLM answer still mentioned `TSS-WP60TH` and discussed an optional mat for that absent model.
- The judge penalized the mismatch because the answer recommended/discussed a model that was not grounded by the products/cards shown to the buyer.

Cause:

- The pre-answer budget evidence gate removed invalid products from `composeAnswer` input, but there was no pre-send invariant that the final answer text names only model identifiers present in the actual answer product evidence.
- Existing card selection could only match products still present in `answerProducts`, so it could not detect a hallucinated/unsupported model token that had already been removed from evidence.

Fix direction:

- Add a deterministic pre-send review guard for catalog-selection answers: detect model identifier tokens in answer text and compare them with model identifier tokens from the products passed as answer evidence.
- If an answer segment names an unsupported model identifier, rewrite by removing that segment before final text/card selection.
- Allow non-target context equipment mentions from structured `productMentions`, so load devices or compatibility context are not stripped.
- Keep semantic decisions in the LLM; the code only enforces evidence/card consistency.
- Do not add regex or a scenario-specific product exception.

Validation:

- Strengthen the budget evidence test so the mocked LLM intentionally mentions dropped `TSS-WP60TH`, and prove pre-send review removes it.
- Rerun focused tests, typecheck, no-regex guard, build, and full test suite.
- Commit, push, wait for Railway marker, and rerun production Promptfoo.

# Problems after production eval c5a46d9

Source artifact: `.agent/tasks/2026-05-22-start-type-semantic-requirement/production-promptfoo-c5a46d9.json`

Summary:

- Production Promptfoo regressed and exited non-zero: `3/6` tests passed.
- Deterministic average: `87.45%`
- LLM average: `60.83%`

## P5: missing-contact commercial handoff can still preserve soft promises

Scenario: `commercial_delivery_discount_rules`

Observed behavior:

- The answer did not promise exact delivery price or discount amount, but said delivery and discount "бывают".
- `lead.capture` returned `not_found` with `lead_contact_missing`.
- Because the answer already used `leadAction="offer_form"`, mechanical review did not rewrite it.
- The LLM judge penalized the soft commercial promise and weak next step.

Cause:

- Mechanical lead review only repaired missing-contact lead attempts for `capture_contact` or `confirm_contact_received`.
- It did not treat `lead.capture:not_found` as sufficient evidence to normalize an unsafe commercial handoff when the model already marked the answer as a form offer.

Fix direction:

- When `lead.capture` returns missing contact and the buyer has not provided contact data, always rewrite to the safe form-offer text.
- Keep this deterministic because delivery, discount, stock, terms, and timing are business constraints, not semantic buyer-intent decisions.

Validation:

- Add a focused AgentManager test where the mocked answer says delivery/discount are available, `lead.capture` lacks contact, and pre-send review rewrites to a safe form offer.

## P6: failed general web grounding fallback is too empty for technical questions

Scenario: `web_required_technical_grounding`

Observed behavior:

- The LLM planner correctly required `web.researchProductFacts`.
- The research tool failed with `product_comparison_research did not return a JSON object`.
- The mechanical rewrite replaced the unsafe generated answer with a generic failure notice that did not answer what THD means for a boiler/electronics.
- Deterministic completion patterns failed because the final answer no longer contained `THD`/harmonic grounding.

Cause:

- `failedWebResearchSafeRewrite` only had a useful branch for exact named product facts.
- For general technical questions with no exact model, it returned a one-size failure notice instead of preserving a truthful, clearly unverified engineering-level answer.

Fix direction:

- Add a structured failed-web fallback for general THD/generator power-quality questions based on planner/tool technical attributes.
- The fallback explains the concept and practical risk, while explicitly saying exact/current verification did not complete.
- Do not claim web verification succeeded and do not cite failed tool output as evidence.

Validation:

- Add a focused AgentManager test where failed general THD web research is cited by the answer, and mechanical review rewrites to a useful unverified THD explanation while clearing failed facts.

## P7: commercial turn metadata can miss pure delivery/lead-handoff task type

Scenario: `commercial_delivery_discount_rules`

Observed behavior:

- The production turn used specialist-required source policy and lead capture, but `turnContract.answerTask` remained `technical_explanation`.
- This weakened eval observability for delivery/discount turns.

Cause:

- `agentManagerTaskTypeFromGrounding` only mapped `grounding.taskType="availability_or_delivery"` to `pure_delivery`.
- It did not fall back to `sourcePolicy="specialist_required"` or a planned `lead.capture` tool.

Fix direction:

- Treat specialist-required grounding or planned lead capture as `pure_delivery` in turn-contract metadata.

Validation:

- Existing metadata assertions plus production eval should show delivery/discount turns as lead handoff instead of technical explanation.
