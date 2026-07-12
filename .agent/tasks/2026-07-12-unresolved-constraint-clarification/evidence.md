# Evidence — unresolved strict constraint clarification

Current verdict: `PASS_LOCAL / PENDING_COMMIT_DEPLOY_REPLAY`

## Production evidence

- Deployed source commit: `bebf07fd6e23f868fcb8b0ee8dc31845c626c00a`.
- Embedded-widget session: `b7d72da7-2b6e-4a3f-aa53-cd3f9d03b706`.
- Failing turn: `e103014e-8920-4d07-bf24-062179fba510`.
- The planner and answer contract chose a useful `needs_more_info` clarification with no selected products or cards.
- Mechanical review replaced it because a strict typed requirement was intentionally pending until the buyer supplied pump data.

## Implementation evidence

- Strict `product_type` / `product_class` is now mechanically bound to `canonicalProductClass`; mismatches or non-null units fail closed.
- Unresolved strict requirements continue to suppress answer product evidence and visible cards.
- Mechanical `unverifiable_strict_hard_constraint` is raised only if the answer selects products or declares that cards are safe.
- A no-card `needs_more_info` clarification follows the normal production risk-review policy instead of receiving a canned calculation-failure rewrite.
- Concrete recommendations under the same unresolved requirement remain blocked.
- Evidence already enclosed in Russian or ASCII quotes is not double-wrapped.
- No phrase-specific regex, product-specific sentence matcher or pump-specific response branch was added.

## Tests

- Canonical product-class success and mismatch failure.
- Safe pending-calculation clarification preserved with semantic review in production `risk` mode.
- Existing unsafe strict-noise recommendation remains mechanically rewritten.
- Already quoted evidence does not produce `««... »»`.
- Full existing derived-load, max/kVA, catalog retry and recovery suite remains green.

## Fresh local checks

- Focused contracts/card/orchestrator suite: `135/135 PASS`.
- Full release gate: `105/105` files, `940/940` tests, `251/251` agentic evals, typecheck, build, high dependency audit and no-new-regex gate all `PASS`.
- `npm audit --audit-level=low`: `0 vulnerabilities`.
- `git diff --check`: `PASS` with only Windows LF-to-CRLF notices.
- Fresh read-only verifier: `PASS_LOCAL` for `AC1-AC9`; its focused rerun passed `125/125`, full rerun passed `940/940` plus `251/251` agentic evals, and it found no blocking issue.

## Pending

- Commit and GitHub push.
- Exact Railway commit marker.
- Fresh embedded-widget replay of the adaptive generator dialogue and authenticated metadata audit.
