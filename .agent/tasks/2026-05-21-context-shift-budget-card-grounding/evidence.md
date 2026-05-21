# Context Shift Budget Card Grounding Evidence

## Summary

Status: local validation PASS, production rerun pending after push.

This pass responds to the production LLM judge result from `f0c3abb`:

- `context_shift_agent_completion` scored `0.41` because a budget-constrained vibration plate answer still showed an above-budget product card when an in-budget selected option existed.
- `generator_load_selection` had a transient production LLM judge HTTP 500.
- The summary artifact reported an impossible LLM average above 1 because named metric totals were preferred over component scores.

## Changed Files

- `src/ai/agentManagerCardSelection.ts`
- `evals/promptfoo/production-llm-grader-provider.cjs`
- `evals/promptfoo/summarize-results.cjs`
- `tests/agentManagerCardSelection.test.ts`
- `tests/promptfooProvider.test.ts`
- `tests/promptfooSummary.test.ts`

## Local Validation

- `npm test -- tests/agentManagerCardSelection.test.ts tests/promptfooProvider.test.ts tests/promptfooSummary.test.ts` PASS: 3 files, 11 tests.
- `npm run lint:no-regex` PASS: no new regex constructs, legacy baseline remains 1832.
- `git diff --check` PASS with line-ending warnings only.
- `npm run typecheck` PASS.
- `npm run build` PASS.
- `npm test` PASS: 65 files, 555 tests.

## Production Gate

Pending:

- Commit and push this pass.
- Wait for Railway marker.
- Rerun production Promptfoo and verify deterministic average and LLM average are both above 90%.
