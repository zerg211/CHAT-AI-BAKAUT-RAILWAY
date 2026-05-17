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

## Verification

- `npm.cmd test -- tests\productionLiveDialoguePolicy.test.mjs tests\productionLiveGate.test.ts` - passed
- `npm.cmd run typecheck` - passed
- `node --check tests\productionLiveDialoguePolicy.mjs`
- `node --check tests\liveAgentCycle.diverse.production.mjs`
- `node --check tests\remediationPostdeploy.mjs`
