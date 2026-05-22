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
- AC4: PENDING. Needs commit, push, and Railway marker.
- AC5: PENDING. Needs production Promptfoo/widget harness after deploy.
