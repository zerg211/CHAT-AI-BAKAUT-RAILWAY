# Eval Summary LLM Average Spec

## Current Behavior

Promptfoo raw JSON artifacts include deterministic assertion scores, but the repository does not have a stable project-owned summary artifact that reports:

- deterministic overall score;
- deterministic assertion pass rate;
- LLM average score when LLM grader assertions are present;
- explicit LLM average status when the grader is blocked or not configured.

As a result, evidence files have to explain the LLM average blocker manually, and future production/widget eval runs can miss whether the LLM average target was actually measured.

## Structural Improvement

Add a small Promptfoo result summarizer that parses raw Promptfoo JSON and writes a sibling `.summary.json` artifact. The summarizer must not call an LLM, must not change chat behavior, and must not use regex. It should be usable standalone and from the existing `npm run evals` wrapper after a JSON output path is passed.

## Acceptance Criteria

AC1. The summary reports deterministic score fields from raw Promptfoo output: result count, pass/fail/error counts, average score, and assertion pass rate.

AC2. The summary reports `llmAverage` and `llmAverageStatus`:

- `ready` when one or more LLM grader component scores are available;
- `blocked` when LLM grader components are present but all failed with grader/API errors;
- `not_configured` when no LLM grader component exists.

AC3. The existing `npm run evals -- -o <path>.json` wrapper writes `<path>.summary.json` when the raw output file exists.

AC4. Focused tests cover deterministic-only output, blocked LLM grader output, and scored LLM grader output.

AC5. `npm run lint:no-regex`, focused tests, and typecheck pass.

## Behavior Parity

This pass is tooling-only. It must not change assistant runtime behavior, public HTTP APIs, prompts, product card selection, database schema, or production deployment behavior.
