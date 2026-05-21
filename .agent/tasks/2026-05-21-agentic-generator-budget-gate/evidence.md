# Agentic Generator Budget Gate Evidence

## Local checks before push

- `npm test -- tests/agentManagerCardSelection.test.ts tests/promptfooProvider.test.ts tests/agentManagerOrchestrator.test.ts`
  - PASS: 3 files, 34 tests.
- `npm run lint:no-regex`
  - PASS: `No new regex constructs. Legacy baseline: 1832.`
- `npm run typecheck`
  - PASS.
- `npm run build`
  - PASS.
- `npm test`
  - PASS: 65 files, 557 tests.

## Iteration notes

- Extended structured budget parsing to accept both `budget.max:` and `budget:` without regex.
- Strengthened the planner contract so bounded generator estimates remain an LLM semantic decision and the runtime only executes structured numeric load facts.
- Increased production LLM grader default attempts from 3 to 5 and covered that behavior in provider tests.

## Production checks

- After `e07a67d`, `npm run evals -- --no-cache -j 1 -o .agent/tasks/2026-05-21-agentic-generator-budget-gate/production-evals-after-e07a67d.json`
  - Promptfoo exit: FAIL because 3 LLM judge components returned production HTTP 500.
  - Deterministic average: `0.9063333333333333`.
  - LLM average: `0.9466666666666667`.
  - Cause: oversized Promptfoo `<Output>` payloads for rows with large metadata/product artifacts.

## Local checks after judge prompt compaction

- `npm test -- tests/promptfooProvider.test.ts tests/promptfooSummary.test.ts`
  - PASS: 2 files, 9 tests.
- `npm run lint:no-regex`
  - PASS: `No new regex constructs. Legacy baseline: 1832.`
- `npm run typecheck`
  - PASS.
- `npm run build`
  - PASS.
- `npm test`
  - PASS: 65 files, 558 tests.

## Next production check

- After `6af7911`, `npm run evals -- --no-cache -j 1 -o .agent/tasks/2026-05-21-agentic-generator-budget-gate/production-evals-after-6af7911.json`
  - PASS: 6/6 cases.
  - Deterministic average: `0.9935555555555555`.
  - Assertion pass rate: `1`.
  - LLM average: `0.9649999999999999`.
  - LLM blocked count: `0`.
  - Gates: deterministic above 90%, LLM average above 90%, LLM usable.
