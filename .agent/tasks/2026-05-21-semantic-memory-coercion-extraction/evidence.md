# Evidence: Semantic Memory Coercion Extraction

Task ID: `2026-05-21-semantic-memory-coercion-extraction`
Date: 2026-05-21

## Verdict

PASS for the scoped semantic-memory coercion extraction.

## Change Summary

- Added `src/ai/semanticMemoryCoercion.ts`.
- Moved semantic-memory coercion helpers out of `src/ai/assistant.ts`.
- Updated `src/ai/assistant.ts` to import `coerceSemanticMemory` and keep `coerceNeedUpdate` behavior unchanged.
- Added focused tests in `tests/semanticMemoryCoercion.test.ts`.
- No prompts, model names, OpenAI request shape, product selection, card rendering, recovery logic, or business policy were changed.
- No regex constructs were added.

## Size Impact

- `src/ai/assistant.ts`: 12347 lines after the pass.
- `src/ai/semanticMemoryCoercion.ts`: 157 lines.

## Validation

- `npm test -- tests/semanticMemoryCoercion.test.ts tests/recommendationRanking.test.ts tests/assistantNeedExtractionSchemas.test.ts`
  - PASS: 3 files, 211 tests.
- `npm run lint:no-regex`
  - PASS: `No new regex constructs. Legacy baseline: 1828.`
- `npm run typecheck`
  - PASS.
- `npm run build`
  - PASS.
- `npm test`
  - PASS: 71 files, 586 tests.
- `git diff --check`
  - PASS with line-ending warnings only.

## Production Gate

Production Promptfoo/widget was not rerun for this pass. This is deterministic coercion extraction only; it does not change prompts, model selection, OpenAI request semantics, tools, product/card behavior, or user-facing answer logic.

Railway marker check is required after push.
