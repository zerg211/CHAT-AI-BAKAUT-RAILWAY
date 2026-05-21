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
- Production live verification must run after commit/push and Railway deployment of the pushed commit.

## Acceptance Criteria

- AC1 PASS by unit test and implementation: invalid load kinds are flagged; estimate-only load profiles are flagged.
- AC2 PASS by unit test: generator `catalog.search` is denied after unconfirmed load basis.
- AC3 PASS by unit test: visible cards are suppressed even when the answer contract says cards are ready.
- AC4 PASS by prompt audit: planner, answer, and reviewer instructions include the unconfirmed generator load policy.
- AC5 PASS: only non-OpenAI local checks were run.
- AC6 PENDING until GitHub push, Railway deployment, and production live gate.
