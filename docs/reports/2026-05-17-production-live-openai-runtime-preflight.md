# Production live OpenAI runtime preflight

Date: 2026-05-17

## Finding

The final production live gate was protected against repeated scenarios and missing approval flags, but it could still open the browser and begin the widget flow before discovering that the Railway OpenAI runtime was blocked by quota, billing, auth, model access, rate-limit, or network/runtime errors.

That is the exact failure class seen in the previous production live evidence: `insufficient_quota`.

## Change

Added `tests/productionOpenAiRuntimePreflight.mjs`.

Before `tests/liveAgentCycle.diverse.production.mjs` launches Playwright, it now:

1. verifies the production remediation marker;
2. calls `/api/admin/runtime/openai` with the admin token;
3. calls `/api/admin/openai-usage?hours=24&source=production_live_test`;
4. blocks before browser launch if the runtime is not healthy or the live-test token budget has no room after reserve.

Blocked classes include:

- `authentication`;
- `provider_access_region`;
- `quota_or_billing`;
- `model_project_or_org_access`;
- `rate_limit`;
- `network_or_timeout`;
- `network_or_runtime`;
- `budget_guard`.

## Result

The final live gate will not spend browser/test time or start a buyer dialogue when the production OpenAI runtime is already known to be unable to answer or the `production_live_test` daily token budget is exhausted. The failure artifact records the scenario, policy context, and preflight error details, but no widget conversation is attempted.

## Verification

- `npm.cmd test -- tests\productionOpenAiRuntimePreflight.test.mjs tests\productionLiveGate.test.ts tests\productionLiveDialoguePolicy.test.mjs` - passed, 16 tests
- `node --check tests\productionOpenAiRuntimePreflight.mjs`
- `node --check tests\liveAgentCycle.diverse.production.mjs`
- `npm.cmd run test:remediation:predeploy` - passed, 32 test files / 336 tests, agentic eval 216 tests, production build passed
- `npm.cmd run test:remediation:postdeploy` - passed, live skipped by policy
- `npm.cmd run test:remediation:completion-audit` - expected fail only on `postdeploy_live_gates_passed`
