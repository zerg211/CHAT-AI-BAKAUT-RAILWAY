# Task: web-required general technical research

## Scope

Fix the latest-main production eval failure where the buyer explicitly asked to check facts for a technical THD question, but the Agent Manager planner answered from general knowledge without `web.researchProductFacts`.

This must not use regex or deterministic keyword routing. The fix belongs in the LLM planner contract: when the buyer asks for factual verification or exact/current technical grounding, the planner should use the research tool even without a named model.

## Current Behavior

Production eval on commit `9d04038`:
- `web_required_technical_grounding` failed deterministic assertions.
- LLM answer quality was high, but metadata had no `web.researchProductFacts` tool result and no web/source evidence.

## Structural Improvement

Refine Agent Manager planner instructions:
- General technical answers can be answered from engineering knowledge only when the buyer did not request verification.
- If the buyer asks to verify/check facts, mentions missing catalog data, or requests exact/current technical grounding, plan `web.researchProductFacts`.
- This applies even when no exact product model is named; use empty `productNames`, the buyer question as query/semanticQuery, and requested attributes in `comparisonAttributes`.

## Acceptance Criteria

AC1. No new regex constructs are introduced.

AC2. Source guard tests assert the planner instruction exists.

AC3. Local gates pass:
- focused integration source test;
- `npm run lint:no-regex`;
- `npm run typecheck`;
- `npm test`;
- `npm run build`;
- `git diff --check`.

AC4. After commit and push, Railway marker reaches the new commit.

AC5. Production Promptfoo/widget harness passes with deterministic average > 90% and LLM average > 90%.
