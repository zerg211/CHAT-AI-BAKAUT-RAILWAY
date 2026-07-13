# Local gate

Verified against the current worktree on 2026-07-13.

- `npm.cmd test -- tests/agentManagerCardSelection.test.ts tests/agentManagerOrchestrator.test.ts`: PASS, 147 tests.
- `npm.cmd run test:eval:agentic`: PASS, 251 tests.
- `npm.cmd run verify`: PASS with network access.
  - dependency audit: 0 vulnerabilities;
  - typecheck: PASS;
  - full suite: 968 tests PASS;
  - agentic eval: 251 tests PASS;
  - production build: PASS;
  - no-new-regex gate: PASS.
- `git diff --check`: PASS.

After adding the stale-load compatibility guard, the current-code checks were rerun: focused 147/147, full suite 968/968, agentic eval 251/251, typecheck/build/regex guard PASS, and production dependency audit 0 vulnerabilities.

The first non-networked `npm.cmd run verify` attempt was correctly treated as BLOCKED because the npm audit endpoint was unreachable. It was not counted as a pass. The complete rerun with registry access passed.
