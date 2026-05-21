# Evidence: Product Trait Coercion Extraction

Task ID: `2026-05-21-product-trait-coercion-extraction`
Date: 2026-05-21

## Verdict

PASS for the scoped product-trait coercion extraction.

## Change Summary

- Added `src/ai/productTraitCoercion.ts`.
- Moved product intent/fuel/start/role/enclosure coercion, list coercion, nullable value coercion, and required product trait helpers out of `src/ai/assistant.ts`.
- Updated `src/ai/assistant.ts` to import the extracted helpers/types.
- Added focused tests in `tests/productTraitCoercion.test.ts`.
- Preserved the legacy behavior that `coerceProductIntentList` does not trim strings before enum coercion.
- No prompts, model names, OpenAI request shape, product ranking, card rendering, recovery logic, or business policy were changed.
- No regex constructs were added.

## Size Impact

- `src/ai/assistant.ts`: 12205 lines after the pass.
- `src/ai/productTraitCoercion.ts`: 154 lines.

## Validation

- `npm test -- tests/productTraitCoercion.test.ts tests/semanticMemoryCoercion.test.ts tests/recommendationRanking.test.ts tests/assistantTurnPlanSchemas.test.ts`
  - PASS: 4 files, 215 tests.
- `npm run lint:no-regex`
  - PASS: `No new regex constructs. Legacy baseline: 1828.`
- `npm run typecheck`
  - PASS.
- `npm run build`
  - PASS.
- `npm test`
  - PASS: 72 files, 590 tests.
- `git diff --check -- src/ai/assistant.ts src/ai/productTraitCoercion.ts tests/productTraitCoercion.test.ts`
  - PASS with line-ending warnings only.

## Scope Note

An unrelated local modification exists in `src/ai/productComparisonResearch.ts`. It was not part of this pass and must stay unstaged/out of this commit.

## Production Gate

Production Promptfoo/widget was not rerun for this pass. This is deterministic coercion extraction only; it does not change prompts, model selection, OpenAI request semantics, tools, product/card behavior, or user-facing answer logic.

Railway marker check is required after push.
