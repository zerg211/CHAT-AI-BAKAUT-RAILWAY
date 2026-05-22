# Evidence: web-required general technical research

## Change

Updated the Agent Manager planner system instructions so the LLM plans `web.researchProductFacts` for explicit technical fact-checking requests even when no exact model is named.

This is not a regex or keyword-routing fix. It keeps the semantic decision in the LLM planner and tells it how to express the research request safely:
- empty `productNames` when no model is named;
- buyer question in `query` and `semanticQuery`;
- requested technical attributes in `comparisonAttributes`.

## Local Validation

- `npm test -- tests/agentManagerIntegrationSource.test.ts`: PASS, 10 tests.
- `npm run lint:no-regex`: PASS, baseline 1767.
- `npm run typecheck`: PASS.
- `npm test`: PASS, 78 files and 648 tests.
- `npm run build`: PASS.
- `git diff --check`: PASS.

## Acceptance Criteria Status

- AC1: PASS. No new regex constructs.
- AC2: PASS. Source guard test asserts the planner instruction.
- AC3: PASS. Local gates passed.
- AC4: PASS. Commit `c778af4` reached Railway.
- AC5: FOLLOW-UP REQUIRED. Production eval passed the original web-required case, but a separate plate visible-card grounding LLM rubric failed.

## Production Eval After `c778af4`

- `npm run evals -- --no-cache -j 1 -o .agent/tasks/2026-05-22-web-required-general-technical-research/production-evals-after-c778af4.json`: FAIL.
- Pass/fail: 5/6.
- Deterministic average: 0.9878333333333332.
- LLM average: 0.9316666666666666.
- `web_required_technical_grounding`: PASS, `web.researchProductFacts` present.
- Remaining failure: `plate_retrieval_grounding` LLM rubric, due product-answer/card grounding weakness.

Follow-up task: `.agent/tasks/2026-05-22-visible-card-grounded-catalog-answer/`.
