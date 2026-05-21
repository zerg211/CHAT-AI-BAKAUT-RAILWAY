# Selection readiness contract spec

## Scope

Replace deterministic buyer-visible card readiness rewrites with an internal structured answer-contract decision.

This pass is an internal LLM contract/refactor, not a public HTTP, database, or widget API change.

## Current behavior

- Card selection can find products from catalog tools.
- Previously, generator card visibility was partly decided by deterministic code that inspected regex/risk signals and could append or replace answer text with a canned load-readiness message.
- That made the code own semantic buyer-dialogue decisions such as whether a preliminary selection is honest.

## Structural improvement

- Add `AnswerSelectionReadinessSchema` to the answer contract.
- Require the LLM answer contract to return:
  - `productClass`;
  - `status`;
  - `canShowProductCards`;
  - `missingFacts`;
  - `rationale`.
- Keep deterministic code responsible for enforcing the structured decision:
  - if `canShowProductCards=false`, suppress visible cards and add metadata warnings;
  - if the field is absent in old/internal callers, preserve legacy ready behavior.
- Remove canned post-answer generator readiness rewrites from the orchestrator path.

## Acceptance criteria

- AC1: `AnswerContractSchema` supports `selectionReadiness`, and `answerContractFormat` requires it for live LLM answer composition.
- AC2: `agentManagerCardSelection.ts` no longer decides generator readiness through dialogue regex/ledger risk heuristics.
- AC3: The orchestrator suppresses visible cards from the structured contract without replacing the LLM answer with a canned message.
- AC4: Existing unit tests cover blocked cards, non-invented generic pump loads, and allowed preliminary cards after a usable profile.
- AC5: Full unit suite, typecheck, diff check, and build pass.
- AC6: Local Promptfoo/eval status is recorded even if blocked by environment.

## Out of scope

- No public API change.
- No dependency upgrade.
- No manual Railway deploy.
- No broad frontend/database refactor.

## Process note

This contract boundary emerged while stabilizing the generator-load/card extraction. The implementation already existed before this separate task artifact was created, so this spec records and freezes the review boundary for verification rather than pretending the pass started cleanly.
