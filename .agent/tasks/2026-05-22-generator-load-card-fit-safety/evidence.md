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
- Production Promptfoo after `e2b9731`: score gate PASS, `5/6`, deterministic average `0.9362222222222222`, LLM average `0.9549999999999997`.

## Acceptance criteria

- AC1: PASS. Unit coverage proves products below structured `requiredNominalKw` are filtered before visible cards.
- AC2: PASS. Existing and updated tests prove fitting generator products remain visible.
- AC3: PASS. Orchestrator test proves all-below-load catalog results become `not_found` with `catalog_search_no_generator_load_fit`.
- AC4: PASS. `npm run lint:no-regex` reports no new regex constructs.
- AC5: PASS. Local non-OpenAI gates passed.
- AC6: PASS for score gate. Production Promptfoo after Railway deploy had deterministic and LLM averages above 90%. Remaining formal `5/6` failure was unrelated plate card continuity and is tracked in `.agent/tasks/2026-05-22-visible-card-continuity/`.
