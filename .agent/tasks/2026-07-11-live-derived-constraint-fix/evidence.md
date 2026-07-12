# Evidence — derived strict constraint remediation

Current verdict: `PASS_LOCAL / PENDING_COMMIT_DEPLOY_PRODUCTION_REPLAY`

## Production failure that triggered the work

- Embedded production widget: `https://bakautprof.ru/`.
- Session: `678e31eb-6899-4092-83b0-8350fd6a47b7`.
- Failing turn: `188153c4-59de-4088-833b-4077c08f83de`.
- The buyer supplied a 1.1 kW borehole pump, a 1.5 kW angle grinder, single-phase 220 V, simultaneous operation and no autostart.
- `calculator.generatorLoad` succeeded and produced `requiredNominalKw = 5.5` in the original production turn.
- Catalog filtering retained useful single-phase candidates, but `preSendReview` incorrectly rechecked the already-consumed operating scenario as an unsupported product attribute, removed the products and replaced the answer with a generic refusal.

The negative production protocol is stored in `local-live-tests/2026-07-11-ai-manager-remediation.production.md` with verdict `FAIL_REQUIRES_FIX` until the post-deploy replay is completed.

## Implemented boundary

- `SelectionRequirement.verification` distinguishes `product_attribute` from `typed_tool` verification.
- `ToolRequest.coversRequirementIds` explicitly binds a requirement to a required typed request.
- Legacy persisted contracts remain parseable; missing verification continues to fail closed.
- The only supported generator-derived binding is the stable ontology kind `generator_load_scenario`, `value=true`, `unit=null`, verified by `calculator.generatorLoad / generator_load_profile -> nominal_power_min_kw`.
- Deterministic proof checks request existence, required status, tool identity, explicit coverage, current result identity, successful status, safe calculation basis and a finite positive `requiredNominalKw`.
- Unknown strict attributes, mismatched kinds, mismatched units, malformed profiles and failed/missing tools remain fail closed.
- Derived load limits use confirmed active nominal power only. Maximum-only values, kVA-only values and an unlabeled number in a product name cannot impersonate confirmed nominal kW.
- The derived minimum is enforced before the answer writer and again before visible cards.
- Typed proof requests are executed before catalog requests that depend on them.
- When the first catalog pool contains no model meeting the calculated minimum, one bounded load-aware search retry is performed and recorded.
- Recovery that replans an intent invalidates stale read/calculator artifacts even when a new request reuses the same ID. A previously completed lead side effect can be rebound only when the new intent still contains valid current authorization/evidence, preventing duplicate lead creation.
- A true product-attribute blocker quotes the buyer's exact evidence. A tool/calculation failure is described honestly as an incomplete calculation, not as absent product characteristics.

## Regression and adversarial coverage

- Successful derived generator constraint and weak-product filtering.
- Missing, failed, wrong-tool, wrong-request, uncovered, malformed and unsafe calculator results.
- Product-class mismatch.
- Unknown strict product attribute remains blocked.
- Arbitrary `noise_max_db` cannot borrow a valid generator calculation.
- Wrong kind/value/unit combinations remain blocked.
- Maximum-only, kVA-only and displayed-max-versus-explicit-nominal products fail closed.
- Real Bakaut catalog specs with the active unit in the key (for example `мощность номинальная при 220 в, квт: 4.7`) are accepted, while the analogous kVA key remains fail closed.
- Pre-writer evidence and visible-card filtering use the same confirmed nominal invariant.
- Catalog-first planner output is dependency-ordered so the calculator runs first.
- A weak initial catalog pool is recovered by one derived-load-aware retry.
- Recovery replanning does not reuse a stale same-ID generator profile.
- Existing non-derived generator selection behavior remains covered by the full suite.

## Fresh local verification

- Focused contracts/card/orchestrator suite: `133/133 PASS`.
- `npm run verify`: `105/105` files, `938/938` tests, `251/251` agentic evals, TypeScript typecheck, production build, high-severity dependency audit and no-new-regex gate all `PASS`.
- `npm audit --audit-level=low`: `0 vulnerabilities`.
- `git diff --check`: `PASS`; only Windows LF-to-CRLF notices.

## Pending release proof

- AC11: commit/push and exact Railway production marker.
- AC12: adaptive replay through the embedded widget, including buyer-visible response/cards and authenticated audit of `turnContract`, tool artifacts, warnings and review trace.
