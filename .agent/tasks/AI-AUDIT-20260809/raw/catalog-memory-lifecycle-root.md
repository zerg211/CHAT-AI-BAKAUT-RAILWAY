# Catalog snapshot and verified-memory lifecycle — root evidence

Date: 2026-08-09

## Product snapshot crash atomicity

- RED fixture added to `tests/catalogRepositoryFreshness.test.ts`: failure while inserting replacement source facts had to roll back the product row and all derived state.
- Owning-layer fix: `ProductRepository.upsertProduct` now performs product upsert, source-owned fact replacement, and conflict refresh on one checked-out DB client inside `BEGIN` / `COMMIT`; any error executes `ROLLBACK`.
- Conflict refresh now resolves no-longer-present open conflicts inside the same transaction instead of leaving stale conflict rows.
- Fresh command: `npm.cmd test -- --run tests/catalogRepositoryFreshness.test.ts` — 1 file, 7 tests, PASS before the verified-memory cases were added.

## Verified fact catalog fingerprint and supersession

- RED: `npm.cmd test -- --run tests/catalogRepositoryFreshness.test.ts` — 2 new failures. The repository did not use a transaction/fingerprint and lookup did not join the current product snapshot.
- Owning-layer fix:
  - `verified_product_facts` stores `catalog_source_hash` and deterministic `source_fingerprint`;
  - product-bound reuse requires the stored catalog hash to equal the current active product hash;
  - a newly verified different value from the same exact source/product/attribute supersedes the prior active value while preserving it as audit history;
  - insert/supersession/update execute in one transaction;
  - the active unique index is partial, so multiple historical superseded versions can coexist.
- GREEN: `npm.cmd test -- --run tests/catalogRepositoryFreshness.test.ts tests/verifiedFactMemory.test.ts` — 2 files, 18 tests, PASS.
- PostgreSQL fault-injection integration is not locally available because Docker/PostgreSQL is unavailable in this environment. SQL transaction order and rollback are covered by explicit client fault injection; production migration/readback remains a release check.

## Scope

Files changed in this slice: `src/db/repositories.ts`, `src/db/migrate.ts`, `src/shared/types.ts`, `tests/catalogRepositoryFreshness.test.ts`.
