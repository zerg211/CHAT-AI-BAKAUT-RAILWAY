# Production LLM Judge Metric Evidence

## Summary

Status: metric wiring PASS, production quality gate needs follow-up fix.

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

First production run after `f0c3abb`:

- Artifact: `.agent/tasks/2026-05-21-production-llm-judge-metric/production-evals-after-f0c3abb.json`.
- Summary: `.agent/tasks/2026-05-21-production-llm-judge-metric/production-evals-after-f0c3abb.summary.json`.
- `llmAverageStatus` became `ready`, proving the production LLM judge path works.
- Corrected summary after component-score averaging: deterministic average `0.9488888888888889`, LLM average `0.858`.
- The run failed 2/6: one transient judge HTTP 500 and one real context-shift card grounding issue.

Follow-up task `2026-05-21-context-shift-budget-card-grounding` addresses those defects.
