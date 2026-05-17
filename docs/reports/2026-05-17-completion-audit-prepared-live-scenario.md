# Completion audit prepared live scenario evidence

Date: 2026-05-17

## Finding

The final production live gate now requires a fresh `PRODUCTION_LIVE_DIALOGUE_FILE`, but `remediationCompletionAudit` did not report whether such a file was prepared and valid. That made the remaining blocker less precise: the audit could only say "live gate not passed", not whether live preparation was ready.

## Change

Added a required completion-audit check:

```text
prepared_production_live_scenario_exists
```

The check scans:

```text
local-live-tests/generated-production-live-scenarios
```

and validates the latest prepared JSON scenario:

- has `scenarioName` and `variantName`;
- has at least 6 buyer turns;
- has a 64-character dialogue signature;
- has matching `productionLivePolicy.dialogueSignature`;
- was not produced with a repeat override;
- has no prior signature matches.

## Result

The completion audit can now distinguish:

- final live scenario is prepared and valid;
- production marker/runtime artifacts are deployed;
- the only remaining required blocker is the actual `postdeploy_live_gates_passed` run through `bakautprof.ru`.

Current prepared scenario:

```text
local-live-tests\generated-production-live-scenarios\final-live-workshop_welder_compressor_bundle-2026-05-17T11-42-34-318Z.json
```

## Verification

- `npm.cmd run test:remediation:completion-audit` - expected fail only on `postdeploy_live_gates_passed`
- `node --check tests\remediationCompletionAudit.mjs`
- `npm.cmd run test:remediation:predeploy` - passed, 31 test files / 331 tests, agentic eval 216 tests, production build passed
