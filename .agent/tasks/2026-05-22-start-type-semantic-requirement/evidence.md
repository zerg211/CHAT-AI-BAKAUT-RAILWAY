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

Initial production run after commit `3d878fd`:

```text
PROMPTFOO_CHAT_BASE_URL=https://chat-ai-production-3057.up.railway.app npm run evals -- --no-cache -j 1 -o .agent/tasks/2026-05-22-start-type-semantic-requirement/production-promptfoo-3d878fd.json
FAIL: 5/6 tests passed
Deterministic average: 98.12%
LLM average: 90.17%
```

Raw artifact:
- `.agent/tasks/2026-05-22-start-type-semantic-requirement/production-promptfoo-3d878fd.json`
- `.agent/tasks/2026-05-22-start-type-semantic-requirement/production-promptfoo-3d878fd.summary.json`

Problems recorded:
- `.agent/tasks/2026-05-22-start-type-semantic-requirement/problems.md`

## Fix pass after failed production eval

Timestamp: `2026-05-22T20:47:24.4406323+03:00`

Changes:
- Improved `answerMentionedProducts` so brand plus short model token sequences such as `Husqvarna LF 50 LAT` are recognized as named product candidates.
- Kept the matcher constrained so it does not match a different model from a partial numeric suffix such as only `60 LAT`.
- Added a focused card-selection test proving short model names keep answer text and visible cards aligned.

Local checks:

```text
npx vitest run tests/agentManagerCardSelection.test.ts tests/semanticMemoryCoercion.test.ts tests/cardManifest.test.ts tests/recommendationRanking.test.ts
PASS: 4 test files, 236 tests

npm run typecheck
PASS

npm run lint:no-regex
PASS: No new regex constructs. Legacy baseline: 1623. Legacy findings removed since baseline: 36.

npm run build
PASS

npm test
PASS: 86 test files, 700 tests
```

AC9 remains pending until this fix pass is committed, pushed, Railway marker reaches it, and production Promptfoo is rerun.

## Production eval after short-model fix

Run after commit `32e60bc`:

```text
PROMPTFOO_CHAT_BASE_URL=https://chat-ai-production-3057.up.railway.app npm run evals -- --no-cache -j 1 -o .agent/tasks/2026-05-22-start-type-semantic-requirement/production-promptfoo-32e60bc.json
FAIL: 5/6 tests passed
Deterministic average: 91.03%
LLM average: 96.50%
```

Raw artifact:
- `.agent/tasks/2026-05-22-start-type-semantic-requirement/production-promptfoo-32e60bc.json`
- `.agent/tasks/2026-05-22-start-type-semantic-requirement/production-promptfoo-32e60bc.summary.json`

Problems recorded:
- `.agent/tasks/2026-05-22-start-type-semantic-requirement/problems.md`

## Fix pass after 32e60bc production eval

Timestamp: `2026-05-22T21:09:00+03:00`

Changes:
- Added a typed `grounding` block to AgentManager intent contracts, so the LLM planner explicitly states task type, source policy, required tool kinds, technical attributes, and rationale.
- Updated the AgentManager planner prompt to fill grounding first and require `web.researchProductFacts` for web-required technical grounding even when no exact model is named.
- Added a runtime consistency repair that only uses the LLM's structured grounding policy: if `web_required` is present but the web tool is missing, it adds `auto:web-grounding`.
- Exposed AgentManager `sourcePolicy` and `turnContract.taskType` in metadata for production eval observability.
- Added focused contract and AgentManager tests for omitted-tool grounding repair.

Behavior boundary:

Where LLM decides:
- Whether the current turn is a technical answer.
- Whether external web grounding is required.
- Which technical attributes need verification.

Where deterministic code decides:
- Whether the LLM's typed grounding policy and typed tool list are internally inconsistent.
- Adds the missing web tool only when `grounding.sourcePolicy="web_required"` or `requiredToolKinds` already names `web.researchProductFacts`.

No regex or raw buyer-phrase keyword rule was added.

Local checks:

```text
npx vitest run tests/agentManagerContracts.test.ts tests/agentManagerComparisonResearch.test.ts
PASS: 2 test files, 25 tests

npm run typecheck
PASS

npm run lint:no-regex
PASS: No new regex constructs. Legacy baseline: 1623. Legacy findings removed since baseline: 36.

npm run build
PASS

npm test
PASS: 86 test files, 701 tests
```

AC9 remains pending until this grounding repair is committed, pushed, Railway marker reaches it, and production Promptfoo is rerun.

## Production eval after grounding repair

Run after commit `4107581`:

