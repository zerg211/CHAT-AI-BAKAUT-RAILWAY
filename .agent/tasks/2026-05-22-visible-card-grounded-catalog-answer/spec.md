# Task: visible-card grounded catalog answer

## Scope

Fix the latest production eval weak spot where a catalog selection answer listed too many product names and concrete dimensions while only a subset became visible product cards.

This is a contract-level grounding pass, not a regex or keyword fix.

## Current Behavior

Production eval on `c778af4`:
- `web_required_technical_grounding` passed and used `web.researchProductFacts`.
- `plate_retrieval_grounding` failed only the LLM rubric because the answer listed several catalog products and concrete dimensions beyond the final visible cards.
- Deterministic average and LLM average were above 90%, but one per-case LLM threshold failed.

## Structural Improvement

Refine answer/reviewer instructions:
- For catalog selection, do not enumerate the entire returned product set.
- Name only the strongest 1-3 products that can be justified from the provided product context.
- Treat a named product in `answerText` as a visible recommendation candidate.
- Mention dimensions/specs only when they are present in the provided product context.

## Acceptance Criteria

AC1. No new regex constructs are introduced.

AC2. Source guard tests assert the catalog-answer grounding instruction exists.

AC3. Local gates pass:
- focused integration source test;
- `npm run lint:no-regex`;
- `npm run typecheck`;
- `npm test`;
- `npm run build`;
- `git diff --check`.

AC4. After commit and push, Railway marker reaches the new commit.

AC5. Production Promptfoo/widget harness passes with deterministic average > 90%, LLM average > 90%, and no failed cases if achievable.
