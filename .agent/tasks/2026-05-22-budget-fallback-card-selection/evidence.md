# Evidence

## Implementation

- Updated visible card selection so explicit budget constraints are enforced against the same-intent catalog candidate pool.
- If answer-mentioned products are all over budget but in-budget same-intent candidates exist, cards fall back to the in-budget candidates.
- Existing nearest over-budget behavior is preserved when there are no in-budget same-intent candidates at all.
- Added answer prompt guidance to avoid presenting over-budget products as satisfying the buyer's budget.
- Follow-up fix after production rerun: card selection now accepts the existing structured ledger key `budget_max:` in addition to `budget.max:`. This keeps the decision deterministic over structured state rather than parsing buyer text with regex or keyword rules.

## Local Verification

- `npm test -- tests/agentManagerCardSelection.test.ts tests/agentManagerIntegrationSource.test.ts` - PASS, 18 tests.
- `npm run lint:no-regex` - PASS, no new regex constructs; legacy baseline remains 1824.
- `npm run typecheck` - PASS.
- `npm test` - PASS, 76 files / 607 tests.
- `git diff --check` - PASS, CRLF warnings only.
- `npm run build` - PASS.
- Follow-up targeted check: `npm test -- tests/agentManagerCardSelection.test.ts` - PASS, 9 tests.

## Production Verification

- `production-evals-after-bedbfc6.json`: 4/6, deterministic average 0.9612222222222222, LLM average 0.8016666666666666. Failed `vague_generator_no_cards_before_load_profile` and `context_shift_agent_completion`.
- `production-evals-after-bedbfc6-rerun2.json`: 5/6, deterministic average 0.9865, LLM average 0.9283333333333333. Gates were above 90%, but `context_shift_agent_completion` still failed because production state stored the budget as `budget_max: 70000`, so card filtering missed the budget and allowed an over-budget plate card.
- Follow-up `budget_max` fix is locally verified and pending commit, push, Railway marker, and production Promptfoo.

## Acceptance Criteria Status

- AC1: PASS.
- AC2: PASS.
- AC3: PASS.
- AC4: PASS.
- AC5: PENDING for the follow-up `budget_max` production check.