```text
PROMPTFOO_CHAT_BASE_URL=https://chat-ai-production-3057.up.railway.app npm run evals -- --no-cache -j 1 -o .agent/tasks/2026-05-22-start-type-semantic-requirement/production-promptfoo-4107581.json
FAIL: 5/6 tests passed
Deterministic average: 96.98%
LLM average: 84.50%
```

Raw artifact:
- `.agent/tasks/2026-05-22-start-type-semantic-requirement/production-promptfoo-4107581.json`
- `.agent/tasks/2026-05-22-start-type-semantic-requirement/production-promptfoo-4107581.summary.json`

Problems recorded:
- `.agent/tasks/2026-05-22-start-type-semantic-requirement/problems.md`

## Fix pass after 4107581 production eval

Timestamp: `2026-05-23T00:23:00+03:00`

Changes:
- Added an AgentManager pre-answer product evidence gate for structured budgets.
- If the current need has a budget and same-class in-budget catalog candidates exist, same-class over-budget products are removed from `composeAnswer` product context before the LLM writes text.
- If no same-class in-budget product exists, over-budget products remain available so the answer can truthfully explain no fit.
- Added `answerProductEvidence` metadata and `answer_products_filtered_by_budget:N` warning for audit.
- Added a focused test proving an over-budget vibroplate is not passed to the answer model when in-budget vibroplates exist.

Behavior boundary:

Where LLM decides:
- Which in-budget catalog candidates best answer the buyer's selection request.

Where deterministic code decides:
- Budget is a hard catalog/business constraint once extracted into need state.
- Same-class products above the structured budget are not allowed as answer evidence while in-budget same-class candidates exist.

No regex or phrase-specific dialogue workaround was added.

Local checks:

```text
npx vitest run tests/agentManagerOrchestrator.test.ts tests/agentManagerCardSelection.test.ts
PASS: 2 test files, 47 tests

npm run typecheck
PASS

npm run lint:no-regex
PASS: No new regex constructs. Legacy baseline: 1623. Legacy findings removed since baseline: 36.

npm test
PASS: 86 test files, 702 tests

npm run build
PASS
```

AC9 remains pending until this evidence-gate fix is committed, pushed, Railway marker reaches it, and production Promptfoo is rerun.

## Production eval after answer-product evidence gate

Run after commit `9a14705`:

```text
PROMPTFOO_CHAT_BASE_URL=https://chat-ai-production-3057.up.railway.app npm run evals -- --no-cache -j 1 -o .agent/tasks/2026-05-22-start-type-semantic-requirement/production-promptfoo-9a14705.json
FAIL: 5/6 tests passed
Deterministic average: 98.64%
LLM average: 92.83%
```

Raw artifact:
- `.agent/tasks/2026-05-22-start-type-semantic-requirement/production-promptfoo-9a14705.json`
- `.agent/tasks/2026-05-22-start-type-semantic-requirement/production-promptfoo-9a14705.summary.json`

Problems recorded:
- `.agent/tasks/2026-05-22-start-type-semantic-requirement/problems.md`

## Fix pass after 9a14705 production eval

Timestamp: `2026-05-23T21:36:51.8876989+03:00`

Changes:
- Added a pre-send review guard for catalog-selection answers that compares answer model identifier tokens with the products actually passed as answer evidence.
- If the final answer names a model identifier absent from answer product evidence, the guard removes the unsupported answer segment before card selection and buyer delivery.
- Context-only structured product mentions remain allowed, so load devices and compatibility context are not treated as unsupported catalog recommendations.
- Strengthened the budget evidence test so the mocked answer intentionally names dropped `TSS-WP60TH`, then verifies the final answer removes it and records `unsupported_catalog_product_mention`.

Behavior boundary:

Where LLM decides:
- Which catalog products best satisfy the buyer's need from the evidence it receives.
- Which context equipment mentions are semantically part of the buyer's task.

Where deterministic code decides:
- A catalog-selection answer may only name model identifiers grounded in the products passed as answer evidence, except structured context-only product mentions.
- Unsupported model-token segments are removed before visible cards are selected.

No regex or phrase-specific dialogue workaround was added.

Focused local checks:

```text
npx vitest run tests/agentManagerOrchestrator.test.ts tests/agentManagerCardSelection.test.ts
PASS: 2 test files, 47 tests

npm run typecheck
PASS

npm run lint:no-regex
PASS: No new regex constructs. Legacy baseline: 1623. Legacy findings removed since baseline: 36.

npm test
PASS: 86 test files, 702 tests

npm run build
PASS
```

AC9 remains pending until this pre-send evidence guard is committed, pushed, Railway marker reaches it, and production Promptfoo is rerun.
