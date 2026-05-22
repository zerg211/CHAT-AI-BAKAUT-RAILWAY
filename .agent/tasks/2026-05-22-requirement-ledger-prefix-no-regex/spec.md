# Task: requirement ledger prefix no regex

## Current behavior

`src/ai/requirementLedger.ts` builds the agent control-plane ledger from semantic memory and structured selection constraints. Hard constraint ledger item IDs use the fixed internal prefix `selection:`, and `hardConstraintKeys` strips that prefix before emitting metadata and warnings.

The current prefix stripping uses regex.

## Structural improvement

Replace regex prefix stripping with an explicit `startsWith`/`slice` helper for the fixed `selection:` prefix.

This keeps the LLM/code boundary unchanged: the LLM supplies structured semantic memory and selection constraints, while code produces deterministic ledger metadata and warnings.

## Acceptance Criteria

AC1. `src/ai/requirementLedger.ts` contains no regex constructs after the pass.

AC2. No new regex constructs are added anywhere else.

AC3. `hardConstraintKeys` still emits raw selection keys such as `productIntent`, `brandConstraint`, `fuel`, and `exactModelTokens`.

AC4. Existing warnings for hard constraints without active semantic mirrors remain stable.

AC5. `npm run lint:no-regex` passes after reviewed baseline reduction.

AC6. Focused tests, typecheck, full tests, build, and diff check pass.

AC7. Production eval is not required because this is deterministic metadata prefix handling with no prompt, answer policy, product selection, tool policy, or widget-visible behavior change.
