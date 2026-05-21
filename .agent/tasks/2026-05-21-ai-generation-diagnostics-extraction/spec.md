# AI Generation Diagnostics Extraction Spec

## Current Behavior

`src/ai/assistant.ts` still defines AI fallback diagnostic types and helpers inline:

- `emptyAiGenerationDiagnostics`
- `aiFailureReason`
- `markAiFallback`
- `aiStageFailure`

These helpers are pure diagnostics utilities. They normalize OpenAI/runtime errors into fallback stage metadata and throw stable stage failure errors. They are used by legacy and fast-turn runtime paths, but they do not need to live inside the oversized assistant runtime module.

Current behavior to preserve:

- Empty diagnostics has all three fallback stages marked `used: false`.
- String errors are preserved as-is.
- Object errors are normalized through the existing `safeError` semantics.
- `markAiFallback` mutates the provided diagnostics object when present and still returns the entry.
- `aiStageFailure` keeps the same message format.

## Structural Improvement

Extract diagnostics types and helpers into:

- `src/ai/aiGenerationDiagnostics.ts`

`assistant.ts` should import the extracted helpers and keep behavior unchanged.

## Validation

AC1. `assistant.ts` no longer defines AI fallback diagnostics helpers inline.

AC2. Focused tests prove default diagnostics, string/object error normalization, mutation behavior, and stage error message stability.

AC3. Existing assistant behavior tests still pass.

AC4. `npm run lint:no-regex` proves no new regex constructs were added.

AC5. `npm run typecheck`, `npm run build`, and full `npm test` pass.

AC6. No production Promptfoo rerun is required for this pass because it is a pure extraction of diagnostics helper code with no prompt/API/model/tool/business behavior change.
