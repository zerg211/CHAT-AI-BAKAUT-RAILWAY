# AI Generation Diagnostics Extraction Evidence

## Refactor

- Added `src/ai/aiGenerationDiagnostics.ts`.
- Updated `src/ai/assistant.ts` to import AI fallback diagnostic helpers.
- Added `tests/aiGenerationDiagnostics.test.ts` for default diagnostics, failure reason normalization, mutation behavior, undefined diagnostics behavior, and stage error message stability.

`assistant.ts` line count after extraction: `12625`.

## Validation

- `npm test -- tests/aiGenerationDiagnostics.test.ts tests/assistantFallback.test.ts tests/assistantControlPlaneGenerate.test.ts`
  - PASS: 3 files, 35 tests.
- `npm run typecheck`
  - PASS.
- `npm run lint:no-regex`
  - PASS: `No new regex constructs. Legacy baseline: 1832.`
- `npm run build`
  - PASS.
- `npm test`
  - PASS: 67 files, 569 tests.

## Production gate

Not rerun for this pass. The change is a pure extraction of diagnostic helper code with no prompt text, API, model, tool, or business behavior change.
