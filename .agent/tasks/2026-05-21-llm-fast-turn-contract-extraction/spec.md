# LLM Fast-Turn Contract Extraction Spec

## Current Behavior

`src/ai/assistant.ts` is still the largest module in the repository and contains unrelated responsibilities: runtime orchestration, fallback handling, product selection, prompt schemas, and LLM fast-turn contract coercion. The LLM fast-turn route/answer schema and coercion helpers are pure contract code, but they are embedded in the oversized runtime file.

Current behavior to preserve:

- Fast-turn route planning still uses the same JSON schema.
- Fast-turn answer composition still uses the same JSON schema.
- Parsed route decisions keep the same defaults by route.
- Parsed answer contracts keep the same trimming, boolean coercion, and string-array limits.
- Public assistant API remains unchanged.

## Structural Improvement

Extract the LLM fast-turn schema, types, and coercion helpers into a focused module:

- `src/ai/llmFastTurnContracts.ts`

This reduces `assistant.ts` responsibility without changing behavior or adding new regex/keyword logic. The assistant runtime should import the extracted contracts and continue to orchestrate the same flow.

## Validation

AC1. `assistant.ts` no longer defines LLM fast-turn schema/coercion code directly and imports it from the new module.

AC2. Focused tests prove route defaults and answer contract coercion remain stable.

AC3. Existing assistant/orchestrator behavior tests still pass.

AC4. `npm run lint:no-regex` proves no new regex constructs were added.

AC5. `npm run typecheck`, `npm run build`, and full `npm test` pass.

AC6. No production Promptfoo rerun is required for this pass because it is a pure extraction with no behavior/prompt/runtime logic changes; production behavior remains covered by the last passing gate unless local validation detects a behavior-impacting diff.
