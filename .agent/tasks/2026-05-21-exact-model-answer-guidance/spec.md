# Exact Model Answer Guidance Spec

## Current Behavior

For exact-model technical questions where the requested model is absent from the BAKAUT catalog, the research/answer flow can still under-answer the buyer:

- suffix or nearby catalog models can be treated too close to the requested exact model;
- broad external facts such as "electric starter" can fail to answer the practical buyer choice, such as key/start switch vs push-button;
- an ambiguous or not-confirmed coverage status can be turned into a categorical negative claim.

## Structural Improvement

Keep semantic interpretation in the LLM/web research step and make the output structured enough for deterministic code to enforce safely:

- `web.researchProductFacts` returns `answerGuidance` with a buyer-facing `directAnswer`, completeness, and per-attribute coverage;
- exact target matching uses identifier-token equality for model/code tokens instead of substring suffix matches;
- the answer contract receives a required response clause when checked research guidance exists;
- pre-send review requires the final answer to use checked guidance and forbids converting `not_confirmed`, `ambiguous`, or `not_found` into categorical negative claims.

## Acceptance Criteria

AC1. A suffix model such as `RD2910E1` must not count as exact catalog presence for target `RD2910E`.

AC2. Exact-target checked research guidance is passed into the answer step and becomes a required semantic clause.

AC3. For key/start-control questions, the research contract can express practical switch/START evidence separately from broad electric-starter facts.

AC4. The final answer can say a mechanism is not confirmed, but must not claim it is absent unless checked evidence supports that.

AC5. The pass adds no new regex constructs.

AC6. Focused tests, typecheck, and build pass before commit.

AC7. Because this can affect buyer-visible behavior, production Promptfoo/widget validation is required after push before claiming production readiness.
