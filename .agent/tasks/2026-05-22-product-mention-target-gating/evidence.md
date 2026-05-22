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

Pending until the code commit is pushed and the Railway marker reaches it.
