# Evidence: Bounded Preliminary Load Estimates

## Local Checks

- `npm test -- tests/agentManagerOrchestrator.test.ts` PASS: 1 test file, 23 tests.
- `npm run typecheck` PASS.
- `git diff --check` PASS.

## OpenAI / Live Checks

- Local OpenAI-dependent checks were not run. They are invalid in this environment because local OpenAI calls return `403 Country, region, or territory not supported`.
- Production live verification is pending until GitHub push and Railway deployment.

## Acceptance Criteria

- AC1 PASS by existing unit coverage: unbounded/invalid generator load basis blocks catalog search and cards.
- AC2 PASS by new unit coverage: `estimateBasis="bounded_assumption"` is preserved in `calculator.generatorLoad` payload.
- AC3 PASS by new unit coverage: bounded assumptions allow `ready_for_preliminary_cards` and visible generator cards while keeping `exact_pump_power_or_model` in missing facts.
- AC4 PASS by existing unit coverage: product-class pseudo-loads still block catalog search/cards.
- AC5 PASS by code audit: no user-text regex or phrase matching was added; the model supplies structured `estimateBasis`, code validates the typed result.
- AC6 PENDING until GitHub push, Railway deployment, and production live gate.
