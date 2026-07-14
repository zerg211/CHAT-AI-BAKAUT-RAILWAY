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

After production attempt 1 exposed unsupported strict `fuel_type`, the final current-code checks were rerun again: focused 149/149, full suite 970/970, agentic eval 251/251, typecheck/build/regex guard PASS, `git diff --check` PASS, and production dependency audit 0 vulnerabilities.

The first non-networked `npm.cmd run verify` attempt was correctly treated as BLOCKED because the npm audit endpoint was unreachable. It was not counted as a pass. The complete rerun with registry access passed.

After production attempt 10 exposed the recovery/lease transport race, the current-code checks were rerun: focused orchestrator and stream suites 86/86, full suite 976/976, agentic eval 251/251, typecheck/build/regex guard PASS, `git diff --check` PASS, and production dependency audit 0 vulnerabilities.

After production attempt 11 exposed redundant unit validation for typed `voltage_v`, the current-code checks were rerun: focused selection/orchestrator/stream suites 161/161, full suite 977/977, agentic eval 251/251, typecheck/build/regex guard PASS, `git diff --check` PASS, and production dependency audit 0 vulnerabilities.
