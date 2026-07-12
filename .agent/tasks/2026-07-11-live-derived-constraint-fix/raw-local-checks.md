# Raw local checks

## Focused regression suite

Command:

`npm test -- --run tests/agentManagerContracts.test.ts tests/agentManagerCardSelection.test.ts tests/agentManagerOrchestrator.test.ts`

Result: 3 files, 133 tests, PASS.

## Full release gate

Command: `npm run verify`

Result:

- Node.js 24.14.1: PASS
- no new regex constructs relative to HEAD: PASS
- production dependency audit, high severity: 0 vulnerabilities
- TypeScript typecheck: PASS
- full test suite: 105 files, 938 tests, PASS
- agentic eval suite: 4 files, 251 tests, PASS
- production build: PASS

## Complete dependency audit

Command: `npm audit --audit-level=low`

Result: `found 0 vulnerabilities`.

## Diff check

Command: `git diff --check`

Result: PASS; warnings only announce future LF-to-CRLF conversion in the Windows worktree.

## Non-blocking tooling notice

The release gate prints Node warning `[DEP0190]` for an existing `shell: true` child-process invocation. It does not affect this behavior fix and is not a failing release criterion.
