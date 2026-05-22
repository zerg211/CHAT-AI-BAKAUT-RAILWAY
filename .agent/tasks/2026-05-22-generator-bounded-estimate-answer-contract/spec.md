# Task: generator bounded-estimate answer contract

## Scope

Improve the Agent Manager answer contract for generator sizing turns where `calculator.generatorLoad` produced a profile from assumptions, but exact pump/tool nameplate data is still missing.

This pass must not add regex, keyword routing, or one-off canned replies. It should adjust the structured LLM contract and reviewer guidance so the model distinguishes:
- a preliminary sizing orientation from assumptions;
- exact product/card selection;
- final purchase-safe recommendation.

## Current Behavior

Production eval after commit `081e621` failed two generator cases:
- `vague_generator_no_cards_before_load_profile`: no cards were shown, but the answer was too blocking and omitted the available approximate load orientation.
- `generator_load_selection`: the answer used the calculated `4 kW` too firmly as a minimum while the pump exact power remained unknown.

## Structural Improvement

Refine required response clauses and model/reviewer instructions:
- For unconfirmed/incomplete generator load basis, keep product cards blocked, but allow a clearly labeled rough orientation from `payload.profile.requiredNominalKw` when the profile exists.
- For bounded-assumption generator load basis, require the answer to label the number as preliminary and preserve the missing exact fact.
- Prevent phrasing the estimate as confirmed nameplate data or final safe product selection.

## Acceptance Criteria

AC1. No new regex constructs are introduced; `npm run lint:no-regex` passes.

AC2. Unit tests cover the required response clause behavior for unconfirmed and bounded-assumption generator load profiles.

AC3. Existing generator card safety remains stable: unconfirmed generator load basis still suppresses product cards.

AC4. Local non-OpenAI gates pass:
- focused orchestrator tests;
- `npm run lint:no-regex`;
- `npm run typecheck`;
- `npm test`;
- `npm run build`;
- `git diff --check`.

AC5. After commit and push, production Promptfoo/widget harness reaches deterministic average > 90% and LLM average > 90%.
