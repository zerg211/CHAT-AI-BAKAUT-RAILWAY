# Spec: Turn Plan Schema Extraction

Task ID: `2026-05-21-turn-plan-schema-extraction`
Date: 2026-05-21

## Current Behavior

`src/ai/assistant.ts` still owns the deterministic JSON schema builders used for the turn planner response format:

- `agentContractV2Schema`
- `turnPlanSchema`

These builders define the structured output contract for the LLM planner. They do not decide semantic intent; they constrain and validate the LLM output shape.

## Structural Improvement

Move turn-planner schema builders into a dedicated module:

- `src/ai/assistantTurnPlanSchemas.ts`

`assistant.ts` should import the schema builder and keep orchestration, request construction, coercion, and runtime behavior unchanged.

## Non-Goals

- Do not change prompts.
- Do not change model selection.
- Do not change OpenAI stage names.
- Do not change planner coercion, fallback, product selection, card rendering, or business policy.
- Do not add regex.
- Do not modify public APIs except adding internal module exports for tests.

## Acceptance Criteria

- AC1: `assistant.ts` imports `turnPlanSchema` and no longer defines `agentContractV2Schema` or `turnPlanSchema` locally.
- AC2: The extracted schema preserves the current required fields, enums, nested `agentContractV2`, and selected product max item limit.
- AC3: No new regex constructs are introduced.
- AC4: Local non-OpenAI gates pass: focused tests, `npm run lint:no-regex`, `npm run typecheck`, `npm run build`, and full `npm test`.
- AC5: Production Promptfoo/widget rerun is not required unless the diff changes prompts, OpenAI request semantics, runtime behavior, or user-facing answers.

## Validation Plan

- Add focused tests for the extracted turn planner schemas.
- Run affected planner/schema tests.
- Run no-regex, typecheck, build, and full unit suite.
- Push through git and verify Railway production marker reaches the new commit.
