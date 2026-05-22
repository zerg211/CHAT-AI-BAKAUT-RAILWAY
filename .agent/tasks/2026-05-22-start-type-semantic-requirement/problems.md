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
