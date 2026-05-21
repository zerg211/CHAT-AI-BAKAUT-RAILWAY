# Spec: Semantic Memory Coercion Extraction

Task ID: `2026-05-21-semantic-memory-coercion-extraction`
Date: 2026-05-21

## Current Behavior

`src/ai/assistant.ts` owns semantic-memory coercion helpers used by `coerceNeedUpdate`:

- semantic requirement kind/status/strictness/source coercion
- semantic value coercion
- mentioned product memory coercion
- semantic selection policy coercion
- bot commitment coercion
- `coerceSemanticMemory`

These helpers normalize structured LLM output into the internal `SemanticMemory` contract. They do not make user-facing semantic decisions; they validate and sanitize the LLM result before deterministic state merge.

## Structural Improvement

Move semantic-memory coercion into a dedicated module:

- `src/ai/semanticMemoryCoercion.ts`

Keep `assistant.ts` responsible for orchestration and `coerceNeedUpdate` composition while semantic-memory normalization lives in a focused module with direct tests.

## Non-Goals

- Do not change prompts.
- Do not change model selection.
- Do not change OpenAI request shape.
- Do not change product selection, recovery, card rendering, or business policy.
- Do not add regex.
- Do not change the public response/API surface.

## Acceptance Criteria

- AC1: `assistant.ts` imports `coerceSemanticMemory` and no longer defines the semantic-memory helper functions locally.
- AC2: The extracted coercion preserves the same limits, defaults, normalized token behavior, and `updatedAt` stamping.
- AC3: No new regex constructs are introduced.
- AC4: Local non-OpenAI gates pass: focused tests, `npm run lint:no-regex`, `npm run typecheck`, `npm run build`, and full `npm test`.
- AC5: Production Promptfoo/widget rerun is not required unless the diff changes prompts, OpenAI request semantics, runtime behavior, or user-facing answers.

## Validation Plan

- Add focused tests for semantic-memory coercion.
- Run affected need-update/ranking tests that already exercise `assistantTestHooks.coerceNeedUpdate`.
- Run no-regex, typecheck, build, and full unit suite.
- Push through git and verify Railway production marker reaches the new commit.
