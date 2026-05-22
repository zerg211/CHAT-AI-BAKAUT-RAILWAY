# Evidence

## Implementation

- Added `web_research_unavailable_grounding` required response clause for non-ok `web.researchProductFacts` results.
- Updated the Agent Manager answer prompt so failed web research cannot be described as checked, verified, or confirmed evidence.
- Added a regression test that forces `web.researchProductFacts` to throw and verifies the answer model receives the required grounding clause before composition.

## Local Verification

- `npm test -- tests/agentManagerComparisonResearch.test.ts tests/agentManagerIntegrationSource.test.ts` - PASS, 17 tests.
- `npm run lint:no-regex` - PASS, no new regex constructs; legacy baseline remains 1824.
- `npm run typecheck` - PASS.
- `npm test` - PASS, 75 files / 602 tests.
- `git diff --check` - PASS, CRLF warnings only.
- `npm run build` - PASS.

## Production Verification

- Commit `da0f939` was pushed to `main`.
- Railway `/api/health` reported deployed commit `da0f9393095d3a031450114477822333d5678abb`.
- Production Promptfoo against Railway/widget wrote `.agent/tasks/2026-05-22-web-research-failure-grounding/production-evals-after-da0f939.json`.
- Result: 5/6 passed, deterministic average `0.9629444444444443`, LLM average `0.9499999999999998`.
- Gates `deterministicAbove90` and `llmAverageAbove90` were both PASS. Remaining deterministic failure moved to `generator_load_selection` card visibility and is handled by task `2026-05-22-bounded-generator-null-load-defaults`.

## Acceptance Criteria Status

- AC1: PASS.
- AC2: PASS.
- AC3: PASS.
- AC4: PASS.
- AC5: PASS.
