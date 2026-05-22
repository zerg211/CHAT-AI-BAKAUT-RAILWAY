# Task: start type as semantic requirement and card invariant

## Current behavior

Buyer wording such as "easy start", "button start", "key start", or "no cord pulling" can be treated as a loose generator preference. In the legacy selection path this can be relaxed away if the visible answer/code does not retain enough evidence, which allows manual-start generators to remain visible even when electric start was an explicit buyer requirement.

## Structural improvement

Represent generator start type as structured agent state instead of a free-text hint:

- The LLM need extractor can emit `semanticMemory.requirements[].kind="startType"` with `value.text="electric"` or `"manual"`.
- Explicit buyer start-type requirements are copied into `selectionState.hardConstraints.startType` with provenance.
- The old "clear ungrounded electric start" safety cleanup preserves explicit-user start requirements instead of erasing them.
- The card manifest deterministically enforces `activeConstraints.startType`, so manual-start cards are hidden when electric start is a hard constraint.

Semantic boundary:

- LLM decides whether buyer wording is an explicit start-type requirement.
- Deterministic code stores, coerces, and enforces the structured requirement against product facts/cards.
- No regex or phrase-specific buyer-response hack is added.

## Acceptance Criteria

- AC1: `SemanticRequirementKind` supports `startType` in shared types and structured need-extraction schema.
- AC2: Need-extractor prompt tells the LLM to emit `startType` only for explicit buyer start requirements, not inferred preferences.
- AC3: Semantic memory coercion accepts `startType`.
- AC4: Product selection copies explicit `startType` requirements into hard constraints and preserves `explicit_user` provenance.
- AC5: Electric-start hard constraints are not cleared by ungrounded-start cleanup when provenance is `explicit_user` or `previous_selection`.
- AC6: Card manifest marks manual-start cards as violating `startType:electric` and enforcement hides them while keeping electric-start cards.
- AC7: Focused tests cover semantic coercion, ranking/selection preservation, and card manifest enforcement.
- AC8: Typecheck, unit tests, build, and no-regex guard pass.
- AC9: Because prompts/selection behavior can affect production responses, commit + push, wait for Railway marker, and run production Promptfoo with deterministic and LLM averages above 90%.
- AC10: Evidence and raw artifacts are recorded in this task folder.

## Validation plan

Local, no OpenAI:

- `npx vitest run tests/semanticMemoryCoercion.test.ts tests/cardManifest.test.ts tests/recommendationRanking.test.ts`
- `npm run typecheck`
- `npm run lint:no-regex`
- `npm run build`
- `npm test`

Production after commit/push/Railway marker:

- `PROMPTFOO_CHAT_BASE_URL=https://chat-ai-production-3057.up.railway.app npm run evals -- --no-cache -j 1 -o .agent/tasks/2026-05-22-start-type-semantic-requirement/production-promptfoo-<commit>.json`
