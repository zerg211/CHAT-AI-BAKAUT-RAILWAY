# Production LLM Judge Metric Evidence

## Summary

Status: local validation PASS, production Promptfoo rerun pending after push.

This pass adds a production-backed Promptfoo LLM judge:

- `src/ai/evalJudge.ts` builds a structured OpenAI judge request and validates `{ pass, score, reason }`.
- `src/routes/admin.ts` exposes `POST /api/admin/evals/llm-rubric` behind the existing admin authorization hook.
- `evals/promptfoo/production-llm-grader-provider.cjs` calls that admin endpoint for Promptfoo `llm-rubric`.
- `promptfooconfig.yaml` adds a default `llm-rubric` assertion with metric `llmAverage`.

## Local Validation

- `npm test -- tests/evalJudge.test.ts tests/promptfooProvider.test.ts tests/promptfooSummary.test.ts` PASS: 3 files, 7 tests.
- `npm run lint:no-regex` PASS: no new regex constructs, legacy baseline remains 1832.
- `git diff --check` PASS with line-ending warnings only.
- `npm run typecheck` PASS.
- `npm run build` PASS.
- `npm test` PASS: 65 files, 551 tests.
- Admin token availability check PASS: local env has a token available for the production grader.

## Production Gate

Pending:

- Commit and push this pass.
- Wait for Railway marker to deploy the pushed commit.
- Rerun production Promptfoo and verify deterministic average and LLM average are both above 90%.
