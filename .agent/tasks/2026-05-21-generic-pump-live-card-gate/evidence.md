# Generic Pump Live Card Gate Evidence

## Summary

Status: PASS locally, production gate pending.

This pass addresses the production live widget failure captured after `4ac10b7`.

## Failure Evidence

- Command: `ALLOW_PRODUCTION_LIVE_TESTS=1 FINAL_RELEASE_LIVE_GATE=1 ALLOW_FIXED_PRODUCTION_REPLAY=1 npm run test:live:production`
- Failure: `Generic unknown pump produced generator cards before pump type or power was known.`
- Raw artifact: `local-live-tests/production-agent-cycle-failure.json`
- Session id: `f29acbe6-d964-4836-bb5d-6768d2b84433`

## Changed Files

- `src/ai/agentManagerGeneratorLoad.ts`
- `tests/agentManagerOrchestrator.test.ts`

## Local Validation

- `npm test -- tests/agentManagerOrchestrator.test.ts` PASS: 1 file, 25 tests.
- `npm test -- tests/agentManagerComparisonResearch.test.ts tests/agentManagerIntegrationSource.test.ts tests/agentManagerOrchestrator.test.ts` PASS: 3 files, 38 tests.
- `npm run lint:no-regex` PASS: no new regex constructs, legacy baseline remains 1832.
- `npm run typecheck` PASS.
- `npm run build` PASS.
- `git diff --check` PASS with line-ending warnings only.

## Production Gate

Pending after commit/push and Railway auto-deploy:

- production Promptfoo after the fix;
- production live widget replay through `https://bakautprof.ru/`.

## Acceptance Criteria

- AC1 PASS locally: omitted generic pump without kW creates incomplete/unbounded warnings.
- AC2 PASS locally: catalog search is denied after that warning.
- AC3 PASS locally: visible cards are suppressed by tool safety even when answer contract marks cards ready.
- AC4 PASS: no new regex constructs.
- AC5 LOCAL PASS, production Promptfoo pending.
- AC6 PENDING: production live widget gate pending.
