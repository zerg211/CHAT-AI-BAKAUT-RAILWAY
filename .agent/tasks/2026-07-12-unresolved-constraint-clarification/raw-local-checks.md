# Raw local checks

- `npm test -- --run tests/agentManagerContracts.test.ts tests/agentManagerCardSelection.test.ts tests/agentManagerOrchestrator.test.ts`: 3 files, 135 tests, PASS.
- `npm run verify`: 105 files, 940 tests, 251 agentic evals, typecheck, build, high dependency audit and no-new-regex gate, PASS.
- `npm audit --audit-level=low`: 0 vulnerabilities.
- `git diff --check`: PASS; only LF-to-CRLF notices.
- Independent read-only verifier: AC1-AC9 PASS_LOCAL; focused rerun 125/125, full rerun 940/940, agentic evals 251/251, no blocking issue.
