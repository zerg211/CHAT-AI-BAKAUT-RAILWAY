# Evidence: verified web fact memory

## Implementation

- Added `verified_product_facts` migration and idempotent schema repair.
- Added repository methods to save, search, and mark reusable verified product facts.
- Agent Manager now checks verified web fact memory before external `web.researchProductFacts`.
- Agent Manager saves high/medium exact web facts after successful research and mirrors catalog-linked facts into existing `product_facts`.
- Matching is based on structured product/model identity and requested attributes, not phrase-specific response patches.
- Follow-up repair removed the start-control shortcut from cached fact memory: cached facts are now passed as source-backed evidence and the LLM writes the buyer-facing answer.
- Final repair removed the temporary start-family matcher; broader attribute paraphrases must be handled by a future LLM normalization pass, not a code dictionary.

## Checks

- `npx vitest run tests/agentManagerComparisonResearch.test.ts` - PASS, 13 tests.
- `npx vitest run tests/agentManagerComparisonResearch.test.ts tests/agentManagerMigrations.test.ts tests/productComparisonResearch.test.ts tests/agentManagerIntegrationSource.test.ts` - PASS, 32 tests.
- `npm run typecheck` - PASS.
- `npm run lint:no-regex` - PASS, no new regex constructs.
- `npm run migrate` - PASS, migration applied locally.
- `npm run build` - PASS.
- Follow-up `npx vitest run tests/agentManagerComparisonResearch.test.ts` after removing the cached starter shortcut - PASS, 13 tests.
- Follow-up `npm run typecheck` - PASS.
- Follow-up `npm run lint:no-regex` - PASS, no new regex constructs, legacy baseline 1687.
- Follow-up `npm run build` - PASS.
- Final `npx vitest run tests/agentManagerComparisonResearch.test.ts` after removing the start-family matcher - PASS, 13 tests.
- Final `npm run typecheck` - PASS.
- Final `npm run lint:no-regex` - PASS, no new regex constructs, legacy baseline 1687.
- Final `npm run build` - PASS.
- Production behavior marker: PASS, `https://chat-ai-production-3057.up.railway.app/api/health` reported final code commit `a9af56c9df99796ccd32c80ed8b95e85507da647`.
- Live widget save/reuse check: PASS, protocol `local-live-tests/2026-05-22-verified-web-fact-memory-2026-05-22T14-11-46-469Z.production.md`.
- Final live widget reuse/style check: PASS, protocol `local-live-tests/2026-05-22-verified-web-fact-memory-reuse-2026-05-22T15-21-48-479Z.production.md`.
- Final live widget no-starter-matcher check: PASS, protocol `local-live-tests/2026-05-22-verified-fact-no-starter-matcher-a9af56c.production.md`.

## Acceptance Criteria

- AC1: PASS. Exact high/medium web facts are persisted with source URL/title/evidence.
- AC2: PASS. Facts are keyed by normalized model identity and linked to `product_id` when catalog product is present.
- AC3: PASS. Agent Manager checks local verified facts first and skips web when stored attributes directly cover requested structured attributes.
- AC4: PASS. No one-model, phrase patch, regex, or start-family dictionary remains in the cached fact path; cached facts are evidence for LLM answer composition.
- AC5: PASS. Catalog facts are not overwritten; web facts are stored separately and mirrored as `source_type='web'` only.
- AC6: PASS. Tests cover save and reuse paths.
- AC7: PASS. Focused tests, typecheck, no-regex, migrate, build passed.
- AC8: PASS. Code commit `a9af56c9df99796ccd32c80ed8b95e85507da647` was pushed, Railway marker matched it, and live widget checks passed. This evidence update is documentation-only.
