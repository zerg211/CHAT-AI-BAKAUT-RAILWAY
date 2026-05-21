# Eval Summary LLM Average Evidence

## Summary

Status: PASS.

Added a project-owned Promptfoo summary artifact that reports deterministic score, assertion pass rate, and LLM average status. The summary does not call an LLM and does not change assistant runtime behavior.

## Changed Files

- `evals/promptfoo/summarize-results.cjs`
- `evals/promptfoo/run-promptfoo.cjs`
- `tests/promptfooSummary.test.ts`
- `package.json`
- `docs/PROMPTFOO_EVALS.md`

## Validation

- `npm test -- tests/promptfooSummary.test.ts` PASS: 1 file, 3 tests.
- `npm run lint:no-regex` PASS: no new regex constructs, legacy baseline remains 1832.
- `npm run typecheck` PASS.
- `node --check evals/promptfoo/summarize-results.cjs` PASS.
- `node --check evals/promptfoo/run-promptfoo.cjs` PASS.
- `npm run evals:summarize -- .agent/tasks/2026-05-21-refactor-completion/raw/llm-grader-smoke.json` PASS.
- `npm run evals:summarize -- .agent/tasks/2026-05-21-bounded-preliminary-load-estimates/production-evals-after-16196c3.json` PASS.

## Observed Summaries

- LLM grader smoke summary: `llmAverageStatus="blocked"`, `llmComponentCount=1`, `llmBlockedCount=1`.
- Production deterministic eval summary after `16196c3`: deterministic average `1`, assertion pass rate `1`, `llmAverageStatus="not_configured"`.

## Behavior Parity

No product code, prompt behavior, public APIs, database schema, or widget behavior is changed by this pass.

## Acceptance Criteria

- AC1 PASS: deterministic counts, average score, and assertion pass rate are reported.
- AC2 PASS: `llmAverage` and `llmAverageStatus` are reported for ready, blocked, and not-configured cases.
- AC3 PASS: the eval wrapper writes a sibling summary for `-o` or `--output` JSON artifacts when the raw file exists.
- AC4 PASS: focused tests cover deterministic-only, blocked LLM grader, and scored LLM grader outputs.
- AC5 PASS: no-regex guard, focused tests, and typecheck pass.
