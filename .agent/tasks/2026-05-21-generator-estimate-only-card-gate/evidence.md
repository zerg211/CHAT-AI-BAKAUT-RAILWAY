# Evidence

## Implementation

- `src/ai/agentManagerGeneratorLoad.ts` validates generator load tool payloads:
  - `generator_load_invalid_load_kind` when the planner sends a product class as a load kind;
  - `generator_load_estimate_only` when every usable load source is `estimated_average`.
- `src/ai/agentManagerOrchestrator.ts` denies generator catalog tools after an unconfirmed generator load basis.
- `src/ai/agentManagerCardSelection.ts` suppresses visible cards after an unconfirmed generator load basis even when the answer contract says cards are ready.
- `tests/agentManagerOrchestrator.test.ts` covers the production failure shape where `calculator.generatorLoad` is followed by `catalog.search` before the load basis is confirmed.

## Local Checks

- `npm test -- tests/agentManagerOrchestrator.test.ts` PASS: 1 file, 22 tests.
- `npm run typecheck` PASS.
- `git diff --check` PASS.

## OpenAI / Live Checks

- Local OpenAI-dependent checks were not run. They are invalid in this environment because local OpenAI calls return `403 Country, region, or territory not supported`.
- Railway `/api/health` showed deployed commit `4b5eaea10366b715758adea99c4cff1d56584ba8`.
- Production Promptfoo through Railway + `https://bakautprof.ru/` PASS: 6/6 tests, score 6, 27/27 assertions.
- Production Promptfoo raw artifact: `.agent/tasks/2026-05-21-generator-estimate-only-card-gate/production-evals-after-4b5eaea.json`.
- `ALLOW_PRODUCTION_LIVE_TESTS=1 FINAL_RELEASE_LIVE_GATE=1 ALLOW_FIXED_PRODUCTION_REPLAY=1 npm run test:live:production` PASS.
- Production protocol: `local-live-tests/2026-05-21-bakautprof-production-agent-cycle.production.md`.
- The first production run exposed a stale live-gate metadata assertion that required legacy `executionContract` on AgentManager messages. `tests/liveAgentCycle.production.mjs` now accepts the current AgentManager metadata contract while still checking legacy metadata when applicable.

## Acceptance Criteria

- AC1 PASS by unit test and implementation: invalid load kinds are flagged; estimate-only load profiles are flagged.
- AC2 PASS by unit test: generator `catalog.search` is denied after unconfirmed load basis.
- AC3 PASS by unit test: visible cards are suppressed even when the answer contract says cards are ready.
- AC4 PASS by prompt audit: planner, answer, and reviewer instructions include the unconfirmed generator load policy.
- AC5 PASS: only non-OpenAI local checks were run.
- AC6 PASS: GitHub push, Railway deployment, and production live gate completed.
