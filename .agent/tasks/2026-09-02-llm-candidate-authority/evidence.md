# Evidence: LLM candidate authority

## Local Verdict

PASS for AC1-AC8, including the follow-up fix for the failed production audit. AC9 is pending a new deployment and successful production widget verification.

## Acceptance Criteria

- AC1 PASS: unknown nominal active power survives `filterGeneratorProductsByLoadProfile`; proven underpowered products are still dropped and an unconfirmed warning is emitted.
- AC2 PASS: unknown power source survives structured policy and final card selection; known gasoline/diesel conflicts are still dropped for battery requirements.
- AC3 PASS: material keyword helpers and post-writer material filtering were removed; material proof status can still exclude only when the normalized proof is actually `violated`.
- AC4 PASS: current typed tool candidates are retained for writer evidence; legacy class matching only ranks current retrieval and scopes broad expansion pools.
- AC5 PASS: matching open text can satisfy a requirement, while open-text mismatch is `unverified`; numeric, boolean, phase, and fuel conflicts remain deterministic.
- AC6 PASS: `selectedProductIds` order is preserved and post-writer code validates identity and factual constraints without reapplying class/material keyword semantics.
- AC7 PASS: focused regressions cover unknown power, unknown source at final fit, material disagreement, class disagreement, open-text mismatch, preliminary generator cards with incomplete load evidence, equivalent 220/230 V and 380/400 V representations, and retained deterministic conflicts.
- AC8 PASS: typecheck, focused tests, agentic tests, full tests, regex guard, build, and diff check pass.
- AC9 PENDING: the deployed `e250b93` audit failed because incomplete load evidence suppressed preliminary cards and 220/230 V triggered a semantic mismatch. The local remediation has not yet been committed, pushed, deployed, or successfully audited in the production widget.

## Verification Commands

- `npm run typecheck`: PASS
- Focused seven-file Vitest suite: PASS, 278 tests
- `npm run test:eval:agentic`: PASS, 205 tests
- `npm test`: PASS, 873 tests across 84 files
- `npm run lint:no-regex`: PASS, no new regex constructs; 15 legacy findings removed
- `npm run build`: PASS
- `git diff --check`: PASS

## Notes

The first full-suite run after the remediation was executed concurrently with typecheck. One unrelated `leadRoutes` test exceeded its 5-second timeout. It passed in 204 ms when rerun alone, and the complete suite then passed sequentially with 873 tests. A fresh read-only verifier independently reran the focused, agentic, full, typecheck, no-regex, build, and diff checks against the current tree and found no blocking issues for AC1-AC8.
