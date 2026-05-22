# Evidence: product mentions contract schema stabilization

Task id: `2026-05-22-product-mentions-contract-schema`

Timestamp: `2026-05-22T19:38:36.1320057+03:00`

## Change summary

- Added strict `ProductMentionRoleSchema` and `ProductMentionSchema`.
- Added `productMentions` to `AgentIntentContractSchema` with default `[]` for parsed contracts.
- Exported product mention role/value types.
- Kept the public `AgentIntentContract` TypeScript type compatible with existing test doubles by allowing omitted `productMentions`.
- Added contract tests for defaulting, strict role parsing, and invalid mention rejection.

## Behavior preservation

Current behavior:
- Planner output is parsed through `AgentIntentContractSchema`.
- Runtime code may already read `intent.productMentions` defensively.

Structural improvement:
- The semantic product-role boundary is now part of the contract schema rather than an ad hoc field.
- New parsed contracts materialize `productMentions: []` when the planner omits it.

Validation check:
- Focused contract tests passed.
- Broader comparison research tests passed because the schema feeds behavior gating.
- Typecheck, build, and no-regex guard passed.

## Commands

```text
npx vitest run tests/agentManagerContracts.test.ts tests/agentManagerComparisonResearch.test.ts
PASS: 2 test files, 24 tests

npm run typecheck
PASS

npm run build
PASS

npm run lint:no-regex
PASS: No new regex constructs. Legacy baseline: 1623.
```

## Acceptance criteria

- AC1: PASS. Product mentions parse with role, product class, name, and evidence.
- AC2: PASS. Omitted product mentions default to `[]` on parsed contracts.
- AC3: PASS. Unknown roles and extra fields are rejected.
- AC4: PASS. Existing fields and public TypeScript compatibility are preserved.
- AC5: PASS. Existing structured format strictness test passes.
- AC6: PASS. Focused tests, typecheck, build, and no-regex guard passed.
- AC7: PASS. Evidence is recorded here.

## Production eval

This schema evidence is paired with the behavior task `2026-05-22-product-mention-target-gating`. Production Promptfoo belongs to that task after commit, push, and Railway marker.
