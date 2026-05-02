# P0 local live follow-up plan

Scope: local only. No GitHub/Railway push.

## Root cause from live dialogue

The local browser dialogue exposed two remaining generator follow-up gaps:

1. Explicitly negated pump load was not fully clearing earlier inferred pump context.
   - Buyer said: “Насоса нет”.
   - Later 1+1 follow-up could still ask for pump power/model.
   - Root cause: `compatibilityTargetFromText()` treated any pump mention as a pump compatibility target, even when the mention was negative; load-profile merge also had no explicit deletion channel for stale load kinds.

2. Interrogative/alternative power mention needed a hard guard.
   - Buyer asked: “надо переходить на 7–8 кВт или нет?”
   - Correct semantic behavior: answer “нет” and keep the active scenario in the 2.8–3.2 kW class unless high-power cards are actually selected.
   - Root cause: question-range parsing needed to distinguish explicit desired power from an exploratory “do I need to switch?” question.

## Fixes implemented

1. Added `hasNegatedPumpLoad(text)` and used it in generator load/profile handling.
2. Added `removedKinds` to `ProductGeneratorLoadProfile` so stale load kinds can be removed during merge.
3. Updated `mergeProductSelectionState()` load-profile merge to drop removed load kinds before merging current/update items.
4. Updated `compatibilityTargetFromText()` so “насоса нет / без насоса” does not become a pump compatibility target.
5. Added regression coverage for:
   - removing an estimated pump load when the buyer explicitly says there is no pump;
   - not treating an exploratory 7–8 kW question as a desired generator range.

## Verification

Local only:

- Targeted tests: GREEN.
- `npm test -- --run tests/turnContract.test.ts tests/recommendationRanking.test.ts`: GREEN, 105 tests passed.
- `npm run typecheck`: GREEN.
- `npm run build`: GREEN.
- `git diff --check`: GREEN.
- Local backend health: GREEN at `http://127.0.0.1:3010/api/health`.
- Local browser/Playwright dialogue: GREEN; protocol saved at `local-live-tests/2026-05-01-p0-generator-local-live-dialogue.md`.

Railway/live production: NOT TESTED / NOT PUSHED by user request.
