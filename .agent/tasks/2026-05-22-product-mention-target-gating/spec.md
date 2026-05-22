# Task: product mention target gating through LLM roles

## Current behavior

The planner may include product names in tool request args, but names can have different semantic roles:

- a product the buyer wants to buy/check;
- a catalog candidate or comparison subject;
- a load device or compatibility context for another target product;
- a casual mention.

Without structured role separation, deterministic code can accidentally promote a context device such as `Baxi 24` into an exact BAKAUT catalog target and then produce catalog absence warnings or nearby alternatives for the wrong object.

## Structural improvement

Use structured LLM `productMentions` as the semantic boundary:

- LLM classifies each mentioned item with a role.
- Runtime deterministic code uses only `target_product`, `catalog_candidate`, and `comparison_subject` roles as exact catalog/web targets.
- `context_load_device`, `compatibility_context`, and `mentioned_only` can remain evidence/context but must not trigger exact catalog absence or nearby catalog alternatives.

This avoids a hard-coded product-name exception and keeps the semantic decision in the planner contract.

## Acceptance Criteria

- AC1: Planner contract schema supports strict `productMentions` with role, product class, name, and evidence.
- AC2: Planner structured JSON schema requires `productMentions` so the model can return role-separated mentions.
- AC3: Runtime suppresses context-only product names from exact web/catalog target handling.
- AC4: Runtime still allows real target/comparison product mentions to drive exact web/catalog target handling.
- AC5: Suppressed names are observable in tool result payload/warnings for debugging, without emitting exact catalog absence warnings for them.
- AC6: Focused contract and comparison research tests pass.
- AC7: Typecheck, build, and no-regex guard pass.
- AC8: Because behavior can change, production Promptfoo must pass after commit/push/Railway marker with deterministic and LLM averages above 90%.
- AC9: Evidence is recorded in this task folder.

## Validation plan

- `npx vitest run tests/agentManagerContracts.test.ts tests/agentManagerComparisonResearch.test.ts`
- `npm run typecheck`
- `npm run build`
- `npm run lint:no-regex`
- after commit/push/Railway marker:
  - `PROMPTFOO_CHAT_BASE_URL=https://chat-ai-production-3057.up.railway.app npm run evals -- --no-cache -j 1 -o .agent/tasks/2026-05-22-product-mention-target-gating/production-promptfoo-<commit>.json`

Local OpenAI/Promptfoo through localhost is not valid in this environment.
