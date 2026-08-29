# Local Verification Output

Verified at `2026-08-29T10:56:17.375Z` against the current worktree.

## `npm run verify`

```text
[release-gate] PASS Node.js >=22 runtime (24.14.1)
[release-gate] PASS no new regex constructs relative to HEAD
[release-gate] PASS production dependency audit (high severity): 0 vulnerabilities
[release-gate] PASS TypeScript typecheck
[release-gate] PASS full test suite (serial files)
Test Files 88 passed (88)
Tests 887 passed (887)
[release-gate] PASS agentic eval suite
Test Files 4 passed (4)
Tests 190 passed (190)
[release-gate] PASS production build
[release-gate] PASS: all local release checks succeeded.
```

## Focused Suites

```text
tests/agentManagerOrchestrator.test.ts: 110 passed
tests/agentManagerConditionalWebShortCircuit.test.ts: 49 passed
tests/agentManagerHarnessContracts.test.ts: 7 passed
tests/agentManagerSearchBeforeSpecialistIntegration.test.ts: 9 passed
Total: 175 passed
```

## Standalone Guards

```text
npm run typecheck: PASS
npm run lint:no-regex: PASS
No new regex constructs. Legacy baseline: 514.
Legacy findings removed since baseline: 15.
git diff --check: PASS (line-ending warnings only; no whitespace errors)
```

## Exact Index Snapshot

The Git index was exported with `git checkout-index` to a clean temporary directory. No unstaged or untracked repository files and no `.env` file were present.

```text
npm run typecheck: PASS
npm test -- --fileParallelism=false: PASS
Test Files 84 passed (84)
Tests 818 passed (818)
npm run test:eval:agentic: PASS
Test Files 4 passed (4)
Tests 190 passed (190)
npm run build: PASS
```

`npm run verify` could not execute only its Git-relative no-regex baseline step because `git checkout-index` exports files without `.git`. The same staged diff is a subset of the repository diff for which `npm run lint:no-regex` passed.

## Post-Live Correction Transport Fix

```text
npx vitest run tests/agentManagerOrchestrator.test.ts tests/openAIAgentManagerModel.test.ts --fileParallelism=false: PASS
Test Files 2 passed (2)
Tests 113 passed (113)
npm run verify: PASS
Test Files 88 passed (88)
Tests 887 passed (887)
Agentic Tests 190 passed (190)
Typecheck/build/no-regex/dependency audit: PASS
Exact staged snapshot without .env: 84 files / 818 tests, agentic 190, typecheck/build PASS
```

## Second Post-Live Schema and Guidance Fix

```text
Focused affected suites: PASS, 4 files / 134 tests
npm run verify: PASS
Test Files 88 passed (88)
Tests 888 passed (888)
Agentic Tests 191 passed (191)
Typecheck/build/no-regex/dependency audit: PASS
Exact staged snapshot without .env: 84 files / 819 tests, agentic 191, typecheck/build PASS
```

## Third Post-Live Diagnostic and Repair-Budget Fix

```text
Focused affected suites: PASS, 4 files / 134 tests
npm run verify: PASS
Test Files 88 passed (88)
Tests 889 passed (889)
Agentic Tests 191 passed (191)
Typecheck/build/no-regex/dependency audit: PASS
Exact staged snapshot without .env: 84 files / 820 tests, agentic 191, typecheck/build PASS
```

## Fresh-Verifier Budget Fix

```text
Focused affected suites: PASS, 5 files / 140 tests
npm run verify: PASS
Test Files 88 passed (88)
Tests 891 passed (891)
Agentic Tests 192 passed (192)
Typecheck/build/no-regex/dependency audit: PASS
Exact staged snapshot without .env: 84 files / 822 tests, agentic 192, typecheck/build PASS
Fresh read-only verifier: PASS for AC1-AC9; AC10 PENDING
```

## Cumulative Correction History Follow-Up

```text
npx vitest run tests/agentManagerOrchestrator.test.ts tests/openAIAgentManagerModel.test.ts --fileParallelism=false: PASS
Test Files 2 passed (2)
Tests 114 passed (114)
npm run typecheck: PASS
npm run verify: PASS
Test Files 88 passed (88)
Tests 891 passed (891)
Agentic Tests 192 passed (192)
Typecheck/build/no-regex/dependency audit: PASS
Exact staged snapshot without .env: 84 files / 822 tests, agentic 192, typecheck/build PASS
Fresh read-only verifier: PASS for AC1-AC9; AC10 PENDING
```

## Generator Loads Guidance Fix

```text
npx vitest run tests/agentManagerOrchestrator.test.ts tests/openAIAgentManagerModel.test.ts --fileParallelism=false: PASS
Test Files 2 passed (2)
Tests 115 passed (115)
npm run typecheck: PASS
npm run verify: PASS
Test Files 88 passed (88)
Tests 892 passed (892)
Agentic Tests 192 passed (192)
Typecheck/build/no-regex/dependency audit: PASS
Exact staged snapshot without .env: 84 files / 823 tests, agentic 192, typecheck/build PASS
Fresh read-only verifier: PASS for AC1-AC9; AC10 PENDING
```
