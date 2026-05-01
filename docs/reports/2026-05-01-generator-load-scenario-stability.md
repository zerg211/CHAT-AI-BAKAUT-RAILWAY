# Generator load scenario stability — 2026-05-01

## Root cause

The defect was not a single bad keyword. The generator selector treated nearly every mentioned appliance as part of the immediate active load and treated the word `одновременно` as affirmative simultaneity even when the buyer explicitly negated it (`одновременно включать не буду`).

That made the agent behave like a keyword accumulator instead of a manager: staged, excluded, contextual and active loads were mixed into one power profile, so a non-simultaneous kettle/tool mention could inflate sizing to 7.5 kW.

## Fix summary

Implemented a scenario layer for generator load mentions:

- load mentions now carry roles: `active`, `staged`, `excluded`, `context`;
- only `active` detections are converted into current electrical load items;
- non-simultaneous / negated clauses are retained as scenario context, not as active watts;
- simultaneous-start sizing now uses an affirmative simultaneity check, so phrases like `одновременно включать не буду` do not trigger all-load starting mode;
- explicit buyer-provided/current loads remain stronger than reference defaults;
- explicit `1 основной + 1 запасной` card contract remains capped to 2 visible cards while extra matched products stay behind show-more behavior.

## Files changed for this stage

- `src/ai/generatorLoadReference.ts`
  - curated generator load reference and runtime overlay/enrichment;
  - role-aware detection model for load mentions;
  - active-only conversion to `ProductElectricalLoadItem`.
- `src/ai/assistant.ts`
  - generator profile merge changes;
  - affirmative simultaneity guard;
  - visible card limit persistence / show-more support;
  - turn-contract card suppression integration.
- `tests/generatorLoadReference.test.ts`
  - static reference coverage.
- `tests/generatorLoadReferenceEnrichment.test.ts`
  - runtime overlay/enrichment persistence coverage.
- `tests/recommendationRanking.test.ts`
  - RED→GREEN regression for non-simultaneous kettle/tool mention;
  - explicit show-more/card-limit coverage.
- `tests/answerSanity.test.ts`, `src/ai/answerSanity.ts`
  - numeric range sanity for Russian decimal comma and reversed ranges.
- `tests/turnContract.test.ts`
  - explicit 1+1 visible card cap test.

## Verification

### Focused regression

Command:

```bash
npm test -- --run tests/recommendationRanking.test.ts -t "does not promote non-simultaneous mentioned loads"
```

Result: PASS after the scenario-layer fix.

### Targeted regression pack

Command:

```bash
npm test -- --run tests/answerSanity.test.ts tests/turnContract.test.ts tests/generatorLoadReference.test.ts tests/generatorLoadReferenceEnrichment.test.ts tests/recommendationRanking.test.ts
```

Result:

- Test Files: 5 passed
- Tests: 112 passed
- Log: `/tmp/bakaut-targeted-scenario.log`

### Typecheck / build / diff hygiene

Command:

```bash
npm run typecheck && npm run build && git diff --check
```

Result: PASS.

Build output included Vite production build success (`30 modules transformed`, built in `2.20s`).

### Local browser full dialogue

Command:

```bash
node tmp-full-dialogue-check.mjs 2>&1 | tee /tmp/bakaut-full-dialogue-check.log; exit ${PIPESTATUS[0]}
```

Result: PASS after rebuilding and restarting local backend/frontend.

Scenario:

1. Buyer asks for generator for дача: light, fridge, grinder/drill, does not know tool power; asks for one main and one backup, rest under show-more.
2. Buyer asks why main vs backup and whether fridge survives tool start.
3. Buyer adds router/TV/laptop and says kettle and tool will not be used simultaneously.
4. Buyer asks budget/rational first pick.
5. Buyer asks about startup/service: oil, first start, warranty, noise.
6. Buyer asks for 6-point checklist.
7. Lead/contact form submitted.

Checks from the script:

- `hasStuck: false`
- `badQuestionnaire: false`
- `impossibleRanges: []`
- `leadSignals: true`
- `initialVisibleCardContractOk: true`
- `followUpCardContractOk: true`
- `scenarioDidNotJumpTo75: true`
- visible card groups stayed at 2 cards
- non-simultaneous kettle/tool turn stayed in ~4.5 kW nominal / ~4.3 kW start range instead of jumping to 7.5 kW
- final answer still used the corrected ~4.5 kW / ~4.3 kW orienting calculation

Local backend health during verification:

```json
{"ok":true,"answerModel":"gpt-5.4-mini","plannerModel":"gpt-5.4-mini"}
```

## Honest status / caveats

Done locally:

- root-cause plan saved;
- RED regression added and turned GREEN;
- targeted tests passed;
- typecheck passed;
- production build passed;
- `git diff --check` passed;
- local full 6 chat turns + 1 contact form browser dialogue passed.

Not done:

- no full test suite beyond the targeted pack;
- no commit/push;
- no Railway deploy;
- no production/live domain verification.

Repo note: `git status` still contains many pre-existing modified files outside this fix scope. I did not claim they are clean or deploy-ready.
