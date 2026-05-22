# No-Regex Card Selection Plate Hints

## Problem

`src/ai/agentManagerCardSelection.ts` still uses regex to infer plate-compactor card ranking hints for self-loading, small-site, and heavy-site contexts. This is legacy deterministic text matching in a behavior-critical card selection module, and it violates the current project direction that old regex should be removed instead of expanded.

## Current Behavior

The module uses regex over joined user/planner/semantic text to derive broad weight ranges:

- self-loading context -> prefer 40-75 kg plates;
- small-site context without heavy-site signals -> prefer 45-95 kg plates;
- heavy-site signals block the small-site inferred range.

These checks influence ranking only; they do not decide buyer intent or answer policy.

## Structural Improvement

Replace those regex checks with normalized deterministic fragment checks. Keep the behavior deterministic and scoped to catalog/card safety, while avoiding regex and avoiding any new private phrase-specific answer logic.

## Validation

- Add unit coverage for self-loading and small-site plate ranking.
- Confirm heavy-site signals still suppress the small-site inferred range.
- Run `npm test -- tests/agentManagerCardSelection.test.ts`.
- Run `npm run lint:no-regex` and confirm the legacy baseline decreases or at least no new regex appears.
- Run typecheck, full tests, diff-check, and build.

## Acceptance Criteria

- AC1: No regex remains in the self-loading/small-site/heavy-site plate hint functions.
- AC2: Ranking still prefers lighter 40-75 kg cards for self-loading contexts.
- AC3: Ranking still prefers 45-95 kg cards for small-site contexts.
- AC4: Heavy-site context still blocks the small-site inferred range.
- AC5: No public API changes.
- AC6: Local non-OpenAI gates pass.
