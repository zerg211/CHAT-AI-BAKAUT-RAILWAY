# Task: product mentions contract schema stabilization

## Current behavior

`AgentManagerOrchestrator` already describes and reads `productMentions` in the planner structured output. The contract schema needs to explicitly own that field so the LLM can return product mention roles as structured data instead of forcing product-role semantics into ad hoc code.

This is a schema/coercion pass. It should not change buyer-facing behavior by itself.

## Structural improvement

Stabilize `productMentions` as an optional structured field on `AgentIntentContractSchema`:

- enum role values for product mentions;
- strict mention object shape;
- default empty array when omitted;
- exported inferred types;
- contract tests that prove parsing, defaults, and strict rejection.

## Acceptance Criteria

- AC1: `AgentIntentContractSchema` parses planner `productMentions` with role, product class, and evidence.
- AC2: Omitted `productMentions` defaults to an empty array so runtime code does not need undefined checks for newly parsed contracts.
- AC3: Unknown mention roles or extra fields are rejected by strict schema parsing.
- AC4: Existing agent intent contract fields and public exports stay compatible.
- AC5: `agentManagerStructuredFormats` remains strict and requires the same JSON schema properties checked by existing tests.
- AC6: Focused contract tests, typecheck, build, and no-regex guard pass.
- AC7: Evidence is recorded in this task folder.

## Validation plan

- `npx vitest run tests/agentManagerContracts.test.ts`
- `npm run typecheck`
- `npm run build`
- `npm run lint:no-regex`

Production Promptfoo is not required for this schema-only stabilization unless behavior code changes. The code still must be committed, pushed, and observed through the Railway marker.
