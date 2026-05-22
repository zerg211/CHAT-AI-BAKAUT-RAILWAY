# Evidence: catalog-present line regression

## Change

Restored the existing exact-model research safe rewrite behavior:
- `catalogPresence.status="present"` still adds a concise catalog-present line only when the semantic intent carries `answer_policy_catalog_presence_relevant`.
- The broader prompt text was aligned back to that behavior.

This keeps pure technical answers from adding catalog availability text unnecessarily, while preserving it when the buyer's current turn makes catalog presence relevant.

## Local Validation

- `npm test -- tests/agentManagerComparisonResearch.test.ts`: PASS, 9 tests.
- `npm run lint:no-regex`: PASS.
- `npm run typecheck`: PASS.
- `npm test`: PASS, 78 files and 648 tests.
- `npm run build`: PASS.
- `git diff --cached --check`: PASS.

## Acceptance Criteria Status

- AC1: PASS.
- AC2: PASS.
- AC3: PASS.
- AC4: PASS.
