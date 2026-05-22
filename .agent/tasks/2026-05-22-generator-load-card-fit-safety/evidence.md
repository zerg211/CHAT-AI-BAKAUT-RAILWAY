# Generator Load Card Fit Safety Evidence

## Pre-fix production signal

Production Promptfoo after `22d1cb8` returned `5/6` with deterministic average `0.9761111111111113` and LLM average `0.86`.

Failing case: `generator_load_selection`.

Observed bottleneck: `calculator.generatorLoad` produced `profile.requiredNominalKw = 7`, while `catalog.search` still returned weak generator cards around `1.8-3.4 kW`. The answer said the weak options were not enough, but visible cards contradicted the calculated requirement.

Raw artifact: `.agent/tasks/2026-05-22-no-regex-promptfoo-sse-parser/production-evals-after-22d1cb8.json`.

## Change

`catalog.search` now reads the latest successful `calculator.generatorLoad.payload.profile.requiredNominalKw` for generator searches and filters generator products through a deterministic fit gate before they are added to visible product candidates.

This is not regex or keyword intent matching. The LLM/tool layer decides the load profile as structured data; code enforces catalog/card factual consistency.

## Local checks

- `npm test -- tests/agentManagerCardSelection.test.ts tests/agentManagerOrchestrator.test.ts`: PASS, 40 tests.
- `npm run lint:no-regex`: PASS, legacy baseline `1794`, no new regex constructs.
- `npm run typecheck`: PASS.
- `npm test`: PASS, 76 files, 621 tests.
- `git diff --check`: PASS.
- `npm run build`: PASS.

## Acceptance criteria

- AC1: PASS. Unit coverage proves products below structured `requiredNominalKw` are filtered before visible cards.
- AC2: PASS. Existing and updated tests prove fitting generator products remain visible.
- AC3: PASS. Orchestrator test proves all-below-load catalog results become `not_found` with `catalog_search_no_generator_load_fit`.
- AC4: PASS. `npm run lint:no-regex` reports no new regex constructs.
- AC5: PASS. Local non-OpenAI gates passed.
- AC6: PENDING. Requires commit, push, Railway deployment, then production Promptfoo/widget check.
