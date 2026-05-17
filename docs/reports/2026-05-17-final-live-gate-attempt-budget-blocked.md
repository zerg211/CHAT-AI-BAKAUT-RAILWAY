# Final production live gate attempt: budget blocked

Date: 2026-05-17

## What was run

After billing was replenished, the final production live gate was run once through the real `bakautprof.ru` widget with the prepared scenario:

```text
local-live-tests\generated-production-live-scenarios\final-live-workshop_welder_compressor_bundle-2026-05-17T11-42-34-318Z.json
```

Generated protocol:

```text
local-live-tests\2026-05-17-production-diverse-buyer-audit-2026-05-17T12-02-59-907Z.production.md
```

Session:

```text
fea65829-f116-49ed-acfe-74b8f2f03955
```

## Result

The run is not accepted as final proof.

The widget opened and the first turns answered, but the production live-test budget guard stopped the agent pipeline mid-dialog:

```text
OpenAI daily token budget exceeded for production_live_test: used 144321, reserve 16000, budget 160000
```

Observed technical result:

- buyer-view script reported `0` buyer issues, but this was too weak;
- code/metadata audit reported `13` issues;
- turns 4-6 failed as `recovery_failed`;
- turns 7-8 were `generation_failed/recovered`;
- completion audit was corrected to reject this protocol because `Code/metadata issues` was not zero.

## Fix made after the attempt

The live gate was hardened so this cannot be treated as a pass again:

- `tests/liveAgentCycle.diverse.production.mjs` now fails the run when buyer or code/metadata issue counts are non-zero.
- `tests/remediationCompletionAudit.mjs` now requires a fresh production protocol with both:
  - `Buyer-view issues: 0`;
  - `Code/metadata issues: 0`.
- `tests/productionOpenAiRuntimePreflight.mjs` now checks `/api/admin/openai-usage?hours=24&source=production_live_test` before browser launch and blocks if the live-test budget has no room after reserve.

## Next valid live attempt

Do not repeat the used scenario. A new scenario was prepared:

```text
local-live-tests\generated-production-live-scenarios\final-live-farm_pump_generator_plate-2026-05-17T12-08-19-994Z.json
```

Before running it, either wait until the 24-hour `production_live_test` usage window clears or raise Railway/code-default `OPENAI_HEADLESS_DAILY_TOKEN_BUDGET` enough for the final live scenario. Otherwise the new budget preflight will block before browser launch.

Follow-up implemented: the code default for `OPENAI_HEADLESS_DAILY_TOKEN_BUDGET` was raised from `160000` to `1200000`. This budget applies only to headless production live tests detected as `production_live_test`; real buyers on the production widget are governed by the separate `OPENAI_DAILY_TOKEN_BUDGET`.

The preflight now estimates required remaining budget for the planned scenario:

```text
max(120000, turnCount * 50000)
```

For the prepared 8-turn scenario this means about `400000` tokens must remain after reserve. This is intentionally conservative because the failed run used about `144321` tokens in only the first three substantive turns.

## Verification

- `npm.cmd test -- tests\productionOpenAiRuntimePreflight.test.mjs tests\productionLiveGate.test.ts tests\productionLiveDialoguePolicy.test.mjs` - passed, 21 tests
- `npm.cmd run test:remediation:predeploy` - passed, 32 test files / 340 tests, agentic eval 216 tests, production build passed
- `npm.cmd run test:remediation:completion-audit` - expected fail on `postdeploy_live_gates_passed`
