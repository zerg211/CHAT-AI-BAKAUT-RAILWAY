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
