# Evidence

## Implementation

- Updated visible card selection so explicit budget constraints are enforced against the same-intent catalog candidate pool.
- If answer-mentioned products are all over budget but in-budget same-intent candidates exist, cards fall back to the in-budget candidates.
- Existing nearest over-budget behavior is preserved when there are no in-budget same-intent candidates at all.
- Added answer prompt guidance to avoid presenting over-budget products as satisfying the buyer's budget.

## Local Verification

- `npm test -- tests/agentManagerCardSelection.test.ts tests/agentManagerIntegrationSource.test.ts` - PASS, 18 tests.
- `npm run lint:no-regex` - PASS, no new regex constructs; legacy baseline remains 1824.
- `npm run typecheck` - PASS.
- `npm test` - PASS, 76 files / 606 tests.
- `git diff --check` - PASS, CRLF warnings only.
- `npm run build` - PASS.

## Production Verification

- Pending commit, push, Railway marker, and production Promptfoo.

## Acceptance Criteria Status

- AC1: PASS.
- AC2: PASS.
- AC3: PASS.
- AC4: PASS.
- AC5: PENDING.
