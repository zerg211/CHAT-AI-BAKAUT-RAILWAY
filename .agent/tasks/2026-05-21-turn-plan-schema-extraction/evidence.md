# Evidence: Turn Plan Schema Extraction

Task ID: `2026-05-21-turn-plan-schema-extraction`
Date: 2026-05-21

## Verdict

PASS for the scoped turn-planner schema extraction.

## Change Summary

- Added `src/ai/assistantTurnPlanSchemas.ts`.
- Moved deterministic `agentContractV2Schema` and `turnPlanSchema` out of `src/ai/assistant.ts`.
- Updated the planner response format to call `turnPlanSchema(MAX_PRODUCT_CARDS)`, preserving the current selected-product schema limit from the existing runtime constant.
- Added focused schema tests in `tests/assistantTurnPlanSchemas.test.ts`.
- No prompts, model names, OpenAI stage names, planner coercion, fallback logic, product selection, card rendering, recovery logic, or business policy were changed.
- No regex constructs were added.

## Size Impact

- `src/ai/assistant.ts`: 12482 lines after the pass.
- `src/ai/assistantTurnPlanSchemas.ts`: 463 lines.

## Validation

- `npm test -- tests/assistantTurnPlanSchemas.test.ts tests/assistantNeedExtractionSchemas.test.ts tests/recommendationRanking.test.ts tests/agentTurnContract.test.ts`
  - PASS: 4 files, 230 tests.
- `npm run lint:no-regex`
  - PASS: `No new regex constructs. Legacy baseline: 1828.`
- `npm run typecheck`
  - PASS.
- `npm run build`
  - PASS.
- `npm test`
  - PASS: 70 files, 582 tests.
- `git diff --check`
  - PASS with line-ending warnings only.

## Production Gate

Production Promptfoo/widget was not rerun for this pass. This is a schema-builder extraction with the same schema content imported from a new module; it does not change prompts, model selection, OpenAI request semantics, tools, product/card behavior, or user-facing answer logic.

Railway marker check is required after push.
