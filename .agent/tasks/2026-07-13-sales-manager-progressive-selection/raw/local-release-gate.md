# Local verification log

Date: 2026-07-13 Europe/Moscow

## Focused regression suite

Command:

`npm.cmd test -- tests/agentManagerContracts.test.ts tests/agentManagerGeneratorLoad.test.ts tests/agentManagerCardSelection.test.ts tests/dialogueLedgerReducer.test.ts tests/agentManagerOrchestrator.test.ts`

Result: PASS. The latest focused run before the final full-gate rerun covered 165 tests. It includes optional versus forbidden autostart, generator selection stages, 5.5-6.0 kW recovery, compromise tiers, exact product-id lookup, durable validated selections, and a five-turn continuity replay.

## Typecheck

Command: `npm.cmd run typecheck`

Result: PASS.

## Regex guard

Command: `npm.cmd run lint:no-regex`

Result: PASS. No new regex constructs; legacy baseline 1623.

## Agentic eval

Command: `npm.cmd run test:eval:agentic`

Result: PASS. 4 files, 251 tests.

## Full release gate

Command: `npm.cmd run verify`

Final-code result: PASS — dependency audit found 0 high-severity production vulnerabilities; typecheck passed; 105 test files / 965 tests passed; agentic eval 251 tests passed; production build passed.

Local OpenAI calls were intentionally not run because repository instructions mark them invalid in this environment. Production behavior must be verified after GitHub push through the embedded widget on `https://bakautprof.ru/`.
