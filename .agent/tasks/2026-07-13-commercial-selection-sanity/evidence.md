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

## Production attempt 1

- Commit marker: PASS for `50ee8a5d8d7b64346933c628844a20842c3ebeb0`.
- Embedded session: `9ad5a646-0f86-4bf5-8df2-1984dcd84538`.
- Buyer-view audit: FAIL on turn 3 because the assistant contradicted its immediately previous gasoline cards and claimed that no model could be shown.
- Admin audit: FAIL. The planner correctly produced strict `fuel_type=gasoline`; deterministic strict validation did not support that requirement kind and suppressed all products. Turns 2-4 were recovered, and pre-send review did not catch the cross-turn contradiction.
- Protocol: `local-live-tests/2026-07-13-commercial-selection-sanity-attempt-1.production.md`.

The release remains unaccepted. The fuel-type validator fix and its exact regression are local-only until a new commit is pushed and a fresh embedded production audit passes.

## Local verification after attempt 1

- Strict `fuel_type=gasoline` is now accepted only when bound to typed `selectionPolicy.powerSource=fuel`.
- Gasoline/diesel remains a deterministic catalog fact check; LLM still owns interpretation of the buyer's request.
- Exact regression keeps SUMEC SU8800 and TSS SGG 5000N while removing FIRMAN diesel.
- Focused suites: PASS, 149/149.
- Full suite: PASS, 970/970.
- Agentic eval: PASS, 251/251.
- Typecheck, production build, no-new-regex guard, diff check: PASS.
- Production dependency audit: PASS, 0 vulnerabilities.
