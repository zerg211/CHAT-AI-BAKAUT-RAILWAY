# Evidence: Bounded Preliminary Load Estimates

## Local Checks

- `npm test -- tests/agentManagerOrchestrator.test.ts` PASS: 1 test file, 24 tests after adding the stricter per-load basis-signal guard.
- `npm test -- tests/openaiStructured.test.ts tests/agentManagerOrchestrator.test.ts` PASS: 2 test files, 28 tests after fixing structured JSON parsing.
- `npm run typecheck` PASS.
- `git diff --check` PASS.

## OpenAI / Live Checks

- Local OpenAI-dependent checks were not run. They are invalid in this environment because local OpenAI calls return `403 Country, region, or territory not supported`.
- Production Promptfoo after `5502ed2` failed: 5/6 pass. Raw artifact: `.agent/tasks/2026-05-21-bounded-preliminary-load-estimates/production-evals-after-5502ed2.json`.
- Production live gate after `5502ed2` PASS: `local-live-tests/2026-05-21-bakautprof-production-agent-cycle.production.md`.
- Remaining Promptfoo failure was not a generator business-rule failure: admin trace showed `Unexpected non-whitespace character after JSON...` in AgentManager recovery, caused by structured JSON parsing when the model returned a valid JSON object plus trailing text.
- Fix applied locally after failure: replace the fragile structured JSON slice with a balanced JSON object extractor. No user-text regex, keyword matching, or scenario phrase rule was added.
- Production verification for this parser fix is pending until GitHub push and Railway deployment.

## Acceptance Criteria

- AC1 PASS by unit coverage: unbounded/invalid generator load basis blocks catalog search and cards.
- AC2 PASS by unit coverage: `estimateBasis="bounded_assumption"` is preserved only when per-load basis signals make the estimate bounded enough.
- AC3 PASS by unit coverage: bounded assumptions allow `ready_for_preliminary_cards` and visible generator cards while keeping `exact_pump_power_or_model` in missing facts.
- AC4 PASS by unit coverage: product-class pseudo-loads still block catalog search/cards.
- AC5 PASS by code audit: no user-text regex or phrase matching was added; the model supplies structured `estimateBasis` and `basisSignals`, code validates the typed result.
- AC6 PENDING until GitHub push, Railway deployment, and production live gate.
