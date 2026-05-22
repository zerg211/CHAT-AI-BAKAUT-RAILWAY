# Evidence: product mention target gating through LLM roles

Task id: `2026-05-22-product-mention-target-gating`

Timestamp: `2026-05-22T19:38:36.1320057+03:00`

## Change summary

- Added `productMentions` to planner structured format and prompt instructions.
- Runtime now treats only `target_product`, `catalog_candidate`, and `comparison_subject` as exact catalog/web targets.
- Runtime suppresses `context_load_device`, `compatibility_context`, and `mentioned_only` names from exact target product handling.
- Suppressed names are included in tool payload/warnings for observability without adding exact catalog absence warnings.
- Added focused tests proving a context device such as `Baxi 24` is not promoted into a BAKAUT catalog target.

## Behavior boundary

Where LLM decides:
- Whether a named item is a target product, catalog candidate, comparison subject, load device, compatibility context, or casual mention.

Where code decides:
- Deterministically filters exact target productNames based on the structured role.
- Records suppressed names for traceability.
- Keeps catalog presence, nearby alternatives, and exact absence warnings scoped to actual target roles.

This avoids adding product-name-specific exceptions and keeps semantic classification inside the planner contract.

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

- AC1: PASS. Planner contract schema supports strict `productMentions`.
- AC2: PASS. Planner structured JSON schema includes and requires `productMentions`.
- AC3: PASS. Focused test proves context-only product names are suppressed from exact web/catalog targets.
- AC4: PASS. Focused test proves target product mentions still drive exact web target handling.
- AC5: PASS. Suppressed names are visible in payload/warnings without exact catalog absence warnings.
- AC6: PASS. Focused contract and comparison research tests passed.
- AC7: PASS. Typecheck, build, and no-regex guard passed.
- AC8: PENDING. Requires commit, push, Railway marker, then production Promptfoo.
- AC9: PASS. Evidence is recorded here.

## Production eval

Initial production run after commit `5d88c46`:

```text
PROMPTFOO_CHAT_BASE_URL=https://chat-ai-production-3057.up.railway.app npm run evals -- --no-cache -j 1 -o .agent/tasks/2026-05-22-product-mention-target-gating/production-promptfoo-5d88c46.json
FAIL: 3/6 tests passed
Deterministic average: 92.62%
LLM average: 77.17%
```

Raw artifact:
- `.agent/tasks/2026-05-22-product-mention-target-gating/production-promptfoo-5d88c46.json`
- `.agent/tasks/2026-05-22-product-mention-target-gating/production-promptfoo-5d88c46.summary.json`

Problems recorded:
- `.agent/tasks/2026-05-22-product-mention-target-gating/problems.md`

## Fix pass after failed production eval

Timestamp: `2026-05-22T19:54:48.5358054+03:00`

Changes:
- Added deterministic final-contract consistency repair: when `lead.capture` reports missing contact/name and the final answer already asks for contact data, final `leadAction` becomes `offer_form`.
- Added a focused unit test proving `leadRequested` stays true for that form-offer case.
- Strengthened general LLM/reviewer instructions so catalog recommendation names must come from `products[].name` and must be true visible recommendation candidates, not filler.
- Strengthened plate-compactor guidance so a heavier in-budget product under one-person transport is labeled as a compromise if no clearly light in-budget candidate is available.

Local checks:

```text
npx vitest run tests/agentManagerOrchestrator.test.ts
PASS: 1 test file, 28 tests

npx vitest run tests/agentManagerOrchestrator.test.ts tests/agentManagerComparisonResearch.test.ts tests/agentManagerContracts.test.ts
PASS: 3 test files, 52 tests

npm run typecheck
PASS

npm run lint:no-regex
PASS: No new regex constructs. Legacy baseline: 1623.

npm run build
PASS

npm test
PASS: 86 test files, 695 tests
```

AC8 remains pending until this fix pass is committed, pushed, Railway marker reaches the new commit, and production Promptfoo is rerun against Railway.
