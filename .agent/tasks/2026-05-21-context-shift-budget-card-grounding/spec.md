# Context Shift Budget Card Grounding Spec

## Current Behavior

Production LLM judge found a real context-shift defect: after the buyer set budget `до 70 000`, the assistant showed a vibration plate card priced above that budget alongside an in-budget option and mentioned it as a nearby option. This made the answer less grounded and lowered the LLM score.

The same run also exposed eval harness issues:

- `summarize-results.cjs` preferred Promptfoo named metric totals over actual `llm-rubric` component scores, producing an impossible `llmAverage` above 1.
- A transient production judge HTTP 500 caused one LLM assertion to fail without retry.

## Structural Improvement

- Use structured `needState` budget facts to filter visible non-generator card selections when at least one selected product is within the buyer's budget.
- Prefer actual LLM component scores in the summary when `llm-rubric` components exist.
- Retry production LLM grader calls on transient endpoint failures.

No new regex constructs may be added.

## Acceptance Criteria

AC1. Card selection removes over-budget products when structured budget state exists and at least one selected product is within budget.

AC2. Card selection keeps alternatives when no in-budget selected products exist, preserving useful fallback behavior.

AC3. Promptfoo summary reports LLM average from component scores when components are present.

AC4. Production LLM grader retries transient HTTP failures.

AC5. Focused tests, full unit tests, `npm run lint:no-regex`, `npm run typecheck`, and build pass locally.

AC6. After commit/push and Railway deploy, production Promptfoo passes with deterministic average and LLM average both above 90%.
