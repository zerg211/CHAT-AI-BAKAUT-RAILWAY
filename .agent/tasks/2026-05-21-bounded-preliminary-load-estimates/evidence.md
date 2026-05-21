# Evidence: Bounded Preliminary Load Estimates

## Local Checks

- `npm test -- tests/agentManagerOrchestrator.test.ts` PASS: 1 test file, 24 tests after adding the stricter per-load basis-signal guard.
- `npm test -- tests/openaiStructured.test.ts tests/agentManagerOrchestrator.test.ts` PASS: 2 test files, 28 tests after fixing structured JSON parsing.
- `npm test -- tests/agentManagerOrchestrator.test.ts tests/openaiStructured.test.ts` PASS: 2 test files, 28 tests after adding `basisKind`.
- `npm test -- tests/agentManagerOrchestrator.test.ts tests/openaiStructured.test.ts tests/agentManagerIntegrationSource.test.ts` PASS: 3 test files, 37 tests on final `bcf920e`.
- `npm run typecheck` PASS.
- `git diff --check` PASS.
- `node --check evals/promptfoo/chat-app-provider.cjs` PASS.

## OpenAI / Live Checks

- Local OpenAI-dependent checks were not run. They are invalid in this environment because local OpenAI calls return `403 Country, region, or territory not supported`.
- Production Promptfoo after `5502ed2` failed: 5/6 pass. Raw artifact: `.agent/tasks/2026-05-21-bounded-preliminary-load-estimates/production-evals-after-5502ed2.json`.
- Production live gate after `5502ed2` PASS: `local-live-tests/2026-05-21-bakautprof-production-agent-cycle.production.md`.
- Remaining Promptfoo failure was not a generator business-rule failure: admin trace showed `Unexpected non-whitespace character after JSON...` in AgentManager recovery, caused by structured JSON parsing when the model returned a valid JSON object plus trailing text.
- Fix applied locally after failure: replace the fragile structured JSON slice with a balanced JSON object extractor. No user-text regex, keyword matching, or scenario phrase rule was added.
- Production Promptfoo after `d91ef7d` PASS: 6/6. Raw artifact: `.agent/tasks/2026-05-21-bounded-preliminary-load-estimates/production-evals-after-d91ef7d.json`.
- Production live gate after `d91ef7d` failed on the real widget: generic unknown pump produced generator cards before pump type or power was known. Failure session: `54930025-e14e-4d70-bf6b-229290d1b8e3`; raw ignored failure artifact: `local-live-tests/production-agent-cycle-failure.json`.
- Fix applied after live failure: add structured per-load `basisKind` so LLM must distinguish exact power, checked fact, specific type/function, generic load name, and unknown source. Runtime blocks preliminary generator cards when an estimated motor load is only `generic_load_name`. No regex, keyword matching, canned phrase, or scenario-specific buyer text rule was added.
- Production deploy marker after push: Railway `/api/health` showed `5c4502b41097519246a6a789780a5962b5c33df3` on branch `main`.
- Production Promptfoo after `5c4502b` PASS: 6/6. Raw artifact: `.agent/tasks/2026-05-21-bounded-preliminary-load-estimates/production-evals-after-5c4502b.json`.
- Production live gate after `5c4502b` PASS: `local-live-tests/2026-05-21-bakautprof-production-agent-cycle.production.md`.
- Final production deploy marker: Railway `/api/health` showed `16196c31a40c8e8d441545a85840204127682cb8` on branch `main`.
- Production Promptfoo after `16196c3` PASS: 6/6, score 1.0 on every case. Raw artifact: `.agent/tasks/2026-05-21-bounded-preliminary-load-estimates/production-evals-after-16196c3.json`.
- Production live gate after `16196c3` PASS: `local-live-tests/2026-05-21-bakautprof-production-agent-cycle.production.md`.

## Acceptance Criteria

- AC1 PASS by unit coverage: unbounded/invalid generator load basis blocks catalog search and cards.
- AC2 PASS by unit/live coverage: `estimateBasis="bounded_assumption"` is preserved only when per-load `basisKind` and basis signals make the estimate bounded enough.
- AC3 PASS by unit coverage: bounded assumptions allow `ready_for_preliminary_cards` and visible generator cards while keeping `exact_pump_power_or_model` in missing facts.
- AC4 PASS by unit coverage: product-class pseudo-loads still block catalog search/cards.
- AC5 PASS by code audit: no user-text regex or phrase matching was added; the model supplies structured `estimateBasis`, `basisKind`, and `basisSignals`, code validates the typed result.
- AC6 PASS: production Promptfoo and live widget gate passed after GitHub push and Railway deployment.
