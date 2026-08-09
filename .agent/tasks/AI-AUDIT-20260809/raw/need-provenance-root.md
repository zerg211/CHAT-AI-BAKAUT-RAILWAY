# Need-state provenance timestamp — root evidence

Date: 2026-08-09

- RED: `npm.cmd test -- --run tests/dialogueLedgerReducer.test.ts` — the confirmed fact created at `2026-08-09T10:00:00.000Z` was rehydrated with the current wall clock and looked newly learned.
- Fix: legacy `NeedItem.updatedAt` now uses the durable ledger fact `createdAt`, with current time only as a fallback for old snapshots that lack provenance.
- GREEN: same command — 1 file, 15 tests, PASS.
