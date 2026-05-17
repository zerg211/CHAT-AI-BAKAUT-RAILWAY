# Completion audit live evidence cleanup

Date: 2026-05-17

## Finding

After the postdeploy marker was refreshed without live dialogs, `remediationCompletionAudit` still embedded the old `production-agent-cycle-failure.json` details under `postdeploy_live_gates_passed`.

That made the report ambiguous: the current postdeploy artifact had `stage=production_marker_complete_live_skipped`, but the completion audit still showed an old recovery/quota failure as if it belonged to the current run.

## Change

Updated `tests/remediationCompletionAudit.mjs` so live failure evidence is included only when the current postdeploy stage actually attempted live gates:

- `live_gates_started`;
- `complete`.

When the current stage is `production_marker_complete_live_skipped`, the audit now records the live-gate policy and required env flags instead of stale failure details.

## Result

The completion audit remains correctly failed on the required final blocker:

```text
postdeploy_live_gates_passed
```

But the evidence now says why it is incomplete:

- current postdeploy live was not attempted;
- production marker and runtime artifacts are present;
- final widget live gate still needs a deliberate, non-repeating run.

## Verification

- `npm.cmd run test:remediation:postdeploy` - passed, live skipped by policy
- `npm.cmd run test:remediation:completion-audit` - expected fail only on `postdeploy_live_gates_passed`
- `npm.cmd run test:remediation:predeploy` - passed
