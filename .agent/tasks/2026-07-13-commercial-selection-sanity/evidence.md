# Evidence: commercial selection sanity and evidence continuity

Status: IN PROGRESS

The specification is frozen before implementation. Production session `18a8f799-8325-43d2-a236-c2e0531078a2` is the authoritative failing baseline.

No acceptance criterion is marked PASS until current-code verification and the fresh embedded production audit are complete.

## Current-code local verification

- Focused selection suites: PASS, 147/147 tests.
- Full release gate: PASS after rerunning with registry access.
- Full test suite: PASS, 968/968 tests.
- Agentic eval suite: PASS, 251/251 tests.
- TypeScript typecheck: PASS.
- Production dependency audit: PASS, 0 vulnerabilities.
- Production build: PASS.
- New-regex guard: PASS; no phrase-specific regex was added.
- `git diff --check`: PASS.

The new regressions prove both failure modes locally:

1. one oversized 8.5 kW / 170,000 RUB survivor triggers canonical recovery and does not outrank closer 5.5-6.0 kW products;
2. a follow-up asking what to buy without overpaying reuses the prior safe calculator and catalog evidence, retains the close products, and completes without fallback.
3. when the buyer changes the load facts, the previous calculator result is rejected as stale and no product is presented as a validated fit from that old calculation.

Deployment and embedded production proof remain pending, so the task is not complete.
