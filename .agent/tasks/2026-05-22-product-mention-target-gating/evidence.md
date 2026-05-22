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

## Production eval after `eeeb714`

```text
PROMPTFOO_CHAT_BASE_URL=https://chat-ai-production-3057.up.railway.app npm run evals -- --no-cache -j 1 -o .agent/tasks/2026-05-22-product-mention-target-gating/production-promptfoo-eeeb714.json
FAIL: 4/6 tests passed
Deterministic average: 97.71%
LLM average: 87.00%
```

Raw artifact:
- `.agent/tasks/2026-05-22-product-mention-target-gating/production-promptfoo-eeeb714.json`
- `.agent/tasks/2026-05-22-product-mention-target-gating/production-promptfoo-eeeb714.summary.json`

Improvement from `5d88c46`:
- Deterministic average: `92.62%` -> `97.71%`
- LLM average: `77.17%` -> `87.00%`
- Passed cases: `3/6` -> `4/6`
- `commercial_delivery_discount_rules` now passes and has `leadRequested: true`.

Remaining failures:
- `generator_load_selection`: answer refused useful preliminary cards because retrieval returned only over-budget generator candidates and the load contract omitted the unknown pump.
- `context_shift_agent_completion`: answer ignored previous visible vibroplate cards and asked for a form instead of narrowing the existing selection.

## Second fix pass after failed production eval

Timestamp: `2026-05-22T20:11:55.0297780+03:00`

Changes:
- Added budget-aware catalog fallback: when structured budget exists and initial same-intent results have no in-budget product, broaden the deterministic catalog pool and add same-intent products within budget.
- Strengthened planner instructions so known relevant generator loads are not omitted when exact power is missing; bounded preliminary motor loads should be represented as bounded assumptions.
- Added previous-visible-card continuity: when no current catalog products exist, relevant prior product cards are passed to the answer model as product context.
- Added explicit `allowHistoricalProducts` card-selection path so historical cards can be reused only when runtime marks that context.
- Added a focused test for historical card reuse in a narrowing turn.
- Replaced a legacy visible-answer sanitizer regex chain in `assistant.ts` with explicit scanners so the staged no-regex gate passes without updating the baseline.

Local checks:

```text
npx vitest run tests/agentManagerCardSelection.test.ts tests/agentManagerOrchestrator.test.ts tests/agentManagerComparisonResearch.test.ts tests/agentManagerContracts.test.ts
PASS: 4 test files, 69 tests

npm run typecheck
PASS

npm run lint:no-regex
PASS: No new regex constructs. Legacy baseline: 1623. Legacy findings removed since baseline: 36.

npm run build
PASS

npm test
PASS: 86 test files, 696 tests
```

AC8 remains pending until this second fix pass is committed, pushed, Railway marker reaches the new commit, and production Promptfoo is rerun against Railway.
