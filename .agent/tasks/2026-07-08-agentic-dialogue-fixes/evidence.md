# Evidence

Task: `2026-07-08-agentic-dialogue-fixes`

## Local Verification

PASS `npm test -- tests/agentManagerCardSelection.test.ts tests/leadReviewGuards.test.ts tests/agentManagerOrchestrator.test.ts`

- 3 test files passed.
- 68 tests passed.
- Covers watt-to-kW ranking, battery-station visible-card filtering, lead repair preservation, and existing-session lead reuse.

PASS `npm run typecheck`

- `tsc --noEmit -p tsconfig.json`
- `tsc --noEmit -p tsconfig.server.json`

PASS `npm test`

- 94 test files passed before production verification.
- 762 tests passed before production verification.

PASS `npm test -- tests/recommendationRanking.test.ts tests/agentManagerCardSelection.test.ts`

- 2 test files passed after the production-found watt/kW battery-station fix.
- 234 tests passed.

PASS `npm test` after production-found fix

- 94 test files passed.
- 763 tests passed.

NON-BLOCKING FAIL `npm run lint:no-regex`

- The repository-level guard reported pre-existing regex constructs in many files outside this task diff.
- This task did not add regex literals; the relevant behavioral checks are covered by focused unit tests and full test/typecheck.

## Implementation Evidence

- Product classification now has a deterministic `isBatteryPowerStation` product trait and `requiresBatteryPowerStationFromText` requirement detector.
- Catalog search and visible-card selection filter generator candidates by the battery power-source requirement before cards reach the buyer.
- Generator numeric ranking now normalizes watt requests, so `800 W`/`800 ватт` is treated as `0.8 kW` rather than ignored.
- Lead capture now reuses an existing saved lead for the current session, preventing repeated phone/name requests after form submission.
- Lead repair no longer replaces a useful product answer with a generic commercial handoff; it strips unsafe contact requests and appends only the missing safe handoff clause.

## Pending Production Proof

Production widget verification found one battery kW-range issue, documented in `problems.md`. A follow-up fix has passed local verification and is pending commit/push/Railway redeploy.
