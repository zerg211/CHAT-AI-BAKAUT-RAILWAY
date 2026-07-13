# Raw local checks

Date: 2026-07-13 (Europe/Moscow)

## Focused regression suite

Command:

`npm.cmd test -- --run tests/productClassifier.test.ts tests/agentManagerCardSelection.test.ts tests/agentManagerOrchestrator.test.ts`

Result:

- Test files: 3 passed.
- Tests: 153 passed.
- Exit code: 0.

## Full release gate

Command:

`npm.cmd run verify`

Final result:

- Node.js runtime: PASS (`24.14.1`, requirement `>=22`).
- No new regex constructs relative to HEAD: PASS.
- Production dependency audit: PASS, 0 vulnerabilities.
- TypeScript typecheck: PASS.
- Full test suite: PASS, 105 files and 957 tests.
- Agentic eval suite: PASS, 4 files and 251 tests.
- Production build: PASS.
- Exit code: 0.

The first sandboxed attempt reached green code/tests/build but could not contact the npm audit endpoint or write its cache log. `npm.cmd audit --audit-level=low` was rerun with approved external registry/cache access and returned `found 0 vulnerabilities`; the complete release gate was then rerun with the same approved access and passed.

## Additional checks

- `npm.cmd audit --audit-level=low` — PASS, `found 0 vulnerabilities`.
- `git diff --check` — PASS; only CRLF conversion warnings were emitted.
