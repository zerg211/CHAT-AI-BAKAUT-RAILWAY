# Production live external scenario gate

Date: 2026-05-17

## Finding

The diverse production live script had a non-repeat signature guard, but it still contained a bundled buyer dialogue. Because older production protocols did not contain signatures, the bundled dialogue could still be run once more and look like fresh evidence.

That conflicts with the live-check policy: final production validation must use a genuinely new buyer scenario with different wording and needs.

## Change

Added `loadProductionLiveDialogue` to `tests/productionLiveDialoguePolicy.mjs`.

`tests/liveAgentCycle.diverse.production.mjs` now requires one of these before it can open the browser:

- `PRODUCTION_LIVE_DIALOGUE_FILE=<path>` with a fresh JSON scenario;
- or explicit `ALLOW_BUNDLED_PRODUCTION_LIVE_DIALOGUE=1` for an intentional bundled run.

Scenario JSON shape:

```json
{
  "scenarioName": "fresh-final-live-example",
  "turns": [
    { "phase": "buyer_need", "user": "..." }
  ]
}
```

The scenario source is recorded in both the markdown protocol and the JSON admin artifact.

## Result

Approved production live execution without a fresh scenario file now fails before browser launch and before OpenAI usage. This keeps final validation aligned with the requirement: no repeated scripted dialogs unless the operator deliberately overrides the policy.

## Scenario preparation

Added a preparation CLI:

```text
npm.cmd run prepare:live:production:scenario
```

Optional variant selection:

```text
$env:PRODUCTION_LIVE_SCENARIO_VARIANT='farm_pump_generator_plate'
npm.cmd run prepare:live:production:scenario
```

Available tracked variants:

- `workshop_welder_compressor_bundle`;
- `farm_pump_generator_plate`;
- `rental_team_diesel_generator_trowel`.

The CLI writes a fresh JSON file under `local-live-tests/generated-production-live-scenarios`, records the dialogue signature, and prints the env values needed for the final postdeploy live command. If the same variant signature already exists in live artifacts, preparation fails before a repeated production dialogue can be queued.

Prepared local scenario for the pending final live gate:

```text
local-live-tests\generated-production-live-scenarios\final-live-workshop_welder_compressor_bundle-2026-05-17T11-42-34-318Z.json
```

This file is intentionally under `local-live-tests` and is not committed.

## Verification

- `npm.cmd test -- tests\productionLiveDialoguePolicy.test.mjs tests\productionLiveGate.test.ts` - passed
- `npm.cmd test -- tests\prepareProductionLiveDialogueScenario.test.mjs` - passed
- `npm.cmd run prepare:live:production:scenario` - passed and wrote a local scenario file
- `npm.cmd run typecheck` - passed
- `npm.cmd run test:remediation:predeploy` - passed
- `npm.cmd run test:remediation:postdeploy` - passed, live skipped by policy
- `npm.cmd run test:remediation:completion-audit` - expected fail only on `postdeploy_live_gates_passed`
- `node --check tests\productionLiveDialoguePolicy.mjs`
- `node --check tests\liveAgentCycle.diverse.production.mjs`
- `node --check tests\remediationPostdeploy.mjs`
