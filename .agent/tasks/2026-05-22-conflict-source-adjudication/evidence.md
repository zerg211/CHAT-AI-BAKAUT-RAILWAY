# Evidence: conflict source adjudication

## Changes verified

- Exact catalog extraction no longer returns early from `researchProductComparisonFacts`.
- Exact-model research now sends catalog extraction into external research as evidence to verify/adjudicate.
- Source conflicts trigger deeper missing-fact retry unless the result is marked `source_conflict_adjudicated`.
- Web coverage with an external `sourceUrl` is validated against that external URL, not against the local catalog product just because the title/model matches.
- Tests cover catalog manual-only vs corroborated external electric/button start.

## Commands

```powershell
npx vitest run tests/productComparisonResearch.test.ts
```

Result: PASS, 8 tests.

```powershell
npx vitest run tests/productComparisonResearch.test.ts tests/agentManagerIntegrationSource.test.ts tests/agentManagerComparisonResearch.test.ts
```

Result: PASS, 3 files, 27 tests.

```powershell
npm run typecheck
```

Result: PASS.

```powershell
npm run lint:no-regex
```

Result: PASS, no new regex constructs.

## Notes

Production live readiness still requires commit, push, Railway deploy pickup, and a real widget check on `https://bakautprof.ru/`.
