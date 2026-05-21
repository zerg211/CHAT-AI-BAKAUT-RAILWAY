# Spec: Need Extraction Schema Extraction

Task ID: `2026-05-21-need-extraction-schema-extraction`
Date: 2026-05-21

## Current Behavior

`src/ai/assistant.ts` owns both assistant runtime behavior and the JSON schema builders used for need extraction and semantic memory output:

- `needItemSchema`
- `activeNeedSchema`
- `needExtractionCriteriaSchema`
- `loadProfileSchema`
- `needExtractionSelectionStateSchema`
- `semanticMemorySchema`

These functions are deterministic schema definitions. They do not make semantic decisions and are only used to shape the LLM structured output.

## Structural Improvement

Move the need-extraction/semantic-memory schema builders into a dedicated module:

- `src/ai/assistantNeedExtractionSchemas.ts`

Keep `assistant.ts` responsible for runtime orchestration and LLM calls, while schema-only code lives beside other assistant support modules.

## Non-Goals

- Do not change prompts.
- Do not change model selection.
- Do not change OpenAI request shape except importing the same schema builders from the new module.
- Do not change coercion, product selection, recovery, card rendering, or business behavior.
- Do not add regex.

## Acceptance Criteria

- AC1: `assistant.ts` imports the extracted schema builders and no longer defines those need-extraction schema functions locally.
- AC2: The exported schema builders return the same required fields/enums/maxItems used by the current response format.
- AC3: No new regex constructs are introduced.
- AC4: Local non-OpenAI gates pass: focused tests, `npm run lint:no-regex`, `npm run typecheck`, `npm run build`, and full `npm test`.
- AC5: Production Promptfoo/widget rerun is not required for this pass unless the diff changes prompts, OpenAI request semantics, or user-facing behavior.

## Validation Plan

- Add focused tests for the extracted schema builders.
- Run affected assistant tests that cover need extraction/coercion.
- Run no-regex, typecheck, build, and full unit suite.
- Push through git and verify Railway production marker reaches the new commit.
