# LLM Fast-Turn Contract Extraction Evidence

## Refactor

- Added `src/ai/llmFastTurnContracts.ts` for LLM fast-turn route/answer schemas, types, and coercion helpers.
- Updated `src/ai/assistant.ts` to import those contracts instead of defining them inline.
- Added `tests/llmFastTurnContracts.test.ts` for route defaults, answer coercion, and exported schema names.

`assistant.ts` line count after extraction: `12722`.

## Validation

- `npm test -- tests/llmFastTurnContracts.test.ts tests/assistantFallback.test.ts tests/assistantControlPlaneGenerate.test.ts`
  - PASS: 3 files, 32 tests.
- `npm run typecheck`
  - PASS.
- `npm run lint:no-regex`
  - PASS: `No new regex constructs. Legacy baseline: 1832.`
- `npm run build`
  - PASS.
- `npm test`
  - PASS: 66 files, 562 tests.

## Production gate

Not rerun for this pass. The change is a pure extraction of fast-turn contracts and coercion with no prompt text, API, model, tool, or business behavior change. Production behavior remains covered by the previous passing production gate:

- runtime commit: `6af7911`
- Promptfoo: 6/6 PASS
- deterministic average: `0.9935555555555555`
- LLM average: `0.9649999999999999`
