# Production live dialogue repeat guard

Date: 2026-05-17

## Context

Final production live validation must be done through the real widget on `https://bakautprof.ru/`, but it must not become another repeated scripted replay. Repeating the same buyer phrasing hides regressions where a fix only works for one exact wording.

## Finding

`tests/liveAgentCycle.diverse.production.mjs` used a broader buyer journey than the old fixed replay scripts, but the journey itself was still a fixed `turns` array. Nothing prevented running the same production dialogue again and treating it as fresh evidence.

Risk:

- repeated live checks could again spend OpenAI budget without adding new behavioral evidence;
- repeated phrasing could miss failures caused by alternate wording or changed buyer context;
- markdown protocols did not carry a durable scenario signature that future gates could compare.

## Change

Added `tests/productionLiveDialoguePolicy.mjs`.

It computes a SHA-256 signature from the ordered buyer phases and user turns, scans production live artifacts in `local-live-tests`, and blocks a repeated signature unless the operator explicitly sets:

```text
ALLOW_REPEAT_PRODUCTION_LIVE_DIALOGUE=1
```

Updated `tests/liveAgentCycle.diverse.production.mjs` so the final diverse production live gate:

- checks the non-repeat policy before opening the browser;
- records the scenario name, signature, turn count, and override status in the `.production.md` protocol;
- records the same policy metadata next to admin conversation details in the JSON artifact;
- includes the policy metadata in failure artifacts.

## Expected behavior

First run of a new final live scenario:

- allowed if `ALLOW_PRODUCTION_LIVE_TESTS=1` and `FINAL_RELEASE_LIVE_GATE=1`;
- writes `Dialogue signature: ...` into the production protocol.

Second run with the same exact buyer turns:

- blocked before browser/OpenAI usage;
- requires a deliberate override only when the repeated run is intentional.

## Residual risk

This guard detects exact scenario repetition, not semantic similarity. A weak "new" scenario could still be too close to an older one if only a few words are changed. The correct process remains: final live gate should use a genuinely new buyer need, different wording, and manual audit of each actual assistant reply.

## Verification

- `npm.cmd test -- tests\productionLiveDialoguePolicy.test.mjs tests\productionLiveGate.test.ts`
- `node --check tests\liveAgentCycle.diverse.production.mjs`
- `npm.cmd run test:remediation:predeploy`
- `npm.cmd run test:remediation:completion-audit` - expected fail only on `postdeploy_live_gates_passed`, because final production live widget verification has not been run yet.
