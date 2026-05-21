# Production LLM Judge Metric Spec

## Current Behavior

Production Promptfoo now passes deterministic assertions, but the result summary reports `llmAverageStatus="not_configured"` because the suite has no LLM-grader component.

Running Promptfoo's normal local OpenAI grader from this machine is not a valid gate: local OpenAI calls fail with `403 Country, region, or territory not supported`.

## Structural Improvement

Add a production-backed LLM judge path:

- an admin-only Railway endpoint evaluates a rendered Promptfoo rubric with the server-side OpenAI configuration;
- a Promptfoo custom grader provider calls that endpoint instead of local OpenAI;
- the Promptfoo suite adds an `llm-rubric` assertion so `summarize-results.cjs` can report a real LLM average.

This is eval harness infrastructure only. It must not change buyer chat behavior or public widget APIs.

No new regex constructs may be added.

## Acceptance Criteria

AC1. The LLM judge endpoint is protected by the existing admin authorization path.

AC2. The custom Promptfoo grader provider posts rendered rubric prompts to the production judge endpoint and returns `{ pass, score, reason }` to Promptfoo.

AC3. Promptfoo result summaries report `llmAverageStatus="ready"` when LLM grader components are present and not blocked.

AC4. Focused tests, full unit tests, `npm run lint:no-regex`, `npm run typecheck`, and build pass locally.

AC5. After commit/push and Railway deploy, production Promptfoo passes deterministic gate and reports LLM average above 90%.
