# Eval Provider And Card Contract Stability Evidence

## Summary

Status: local validation PASS, production Promptfoo rerun pending after push.

This pass keeps the fix in the agent/harness layer instead of adding phrase-specific bot rules:

- Promptfoo session creation now has retry handling, matching the already retried message/recovery paths.
- Non-generator catalog cards are not suppressed when the answer contract says `selectionReadiness.status="not_applicable"` but the visible card intent has valid catalog products.
- The context-shift scorecard can validate product class from structured metadata with `expectedProductClasses`.
- The commercial non-confirmation scorecard guard uses deterministic fragment checks and adds no new regex.

## Local Validation

- `npm test -- tests/promptfooProvider.test.ts tests/agentManagerCardSelection.test.ts tests/promptfooAssertions.test.ts` PASS: 3 files, 6 tests.
- `npm run lint:no-regex` PASS: no new regex constructs, legacy baseline remains 1832.
- `git diff --check` PASS with line-ending warnings only.
- `npm run typecheck` PASS.
- `npm run build` PASS.
- `npm test` PASS: 64 files, 548 tests.

## Notes

The working tree also contains a separate exact-model guidance diff in `src/ai/agentManagerOrchestrator.ts` and `tests/agentManagerComparisonResearch.test.ts`; it is not part of this pass.

## Production Gate

Pending:

- Commit and push this pass.
- Wait for Railway to deploy the pushed commit.
- Rerun production Promptfoo with `PROMPTFOO_CHAT_BASE_URL=https://chat-ai-production-3057.up.railway.app` and `PROMPTFOO_CHAT_PAGE_URL=https://bakautprof.ru/`.
