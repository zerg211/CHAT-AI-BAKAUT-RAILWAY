# Spec: Product Trait Coercion Extraction

Task ID: `2026-05-21-product-trait-coercion-extraction`
Date: 2026-05-21

## Current Behavior

`src/ai/assistant.ts` still owns general product trait coercion helpers used by need extraction and turn planning:

- product intent/fuel/start/role/enclosure coercion
- string list and product intent list coercion
- nullable boolean/number coercion
- `emptyRequiredProductTraits`
- `requiredTraitsHaveHardConstraints`
- `coerceRequiredProductTraits`

These helpers normalize structured LLM output into deterministic internal product selection fields. They do not decide user intent or add product-selection rules.

## Structural Improvement

Move this general coercion layer into:

- `src/ai/productTraitCoercion.ts`

Keep `assistant.ts` responsible for orchestration, planning flow, and behavior while reusing the extracted helpers.

## Non-Goals

- Do not change prompts.
- Do not change model selection.
- Do not change OpenAI request shape.
- Do not change semantic decision logic, product ranking, card rendering, recovery, or business policy.
- Do not add regex.
- Do not change public API or user-facing behavior.

## Acceptance Criteria

- AC1: `assistant.ts` imports the product trait coercion helpers/types and no longer defines those helper functions locally.
- AC2: The extracted helpers preserve all current allowed values, defaults, numeric positivity rules, list limits, and `powerReasoning` truncation.
- AC3: No new regex constructs are introduced.
- AC4: Local non-OpenAI gates pass: focused tests, `npm run lint:no-regex`, `npm run typecheck`, `npm run build`, and full `npm test`.
- AC5: Production Promptfoo/widget rerun is not required unless the diff changes prompts, OpenAI request semantics, runtime behavior, or user-facing answers.

## Validation Plan

- Add focused tests for product trait coercion.
- Run affected assistant/coercion tests.
- Run no-regex, typecheck, build, and full unit suite.
- Push through git and verify Railway production marker reaches the new commit.
