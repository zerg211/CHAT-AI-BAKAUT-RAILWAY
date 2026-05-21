# Evidence: Need Extraction Schema Extraction

Task ID: `2026-05-21-need-extraction-schema-extraction`
Date: 2026-05-21

## Verdict

PASS for the scoped schema extraction.

## Change Summary

- Added `src/ai/assistantNeedExtractionSchemas.ts`.
- Moved deterministic need-extraction and semantic-memory schema builders out of `src/ai/assistant.ts`.
- Updated `src/ai/assistant.ts` to import:
  - `activeNeedSchema`
  - `needExtractionSelectionStateSchema`
  - `needItemSchema`
  - `semanticMemorySchema`
- Added focused schema contract tests in `tests/assistantNeedExtractionSchemas.test.ts`.
- No prompts, model names, OpenAI stage names, coercion, product selection, card rendering, recovery logic, or business policy were changed.
- No regex constructs were added.

## Size Impact

- `src/ai/assistant.ts`: 12945 lines after the pass.
- `src/ai/assistantNeedExtractionSchemas.ts`: 267 lines.

## Validation

- `npm test -- tests/assistantNeedExtractionSchemas.test.ts tests/recommendationRanking.test.ts tests/assistantStructuredJson.test.ts`
  - PASS: 3 files, 212 tests.
- `npm run lint:no-regex`
  - PASS: `No new regex constructs. Legacy baseline: 1828.`
- `npm run typecheck`
  - PASS.
- `npm run build`
  - PASS.
- `npm test`
  - PASS: 69 files, 579 tests.
- `git diff --check`
  - PASS with line-ending warnings only.

## Production Gate

Production Promptfoo/widget was not rerun for this pass. This is a schema-builder extraction with the same schema objects imported from a new module; it does not change prompts, model selection, OpenAI request semantics, tools, product/card behavior, or user-facing answer logic.

Railway marker check is required after push.
