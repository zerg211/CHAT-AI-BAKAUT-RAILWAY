# Task: plate self-loading shortlist contract

## Problem

Production eval after `f395d36` failed `context_shift_agent_completion`: the assistant correctly switched from generator to plate compactor selection and respected the budget, but the LLM-grader marked the final shortlist as weak because a heavier in-budget option was presented alongside lighter one-person transport candidates without a clear enough tradeoff.

This should not be fixed by a regex, phrase trigger, or hardcoded dialog script. The answer model and reviewer should use the structured dialogue, catalog products, prices, and weights to keep the visible shortlist aligned with buyer constraints.

## Acceptance Criteria

AC1. No regex is added.

AC2. For plate compactor catalog selection with a budget plus one-person/light transport constraint, the answer contract tells the LLM to prefer the lightest in-budget candidates that still match the job.

AC3. If two or more lighter in-budget candidates exist, heavier in-budget products must not be presented as equal primary recommendations; they may only be mentioned as a clear tradeoff if useful.

AC4. The reviewer contract requires rewrite when a plate-compactor shortlist ignores the buyer's light/self-loading constraint while lighter in-budget product cards are available.

AC5. Add or update a focused source guard so the contract remains in the prompt.

AC6. Run focused tests, no-regex guard, typecheck, full tests, build, and diff check.

AC7. After commit/push/Railway marker, production Promptfoo/widget harness passes with deterministic average and LLM average both above 90%.
