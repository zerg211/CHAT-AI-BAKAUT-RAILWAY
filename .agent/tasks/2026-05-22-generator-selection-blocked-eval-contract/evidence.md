# Evidence: Generator Selection Blocked Eval Contract

## Baseline

- Production source: `.agent/tasks/2026-05-22-widget-embed-no-regex/production-evals-after-c6a4472.json`
- Commit: `c6a4472`
- Result: `5/6`
- Deterministic average: `0.9074444444444444`
- LLM average: `0.9483333333333333`
- Failing case: `generator_load_selection`

## Diagnosis

The assistant did not show generator cards because pump power/model was missing. Metadata showed:

- product class: `generator`;
- selection readiness: `blocked_by_answer_contract`;
- decision status: `needs_more_info`;
- visible cards: `0`;
- tool requests/results: none.

The LLM grader scored the answer `0.96` and agreed that not showing cards was appropriate. The deterministic assertions were too narrow because `allowNoSuitableProductOutcome` accepted only no-card outcomes after a catalog/search attempt.

## Change

- Added a structured missing-critical-generator-load outcome in `evals/promptfoo/assertions.cjs`.
- Allowed `assertToolCallCorrectness` and `assertAgentTaskCompletion` to accept that opt-in outcome.
- Set `allowNoSuitableProductOutcome: true` on the generator load selection tool assertion.
- Added unit coverage for a no-tool blocked generator selection where pump power/model is the missing fact.

## Checks

- `npm test -- tests/promptfooAssertions.test.ts`: PASS, 7 tests.
- `npm run lint:no-regex`: PASS, baseline 1782.
- Replayed saved production raw `generator_load_selection` through updated assertions: PASS.
- `git diff --check`: PASS, only line-ending warnings.
- `npm run typecheck`: PASS.
- `npm test`: PASS, 77 files, 636 tests.
- `npm run build`: PASS.

## Acceptance Criteria

- AC1: PASS. Retrieval grounding accepts the opt-in structured blocked generator-selection outcome.
- AC2: PASS. Tool correctness accepts missing catalog/search only for the opt-in blocked outcome.
- AC3: PASS. Agent completion accepts missing `product_selection` task type only for the opt-in blocked outcome.
- AC4: PASS. Existing negative test still rejects missing cards without opt-in.
- AC5: PASS. No new regex constructs.
- AC6: PASS. Local non-OpenAI gates pass.
- AC7: PENDING. Requires commit, push, Railway marker, and production Promptfoo.
