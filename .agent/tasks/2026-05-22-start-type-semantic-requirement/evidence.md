# Evidence: start type as semantic requirement and card invariant

Task id: `2026-05-22-start-type-semantic-requirement`

Timestamp: `2026-05-22T20:31:52.6914463+03:00`

## Change summary

- Added `startType` to semantic requirement kinds, need-extraction schema, prompt documentation, and semantic memory coercion.
- Product selection now accepts `startType` for generator/welding-generator intent and copies explicit semantic requirements into hard constraints with provenance.
- Ungrounded electric-start cleanup now preserves explicit-user and previous-selection provenance.
- Card manifest enforces `activeConstraints.startType`, flagging manual-start cards when electric start is required.
- Added focused tests for semantic coercion, selection/ranking preservation, and card manifest enforcement.

## Behavior boundary

Where LLM decides:
- Whether buyer language means an explicit generator start-type requirement.
- Whether the requirement is strict and buyer-provided.

Where deterministic code decides:
- Coerces `startType` into typed semantic memory.
- Copies explicit start-type requirement into hard product-selection constraints.
- Keeps or clears start constraints based on provenance/evidence.
- Enforces card visibility against product/card facts.

No regex or phrase-specific dialogue workaround was added.

## Commands

```text
npx vitest run tests/semanticMemoryCoercion.test.ts tests/cardManifest.test.ts tests/recommendationRanking.test.ts
PASS: 3 test files, 218 tests

npm run typecheck
PASS

npm run lint:no-regex
PASS: No new regex constructs. Legacy baseline: 1623. Legacy findings removed since baseline: 36.

npm run build
PASS

npm test
PASS: 86 test files, 699 tests
```

## Acceptance criteria

- AC1: PASS. `SemanticRequirementKind` includes `startType`.
- AC2: PASS. Need-extractor prompt instructs explicit `startType` extraction only for buyer requirements.
- AC3: PASS. Semantic memory coercion accepts `startType`.
- AC4: PASS. Product selection copies explicit `startType` requirements into hard constraints and provenance.
- AC5: PASS. Ungrounded electric-start cleanup preserves explicit-user and previous-selection provenance.
- AC6: PASS. Card manifest flags and hides manual-start cards when electric start is required.
- AC7: PASS. Focused tests cover coercion, selection preservation, and card enforcement.
- AC8: PASS locally. Typecheck, unit tests, build, and no-regex guard passed.
- AC9: PENDING. Requires commit, push, Railway marker, then production Promptfoo.
- AC10: PASS. Evidence is recorded here.

## Production eval

Pending until commit/push and Railway marker.
