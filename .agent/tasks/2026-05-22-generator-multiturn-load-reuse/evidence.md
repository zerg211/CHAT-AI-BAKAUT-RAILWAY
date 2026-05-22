# Evidence: generator multi-turn load reuse

## Change

Updated the Agent Manager planner instruction for multi-turn generator selection:
- if history contains a previous load estimate, prior generator sizing answer, or enough load facts, the planner must not run `catalog.search` alone;
- it must re-run `calculator.generatorLoad` in the current turn before `catalog.search`;
- this ensures current tool results include `payload.profile.requiredNominalKw` so weak products can be filtered.

No regex was added.

## Local Validation

- `npm test -- tests/agentManagerIntegrationSource.test.ts tests/agentManagerComparisonResearch.test.ts`: PASS, 19 tests.
- `npm run lint:no-regex`: PASS, baseline 1767.
- `npm run typecheck`: PASS.
- `npm test`: PASS, 78 files and 648 tests.
- `npm run build`: PASS.
- `git diff --check`: PASS.

## Acceptance Criteria Status

- AC1: PASS. No new regex constructs.
- AC2: PASS. Source guard test asserts the multi-turn generator load instruction.
- AC3: PASS. Clean-index local gates passed.
- AC4: PENDING. Needs commit, push, and Railway marker.
- AC5: PENDING. Needs production Promptfoo/widget harness after deploy.
