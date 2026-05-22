# Evidence: verified web fact memory

## Implementation

- Added `verified_product_facts` migration and idempotent schema repair.
- Added repository methods to save, search, and mark reusable verified product facts.
- Agent Manager now checks verified web fact memory before external `web.researchProductFacts`.
- Agent Manager saves high/medium exact web facts after successful research and mirrors catalog-linked facts into existing `product_facts`.
- Matching is based on structured product/model identity and requested attributes, not phrase-specific response patches.

## Checks

- `npx vitest run tests/agentManagerComparisonResearch.test.ts` - PASS, 13 tests.
- `npx vitest run tests/agentManagerComparisonResearch.test.ts tests/agentManagerMigrations.test.ts tests/productComparisonResearch.test.ts tests/agentManagerIntegrationSource.test.ts` - PASS, 32 tests.
- `npm run typecheck` - PASS.
- `npm run lint:no-regex` - PASS, no new regex constructs.
- `npm run migrate` - PASS, migration applied locally.
- `npm run build` - PASS.

## Acceptance Criteria

- AC1: PASS. Exact high/medium web facts are persisted with source URL/title/evidence.
- AC2: PASS. Facts are keyed by normalized model identity and linked to `product_id` when catalog product is present.
- AC3: PASS. Agent Manager checks local verified facts first and skips web when they cover requested attributes.
- AC4: PASS. No one-model or phrase patch; logic is structured around model/fact/attribute coverage.
- AC5: PASS. Catalog facts are not overwritten; web facts are stored separately and mirrored as `source_type='web'` only.
- AC6: PASS. Tests cover save and reuse paths.
- AC7: PASS. Focused tests, typecheck, no-regex, migrate, build passed.
- AC8: PENDING. Commit/push, Railway marker, and live widget check still need to run.
