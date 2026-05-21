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

Pending until commit, push, Railway marker, and production Promptfoo rerun.
